/**
 * システム 10/14: construction — 建設・修理・跡地タイマー（`07§9`, 実装手順書 §6.7）
 *
 * 担当マイルストーン: **M6**（T-M6-02）+ **M10**（T-M10-01〜12）。
 *
 * 責務（このファイルで実装済み）:
 *  - 建設進捗を村人数で加速する（1 人 1.0 / 2 人 1.7 / 3 人 2.3。
 *    テーブルは `config.json:construction.villagerSpeedMulTable`。sim で冪乗を計算しない）。
 *  - 文明ボーナスの建設速度（アステカ 1.3 倍）・建設コスト（ローマの街道 0.5 倍）を
 *    `core/effects.ts` 経由で適用する（**コードに文明名を書かない**）。
 *  - 建設中の建物は HP が低い。完成に向かって HP が伸びる。壊れても資源は戻らない。
 *  - 修理は失った HP に比例し、建設費の 1/4 が上限。
 *  - 破壊跡地タイマー（`core/effects.ts` の `DestroyedSite`）の期限切れ処理。
 *  - 壊れた壁の穴に建て直すと建設時間が 1.5 倍。
 *
 * M10 で足したもの（判定の本体は `core/structure.ts` と `core/siege.ts`）:
 *  - 足跡の封鎖（`Pass.Blocked`）の上げ下げ。**壊れた壁のマスは封鎖を下ろすだけ**なので
 *    穴が試合中ずっと通り道として残る（T-M10-02）。跡地に `Tile.Rubble` を**置かない**
 *    （Rubble は `Pass.Wheeled` を含まないので、置くと穴を攻城兵器が通れなくなる）。
 *  - 門の開閉（`updateGates`。T-M10-03）
 *  - 収容中の者の斉射（`garrisonVolley`。T-M10-05）
 *  - 井楼・攻城塔の壁越え（`crossWalls`。T-M10-08）
 *  - 完成時の付属物の自動生成（`attachAttachments`。T-M10-09）
 *
 * **壁の穴（T-M10-02）と跡地（T-M10-10）の違い**は `core/structure.ts` の冒頭に表で書いた。
 * 要点は「穴 = 試合中ずっと通れる & 1.5 倍時間で再建できる」／
 * 「跡地 = 30 秒だけ残り、その間は同じ場所に建てられない」。
 *
 * ---- 進捗の持ち方（重要）----
 *
 * `buildProgress` / `prodProgress` / `researchProgress` は
 * **「積み上げた仕事量（Fx。1 tick ぶんの 1.0 倍速 = `FX_ONE`）」**として使う。
 * 「0..FX_ONE の割合」にすると 1 tick の増分が 1 未満に丸められて（例: 30 秒 = 750 tick なら
 * 256/750 = 0）進まなくなるため。必要量は `fx(必要 tick 数)` で表し、
 * **毎 tick の除算を使わない**ので丸め誤差が積もらない。
 * 完成した建物には番兵 `PROGRESS_DONE` を入れる（完成判定を定義に依存させないため）。
 */

import type { EntityId, PlayerId } from '@/shared/types';
import { EntityKind, INVALID_ENTITY, RESOURCE_COUNT } from '@/shared/types';
import type { Fx } from '../core/fx';
import { FX_ONE, fx, fxFromInt, fxMul, idiv } from '../core/fx';
import type { BuildingDef } from '../core/defs';
import { buildingDef, buildingDefById, canCivBuild, resolveBuildingForCiv } from '../core/defs';
import { UnitState, idOfIndex, resolveIndex, spawnEntity } from '../core/entity';
import type { World } from '../core/world';
import { cfgFx, cfgNum, cfgObject } from '../core/config';
import {
  PROGRESS_DONE,
  buildCostMul,
  buildSpeedMul,
  buildingLimit,
  getPlayerModifiers,
  isBuildingComplete,
  isRebuildBlocked,
  isWallHole,
  markModifiersDirty,
  pruneDestroyedSites,
  refreshModifiers,
  registerDestroyedSite,
} from '../core/effects';
import {
  applyFootprint,
  garrisonVolley,
  onStructureCompleted,
  onStructureRemoved,
  updateGates,
} from '../core/structure';
import { crossWalls } from '../core/siege';
import { recomputeFrontSlots } from './production';

/** 建設速度テーブル（村人 n 人 → 倍率 Fx）。添字 0 は「0 人 = 進まない」。 */
const VILLAGER_SPEED_MUL: readonly Fx[] = (() => {
  const table = cfgObject('construction.villagerSpeedMulTable');
  const max = cfgNum('construction.villagerSpeedMulMaxVillagers');
  const out: Fx[] = [0];
  for (let n = 1; n <= max; n++) {
    const v = table[String(n)];
    if (typeof v !== 'number') {
      throw new Error(`config.json: construction.villagerSpeedMulTable.${n} がありません`);
    }
    out.push(fx(v));
  }
  return out;
})();

/** テーブル上限を超える人数は打ち止め（`villagerSpeedMulMaxVillagers`）。 */
export function villagerBuildSpeedMul(villagers: number): Fx {
  if (villagers <= 0) return 0;
  const i = villagers < VILLAGER_SPEED_MUL.length ? villagers : VILLAGER_SPEED_MUL.length - 1;
  return VILLAGER_SPEED_MUL[i]!;
}

/** 建設中の建物の HP 比率（Fx）。 */
const UNDER_CONSTRUCTION_HP_RATIO: Fx = cfgFx('construction.underConstructionHpRatio');
/** 修理費の上限比（建設費の 1/4）。 */
const REPAIR_COST_RATIO_MAX: Fx = cfgFx('construction.repairCostRatioMax');
/** 壁の穴に建て直すときの時間倍率。 */
const WALL_REBUILD_TIME_MUL: Fx = cfgFx('construction.wallRebuildTimeMul');

// ---------------------------------------------------------------- 建設の開始

/** `beginConstruction` の結果。失敗理由を UI に返せるようにしてある。 */
export type BuildRejection =
  | 'ok'
  | 'unknownPlayer'
  | 'civForbidden'
  | 'ageLocked'
  | 'limitReached'
  | 'siteBlocked'
  | 'notEnoughResources';

/** その建物 1 棟の実効建設コスト（Fx、資源 index 順）。 */
export function buildingCostFx(w: World, p: PlayerId, def: BuildingDef): Int32Array {
  const m = getPlayerModifiers(w, p);
  const mul = buildCostMul(m, def.id);
  const out = new Int32Array(RESOURCE_COUNT);
  for (let r = 0; r < RESOURCE_COUNT; r++) out[r] = fxMul(def.cost[r]!, mul);
  return out;
}

/** 建設に必要な仕事量（Fx）。壊れた壁の穴の上は 1.5 倍。 */
export function requiredBuildWork(w: World, def: BuildingDef, x: Fx, y: Fx): Fx {
  const base = fxFromInt(def.buildTicks);
  return isWallHole(w, x, y) ? fxMul(base, WALL_REBUILD_TIME_MUL) : base;
}

/** 所有している同種建物の数（完成済み + 建設中）。 */
export function countOwnedBuildings(w: World, p: PlayerId, typeId: number): number {
  const e = w.entities;
  let n = 0;
  for (let i = 0; i < e.highWater; i++) {
    if (e.alive[i] !== 1) continue;
    if (e.kind[i] !== EntityKind.Building) continue;
    if (e.owner[i] !== p) continue;
    if (e.typeId[i] === typeId) n++;
  }
  return n;
}

/**
 * 建物を建て始める（`placeBuilding` コマンドの本体。T-M6-02 / T-M6-05）。
 *
 * 文明の禁止・置換は `resolveBuildingForCiv` / `canCivBuild` で判定するので、
 * ここに文明名は出てこない。**前線でも建てられる**（位置の制限を掛けない）。
 *
 * @param buildingId プレイヤーが選んだ建物 ID（文明置換は内部で解決する）
 * @param villagers 建設に就ける村人の EntityId（0 体でもよい。後から `assignBuilder` 可）
 */
export function beginConstruction(
  w: World,
  p: PlayerId,
  buildingId: string,
  x: Fx,
  y: Fx,
  villagers: readonly EntityId[] = []
): { result: BuildRejection; id: EntityId } {
  const pl = w.players[p];
  if (pl === undefined) return { result: 'unknownPlayer', id: INVALID_ENTITY };

  const resolved = resolveBuildingForCiv(pl.civ, buildingId);
  if (resolved === null || !canCivBuild(pl.civ, resolved)) {
    return { result: 'civForbidden', id: INVALID_ENTITY };
  }
  const def = buildingDefById(resolved);
  if (def.age > pl.age) return { result: 'ageLocked', id: INVALID_ENTITY };

  const limit = buildingLimit(getPlayerModifiers(w, p), def);
  if (limit > 0 && countOwnedBuildings(w, p, def.index) >= limit) {
    return { result: 'limitReached', id: INVALID_ENTITY };
  }
  if (isRebuildBlocked(w, def.id, x, y)) return { result: 'siteBlocked', id: INVALID_ENTITY };

  const cost = buildingCostFx(w, p, def);
  if (!canAfford(pl.resources, cost)) {
    return { result: 'notEnoughResources', id: INVALID_ENTITY };
  }
  for (let r = 0; r < RESOURCE_COUNT; r++) pl.resources[r] = pl.resources[r]! - cost[r]!;

  const id = spawnEntity(w.entities, {
    kind: EntityKind.Building,
    owner: p,
    typeId: def.index,
    x,
    y,
    hpMax: def.hp,
    // 建設中は HP が低い（`07§9`）。完成に向かって伸びる。
    hp: fxMul(def.hp, UNDER_CONSTRUCTION_HP_RATIO),
  });
  const idx = resolveIndex(w.entities, id);
  w.entities.buildProgress[idx] = 0;
  // 着工した時点で足跡を封鎖する（土台がその場を占める）。門は完成するまで閉じたまま。
  applyFootprint(w, idx, true);

  for (let k = 0; k < villagers.length; k++) assignBuilder(w, villagers[k]!, id);
  return { result: 'ok', id };
}

/**
 * 完成済みの建物を直接置く（マップ生成・シナリオ・テスト用）。
 * **完成の印は `buildProgress = PROGRESS_DONE`。** 事前配置でもこれを必ず入れること。
 */
export function spawnBuilding(w: World, p: PlayerId, buildingId: string, x: Fx, y: Fx): EntityId {
  const def = buildingDefById(buildingId);
  const id = spawnEntity(w.entities, {
    kind: def.kind === 'attachment' ? EntityKind.Attachment : EntityKind.Building,
    owner: p,
    typeId: def.index,
    x,
    y,
    hpMax: def.hp,
  });
  const idx = resolveIndex(w.entities, id);
  w.entities.buildProgress[idx] = PROGRESS_DONE;
  // 完成済みで置くので、完成時の後処理をそのまま通す。
  // **個別に `applyFootprint` + `attachAttachments` を書かない** ―― 建設で完成した
  // ときと事前配置で処理が食い違うと、片方だけ抜ける（実測: 農地の食料ノードが
  // 建設経路では載らなかった）。完成時にやることは 1 か所に集める。
  onStructureCompleted(w, idx);
  markModifiersDirty(w, p);
  recomputeFrontSlots(w, p);
  return id;
}

/** 村人を建設・修理に就ける。 */
export function assignBuilder(w: World, villager: EntityId, building: EntityId): boolean {
  const e = w.entities;
  const u = resolveIndex(e, villager);
  const b = resolveIndex(e, building);
  if (u < 0 || b < 0) return false;
  if (e.kind[u] !== EntityKind.Unit) return false;
  if (e.owner[u] !== e.owner[b]) return false;
  e.state[u] = UnitState.Building;
  e.stateTick[u] = w.tick;
  e.target[u] = building;
  return true;
}

/** その建物で働いている村人の数（`state = Building` かつ `target` が一致）。 */
export function countBuilders(w: World, buildingIndexValue: number): number {
  const e = w.entities;
  const id = idOfIndex(e, buildingIndexValue);
  let n = 0;
  for (let i = 0; i < e.highWater; i++) {
    if (e.alive[i] !== 1) continue;
    if (e.kind[i] !== EntityKind.Unit) continue;
    if (e.state[i] !== UnitState.Building) continue;
    if (e.target[i] !== id) continue;
    n++;
  }
  return n;
}

// ---------------------------------------------------------------- 修理

/**
 * 失った HP を全部戻すのにかかる資源（Fx、資源 index 順）。
 * 失った HP に比例し、**建設費の 1/4 が上限**（`07§9`）。
 */
export function repairCostFx(w: World, p: PlayerId, index: number): Int32Array {
  const e = w.entities;
  const def = buildingDef(e.typeId[index]!);
  const hpMax = e.hpMax[index]!;
  const missing = hpMax - e.hp[index]!;
  const base = buildingCostFx(w, p, def);
  const out = new Int32Array(RESOURCE_COUNT);
  if (hpMax <= 0 || missing <= 0) return out;
  for (let r = 0; r < RESOURCE_COUNT; r++) {
    const cap = fxMul(base[r]!, REPAIR_COST_RATIO_MAX);
    out[r] = idiv(cap * missing, hpMax);
  }
  return out;
}

// ---------------------------------------------------------------- 建物の破壊

/**
 * 建物が壊れたときの後処理（跡地の登録・修飾子の再計算・戦域スロットの再計算）。
 *
 * **申し送り**: 実際に HP 0 を検出するのは `combat` / `cleanup`（M7 / M10 の担当）。
 * `markDead` の**前に**この関数を呼ぶこと（座標と typeId が必要）。
 * 建設中に壊された場合、資源は戻らない（`config.construction.refundOnDestroyedWhileBuilding` = 0）。
 */
export function onBuildingDestroyed(w: World, index: number): void {
  const e = w.entities;
  if (e.kind[index] !== EntityKind.Building && e.kind[index] !== EntityKind.Attachment) return;
  const owner = e.owner[index]!;
  registerDestroyedSite(w, e.typeId[index]!, e.x[index]!, e.y[index]!, owner);
  // 封鎖を下ろす（壁ならここで「穴」になる）。収容していた者も外に出す（M10）。
  onStructureRemoved(w, index);
  markModifiersDirty(w, owner);
  if (owner < w.playerCount) recomputeFrontSlots(w, owner);
}

// ---------------------------------------------------------------- システム本体

/**
 * 建設中の村人数を建物 index 別に数えた作業表。
 * **状態ハッシュの対象外**（毎 tick 作り直す純粋な派生物）。`WeakMap` はキー引きのみ。
 */
const builderCountStore = new WeakMap<World, Int32Array>();

/**
 * 1 tick ぶんの「建物 index → 建設中の村人数」を作る。
 * 建物ごとに全エンティティを走査すると O(建物数 × 体数) になるので、
 * **1 回の走査**で数え上げる。
 */
function tallyBuilders(w: World): Int32Array {
  const e = w.entities;
  let counts = builderCountStore.get(w);
  if (counts === undefined || counts.length !== e.capacity) {
    counts = new Int32Array(e.capacity);
    builderCountStore.set(w, counts);
  }
  counts.fill(0, 0, e.highWater);
  for (let i = 0; i < e.highWater; i++) {
    if (e.alive[i] !== 1) continue;
    if (e.kind[i] !== EntityKind.Unit) continue;
    if (e.state[i] !== UnitState.Building) continue;
    const b = resolveIndex(e, e.target[i]!);
    if (b < 0 || e.kind[b] !== EntityKind.Building) continue;
    counts[b] = counts[b]! + 1;
  }
  return counts;
}

/** 1 tick ぶんの建設・修理を進める。 */
export function construction(w: World): void {
  refreshModifiers(w);
  pruneDestroyedSites(w);

  // M10: 構造物まわりの毎 tick 処理。建設の進捗より先に置く
  // （門の開閉と壁越えは「今の封鎖状態」を見るため）。
  updateGates(w); //     T-M10-03 門の通行制御
  crossWalls(w); //      T-M10-08 井楼・攻城塔の壁越え
  garrisonVolley(w); //  T-M10-05 収容中の者が矢を放つ

  const e = w.entities;
  const counts = tallyBuilders(w);
  for (let i = 0; i < e.highWater; i++) {
    if (e.alive[i] !== 1) continue;
    if (e.kind[i] !== EntityKind.Building) continue;
    const owner = e.owner[i]!;
    if (owner >= w.playerCount) continue;
    const builders = counts[i]!;
    if (builders <= 0) continue;

    const speed = fxMul(
      villagerBuildSpeedMul(builders),
      buildSpeedMul(getPlayerModifiers(w, owner))
    );
    if (speed <= 0) continue;

    if (!isBuildingComplete(w, i)) {
      advanceConstruction(w, i, speed);
    } else if (e.hp[i]! < e.hpMax[i]!) {
      advanceRepair(w, i, speed);
    }
  }
}

/** 建設を 1 tick 進める。 */
function advanceConstruction(w: World, i: number, speed: Fx): void {
  const e = w.entities;
  const def = buildingDef(e.typeId[i]!);
  const required = requiredBuildWork(w, def, e.x[i]!, e.y[i]!);
  const work = e.buildProgress[i]! + speed;
  const hpMax = e.hpMax[i]!;

  if (required <= 0 || work >= required) {
    e.buildProgress[i] = PROGRESS_DONE;
    e.hp[i] = hpMax;
    releaseBuilders(w, i);
    // 封鎖の確定・城壁上の高低・付属物の生成（M10）。
    onStructureCompleted(w, i);
    markModifiersDirty(w, e.owner[i]!);
    recomputeFrontSlots(w, e.owner[i]!);
    return;
  }
  e.buildProgress[i] = work;
  // HP は underConstructionHpRatio から 1.0 へ線形に伸びる。
  const lo = fxMul(hpMax, UNDER_CONSTRUCTION_HP_RATIO);
  e.hp[i] = lo + idiv((hpMax - lo) * work, required);
}

/** 修理を 1 tick 進める（資源が足りない tick は進まない）。 */
function advanceRepair(w: World, i: number, speed: Fx): void {
  const e = w.entities;
  const pl = w.players[e.owner[i]!];
  if (pl === undefined) return;
  const def = buildingDef(e.typeId[i]!);
  const hpMax = e.hpMax[i]!;
  const required = fxFromInt(def.buildTicks);
  if (required <= 0 || hpMax <= 0) return;

  // 建設と同じ速さで HP を戻す。
  let heal = idiv(hpMax * speed, required);
  if (heal <= 0) heal = 1;
  const missing = hpMax - e.hp[i]!;
  if (heal > missing) heal = missing;

  const base = buildingCostFx(w, e.owner[i]!, def);
  const pay = new Int32Array(RESOURCE_COUNT);
  for (let r = 0; r < RESOURCE_COUNT; r++) {
    pay[r] = idiv(fxMul(base[r]!, REPAIR_COST_RATIO_MAX) * heal, hpMax);
  }
  if (!canAfford(pl.resources, pay)) return;
  for (let r = 0; r < RESOURCE_COUNT; r++) pl.resources[r] = pl.resources[r]! - pay[r]!;
  e.hp[i] = e.hp[i]! + heal;
  if (e.hp[i]! >= hpMax) {
    e.hp[i] = hpMax;
    releaseBuilders(w, i);
  }
}

/** 建設・修理が終わったので村人を手放す。 */
function releaseBuilders(w: World, buildingIndexValue: number): void {
  const e = w.entities;
  const id = idOfIndex(e, buildingIndexValue);
  for (let i = 0; i < e.highWater; i++) {
    if (e.alive[i] !== 1) continue;
    if (e.kind[i] !== EntityKind.Unit) continue;
    if (e.state[i] !== UnitState.Building) continue;
    if (e.target[i] !== id) continue;
    e.state[i] = UnitState.Idle;
    e.stateTick[i] = w.tick;
    e.target[i] = INVALID_ENTITY;
  }
}

/** 資源が足りているか（Fx 比較）。 */
export function canAfford(have: Int32Array, cost: Int32Array): boolean {
  for (let r = 0; r < RESOURCE_COUNT; r++) {
    if (have[r]! < cost[r]!) return false;
  }
  return true;
}

/** 進捗の割合（Fx、0..FX_ONE）。UI の描画用。 */
export function progressRatio(work: Fx, required: Fx): Fx {
  if (work >= PROGRESS_DONE) return FX_ONE;
  if (required <= 0) return FX_ONE;
  const r = idiv(work * FX_ONE, required);
  return r > FX_ONE ? FX_ONE : r;
}
