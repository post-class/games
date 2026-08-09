/**
 * sim/core/structure.ts — 壁・門・穴・収容・堀の判定（M10。`07§9` / `03§3` / 手順書 §6.7）
 *
 * 担当マイルストーン: **M10**（T-M10-02 / 03 / 05 / 07 / 09 / 11）。
 * `systems/construction.ts` から呼ばれる。ここは「構造物と地形の関係」だけを持ち、
 * 建設の進捗・資源の出入りは construction 側にある。
 *
 * ---- 通行の表し方（M3 からの申し送りをそのまま守る）----
 *
 * 通行可否は `MapState.passable` の `Pass.Blocked` ビット 1 本で表し、
 * **地形タイル（`MapState.tiles`）は建物の建設・破壊で書き換えない**。
 *
 *   建てた   → `blockTiles(map, …, true)`
 *   壊れた   → `blockTiles(map, …, false)`
 *
 * これだけで `07§9`「壊れた壁の穴はその試合の間ずっと通り道として残る」が自動的に満たされる。
 * **壊れた壁のマスに `Tile.Rubble` を置いてはいけない。** Rubble の通行ビットは `Pass.Land`
 * だけで `Pass.Wheeled` を含まないため、置くと「穴なのに攻城兵器が通れない」ことになり
 * `07§9`「攻城兵器は門か穴しか通れない」が壊れる。跡地の見た目は `World.destroyedSites`
 * （M6 が持つ跡地レジストリ）を描画層が読めば足りる。
 *
 * ---- 壁の穴と跡地の違い（T-M10-02 と T-M10-10 の整理）----
 *
 * | | 壁の穴（壁・門） | 跡地（それ以外の建物） |
 * |---|---|---|
 * | 通行 | **通れる**（Blocked を下ろしたまま） | 通れる（そもそも封鎖を戻すだけ） |
 * | 残る期間 | **試合中ずっと**（`DestroyedSite.wasWall`） | `construction.rubbleSec`（30 秒） |
 * | 同じ場所への再建 | **できる。ただし建設時間 1.5 倍** | 期間中は**できない**（`siteBlocked`） |
 * | 判定の入口 | `effects.isWallHole` → `requiredBuildWork` | `effects.isRebuildBlocked` |
 *
 * ---- 堀と跳ね橋の表し方（T-M10-07。選択理由）----
 *
 * **既存のタイル種別で表す**（`Tile` を増やさない / `buildings.json` に建物を足さない）。
 *  - 堀 = `Tile.Shallow`（浅瀬）。通行ビットが `Land|Ship` で **`Wheeled` を含まない**ので、
 *    「攻城兵器は橋を通るしかない」（`01` 決着は、城の前で）が地形の表だけで成立する。
 *    おまけに `combat.shallowCavSpeed` が効いて騎兵が水際で鈍るので、
 *    「橋の前が必ず激戦地になる」も同じ仕組みで出る。
 *  - 跳ね橋 = `Tile.Road`（街道）。`terrain.ts` が Road を「街道・橋の路面」と定義しており、
 *    通行ビットが `Land|Wheeled` なので橋の上だけ攻城兵器が渡れる。
 *    橋を上げる = そのマスの `Pass.Blocked` を立てる（門と同じ扱い）。
 * `Tile` を増やすと `TILE_COUNT` と定数表（`terrain.ts` は編集対象外）に手が入り、
 * `buildings.json` に足すと「共通 25 + 付属物 2 + 固有 8 = 35 件」というデータ契約
 * （`tests/unit/data.buildings.test.ts` と `src/data/README.md`）が壊れる。
 * どちらも避けられるので既存タイルで表した。
 *
 * 決定論: 反復は index 昇順。座標はすべて Fx（実数 × 256）。数値リテラルは書かない。
 */

import buildingsJson from '@/data/buildings.json' with { type: 'json' };

import type { EntityId, PlayerId } from '@/shared/types';
import { EntityKind, INVALID_ENTITY } from '@/shared/types';
import type { Fx } from './fx';
import { FX_HALF, FX_ONE, distSq, idiv } from './fx';
import { TICK_RATE, cfgBool, cfgFx, cfgInt, cfgNum, cfgObject, cfgStr, cfgTiles } from './config';
import type { BuildingDef } from './defs';
import { BUILDING_DEFS, buildingDef, unitDef } from './defs';
import {
  PROGRESS_DONE,
  UnitState,
  idOfIndex,
  isAliveIndex,
  markDeadIndex,
  resolveIndex,
  spawnEntity,
} from './entity';
import { isBuildingComplete, isWallHole, markModifiersDirty } from './effects';
import { Formation, computeDamage } from './damage';
import { invalidatePathfinder } from './pathfind';
import {
  Move,
  Pass,
  TILE_NAMES,
  Tile,
  blockTiles,
  hasTerrain,
  inBounds,
  isPassableFor,
  markGate,
  nearestPassable,
  setElevation,
  setTile,
  tileAt,
  tileIndex,
} from './terrain';
import { areAllies, type World } from './world';
import { queryCircle } from './grid';

// ---------------------------------------------------------------- 設定値

/** 壁・門以外の建物も足跡を封鎖するか。 */
const BLOCK_BUILDINGS: boolean = cfgBool('construction.blockTilesForBuildings');
/** 完成した壁の上の高低（城壁上）。 */
const WALL_TOP_ELEVATION: number = cfgInt('construction.wallTopElevation');
/** 門が開く判定の半径（Fx）。 */
const GATE_OPEN_RADIUS: Fx = cfgTiles('construction.gateOpenRadiusTiles');
/** 門は自軍・味方だけが通れるか。 */
const GATE_ALLIES_ONLY: boolean = cfgBool('construction.gatePassableForAlliesOnly');
/** 攻城兵器は門か穴しか通れないか。 */
const SIEGE_GATE_OR_HOLE_ONLY: boolean = cfgBool('construction.siegePassesGateOrHoleOnly');
/** 収容中の 1 名が放つ矢の攻撃力（Fx）。 */
const GARRISON_ARROW_DAMAGE: Fx = cfgFx('construction.garrisonArrowDamage');
/** 収容中の 1 名が矢を放つ間隔（tick）。0 除算を避けるため最低 1。 */
const GARRISON_VOLLEY_TICKS: number = Math.max(
  1,
  Math.round(cfgNum('construction.garrisonVolleySec') * TICK_RATE)
);
/** 付属物を親からずらす距離（マス）。 */
const ATTACHMENT_OFFSET_TILES: number = cfgInt('construction.attachmentOffsetTiles');
/** 堀のタイル種別。 */
export const MOAT_TILE: number = tileIdByName(cfgStr('construction.moatTile'));
/** 跳ね橋のタイル種別。 */
export const DRAWBRIDGE_TILE: number = tileIdByName(cfgStr('construction.drawbridgeTile'));

function tileIdByName(name: string): number {
  const i = TILE_NAMES.indexOf(name);
  if (i < 0) throw new Error(`structure: config.json のタイル名 "${name}" は terrain.ts に無い`);
  return i;
}

// ---------------------------------------------------------------- 足跡

/** Fx 座標 → マス番号。 */
export function tileOf(v: Fx): number {
  return idiv(v, FX_ONE);
}

/** マス番号 → マス中心の Fx 座標。 */
export function tileCenterFx(t: number): Fx {
  return t * FX_ONE + FX_HALF;
}

/** 建物が占めるマスの矩形。 */
export interface Footprint {
  readonly tx: number;
  readonly ty: number;
  readonly w: number;
  readonly h: number;
}

/**
 * 建物の足跡。
 * `(x, y)` は建物の代表点で、**代表点のマスを含む w×h をできるだけ中央に置く**
 * （1×1 は代表点そのまま、2×1 の門は代表点とその右、4×4 は代表点の 1 つ手前から）。
 */
export function footprintOf(w: World, i: number): Footprint {
  const e = w.entities;
  const def = buildingDef(e.typeId[i]!);
  return {
    tx: tileOf(e.x[i]!) - ((def.sizeW - 1) >> 1),
    ty: tileOf(e.y[i]!) - ((def.sizeH - 1) >> 1),
    w: def.sizeW,
    h: def.sizeH,
  };
}

/**
 * その建物種別が足跡のマスを封鎖するか。
 *  - 付属物（井戸・種籾蔵）… 封鎖しない（親の周りが歩けなくなるのを避ける）
 *  - 壁・門 … 必ず封鎖する（門は `updateGates` が味方の接近で開ける）
 *  - 敷設物（`isLinear` で壁でないもの = 街道）… 封鎖しない
 *  - それ以外の建物 … `construction.blockTilesForBuildings`
 */
export function structureBlocksTiles(def: BuildingDef): boolean {
  if (def.kind === 'attachment') return false;
  if (def.isWall || def.isGate) return true;
  if (def.isLinear) return false;
  return BLOCK_BUILDINGS;
}

/**
 * 足跡の封鎖を上げ下げする（T-M10-02 の実装本体）。
 *
 * `on = false`（壊れたとき）は **`Pass.Blocked` を下ろすだけ**で地形に触らないので、
 * 壁のあった場所は元の地形の通行ビット（草地なら `Land|Wheeled`）に戻る。
 * = 穴は歩兵も攻城兵器も通れる通り道として残る。
 */
export function applyFootprint(w: World, i: number, on: boolean): void {
  const map = w.map;
  if (!hasTerrain(map)) return;
  const e = w.entities;
  const def = buildingDef(e.typeId[i]!);
  const fp = footprintOf(w, i);

  if (structureBlocksTiles(def)) blockTiles(map, fp.tx, fp.ty, fp.w, fp.h, on);
  if (def.isGate) {
    for (let y = fp.ty; y < fp.ty + fp.h; y++) {
      for (let x = fp.tx; x < fp.tx + fp.w; x++) markGate(map, x, y, on);
    }
  }
  // 城壁の上は高所（`combat.highGround` ×1.15）。門は地上なので付けない。
  if (def.isWall && !def.isGate) {
    for (let y = fp.ty; y < fp.ty + fp.h; y++) {
      for (let x = fp.tx; x < fp.tx + fp.w; x++) {
        if (!inBounds(map, x, y)) continue;
        // 解除は「地形から作り直す」で戻す（`setTile` は Blocked / Gate を保持する）。
        if (on) setElevation(map, x, y, WALL_TOP_ELEVATION);
        else setTile(map, x, y, tileAt(map, x, y));
      }
    }
  }
  invalidatePathfinder(map);
}

/**
 * 建物が完成したときの後処理（`construction.advanceConstruction` から呼ぶ）。
 * 封鎖の再適用（着工時から立てているが、置き直しに強くしておく）と付属物の生成。
 */
export function onStructureCompleted(w: World, i: number): void {
  applyFootprint(w, i, true);
  attachAttachments(w, i);
}

/**
 * 建物が壊れたときの後処理（`construction.onBuildingDestroyed` から呼ぶ）。
 * 封鎖を解いて（= 壁なら穴になる）、収容していた者を外に出す。
 */
export function onStructureRemoved(w: World, i: number): void {
  releaseGarrison(w, i);
  applyFootprint(w, i, false);
}

// ---------------------------------------------------------------- 通行の判定

/** そのユニットの移動種（`movement.moveMaskOf` と同じ規則）。 */
export function moveMaskOfUnit(w: World, i: number): number {
  const d = unitDef(w.entities.typeId[i]!);
  if (d.line === 'ship' || d.role === 'ship') return Move.Ship;
  if (d.role === 'siege') return Move.Wheeled;
  return Move.Land;
}

/** 攻城兵器か（`03§6`。役割で判定する。兵器 ID をコードに書かない）。 */
export function isSiegeUnitIndex(w: World, i: number): boolean {
  return unitDef(w.entities.typeId[i]!).role === 'siege';
}

/** そのマスが門か。 */
export function isGateTile(w: World, tx: number, ty: number): boolean {
  const map = w.map;
  if (!hasTerrain(map) || !inBounds(map, tx, ty)) return false;
  return (map.passable[tileIndex(map, tx, ty)]! & Pass.Gate) !== 0;
}

/** そのマスが壊れた壁の穴か（`effects.isWallHole` のマス版）。 */
export function isWallHoleTile(w: World, tx: number, ty: number): boolean {
  return isWallHole(w, tileCenterFx(tx), tileCenterFx(ty));
}

/**
 * その門のマスを通れるプレイヤーか（`07§9`「自軍と味方だけが通れます」）。
 * 門のマスの上に立っている建物の所有者を引いて、同陣営かどうかで決める。
 */
export function gateAllowsPlayer(w: World, p: PlayerId, tx: number, ty: number): boolean {
  if (!GATE_ALLIES_ONLY) return true;
  const owner = gateOwnerAt(w, tx, ty);
  if (owner < 0) return true; // 門が壊れている = 穴なので誰でも通れる
  if (owner === p) return true;
  return areAllies(w, p, owner as PlayerId);
}

/** そのマスに建っている門の所有者（無ければ -1）。index 昇順で最初に見つけたもの。 */
export function gateOwnerAt(w: World, tx: number, ty: number): number {
  const e = w.entities;
  for (let i = 0; i < e.highWater; i++) {
    if (e.alive[i] !== 1) continue;
    if (e.kind[i] !== EntityKind.Building) continue;
    const def = buildingDef(e.typeId[i]!);
    if (!def.isGate) continue;
    const fp = footprintOf(w, i);
    if (tx < fp.tx || tx >= fp.tx + fp.w) continue;
    if (ty < fp.ty || ty >= fp.ty + fp.h) continue;
    return e.owner[i]!;
  }
  return -1;
}

/**
 * そのユニットがそのマスへ入れるか（`07§9` の規則そのもの）。
 *
 * **申し送り（movement.ts は別担当）**: `movement` / `pathfind` は
 * `isPassableFor`（所有者を知らない）だけを見ている。所有者依存の門の規則を
 * 経路探索に効かせるにはこの関数を参照する必要がある。今は
 * `updateGates` が「味方が近い門の Blocked を下ろす」ことで同じ結果を作っている。
 */
export function canUnitEnterTile(w: World, i: number, tx: number, ty: number): boolean {
  const map = w.map;
  if (!hasTerrain(map)) return true;
  if (!inBounds(map, tx, ty)) return false;
  const p = map.passable[tileIndex(map, tx, ty)]!;
  const mask = moveMaskOfUnit(w, i);
  const owner = w.entities.owner[i]!;

  if ((p & Pass.Gate) !== 0) {
    // 門: 地形として通れて、かつ自軍・味方の門であること。
    if ((p & mask) === 0) return false;
    return gateAllowsPlayer(w, owner as PlayerId, tx, ty);
  }
  if ((p & Pass.Blocked) !== 0) return false;
  return (p & mask) !== 0;
}

/**
 * 攻城兵器が壁の内側へ入る道があるか（T-M10-03 の完了条件の言い換え）。
 *
 * 立っている壁は `Pass.Blocked` で誰も通れないので、車輪で入れるマスは
 * **門（味方の門）か穴（封鎖が下りたマス）**しかない。ここではその 2 つを区別して返す。
 */
export function siegeEntryKindAt(
  w: World,
  i: number,
  tx: number,
  ty: number
): 'gate' | 'hole' | 'open' | 'blocked' {
  if (!canUnitEnterTile(w, i, tx, ty)) return 'blocked';
  if (isGateTile(w, tx, ty)) return 'gate';
  if (isWallHoleTile(w, tx, ty)) return 'hole';
  return 'open';
}

/** 攻城兵器を（梯子などで）壁の向こうへ運べるか。運べない = 門か穴を使うしかない。 */
export function canCarryOverWall(w: World, i: number): boolean {
  if (!SIEGE_GATE_OR_HOLE_ONLY) return true;
  return !isSiegeUnitIndex(w, i);
}

// ---------------------------------------------------------------- 門の開閉

/**
 * 門の開閉を 1 tick ぶん更新する（T-M10-03）。
 *
 * `passable` は所有者を持てないので、**「半径内に自軍・味方がいて、敵がいない門は開く」**
 * で「自軍と味方だけが通れる」を表す。副作用として敵が門前に着くと門が閉じるので、
 * `07§9`「門前が必ず激戦地になります」がそのまま出る。
 *
 * 反復は index 昇順。開閉が 1 つでも変わったら経路キャッシュを落とす。
 */
export function updateGates(w: World): void {
  const map = w.map;
  if (!hasTerrain(map)) return;
  const e = w.entities;
  const out = w.scratch.neighbors;
  let changed = false;

  for (let i = 0; i < e.highWater; i++) {
    if (e.alive[i] !== 1) continue;
    if (e.kind[i] !== EntityKind.Building) continue;
    const def = buildingDef(e.typeId[i]!);
    if (!def.isGate) continue;

    // 建設中の門は閉じたまま（まだ扉が付いていない、ではなく「通せない」側に倒す）。
    const open = isBuildingComplete(w, i) && gateShouldOpen(w, i, out);
    const fp = footprintOf(w, i);
    if (!inBounds(map, fp.tx, fp.ty)) continue;
    const wasOpen = (map.passable[tileIndex(map, fp.tx, fp.ty)]! & Pass.Blocked) === 0;
    if (wasOpen === open) continue;
    blockTiles(map, fp.tx, fp.ty, fp.w, fp.h, !open);
    changed = true;
  }
  if (changed) invalidatePathfinder(map);
}

/** 半径内に自軍・味方の生きたユニットがいて、敵のユニットがいなければ開く。 */
function gateShouldOpen(w: World, i: number, out: number[]): boolean {
  const e = w.entities;
  const owner = e.owner[i]! as PlayerId;
  const n = queryCircle(w.grid, e, e.x[i]!, e.y[i]!, GATE_OPEN_RADIUS, out);
  let ally = false;
  for (let k = 0; k < n; k++) {
    const t = out[k]!;
    if (e.kind[t] !== EntityKind.Unit) continue;
    const other = e.owner[t]!;
    if (other >= w.playerCount) continue;
    if (other === owner || areAllies(w, owner, other as PlayerId)) ally = true;
    else return false; // 敵が半径内にいる = 開けない
  }
  return ally;
}

// ---------------------------------------------------------------- 収容（塔・櫓・城）

/** `buildings.json` の `garrisonAllows`（`defs.ts` が公開していないので直接読む）。 */
const GARRISON_ALLOWS: readonly (readonly string[])[] = BUILDING_DEFS.map((b) => {
  const src = (buildingsJson as unknown as Record<string, Record<string, unknown>>)[b.id];
  const v = src?.['garrisonAllows'];
  return Array.isArray(v) ? (v as string[]) : [];
});

/** 収容の種別（`buildings.json` の `garrisonAllows` の語彙）。 */
export const GARRISON_VILLAGER = 'villager';
export const GARRISON_MILITARY = 'military';

/** その建物が収容できる種別。 */
export function garrisonAllowsOf(typeId: number): readonly string[] {
  return GARRISON_ALLOWS[typeId] ?? [];
}

/** そのユニットの収容種別（村人か兵か）。 */
export function garrisonClassOfUnit(w: World, i: number): string {
  return unitDef(w.entities.typeId[i]!).role === 'villager' ? GARRISON_VILLAGER : GARRISON_MILITARY;
}

/**
 * 収容できるか（T-M10-05）。
 *  - 完成済みの自軍・味方の建物で、`garrisonCapacity` に空きがある
 *  - `garrisonAllows` にそのユニットの種別が入っている
 *    （見張り塔・砲塔は `villager` のみ。ヤマトの櫓と城は `military` も可 = 兵 5 名）
 *  - 攻城兵器と船は収容しない（`03§3` は「村人」「兵」しか挙げていない）
 */
export function canGarrison(w: World, unitIdx: number, buildingIdx: number): boolean {
  const e = w.entities;
  if (!isAliveIndex(e, unitIdx) || !isAliveIndex(e, buildingIdx)) return false;
  if (e.kind[unitIdx] !== EntityKind.Unit) return false;
  if (e.kind[buildingIdx] !== EntityKind.Building) return false;
  if (!isBuildingComplete(w, buildingIdx)) return false;
  const owner = e.owner[buildingIdx]!;
  const uOwner = e.owner[unitIdx]!;
  if (uOwner !== owner && !areAllies(w, uOwner as PlayerId, owner as PlayerId)) return false;

  const def = buildingDef(e.typeId[buildingIdx]!);
  if (def.garrisonCapacity <= 0) return false;
  if (e.garrisonCount[buildingIdx]! >= def.garrisonCapacity) return false;

  const d = unitDef(e.typeId[unitIdx]!);
  if (d.role === 'siege' || d.role === 'ship' || d.line === 'ship') return false;
  return garrisonAllowsOf(e.typeId[buildingIdx]!).includes(garrisonClassOfUnit(w, unitIdx));
}

/**
 * 収容する。`state = Garrisoned` / `target = 建物` が収容の表現
 * （`movement` / `combat` / `unitDecision` はこの状態を飛ばす）。
 */
export function garrisonUnit(w: World, unit: EntityId, building: EntityId): boolean {
  const e = w.entities;
  const u = resolveIndex(e, unit);
  const b = resolveIndex(e, building);
  if (u < 0 || b < 0) return false;
  if (!canGarrison(w, u, b)) return false;
  e.state[u] = UnitState.Garrisoned;
  e.stateTick[u] = w.tick;
  e.target[u] = building;
  e.destX[u] = 0;
  e.destY[u] = 0;
  e.vx[u] = 0;
  e.vy[u] = 0;
  // 中に入るので座標は建物と同じ（描画は中に隠す）。
  e.x[u] = e.x[b]!;
  e.y[u] = e.y[b]!;
  e.garrisonCount[b] = e.garrisonCount[b]! + 1;
  return true;
}

/** その建物に収容されているユニットの index を昇順で数える。 */
export function garrisonedUnits(w: World, buildingIdx: number, out: number[]): number {
  const e = w.entities;
  out.length = 0;
  const id = idOf(w, buildingIdx);
  for (let i = 0; i < e.highWater; i++) {
    if (e.alive[i] !== 1) continue;
    if (e.kind[i] !== EntityKind.Unit) continue;
    if (e.state[i] !== UnitState.Garrisoned) continue;
    if (e.target[i] !== id) continue;
    out.push(i);
  }
  return out.length;
}

/** 1 体を外に出す（建物のそばの通れるマスへ）。 */
export function ungarrisonUnit(w: World, unitIdx: number): boolean {
  const e = w.entities;
  if (!isAliveIndex(e, unitIdx)) return false;
  if (e.state[unitIdx] !== UnitState.Garrisoned) return false;
  const b = resolveIndex(e, e.target[unitIdx]!);
  if (b >= 0) {
    if (e.garrisonCount[b]! > 0) e.garrisonCount[b] = e.garrisonCount[b]! - 1;
    placeOutside(w, unitIdx, b);
  }
  e.state[unitIdx] = UnitState.Idle;
  e.stateTick[unitIdx] = w.tick;
  e.target[unitIdx] = INVALID_ENTITY;
  return true;
}

/**
 * 建物が壊れたときに中身を全部出す。
 * 出さないと「死んだ建物を target にしたまま永久に Garrisoned」になって消えなくなる。
 */
export function releaseGarrison(w: World, buildingIdx: number): number {
  const e = w.entities;
  const id = idOf(w, buildingIdx);
  let n = 0;
  for (let i = 0; i < e.highWater; i++) {
    if (e.alive[i] !== 1) continue;
    if (e.kind[i] !== EntityKind.Unit) continue;
    if (e.state[i] !== UnitState.Garrisoned) continue;
    if (e.target[i] !== id) continue;
    placeOutside(w, i, buildingIdx);
    e.state[i] = UnitState.Idle;
    e.stateTick[i] = w.tick;
    e.target[i] = INVALID_ENTITY;
    n++;
  }
  e.garrisonCount[buildingIdx] = 0;
  return n;
}

/** 建物の足跡の外側で最も近い通れるマスへ置く。地形が無ければ足跡の右隣。 */
function placeOutside(w: World, unitIdx: number, buildingIdx: number): void {
  const e = w.entities;
  const fp = footprintOf(w, buildingIdx);
  const tx = fp.tx + fp.w;
  const ty = fp.ty;
  if (!hasTerrain(w.map)) {
    e.x[unitIdx] = tileCenterFx(tx);
    e.y[unitIdx] = tileCenterFx(ty);
    return;
  }
  const found = nearestPassable(w.map, tx, ty, moveMaskOfUnit(w, unitIdx), fp.w + fp.h);
  if (found < 0) {
    e.x[unitIdx] = tileCenterFx(tx);
    e.y[unitIdx] = tileCenterFx(ty);
    return;
  }
  const width = w.map.widthTiles;
  const fx0 = found % width;
  e.x[unitIdx] = tileCenterFx(fx0);
  e.y[unitIdx] = tileCenterFx(idiv(found - fx0, width));
}

/**
 * 収容中の者が矢を放つ（`07§9`「収容中の村人は塔から矢を放つ」）。
 *
 * **申し送り（combat.ts は別担当）**: 本来は `combat.buildingAttackCycle` の隣に置くべき
 * 処理。combat.ts を触れないため、暫定的に `construction` システムから呼んでいる。
 * そのため戦域の与ダメージ集計（`Front.dmgDealt`）と士気への反映が漏れている。
 * combat 側へ移すときは `dealDamage` を通すこと。
 *
 * 発射のタイミングは `tick % 間隔 === index % 間隔` の固定分散（乱数を使わない。§16-3）。
 */
export function garrisonVolley(w: World): void {
  const e = w.entities;
  const out = w.scratch.neighbors;
  const phase = w.tick % GARRISON_VOLLEY_TICKS;

  for (let i = 0; i < e.highWater; i++) {
    if (e.alive[i] !== 1) continue;
    if (e.kind[i] !== EntityKind.Unit) continue;
    if (e.state[i] !== UnitState.Garrisoned) continue;
    if (i % GARRISON_VOLLEY_TICKS !== phase) continue;
    const b = resolveIndex(e, e.target[i]!);
    if (b < 0 || e.kind[b] !== EntityKind.Building) continue;
    const bdef = buildingDef(e.typeId[b]!);
    if (bdef.attackRange <= 0) continue;

    const victim = nearestEnemyUnit(w, b, bdef.attackRange, out);
    if (victim < 0) continue;

    const d = unitDef(e.typeId[i]!);
    const atk = d.atk > GARRISON_ARROW_DAMAGE ? d.atk : GARRISON_ARROW_DAMAGE;
    const vd = unitDef(e.typeId[victim]!);
    const dmg = computeDamage({
      atk,
      def: vd.def,
      pierceDef: vd.pierceDef,
      attackClass: 'arrow',
      pierce: false,
      attackerRole: d.roleIdx,
      defenderRole: vd.roleIdx,
      // 塔の上から放つので高所（`07§6` ×1.15）。
      attackerElevation: WALL_TOP_ELEVATION,
      defenderElevation: 0,
      isAoeAttack: false,
      defenderFormation: Formation.Normal,
    });
    applyPlainDamage(w, victim, dmg);
  }
}

/** 射程内で最も近い敵ユニット（タイブレークは index 昇順）。無ければ -1。 */
function nearestEnemyUnit(w: World, buildingIdx: number, range: Fx, out: number[]): number {
  const e = w.entities;
  const owner = e.owner[buildingIdx]! as PlayerId;
  const n = queryCircle(w.grid, e, e.x[buildingIdx]!, e.y[buildingIdx]!, range, out);
  let best = -1;
  let bestSq = 0;
  for (let k = 0; k < n; k++) {
    const t = out[k]!;
    if (e.kind[t] !== EntityKind.Unit) continue;
    const other = e.owner[t]!;
    if (other >= w.playerCount) continue;
    if (other === owner || areAllies(w, owner, other as PlayerId)) continue;
    const sq = distSq(e.x[buildingIdx]!, e.y[buildingIdx]!, e.x[t]!, e.y[t]!);
    if (best < 0 || sq < bestSq) {
      best = t;
      bestSq = sq;
    }
  }
  return best;
}

/** HP を削るだけの最小のダメージ適用（戦域集計を伴わない。上の申し送りを参照）。 */
function applyPlainDamage(w: World, victimIdx: number, dmg: Fx): void {
  if (dmg <= 0) return;
  const e = w.entities;
  e.hp[victimIdx] = e.hp[victimIdx]! - dmg;
  if (e.hp[victimIdx]! <= 0) {
    e.hp[victimIdx] = 0;
    markDeadIndex(e, victimIdx);
  }
}

// ---------------------------------------------------------------- 付属物（井戸・種籾蔵）

/** 付属物 1 つが受け持つ親建物の数（`construction.attachmentParentsPer`）。 */
function parentsPerAttachment(id: string): number {
  const table = cfgObject('construction.attachmentParentsPer');
  const v = table[id];
  return typeof v === 'number' && v > 0 ? Math.trunc(v) : 1;
}

/** `buildings.json` の `lawViolationOnDestroy`（掟 ID）。無ければ null。 */
const LAW_ON_DESTROY: readonly (string | null)[] = BUILDING_DEFS.map((b) => {
  const src = (buildingsJson as unknown as Record<string, Record<string, unknown>>)[b.id];
  const v = src?.['lawViolationOnDestroy'];
  return typeof v === 'string' ? v : null;
});

/**
 * 壊すと掟破りになる建物か（井戸 = 掟二 / 種籾蔵 = 掟三）。
 *
 * **申し送り（loyalty.ts = M11 担当）**: 忠誠度 −25% の減算はここでは行わない。
 * `cleanup` → `construction.onBuildingDestroyed` の中でこの関数を引き、
 * 「誰が壊したか」と組み合わせて `loyalty` 側で減算すること
 * （攻撃者の記録は `Entities` に無いので、M11 で `lastAttacker` 相当が必要）。
 * 手動選択でしか狙えない（`autoTargetable === false`）ことは M9 の
 * `unitDecision.isTargetable` が既に守っている（§16-7）。
 */
export function lawViolationOnDestroy(typeId: number): string | null {
  return LAW_ON_DESTROY[typeId] ?? null;
}

/** その親建物に既に付いている付属物の数（種別ごと）。 */
function countAttachmentsOf(w: World, parentId: EntityId, typeId: number): number {
  const e = w.entities;
  let n = 0;
  for (let i = 0; i < e.highWater; i++) {
    if (e.alive[i] !== 1) continue;
    if (e.kind[i] !== EntityKind.Attachment) continue;
    if (e.typeId[i] !== typeId) continue;
    if (e.attachParent[i] !== parentId) continue;
    n++;
  }
  return n;
}

/** そのプレイヤーが持つ、その種別の完成済み建物の数（付属物の間隔を決めるのに使う）。 */
function countCompletedBuildings(w: World, p: PlayerId, typeId: number): number {
  const e = w.entities;
  let n = 0;
  for (let i = 0; i < e.highWater; i++) {
    if (e.alive[i] !== 1) continue;
    if (e.kind[i] !== EntityKind.Building) continue;
    if (e.owner[i] !== p) continue;
    if (e.typeId[i] !== typeId) continue;
    if (!isBuildingComplete(w, i)) continue;
    n++;
  }
  return n;
}

/**
 * 親建物に付属物を自動で付ける（T-M10-09。`03§3`「プレイヤーが建てるものではなく、
 * 対応する建物に自動で付属し、独立して破壊できる」）。
 *
 * 井戸は「町の中心・家 1 か所につき 1 つ」、種籾蔵は「農地の数面ごとに 1 つ」なので、
 * 間隔は `construction.attachmentParentsPer` で表す。
 * 独立して破壊できるのは `EntityKind.Attachment` の別エンティティにしているから。
 */
export function attachAttachments(w: World, parentIdx: number): void {
  const e = w.entities;
  const pdef = buildingDef(e.typeId[parentIdx]!);
  if (pdef.attachments.length === 0) return;
  const owner = e.owner[parentIdx]!;
  if (owner >= w.playerCount) return;
  const parentId = idOf(w, parentIdx);

  for (let k = 0; k < pdef.attachments.length; k++) {
    const aid = pdef.attachments[k]!;
    const adef = BUILDING_DEFS.find((b) => b.id === aid);
    if (adef === undefined) continue;
    if (countAttachmentsOf(w, parentId, adef.index) > 0) continue;
    // 数面ごとに 1 つ: この親が「組の先頭」でなければ付けない。
    const per = parentsPerAttachment(aid);
    if (per > 1) {
      const built = countCompletedBuildings(w, owner as PlayerId, pdef.index);
      if (built % per !== 1) continue;
    }
    spawnAttachment(w, parentIdx, adef, parentId);
  }
}

function spawnAttachment(
  w: World,
  parentIdx: number,
  adef: BuildingDef,
  parentId: EntityId
): EntityId {
  const e = w.entities;
  const ptx = tileOf(e.x[parentIdx]!);
  const pty = tileOf(e.y[parentIdx]!);
  const id = spawnEntity(e, {
    kind: EntityKind.Attachment,
    owner: e.owner[parentIdx]! as PlayerId,
    typeId: adef.index,
    x: tileCenterFx(ptx + ATTACHMENT_OFFSET_TILES),
    y: tileCenterFx(pty),
    hpMax: adef.hp,
  });
  const i = resolveIndex(e, id);
  e.buildProgress[i] = PROGRESS_DONE;
  e.attachParent[i] = parentId;
  return id;
}

// ---------------------------------------------------------------- 城と大天幕（T-M10-11）

/**
 * 令の発信点を畳んで動かす（モンゴルの大天幕。`03§3` / `07§4`）。
 *
 * 封鎖を外して座標を書き換え、封鎖を立て直すだけ。**建物は完成したまま**なので
 * 戦域スロット +1 も発信点も維持され、`core/order.ts` の `nearestOrderSourceDistFx`
 * が次の令から新しい位置で距離を測る（= 令の遅延が変わる）。
 *
 * **申し送り（command.ts は別担当）**: これを操作から呼ぶには
 * `{ t: 'foldStructure'; p; building; x; y }` 相当のコマンドが必要。
 */
export function moveStructure(w: World, building: EntityId, x: Fx, y: Fx): boolean {
  const e = w.entities;
  const i = resolveIndex(e, building);
  if (i < 0 || e.kind[i] !== EntityKind.Building) return false;
  const def = buildingDef(e.typeId[i]!);
  if (!def.movable) return false;
  if (!isBuildingComplete(w, i)) return false;
  if (x < 0 || y < 0) return false;
  if (x >= w.map.widthTiles * FX_ONE || y >= w.map.heightTiles * FX_ONE) return false;

  releaseGarrison(w, i);
  applyFootprint(w, i, false);
  e.x[i] = x;
  e.y[i] = y;
  applyFootprint(w, i, true);
  markModifiersDirty(w, e.owner[i]! as PlayerId);
  return true;
}

// ---------------------------------------------------------------- 堀と跳ね橋（T-M10-07）

/** 堀を掘る（そのマスを浅瀬にする）。攻城兵器は通れなくなる。 */
export function digMoat(w: World, tx: number, ty: number): boolean {
  const map = w.map;
  if (!hasTerrain(map) || !inBounds(map, tx, ty)) return false;
  setTile(map, tx, ty, MOAT_TILE);
  invalidatePathfinder(map);
  return true;
}

/** 堀を埋め戻す（元の地形を呼び出し側が指定する。既定は平地）。 */
export function fillMoat(w: World, tx: number, ty: number, tile: number = Tile.Grass): boolean {
  const map = w.map;
  if (!hasTerrain(map) || !inBounds(map, tx, ty)) return false;
  setTile(map, tx, ty, tile);
  invalidatePathfinder(map);
  return true;
}

/** 跳ね橋を架ける（そのマスを橋の路面にして下ろした状態にする）。 */
export function placeDrawbridge(w: World, tx: number, ty: number): boolean {
  const map = w.map;
  if (!hasTerrain(map) || !inBounds(map, tx, ty)) return false;
  setTile(map, tx, ty, DRAWBRIDGE_TILE);
  blockTiles(map, tx, ty, 1, 1, false);
  invalidatePathfinder(map);
  return true;
}

/** 跳ね橋を上げる / 下ろす（上げると封鎖 = 誰も渡れない）。 */
export function setDrawbridgeLowered(w: World, tx: number, ty: number, lowered: boolean): boolean {
  const map = w.map;
  if (!hasTerrain(map) || !inBounds(map, tx, ty)) return false;
  if (tileAt(map, tx, ty) !== DRAWBRIDGE_TILE) return false;
  blockTiles(map, tx, ty, 1, 1, !lowered);
  invalidatePathfinder(map);
  return true;
}

/** そのマスが堀か。 */
export function isMoatTile(w: World, tx: number, ty: number): boolean {
  const map = w.map;
  if (!hasTerrain(map) || !inBounds(map, tx, ty)) return false;
  return tileAt(map, tx, ty) === MOAT_TILE;
}

/** そのマスが跳ね橋（橋の路面）か。 */
export function isDrawbridgeTile(w: World, tx: number, ty: number): boolean {
  const map = w.map;
  if (!hasTerrain(map) || !inBounds(map, tx, ty)) return false;
  return tileAt(map, tx, ty) === DRAWBRIDGE_TILE;
}

/** 車輪（攻城兵器）がそのマスを通れるか。堀は false、橋は true。 */
export function isWheeledPassable(w: World, tx: number, ty: number): boolean {
  return isPassableFor(w.map, tx, ty, Move.Wheeled);
}

// ---------------------------------------------------------------- 小物

function idOf(w: World, i: number): EntityId {
  return idOfIndex(w.entities, i);
}
