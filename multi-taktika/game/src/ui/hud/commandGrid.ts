/**
 * ui/hud/commandGrid.ts — 生産・建設パネル（`05§9` の 8 項目。T-M5-06 / T-M12-05）
 *
 * 対戦画面の下端そのもの。**何を選んでいるかでボタンが丸ごと入れ替わる**（`05§9`）。
 *
 * ■ `05§9` の 8 項目との対応
 *   1 選択中の対象（絵・名前・**その文明での呼び名**）     → `PanelTarget.name` / `sprite`
 *   2 体力バー（建設中は建築の進捗を兼ねる）              → `PanelTarget.hpRatio` / `buildRatio`
 *   3 属性アイコン（攻撃・防御・射程・視界。研究分は金色） → `PanelTarget.attrs[].bonus`
 *   4 コマンドグリッド上段（内政の建物。`Q W E R`）        → `slots[0..3]`
 *   5 中段・下段（時代で解禁。`A S D F` / `Z X C V`）      → `slots[4..7]` / `slots[8..11]`
 *   6 暗いボタンの理由 3 種                              → `GridButton.reason` / `detail`
 *   7 生産中（リングが一周で 1 体完成）                   → `queue[0].ratio`
 *   8 生産キュー 最大 5 件（ローマ「軍団編成」だけ 10 件） → `queueLimit`
 *
 * ■ 3 段 12 ボタンとキーの一対一（`05§9` / `06§6`）
 *   スロットは**必ず 12 個**あり、`GRID_KEYS`（QWER/ASDF/ZXCV）と添字が一対一。
 *   候補が 1 段 4 個を超えるぶんは**ページ**で送る（段の意味はページを送っても変えない）。
 *   段の意味:
 *     村人を選択 → 上段 内政の建物 / 中段 生産・研究の建物 / 下段 防御・その他
 *     建物を選択 → 上段 生産ユニット / 中段 研究 / 下段 時代進化
 *
 * ■ 暗いボタンの理由は 3 種だけ（`05§15`。「なんとなく押せない」を作らない）
 *   `Age`（まだ解禁されていない）/ `Resource`（今は払えない）/ `Civ`（その文明は持てない）。
 *   3 種は**色と錠の分類**で、細かい事情は `detail` に日本語で入れてカーソルで出す。
 *   判断が要る割り振りは次のとおり（他は自明）:
 *     - 前提研究が未了 / 解禁の建物が無い / 段が入れ替わって作れない → `Age`（未解禁）
 *     - 人口上限 / キューが満杯 / 建設上限（市場 1 棟）              → `Resource`（今は無理）
 *     - 文明が禁止（ヴァイキング・アステカの厩、アステカの鉄鎧系）    → `Civ`（**永久に暗い**）
 *
 * ■ 層の制約（手順書 §3.1）
 *   World は**読むだけ**。状態を変えるのは返した `Command` を `emit` したときだけ。
 *   コストと効果の数値は `defs.ts` / `production.ts` / `effects.ts` から引き、ここには書かない。
 */

import buildingsJson from '@/data/buildings.json' with { type: 'json' };
import configJson from '@/data/config.json' with { type: 'json' };

import { EntityKind, RESOURCE_COUNT, type EntityId, type PlayerId } from '@/shared/types';
import type { Command } from '@/sim/command';
import { TICK_RATE, cfgAges } from '@/sim/core/config';
import {
  BUILDING_DEFS,
  CIV_DEFS,
  TECH_DEFS,
  UNIT_DEFS,
  buildingDef,
  buildingDefById,
  canCivBuild,
  canCivResearch,
  civUnitsAtAge,
  resolveBuildingForCiv,
  techDef,
  unitDef,
  type BuildingDef,
  type TechDef,
  type UnitDef,
} from '@/sim/core/defs';
import {
  applyUnitStat,
  buildingLimit,
  buildingSightAdd,
  getPlayerModifiers,
  isBuildingComplete,
  isUnitUnlocked,
  unitRequiresUnlock,
} from '@/sim/core/effects';
import {
  MAX_PRODUCTION_QUEUE,
  PROGRESS_DONE,
  RESEARCH_AGE_ADVANCE,
  resolveIndex,
} from '@/sim/core/entity';
import { FX_ONE, fxToNumber } from '@/sim/core/fx';
import { isVillagerIndex } from '@/sim/core/gather';
import { hasPopRoomFor } from '@/sim/core/population';
import { getPlayer, type World } from '@/sim/core/world';
import {
  ageAdvanceCostFx,
  canAdvanceAge,
  countCurrentAgeBuildingKinds,
  isProductionSource,
  isUnitAvailable,
  productionQueueLimit,
  techCostFx,
  unitCostFx,
} from '@/sim/systems/production';
import { resourceGlyph } from '@/render/palette';

/** グリッドのキー配列（`05§9` の QWER / ASDF / ZXCV）。 */
export const GRID_KEYS: readonly string[] = [
  'Q',
  'W',
  'E',
  'R',
  'A',
  'S',
  'D',
  'F',
  'Z',
  'X',
  'C',
  'V',
];

/** 段数（3 段）と 1 段のボタン数（4 個）。積が `GRID_KEYS.length` と一致する。 */
export const GRID_ROWS = 3;
export const GRID_COLS = 4;

/** ボタンが押せない理由（`05§9` / `05§15` の 3 種）。 */
export const DisabledReason = {
  None: '',
  Age: '時代が足りない',
  Resource: '資源が足りない',
  Civ: 'この文明は持てない',
} as const;
export type DisabledReasonId = (typeof DisabledReason)[keyof typeof DisabledReason];

/** ボタンの種別。 */
export type GridButtonKind = 'build' | 'produce' | 'research' | 'advanceAge';

/** グリッド 1 ボタン。 */
export interface GridButton {
  /** 対応キー（`GRID_KEYS`）。 */
  readonly key: string;
  readonly label: string;
  readonly kind: GridButtonKind;
  readonly enabled: boolean;
  readonly reason: DisabledReasonId;
  /** 3 種に丸めた `reason` では足りない事情（前提研究・人口上限など）。 */
  readonly detail: string;
  /** 足りない資源の index（`RESOURCE_IDS` 順）。 */
  readonly lacking: readonly number[];
  /** 押したときに送る Command。null なら「置くモード」に入る（`building` を見る）。 */
  readonly command: Command | null;
  /** 建設したい建物 ID（`placeBuilding` は位置が必要なので、クリック後に決める）。 */
  readonly building: string | null;
  /** ツールチップ（コストと時間）。 */
  readonly hint: string;
}

/** 判定の結果（純関数。テストはここを突く）。 */
export interface Verdict {
  readonly enabled: boolean;
  readonly reason: DisabledReasonId;
  readonly detail: string;
  readonly lacking: readonly number[];
}

/** 属性 1 つ（`05§9-3`。`bonus > 0` を金色で「+n」と出す）。 */
export interface AttrView {
  readonly label: string;
  readonly base: number;
  /** 研究などで伸びた分。金色の加算表示にする。 */
  readonly bonus: number;
}

/** 選択中の対象（`05§9-1`〜`05§9-3`）。 */
export interface PanelTarget {
  readonly name: string;
  /** 同時に選んでいる数（`名前 他 N`）。 */
  readonly count: number;
  readonly sprite: string;
  readonly hpRatio: number;
  readonly hpText: string;
  /** 建設中か（体力バーが建築の進捗を兼ねる）。 */
  readonly underConstruction: boolean;
  /** 建設の進捗（0..1）。建設中でなければ 1。 */
  readonly buildRatio: number;
  readonly attrs: readonly AttrView[];
}

/** 生産キューの 1 件（先頭が生産中。リング表示に使う）。 */
export interface QueueItemView {
  readonly index: number;
  readonly name: string;
  /** 先頭だけ 0..1 の進捗。以降は 0。 */
  readonly ratio: number;
}

/** 12 スロットのうちの 1 つ（`button === null` = 空きスロット）。 */
export interface GridSlot {
  readonly key: string;
  readonly row: number;
  readonly col: number;
  readonly button: GridButton | null;
}

/** 生産・建設パネル全体の表示モデル（DOM を触らない純データ）。 */
export interface ProductionPanelModel {
  readonly target: PanelTarget | null;
  /** 必ず `GRID_KEYS.length`（12）件。 */
  readonly slots: readonly GridSlot[];
  readonly rowLabels: readonly string[];
  readonly page: number;
  readonly pageCount: number;
  readonly queue: readonly QueueItemView[];
  /** 生産キューの上限（既定 5。ローマ「軍団編成」で 10）。 */
  readonly queueLimit: number;
  /** 研究・解読の進行中表示（`05§10-8`「研究中も内政と戦闘は止まらない」）。 */
  readonly researchLabel: string;
  readonly researchRatio: number;
}

// ---------------------------------------------------------------- データ由来の小道具

/**
 * 時代の呼び名（`config.json:ages[].name`）。UI に時代名を書き写さないため
 * データから引く（`cfgAges()` は `name` を公開していないので JSON を直接読む）。
 */
const AGE_LABELS: readonly string[] = (
  (configJson as unknown as { ages?: { id: string; name?: string }[] }).ages ?? []
).map((a) => a.name ?? a.id);

/** 時代の呼び名。 */
export function ageName(ageIdx: number): string {
  return AGE_LABELS[ageIdx] ?? '?';
}

const NO_LACK: readonly number[] = [];

function ok(): Verdict {
  return { enabled: true, reason: DisabledReason.None, detail: '', lacking: NO_LACK };
}

function ng(
  reason: DisabledReasonId,
  detail: string,
  lacking: readonly number[] = NO_LACK
): Verdict {
  return { enabled: false, reason, detail, lacking };
}

/** コストを払えるか調べ、足りない資源の index を返す。 */
export function lackingResources(w: World, p: PlayerId, cost: Int32Array): number[] {
  const pl = getPlayer(w, p);
  if (pl === undefined) return [];
  const out: number[] = [];
  for (let r = 0; r < RESOURCE_COUNT; r++) {
    if ((pl.resources[r] ?? 0) < (cost[r] ?? 0)) out.push(r);
  }
  return out;
}

/** コストを「食100 / 木50」の形にする（記号は `render/palette` と共通）。 */
export function costText(cost: Int32Array): string {
  const parts: string[] = [];
  for (let r = 0; r < RESOURCE_COUNT; r++) {
    const v = cost[r] ?? 0;
    if (v <= 0) continue;
    parts.push(`${resourceGlyph(r)}${Math.round(fxToNumber(v))}`);
  }
  return parts.length === 0 ? '無償' : parts.join(' / ');
}

/** tick 数を「30 秒」の形にする（秒数はデータ由来）。 */
export function ticksText(ticks: number): string {
  return `${Math.round(ticks / TICK_RATE)} 秒`;
}

/** 自軍が持っている（建設中を含む）その建物の数。 */
function countOwnBuildings(w: World, p: PlayerId, typeIndex: number): number {
  const e = w.entities;
  let n = 0;
  for (let i = 0; i < e.highWater; i++) {
    if (e.alive[i] !== 1) continue;
    if (e.kind[i] !== EntityKind.Building) continue;
    if (e.owner[i] !== p) continue;
    if (e.typeId[i] !== typeIndex) continue;
    n++;
  }
  return n;
}

/** その文明の兵種ツリーに載っているユニット ID（全時代ぶん）。 */
function civTreeUnits(civ: string): Set<string> {
  const out = new Set<string>();
  for (let age = 1; age < cfgAges().length; age++) {
    for (const id of civUnitsAtAge(civ as never, age)) out.add(id);
  }
  return out;
}

/** どこかの文明の兵種ツリーに載っているユニット ID（= 時代で段が入れ替わる兵）。 */
const TREE_UNITS_ANY_CIV: ReadonlySet<string> = (() => {
  const out = new Set<string>();
  for (const c of CIV_DEFS) {
    for (const line of Object.keys(c.unitTree)) {
      const arr = c.unitTree[line];
      if (arr === undefined) continue;
      for (const v of arr) {
        if (v === null || v === undefined) continue;
        if (Array.isArray(v)) for (const id of v) out.add(id);
        else out.add(v as string);
      }
    }
  }
  return out;
})();

// ---------------------------------------------------------------- 判定（純関数）

/**
 * その建物を今建てられるか（`05§9-6` の 3 種に分類する）。
 * ヴァイキングとアステカの厩は `Civ` になり**永久に暗い**。
 */
export function judgeBuild(w: World, p: PlayerId, def: BuildingDef): Verdict {
  const pl = getPlayer(w, p);
  if (pl === undefined) return ng(DisabledReason.Civ, '観戦中');
  if (!canCivBuild(pl.civ, def.id)) return ng(DisabledReason.Civ, 'この文明は建てられない');
  if (def.age > pl.age) return ng(DisabledReason.Age, `${ageName(def.age)}で解禁される`);
  const limit = buildingLimit(getPlayerModifiers(w, p), def);
  if (limit > 0 && countOwnBuildings(w, p, def.index) >= limit) {
    return ng(DisabledReason.Resource, `${def.name}は ${limit} 棟まで`);
  }
  const lacking = lackingResources(w, p, def.cost);
  if (lacking.length > 0) return ng(DisabledReason.Resource, '資源が足りない', lacking);
  return ok();
}

/** その建物でそのユニットを今生産できるか。 */
export function judgeProduce(w: World, p: PlayerId, buildingIdx: number, udef: UnitDef): Verdict {
  const pl = getPlayer(w, p);
  if (pl === undefined) return ng(DisabledReason.Civ, '観戦中');
  if (udef.civ !== null && udef.civ !== pl.civ) {
    return ng(DisabledReason.Civ, 'この文明の兵ではない');
  }
  // 段で入れ替わる系統の兵は、その文明のツリーに無ければ**永久に**作れない
  //（例: 騎兵を持たないヴァイキング・アステカ）。
  if (TREE_UNITS_ANY_CIV.has(udef.id) && !civTreeUnits(pl.civ).has(udef.id)) {
    return ng(DisabledReason.Civ, 'この文明は持たない役割');
  }
  if (udef.age > pl.age) return ng(DisabledReason.Age, `${ageName(udef.age)}で解禁される`);
  if (unitRequiresUnlock(udef) && !isUnitUnlocked(getPlayerModifiers(w, p), udef)) {
    return ng(DisabledReason.Age, '解禁されていない（前提の建物が必要）');
  }
  if (!isUnitAvailable(w, p, udef)) return ng(DisabledReason.Age, '今の世ではこの段を作れない');
  const e = w.entities;
  if (!isBuildingComplete(w, buildingIdx)) return ng(DisabledReason.Age, '建設中');
  const bdef = buildingDef(e.typeId[buildingIdx]!);
  const limit = productionQueueLimit(w, p, bdef.id);
  if ((e.queueCount[buildingIdx] ?? 0) >= limit) {
    return ng(DisabledReason.Resource, `生産キューが満杯（${limit} 件）`);
  }
  if (!hasPopRoomFor(w, p, udef.index)) {
    return ng(DisabledReason.Resource, `人口上限（${pl.pop}/${pl.popCap}）`);
  }
  const lacking = lackingResources(w, p, unitCostFx(w, p, udef));
  if (lacking.length > 0) return ng(DisabledReason.Resource, '資源が足りない', lacking);
  return ok();
}

/** 前提研究のうち未了のものの名前（`05§10-6`「飛び越して研究できない」）。 */
export function missingRequires(w: World, p: PlayerId, tdef: TechDef): string[] {
  const pl = getPlayer(w, p);
  if (pl === undefined) return [];
  const out: string[] = [];
  for (const req of tdef.requires) {
    const d = TECH_DEFS.find((t) => t.id === req);
    if (d === undefined) continue;
    if (pl.researched[d.index] !== 1) out.push(d.name);
  }
  return out;
}

/** その建物でその研究に着手できるか。 */
export function judgeResearch(w: World, p: PlayerId, buildingIdx: number, tdef: TechDef): Verdict {
  const pl = getPlayer(w, p);
  if (pl === undefined) return ng(DisabledReason.Civ, '観戦中');
  if (!canCivResearch(pl.civ, tdef.id)) return ng(DisabledReason.Civ, 'この文明は研究できない');
  if (pl.researched[tdef.index] === 1) return ng(DisabledReason.Age, '研究済み');
  if (tdef.age > pl.age) return ng(DisabledReason.Age, `${ageName(tdef.age)}で解禁される`);
  const missing = missingRequires(w, p, tdef);
  if (missing.length > 0) {
    return ng(DisabledReason.Age, `前提「${missing.join('・')}」が未研究（飛び越せない）`);
  }
  const e = w.entities;
  if (!isBuildingComplete(w, buildingIdx)) return ng(DisabledReason.Age, '建設中');
  if (e.researchTech[buildingIdx] !== 0) return ng(DisabledReason.Resource, 'この建物は研究中');
  const bdef = buildingDef(e.typeId[buildingIdx]!);
  const lacking = lackingResources(w, p, techCostFx(w, p, tdef, bdef.id));
  if (lacking.length > 0) return ng(DisabledReason.Resource, '資源が足りない', lacking);
  return ok();
}

/** 「この建物では解読できない」（ボタンを置かない判定に使う目印）。 */
const NOT_AGE_BUILDING = 'この建物では解読できない';

/**
 * 時代進化（解読）ができる建物 ID（`buildings.json:canAdvanceAge`）。
 * `defs.ts` がこのフラグを公開していないので JSON を直接読む
 * （`systems/production.ts` も同じ理由で同じ読み方をしている）。
 */
const CAN_ADVANCE_AGE: ReadonlySet<string> = (() => {
  const src = buildingsJson as unknown as Record<string, Record<string, unknown>>;
  const out = new Set<string>();
  for (const id of Object.keys(src)) {
    if (id.startsWith('_')) continue;
    if (src[id]?.['canAdvanceAge'] === true) out.add(id);
  }
  return out;
})();

/** 時代進化に着手できるか（資源 / 今の世の建物 2 種）。 */
export function judgeAdvanceAge(w: World, p: PlayerId, buildingIdx: number): Verdict {
  const pl = getPlayer(w, p);
  if (pl === undefined) return ng(DisabledReason.Civ, '観戦中');
  const next = cfgAges()[pl.age + 1];
  if (next === undefined) return ng(DisabledReason.Age, 'これ以上進化できない');
  const e = w.entities;
  // 解読できる建物か（町の中心など）を最初に見る。無関係な建物にボタンを置かないため。
  if (!CAN_ADVANCE_AGE.has(buildingDef(e.typeId[buildingIdx]!).id)) {
    return ng(DisabledReason.Age, NOT_AGE_BUILDING);
  }
  if (e.researchTech[buildingIdx] !== 0) {
    return ng(
      DisabledReason.Resource,
      e.researchTech[buildingIdx] === RESEARCH_AGE_ADVANCE ? '解読中' : 'この建物は研究中'
    );
  }
  const kinds = countCurrentAgeBuildingKinds(w, p);
  if (kinds < next.requireBuildingsOfPrevAge) {
    return ng(
      DisabledReason.Age,
      `今の世の建物が ${next.requireBuildingsOfPrevAge} 種必要（今 ${kinds} 種）`
    );
  }
  const lacking = lackingResources(w, p, ageAdvanceCostFx(pl.age + 1));
  if (lacking.length > 0) return ng(DisabledReason.Resource, '資源が足りない', lacking);
  return canAdvanceAge(w, p, buildingIdx) ? ok() : ng(DisabledReason.Age, NOT_AGE_BUILDING);
}

// ---------------------------------------------------------------- 段の割り振り

/**
 * 建物がどの段に入るか（`05§9-4` / `05§9-5`）。
 * データの性質だけで決める（建物 ID でコードを分岐させない）:
 *   0 上段 = 内政（搬入点・人口を増やす・生産も研究もしない建物）
 *   1 中段 = 生産・研究の建物（兵舎・射場・市場・鍛冶場…）
 *   2 下段 = 防御・その他（壁・門・塔・城・記念碑）
 */
export function buildRowOf(def: BuildingDef): number {
  if (def.isDropOff || def.popProvide > 0) return 0;
  if (def.kind !== 'normal') return 2;
  if (def.isWall || def.isGate || def.attackDamage > 0 || def.garrisonCapacity > 0) return 2;
  if (def.researches.length > 0 || producesMilitary(def)) return 1;
  return 0;
}

/** その建物から兵（村人・支援以外）が出るか。 */
function producesMilitary(def: BuildingDef): boolean {
  for (const u of UNIT_DEFS) {
    if (!isProductionSource(def, u)) continue;
    if (u.role === 'villager' || u.role === 'support') continue;
    return true;
  }
  return false;
}

// ---------------------------------------------------------------- 候補の収集

interface Candidate {
  readonly row: number;
  readonly button: Omit<GridButton, 'key'>;
}

/** 村人を選んだときの建設候補（**建てられないものも暗いボタンとして残す**）。 */
function villagerCandidates(w: World, p: PlayerId): Candidate[] {
  const pl = getPlayer(w, p);
  if (pl === undefined) return [];
  const out: Candidate[] = [];
  for (const def of BUILDING_DEFS) {
    if (!def.buildable) continue;
    // 他文明の固有建物は候補にしない（「持てない」ではなく「存在しない」）。
    if (def.civ !== null && def.civ !== pl.civ) continue;
    // 置換元は候補から外し、置換先（櫓・翰林院・大天幕…）だけを出す。
    const resolved = resolveBuildingForCiv(pl.civ, def.id);
    if (resolved !== null && resolved !== def.id) continue;
    const v = judgeBuild(w, p, def);
    out.push({
      row: buildRowOf(def),
      button: {
        label: def.name,
        kind: 'build',
        enabled: v.enabled,
        reason: v.reason,
        detail: v.detail,
        lacking: v.lacking,
        command: null,
        building: def.id,
        hint: `${def.name}（${costText(def.cost)} / ${ticksText(def.buildTicks)}）— クリックしてから地面をクリックで建設`,
      },
    });
  }
  return out;
}

/** 建物を選んだときの候補（上段 = 生産 / 中段 = 研究 / 下段 = 時代進化）。 */
function buildingCandidates(w: World, p: PlayerId, head: EntityId, i: number): Candidate[] {
  const pl = getPlayer(w, p);
  if (pl === undefined) return [];
  const e = w.entities;
  const bdef = buildingDef(e.typeId[i]!);
  const out: Candidate[] = [];
  const tree = civTreeUnits(pl.civ);

  // ---- 上段: 生産できるユニット
  // `units.json:producedAt` で引く（`buildings.json:produces` は兵舎・射場・厩が空で、
  // 系統は `producesLines` + `units.json` の civ/line で解決される設計のため）。
  for (const u of UNIT_DEFS) {
    if (!isProductionSource(bdef, u)) continue;
    if (u.civ !== null && u.civ !== pl.civ) continue;
    // 他文明のツリー専用の段は並べない（同じ役割の別文明版が大量に並ぶのを避ける）。
    // 「その文明が持たない役割」は建物ごと持てないので、厩が永久に暗いことで表現される。
    if (TREE_UNITS_ANY_CIV.has(u.id) && !tree.has(u.id)) continue;
    const v = judgeProduce(w, p, i, u);
    out.push({
      row: 0,
      button: {
        label: u.name,
        kind: 'produce',
        enabled: v.enabled,
        reason: v.reason,
        detail: v.detail,
        lacking: v.lacking,
        command: { t: 'produce', p, building: head, unit: u.id, count: 1 },
        building: null,
        hint: `${u.name}（${costText(unitCostFx(w, p, u))} / ${ticksText(u.buildTicks)} / 人口 ${u.pop}）`,
      },
    });
  }

  // ---- 中段: 研究（`techs.json:at` で引く。文明固有研究もここに出る）
  for (const t of TECH_DEFS) {
    if (t.at !== bdef.id && t.at !== bdef.replaces) continue;
    if (t.civ !== null && t.civ !== pl.civ) continue;
    if (pl.researched[t.index] === 1) continue; // 研究済みは学舎パネルの金メダルで見る
    const v = judgeResearch(w, p, i, t);
    out.push({
      row: 1,
      button: {
        label: t.name,
        kind: 'research',
        enabled: v.enabled,
        reason: v.reason,
        detail: v.detail,
        lacking: v.lacking,
        command: { t: 'research', p, building: head, tech: t.id },
        building: null,
        hint: `研究: ${t.name}（${costText(techCostFx(w, p, t, bdef.id))} / ${ticksText(t.researchTicks)}）`,
      },
    });
  }

  // ---- 下段: 時代進化（解読できる建物だけ）
  if (pl.age + 1 < cfgAges().length) {
    const v = judgeAdvanceAge(w, p, i);
    if (v.enabled || v.detail !== NOT_AGE_BUILDING) {
      out.push({
        row: 2,
        button: {
          label: `${ageName(pl.age + 1)}へ`,
          kind: 'advanceAge',
          enabled: v.enabled,
          reason: v.reason,
          detail: v.detail,
          lacking: v.lacking,
          command: { t: 'advanceAge', p, building: head },
          building: null,
          hint: `次の世へ（${costText(ageAdvanceCostFx(pl.age + 1))}）— 戦域スロットが増える`,
        },
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------- モデル生成

const ROW_LABELS_BUILD: readonly string[] = ['内政', '生産・研究', '防御・その他'];
const ROW_LABELS_UNIT: readonly string[] = ['生産', '研究', '時代進化'];

function emptySlots(): GridSlot[] {
  const out: GridSlot[] = [];
  for (let k = 0; k < GRID_KEYS.length; k++) {
    out.push({
      key: GRID_KEYS[k]!,
      row: Math.floor(k / GRID_COLS),
      col: k % GRID_COLS,
      button: null,
    });
  }
  return out;
}

/**
 * 生産・建設パネルの表示モデルを作る（DOM を触らない）。
 * `page` は 1 段 4 個を超えた候補の送り。段の意味はページを送っても変わらない。
 */
export function buildProductionPanelModel(
  w: World,
  viewer: PlayerId,
  selected: readonly EntityId[],
  page = 0
): ProductionPanelModel {
  const empty: ProductionPanelModel = {
    target: null,
    slots: emptySlots(),
    rowLabels: ROW_LABELS_BUILD,
    page: 0,
    pageCount: 1,
    queue: [],
    queueLimit: 0,
    researchLabel: '',
    researchRatio: 0,
  };
  const pl = getPlayer(w, viewer);
  if (pl === undefined || selected.length === 0) return empty;
  const e = w.entities;
  const head = selected[0]!;
  const i = resolveIndex(e, head);
  if (i < 0) return empty;

  const isVillager = isVillagerIndex(e, i);
  const isOwnBuilding = e.kind[i] === EntityKind.Building && e.owner[i] === viewer;

  const candidates: Candidate[] = isVillager
    ? villagerCandidates(w, viewer)
    : isOwnBuilding
      ? buildingCandidates(w, viewer, head, i)
      : [];

  const rows: Candidate[][] = [[], [], []];
  for (const c of candidates) rows[c.row]?.push(c);
  let pageCount = 1;
  for (const r of rows) pageCount = Math.max(pageCount, Math.ceil(r.length / GRID_COLS));
  const pg = Math.max(0, Math.min(page, pageCount - 1));

  const slots = emptySlots();
  for (let row = 0; row < GRID_ROWS; row++) {
    const list = rows[row] ?? [];
    for (let col = 0; col < GRID_COLS; col++) {
      const c = list[pg * GRID_COLS + col];
      if (c === undefined) continue;
      const k = row * GRID_COLS + col;
      slots[k] = { key: GRID_KEYS[k]!, row, col, button: { ...c.button, key: GRID_KEYS[k]! } };
    }
  }

  return {
    target: targetOf(w, viewer, selected, i),
    slots,
    rowLabels: isVillager ? ROW_LABELS_BUILD : ROW_LABELS_UNIT,
    page: pg,
    pageCount,
    queue: isOwnBuilding ? queueOf(w, i) : [],
    queueLimit: isOwnBuilding ? productionQueueLimit(w, viewer, buildingDef(e.typeId[i]!).id) : 0,
    researchLabel: isOwnBuilding ? researchLabelOf(w, i) : '',
    researchRatio: isOwnBuilding ? researchRatioOf(w, i) : 0,
  };
}

/**
 * 選択対象の表示（`05§9-1`〜`05§9-3`）。
 * 名前は**その文明での呼び名**（櫓・翰林院・大天幕）。文明置換は定義側が実体を分けているので、
 * 選択中のエンティティの `typeId` を引けばそのまま civ の呼び名になる。
 */
function targetOf(
  w: World,
  viewer: PlayerId,
  selected: readonly EntityId[],
  i: number
): PanelTarget {
  const e = w.entities;
  const kind = e.kind[i]!;
  const hp = e.hp[i]!;
  const hpMax = e.hpMax[i]!;
  const progress = e.buildProgress[i]!;
  const underConstruction = progress > 0 && progress < PROGRESS_DONE;
  const m = getPlayerModifiers(w, viewer);
  const hpText = `${Math.round(fxToNumber(hp))} / ${Math.round(fxToNumber(hpMax))}`;

  if (kind === EntityKind.Unit) {
    const def = unitDef(e.typeId[i]!);
    return {
      name: def.name,
      count: selected.length,
      sprite: def.sprite,
      hpRatio: hpMax > 0 ? clamp01(hp / hpMax) : 0,
      hpText,
      underConstruction: false,
      buildRatio: 1,
      attrs: [
        attr('攻撃', def.atk, applyUnitStat(m, def, 'atk', def.atk)),
        attr('防御', def.def, applyUnitStat(m, def, 'def', def.def)),
        attr('射程', def.range, applyUnitStat(m, def, 'rangeTiles', def.range)),
        // 視界を伸ばす研究（測量）は建物にだけ効く。
        attr('視界', def.sight, def.sight),
      ],
    };
  }

  const def = buildingDef(e.typeId[i]!);
  return {
    name: def.name,
    count: selected.length,
    sprite: '',
    hpRatio: hpMax > 0 ? clamp01(hp / hpMax) : 0,
    hpText,
    underConstruction,
    buildRatio: underConstruction ? clamp01(progress / PROGRESS_DONE) : 1,
    attrs: [
      attr('攻撃', def.attackDamage, def.attackDamage),
      attr('防御', 0, 0),
      attr('射程', def.attackRange, def.attackRange),
      attr('視界', def.sight, def.sight + buildingSightAdd(m)),
    ],
  };
}

function attr(label: string, baseFx: number, effectiveFx: number): AttrView {
  const base = round1(fxToNumber(baseFx));
  const eff = round1(fxToNumber(effectiveFx));
  return { label, base, bonus: round1(eff - base) };
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** 生産キュー（先頭 = 生産中。リングが一周で 1 体完成）。 */
function queueOf(w: World, i: number): QueueItemView[] {
  const e = w.entities;
  const out: QueueItemView[] = [];
  const n = Math.min(e.queueCount[i] ?? 0, MAX_PRODUCTION_QUEUE);
  for (let k = 0; k < n; k++) {
    const typeId = (e.queueUnit[i * MAX_PRODUCTION_QUEUE + k] ?? 0) - 1;
    if (typeId < 0) continue;
    const def = unitDef(typeId);
    const required = def.buildTicks * FX_ONE;
    const ratio = k === 0 && required > 0 ? clamp01((e.prodProgress[i] ?? 0) / required) : 0;
    out.push({ index: k, name: def.name, ratio });
  }
  return out;
}

/** 研究・解読の表示名（`05§10-8`「研究中も内政と戦闘は止まらない」）。 */
function researchLabelOf(w: World, i: number): string {
  const rt = w.entities.researchTech[i] ?? 0;
  if (rt === 0) return '';
  if (rt === RESEARCH_AGE_ADVANCE) {
    const pl = getPlayer(w, w.entities.owner[i]!);
    return `解読中: ${ageName((pl?.age ?? 0) + 1)}`;
  }
  return `研究中: ${techDef(rt - 1).name}`;
}

function researchRatioOf(w: World, i: number): number {
  const e = w.entities;
  const rt = e.researchTech[i] ?? 0;
  if (rt === 0) return 0;
  const pl = getPlayer(w, e.owner[i]!);
  const baseTicks =
    rt === RESEARCH_AGE_ADVANCE
      ? (cfgAges()[(pl?.age ?? 0) + 1]?.researchTicks ?? 0)
      : techDef(rt - 1).researchTicks;
  const required = baseTicks * FX_ONE;
  return required > 0 ? clamp01((e.researchProgress[i] ?? 0) / required) : 0;
}

/**
 * 旧 API（`Hud.ts` が使う）。**詰めた配列**を返すので添字がそのままキーになる。
 * 新しい画面は `buildProductionPanelModel`（12 スロットの位置が保たれる）を使うこと。
 */
export function buildCommandGrid(
  w: World,
  viewer: PlayerId,
  selected: readonly EntityId[]
): GridButton[] {
  const model = buildProductionPanelModel(w, viewer, selected, 0);
  const out: GridButton[] = [];
  for (const s of model.slots) {
    if (s.button === null) continue;
    out.push({ ...s.button, key: GRID_KEYS[out.length] ?? '' });
  }
  return out;
}

/** 錠の記号（理由 3 種を色に頼らず区別する。`06§12`）。 */
export function lockGlyph(reason: DisabledReasonId): string {
  if (reason === DisabledReason.Civ) return '✖';
  if (reason === DisabledReason.Age) return '🔒';
  if (reason === DisabledReason.Resource) return '△';
  return '';
}

/** 建物 ID からその文明での呼び名を引く（`05§9-1`）。 */
export function civBuildingName(civ: string, buildingId: string): string {
  const resolved = resolveBuildingForCiv(civ as never, buildingId);
  return buildingDefById(resolved ?? buildingId).name;
}

// ---------------------------------------------------------------- DOM（部品）

/** パネルが外に触るための窓口（World は読むだけ。変更は `emit` の Command 経由）。 */
export interface ProductionPanelContext {
  world(): World;
  readonly viewer: PlayerId;
  /** 今選んでいるエンティティ（入力層の選択状態）。 */
  selected(): readonly EntityId[];
  emit(cmd: Command): void;
  /** 建設の「置くモード」に入る（位置は地面クリックで決まる）。 */
  beginPlacement(buildingId: string): void;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * 生産・建設パネル（対戦画面の下端）。**試合は止まらない**（World を読むだけ）。
 *
 * ```ts
 * const panel = new ProductionPanel(bottomEl, ctx);
 * panel.update();        // 毎フレーム（呼ぶ側が間引く）
 * panel.pressKey('Q');   // キーボードからの入口
 * ```
 */
export class ProductionPanel {
  readonly root: HTMLElement;
  private readonly ctx: ProductionPanelContext;

  private readonly nameEl: HTMLElement;
  private readonly hpFill: HTMLElement;
  private readonly hpTextEl: HTMLElement;
  private readonly attrsEl: HTMLElement;
  private readonly rowLabelEls: HTMLElement[] = [];
  private readonly btnEls: HTMLButtonElement[] = [];
  private readonly pageEl: HTMLElement;
  private readonly queueEl: HTMLElement;
  private readonly researchEl: HTMLElement;

  private model: ProductionPanelModel;
  private page = 0;

  constructor(parent: HTMLElement, ctx: ProductionPanelContext) {
    this.ctx = ctx;
    this.root = el('div', 'mt-prod');

    // ---- 1 選択中の対象 / 2 体力バー / 3 属性 ----
    const left = el('div', 'mt-prod-target');
    this.nameEl = el('div', 'mt-prod-name', '—');
    const hpWrap = el('div', 'mt-prod-hp');
    this.hpFill = el('div', 'mt-prod-hp-fill');
    hpWrap.appendChild(this.hpFill);
    this.hpTextEl = el('div', 'mt-prod-hp-text', '');
    this.attrsEl = el('div', 'mt-prod-attrs');
    left.append(this.nameEl, hpWrap, this.hpTextEl, this.attrsEl);

    // ---- 4/5 コマンドグリッド（3 段 12 ボタン） ----
    const gridWrap = el('div', 'mt-prod-gridwrap');
    const grid = el('div', 'mt-prod-grid');
    for (let row = 0; row < GRID_ROWS; row++) {
      const label = el('div', 'mt-prod-rowlabel', '');
      grid.appendChild(label);
      this.rowLabelEls.push(label);
      for (let col = 0; col < GRID_COLS; col++) {
        const k = row * GRID_COLS + col;
        const b = el('button', 'mt-prod-btn');
        b.type = 'button';
        b.append(
          el('span', 'mt-prod-btn-key', GRID_KEYS[k] ?? ''),
          el('span', 'mt-prod-btn-label', ''),
          el('span', 'mt-prod-btn-lock', '')
        );
        b.addEventListener('click', () => this.press(k));
        grid.appendChild(b);
        this.btnEls.push(b);
      }
    }
    this.pageEl = el('div', 'mt-prod-page', '');
    const pageBtn = el('button', 'mt-prod-pagebtn', '次のページ');
    pageBtn.type = 'button';
    pageBtn.addEventListener('click', () => this.nextPage());
    const pageRow = el('div', 'mt-prod-pagerow');
    pageRow.append(this.pageEl, pageBtn);
    gridWrap.append(grid, pageRow);

    // ---- 7/8 生産中と生産キュー ----
    const right = el('div', 'mt-prod-queuewrap');
    this.queueEl = el('div', 'mt-prod-queue');
    this.researchEl = el('div', 'mt-prod-research', '');
    right.append(this.queueEl, this.researchEl);

    this.root.append(left, gridWrap, right);
    parent.appendChild(this.root);
    this.model = buildProductionPanelModel(ctx.world(), ctx.viewer, ctx.selected(), 0);
  }

  /** キーボード（`QWER/ASDF/ZXCV`）からの入口。 */
  pressKey(key: string): boolean {
    const k = GRID_KEYS.indexOf(key.toUpperCase());
    if (k < 0) return false;
    return this.press(k);
  }

  /** ページ送り（1 段 4 個を超える候補があるとき）。 */
  nextPage(): void {
    if (this.model.pageCount <= 1) return;
    this.page = (this.page + 1) % this.model.pageCount;
    this.update();
  }

  private press(k: number): boolean {
    const b = this.model.slots[k]?.button ?? null;
    if (b === null || !b.enabled) return false;
    if (b.command !== null) {
      this.ctx.emit(b.command);
      return true;
    }
    if (b.building !== null) {
      this.ctx.beginPlacement(b.building);
      return true;
    }
    return false;
  }

  /** 表示を作り直す（World は読むだけ）。 */
  update(): void {
    const model = buildProductionPanelModel(
      this.ctx.world(),
      this.ctx.viewer,
      this.ctx.selected(),
      this.page
    );
    this.model = model;
    this.page = model.page;

    // 1/2/3
    const t = model.target;
    this.nameEl.textContent =
      t === null ? '—' : t.count > 1 ? `${t.name} 他 ${t.count - 1}` : t.name;
    this.hpFill.style.width = `${Math.round((t?.hpRatio ?? 0) * 100)}%`;
    this.hpTextEl.textContent =
      t === null
        ? ''
        : `${t.hpText}${t.underConstruction ? `（建設中 ${Math.round(t.buildRatio * 100)}%）` : ''}`;
    this.root.classList.toggle('mt-prod-building', t?.underConstruction === true);
    this.attrsEl.textContent = '';
    for (const a of t?.attrs ?? []) {
      const item = el('span', 'mt-prod-attr');
      item.append(
        el('span', 'mt-prod-attr-label', a.label),
        el('span', 'mt-prod-attr-base', String(a.base))
      );
      // 研究で伸びた分は**金色で加算表示**（`05§9-3`）
      if (a.bonus > 0) item.append(el('span', 'mt-prod-attr-bonus', `+${a.bonus}`));
      this.attrsEl.appendChild(item);
    }

    // 4/5/6
    for (let row = 0; row < GRID_ROWS; row++) {
      const label = this.rowLabelEls[row];
      if (label !== undefined) label.textContent = model.rowLabels[row] ?? '';
    }
    for (let k = 0; k < this.btnEls.length; k++) {
      const node = this.btnEls[k];
      if (node === undefined) continue;
      const b = model.slots[k]?.button ?? null;
      const label = node.querySelector('.mt-prod-btn-label');
      const lock = node.querySelector('.mt-prod-btn-lock');
      const dark = b !== null && !b.enabled;
      node.classList.toggle('mt-prod-empty', b === null);
      node.classList.toggle('mt-prod-disabled', dark);
      node.classList.toggle('mt-lock-age', dark && b.reason === DisabledReason.Age);
      node.classList.toggle('mt-lock-res', dark && b.reason === DisabledReason.Resource);
      node.classList.toggle('mt-lock-civ', dark && b.reason === DisabledReason.Civ);
      if (label !== null) label.textContent = b?.label ?? '';
      if (lock !== null) lock.textContent = dark ? lockGlyph(b.reason) : '';
      // 暗い理由は 3 種 + 具体的な事情をカーソルで出す（`05§15`）
      node.title = b === null ? '' : dark ? `${b.hint}\n${b.reason}: ${b.detail}` : b.hint;
      node.disabled = b === null || !b.enabled;
    }
    this.pageEl.textContent =
      model.pageCount > 1 ? `${model.page + 1} / ${model.pageCount} ページ` : '';

    // 7/8
    this.queueEl.textContent = '';
    for (let k = 0; k < model.queueLimit; k++) {
      const q = model.queue[k];
      const slot = el('div', 'mt-prod-qslot');
      if (q === undefined) {
        slot.classList.add('mt-prod-qempty');
        this.queueEl.appendChild(slot);
        continue;
      }
      slot.append(el('span', 'mt-prod-qname', q.name));
      if (k === 0) {
        // リングが一周で 1 体完成（`05§9-7`）
        const ring = el('span', 'mt-prod-qring');
        ring.style.setProperty('--mt-ring', `${Math.round(q.ratio * 360)}deg`);
        slot.appendChild(ring);
        slot.classList.add('mt-prod-qhead');
      }
      // 右クリックで取消（資源は全額返却。`06§6`）
      slot.addEventListener('contextmenu', (ev: MouseEvent) => {
        ev.preventDefault();
        const sel = this.ctx.selected();
        if (sel.length === 0) return;
        this.ctx.emit({ t: 'cancelQueue', p: this.ctx.viewer, building: sel[0]!, index: q.index });
      });
      this.queueEl.appendChild(slot);
    }
    this.researchEl.textContent = model.researchLabel;
    this.researchEl.style.setProperty('--mt-ratio', `${Math.round(model.researchRatio * 100)}%`);
  }

  destroy(): void {
    this.root.remove();
  }
}
