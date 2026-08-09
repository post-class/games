/**
 * sim/command.ts — 入力コマンドの型と適用（実装手順書 §6.11、システム 1/14）
 *
 * **World の状態変更はすべて Command 経由。** これが対戦・リプレイ・AI を
 * 同一機構にする根拠（`07§12`）。UI / input / ai / net は Command を作るだけで、
 * World を直接書き換えない。
 *
 * 規約:
 *  - Command は **シリアライズ可能な平坦な値のみ**。関数・クラス・オブジェクト参照を含めない
 *    （JSON 往復で同値になること。T-M2-08）。
 *  - `stepWorld` に渡す配列は「この tick に確定した全プレイヤーの入力」を
 *    **playerId 昇順、同一 playerId 内は発行順**に並べたもの。順序が変わると結果が変わる。
 *  - 不正な Command（他人のユニットを動かす、資源不足、存在しない EntityId など）は
 *    **例外を投げずに黙って無視する**。通信相手の古い入力で試合が落ちてはいけない。
 *
 * ---- このファイルの役割は「結線」だけ ----
 *
 * 判定と状態変更の本体は各システムの公開関数にある（`production.ts` / `construction.ts` /
 * `core/market.ts` / `core/gather.ts`）。ここでは
 *   ① プレイヤーの妥当性 → ② 対象の所有者・生存 → ③ 種別・前提 → ④ システムへ委譲
 * の順に並べるだけで、**バランス数値も文明名も建物名もここには書かない**。
 *
 * 不正入力の扱いは「黙って無視」で統一している。理由は各 case のコメントに書く。
 * 例外を投げると、遅延した通信入力 1 件で全員の試合が止まる。
 */

import type {
  BuildingTypeId,
  EntityId,
  OrderId,
  PlayerId,
  ResourceId,
  TechId,
  Tier,
  UnitTypeId,
} from '@/shared/types';
import { EntityKind, INVALID_ENTITY, RESOURCE_IDS } from '@/shared/types';
import type { Fx } from './core/fx';
import { FX_HALF, FX_ONE, idiv } from './core/fx';
import { TICK_RATE, cfgInt, cfgNum } from './core/config';
import type { BuildingDef, OrderDef, TechDef, UnitDef } from './core/defs';
import { BUILDING_DEFS, ORDER_DEFS, TECH_DEFS, UNIT_DEFS } from './core/defs';
import { UnitState, resolveIndex } from './core/entity';
import { getPlayerModifiers, orderStackSlots, orderSwitchIntervalMul } from './core/effects';
import { orderDelayTicks } from './core/order';
import { assignVillagerToNode, isResourceNode, isVillagerIndex } from './core/gather';
import { marketBuy, marketSell, tribute as tributeResources } from './core/market';
import { hasPopRoomFor } from './core/population';
import type { World } from './core/world';
import { areAllies, getFront, isOwnedBy } from './core/world';
import { moveStructure } from './core/structure';
import { beginConstruction } from './systems/construction';
import {
  cancelQueueItem,
  queueUnitProduction,
  setRallyPoint,
  startAgeAdvance,
  startResearch,
} from './systems/production';

/**
 * 全 16 種のコマンド。実装手順書 §6.11 の定義そのまま。
 * 追加するときは `applyCommands` の switch と tests/unit/command.test.ts の
 * 網羅テーブルの両方を必ず更新する（TS が漏れを検出する）。
 */
export type Command =
  | { t: 'setOrder'; p: PlayerId; front: number; order: OrderId; tier: Tier }
  | { t: 'produce'; p: PlayerId; building: EntityId; unit: UnitTypeId; count: number }
  | { t: 'cancelQueue'; p: PlayerId; building: EntityId; index: number }
  | { t: 'placeBuilding'; p: PlayerId; type: BuildingTypeId; x: Fx; y: Fx; villagers: EntityId[] }
  | { t: 'placeWallLine'; p: PlayerId; type: BuildingTypeId; x0: Fx; y0: Fx; x1: Fx; y1: Fx }
  | { t: 'moveUnits'; p: PlayerId; units: EntityId[]; x: Fx; y: Fx; queued: boolean }
  | { t: 'attackTarget'; p: PlayerId; units: EntityId[]; target: EntityId }
  | { t: 'gather'; p: PlayerId; units: EntityId[]; target: EntityId }
  | { t: 'releaseManual'; p: PlayerId; units: EntityId[] }
  | { t: 'research'; p: PlayerId; building: EntityId; tech: TechId }
  | { t: 'advanceAge'; p: PlayerId; building: EntityId }
  | { t: 'marketTrade'; p: PlayerId; sell: ResourceId; buy: ResourceId; amount: number }
  | { t: 'tribute'; p: PlayerId; to: PlayerId; resource: ResourceId; amount: number }
  | { t: 'setRally'; p: PlayerId; building: EntityId; x: Fx; y: Fx }
  | {
      /**
       * 建物を畳んで動かす（モンゴルの大天幕。`03§3` / `07§4`）。
       * 動かせるのは `movable` な完成済みの自軍建物だけ。
       * 大天幕は**令の発信点**なので、動かすと令の遅延が変わる。
       */
      t: 'foldStructure';
      p: PlayerId;
      building: EntityId;
      x: Fx;
      y: Fx;
    }
  | { t: 'resign'; p: PlayerId };

/** Command の判別子。 */
export type CommandType = Command['t'];

/** 特定の判別子の Command 型を取り出す補助型（テストと input 層で使う）。 */
export type CommandOf<T extends CommandType> = Extract<Command, { t: T }>;

/** 全コマンド種別の固定順リスト（リプレイのバイナリ化で ID として使う）。 */
export const COMMAND_TYPES = [
  'setOrder',
  'produce',
  'cancelQueue',
  'placeBuilding',
  'placeWallLine',
  'moveUnits',
  'attackTarget',
  'gather',
  'releaseManual',
  'research',
  'advanceAge',
  'marketTrade',
  'tribute',
  'setRally',
  'foldStructure',
  'resign',
] as const satisfies readonly CommandType[];

/** switch の網羅性を型で保証する。 */
function unreachable(_c: never): void {
  /* 到達しない。新しい Command 型を足すとここで型エラーになる。 */
}

// ---------------------------------------------------------------------------
// マスターデータの「存在するか」判定
//
// `defs.ts` の `unitDefById` などは未知の ID で例外を投げる（データの誤りを
// 起動時に落とすための設計）。Command は**外から来る信用できない入力**なので、
// 例外にせず「無い」を返せる引き方が必要。`Map` はキー引きにしか使わないので
// 反復順の問題は起きない（§0.3）。
// ---------------------------------------------------------------------------

const UNIT_BY_ID = new Map<string, UnitDef>(UNIT_DEFS.map((d) => [d.id, d]));
const BUILDING_BY_ID = new Map<string, BuildingDef>(BUILDING_DEFS.map((d) => [d.id, d]));
const TECH_BY_ID = new Map<string, TechDef>(TECH_DEFS.map((d) => [d.id, d]));
const ORDER_BY_ID = new Map<string, OrderDef>(ORDER_DEFS.map((d) => [d.id, d]));

/** 令の切り替え間隔の基準 tick 数（`config.order.switchIntervalSec` = 6 秒）。 */
const ORDER_SWITCH_BASE_TICKS = Math.round(cfgNum('order.switchIntervalSec') * TICK_RATE);

/**
 * 下段の令を使うのに必要な「重ねられる枚数」。
 * `config.order.doubleFlagUpperCount`（1）+ `doubleFlagLowerCount`（1）= 2。
 */
const DOUBLE_FLAG_SLOTS =
  cfgInt('order.doubleFlagUpperCount') + cfgInt('order.doubleFlagLowerCount');

// ---------------------------------------------------------------------------
// 共通の検証ヘルパ
// ---------------------------------------------------------------------------

/** 有限の整数か（NaN / Infinity / 小数を弾く。Fx はすべて整数）。 */
function isInt(v: number): boolean {
  return Number.isInteger(v);
}

/** マップ内の座標か（Fx）。範囲外への設置・移動指示は捨てる。 */
function inMap(w: World, x: Fx, y: Fx): boolean {
  if (!isInt(x) || !isInt(y)) return false;
  return x >= 0 && y >= 0 && x < w.map.widthTiles * FX_ONE && y < w.map.heightTiles * FX_ONE;
}

/** Fx 座標 → マス番号（0 方向切り捨て。負値は inMap で弾いてある）。 */
function tileOf(v: Fx): number {
  return idiv(v, FX_ONE);
}

/** マス番号 → マス中心の Fx 座標。 */
function tileCenter(t: number): Fx {
  return t * FX_ONE + FX_HALF;
}

/** 生存していて、そのプレイヤーが所有する**ユニット**の index。無ければ -1。 */
function ownUnitIndex(w: World, id: EntityId, p: PlayerId): number {
  const e = w.entities;
  const i = resolveIndex(e, id);
  if (i < 0) return -1;
  if (e.kind[i] !== EntityKind.Unit) return -1;
  if (e.owner[i] !== p) return -1;
  return i;
}

/** 資源 ID → 添字。未知の資源は -1。 */
function resourceOf(id: ResourceId): number {
  return RESOURCE_IDS.indexOf(id);
}

// ---------------------------------------------------------------------------
// 適用
// ---------------------------------------------------------------------------

/**
 * システム 1/14: 入力を適用する。
 *
 * 担当マイルストーン: 枠は M2、各機構への結線は M10（統合）。
 *  - setOrder → 切り替え間隔の判定と pendingOrder の格納まで（遅延の本計算は M9）
 *  - produce / cancelQueue / research / advanceAge / setRally → `production.ts`
 *  - placeBuilding / placeWallLine → `construction.ts`
 *  - moveUnits / attackTarget / gather / releaseManual → `manual` フラグと目標の設定
 *  - marketTrade / tribute → `core/market.ts`
 *  - resign → `PlayerState.resigned`（判定は M11 の victory）
 */
export function applyCommands(w: World, cmds: readonly Command[]): void {
  for (let k = 0; k < cmds.length; k++) {
    applyCommand(w, cmds[k]!);
  }
}

/** 1 件の Command を適用する。不正な入力は黙って無視する。 */
function applyCommand(w: World, c: Command): void {
  // プレイヤー番号が範囲外・敗北済みの入力は捨てる（通信の遅延入力対策）。
  const pl = c.p >= 0 && c.p < w.playerCount ? w.players[c.p] : undefined;
  if (pl === undefined || pl.defeated) return;
  // 投了済みプレイヤーの入力も捨てる（服属した側は以後の操作権を持たない。`03§10`）。
  // `resign` 自体も冪等なので、ここで落として構わない。
  if (pl.resigned) return;

  switch (c.t) {
    // ---------------------------------------------------------------- 令
    case 'setOrder': {
      // 無視する条件（すべて「黙って」）:
      //  - 未知の令 ID / 段が令の定義と違う（改造クライアント・古いリプレイ）
      //  - 他文明の固有令
      //  - 下段は二重旗（`orderStackSlots >= 2`）を取っていないと使えない
      //  - スロットが未使用 / 自分のものでない / 使用可能スロット数を超えている
      //  - 配達中の令がある（`06§4`「連打しないでください」を入力段で吸収する）
      //  - 前の令の発効から切り替え間隔（6 秒 / 早馬 4.2 秒）が経っていない
      const odef = ORDER_BY_ID.get(c.order);
      if (odef === undefined) return;
      if (odef.tier !== c.tier) return;
      if (odef.civ !== null && odef.civ !== pl.civ) return;
      const m = getPlayerModifiers(w, c.p);
      // 下段を使うには「上段 1 + 下段 1」= 2 枚を重ねられること（研究「二重旗」。`07§4`）。
      if (c.tier === 'lower' && orderStackSlots(m) < DOUBLE_FLAG_SLOTS) return;
      // 戦域はプレイヤーごとに 6 枠あるので、自分の戦域だけを引く。
      const f = getFront(w, c.p, c.front);
      if (f === undefined || !f.active) return;
      if (f.slot > pl.frontSlots) return;
      if (f.pendingOrder !== null) return;
      // 切り替え間隔は「**切り替え**」に掛かる。まだ 1 枚も令が立っていない戦域への
      // 最初の令は待たされない（`lastSwitchTick` の初期値 0 で足止めしないため）。
      if (f.order !== null || f.orderLower !== null) {
        // 切り替え間隔は資料に秒で書かれている数字（6.0 秒 → 早馬で 4.2 秒。`06§4`）。
        // **切り捨てではなく四捨五入**で tick に落とす。切り捨てると
        // 150 tick × 0.7 = 104.88 → 104 tick（4.16 秒）になり、
        // 資料の 4.2 秒と 1 tick ずれる。UI に出る数字なので近い方に丸める。
        const interval = idiv(
          ORDER_SWITCH_BASE_TICKS * orderSwitchIntervalMul(m) + FX_HALF,
          FX_ONE
        );
        if (w.tick - f.lastSwitchTick < interval) return;
      }

      // 遅延は**発信した瞬間に確定**させる（`§6.2` の式は `core/order.ts`）。
      //  dist（最寄りの発信点 → 戦域中心）・伝令 -1.0s・復唱 ×0.5・駅伝（距離の項を 0）・
      //  忠誠度 +2.0s を織り込み、`delayMin/Max`（0.5〜8.0 秒）でクランプした tick 数。
      // **即時発効にしてはいけない**（「押した瞬間に効かない」のが設計の肝。§16-4）。
      f.pendingOrder = {
        id: odef.id,
        tier: c.tier,
        deliverAtTick: w.tick + orderDelayTicks(w, f),
      };
      return;
    }

    // ---------------------------------------------------------------- 生産・研究
    case 'produce': {
      // 無視する条件: 未知のユニット ID / 件数が 1 未満 / 人口枠が無い。
      // それ以外（建物の所有者・種別・完成済み・生産元・文明の禁止置換・資源・キュー長）は
      // `queueUnitProduction` が同じ「黙って 0 件」で返す。
      const udef = UNIT_BY_ID.get(c.unit);
      if (udef === undefined) return;
      if (!isInt(c.count) || c.count < 1) return;
      // 人口上限に達しているときは**キューに積ませない**（`07§8`「生産ボタンが止まります」）。
      // production.ts 側は「積めるが進まない」設計なので、資源を先取りされないよう入口で止める。
      if (!hasPopRoomFor(w, c.p, udef.index)) return;
      queueUnitProduction(w, c.p, c.building, udef.id, c.count);
      return;
    }

    case 'cancelQueue': {
      // 無視する条件: index が整数でない。所有者・範囲は `cancelQueueItem` が見る（全額返却）。
      if (!isInt(c.index)) return;
      cancelQueueItem(w, c.p, c.building, c.index);
      return;
    }

    case 'research': {
      // 無視する条件: 未知の研究 ID。文明制限・時代・前提研究・資源・建物種別・
      // 研究中かどうかは `startResearch`（`canStartResearch`）が見る。
      const tdef = TECH_BY_ID.get(c.tech);
      if (tdef === undefined) return;
      startResearch(w, c.p, c.building, tdef.id);
      return;
    }

    case 'advanceAge':
      // 無視する条件: 解読できる建物でない / 前の世の建物が 2 種未満 / 資源不足 /
      // 既に何か研究中 / 最終時代。すべて `startAgeAdvance`（`canAdvanceAge`）が見る。
      startAgeAdvance(w, c.p, c.building);
      return;

    case 'setRally':
      // 無視する条件: 建物でない / 他人の建物 / マップ外。
      if (!inMap(w, c.x, c.y)) return;
      setRallyPoint(w, c.p, c.building, c.x, c.y);
      return;

    // ---------------------------------------------------------------- 建設
    case 'placeBuilding': {
      // 無視する条件: 未知の建物 ID / マップ外。
      // その文明が建てられない（ヴァイキングの厩）・時代未解禁・棟数上限・跡地タイマー・
      // 資源不足は `beginConstruction` が `BuildRejection` を返すだけで何も起こさない。
      if (BUILDING_BY_ID.get(c.type) === undefined) return;
      if (!inMap(w, c.x, c.y)) return;
      // 建設に就ける村人は「生きている自分の村人」だけに絞る
      // （他人の村人・死んだ EntityId・兵は黙って落とす）。
      const builders: EntityId[] = [];
      for (let k = 0; k < c.villagers.length; k++) {
        const i = ownUnitIndex(w, c.villagers[k]!, c.p);
        if (i < 0 || !isVillagerIndex(w.entities, i)) continue;
        builders.push(c.villagers[k]!);
      }
      beginConstruction(w, c.p, c.type, c.x, c.y, builders);
      return;
    }

    case 'placeWallLine': {
      // 無視する条件: 未知の建物 ID / 線で引けない建物 / 端点がマップ外。
      //
      // 線で引けるのは壁・門と、**ローマの街道**（`isLinear`）。
      // `06§6`「壁の建設中にドラッグ → 木柵・石壁・**街道**は始点から終点までまとめて」。
      // 街道を除外していたため、ローマの固有建物がドラッグで引けなかった。
      const wdef = BUILDING_BY_ID.get(c.type);
      if (wdef === undefined) return;
      if (!wdef.isWall && !wdef.isGate && !wdef.isLinear) return;
      if (!inMap(w, c.x0, c.y0) || !inMap(w, c.x1, c.y1)) return;
      placeWallLine(w, c.p, c.type, c.x0, c.y0, c.x1, c.y1);
      return;
    }

    case 'foldStructure': {
      // 無視する条件: マップ外 / 自軍の建物でない / 動かせない建物 / 建設中。
      // 判定はすべて `structure.moveStructure` が持っているので、
      // ここでは所有者とマップ内だけ見て委ねる（判定を二重に書かない）。
      if (!inMap(w, c.x, c.y)) return;
      if (!isOwnedBy(w, c.building, c.p)) return;
      moveStructure(w, c.building, c.x, c.y);
      return;
    }

    // ---------------------------------------------------------------- 手動操作
    case 'moveUnits': {
      // 無視する条件: マップ外の目標。個々のユニットは「生きている自分のユニット」だけ。
      if (!inMap(w, c.x, c.y)) return;
      const e = w.entities;
      for (let k = 0; k < c.units.length; k++) {
        const i = ownUnitIndex(w, c.units[k]!, c.p);
        if (i < 0) continue;
        if (e.state[i] === UnitState.Garrisoned) continue; // 収容中は出撃を待つ（M10）
        e.destX[i] = c.x;
        e.destY[i] = c.y;
        e.target[i] = INVALID_ENTITY;
        if (e.state[i] !== UnitState.Moving) {
          e.state[i] = UnitState.Moving;
          e.stateTick[i] = w.tick;
        }
        // 選択して指示した瞬間、その部隊は令から外れて手動になる（`06§5`）。
        e.manual[i] = 1;
      }
      // TODO(M3/M5): `queued = true`（Shift）の経路点積みは `movement.ts` の
      //   経路点バッファ（現在 WeakMap 上）に公開 API が無いため未実装。
      //   今は最後の指示で上書きする（= queued を無視する）。
      return;
    }

    case 'attackTarget': {
      // 無視する条件: 目標が死んでいる / 目標が味方（同チーム）/ 資源・投射物。
      const e = w.entities;
      const ti = resolveIndex(e, c.target);
      if (ti < 0) return;
      const tkind = e.kind[ti]!;
      if (tkind !== EntityKind.Unit && tkind !== EntityKind.Building && tkind !== EntityKind.Attachment) {
        return;
      }
      const towner = e.owner[ti]!;
      if (towner < w.playerCount && areAllies(w, c.p, towner as PlayerId)) return;
      for (let k = 0; k < c.units.length; k++) {
        const i = ownUnitIndex(w, c.units[k]!, c.p);
        if (i < 0) continue;
        if (i === ti) continue; // 自分自身は攻撃しない
        if (e.state[i] === UnitState.Garrisoned) continue;
        e.target[i] = c.target;
        e.destX[i] = e.x[ti]!;
        e.destY[i] = e.y[ti]!;
        if (e.state[i] !== UnitState.Attacking) {
          e.state[i] = UnitState.Attacking;
          e.stateTick[i] = w.tick;
        }
        e.manual[i] = 1;
      }
      return;
    }

    case 'gather': {
      // 無視する条件: 目標が資源ノードでない / 採り切っている / 指示対象が村人でない。
      const e = w.entities;
      const ni = resolveIndex(e, c.target);
      if (ni < 0 || !isResourceNode(e, ni)) return;
      for (let k = 0; k < c.units.length; k++) {
        const i = ownUnitIndex(w, c.units[k]!, c.p);
        if (i < 0 || !isVillagerIndex(e, i)) continue;
        if (!assignVillagerToNode(w, c.units[k]!, c.target)) continue;
        // `06§5`: 選択して指示した部隊は令から外れて手動になる。
        // **申し送り（M4 との不整合）**: `economy.villagerTick` は `manual = 1` の村人を
        // 早期 return するため、このままでは採集が進まない。`Esc`（releaseManual）で
        // 令の管理下に戻すと動き出す。恒久対策は economy 側を
        // 「manual でも Gathering / Hauling は進める」に直すこと（報告に記載）。
        e.manual[i] = 1;
      }
      return;
    }

    case 'releaseManual': {
      // 無視する条件: 生きている自分のユニット以外。`Esc`（`06§4`）。
      const e = w.entities;
      for (let k = 0; k < c.units.length; k++) {
        const i = ownUnitIndex(w, c.units[k]!, c.p);
        if (i < 0) continue;
        // 戦域の編入対象に戻る（`frontEnrollment` は manual = 1 を編入しない）。
        e.manual[i] = 0;
      }
      return;
    }

    // ---------------------------------------------------------------- 市場・貢納
    case 'marketTrade': {
      // 市場は**金を介した交換**しか行わない（`07§8`）。したがって
      //  - 売る側が金 → `buy` を `amount` 単位だけ買う（100 単位ごとに +3%）
      //  - 買う側が金 → `sell` を `amount` 単位だけ売る
      //  - 金が絡まない交換・同じ資源同士は無視する（相場の定義が無いため）
      // 資源不足は `marketBuy` / `marketSell` が false を返すだけ。
      const sell = resourceOf(c.sell);
      const buy = resourceOf(c.buy);
      if (sell < 0 || buy < 0 || sell === buy) return;
      if (!isInt(c.amount) || c.amount < 1) return;
      const gold = resourceOf('gold');
      if (sell === gold) marketBuy(w, c.p, buy, c.amount);
      else if (buy === gold) marketSell(w, c.p, sell, c.amount);
      return;
    }

    case 'tribute': {
      // 無視する条件: 未知の資源 / 量が 1 未満 / 相手が範囲外・自分自身・敵。
      // 味方判定と手数料 10% は `core/market.ts` の `tribute` が持つ。
      const r = resourceOf(c.resource);
      if (r < 0) return;
      if (!isInt(c.amount) || c.amount < 1) return;
      if (!isInt(c.to) || c.to < 0 || c.to >= w.playerCount) return;
      // Command の `amount` は**単位数**。内部の資源は Fx なので単位を合わせる。
      tributeResources(w, c.p, c.to, r, c.amount * FX_ONE);
      return;
    }

    // ---------------------------------------------------------------- 投了
    case 'resign':
      // 服属（`03§10`）。敗北処理そのものは M11 の `victory` が行う。
      pl.resigned = true;
      return;

    default:
      unreachable(c);
  }
}

// ---------------------------------------------------------------------------
// 壁のライン建設
// ---------------------------------------------------------------------------

/**
 * `(x0,y0)` から `(x1,y1)` までを**マス単位に整数化**して壁を並べる。
 *
 * 斜線の整数化は Bresenham（浮動小数を使わない。§6.11 の指定）。
 * 1 マスにつき `beginConstruction` を 1 回呼ぶので、途中で資源が尽きたら
 * そこで打ち切る（`07§9` の「引いた長さぶんの資源が要る」をそのまま表す）。
 */
function placeWallLine(
  w: World,
  p: PlayerId,
  type: BuildingTypeId,
  x0: Fx,
  y0: Fx,
  x1: Fx,
  y1: Fx
): void {
  let tx = tileOf(x0);
  let ty = tileOf(y0);
  const ex = tileOf(x1);
  const ey = tileOf(y1);

  const dx = ex > tx ? ex - tx : tx - ex;
  const dy = ey > ty ? ey - ty : ty - ey;
  const sx = ex > tx ? 1 : -1;
  const sy = ey > ty ? 1 : -1;
  let err = dx - dy;

  // マップ 1 辺ぶん以上は引けない（不正な入力で無限ループにしないための構造的上限）。
  const maxSegments = w.map.widthTiles + w.map.heightTiles;

  for (let n = 0; n <= maxSegments; n++) {
    const r = beginConstruction(w, p, type, tileCenter(tx), tileCenter(ty), []);
    // 資源が尽きたら以降のマスは引かない。地形・跡地・棟数上限で 1 マスだけ
    // 置けなかった場合は飛ばして続ける（線が途切れるのは仕様どおり）。
    if (r.result === 'notEnoughResources') return;
    if (r.result === 'civForbidden' || r.result === 'ageLocked' || r.result === 'unknownPlayer') return;
    if (tx === ex && ty === ey) return;
    const e2 = err << 1;
    if (e2 > -dy) {
      err -= dy;
      tx += sx;
    }
    if (e2 < dx) {
      err += dx;
      ty += sy;
    }
  }
}
