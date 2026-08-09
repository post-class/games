/**
 * ui/hud/techPanel.ts — 学舎（研究）パネル（`05§10` の 8 項目。T-M12-06）
 *
 * ■ `05§10` の 8 項目との対応
 *   1 系統タブ（鍛冶場／学舎／採集／その他）  → `TechPanelModel.tabs`。**建てていない系統は暗く開けない**
 *   2 起点（その系統の最初の研究）           → `TechNodeView.isRoot`（`requires` が空）
 *   3 研究済み = 金色のメダル（効果は累積）   → `state === 'researched'`
 *   4 研究可能 = 縁が光る。クリックで即開始   → `state === 'available'` + `command`（`research`）
 *   5 未解禁 = 暗く錠。時代不足 or 文明制限   → `state === 'locked'` + `reason` / `detail`
 *   6 前提線（飛び越して研究できない）        → `TechPanelModel.edges`
 *   7 説明プレート（効果と、それが効く場面）  → `TechNodeView.effectText` / `sceneText`
 *   8 必要資源と時間                        → `TechNodeView.costText` / `timeText`
 *
 * ■ 「画面上での見え方」（`05§10` の表）
 *   旗竿 → 右端の空きスロットが 1 つ増える / 早馬 → 砂時計が短くなる /
 *   復唱 → 伝達線の点線が流れる時間が半分 / 二重旗 → スロットが上下 2 段に割れる /
 *   徴兵令 → 生産キューのリングが速く回る。
 *   これらは**他の画面の見た目**なので、学舎側は `lookText` として説明文で出すだけにする。
 *   文言は研究 ID ではなく**効果の型**で引くので、データが増えても壊れない。
 *
 * ■ 制約
 *   - World は**読むだけ**。開始は `research` Command を `emit` するだけ（手順書 §3.1）。
 *   - コスト・時間・効果の数値は `defs.ts` / `production.ts` / `effects.ts` から引く。
 *   - **このパネルを開いても試合は止まらない**（`05§1`）。`update()` は表示だけを作る。
 */

import configJson from '@/data/config.json' with { type: 'json' };
import techsJson from '@/data/techs.json' with { type: 'json' };

import { EntityKind, RESOURCE_COUNT, type EntityId, type PlayerId } from '@/shared/types';
import type { Command } from '@/sim/command';
import { TICK_RATE } from '@/sim/core/config';
import {
  TECH_DEFS,
  buildingDef,
  buildingDefById,
  canCivResearch,
  resolveBuildingForCiv,
  type TechDef,
} from '@/sim/core/defs';
import { getPlayerModifiers, isBuildingComplete, researchTimeMul } from '@/sim/core/effects';
import { idOfIndex } from '@/sim/core/entity';
import { FX_ONE, fxToNumber } from '@/sim/core/fx';
import { getPlayer, type World } from '@/sim/core/world';
import { techCostFx } from '@/sim/systems/production';
import { resourceGlyph } from '@/render/palette';
import { DisabledReason, type DisabledReasonId } from './commandGrid';

// ---------------------------------------------------------------- データ由来の小道具

/**
 * 時代の呼び名（`config.json:ages[].name`）。**UI に時代名を書き写さない**ため
 * データから引く（`cfgAges()` は name を公開していないので JSON を直接読む）。
 */
export const AGE_NAMES: readonly string[] = (
  (configJson as unknown as { ages?: { id: string; name?: string }[] }).ages ?? []
).map((a) => a.name ?? a.id);

/** `techs.json` の note（効果と効く場面の説明。`defs.ts` は note を持たない）。 */
const TECH_NOTES: Readonly<Record<string, string>> = (() => {
  const src = techsJson as unknown as Record<string, { note?: string }>;
  const out: Record<string, string> = {};
  for (const id of Object.keys(src)) {
    if (id.startsWith('_')) continue;
    out[id] = src[id]?.note ?? '';
  }
  return out;
})();

/** コストを「食100 / 木50」の形にする（記号は `render/palette` と共通）。 */
export function costTextOf(cost: Int32Array): string {
  const parts: string[] = [];
  for (let r = 0; r < RESOURCE_COUNT; r++) {
    const v = cost[r] ?? 0;
    if (v <= 0) continue;
    parts.push(`${resourceGlyph(r)}${Math.round(fxToNumber(v))}`);
  }
  return parts.length === 0 ? '無償' : parts.join(' / ');
}

/** コストに対して足りない資源の index（`RESOURCE_IDS` 順）。 */
export function resourceLackOf(w: World, p: PlayerId, cost: Int32Array): number[] {
  const pl = getPlayer(w, p);
  if (pl === undefined) return [];
  const out: number[] = [];
  for (let r = 0; r < RESOURCE_COUNT; r++) {
    if ((pl.resources[r] ?? 0) < (cost[r] ?? 0)) out.push(r);
  }
  return out;
}

// ---------------------------------------------------------------- 系統タブ

/** 系統タブ（`05§10-1`）。 */
export type TechTabId = 'blacksmith' | 'academy' | 'gather' | 'other';

/**
 * タブに載る建物（`05§10-1` の「鍛冶場／学舎／採集（伐採所・採掘場・農地）／その他（市場・港・城）」）。
 *
 * ここに並ぶのは**画面上のまとめ方**だけで、コストも効果も含まない
 * （バランス数値を UI に書き写さないという規約に触れない）。
 * `other` は「上の 3 つに入らない研究の建物すべて」なので列挙しない。
 */
const TAB_BUILDING_IDS: Readonly<Record<Exclude<TechTabId, 'other'>, readonly string[]>> = {
  blacksmith: ['blacksmith'],
  academy: ['academy'],
  gather: ['lumber_camp', 'mining_camp', 'town_center', 'farm'],
};

/** タブの表示名。 */
const TAB_LABELS: Readonly<Record<TechTabId, string>> = {
  blacksmith: '鍛冶場（兵の質）',
  academy: '学舎（指揮の質）',
  gather: '採集',
  other: 'その他',
};

/** タブの固定順（左から）。 */
export const TECH_TAB_IDS: readonly TechTabId[] = ['blacksmith', 'academy', 'gather', 'other'];

/** その研究がどのタブに載るか（`at` の建物で決まる）。 */
export function techTabOf(t: TechDef): TechTabId {
  for (const tab of ['blacksmith', 'academy', 'gather'] as const) {
    if (TAB_BUILDING_IDS[tab].includes(t.at)) return tab;
  }
  return 'other';
}

/** そのタブに研究がある建物 ID の一覧（`techs.json` から引く）。 */
export function tabBuildingIds(tab: TechTabId): string[] {
  const out: string[] = [];
  for (const t of TECH_DEFS) {
    if (techTabOf(t) !== tab) continue;
    if (!out.includes(t.at)) out.push(t.at);
  }
  return out;
}

// ---------------------------------------------------------------- 表示モデル

/** メダルの状態（`05§10-3`〜`05§10-5`）。 */
export type TechStateId = 'researched' | 'inProgress' | 'available' | 'locked';

/** 研究 1 件のメダル。 */
export interface TechNodeView {
  readonly id: string;
  readonly name: string;
  /** 時代（0..3）。右へ進むほど後の時代（`05§10` の図）。 */
  readonly ageIdx: number;
  readonly ageName: string;
  readonly costText: string;
  readonly timeText: string;
  /** 効果（`techs.json` の note の前半）。 */
  readonly effectText: string;
  /** それが効く場面（note の後半）。`05§10-7`「どの局面で効くか」。 */
  readonly sceneText: string;
  /** 画面上での見え方（`05§10` の表。効果の型から引く）。 */
  readonly lookText: string;
  readonly state: TechStateId;
  /** 錠の理由（3 種。`state === 'locked'` のときだけ意味がある）。 */
  readonly reason: DisabledReasonId;
  readonly detail: string;
  /** 足りない資源の index（`RESOURCE_IDS` 順）。 */
  readonly lacking: readonly number[];
  /** 前提研究（**飛び越して研究できない**）。 */
  readonly requires: readonly string[];
  /** 起点か（`05§10-2`）。 */
  readonly isRoot: boolean;
  /** 研究中の進捗 0..1（`state === 'inProgress'` のとき）。 */
  readonly progress: number;
  /** 研究する建物（その文明での呼び名。翰林院・大天幕を解決済み）。 */
  readonly atBuildingName: string;
  /** クリックで送る Command（`state === 'available'` のときだけ非 null）。 */
  readonly command: Command | null;
}

/** 系統タブ 1 つ。 */
export interface TechTabView {
  readonly id: TechTabId;
  readonly label: string;
  /** 建てていない系統は**暗く開けない**（`05§10-2`）。 */
  readonly enabled: boolean;
  /** 開けない理由（例: 「鍛冶場を建てていない」）。 */
  readonly detail: string;
  readonly total: number;
  readonly researched: number;
}

/** 前提線（`05§10-6`）。 */
export interface TechEdgeView {
  readonly from: string;
  readonly to: string;
  /** 前提が満たされているか（満たされていなければ点線で「飛び越せない」を示す）。 */
  readonly satisfied: boolean;
}

/** 学舎パネル全体。 */
export interface TechPanelModel {
  readonly tabs: readonly TechTabView[];
  readonly activeTab: TechTabId;
  /** 列（時代）ごとに並べたメダル。添字 = 時代 index。 */
  readonly columns: readonly (readonly TechNodeView[])[];
  readonly edges: readonly TechEdgeView[];
  /** いま走っている研究（`05§10-8`「研究中も内政と戦闘は止まらない」）。 */
  readonly runningLabel: string;
}

// ---------------------------------------------------------------- 「見え方」の文言

/**
 * 効果の型 → 画面上での見え方（`05§10` の表）。
 * 研究 ID ではなく**型**で引くので、`techs.json` が増減しても壊れない。
 */
const LOOK_BY_EFFECT: Readonly<Record<string, string>> = {
  frontSlot: '右端の空きスロットが 1 つ増える',
  orderSwitchIntervalMul: 'カード切り替え時の砂時計が短くなる',
  orderDelayMul: '伝達線の点線が流れる時間が短くなる',
  orderDelayDistanceZero: '距離に関係なく点線の流れる時間が一定になる',
  orderStackSlots: 'スロットが上下 2 段に割れる',
  produceSpeedMul: '生産キューのリングが速く回る',
  queueLengthAdd: '生産キューの枠が増える',
  buildingSightAdd: '建物の周りの暗がりが後退する',
  researchCostMul: '以降の研究の必要資源が減る',
  unitStat: '属性アイコンに金色の加算が付く',
  rangedResistAdd: '属性アイコンに金色の加算が付く',
  lowHpAtkBonus: '体力が減った兵の攻撃表示が上がる',
  gatherRateMul: '資源の増減バーが伸びる',
  depositMul: '資源の残量表示が増える',
  farmYieldMul: '農地の残量表示が増える',
  tradeIncomeMul: '交易荷車 1 往復の金が増える',
  cartSpeedMul: '交易荷車が速く往復する',
  healSpeedMul: '祈祷師の治療が速くなる',
  shipStatMul: '船の体力バーが長くなる',
  eliteCostMul: 'エリートの必要資源が減る',
};

/** その研究の「画面上での見え方」（複数の効果があれば連結）。 */
export function lookTextOf(t: TechDef): string {
  const out: string[] = [];
  for (const e of t.effects) {
    const type = typeof e['type'] === 'string' ? (e['type'] as string) : '';
    const text = LOOK_BY_EFFECT[type];
    if (text !== undefined && !out.includes(text)) out.push(text);
  }
  return out.join(' / ');
}

/**
 * `techs.json` の note を「効果」と「効く場面」に割る。
 * note は「効果。場面」（句点区切り）で書かれているので最初の句点で切る。
 */
export function splitNote(note: string): { effect: string; scene: string } {
  const i = note.indexOf('。');
  if (i < 0) return { effect: note, scene: '' };
  return { effect: note.slice(0, i), scene: note.slice(i + 1) };
}

// ---------------------------------------------------------------- 判定（純関数）

/** その研究を行える自軍の完成済み建物の index（無ければ -1）。 */
export function findResearchBuildingIndex(w: World, p: PlayerId, t: TechDef): number {
  const e = w.entities;
  for (let i = 0; i < e.highWater; i++) {
    if (e.alive[i] !== 1) continue;
    if (e.kind[i] !== EntityKind.Building) continue;
    if (e.owner[i] !== p) continue;
    const def = buildingDef(e.typeId[i]!);
    if (def.id !== t.at && def.replaces !== t.at) continue;
    if (!isBuildingComplete(w, i)) continue;
    return i;
  }
  return -1;
}

/** その建物 ID をその文明が持っているか（完成済み。タブの開閉に使う）。 */
export function hasCompletedBuilding(w: World, p: PlayerId, buildingId: string): boolean {
  const pl = getPlayer(w, p);
  if (pl === undefined) return false;
  const resolved = resolveBuildingForCiv(pl.civ, buildingId);
  if (resolved === null) return false;
  const e = w.entities;
  for (let i = 0; i < e.highWater; i++) {
    if (e.alive[i] !== 1) continue;
    if (e.kind[i] !== EntityKind.Building) continue;
    if (e.owner[i] !== p) continue;
    if (buildingDef(e.typeId[i]!).id !== resolved) continue;
    if (!isBuildingComplete(w, i)) continue;
    return true;
  }
  return false;
}

/** 前提研究のうち未了のものの名前（`05§10-6`）。 */
export function missingRequireNames(w: World, p: PlayerId, t: TechDef): string[] {
  const pl = getPlayer(w, p);
  if (pl === undefined) return [];
  const out: string[] = [];
  for (const req of t.requires) {
    const d = TECH_DEFS.find((x) => x.id === req);
    if (d === undefined) continue;
    if (pl.researched[d.index] !== 1) out.push(d.name);
  }
  return out;
}

/** 錠の判定結果。 */
export interface TechVerdict {
  readonly state: TechStateId;
  readonly reason: DisabledReasonId;
  readonly detail: string;
  readonly lacking: readonly number[];
  readonly progress: number;
}

/**
 * メダル 1 つの状態を決める（DOM を触らない。テストはここを突く）。
 *
 * 錠の理由は 3 種に丸める（`05§15`）:
 *   - `Civ`  = その文明が研究できない（例: アステカの鉄鎧系）。**永久に錠**
 *   - `Age`  = まだ解禁されていない（時代不足 / 前提未了 / その建物が無い）
 *   - `Resource` = 今は払えない（資源不足 / その建物が別の研究中）
 * 3 種では足りない事情は `detail` に日本語で入れる（「なんとなく押せない」を作らない）。
 */
export function judgeTech(w: World, p: PlayerId, t: TechDef): TechVerdict {
  const pl = getPlayer(w, p);
  if (pl === undefined) {
    return { state: 'locked', reason: DisabledReason.Civ, detail: '観戦中', lacking: [], progress: 0 };
  }
  if (pl.researched[t.index] === 1) {
    return { state: 'researched', reason: DisabledReason.None, detail: '', lacking: [], progress: 1 };
  }
  // 文明制限は時代や資源より先に見る（**永久に錠**なので他の理由を出しても意味がない）。
  if (!canCivResearch(pl.civ, t.id)) {
    return {
      state: 'locked',
      reason: DisabledReason.Civ,
      detail: 'この文明は研究できない',
      lacking: [],
      progress: 0,
    };
  }
  // 研究中か（`05§10-8`。研究中も内政と戦闘は止まらない）
  const e = w.entities;
  for (let i = 0; i < e.highWater; i++) {
    if (e.alive[i] !== 1) continue;
    if (e.owner[i] !== p) continue;
    if (e.researchTech[i] !== t.index + 1) continue;
    const def = buildingDef(e.typeId[i]!);
    const required = t.researchTicks * fxToNumber(researchTimeMul(getPlayerModifiers(w, p), def.id));
    const ratio = required > 0 ? e.researchProgress[i]! / (required * FX_ONE) : 0;
    return {
      state: 'inProgress',
      reason: DisabledReason.None,
      detail: '研究中',
      lacking: [],
      progress: ratio < 0 ? 0 : ratio > 1 ? 1 : ratio,
    };
  }
  if (t.age > pl.age) {
    return {
      state: 'locked',
      reason: DisabledReason.Age,
      detail: `${AGE_NAMES[t.age] ?? '?'}で解禁される`,
      lacking: [],
      progress: 0,
    };
  }
  const missing = missingRequireNames(w, p, t);
  if (missing.length > 0) {
    return {
      state: 'locked',
      reason: DisabledReason.Age,
      detail: `前提「${missing.join('・')}」が未研究（飛び越せない）`,
      lacking: [],
      progress: 0,
    };
  }
  const bIdx = findResearchBuildingIndex(w, p, t);
  if (bIdx < 0) {
    return {
      state: 'locked',
      reason: DisabledReason.Age,
      detail: `${civBuildingName(w, p, t.at)}が無い（建てると開く）`,
      lacking: [],
      progress: 0,
    };
  }
  if (e.researchTech[bIdx] !== 0) {
    return {
      state: 'locked',
      reason: DisabledReason.Resource,
      detail: `${civBuildingName(w, p, t.at)}が別の研究中`,
      lacking: [],
      progress: 0,
    };
  }
  const lacking = resourceLackOf(w, p, techCostFx(w, p, t, buildingDef(e.typeId[bIdx]!).id));
  if (lacking.length > 0) {
    return {
      state: 'locked',
      reason: DisabledReason.Resource,
      detail: '資源が足りない',
      lacking,
      progress: 0,
    };
  }
  return { state: 'available', reason: DisabledReason.None, detail: '', lacking: [], progress: 0 };
}

/** その建物のその文明での呼び名（翰林院・大天幕・櫓）。 */
export function civBuildingName(w: World, p: PlayerId, buildingId: string): string {
  const pl = getPlayer(w, p);
  if (pl === undefined) return buildingDefById(buildingId).name;
  const resolved = resolveBuildingForCiv(pl.civ, buildingId);
  return buildingDefById(resolved ?? buildingId).name;
}

/** 学舎パネルの表示モデルを作る（DOM を触らない）。 */
export function buildTechPanelModel(
  w: World,
  viewer: PlayerId,
  activeTab: TechTabId
): TechPanelModel {
  const pl = getPlayer(w, viewer);
  const tabs: TechTabView[] = TECH_TAB_IDS.map((id) => {
    const buildings = tabBuildingIds(id);
    const techs = TECH_DEFS.filter(
      (t) => techTabOf(t) === id && (t.civ === null || (pl !== undefined && t.civ === pl.civ))
    );
    const has = buildings.some((b) => hasCompletedBuilding(w, viewer, b));
    const names = buildings.map((b) => civBuildingName(w, viewer, b));
    return {
      id,
      label: TAB_LABELS[id],
      enabled: has,
      detail: has ? '' : `${names.join('・')}を建てていない`,
      total: techs.length,
      researched:
        pl === undefined ? 0 : techs.filter((t) => pl.researched[t.index] === 1).length,
    };
  });

  const nodes: TechNodeView[] = [];
  for (const t of TECH_DEFS) {
    if (techTabOf(t) !== activeTab) continue;
    // 他文明の固有研究は「存在しない」ので並べない（暗くするのは**自分が持てないもの**だけ）。
    if (t.civ !== null && (pl === undefined || t.civ !== pl.civ)) continue;
    const v = judgeTech(w, viewer, t);
    const note = splitNote(TECH_NOTES[t.id] ?? '');
    const bId =
      pl === undefined ? t.at : (resolveBuildingForCiv(pl.civ, t.at) ?? t.at);
    nodes.push({
      id: t.id,
      name: t.name,
      ageIdx: t.age,
      ageName: AGE_NAMES[t.age] ?? '?',
      costText: costTextOf(techCostFx(w, viewer, t, bId)),
      timeText: `${Math.round(t.researchTicks / TICK_RATE)} 秒`,
      effectText: note.effect,
      sceneText: note.scene,
      lookText: lookTextOf(t),
      state: v.state,
      reason: v.reason,
      detail: v.detail,
      lacking: v.lacking,
      requires: t.requires,
      isRoot: t.requires.length === 0,
      progress: v.progress,
      atBuildingName: civBuildingName(w, viewer, t.at),
      command:
        v.state === 'available'
          ? researchCommandFor(w, viewer, t)
          : null,
    });
  }

  const columns: TechNodeView[][] = AGE_NAMES.map(() => []);
  for (const n of nodes) {
    const col = columns[n.ageIdx];
    if (col === undefined) continue;
    col.push(n);
  }

  const ids = new Set(nodes.map((n) => n.id));
  const edges: TechEdgeView[] = [];
  for (const n of nodes) {
    for (const req of n.requires) {
      if (!ids.has(req)) continue;
      const parent = nodes.find((x) => x.id === req);
      edges.push({
        from: req,
        to: n.id,
        satisfied: parent !== undefined && parent.state === 'researched',
      });
    }
  }

  const running = nodes.find((n) => n.state === 'inProgress');
  return {
    tabs,
    activeTab,
    columns,
    edges,
    runningLabel:
      running === undefined
        ? ''
        : `研究中: ${running.name}（${Math.round(running.progress * 100)}%）— 内政と戦闘は止まりません`,
  };
}

/** `research` Command を作る（研究できる建物を 1 つ選ぶ）。 */
function researchCommandFor(w: World, p: PlayerId, t: TechDef): Command | null {
  const i = findResearchBuildingIndex(w, p, t);
  if (i < 0) return null;
  const id = idOf(w, i);
  if (id === null) return null;
  return { t: 'research', p, building: id, tech: t.id };
}

function idOf(w: World, i: number): EntityId | null {
  if (i < 0 || i >= w.entities.highWater) return null;
  return idOfIndex(w.entities, i);
}

// ---------------------------------------------------------------- DOM（部品）

/** パネルが外に触るための窓口（World は読むだけ。変更は `emit` の Command 経由）。 */
export interface TechPanelContext {
  world(): World;
  readonly viewer: PlayerId;
  emit(cmd: Command): void;
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
 * 学舎（研究）パネル。対戦画面に重ねるオーバーレイで、**開いても試合は止まらない**。
 *
 * ```ts
 * const tech = new TechPanel(overlayEl, { world: () => w, viewer: 0, emit });
 * tech.toggle();      // `K` キー
 * tech.update();      // 毎フレーム（呼ぶ側が間引く）
 * ```
 */
export class TechPanel {
  readonly root: HTMLElement;
  private readonly ctx: TechPanelContext;
  private readonly tabsEl: HTMLElement;
  private readonly gridEl: HTMLElement;
  private readonly plateEl: HTMLElement;
  private readonly runningEl: HTMLElement;
  private tab: TechTabId = 'academy';
  private selected: string | null = null;
  private open = false;

  constructor(parent: HTMLElement, ctx: TechPanelContext) {
    this.ctx = ctx;
    this.root = el('div', 'mt-panel mt-tech mt-panel-hidden');

    const head = el('div', 'mt-panel-head');
    head.append(el('span', 'mt-panel-title', '学舎（研究）'));
    const close = el('button', 'mt-panel-close', '閉じる (K)');
    close.type = 'button';
    close.addEventListener('click', () => this.close());
    head.appendChild(close);

    this.tabsEl = el('div', 'mt-tech-tabs');
    this.gridEl = el('div', 'mt-tech-grid');
    this.plateEl = el('div', 'mt-tech-plate', 'メダルを選ぶと効果と、それが効く場面が出ます。');
    this.runningEl = el('div', 'mt-tech-running', '');

    this.root.append(head, this.tabsEl, this.gridEl, this.plateEl, this.runningEl);
    parent.appendChild(this.root);
  }

  get visible(): boolean {
    return this.open;
  }

  /** `K` キー / 学舎のボタンから。 */
  toggle(): void {
    if (this.open) this.close();
    else this.show();
  }

  show(): void {
    this.open = true;
    this.root.classList.remove('mt-panel-hidden');
    this.update();
  }

  close(): void {
    this.open = false;
    this.root.classList.add('mt-panel-hidden');
  }

  /** 表示を作り直す（閉じているときは何もしない = 試合の描画負荷を増やさない）。 */
  update(): void {
    if (!this.open) return;
    const model = buildTechPanelModel(this.ctx.world(), this.ctx.viewer, this.tab);

    // ---- 1 系統タブ（建てていない系統は暗く開けない） ----
    this.tabsEl.textContent = '';
    for (const t of model.tabs) {
      const b = el('button', 'mt-tech-tab', `${t.label}（${t.researched}/${t.total}）`);
      b.type = 'button';
      b.disabled = !t.enabled;
      b.classList.toggle('mt-tech-tab-locked', !t.enabled);
      b.classList.toggle('mt-tech-tab-active', t.id === model.activeTab);
      b.title = t.enabled ? t.label : `開けません: ${t.detail}`;
      b.addEventListener('click', () => {
        this.tab = t.id;
        this.selected = null;
        this.update();
      });
      this.tabsEl.appendChild(b);
    }

    // ---- 2〜6 メダルと前提線 ----
    this.gridEl.textContent = '';
    const activeTab = model.tabs.find((t) => t.id === model.activeTab);
    if (activeTab !== undefined && !activeTab.enabled) {
      this.gridEl.appendChild(el('div', 'mt-tech-empty', `${activeTab.detail}ので開けません`));
    }
    for (let age = 0; age < model.columns.length; age++) {
      const list = model.columns[age] ?? [];
      if (list.length === 0) continue;
      const col = el('div', 'mt-tech-col');
      col.appendChild(el('div', 'mt-tech-colhead', AGE_NAMES[age] ?? '?'));
      for (const n of list) {
        const medal = el('button', 'mt-tech-medal');
        medal.type = 'button';
        medal.classList.add(`mt-tech-${n.state}`);
        if (n.state === 'locked') medal.classList.add(lockClass(n.reason));
        medal.append(el('span', 'mt-tech-medal-name', n.name));
        medal.append(el('span', 'mt-tech-medal-cost', `${n.costText} / ${n.timeText}`));
        // 前提線: 親を持つメダルは左に線を引く（未了なら点線）
        if (!n.isRoot) {
          const edge = model.edges.find((x) => x.to === n.id);
          medal.classList.add(edge?.satisfied === true ? 'mt-tech-linked' : 'mt-tech-blocked');
          medal.append(
            el('span', 'mt-tech-req', `前提: ${n.requires.map((r) => nameOfTech(r)).join('・')}`)
          );
        }
        if (n.state === 'locked') medal.append(el('span', 'mt-tech-lock', lockGlyph(n.reason)));
        if (n.state === 'inProgress') {
          const bar = el('span', 'mt-tech-progress');
          bar.style.setProperty('--mt-ratio', `${Math.round(n.progress * 100)}%`);
          medal.appendChild(bar);
        }
        medal.title = titleOf(n);
        medal.addEventListener('click', () => {
          this.selected = n.id;
          // 4 研究可能なメダルはクリックで**即座に開始**（Command 経由）
          if (n.state === 'available' && n.command !== null) this.ctx.emit(n.command);
          this.update();
        });
        col.appendChild(medal);
      }
      this.gridEl.appendChild(col);
    }

    // ---- 7/8 説明プレート ----
    const sel =
      this.selected === null
        ? undefined
        : model.columns.flat().find((n) => n.id === this.selected);
    this.plateEl.textContent = '';
    if (sel === undefined) {
      this.plateEl.appendChild(
        el('div', 'mt-tech-plate-hint', 'メダルを選ぶと効果と、それが効く場面が出ます。')
      );
    } else {
      this.plateEl.append(
        el('div', 'mt-tech-plate-name', `${sel.name}（${sel.ageName} / ${sel.atBuildingName}）`),
        el('div', 'mt-tech-plate-effect', sel.effectText),
        el('div', 'mt-tech-plate-scene', sel.sceneText === '' ? '' : `効く場面: ${sel.sceneText}`),
        el('div', 'mt-tech-plate-look', sel.lookText === '' ? '' : `見え方: ${sel.lookText}`),
        el('div', 'mt-tech-plate-cost', `必要: ${sel.costText} / ${sel.timeText}`),
        el(
          'div',
          'mt-tech-plate-state',
          sel.state === 'locked' ? `${sel.reason}: ${sel.detail}` : stateLabel(sel.state)
        )
      );
    }

    this.runningEl.textContent = model.runningLabel;
  }

  destroy(): void {
    this.root.remove();
  }
}

function stateLabel(state: TechStateId): string {
  if (state === 'researched') return '研究済み（効果は累積）';
  if (state === 'inProgress') return '研究中（内政と戦闘は止まりません）';
  if (state === 'available') return '研究可能（クリックで開始）';
  return '';
}

function titleOf(n: TechNodeView): string {
  const head = `${n.name}（${n.costText} / ${n.timeText}）`;
  if (n.state === 'locked') return `${head}\n${n.reason}: ${n.detail}`;
  return `${head}\n${n.effectText}`;
}

function nameOfTech(id: string): string {
  const d = TECH_DEFS.find((t) => t.id === id);
  return d === undefined ? id : d.name;
}

/** 錠の記号（色に頼らない。`06§12`）。 */
export function lockGlyph(reason: DisabledReasonId): string {
  if (reason === DisabledReason.Civ) return '✖';
  if (reason === DisabledReason.Resource) return '△';
  return '🔒';
}

/** 錠の種別に対応する CSS クラス。 */
export function lockClass(reason: DisabledReasonId): string {
  if (reason === DisabledReason.Civ) return 'mt-lock-civ';
  if (reason === DisabledReason.Resource) return 'mt-lock-res';
  return 'mt-lock-age';
}
