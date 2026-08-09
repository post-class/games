/**
 * sim/setup.ts — 試合の初期配置（実装手順書 §4, §6.10, `03§1`）
 *
 * 「マップを生成して、各プレイヤーに開始資源・町の中心・村人を置き、
 * **すぐ遊べる World** を返す」ことだけを担当する。
 *
 * ここは `stepWorld` の外側（tick 0 の前）に 1 回だけ走る初期化なので、
 * システムの一部ではない。ただし決定論の制約は同じで、
 *  - 乱数は `rngMap`（`generateMap` の中）だけを使う
 *  - プレイヤー・村人の走査は必ず index（playerId）昇順
 *  - 数値は `config.json` から引く
 * を守る。**同じ `MatchOptions` からは常に同じ World ができる**（determinism テストの前提）。
 *
 * 置くもの（`03§1` の「黎明の世の始まり」）:
 *  1. 町の中心 1 棟（文明置換を解決。モンゴル = 大天幕は城の置換なので町の中心は共通）
 *  2. 村人 `matchOptions.startVillagers` 体（既定 3。申し送り: キーが無いので既定値で動かす）
 *  3. 開始資源プリセット（`matchOptions.startResources.presets`）+ 文明ボーナス
 *     （ペルシアの「開始資源が多い」は `applyStartResourceBonus` が効かせる）
 *  4. `startAge` が黎明より上ならその時代へ引き上げ、戦域スロット数も作り直す
 */

import type { Age, CivId, MapTypeId, PlayerId, ResourceId } from '@/shared/types';
import { AGE_IDS, EntityKind, RESOURCE_COUNT, RESOURCE_IDS } from '@/shared/types';

import { cfgObject } from './core/config';
import { resolveBuildingForCiv, unitDefById } from './core/defs';
import {
  applyUnitStat,
  getPlayerModifiers,
  markModifiersDirty,
  refreshModifiers,
} from './core/effects';
import { UnitState, idOfIndex, resolveIndex, spawnEntity } from './core/entity';
import type { Fx } from './core/fx';
import { FX_HALF, FX_ONE, fx, idiv } from './core/fx';
import {
  assignVillagerToNode,
  findNearestResourceNodeIndex,
  isResourceNode,
  isVillagerIndex,
} from './core/gather';
import { refreshPopulation } from './core/population';
import { Move, hasTerrain, isPassableFor } from './core/terrain';
import type { World } from './core/world';
import { createWorld } from './core/world';
import type { MapGenResult } from './systems/mapgen';
import { generateMap, mapSizeForPlayers } from './systems/mapgen';
import { applyStartResourceBonus, recomputeFrontSlots } from './systems/production';
import { spawnBuilding } from './systems/construction';

/** 町の中心の建物 ID（置換は `resolveBuildingForCiv` が解決する）。 */
const TOWN_CENTER_ID = 'town_center';

/** 村人のユニット ID。 */
const VILLAGER_ID = 'villager';

const MATCH_OPTIONS = cfgObject('matchOptions');

/**
 * 開始村人数の既定値。
 *
 * **申し送り**: `config.json` に `matchOptions.startVillagers` が無いため、
 * ここに既定値を置いている。追加されたらそちらが優先される（下の `startVillagerCount`）。
 * 3 体は `03§1`「村人が数人」の最小構成。
 */
const DEFAULT_START_VILLAGERS = 3;

/** 村人を町の中心の周りに置くときのマス単位オフセット（**レイアウト表**。バランス値ではない）。 */
const VILLAGER_OFFSETS: readonly (readonly [number, number])[] = [
  [2, 0],
  [0, 2],
  [-2, 0],
  [0, -2],
  [2, 2],
  [-2, 2],
  [-2, -2],
  [2, -2],
  [3, 0],
  [0, 3],
  [-3, 0],
  [0, -3],
];

/** `createMatch` の引数。 */
export interface MatchOptions {
  /** マップ生成と戦闘乱数の種。同じ値からは同じ試合になる。 */
  readonly seed: number;
  /** 1..MAX_PLAYERS。 */
  readonly playerCount: number;
  /** 文明（添字 = playerId）。省略時は `CIV_IDS` の先頭から順。 */
  readonly civs?: readonly CivId[];
  /** チーム番号（添字 = playerId）。省略時は全員別チーム。 */
  readonly teams?: readonly number[];
  /** マップ型。省略時は平野。 */
  readonly mapType?: MapTypeId;
  /** 開始時代。省略時は `matchOptions.startAge.default`（黎明）。 */
  readonly startAge?: Age;
  /** 開始資源のプリセット名。省略時は `matchOptions.startResources.default`。 */
  readonly startResources?: string;
  /** エンティティ容量（省略時は `createWorld` の既定）。 */
  readonly entityCapacity?: number;
  /**
   * 開始村人を最寄りの資源へ就かせるか（既定 true）。
   * false にすると全員が手空きで始まる（`06§5` の「遊休村人」ジャンプの検証用）。
   */
  readonly assignVillagers?: boolean;
}

/** `createMatch` の結果。 */
export interface MatchSetup {
  readonly world: World;
  /** マップ生成の詳細（開始位置・資源ノード・掟領域。UI と AI が使う）。 */
  readonly mapResult: MapGenResult;
}

/** `matchOptions.startVillagers`（無ければ `DEFAULT_START_VILLAGERS`）。 */
function startVillagerCount(): number {
  const v = MATCH_OPTIONS['startVillagers'];
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0) return v;
  return DEFAULT_START_VILLAGERS;
}

/** `matchOptions.startResources.default` のプリセット名。 */
function defaultStartResourcePreset(): string {
  const sr = cfgObject('matchOptions.startResources');
  const d = sr['default'];
  return typeof d === 'string' ? d : '';
}

/** `matchOptions.startAge.default`。 */
function defaultStartAge(): Age {
  const sa = cfgObject('matchOptions.startAge');
  const d = sa['default'];
  const i = typeof d === 'string' ? AGE_IDS.indexOf(d as Age) : -1;
  return i >= 0 ? AGE_IDS[i]! : AGE_IDS[0]!;
}

/**
 * 開始資源プリセットを Fx の資源配列にする。
 * 未知のプリセット名は例外（試合が始まってから気付くより起動時に落とす。§0.5）。
 */
export function startResourcesFx(preset: string): Int32Array {
  const presets = cfgObject('matchOptions.startResources.presets');
  const raw = presets[preset];
  if (raw === null || typeof raw !== 'object') {
    throw new Error(`setup: config.json の matchOptions.startResources.presets に "${preset}" が無い`);
  }
  const src = raw as Record<string, unknown>;
  const out = new Int32Array(RESOURCE_COUNT);
  for (const [k, v] of Object.entries(src)) {
    const r = RESOURCE_IDS.indexOf(k as ResourceId);
    if (r < 0) {
      throw new Error(`setup: startResources プリセット "${preset}" に未知の資源 "${k}"`);
    }
    if (typeof v !== 'number') {
      throw new Error(`setup: startResources プリセット "${preset}" の "${k}" が数値でない`);
    }
    out[r] = fx(v);
  }
  return out;
}

/**
 * 試合を組み立てる。
 *
 * 手順（この順序に意味がある）:
 *  1. 人数からマップの広さを決めて `createWorld`
 *  2. `generateMap`（`rngMap` のみを消費。`w.map.starts` / `lawZones` もここで入る）
 *  3. playerId 昇順に: 時代 → 開始資源 → 町の中心 → 村人 → 戦域スロット
 *  4. 修飾子と人口を作り直す（tick 0 から生産・研究が動く状態にする）
 */
export function createMatch(opts: MatchOptions): MatchSetup {
  const mapType: MapTypeId = opts.mapType ?? 'plain';
  const size = mapSizeForPlayers(mapType, opts.playerCount);

  const world = createWorld({
    seed: opts.seed,
    playerCount: opts.playerCount,
    mapWidthTiles: size,
    mapHeightTiles: size,
    ...(opts.civs === undefined ? {} : { civs: opts.civs }),
    ...(opts.teams === undefined ? {} : { teams: opts.teams }),
    ...(opts.entityCapacity === undefined ? {} : { entityCapacity: opts.entityCapacity }),
  });

  const mapResult = generateMap(world, { mapType });

  const ageIdx = AGE_IDS.indexOf(opts.startAge ?? defaultStartAge());
  const preset = opts.startResources ?? defaultStartResourcePreset();
  const startRes = startResourcesFx(preset);
  const villagers = startVillagerCount();
  const assign = opts.assignVillagers ?? true;

  for (let p = 0; p < world.playerCount; p++) {
    const pl = world.players[p]!;

    // 1) 時代。上げると内政フェーズを飛ばせる（`matchOptions.startAge`）。
    //    解禁（建物・ユニット・研究）は各判定が `pl.age` を見るので、これだけで効く。
    pl.age = ageIdx < 0 ? 0 : ageIdx;

    // 2) 開始資源 = プリセット + 文明ボーナス（ペルシアの「開始資源が多い」）。
    for (let r = 0; r < RESOURCE_COUNT; r++) pl.resources[r] = startRes[r]!;

    // 3) 町の中心。**`spawnBuilding` を使う**（`buildProgress = PROGRESS_DONE` が入る）。
    //    0 のままだと「建設中」扱いになり、生産も研究も時代進化も動かない。
    const cx = world.map.starts[p * 2]!;
    const cy = world.map.starts[p * 2 + 1]!;
    const tcId = resolveBuildingForCiv(pl.civ, TOWN_CENTER_ID);
    if (tcId !== null) spawnBuilding(world, p, tcId, cx, cy);

    // 修飾子は町の中心を置いた後に作り直す（建物の効果と文明ボーナスを両方拾うため）。
    markModifiersDirty(world, p);
    applyStartResourceBonus(world, p);

    // 4) 村人。
    spawnStartVillagers(world, p, cx, cy, villagers);

    // 5) 戦域スロット数（時代 + 建物 + 研究）。`startAge` を上げた分もここで反映される。
    recomputeFrontSlots(world, p);
  }

  // 人口と修飾子を tick 0 の時点で正しくしておく。
  // `economy` / `production` は毎 tick 作り直すが、初期化直後に
  // 「popCap が 0 なので何も生産できない」World を返さないため。
  refreshModifiers(world);
  refreshPopulation(world);

  // 6) 村人を最寄りの資源へ就かせる（`manual = 0` のまま = 令の管理下）。
  //    Command 経由の `gather` と違って手動フラグを立てないので、
  //    `economy` がそのまま採集・搬入を回す。
  if (assign) {
    for (let p = 0; p < world.playerCount; p++) assignStartVillagers(world, p);
  }

  return { world, mapResult };
}

/** 町の中心の周りに村人を置く（レイアウト表の順に、通行可能なマスだけ）。 */
function spawnStartVillagers(w: World, p: PlayerId, cx: Fx, cy: Fx, count: number): void {
  if (count <= 0) return;
  const e = w.entities;
  const udef = unitDefById(VILLAGER_ID);
  const hpMax = applyUnitStat(getPlayerModifiers(w, p), udef, 'hp', udef.hp);
  const baseTx = idiv(cx, FX_ONE);
  const baseTy = idiv(cy, FX_ONE);

  let placed = 0;
  for (let k = 0; k < VILLAGER_OFFSETS.length && placed < count; k++) {
    const tx = baseTx + VILLAGER_OFFSETS[k]![0]!;
    const ty = baseTy + VILLAGER_OFFSETS[k]![1]!;
    if (tx < 0 || ty < 0 || tx >= w.map.widthTiles || ty >= w.map.heightTiles) continue;
    if (hasTerrain(w.map) && !isPassableFor(w.map, tx, ty, Move.Land)) continue;
    const x = tx * FX_ONE + FX_HALF;
    const y = ty * FX_ONE + FX_HALF;
    const id = spawnEntity(e, {
      kind: EntityKind.Unit,
      owner: p,
      typeId: udef.index,
      x,
      y,
      hpMax,
    });
    const idx = resolveIndex(e, id);
    if (idx < 0) continue;
    e.destX[idx] = x;
    e.destY[idx] = y;
    e.state[idx] = UnitState.Idle;
    e.stateTick[idx] = w.tick;
    placed++;
  }
}

/**
 * 開始村人を最寄りの資源へ就かせる。
 * 資源は index 昇順の村人に対して食料 → 木材の順で交互に割り当てる
 * （黎明の世は食料と木材しか要らないため。`03§1`）。
 */
function assignStartVillagers(w: World, p: PlayerId): void {
  const e = w.entities;
  const food = RESOURCE_IDS.indexOf('food');
  const wood = RESOURCE_IDS.indexOf('wood');
  let n = 0;
  for (let i = 0; i < e.highWater; i++) {
    if (e.owner[i] !== p || !isVillagerIndex(e, i)) continue;
    if (e.state[i] !== UnitState.Idle) continue;
    const want = n % 2 === 0 ? food : wood;
    let ni = findNearestResourceNodeIndex(w, e.x[i]!, e.y[i]!, want);
    // その資源が近くに無ければ資源を問わず最寄りへ（列島型などで食料が遠いことがある）。
    if (ni < 0) ni = findNearestResourceNodeIndex(w, e.x[i]!, e.y[i]!, -1);
    if (ni < 0 || !isResourceNode(e, ni)) continue;
    assignVillagerToNode(w, idOfIndex(e, i), idOfIndex(e, ni));
    n++;
  }
}
