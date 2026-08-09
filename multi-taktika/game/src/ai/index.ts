/**
 * ai/index.ts — AI 層の公開 API（実装手順書 §10）
 *
 * 外の層（`main.ts` / `net` / テスト）はここから引く。
 *
 * 使い方:
 * ```ts
 * const ai = new AiPlayer(playerId, level);       // level は 1..5（ai.json）
 * const cmds = ai.think(world);                   // 判断間隔の tick 以外は []
 * stepWorld(world, [...allPlayersCmds, ...cmds]); // 並びは playerId 昇順
 * ```
 *
 * 約束（`07§11`「難易度を上げてもズルはしません」）:
 *  - AI が盤面を読むのは `createAiView(world, playerId)` の戻り値だけ
 *  - AI が出せるのは `Command` だけ（World を書き換えない）
 *  - 乱数は `world.rngAi` だけ（`rngCombat` を消費しないので戦闘結果に影響しない）
 */

export { AiPlayer, aiLevelConfig, AI_LEVELS, AI_LEVEL_COUNT } from './AiPlayer';
export type { AiLevelConfig, AiContext, AiMemory } from './AiPlayer';

export { createAiView } from './view';
export type { AiView, OwnEntity, OwnFront, OwnState, SeenEntity } from './view';

// 判断の内訳（テストと調整のために個別に呼べるようにしておく）。
export {
  planEconomy,
  planEconBuilding,
  planResearch,
  planAgeAdvance,
  planMarketTrade,
  scarcestResource,
} from './econGoals';
export {
  planMilitary,
  readEnemy,
  desiredRoleMix,
  roleMixFromWeights,
  roleShare,
  producibleUnits,
  attackTargets,
  combatUnits,
  COMBAT_ROLES,
  SQUAD_MIN_UNITS,
} from './militaryGoals';
export type { EnemyRead } from './militaryGoals';
export { planFronts, planDecoy, pickAbandonedFront, canUseOrder, decoyCount } from './frontPolicy';
