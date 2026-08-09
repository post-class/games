/**
 * sim/index.ts — シミュレーション層の唯一の入口（実装手順書 §4.1, §4.6）
 *
 * 外の層（render / ui / input / ai / net / replay）はここから見えるものだけを使う。
 * sim は他の層を import しない（`shared` と `data` のみ可。§3.1）。
 *
 * tick モデル: 25 tick/秒（1 tick = 40ms）。試合長 約 30 分 = 45,000 tick。
 * ゲーム速度は tick レートではなく「1 描画フレームで進める tick 数」で調整する
 * （tick 数そのものを変えると決定論が崩れる。`07§14`）。
 */

import { rebuildGrid } from './core/grid';
import type { World } from './core/world';
import { applyCommands, type Command } from './command';
import { orderDelivery } from './systems/orderDelivery';
import { frontLifecycle } from './systems/frontLifecycle';
import { frontEnrollment } from './systems/frontEnrollment';
import { unitDecision } from './systems/unitDecision';
import { movement } from './systems/movement';
import { combat } from './systems/combat';
import { morale } from './systems/morale';
import { economy } from './systems/economy';
import { construction } from './systems/construction';
import { production } from './systems/production';
import { loyalty } from './systems/loyalty';
import { victory } from './systems/victory';
import { cleanup } from './systems/cleanup';

/** 1 秒あたりの tick 数（`config.json` の `tickRate` と一致させる）。 */
export const TICK_RATE = 25;

/** 1 tick のミリ秒。 */
export const TICK_MS = 1000 / TICK_RATE;

/** 状態ハッシュを突き合わせる周期（tick）。10 秒（§4.5）。 */
export const HASH_CHECK_INTERVAL_TICKS = 250;

/**
 * World を 1 tick 進める。
 *
 * `cmds` は「この tick に確定した全プレイヤーの入力」を
 * **playerId 昇順、同一 playerId 内は発行順**に並べた配列。順序が変わると結果が変わる。
 *
 * システムの実行順は実装手順書 §4.6 のとおりで、**この順序を変えない**。
 * 順序を変えると過去のリプレイと golden ハッシュがすべて無効になる。
 */
export function stepWorld(w: World, cmds: readonly Command[]): void {
  // 空間索引の更新。システムではなく索引の保守なので §4.6 の 14 個には含めない。
  // 前 tick の cleanup で座標が変わっている可能性があるため、入力適用の前に作り直す。
  rebuildGrid(w.grid, w.entities, w.tick);

  applyCommands(w, cmds); //  1
  orderDelivery(w); //        2
  frontLifecycle(w); //       3
  frontEnrollment(w); //      4
  unitDecision(w); //         5
  movement(w); //             6
  combat(w); //               7
  morale(w); //               8
  economy(w); //              9
  construction(w); //        10
  production(w); //          11
  loyalty(w); //             12
  victory(w); //             13
  cleanup(w); //             14

  // tick は最後に進める。各システムは「今の tick」を見て判断する。
  w.tick += 1;
}

// ---------------------------------------------------------------------------
// 公開 API
// ---------------------------------------------------------------------------

export { createWorld } from './core/world';
export type {
  World,
  WorldOptions,
  PlayerState,
  Front,
  MapState,
  System,
} from './core/world';
export {
  MAX_PLAYERS,
  MAX_FRONTS,
  ADVANTAGE_WINDOW_TICKS,
  TECH_CAPACITY,
  DEFAULT_ENTITY_CAPACITY,
  getPlayer,
  frontIndex,
  getFront,
  isOwnedBy,
} from './core/world';

// 試合の初期配置（マップ生成 + 町の中心 + 村人 + 開始資源）。
// UI / AI / テストはここから引く（`@/sim/setup` を直接触らせない）。
export { createMatch, startResourcesFx } from './setup';
export type { MatchOptions, MatchSetup } from './setup';

export { applyCommands } from './command';
export type { Command, CommandType, CommandOf } from './command';
export { COMMAND_TYPES } from './command';

export { hashWorld, formatHash } from './hash';

export type { Fx } from './core/fx';
export {
  FX_ONE,
  FX_SHIFT,
  fx,
  fxFromInt,
  fxToInt,
  fxToNumber,
  fxMul,
  fxDiv,
  fxSqrt,
  fxAbs,
  fxClamp,
  distSq,
  withinRange,
} from './core/fx';

export { Rng } from './core/rng';

export type { Entities, SpawnSpec } from './core/entity';
export {
  createEntities,
  spawnEntity,
  markDead,
  markDeadIndex,
  flushDead,
  isAlive,
  isAliveIndex,
  entityIndex,
  entityGeneration,
  makeEntityId,
  idOfIndex,
  resolveIndex,
  forEachAlive,
  UnitState,
} from './core/entity';

export type { Grid } from './core/grid';
export {
  createGrid,
  rebuildGrid,
  queryCircle,
  queryCircleBruteForce,
  GRID_CELL_TILES,
} from './core/grid';
