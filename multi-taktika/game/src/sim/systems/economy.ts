/**
 * システム 9/14: economy — 採集・搬入・農地枯渇・交易・相場（`07§8`, 実装手順書 §6.6）
 *
 * 責務:
 *  - 実効収集速度 = 基礎速度 × 研究倍率 × 文明倍率 × (1 - 運搬損失)
 *    運搬損失 = min(0.50, floor(片道距離マス / 4) * 0.05)
 *  - 村人は 10 単位で最寄りの搬入点（町の中心・伐採所・採掘場・桟橋）へ歩く。
 *  - 森・鉱脈・農地の埋蔵量（`Entities.amount`）を採った分だけ減らす。
 *    枯れた農地は木材半額で再建（自動再建オプション）。
 *  - 市場相場は **全プレイヤー共通**。100 単位買うごとに +3%、30 秒ごとに 1% 戻る。
 *  - 交易: 金 = 片道距離 × 0.5 / 往復。
 *  - 貢納（チーム戦）は手数料 10%。
 *  - 攻撃された村人の自動退避（塔・櫓・城）。
 *
 * 担当マイルストーン: **M4**（T-M4-01〜10）。
 *
 * 実装の分担:
 *  - 計算そのものは `core/gather.ts`（採集・搬入・農地）、`core/market.ts`（相場・交易・貢納）、
 *    `core/population.ts`（人口）に置いてある。このファイルは
 *    **毎 tick の状態遷移だけ**を担当する（テストしやすさのため）。
 *  - 移動は M3 の `movement.ts` の責務なので、ここでは `destX/destY` を置くところまで。
 *    到着判定は距離（平方距離）で行う。
 *
 * 決定論の注意:
 *  - 資源は Fx で持つ（tick ごとの端数が出るため）。表示は整数に切り捨てる。
 *  - エンティティの走査は必ず index 昇順（§0.3, §16-1）。
 *  - 1 tick 分の採集量は「毎秒の速度」からの整数除算の差分で切り出す
 *    （`gatherAmountForTick`。毎 tick 丸めると速度が目減りする）。
 */

import type { EntityId, PlayerId } from '@/shared/types';
import { EntityKind, INVALID_ENTITY, RESOURCE_COUNT } from '@/shared/types';

import { UnitState, idOfIndex, isAliveIndex, resolveIndex } from '../core/entity';
import { unitDef } from '../core/defs';
import type { Fx } from '../core/fx';
import { distSq } from '../core/fx';
import {
  interactReachTo,
  TRADE_CART_TYPE,
  carryCapacityFx,
  civGatherMulFx,
  depleteNode,
  distanceFx,
  effectiveGatherRatePerSecFx,
  findNearestDropOffIndex,
  findNearestResourceNodeAnyIndex,
  findNearestResourceNodeIndex,
  findNearestShelterIndex,
  gatherAmountForTick,
  isDropOffIndex,
  isResourceNode,
  isVillagerIndex,
  researchGatherMulFx,
  resourceDepletionEnabled,
  resourceNodeDef,
  setVillagerState,
  villagerFleeEnabled,
} from '../core/gather';
import { GOLD_RESOURCE, applyMarketDecay, tradeGoldPerRoundTripFx } from '../core/market';
import { holdIncomePerSec, orderPairOfFront } from '../core/orderEffects';
import { TICK_RATE } from '../core/config';
import { idiv } from '../core/fx';
import { refreshPopulation } from '../core/population';
import { queryCircle, queryCircleBruteForce } from '../core/grid';
import type { World } from '../core/world';
import { areAllies, getPlayer } from '../core/world';

/**
 * この tick 中は変わらない設定値。毎エンティティで `config.json` を引き直さないために
 * 1 tick に 1 回だけ読んでまとめて持ち回す。
 */
interface EconomyTickContext {
  /** 村人の自動退避が有効か（設定で無効化可）。 */
  readonly fleeEnabled: boolean;
  /** 資源の枯渇が有効か（試合オプション）。 */
  readonly depletion: boolean;
  /** 村人の運搬容量（Fx。10 単位）。 */
  readonly carryCap: Fx;
}

export function economy(w: World): void {
  // 1) 相場を戻す（30 秒ごとに 1%）。全プレイヤー共通の状態なので最初に 1 回だけ。
  applyMarketDecay(w);

  // 2) ユニットの経済行動。index 昇順（§0.3）。
  const e = w.entities;
  const ctx: EconomyTickContext = {
    fleeEnabled: villagerFleeEnabled(),
    depletion: resourceDepletionEnabled(),
    carryCap: carryCapacityFx(),
  };
  for (let i = 0; i < e.highWater; i++) {
    if (!isAliveIndex(e, i) || e.kind[i] !== EntityKind.Unit) continue;
    if (e.owner[i]! >= w.playerCount) continue;
    if (isVillagerIndex(e, i)) {
      villagerTick(w, i, ctx);
    } else if (e.typeId[i] === TRADE_CART_TYPE) {
      tradeCartTick(w, i);
    }
  }

  // 3) 令「交易」（マリ）: 戦域を維持している間の収入。
  frontHoldIncome(w);

  // 4) 人口の集計（家 +5 / 町の中心 +10 / 既定上限 200）。
  refreshPopulation(w);
}

// ---------------------------------------------------------------- 戦域維持の収入（令「交易」）

/** `holdIncomePerSec` の受け皿。毎 tick × 戦域数の確保を避けるための使い回しバッファ。 */
const HOLD_INCOME_BUF = new Int32Array(RESOURCE_COUNT);

/**
 * 令「交易」（`holdIncome`）: **その戦域が立っている間、毎秒 資源が入る**。
 *
 * `01`「交易：戦域を維持すると金が入る」の実装。決めた点:
 *  - 「維持している」= **戦域が active で、その令が実際に効いていること**。
 *    離反中（`defected`）の戦域は令が効かないので入らない（`orderPairOfFront` が弾く）。
 *    優勢かどうかは条件にしない（資料は「維持すると」だけ。押されていても畳まなければ入る）。
 *  - 収入は戦域 1 つあたり。戦域を 2 つ立てて両方に交易を渡せば 2 倍入る
 *    （令のスロットは 6 枠しかないので上限は自然に決まる）。
 *  - 令の名前で分岐しない。`holdIncome` を持つ令なら同じに効く。
 *
 * 1 tick 分の切り出しは `morale.moraleDelta` と同じ telescoping 差分。
 * 毎秒 1.5（Fx 384）を 25 で割ると 15.36 で、素直に丸めると 15 になり
 * 実効 1.464/秒 に目減りする。tick からの差分にすれば合計が必ず「秒数 × rate」になる。
 *
 * 反復は `w.fronts` の index 昇順（= owner, slot 昇順）。
 */
function frontHoldIncome(w: World): void {
  for (let s = 0; s < w.fronts.length; s++) {
    const f = w.fronts[s]!;
    if (!f.active) continue;
    const pair = orderPairOfFront(f);
    if (!holdIncomePerSec(pair, HOLD_INCOME_BUF)) continue;
    const pl = getPlayer(w, f.owner);
    if (pl === undefined) continue;
    for (let r = 0; r < RESOURCE_COUNT; r++) {
      const rate = HOLD_INCOME_BUF[r]!;
      if (rate === 0) continue;
      const add = idiv(rate * (w.tick + 1), TICK_RATE) - idiv(rate * w.tick, TICK_RATE);
      if (add === 0) continue;
      pl.resources[r] = pl.resources[r]! + add;
    }
  }
}

// ---------------------------------------------------------------- 村人

/** 村人 1 体の 1 tick。 */
function villagerTick(w: World, i: number, ctx: EconomyTickContext): void {
  const e = w.entities;

  /**
   * 手動操作中か（`06§5`「選択した瞬間、その部隊は令から外れて手動になる」）。
   *
   * **`manual` が止めるのは自律判断だけ**で、プレイヤーが出した採集・搬入の指示は
   * そのまま進める。`gather` コマンドは仕様どおり `manual = 1` を立てるので、
   * ここで丸ごと return すると「採集を命じた村人が 1 tick も働かない」ことになる。
   * 止めるのは「勝手に逃げる」「勝手に次の仕事を探す」の 2 つ。
   */
  const manual = e.manual[i] === 1;

  if (!manual && ctx.fleeEnabled && findThreatIndex(w, i) >= 0) {
    fleeToShelter(w, i);
    return;
  }

  switch (e.state[i]) {
    case UnitState.Gathering:
      // プレイヤーが指示した採集も、令に任せた採集も同じ処理を進める。
      gatherTick(w, i, ctx);
      break;
    case UnitState.Hauling:
      haulTick(w, i);
      break;
    case UnitState.Moving:
      // 退避が終わった村人を仕事に戻す（作業対象を覚えている場合だけ）。
      // 手動で移動を命じられている村人には割り込まない。
      if (!manual) resumeWork(w, i, ctx);
      break;
    default:
      break;
  }
}

/**
 * 採集中の 1 tick。
 *
 * 運搬損失の基準になる「片道距離」は **資源ノード → 搬入点**の距離。
 * 村人の現在位置ではなくノードの位置を使うのは、往復のたびに歩く距離がそこで決まるため
 * （搬入点を資源のそばに建てると効率が上がる、という設計意図）。
 */
function gatherTick(w: World, i: number, ctx: EconomyTickContext): void {
  const e = w.entities;
  const ni = resolveIndex(e, e.target[i]!);
  if (ni < 0 || !isResourceNode(e, ni) || e.amount[ni]! <= 0) {
    // 採り切った / 対象が消えた。
    // 満載なら先に搬入し、そうでなければ**同じ資源の次のノードへ移る**（`07§8`）。
    if (e.carryAmount[i]! > 0) {
      startHaul(w, i);
      return;
    }
    // **向かっていたノードが、着く前に他の村人に採り切られた場合。**
    // 何を採るつもりだったかは残っていないので、失った目標の座標の最寄りのノードを継ぐ。
    // これが無いと「歩いている間に森が尽きた村人」が Idle のまま働かなくなる（実測）。
    const lost = findNearestResourceNodeAnyIndex(w, e.destX[i]!, e.destY[i]!);
    if (lost >= 0) {
      setVillagerState(e, i, UnitState.Gathering, w.tick);
      e.target[i] = idOfIndex(e, lost);
      e.destX[i] = e.x[lost]!;
      e.destY[i] = e.y[lost]!;
      return;
    }
    stopWork(w, i);
    return;
  }

  const nodeDef = resourceNodeDef(e.typeId[ni]!);
  const owner = e.owner[i]! as PlayerId;
  const di = ensureDropOff(w, i, e.x[ni]!, e.y[ni]!);

  // ノードに触れていなければ歩く（移動は M3 の movement）。
  if (!reachedTarget(w, i, ni)) {
    e.destX[i] = e.x[ni]!;
    e.destY[i] = e.y[ni]!;
    return;
  }

  // 別の資源を持ったままなら先に搬入する。
  if (e.carryKind[i] !== 0 && e.carryKind[i] !== nodeDef.resource + 1) {
    startHaul(w, i);
    return;
  }

  const oneWay = di >= 0 ? distanceFx(e.x[ni]!, e.y[ni]!, e.x[di]!, e.y[di]!) : 0;
  const rate = effectiveGatherRatePerSecFx(
    e.typeId[ni]!,
    oneWay,
    researchGatherMulFx(w, owner, nodeDef.resource),
    civGatherMulFx(w, owner, nodeDef.resource)
  );

  const cap = ctx.carryCap;
  let take = gatherAmountForTick(rate, w.tick - e.stateTick[i]!);
  const room = cap - e.carryAmount[i]!;
  if (take > room) take = room;
  const depletes = ctx.depletion && nodeDef.depletable;
  if (depletes && take > e.amount[ni]!) take = e.amount[ni]!;
  if (take <= 0) {
    if (e.carryAmount[i]! >= cap) startHaul(w, i);
    return;
  }

  e.carryKind[i] = nodeDef.resource + 1;
  e.carryAmount[i] = e.carryAmount[i]! + take;

  if (depletes) {
    e.amount[ni] = e.amount[ni]! - take;
    if (e.amount[ni]! <= 0) {
      // 採り切ったのでノードは消える。農地なら自動再建（木材半額）を試みる。
      const revived = depleteNode(w, ni);
      if (revived !== INVALID_ENTITY) {
        e.target[i] = revived;
        const ri = resolveIndex(e, revived);
        if (ri >= 0) {
          e.destX[i] = e.x[ri]!;
          e.destY[i] = e.y[ri]!;
        }
      } else {
        // **同じ資源の次のノードへ移る**（`07§8`「採り切ると消えます」/
        // 「枯れた後は農地と交易だけが収入源」= 残っている森があるうちは続く）。
        //
        // ここで移すのが要点。搬入すると `carryKind` が 0 に戻るので、
        // 「何を採っていたか」は**採り切ったこの瞬間しか分からない**。
        // 後から探そうとして失敗し、村人が Idle のまま資源が止まっていた（実測）。
        e.target[i] = INVALID_ENTITY;
        seekSameResource(w, i, nodeDef.resource);
      }
    }
  }

  if (e.carryAmount[i]! >= cap) startHaul(w, i);
}

/** 搬入中の 1 tick。 */
function haulTick(w: World, i: number): void {
  const e = w.entities;
  const di = ensureDropOff(w, i, e.x[i]!, e.y[i]!);
  if (di < 0) {
    // 搬入点が 1 つも無い（全部壊された）。持ったまま待機する。
    stopWork(w, i);
    return;
  }
  if (!reachedTarget(w, i, di)) {
    e.destX[i] = e.x[di]!;
    e.destY[i] = e.y[di]!;
    return;
  }
  // **搬入する前に「何を採っていたか」を覚えておく。**
  // `deliverCarry` は `carryKind` を 0 に戻すので、この行より後では分からなくなる。
  const wasGathering = e.carryKind[i]! - 1;
  deliverCarry(w, i);

  // 元の資源ノードが残っていれば戻る。
  const ni = resolveIndex(e, e.target[i]!);
  if (ni >= 0 && isResourceNode(e, ni) && e.amount[ni]! > 0) {
    setVillagerState(e, i, UnitState.Gathering, w.tick);
    e.destX[i] = e.x[ni]!;
    e.destY[i] = e.y[ni]!;
    return;
  }
  // 採り切られていたら**同じ資源の次のノードへ移る**（`07§8`）。
  // ここを `stopWork` にしていたため、森 1 本を採り終えた村人が
  // 拠点まわりに 18 本の森を残したまま Idle になり、木材が 300 で止まっていた。
  if (wasGathering >= 0 && seekSameResource(w, i, wasGathering)) return;
  stopWork(w, i);
}

/** 持っている資源をプレイヤーの手持ちに加える。 */
function deliverCarry(w: World, i: number): void {
  const e = w.entities;
  const kind = e.carryKind[i]!;
  if (kind === 0) return;
  const pl = getPlayer(w, e.owner[i]! as PlayerId);
  if (pl !== undefined) {
    const r = kind - 1;
    pl.resources[r] = pl.resources[r]! + e.carryAmount[i]!;
  }
  e.carryKind[i] = 0;
  e.carryAmount[i] = 0;
}

/** 搬入へ切り替える（`homeId` を最寄りの搬入点に更新して `Hauling` に入る）。 */
function startHaul(w: World, i: number): void {
  const e = w.entities;
  const di = ensureDropOff(w, i, e.x[i]!, e.y[i]!);
  if (di < 0) {
    stopWork(w, i);
    return;
  }
  setVillagerState(e, i, UnitState.Hauling, w.tick);
  e.destX[i] = e.x[di]!;
  e.destY[i] = e.y[di]!;
}

/** 手が空いた状態にする（T-M4-10 の列挙対象になる）。 */
function stopWork(w: World, i: number): void {
  const e = w.entities;
  setVillagerState(e, i, UnitState.Idle, w.tick);
  if (e.carryAmount[i]! <= 0) e.carryKind[i] = 0;
  e.target[i] = INVALID_ENTITY;
}

/**
 * 採り切ったノードの代わりに、**同じ資源の最寄りのノードへ移る**。
 *
 * `07§8` は「森・鉱脈・農地には埋蔵量があり、採り切ると消えます」「枯れた後は
 * 農地と交易だけが収入源になる」と書いている。つまり **1 本の森が尽きても、
 * 隣の森が残っている限り採集は続く**のが前提。
 *
 * これが無いと「森 1 本（100）を採り切った村人が Idle のまま二度と働かず、
 * 拠点まわりに森が 18 本あるのに木材が 300 で止まる」という壊れ方をする（実測）。
 * 手で 1 体ずつ指示し直せば動くが、それは仕様ではない。
 *
 * 決定論: 探すのは `findNearestResourceNodeIndex`（index 昇順の最近傍）だけ。乱数を使わない。
 * 見つからなければ Idle（= その資源はマップから尽きた。次の指示を待つ）。
 */
function seekSameResource(w: World, i: number, resource: number): boolean {
  const e = w.entities;
  const ni = findNearestResourceNodeIndex(w, e.x[i]!, e.y[i]!, resource);
  if (ni < 0) return false;
  setVillagerState(e, i, UnitState.Gathering, w.tick);
  e.target[i] = idOfIndex(e, ni);
  e.destX[i] = e.x[ni]!;
  e.destY[i] = e.y[ni]!;
  return true;
}

/**
 * `homeId` が有効な搬入点を指しているか確かめ、必要なら `(x, y)` から最寄りを選び直す。
 * 戻り値は搬入点の index（無ければ -1）。
 */
function ensureDropOff(w: World, i: number, x: Fx, y: Fx): number {
  const e = w.entities;
  const cur = resolveIndex(e, e.homeId[i]!);
  if (cur >= 0 && isDropOffIndex(e, cur) && e.owner[cur] === e.owner[i]) return cur;
  const di = findNearestDropOffIndex(w, e.owner[i]! as PlayerId, x, y);
  e.homeId[i] = di >= 0 ? idOfIndex(e, di) : INVALID_ENTITY;
  return di;
}

/** 到着判定（平方距離。`fxSqrt` を使わない）。 */
/**
 * 相手（建物・資源ノード）に届いたか。**相手の大きさを足して判定する**。
 * 4×4 の町の中心は縁に立っても中心まで 2 マス以上あるので、
 * 中心との距離を 1 マスで判定すると永久に到着しない（実測で資源が凍った）。
 */
function reachedTarget(w: World, i: number, targetIndex: number): boolean {
  const e = w.entities;
  const reach = interactReachTo(e, targetIndex);
  return distSq(e.x[i]!, e.y[i]!, e.x[targetIndex]!, e.y[targetIndex]!) <= reach * reach;
}

// ---------------------------------------------------------------- 村人の自動退避（T-M4-09）

/**
 * 村人を脅かしている敵ユニットの index（いなければ -1）。
 *
 * `07§8` は「攻撃された村人は…退避します」だが、「攻撃された」を被弾フラグで持つには
 * エンティティに新しい列が必要になる（`entity.ts` は M2 の担当で編集不可）。
 * ここでは **村人の視界内に敵の戦闘ユニットがいること**を脅威の定義にしている。
 * 追加の状態を持たずに済み、敵が去れば自動で仕事へ戻る（＝収入が復活する）。
 *
 * **申し送り**: `Entities` に `lastDamagedTick` を足せる段になったら、
 * この関数を「直近 n tick に被弾したか」に差し替えるとより資料に忠実になる。
 */
function findThreatIndex(w: World, vi: number): number {
  const e = w.entities;
  const sight = unitDef(e.typeId[vi]!).sight;
  if (sight <= 0) return -1;
  const out = w.scratch.neighbors;
  const n =
    w.grid.builtTick >= 0
      ? queryCircle(w.grid, e, e.x[vi]!, e.y[vi]!, sight, out)
      : queryCircleBruteForce(e, e.x[vi]!, e.y[vi]!, sight, out);
  const owner = e.owner[vi]! as PlayerId;
  for (let k = 0; k < n; k++) {
    const j = out[k]!;
    if (e.kind[j] !== EntityKind.Unit) continue;
    const other = e.owner[j]!;
    if (other >= w.playerCount) continue;
    if (areAllies(w, owner, other as PlayerId)) continue;
    const def = unitDef(e.typeId[j]!);
    // 村人同士のにらみ合いでは逃げない。攻撃力を持つ戦闘ユニットだけを脅威とする。
    if (def.atk <= 0 || def.roleIdx === unitDef(e.typeId[vi]!).roleIdx) continue;
    return j;
  }
  return -1;
}

/**
 * 最寄りの塔・櫓・城（`garrisonCapacity > 0`）へ退避させる。
 * 退避先が無ければその場から離れないが、いずれにせよ採集は止まる
 * （`07§8`「壊滅はしませんが、その間の収入は止まります」）。
 */
function fleeToShelter(w: World, i: number): void {
  const e = w.entities;
  const si = findNearestShelterIndex(w, e.owner[i]! as PlayerId, e.x[i]!, e.y[i]!);
  setVillagerState(e, i, UnitState.Moving, w.tick);
  if (si >= 0) {
    e.destX[i] = e.x[si]!;
    e.destY[i] = e.y[si]!;
  }
}

/** 退避が解けた村人を元の仕事へ戻す。 */
function resumeWork(w: World, i: number, ctx: EconomyTickContext): void {
  const e = w.entities;
  const ni = resolveIndex(e, e.target[i]!);
  if (ni >= 0 && isResourceNode(e, ni) && e.amount[ni]! > 0) {
    if (e.carryAmount[i]! >= ctx.carryCap) startHaul(w, i);
    else {
      setVillagerState(e, i, UnitState.Gathering, w.tick);
      e.destX[i] = e.x[ni]!;
      e.destY[i] = e.y[ni]!;
    }
    return;
  }
  if (e.carryAmount[i]! > 0) {
    startHaul(w, i);
    return;
  }
  // 覚えていたノードが尽きていたら、同じ資源の次のノードへ移る（`07§8`）。
  const kind = e.carryKind[i]! - 1;
  if (kind >= 0) seekSameResource(w, i, kind);
}

// ---------------------------------------------------------------- 交易荷車（T-M4-06）

/**
 * 交易荷車 1 台の 1 tick。
 *
 * `homeId` = 自分の市場（発地）、`target` = 交易相手の市場（着地）。
 * 「往路 / 復路」は **`carryKind` で表す**（0 = 往路、金 index + 1 = 復路で金を積んでいる）。
 * 新しい状態列を増やさずに済ませるための割り当て（`entity.ts` は編集不可）。
 *
 * 金は `07§8` どおり **往復 1 回につき「片道距離 × 0.5」**。着地に着いた時点で
 * 積み込み額が確定し、発地に戻った時点で加算される（途中で狙われて死ぬと入らない）。
 */
function tradeCartTick(w: World, i: number): void {
  const e = w.entities;
  const home = resolveIndex(e, e.homeId[i]!);
  const partner = resolveIndex(e, e.target[i]!);
  if (home < 0 || partner < 0) return;

  if (e.carryKind[i] === 0) {
    // 往路: 相手の市場へ。
    if (!reachedTarget(w, i, partner)) {
      e.destX[i] = e.x[partner]!;
      e.destY[i] = e.y[partner]!;
      return;
    }
    const oneWay = distanceFx(e.x[home]!, e.y[home]!, e.x[partner]!, e.y[partner]!);
    e.carryKind[i] = GOLD_RESOURCE + 1;
    e.carryAmount[i] = tradeGoldPerRoundTripFx(oneWay);
    e.destX[i] = e.x[home]!;
    e.destY[i] = e.y[home]!;
    return;
  }

  // 復路: 自分の市場へ。着いたら金が入る。
  if (!reachedTarget(w, i, home)) {
    e.destX[i] = e.x[home]!;
    e.destY[i] = e.y[home]!;
    return;
  }
  const pl = getPlayer(w, e.owner[i]! as PlayerId);
  if (pl !== undefined) {
    pl.resources[GOLD_RESOURCE] = pl.resources[GOLD_RESOURCE]! + e.carryAmount[i]!;
  }
  e.carryKind[i] = 0;
  e.carryAmount[i] = 0;
  e.destX[i] = e.x[partner]!;
  e.destY[i] = e.y[partner]!;
}

/**
 * 交易荷車に経路（自分の市場 → 相手の市場）を割り当てる。
 * UI / AI から呼ぶ入口。片道距離が長いほど 1 往復の収入が増える（T-M4-06）。
 */
export function assignTradeRoute(
  w: World,
  cartId: EntityId,
  homeMarketId: EntityId,
  partnerMarketId: EntityId
): boolean {
  const e = w.entities;
  const ci = resolveIndex(e, cartId);
  const hi = resolveIndex(e, homeMarketId);
  const pi = resolveIndex(e, partnerMarketId);
  if (ci < 0 || hi < 0 || pi < 0) return false;
  if (e.typeId[ci] !== TRADE_CART_TYPE) return false;
  if (e.kind[hi] !== EntityKind.Building || e.kind[pi] !== EntityKind.Building) return false;
  e.homeId[ci] = homeMarketId;
  e.target[ci] = partnerMarketId;
  e.carryKind[ci] = 0;
  e.carryAmount[ci] = 0;
  e.state[ci] = UnitState.Moving;
  e.stateTick[ci] = w.tick;
  e.destX[ci] = e.x[pi]!;
  e.destY[ci] = e.y[pi]!;
  return true;
}
