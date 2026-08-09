/**
 * システム 12/14: loyalty — 忠誠度の増減（`07§10`, 実装手順書 §6.8）
 *
 * 責務（`PlayerState.loyalty` は Fx、0..FX_ONE）:
 *  - 掟破り 各 -25%/回（掟一 碑の島で交戦 / 掟二 井戸破壊 / 掟三 種籾蔵破壊 /
 *    掟五 逃亡村人を 30 秒以内に攻撃）
 *  - 町の中心を失う -5%/1 つ
 *  - 戦域を 3 つ以上同時に見捨てる -10%（令を渡さず 60 秒放置し、その間に劣勢へ落ちた数。
 *    後退で畳んだ分は対象外）
 *  - 時間経過 +1% / 30 秒
 *  - 休戦の季を守り切る +15%（オプション有効時のみ）
 *
 * 閾値: < 80% → 令の遅延 +2 秒（`core/order.ts` が `loyalty` を見て加算する）/
 *       < 50% → 戦域 1 つが令を無視（`defected = true`）/ = 0% → 敗北（判定は `victory.ts`）。
 *
 * 離反対象の戦域の選び方は **slot 番号が最大のもの**（乱数を使わない）。
 *
 * 担当マイルストーン: **M11**（T-M11-01〜04, 07）。
 *
 * 仕様の注意（§16-7）: 「略奪」は井戸・種籾蔵を自動で狙わない
 * （`buildings.json` の `autoTargetable: false`）。掟破りは手動選択時のみ発生する。
 *
 * ---- 状態をどこに置いているか（申し送り）----
 *
 * 「令を渡さず 60 秒」「逃亡村人の 30 秒」「町の中心の前 tick の数」は**再現に必要な状態**
 * だが、`world.ts` を編集できないため `WeakMap<World, LoyaltyStore>` に置いている
 * （`systems/movement.ts` の経路バッファと同じ扱い）。
 * **状態ハッシュ（`sim/hash.ts`）の対象外**なので、ここだけはデシンク検出に載らない。
 * `World` に下記を足したら、この store を捨ててそちらへ移すこと:
 *   - `Front.orderlessSinceTick` / `Front.warnedWhileOrderless`
 *   - `PlayerState.townCenterCount`（前 tick の数）
 *   - `World.fleeingVillagers`（逃亡村人の id / 発生 tick / 前 tick の HP）
 *   - `World.truce`（休戦中に交戦したか / 報酬を配ったか）
 *   - `World.matchOptions`（試合オプション 7 種。今は `core/law.ts` の上書き口で代替）
 */

import type { PlayerId } from '@/shared/types';
import { EntityKind } from '@/shared/types';
import { MAX_FRONTS, MAX_PLAYERS, getPlayer, type World } from '../core/world';
import { effectiveOrderOf, isFrontWarning } from '../core/front';
import {
  UnitState,
  entityGeneration,
  entityIndex,
  markDeadIndex,
  spawnEntity,
} from '../core/entity';
import { buildingDef, orderDefById, unitDefById } from '../core/defs';
import { applyUnitStat, getPlayerModifiers, isBuildingComplete } from '../core/effects';
import type { Fx } from '../core/fx';
import { FX_ONE, fxFromInt, fxMul } from '../core/fx';
import {
  LAW_FLEEING_VILLAGER,
  LAW_MONOLITH_ISLE,
  addLoyalty,
  blameLastDamager,
  buildingLawViolation,
  defectRecovers,
  fleeingVillagerCount,
  fleeingVillagerSpacing,
  fleeingVillagerWindowTicks,
  frontSlotCap,
  isCityBuilding,
  isDefeatCriticalBuilding,
  isInLawOneZone,
  isTruceActive,
  lawPenalty,
  lawsEnabled,
  loyaltyAbandonCountThreshold,
  loyaltyAbandonExcludesRetreat,
  loyaltyAbandonIdleTicks,
  loyaltyAbandonPenalty,
  loyaltyLoseTownCenter,
  loyaltyRegenAmount,
  loyaltyRegenPeriodTicks,
  loyaltyThresholdDefect,
  truceBlocksNewFronts,
  truceEndTick,
  truceKeptBonus,
  truceSeasonEnabled,
  truceStopsEngaging,
} from '../core/law';

/** 村人の unit ID（逃亡村人はこの型で出す）。 */
const VILLAGER_ID = 'villager';

/** 後退の令の ID（これを渡した戦域は「見捨てた」に数えない）。 */
const RETREAT_ORDER_ID = 'retreat';

/** `fronts` の長さ（プレイヤーごとに MAX_FRONTS 枠）。 */
const SLOT_COUNT = MAX_PLAYERS * MAX_FRONTS;

/** 「令が無い期間」が始まっていないことを表す番兵。 */
const NO_ORDERLESS = -1;

/**
 * 休戦中に立てておくクールダウン（tick）。
 * `combat.coolingDown` は「1 減らしてから 0 より大きいか」を見るので 2 が最小値。
 */
const TRUCE_COOLDOWN = 2;

/** 逃亡村人 1 体の追跡情報。 */
interface FleeingVillager {
  /** 生成時の EntityId（index 再利用の検出に使う）。 */
  readonly id: number;
  /** 逃げ出した tick（`fleeingVillagerWindowSec` の起点）。 */
  readonly spawnTick: number;
  /** 前 tick の HP（Fx）。減っていたら「攻撃された」。 */
  prevHp: Fx;
  /** 元の持ち主（落城した城・町の中心の所有者）。 */
  readonly owner: PlayerId;
  /** 追跡終了（成立済み / 消滅済み）。 */
  done: boolean;
}

/** M11 が必要とする状態（**ハッシュ対象外**。上のコメント参照）。 */
interface LoyaltyStore {
  /** 掟一を既に課した戦域（戦域が閉じるまで二重に課さない）。 */
  readonly lawOneCharged: Uint8Array;
  /** 令が無い期間の開始 tick（-1 = 令がある / 非活性）。 */
  readonly orderlessSince: Int32Array;
  /** その期間中に劣勢（警告）へ落ちたか。 */
  readonly warnedWhileOrderless: Uint8Array;
  /** 前 tick の町の中心の数（喪失の検出用。-1 = 未初期化）。 */
  readonly townCenters: Int32Array;
  /** 休戦中に交戦したか（守り切ったかの判定）。 */
  readonly truceEngaged: Uint8Array;
  /** 休戦の報酬を配ったか。 */
  truceRewarded: boolean;
  /** 逃亡村人の追跡（生成順 = tick 昇順・index 昇順）。 */
  readonly fleeing: FleeingVillager[];
}

const stores = new WeakMap<World, LoyaltyStore>();

function getStore(w: World): LoyaltyStore {
  let s = stores.get(w);
  if (s === undefined) {
    s = {
      lawOneCharged: new Uint8Array(SLOT_COUNT),
      orderlessSince: new Int32Array(SLOT_COUNT).fill(NO_ORDERLESS),
      warnedWhileOrderless: new Uint8Array(SLOT_COUNT),
      townCenters: new Int32Array(MAX_PLAYERS).fill(-1),
      truceEngaged: new Uint8Array(MAX_PLAYERS),
      truceRewarded: false,
      fleeing: [],
    };
    stores.set(w, s);
  }
  return s;
}

/** テスト用。World に紐づいた M11 の作業状態を捨てる。 */
export function resetLoyaltyState(w: World): void {
  stores.delete(w);
}

/** 追跡中の逃亡村人の数（テスト・HUD 用）。 */
export function fleeingVillagerTrackCount(w: World): number {
  const s = stores.get(w);
  if (s === undefined) return 0;
  let n = 0;
  for (let k = 0; k < s.fleeing.length; k++) if (!s.fleeing[k]!.done) n += 1;
  return n;
}

// ---------------------------------------------------------------------------
// システム本体
// ---------------------------------------------------------------------------

export function loyalty(w: World): void {
  const s = getStore(w);

  // 休戦の季（`07§14`）は「掟の適用」とは別のオプションなので、
  // 掟が無効でも休戦そのものは働く（新しい戦域が立たない / 交戦をやめる）。
  enforceTruce(w, s);
  enforceFrontSlotCap(w);

  // 掟の適用が無効なら、忠誠度の仕組みごと働かない（`07§14`）。
  // 既に出ている逃亡村人の掃除だけは続ける（罰は与えない）。
  if (!lawsEnabled()) {
    trackFleeingVillagers(w, s, false);
    return;
  }

  trackFleeingVillagers(w, s, true); // 掟五（30 秒以内の攻撃）
  chargeLawOne(w, s); //               掟一（碑の島で交戦）
  chargeDestroyedLawBuildings(w); //   掟二・三（井戸・種籾蔵）
  chargeTownCenterLoss(w, s); //       町の中心 -5%
  chargeAbandonedFronts(w, s); //      戦域 3 つ以上の見捨て -10%
  grantTruceBonus(w, s); //            休戦を守り切った +15%
  regenerate(w); //                    +1% / 30 秒
  applyThresholds(w); //               50% 未満で戦域 1 つが離反
}

// ---------------------------------------------------------------- T-M11-01 自然回復

/**
 * 自然回復 +1% / 30 秒（`loyalty.regenPer30s` / `loyalty.regenPeriodSec`）。
 *
 * 周期の頭でまとめて足す（毎 tick 1/750 を足すと Fx で 0 に丸まって永久に回復しない）。
 * 投了・敗北したプレイヤーには足さない。
 */
function regenerate(w: World): void {
  const period = loyaltyRegenPeriodTicks();
  if (period <= 0 || w.tick <= 0 || w.tick % period !== 0) return;
  const amount = loyaltyRegenAmount();
  for (let p = 0; p < w.playerCount; p++) {
    const pl = w.players[p]!;
    if (pl.resigned || pl.defeated) continue;
    addLoyalty(w, p as PlayerId, amount);
  }
}

// ---------------------------------------------------------------- T-M11-02 掟一

/**
 * 掟一「碑の島では戦わない」。
 *
 * `combat` の後に走るので、**今 tick に実ダメージが出た戦域**（`lastEngageTick === tick`）
 * の中心が掟一の領域に入っているかを見る。成立したら戦域ごとに 1 回だけ課し、
 * その戦域が閉じるまで再度は課さない（「-25% / 回」の「1 回」の単位を戦域にする）。
 */
function chargeLawOne(w: World, s: LoyaltyStore): void {
  if (w.map.lawZones.length === 0) {
    s.lawOneCharged.fill(0);
    return;
  }
  for (let fi = 0; fi < SLOT_COUNT; fi++) {
    const f = w.fronts[fi]!;
    if (!f.active) {
      s.lawOneCharged[fi] = 0;
      continue;
    }
    if (s.lawOneCharged[fi] === 1) continue;
    if (f.lastEngageTick !== w.tick) continue;
    if (!isInLawOneZone(w.map, f.x, f.y)) continue;
    s.lawOneCharged[fi] = 1;
    addLoyalty(w, f.owner, lawPenalty(LAW_MONOLITH_ISLE));
  }
}

// ---------------------------------------------------------------- T-M11-02 掟二・三

/**
 * 掟二「井戸を埋めない」・掟三「種籾を焼かない」。
 *
 * `cleanup` より前に走るので、今 tick に HP 0 になった付属物は
 * まだ `pendingDead` に残っている（`alive = 0` だが座標と typeId は生きている）。
 * 犯人は `Entities.lastDamagedBy`（**最後に実際に壊した者**）で決める。
 * 味方の範囲攻撃で割れた場合も、割ったのはその味方なのでその者が罰される。
 * ダメージの記録が無い（スクリプトによる除去など）場合は誰も罰されない。
 */
function chargeDestroyedLawBuildings(w: World): void {
  const e = w.entities;
  const n = e.pendingDeadCount;
  if (n === 0) return;

  // index 昇順に処理する（`cleanup` と同じ全順序）。`pendingDead` 自体は並べ替えない。
  const order: number[] = [];
  for (let k = 0; k < n; k++) order.push(e.pendingDead[k]!);
  order.sort((a, b) => a - b);

  for (let k = 0; k < order.length; k++) {
    const i = order[k]!;
    const kind = e.kind[i]!;
    if (kind !== EntityKind.Building && kind !== EntityKind.Attachment) continue;
    const lawId = buildingLawViolation(e.typeId[i]!);
    if (lawId === null) continue;
    const culprit = blameLastDamager(w, i);
    if (culprit < 0) continue;
    addLoyalty(w, culprit, lawPenalty(lawId));
  }
}

// ---------------------------------------------------------------- T-M11-02 掟五

/**
 * 掟五「降った城の民は通す」の逃亡村人を出す（`cleanup` の建物破壊フックが呼ぶ）。
 *
 * 落ちた城・町の中心（`isCityBuilding` = 令の発信点）の地点から、
 * **いちばん近いマップ端へ向かって歩く村人**を数体出す。
 *  - `manual = 1`（自律判断・令の対象から外す。`unitDecision` / `economy` が触らない）
 *  - `state = Moving` + `destX/destY` = 最寄りのマップ端（`movement` が歩かせる）
 *  - `fleeingVillagerWindowSec`（30 秒）で消える（放置すればマップ外へ消える）
 *  - その間に攻撃されたら掟五が成立し、**攻撃した側**の忠誠度が -25%
 *
 * 所有者は落城した側のまま（`07§10`「降った城の民」）。中立にすると
 * `combat.isEnemy` が中立を敵と見なさないため、そもそも攻撃できなくなる。
 */
export function spawnFleeingVillagers(w: World, buildingIndexValue: number): void {
  if (!lawsEnabled()) return;
  const e = w.entities;
  const i = buildingIndexValue;
  if (e.kind[i] !== EntityKind.Building) return;
  if (!isCityBuilding(e.typeId[i]!)) return;
  const owner = e.owner[i]!;
  if (owner >= w.playerCount) return;

  const count = fleeingVillagerCount();
  if (count <= 0) return;

  const s = getStore(w);
  const udef = unitDefById(VILLAGER_ID);
  const hpMax = applyUnitStat(getPlayerModifiers(w, owner as PlayerId), udef, 'hp', udef.hp);
  const spacing = fleeingVillagerSpacing();
  const x0 = e.x[i]!;
  const y0 = e.y[i]!;
  const dest = nearestMapEdge(w, x0, y0);

  for (let k = 0; k < count; k++) {
    // 並べる方向は「逃げる向きに直交する軸」。乱数を使わず等間隔に並べる。
    const offset = fxMul(spacing, fxFromInt(k - (count >> 1)));
    const px = dest.horizontal ? x0 : x0 + offset;
    const py = dest.horizontal ? y0 + offset : y0;
    let id: number;
    try {
      id = spawnEntity(e, {
        kind: EntityKind.Unit,
        owner: owner as PlayerId,
        typeId: udef.index,
        x: px,
        y: py,
        hpMax,
      });
    } catch {
      // 容量が尽きているときは掟五を諦める（試合を落とさない）。
      return;
    }
    const idx = entityIndex(id);
    e.manual[idx] = 1;
    e.state[idx] = UnitState.Moving;
    e.stateTick[idx] = w.tick;
    e.destX[idx] = dest.x;
    e.destY[idx] = dest.y;
    s.fleeing.push({
      id,
      spawnTick: w.tick,
      prevHp: e.hp[idx]!,
      owner: owner as PlayerId,
      done: false,
    });
  }
}

/** いちばん近いマップ端（そこへ着いたらマップ外へ消えたものとして扱う）。 */
function nearestMapEdge(w: World, x: Fx, y: Fx): { x: Fx; y: Fx; horizontal: boolean } {
  const maxX = w.map.widthTiles * FX_ONE - FX_ONE;
  const maxY = w.map.heightTiles * FX_ONE - FX_ONE;
  const dists = [x, maxX - x, y, maxY - y];
  // 同値のタイブレークは 左 → 右 → 上 → 下 の固定順（乱数を使わない）。
  let bestK = 0;
  for (let k = 1; k < dists.length; k++) if (dists[k]! < dists[bestK]!) bestK = k;
  if (bestK === 0) return { x: 0, y, horizontal: true };
  if (bestK === 1) return { x: maxX, y, horizontal: true };
  if (bestK === 2) return { x, y: 0, horizontal: false };
  return { x, y: maxY, horizontal: false };
}

/**
 * 逃亡村人の追跡を 1 tick 進める。
 *  - HP が減っていた（または死んでいた）→ 掟五成立。犯人に -25%
 *  - 30 秒経った / マップ端に着いた → マップ外へ消えた（`markDeadIndex`）
 *
 * @param charge false なら掟の適用が無効。罰は与えず掃除だけ行う。
 */
function trackFleeingVillagers(w: World, s: LoyaltyStore, charge: boolean): void {
  if (s.fleeing.length === 0) return;
  const e = w.entities;
  const window = fleeingVillagerWindowTicks();

  for (let k = 0; k < s.fleeing.length; k++) {
    const fv = s.fleeing[k]!;
    if (fv.done) continue;
    const idx = entityIndex(fv.id);
    // index が再利用されていたら追跡終了（別のエンティティになっている）。
    if (e.generation[idx]! !== entityGeneration(fv.id)) {
      fv.done = true;
      continue;
    }
    const dead = e.alive[idx] !== 1;
    const hp = e.hp[idx]!;
    if (dead || hp < fv.prevHp) {
      // 攻撃された（または撃ち殺された）。30 秒以内なら掟五が成立する。
      if (charge && w.tick - fv.spawnTick <= window) {
        const culprit = blameNearestEnemy(w, fv.owner, e.x[idx]!, e.y[idx]!);
        if (culprit >= 0) addLoyalty(w, culprit, lawPenalty(LAW_FLEEING_VILLAGER));
      }
      fv.done = true;
      continue;
    }
    fv.prevHp = hp;

    // 期限切れ / マップ端に到達 → マップ外へ消える。
    const arrived = e.destX[idx] === e.x[idx] && e.destY[idx] === e.y[idx];
    if (w.tick - fv.spawnTick >= window || arrived) {
      markDeadIndex(e, idx);
      fv.done = true;
    }
  }

  // 追跡終了ぶんを前詰めで捨てる（相対順序は保つ）。
  let write = 0;
  for (let k = 0; k < s.fleeing.length; k++) {
    const fv = s.fleeing[k]!;
    if (fv.done) continue;
    s.fleeing[write] = fv;
    write += 1;
  }
  s.fleeing.length = write;
}

// ---------------------------------------------------------------- T-M11-03 町の中心

/**
 * 町の中心を失うと -5% / 1 つ（`loyalty.loseTownCenter`）。
 *
 * 前 tick の数と比べて減った分だけ課す。建設中の町の中心は数えない
 * （まだ「持っている」とは言えないため）。
 */
function chargeTownCenterLoss(w: World, s: LoyaltyStore): void {
  const counts = countTownCenters(w);
  const penalty = loyaltyLoseTownCenter();
  for (let p = 0; p < w.playerCount; p++) {
    const prev = s.townCenters[p]!;
    const now = counts[p]!;
    if (prev >= 0 && now < prev) addLoyalty(w, p as PlayerId, penalty * (prev - now));
    s.townCenters[p] = now;
  }
}

/** プレイヤーごとの「完成した町の中心」の数（`victory.ts` も使う）。 */
export function countTownCenters(w: World): Int32Array {
  const out = new Int32Array(MAX_PLAYERS);
  const e = w.entities;
  for (let i = 0; i < e.highWater; i++) {
    if (e.alive[i] !== 1) continue;
    if (e.kind[i] !== EntityKind.Building) continue;
    const owner = e.owner[i]!;
    if (owner >= w.playerCount) continue;
    if (!isDefeatCriticalBuilding(e.typeId[i]!)) continue;
    if (!isBuildingComplete(w, i)) continue;
    out[owner] = out[owner]! + 1;
  }
  return out;
}

// ---------------------------------------------------------------- T-M11-03 見捨て

/**
 * 戦域を 3 つ以上同時に見捨てると -10%（`loyalty.abandonFronts`）。
 *
 * 「見捨てる」= **令を渡さないまま `abandonIdleSec`（60 秒）放置し、その間に劣勢へ落ちた**戦域。
 *
 * 60 秒の計測（`World` に列を足せないので store で持つ）:
 *   - 令が無い戦域は `orderlessSince` に「令が無くなった tick」を入れる
 *   - その期間に `isFrontWarning`（advantage < -30%）になったら `warnedWhileOrderless = 1`
 *   - 令が届いた / 戦域が閉じたら両方リセット（**後退の令で畳んだ戦域は令があるので対象外**）
 *   - 条件を満たす戦域が同時に 3 つ以上あったら -10% を 1 回課し、時計を今から巻き直す
 */
function chargeAbandonedFronts(w: World, s: LoyaltyStore): void {
  const idle = loyaltyAbandonIdleTicks();
  const threshold = loyaltyAbandonCountThreshold();
  // フラグを読んでいることを明示する（後退は「令がある」ので自動的に対象外になる）。
  const excludesRetreat = loyaltyAbandonExcludesRetreat();
  if (excludesRetreat) orderDefById(RETREAT_ORDER_ID);

  for (let p = 0; p < w.playerCount; p++) {
    let abandoned = 0;
    const base = p * MAX_FRONTS;
    for (let slot = 1; slot <= MAX_FRONTS; slot++) {
      const fi = base + (slot - 1);
      const f = w.fronts[fi]!;
      if (!f.active) {
        s.orderlessSince[fi] = NO_ORDERLESS;
        s.warnedWhileOrderless[fi] = 0;
        continue;
      }
      // 令を渡してある（後退で畳んだ場合もここに入る = 対象外）。
      // 離反した戦域は `effectiveOrderOf` が null を返すが、令は渡してあるので
      // `order` / `orderLower` の有無で見る。
      if (f.order !== null || f.orderLower !== null || effectiveOrderOf(f) !== null) {
        s.orderlessSince[fi] = NO_ORDERLESS;
        s.warnedWhileOrderless[fi] = 0;
        continue;
      }
      if (s.orderlessSince[fi] === NO_ORDERLESS) s.orderlessSince[fi] = w.tick;
      if (isFrontWarning(f)) s.warnedWhileOrderless[fi] = 1;
      if (s.warnedWhileOrderless[fi] === 1 && w.tick - s.orderlessSince[fi]! >= idle) {
        abandoned += 1;
      }
    }
    if (abandoned < threshold) continue;
    addLoyalty(w, p as PlayerId, loyaltyAbandonPenalty());
    // 二重に課さないよう、放置中の戦域の時計を巻き直す。
    for (let slot = 1; slot <= MAX_FRONTS; slot++) {
      const fi = base + (slot - 1);
      if (s.orderlessSince[fi] === NO_ORDERLESS) continue;
      s.orderlessSince[fi] = w.tick;
      s.warnedWhileOrderless[fi] = 0;
    }
  }
}

// ---------------------------------------------------------------- T-M11-04 閾値

/**
 * 忠誠度の閾値の適用（`07§10`）。
 *
 *  - `< 80%` … 令の遅延 +2 秒。**ここでは何もしない**。`core/order.ts` の
 *    `orderDelayInputFor` が `loyalty < loyalty.thresholdDelayPenalty` を見て
 *    `order.lowLoyaltyPenaltySec` を足すので、値が下がれば自動で効く。
 *  - `< 50%` … 戦域 1 つが令を無視する（`defected = true`）。対象は **slot 番号が最大**の
 *    活性戦域（乱数を使わない。手順書 §6.8）。カードを差し替えても反応しないのは
 *    `orderDelivery` が離反中の戦域に届いた令を捨てるため。
 *  - `= 0%` … 敗北。判定は `victory.ts`。
 */
function applyThresholds(w: World): void {
  const defectAt = loyaltyThresholdDefect();
  const recovers = defectRecovers();

  for (let p = 0; p < w.playerCount; p++) {
    const pl = w.players[p]!;
    const base = p * MAX_FRONTS;
    if (pl.loyalty < defectAt) {
      // 既に離反している戦域があれば増やさない（「戦域 1 つ」）。
      let already = false;
      for (let slot = 1; slot <= MAX_FRONTS; slot++) {
        const f = w.fronts[base + (slot - 1)]!;
        if (f.active && f.defected) {
          already = true;
          break;
        }
      }
      if (already) continue;
      // slot 番号が最大の活性戦域を選ぶ。
      for (let slot = MAX_FRONTS; slot >= 1; slot--) {
        const f = w.fronts[base + (slot - 1)]!;
        if (!f.active) continue;
        f.defected = true;
        break;
      }
      continue;
    }
    if (!recovers) continue;
    // 閾値まで戻ったら旗も戻る。
    for (let slot = 1; slot <= MAX_FRONTS; slot++) {
      const f = w.fronts[base + (slot - 1)]!;
      if (f.defected) f.defected = false;
    }
  }
}

// ---------------------------------------------------------------- T-M11-07 休戦の季

/**
 * 休戦の季（`07§14`）。
 *
 *  - **新しい戦域が発生しない**: 孵化中のスロット（`candidateTicks`）を毎 tick 0 に戻す。
 *    `frontLifecycle` は「連続 2 秒」で戦域化するので、毎 tick 潰せば発生しない。
 *  - **既存戦域は令を維持したまま交戦をやめる**: 攻撃できるユニット・砲台建物の
 *    `cooldown` を毎 tick 立てておく（`combat.coolingDown` が攻撃を見送る）。
 *    令（`Front.order`）には手を触れないので睨み合いになる。
 *  - 休戦中に交戦した（実ダメージが出た）プレイヤーを記録し、
 *    守り切った側に終了時 +15%（`grantTruceBonus`）。
 *
 * **申し送り**: 本来は `combat` / `frontLifecycle` が休戦フラグを見るのが素直。
 * 今は両ファイルを編集できないため、このシステムから外側で押さえている。
 */
function enforceTruce(w: World, s: LoyaltyStore): void {
  if (!isTruceActive(w)) return;

  if (truceBlocksNewFronts()) {
    for (let fi = 0; fi < SLOT_COUNT; fi++) {
      const f = w.fronts[fi]!;
      if (f.active) continue;
      f.candidateTicks = 0;
      f.candidateDamageSeen = false;
    }
  }

  // 休戦を破った側の記録（`combat` が今 tick に実ダメージを入れた戦域を見る）。
  for (let fi = 0; fi < SLOT_COUNT; fi++) {
    const f = w.fronts[fi]!;
    if (!f.active) continue;
    if (f.lastEngageTick === w.tick) s.truceEngaged[f.owner] = 1;
  }

  if (!truceStopsEngaging()) return;
  const e = w.entities;
  for (let i = 0; i < e.highWater; i++) {
    if (e.alive[i] !== 1) continue;
    const owner = e.owner[i]!;
    if (owner >= w.playerCount) continue;
    const kind = e.kind[i]!;
    let armed = false;
    if (kind === EntityKind.Unit) armed = true;
    else if (kind === EntityKind.Building) armed = buildingDef(e.typeId[i]!).attackDamage > 0;
    if (!armed) continue;
    if (e.cooldown[i]! < TRUCE_COOLDOWN) e.cooldown[i] = TRUCE_COOLDOWN;
  }
}

/** 休戦を守り切ったら +15%（`matchOptions.truceSeason.loyaltyBonusOnKept`）。 */
function grantTruceBonus(w: World, s: LoyaltyStore): void {
  if (s.truceRewarded) return;
  if (!truceSeasonEnabled()) return;
  if (w.tick < truceEndTick()) return;
  s.truceRewarded = true;
  const bonus = truceKeptBonus();
  for (let p = 0; p < w.playerCount; p++) {
    if (s.truceEngaged[p] === 1) continue;
    addLoyalty(w, p as PlayerId, bonus);
  }
}

// ---------------------------------------------------------------- T-M11-07 スロット上限

/**
 * 戦域スロット上限（`matchOptions.frontSlotCap`。2..6）。
 *
 * `production.recomputeFrontSlots` は時代 + 城 + 研究から `frontSlots` を作って
 * `MAX_FRONTS` で止めるだけなので、オプションの上限はここで被せる。
 * `acquireFrontSlot` が `frontSlots` を見るため、これだけで新しい戦域が上限を超えない。
 */
function enforceFrontSlotCap(w: World): void {
  const cap = frontSlotCap();
  for (let p = 0; p < w.playerCount; p++) {
    const pl = getPlayer(w, p as PlayerId);
    if (pl === undefined) continue;
    if (pl.frontSlots > cap) pl.frontSlots = cap;
  }
}
