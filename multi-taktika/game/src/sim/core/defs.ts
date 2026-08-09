/**
 * sim/core/defs.ts — マスターデータを sim が使える形に変換した定義層。
 *
 * 役割:
 *  1. **文字列 ID ↔ 数値 index の対応を固定する。** SoA の `typeId` は
 *     `Uint16Array` なので、`units.json` / `buildings.json` の並び順が
 *     そのまま index になる。並び順はデータの記述順（`Object.keys`）で固定し、
 *     ここ以外で index を作らない。
 *  2. **単位変換を 1 箇所に集める。** 秒 → tick、マス → Fx、
 *     マス/秒 → Fx/tick、実数 → Fx。システム側は変換しない。
 *  3. **相性行列を数値表に落とす。** 役割 index × 役割 index の Fx 倍率。
 *
 * 決定論について:
 *  - `Map` は **ID → index の引き当てにだけ**使う。反復しない（§0.3 が
 *    禁じているのは「反復順に依存すること」で、キー引きは安全）。
 *  - 定義は読み込み時に 1 回作って以後不変。World の状態ではないので
 *    ハッシュ対象外。
 */

import unitsJson from '@/data/units.json' with { type: 'json' };
import buildingsJson from '@/data/buildings.json' with { type: 'json' };
import techsJson from '@/data/techs.json' with { type: 'json' };
import ordersJson from '@/data/orders.json' with { type: 'json' };
import civsJson from '@/data/civs.json' with { type: 'json' };

import type { Age, CivId, LineId, OrderId, ResourceId, RoleId, Tier } from '@/shared/types';
import { AGE_IDS, RESOURCE_COUNT, RESOURCE_IDS } from '@/shared/types';
import type { Fx } from './fx';
import { fx } from './fx';
import { TICK_RATE, cfgFx, cfgObject } from './config';

// ---------------------------------------------------------------- 役割

/**
 * 役割（相性判定のキー）。順序は `config.json:counterMatrix` の行順に合わせる。
 * `data/README.md` の role 一覧と一致していることを test で検証する。
 */
export const ROLE_IDS: readonly RoleId[] = Object.keys(cfgObject('counterMatrix')) as RoleId[];
export const ROLE_COUNT = ROLE_IDS.length;

const roleIndex = new Map<string, number>(ROLE_IDS.map((r, i) => [r, i]));

/** 役割 ID → index。未知の役割は例外（黙って neutral にしない）。 */
export function roleToIndex(role: string): number {
  const i = roleIndex.get(role);
  if (i === undefined) throw new Error(`defs: 未知の role "${role}"（config.json:counterMatrix に行がない）`);
  return i;
}

/** 系統（line）。null を 0 に割り当てるため先頭に `none` を置く。 */
export const LINE_IDS = ['none', 'melee', 'ranged', 'cavalry', 'beast', 'siege', 'ship', 'elite'] as const;
const lineIndex = new Map<string, number>(LINE_IDS.map((l, i) => [l, i]));

function lineToIndex(line: unknown): number {
  if (line === null || line === undefined) return 0;
  const i = lineIndex.get(String(line));
  if (i === undefined) throw new Error(`defs: 未知の line "${String(line)}"`);
  return i;
}

function ageToIndex(age: unknown): number {
  const i = AGE_IDS.indexOf(age as Age);
  if (i < 0) throw new Error(`defs: 未知の age "${String(age)}"`);
  return i;
}

// ---------------------------------------------------------------- 相性

/**
 * 相性倍率表。`COUNTER[attacker * ROLE_COUNT + defender]` が Fx 倍率。
 * `good` → `combat.counterGood`(1.5) / `bad` → `combat.counterBad`(0.7) /
 * 記載なし → `combat.counterNeutral`(1.0)。
 *
 * 手順書 §6.4「相性は兵の名前ではなく **役割** で決まる」。
 */
export const COUNTER: Int32Array = buildCounterTable();

function buildCounterTable(): Int32Array {
  const good = cfgFx('combat.counterGood');
  const bad = cfgFx('combat.counterBad');
  const neutral = cfgFx('combat.counterNeutral');
  const table = new Int32Array(ROLE_COUNT * ROLE_COUNT).fill(neutral);
  const matrix = cfgObject('counterMatrix');
  for (const [atk, row] of Object.entries(matrix)) {
    const a = roleToIndex(atk);
    if (typeof row !== 'object' || row === null) continue;
    for (const [def, verdict] of Object.entries(row as Record<string, unknown>)) {
      const d = roleToIndex(def);
      const v = verdict === 'good' ? good : verdict === 'bad' ? bad : neutral;
      table[a * ROLE_COUNT + d] = v;
    }
  }
  return table;
}

/** 攻撃側 role index → 防御側 role index の相性倍率（Fx）。 */
export function counterMul(attackerRole: number, defenderRole: number): Fx {
  return COUNTER[attackerRole * ROLE_COUNT + defenderRole] as Fx;
}

// ---------------------------------------------------------------- ユニット

/** ユニット定義（すべて Fx / tick に変換済み）。 */
export interface UnitDef {
  /** `units.json` の記述順。SoA の `typeId` に入る値。 */
  readonly index: number;
  readonly id: string;
  readonly name: string;
  readonly civ: CivId | null;
  /** AGE_IDS の添字 0..3。 */
  readonly age: number;
  readonly role: string;
  readonly roleIdx: number;
  readonly line: LineId | 'none';
  readonly lineIdx: number;
  readonly tier: number;
  readonly producedAt: string;
  /** 資源 index 順のコスト（Fx）。player.resources と同じ単位。 */
  readonly cost: Int32Array;
  readonly buildTicks: number;
  readonly pop: number;
  readonly hp: Fx;
  readonly atk: Fx;
  readonly def: Fx;
  readonly pierceDef: Fx;
  /** 射程（Fx。0 = 近接）。 */
  readonly range: Fx;
  /** 射程の平方（Fx*Fx は桁が溢れるのでマス単位の平方を Fx で持つ）。 */
  readonly attackTicks: number;
  /** 速度（Fx / tick）。 */
  readonly speed: Fx;
  readonly sight: Fx;
  readonly attackClass: string;
  readonly pierce: boolean;
  readonly aoeRadius: Fx;
  readonly upgradeTo: string | null;
  readonly traits: readonly string[];
  readonly sprite: string;
}

export const UNIT_DEFS: readonly UnitDef[] = buildUnitDefs();
const unitIndexById = new Map<string, number>(UNIT_DEFS.map((u, i) => [u.id, i]));

/** ユニット ID → typeId（index）。未知の ID は例外。 */
export function unitIndex(id: string): number {
  const i = unitIndexById.get(id);
  if (i === undefined) throw new Error(`defs: 未知の unit "${id}"`);
  return i;
}

/** typeId → 定義。 */
export function unitDef(typeId: number): UnitDef {
  const d = UNIT_DEFS[typeId];
  if (d === undefined) throw new Error(`defs: 範囲外の unit typeId ${typeId}`);
  return d;
}

/** ユニット ID → 定義。 */
export function unitDefById(id: string): UnitDef {
  return unitDef(unitIndex(id));
}

function buildUnitDefs(): UnitDef[] {
  const src = unitsJson as unknown as Record<string, Record<string, unknown>>;
  const out: UnitDef[] = [];
  let i = 0;
  for (const id of Object.keys(src)) {
    if (id.startsWith('_')) continue;
    const u = src[id] as Record<string, unknown>;
    const role = String(u['role']);
    out.push({
      index: i,
      id,
      name: String(u['name']),
      civ: (u['civ'] ?? null) as CivId | null,
      age: ageToIndex(u['age']),
      role,
      roleIdx: roleToIndex(role),
      line: (u['line'] ?? 'none') as LineId | 'none',
      lineIdx: lineToIndex(u['line']),
      tier: num(u['tier'], 0),
      producedAt: String(u['producedAt']),
      cost: toCost(u['cost'], `units.json:${id}.cost`),
      buildTicks: Math.round(num(u['buildSec'], 0) * TICK_RATE),
      pop: num(u['pop'], 0),
      hp: fx(num(u['hp'], 1)),
      atk: fx(num(u['atk'], 0)),
      def: fx(num(u['def'], 0)),
      pierceDef: fx(num(u['pierceDef'], 0)),
      range: fx(num(u['rangeTiles'], 0)),
      attackTicks: Math.max(1, Math.round(num(u['attackSec'], 1) * TICK_RATE)),
      // マス/秒 → Fx/tick
      speed: fx(num(u['speedTilesPerSec'], 0) / TICK_RATE),
      sight: fx(num(u['sightTiles'], 0)),
      attackClass: String(u['attackClass'] ?? 'melee'),
      pierce: u['pierce'] === true,
      aoeRadius: fx(num(u['aoeRadiusTiles'], 0)),
      upgradeTo: (u['upgradeTo'] ?? null) as string | null,
      traits: (u['traits'] ?? []) as string[],
      sprite: String(u['sprite'] ?? ''),
    });
    i++;
  }
  return out;
}

// ---------------------------------------------------------------- 建物

export interface BuildingDef {
  readonly index: number;
  readonly id: string;
  readonly name: string;
  readonly civ: CivId | null;
  readonly age: number;
  readonly kind: string;
  readonly cost: Int32Array;
  readonly buildTicks: number;
  readonly hp: Fx;
  readonly sizeW: number;
  readonly sizeH: number;
  readonly sight: Fx;
  readonly popProvide: number;
  readonly isDropOff: boolean;
  readonly isOrderSource: boolean;
  readonly frontSlotBonus: number;
  readonly lossCausesDefeat: boolean;
  readonly buildable: boolean;
  readonly autoTargetable: boolean;
  readonly movable: boolean;
  readonly isWall: boolean;
  readonly isGate: boolean;
  readonly isLinear: boolean;
  readonly garrisonCapacity: number;
  readonly attackDamage: Fx;
  readonly attackRange: Fx;
  readonly attackTicks: number;
  readonly produces: readonly string[];
  readonly researches: readonly string[];
  readonly attachments: readonly string[];
  readonly replaces: string | null;
  readonly effects: readonly Record<string, unknown>[];
  readonly maxCount: number;
}

export const BUILDING_DEFS: readonly BuildingDef[] = buildBuildingDefs();
const buildingIndexById = new Map<string, number>(BUILDING_DEFS.map((b, i) => [b.id, i]));

export function buildingIndex(id: string): number {
  const i = buildingIndexById.get(id);
  if (i === undefined) throw new Error(`defs: 未知の building "${id}"`);
  return i;
}

export function buildingDef(typeId: number): BuildingDef {
  const d = BUILDING_DEFS[typeId];
  if (d === undefined) throw new Error(`defs: 範囲外の building typeId ${typeId}`);
  return d;
}

export function buildingDefById(id: string): BuildingDef {
  return buildingDef(buildingIndex(id));
}

function buildBuildingDefs(): BuildingDef[] {
  const src = buildingsJson as unknown as Record<string, Record<string, unknown>>;
  const out: BuildingDef[] = [];
  let i = 0;
  for (const id of Object.keys(src)) {
    if (id.startsWith('_')) continue;
    const b = src[id] as Record<string, unknown>;
    const size = (b['sizeTiles'] ?? [1, 1]) as number[];
    out.push({
      index: i,
      id,
      name: String(b['name']),
      civ: (b['civ'] ?? null) as CivId | null,
      age: ageToIndex(b['age']),
      kind: String(b['kind'] ?? 'normal'),
      cost: toCost(b['cost'], `buildings.json:${id}.cost`),
      buildTicks: Math.round(num(b['buildSec'], 0) * TICK_RATE),
      hp: fx(num(b['hp'], 1)),
      sizeW: size[0] ?? 1,
      sizeH: size[1] ?? 1,
      sight: fx(num(b['sightTiles'], 0)),
      popProvide: num(b['popProvide'], 0),
      isDropOff: b['isDropOff'] === true,
      isOrderSource: b['isOrderSource'] === true,
      frontSlotBonus: num(b['frontSlotBonus'], 0),
      lossCausesDefeat: b['lossCausesDefeat'] === true,
      // 付属物だけが buildable:false。既定は建てられる。
      buildable: b['buildable'] !== false,
      autoTargetable: b['autoTargetable'] !== false,
      movable: b['movable'] === true,
      isWall: b['isWall'] === true,
      isGate: b['isGate'] === true,
      isLinear: b['isLinear'] === true,
      garrisonCapacity: num(b['garrisonCapacity'], 0),
      attackDamage: fx(num(b['attackDamage'], 0)),
      attackRange: fx(num(b['attackRangeTiles'], 0)),
      attackTicks: Math.max(1, Math.round(num(b['attackSec'], 1) * TICK_RATE)),
      produces: (b['produces'] ?? []) as string[],
      researches: (b['researches'] ?? []) as string[],
      attachments: (b['attachments'] ?? []) as string[],
      replaces: (b['replaces'] ?? null) as string | null,
      effects: (b['effects'] ?? []) as Record<string, unknown>[],
      maxCount: num(b['maxCount'], 0),
    });
    i++;
  }
  return out;
}

// ---------------------------------------------------------------- 研究

export interface TechDef {
  readonly index: number;
  readonly id: string;
  readonly name: string;
  readonly civ: CivId | null;
  readonly at: string;
  readonly age: number;
  readonly cost: Int32Array;
  readonly researchTicks: number;
  readonly requires: readonly string[];
  readonly effects: readonly Record<string, unknown>[];
}

export const TECH_DEFS: readonly TechDef[] = buildTechDefs();
const techIndexById = new Map<string, number>(TECH_DEFS.map((t, i) => [t.id, i]));

/**
 * 研究 ID → index。`PlayerState.researched`（Uint8Array）の添字になる。
 * `TECH_CAPACITY`（64）以内であることを test で検証する。
 */
export function techIndex(id: string): number {
  const i = techIndexById.get(id);
  if (i === undefined) throw new Error(`defs: 未知の tech "${id}"`);
  return i;
}

export function techDef(index: number): TechDef {
  const d = TECH_DEFS[index];
  if (d === undefined) throw new Error(`defs: 範囲外の tech index ${index}`);
  return d;
}

export function techDefById(id: string): TechDef {
  return techDef(techIndex(id));
}

function buildTechDefs(): TechDef[] {
  const src = techsJson as unknown as Record<string, Record<string, unknown>>;
  const out: TechDef[] = [];
  let i = 0;
  for (const id of Object.keys(src)) {
    if (id.startsWith('_')) continue;
    const t = src[id] as Record<string, unknown>;
    out.push({
      index: i,
      id,
      name: String(t['name']),
      civ: (t['civ'] ?? null) as CivId | null,
      at: String(t['at']),
      age: ageToIndex(t['age']),
      cost: toCost(t['cost'], `techs.json:${id}.cost`),
      researchTicks: Math.round(num(t['researchSec'], 0) * TICK_RATE),
      requires: (t['requires'] ?? []) as string[],
      effects: (t['effects'] ?? []) as Record<string, unknown>[],
    });
    i++;
  }
  return out;
}

// ---------------------------------------------------------------- 令

export interface OrderDef {
  readonly index: number;
  readonly id: OrderId;
  readonly name: string;
  readonly key: number;
  readonly tier: Tier;
  readonly civ: CivId | null;
  /** 判断エンジンの重み（Fx）。存在しないキーは 0。 */
  readonly weights: Readonly<Record<string, Fx>>;
  readonly targetPriority: readonly string[];
  readonly formation: string;
  readonly flags: Readonly<Record<string, unknown>>;
}

export const ORDER_DEFS: readonly OrderDef[] = buildOrderDefs();
const orderIndexById = new Map<string, number>(ORDER_DEFS.map((o, i) => [o.id, i]));

/**
 * 令 ID → index。SoA の `lastOrder` には **index + 1**（0 = 令なし）を入れる。
 */
export function orderIndex(id: string): number {
  const i = orderIndexById.get(id);
  if (i === undefined) throw new Error(`defs: 未知の order "${id}"`);
  return i;
}

export function orderDef(index: number): OrderDef {
  const d = ORDER_DEFS[index];
  if (d === undefined) throw new Error(`defs: 範囲外の order index ${index}`);
  return d;
}

export function orderDefById(id: string): OrderDef {
  return orderDef(orderIndex(id));
}

function buildOrderDefs(): OrderDef[] {
  const src = ordersJson as unknown as Record<string, Record<string, unknown>>;
  const out: OrderDef[] = [];
  let i = 0;
  for (const id of Object.keys(src)) {
    if (id.startsWith('_')) continue;
    const o = src[id] as Record<string, unknown>;
    const rawW = (o['weights'] ?? {}) as Record<string, number>;
    const weights: Record<string, Fx> = {};
    for (const [k, v] of Object.entries(rawW)) weights[k] = fx(v);
    const flags: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) {
      if (['name', 'key', 'tier', 'civ', 'weights', 'targetPriority', 'formation', 'note'].includes(k))
        continue;
      flags[k] = v;
    }
    out.push({
      index: i,
      id: id as OrderId,
      name: String(o['name']),
      key: num(o['key'], 0),
      tier: o['tier'] === 'lower' ? 'lower' : 'upper',
      civ: (o['civ'] ?? null) as CivId | null,
      weights,
      targetPriority: (o['targetPriority'] ?? []) as string[],
      formation: String(o['formation'] ?? 'normal'),
      flags,
    });
    i++;
  }
  return out;
}

// ---------------------------------------------------------------- 文明

export interface CivDef {
  readonly index: number;
  readonly id: CivId;
  readonly name: string;
  readonly uniqueOrder: string;
  readonly uniqueTech: string;
  readonly eliteUnit: string;
  readonly replaceBuildings: Readonly<Record<string, string>>;
  readonly forbidBuildings: readonly string[];
  readonly forbidTechs: readonly string[];
  readonly econBonus: readonly Record<string, unknown>[];
  /** `unitTree[line][ageTier]`。null = その段を持たない。複数併記は配列。 */
  readonly unitTree: Readonly<Record<string, readonly (string | readonly string[] | null)[]>>;
}

export const CIV_DEFS: readonly CivDef[] = buildCivDefs();
const civIndexById = new Map<string, number>(CIV_DEFS.map((c, i) => [c.id, i]));

export function civIndex(id: string): number {
  const i = civIndexById.get(id);
  if (i === undefined) throw new Error(`defs: 未知の civ "${id}"`);
  return i;
}

export function civDefById(id: string): CivDef {
  const d = CIV_DEFS[civIndex(id)];
  if (d === undefined) throw new Error(`defs: 未知の civ "${id}"`);
  return d;
}

function buildCivDefs(): CivDef[] {
  const src = civsJson as unknown as Record<string, Record<string, unknown>>;
  const out: CivDef[] = [];
  let i = 0;
  for (const id of Object.keys(src)) {
    if (id.startsWith('_')) continue;
    const c = src[id] as Record<string, unknown>;
    out.push({
      index: i,
      id: id as CivId,
      name: String(c['name']),
      uniqueOrder: String(c['uniqueOrder']),
      uniqueTech: String(c['uniqueTech']),
      eliteUnit: String(c['eliteUnit']),
      replaceBuildings: (c['replaceBuildings'] ?? {}) as Record<string, string>,
      forbidBuildings: (c['forbidBuildings'] ?? []) as string[],
      forbidTechs: (c['forbidTechs'] ?? []) as string[],
      econBonus: (c['econBonus'] ?? []) as Record<string, unknown>[],
      unitTree: (c['unitTree'] ?? {}) as Record<string, (string | string[] | null)[]>,
    });
    i++;
  }
  return out;
}

// ---------------------------------------------------------------- 文明別の解決

/**
 * その文明が実際に建てる建物 ID を返す（置換を解決する）。
 * 例: モンゴルの `castle` → `great_tent`、ヤマトの `watch_tower` → `yagura`。
 * 建てられない建物は null。
 */
export function resolveBuildingForCiv(civ: CivId, buildingId: string): string | null {
  const c = civDefById(civ);
  const replaced = c.replaceBuildings[buildingId];
  if (replaced !== undefined) return replaced;
  if (c.forbidBuildings.includes(buildingId)) return null;
  return buildingId;
}

/** その文明がその建物を建てられるか。 */
export function canCivBuild(civ: CivId, buildingId: string): boolean {
  const c = civDefById(civ);
  const def = buildingDefById(buildingId);
  if (!def.buildable) return false;
  // 他文明の固有建物は建てられない
  if (def.civ !== null && def.civ !== civ) return false;
  // 置換元は「その文明にとっては存在しない」（置換先を建てる）
  if (c.replaceBuildings[buildingId] !== undefined) return false;
  return !c.forbidBuildings.includes(buildingId);
}

/** その文明がその研究をできるか。 */
export function canCivResearch(civ: CivId, techId: string): boolean {
  const c = civDefById(civ);
  const def = techDefById(techId);
  if (def.civ !== null && def.civ !== civ) return false;
  return !c.forbidTechs.includes(techId);
}

/**
 * その文明・その時代で生産できるユニット ID の一覧（系統ごとの現行段）。
 * `unitTree` の該当段を引き、`null` の系統は含めない。
 */
export function civUnitsAtAge(civ: CivId, ageIdx: number): string[] {
  const c = civDefById(civ);
  const out: string[] = [];
  // ageIdx 0(黎明) は共通ユニットのみ。ツリーは 1..3 が [青銅, 鉄器, 帝国]。
  const slot = ageIdx - 1;
  if (slot < 0) return out;
  for (const line of Object.keys(c.unitTree)) {
    const arr = c.unitTree[line];
    if (arr === undefined) continue;
    const v = arr[slot];
    if (v === null || v === undefined) continue;
    if (Array.isArray(v)) out.push(...v);
    else out.push(v as string);
  }
  return out;
}

// ---------------------------------------------------------------- 補助

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** コスト表 → 資源 index 順の Int32Array（Fx）。 */
function toCost(v: unknown, where: string): Int32Array {
  const out = new Int32Array(RESOURCE_COUNT);
  if (v === undefined || v === null) return out;
  if (typeof v !== 'object' || Array.isArray(v)) throw new Error(`defs: ${where} がオブジェクトでない`);
  for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
    const i = RESOURCE_IDS.indexOf(k as ResourceId);
    if (i < 0) throw new Error(`defs: ${where} に未知の資源 "${k}"`);
    if (typeof raw !== 'number') throw new Error(`defs: ${where}.${k} が数値でない`);
    out[i] = fx(raw);
  }
  return out;
}
