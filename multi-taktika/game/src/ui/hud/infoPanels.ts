/**
 * ui/hud/infoPanels.ts — 情報パネル群（T-M12-13。`06§8` の 7 項目）
 *
 * | 操作 | すること |
 * |---|---|
 * | `L` | 戦績パネル（**相手の人口と時代の推定値**も出る） |
 * | `G` | 資源の残量を地形に重ねて表示（森・鉱脈の残りが色で分かる） |
 * | `N` | 時代進化の条件（**あと何が足りないかだけ**） |
 * | `Y` | 令の履歴（この試合で出した令。試合後のリプレイと同じ形式） |
 * | `Alt` 長押し | 全ユニットの体力バーと所属戦域の色 |
 * | 対象にカーソル | 性能と相性（**「この兵は何に強いか」が役割で出る**） |
 * | 暗いボタンにカーソル | できない理由 3 種（時代不足 / 資源不足 / その文明が持てない） |
 *
 * ■ `Alt` の兼任（`06§8`）
 *   `Alt`+ドラッグ / `Alt`+数字 / `Alt`+クリック のように**他の入力と組み合わせたときは
 *   修飾キーとして働き、情報表示は出さない**。トグル設定（`06§12`）にすれば兼任そのものが
 *   無くなるので、`shouldShowAltInfo` が 2 つのモードを 1 つの純関数で表している。
 *
 * ■ **どのパネルを開いても試合は止まらない**（`05§1`）。ここは DOM を書くだけで
 *   sim には何も送らない（World は読み取り専用。手順書 §3.1）。
 *
 * ■ `G` の「地形に重ねて表示」をどう出しているか（申し送り）
 *   地形タイルそのものを染めるのは `render/terrainLayer` のチャンクキャッシュの仕事で、
 *   `src/render/**` は担当外なので触れない。そこで **UI が自前の `<canvas>` を戦場の上に重ね**、
 *   `render/iso.tileToScreen`（読み取り専用の import。層の向き `render → ui` に沿う）で
 *   資源ノードの位置を投影し、**残量の比で色を変えた菱形**を描いている。
 *   タイルの染め分けが欲しくなったら、描画層に `resourceOverlayLayer.ts` を追加して
 *   この canvas を捨てるのが正しい（チャンクキャッシュを再利用できるため）。
 */

import '@/styles/result.css';

import {
  AGE_IDS,
  EntityKind,
  RESOURCE_COUNT,
  RESOURCE_IDS,
  type PlayerId,
} from '@/shared/types';
import { cfgAges } from '@/sim/core/config';
import { ROLE_IDS, buildingDef, counterMul, unitDef } from '@/sim/core/defs';
import { FX_ONE } from '@/sim/core/fx';
import { effectiveOrderOf } from '@/sim/core/front';
import { RESOURCE_NODE_DEFS, resourceNodeDef } from '@/sim/core/gather';
import { countCurrentAgeBuildingKinds, ageAdvanceCostFx } from '@/sim/systems/production';
import { MAX_FRONTS, frontIndex, getPlayer, type World } from '@/sim/core/world';
import type { Camera } from '@/render/iso';
import { tileToScreen } from '@/render/iso';
import {
  frontColor,
  frontShape,
  healthColor,
  playerColor,
  resourceColor,
  resourceGlyph,
} from '@/render/palette';
import type { VisionBuffer } from '@/render/vision';
import { DisabledReason, type DisabledReasonId } from './commandGrid';
import { fxToAmount, tickToClock, type MatchStatsSnapshot } from '../stats';

// ---------------------------------------------------------------------------
// パネルの種類とキー（`06§14` の「情報」区分）
// ---------------------------------------------------------------------------

/** 情報パネルの識別子。 */
export type InfoPanelId = 'score' | 'resources' | 'age' | 'orders';

/** パネル → 既定キーと見出し（キーは設定で再割り当て可。`06§12`）。 */
export const INFO_PANELS: readonly {
  readonly id: InfoPanelId;
  readonly key: string;
  readonly title: string;
}[] = [
  { id: 'score', key: 'L', title: '戦績' },
  { id: 'resources', key: 'G', title: '資源の残量' },
  { id: 'age', key: 'N', title: '時代進化の条件' },
  { id: 'orders', key: 'Y', title: '令の履歴' },
];

/**
 * 時代の表示名（`AGE_IDS` 順）。
 *
 * `config.json` の `ages[].name` に同じ文字列があるが、`cfgAges()` は `name` を
 * 公開していない（`sim/core/config.ts` は担当外なので触らない）。
 * **申し送り**: `AgeConfig` に `name` を足せばこの表は捨てられる。
 */
export const AGE_NAMES: readonly string[] = ['黎明の世', '青銅の世', '鉄器の世', '帝国の世'];

/** 時代の添字 → 表示名。 */
export function ageName(ageIdx: number): string {
  return AGE_NAMES[ageIdx] ?? AGE_IDS[ageIdx] ?? '?';
}

/** キー（大文字小文字どちらでも）→ パネル。該当しなければ null。 */
export function panelForKey(key: string): InfoPanelId | null {
  const up = key.toUpperCase();
  return INFO_PANELS.find((p) => p.key === up)?.id ?? null;
}

// ---------------------------------------------------------------------------
// `Alt` の情報表示（純関数。`06§8` の兼任規則と `06§12` のトグル設定）
// ---------------------------------------------------------------------------

/** `shouldShowAltInfo` の入力。 */
export interface AltInfoInput {
  /** `Alt` が押されているか。 */
  readonly altDown: boolean;
  /**
   * `Alt` と**同時に別の入力**が走っているか
   * （ドラッグ中 / 数字キー / クリック）。true なら `Alt` は修飾キーとして働く。
   */
  readonly otherInputActive: boolean;
  /** トグル設定（`06§12`「長押しを使わない設定」）。 */
  readonly toggleMode: boolean;
  /** トグル設定のときの現在の状態。 */
  readonly toggled: boolean;
}

/**
 * `Alt` の情報表示を出すか。
 *
 * - トグル設定 → 押した回数で決まる（`altDown` は見ない = **長押しが不要になる**）
 * - 長押し設定 → `Alt` 単独のときだけ。他の入力と組み合わせたら出さない（`06§8`）
 */
export function shouldShowAltInfo(i: AltInfoInput): boolean {
  if (i.toggleMode) return i.toggled;
  return i.altDown && !i.otherInputActive;
}

// ---------------------------------------------------------------------------
// `L` 戦績パネル（相手の人口と時代は**推定値**）
// ---------------------------------------------------------------------------

/** 戦績パネルの 1 行。 */
export interface ScoreRow {
  readonly player: PlayerId;
  readonly color: string;
  /** 自分（と味方）は実数、敵は推定値。 */
  readonly pop: number;
  readonly popCap: number;
  /** 時代（`AGE_IDS` の添字）。 */
  readonly age: number;
  readonly ageName: string;
  /** 立っている戦域の数（敵は見えている輪の数）。 */
  readonly fronts: number;
  /** true = 推定値（`?` 付きで出す）。 */
  readonly estimated: boolean;
  readonly defeated: boolean;
}

/**
 * 戦績パネルの行を作る（`06§8` の `L`）。
 *
 * **相手の人口と時代は推定値**。`07§7` の視界規則を守るため、
 * 敵については「今見えているもの」からしか数えない:
 *   - 人口 = 可視マスにいる敵ユニットの `pop` の合計（**見えていない兵は数えない**）
 *   - 時代 = 可視マスに見えた敵の建物・ユニットが必要とする時代の最大値
 * `vision` が null（観戦・リプレイの全開放）のときは全部が可視として扱われ、
 * 推定値ではなく実数になる。
 */
export function scoreRows(w: World, viewer: PlayerId, vision: VisionBuffer | null): ScoreRow[] {
  const e = w.entities;
  const out: ScoreRow[] = [];

  // 敵の推定値をまとめる作業配列（index 昇順の 1 パスで数える）。
  const estPop = new Int32Array(w.playerCount);
  const estAge = new Int32Array(w.playerCount);
  for (let i = 0; i < e.highWater; i++) {
    if (e.alive[i] !== 1) continue;
    const owner = e.owner[i]!;
    if (owner >= w.playerCount) continue;
    const kind = e.kind[i]!;
    if (kind !== EntityKind.Unit && kind !== EntityKind.Building) continue;
    if (vision !== null) {
      const tx = Math.floor(e.x[i]! / FX_ONE);
      const ty = Math.floor(e.y[i]! / FX_ONE);
      if (!vision.isVisible(tx, ty)) continue;
    }
    if (kind === EntityKind.Unit) {
      const d = unitDef(e.typeId[i]!);
      estPop[owner] = estPop[owner]! + d.pop;
      if (d.age > estAge[owner]!) estAge[owner] = d.age;
    } else {
      const d = buildingDef(e.typeId[i]!);
      if (d.age > estAge[owner]!) estAge[owner] = d.age;
    }
  }

  for (let p = 0; p < w.playerCount; p++) {
    const pl = w.players[p]!;
    const own = p === viewer || w.teams[p] === w.teams[viewer];
    let fronts = 0;
    for (let slot = 1; slot <= MAX_FRONTS; slot++) {
      if (w.fronts[frontIndex(p as PlayerId, slot)]?.active === true) fronts++;
    }
    const age = own ? pl.age : estAge[p]!;
    out.push({
      player: p as PlayerId,
      color: playerColor(p),
      pop: own ? pl.pop : estPop[p]!,
      popCap: own ? pl.popCap : 0,
      age,
      ageName: ageName(age),
      fronts,
      estimated: !own && vision !== null,
      defeated: pl.defeated,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// `N` 時代進化の条件（**あと何が足りないかだけ**）
// ---------------------------------------------------------------------------

/** 足りないもの 1 件。 */
export interface AgeRequirement {
  /** 何が足りないか（'resource' | 'buildings'）。 */
  readonly kind: 'resource' | 'buildings';
  /** 表示ラベル。 */
  readonly label: string
  /** あとどれだけ足りないか（整数量 / 種類数）。 */
  readonly missing: number;
}

/** `N` パネルの内容。 */
export interface AgeAdvanceInfo {
  /** 次の時代（`AGE_IDS` の添字。-1 = もう最終時代）。 */
  readonly nextAge: number;
  readonly nextAgeName: string;
  /** **足りないものだけ**。空 = いま進化できる。 */
  readonly missing: readonly AgeRequirement[];
}

/**
 * 時代進化の条件を「**あと何が足りないかだけ**」で返す（`06§8` の `N`）。
 *
 * 満たしている条件は返さない。全部並べると「あと何が要るのか」を探す作業が発生し、
 * このパネルの目的（一目で分かる）が消える。
 */
export function ageAdvanceInfo(w: World, p: PlayerId): AgeAdvanceInfo {
  const pl = getPlayer(w, p);
  const ages = cfgAges();
  if (pl === undefined || pl.age + 1 >= ages.length) {
    return { nextAge: -1, nextAgeName: '—', missing: [] };
  }
  const next = pl.age + 1;
  const a = ages[next]!;
  const missing: AgeRequirement[] = [];

  const cost = ageAdvanceCostFx(next);
  for (let r = 0; r < RESOURCE_COUNT; r++) {
    const need = cost[r]!;
    if (need <= 0) continue;
    const have = pl.resources[r]!;
    if (have >= need) continue;
    missing.push({
      kind: 'resource',
      label: `${resourceGlyph(r)}（${RESOURCE_IDS[r] ?? ''}）`,
      missing: fxToAmount(need - have),
    });
  }

  const needKinds = a.requireBuildingsOfPrevAge;
  const haveKinds = countCurrentAgeBuildingKinds(w, p);
  if (haveKinds < needKinds) {
    missing.push({
      kind: 'buildings',
      label: '今の世の建物の種類',
      missing: needKinds - haveKinds,
    });
  }
  return { nextAge: next, nextAgeName: ageName(next), missing };
}

// ---------------------------------------------------------------------------
// `Y` 令の履歴（試合後のリプレイと同じ形式）
// ---------------------------------------------------------------------------

/** 令の履歴 1 行（表示用の文字列まで作る）。 */
export interface OrderHistoryLine {
  readonly slot: number;
  readonly slotColor: string;
  readonly slotShape: string;
  readonly name: string;
  /** 「出した 3:20 → 届いた 3:24」。**遅延を隠さない**（手順書 §16-4）。 */
  readonly text: string;
}

/**
 * 令の履歴（`06§8` の `Y`。「試合後のリプレイと同じ形式」）。
 *
 * 出した時刻と届いた時刻を**両方**出す。片方だけにすると
 * 「押した瞬間に効かない」というこのゲームの肝が UI から消える。
 * 新しいものが上に来るよう `issuedTick` 降順で返す。
 */
export function orderHistoryLines(
  stats: MatchStatsSnapshot | null,
  viewer: PlayerId,
  limit = 40,
): OrderHistoryLine[] {
  const st = stats?.players.find((s) => s.player === viewer);
  if (st === undefined) return [];
  const rows = [...st.orderLog].sort((a, b) => b.issuedTick - a.issuedTick).slice(0, limit);
  return rows.map((r) => {
    const delivered =
      r.deliveredTick >= 0 ? `届いた ${tickToClock(r.deliveredTick)}` : '未着（試合終了）';
    return {
      slot: r.slot,
      slotColor: frontColor(r.slot),
      slotShape: frontShape(r.slot),
      name: r.orderId,
      text: `出した ${tickToClock(r.issuedTick)} → ${delivered}`,
    };
  });
}

// ---------------------------------------------------------------------------
// `G` 資源の残量
// ---------------------------------------------------------------------------

/** 資源ノード 1 個の残量（オーバーレイと一覧で共通）。 */
export interface ResourceNodeView {
  /** マップ座標（マス、小数）。 */
  readonly x: number;
  readonly y: number;
  /** 資源 index（`RESOURCE_IDS` 順）。 */
  readonly resource: number;
  /** 残量（整数量）。 */
  readonly remaining: number;
  /** 残量の比（0..1）。色の濃さに使う。 */
  readonly ratio: number;
}

/** 資源ごとの残量の合計（`G` の一覧側）。 */
export interface ResourceRemainingRow {
  readonly resource: number;
  readonly glyph: string;
  readonly nodes: number;
  readonly remaining: number;
}

/**
 * 見えている資源ノードを集める（`06§8` の `G`）。
 *
 * `vision` が渡されたときは**一度でも見たマス**（既知）のノードだけを返す。
 * 未探索の場所の埋蔵量を出すと `07§7` の視界規則が壊れる。
 */
export function resourceNodeViews(w: World, vision: VisionBuffer | null): ResourceNodeView[] {
  const e = w.entities;
  const out: ResourceNodeView[] = [];
  for (let i = 0; i < e.highWater; i++) {
    if (e.alive[i] !== 1) continue;
    if (e.kind[i] !== EntityKind.Resource) continue;
    const tx = Math.floor(e.x[i]! / FX_ONE);
    const ty = Math.floor(e.y[i]! / FX_ONE);
    if (vision !== null && !vision.isExplored(tx, ty)) continue;
    const def = resourceNodeDef(e.typeId[i]!);
    const full = def.deposit > 0 ? def.deposit : 1;
    const remain = e.amount[i]!;
    out.push({
      x: e.x[i]! / FX_ONE,
      y: e.y[i]! / FX_ONE,
      resource: def.resource,
      remaining: fxToAmount(remain),
      ratio: clamp01(remain / full),
    });
  }
  return out;
}

/** 資源ごとの残量の合計（ノード数と総量）。`RESOURCE_IDS` 順で常に 4 行返す。 */
export function resourceRemainingRows(views: readonly ResourceNodeView[]): ResourceRemainingRow[] {
  const nodes = new Int32Array(RESOURCE_COUNT);
  const remaining = new Float64Array(RESOURCE_COUNT);
  for (const v of views) {
    if (v.resource < 0 || v.resource >= RESOURCE_COUNT) continue;
    nodes[v.resource] = nodes[v.resource]! + 1;
    remaining[v.resource] = remaining[v.resource]! + v.remaining;
  }
  const out: ResourceRemainingRow[] = [];
  for (let r = 0; r < RESOURCE_COUNT; r++) {
    out.push({
      resource: r,
      glyph: resourceGlyph(r),
      nodes: nodes[r]!,
      remaining: Math.round(remaining[r]!),
    });
  }
  return out;
}

/**
 * 残量の比 → 色（**色以外の手がかりも要る**ので、濃さと大きさの両方で示す）。
 * 満杯 = 資源色そのまま、枯れかけ = 灰に寄せる。
 */
export function remainingColor(resource: number, ratio: number): string {
  // 色そのものは `render/palette` が唯一の出所（ここで色リテラルを作らない）。
  // 残量は**透明度と大きさ**で表す（色の意味を増やすと `05§15` の一貫性が崩れる）。
  const a = 0.25 + 0.65 * clamp01(ratio);
  return withAlpha(resourceColor(resource), a);
}

function withAlpha(hex: string, a: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (m === null) return hex;
  const v = parseInt(m[1]!, 16);
  const r = (v >> 16) & 0xff;
  const g = (v >> 8) & 0xff;
  const b = v & 0xff;
  return `rgba(${r},${g},${b},${Math.round(a * 100) / 100})`;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

// ---------------------------------------------------------------------------
// カーソルを乗せたときの説明
// ---------------------------------------------------------------------------

/** 役割 → 表示名（`03§7` の相性表の行と同じ並び）。 */
export const ROLE_NAMES: Readonly<Record<string, string>> = {
  spear: '槍',
  sword: '刀剣',
  ranged: '遠隔',
  cavalry: '騎兵',
  camel: '駱駝騎兵',
  beast: '獣兵',
  siege: '攻城',
  gunpowder: '火器',
  ship: '船',
  villager: '村人',
  support: '支援',
  building: '建物',
};

/** 役割名（未知はそのまま）。 */
export function roleName(role: string): string {
  return ROLE_NAMES[role] ?? role;
}

/** 相性の説明。 */
export interface MatchupText {
  readonly name: string;
  readonly role: string;
  /** 「体 120 / 攻 12 / 射程 4」など。 */
  readonly stats: string;
  /** 強い相手（役割名）。 */
  readonly strongAgainst: readonly string[];
  /** 弱い相手（役割名）。 */
  readonly weakAgainst: readonly string[];
  /** 1 行の要約（ツールチップ本文）。 */
  readonly summary: string;
}

/**
 * 「この兵は何に強いか」を**役割で**出す（`06§8`）。
 *
 * 相性は `config.counterMatrix` から作った `counterMul` を引くだけ
 * （表を UI 側に書き写すと、バランス調整のときに 2 か所直すことになる）。
 */
export function unitMatchup(typeId: number): MatchupText {
  const d = unitDef(typeId);
  const strong: string[] = [];
  const weak: string[] = [];
  for (let r = 0; r < ROLE_IDS.length; r++) {
    const mul = counterMul(d.roleIdx, r);
    if (mul > FX_ONE) strong.push(roleName(ROLE_IDS[r]!));
    else if (mul < FX_ONE) weak.push(roleName(ROLE_IDS[r]!));
  }
  const stats = [
    `体 ${fxToAmount(d.hp)}`,
    `攻 ${fxToAmount(d.atk)}`,
    d.range > 0 ? `射程 ${Math.round((d.range / FX_ONE) * 10) / 10}` : '近接',
  ].join(' / ');
  const summary =
    (strong.length > 0 ? `強い: ${strong.join('・')}` : '相性の得手なし') +
    (weak.length > 0 ? ` / 弱い: ${weak.join('・')}` : '');
  return {
    name: d.name,
    role: roleName(d.role),
    stats,
    strongAgainst: strong,
    weakAgainst: weak,
    summary,
  };
}

/**
 * 暗いボタンの理由（`05§15` / `06§8` の 3 種）。
 * `commandGrid.DisabledReason` の文言をそのまま使い、**言い方を UI ごとに増やさない**。
 */
export function disabledReasonDetail(reason: DisabledReasonId, lacking: readonly number[] = []): string {
  switch (reason) {
    case DisabledReason.Age:
      return '時代が足りない（先に時代進化）';
    case DisabledReason.Resource: {
      if (lacking.length === 0) return '資源が足りない';
      const names = lacking.map((r) => resourceGlyph(r)).join('・');
      return `資源が足りない（${names}）`;
    }
    case DisabledReason.Civ:
      return 'この文明は持てない（文明制限）';
    default:
      return '';
  }
}

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

/** 情報パネル群が外を見るための窓口。**World は読むだけ**。 */
export interface InfoPanelsContext {
  world(): World;
  readonly viewer: PlayerId;
  /** 霧（null = 全開放。観戦・リプレイ）。 */
  vision?(): VisionBuffer | null;
  /** 描画カメラ（`G` と `Alt` のオーバーレイに使う。無ければ一覧表示だけ）。 */
  camera?(): Camera | null;
  /** 統計（`Y` の令の履歴）。 */
  stats?(): MatchStatsSnapshot | null;
  /** `Alt` の情報表示をトグルにする設定（`06§12`）。 */
  altToggleMode?(): boolean;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** 更新間隔（ms）。毎フレーム DOM を作り直さない。 */
const REFRESH_MS = 150;

/**
 * 情報パネル群。対戦画面の上に重ねる 1 枚のレイヤ。
 *
 * 使い方（親が結線する）:
 * ```ts
 * const info = new InfoPanels(overlay, ctx);
 * // キー入力: info.onKeyDown('L', mods) が true を返したら preventDefault
 * // 毎フレーム: info.frame(nowMs)
 * // 描画層に渡す: info.altInfoActive()
 * ```
 */
export class InfoPanels {
  private readonly ctx: InfoPanelsContext;
  private readonly root: HTMLElement;
  private readonly panels = new Map<InfoPanelId, HTMLElement>();
  private readonly bodies = new Map<InfoPanelId, HTMLElement>();
  private readonly open = new Set<InfoPanelId>();
  private readonly canvas: HTMLCanvasElement;
  private readonly tooltip: HTMLElement;
  private readonly altBadge: HTMLElement;

  private altDown = false;
  private altToggled = false;
  private otherInputActive = false;
  private lastRefreshMs = -1;

  constructor(overlay: HTMLElement, ctx: InfoPanelsContext) {
    this.ctx = ctx;
    this.root = el('div', 'mt-info-layer');

    // `G` / `Alt` のオーバーレイ（戦場の上に重ねる UI 所有の canvas）
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'mt-res-overlay';
    this.canvas.hidden = true;
    this.root.appendChild(this.canvas);

    for (const p of INFO_PANELS) {
      const panel = el('div', 'mt-info-panel');
      panel.hidden = true;
      const head = el('div', 'mt-info-head');
      head.appendChild(el('span', 'mt-info-title', p.title));
      head.appendChild(el('span', 'mt-info-key', `${p.key} で開閉 / Esc で閉じる`));
      panel.appendChild(head);
      const body = el('div');
      panel.appendChild(body);
      this.panels.set(p.id, panel);
      this.bodies.set(p.id, body);
      this.root.appendChild(panel);
    }

    this.altBadge = el('div', 'mt-alt-badge', '全体表示中（体力バーと戦域色）');
    this.altBadge.hidden = true;
    this.root.appendChild(this.altBadge);

    this.tooltip = el('div', 'mt-tooltip');
    this.tooltip.hidden = true;
    this.root.appendChild(this.tooltip);

    overlay.appendChild(this.root);
  }

  /** レイヤを外す。 */
  destroy(): void {
    this.root.remove();
  }

  // ---------------------------------------------------------------- 開閉

  isOpen(id: InfoPanelId): boolean {
    return this.open.has(id);
  }

  /** 開いているパネルの数（`Esc` の段位判定に使う）。 */
  openCount(): number {
    return this.open.size;
  }

  toggle(id: InfoPanelId): void {
    if (this.open.has(id)) this.open.delete(id);
    else this.open.add(id);
    this.layout();
    this.refresh(true);
  }

  /**
   * 開いているパネルを 1 枚閉じる（`Esc` の①「パネルを閉じる」）。
   * 閉じるものが無ければ false（`Esc` の次の段に譲る）。
   */
  closeTop(): boolean {
    const last = [...this.open].pop();
    if (last === undefined) return false;
    this.open.delete(last);
    this.layout();
    return true;
  }

  /**
   * キー入力。**戻り値 true なら既定動作を止める**。
   * `L` / `G` / `N` / `Y` と `Alt` だけを見る（他は `input/keys.ts` の担当）。
   */
  onKeyDown(key: string, mods: { shift: boolean; ctrl: boolean; alt: boolean }): boolean {
    if (key === 'Alt') {
      this.setAltDown(true);
      return false; // 修飾キーなので既定動作は止めない
    }
    if (mods.ctrl || mods.shift) return false;
    const id = panelForKey(key);
    if (id === null) return false;
    // `Alt`+文字は修飾キーとしての組み合わせなので、パネルは開かない（`06§8`）。
    if (mods.alt) {
      this.otherInputActive = true;
      return false;
    }
    this.toggle(id);
    return true;
  }

  /** キーを離した。 */
  onKeyUp(key: string): void {
    if (key === 'Alt') this.setAltDown(false);
  }

  /** `Alt` の押下状態。トグル設定のときは「押した瞬間に切り替え」になる。 */
  setAltDown(down: boolean): void {
    const wasDown = this.altDown;
    this.altDown = down;
    if (down && !wasDown) {
      if (this.ctx.altToggleMode?.() === true) this.altToggled = !this.altToggled;
      this.otherInputActive = false;
    }
    if (!down) this.otherInputActive = false;
    this.updateAltBadge();
  }

  /**
   * `Alt` と組み合わせて別の入力が走ったことを伝える
   * （ドラッグ開始・クリック・数字キー）。以後、離すまで情報表示は出さない（`06§8`）。
   */
  markOtherInput(): void {
    if (this.altDown) this.otherInputActive = true;
    this.updateAltBadge();
  }

  /** `Alt` の情報表示が効いているか（描画層に渡す値）。 */
  altInfoActive(): boolean {
    return shouldShowAltInfo({
      altDown: this.altDown,
      otherInputActive: this.otherInputActive,
      toggleMode: this.ctx.altToggleMode?.() === true,
      toggled: this.altToggled,
    });
  }

  private updateAltBadge(): void {
    this.altBadge.hidden = !this.altInfoActive();
  }

  // ---------------------------------------------------------------- ツールチップ

  /** 対象の説明を出す（ユニットの性能と相性）。 */
  showUnitTooltip(px: number, py: number, typeId: number): void {
    const m = unitMatchup(typeId);
    this.tooltip.textContent = '';
    this.tooltip.appendChild(el('div', undefined, `${m.name}（${m.role}）`));
    this.tooltip.appendChild(el('div', 'mt-dim', m.stats));
    this.tooltip.appendChild(el('div', undefined, m.summary));
    this.placeTooltip(px, py);
  }

  /** 暗いボタンの理由を出す（3 種）。 */
  showReasonTooltip(
    px: number,
    py: number,
    reason: DisabledReasonId,
    lacking: readonly number[] = [],
  ): void {
    const text = disabledReasonDetail(reason, lacking);
    if (text === '') {
      this.hideTooltip();
      return;
    }
    this.tooltip.textContent = text;
    this.placeTooltip(px, py);
  }

  hideTooltip(): void {
    this.tooltip.hidden = true;
  }

  private placeTooltip(px: number, py: number): void {
    this.tooltip.hidden = false;
    // 左右の余白 20px を割らない（規約）。
    const w = this.root.clientWidth;
    const x = Math.min(Math.max(px + 12, 20), Math.max(20, w - 20 - 320));
    this.tooltip.style.left = `${x}px`;
    this.tooltip.style.top = `${Math.max(20, py + 12)}px`;
  }

  // ---------------------------------------------------------------- 更新

  /** 毎フレーム呼ぶ。中身の作り直しは `REFRESH_MS` ごと。 */
  frame(nowMs: number): void {
    if (this.lastRefreshMs < 0 || nowMs - this.lastRefreshMs >= REFRESH_MS) {
      this.lastRefreshMs = nowMs;
      this.refresh(false);
    }
    this.drawOverlay();
  }

  private layout(): void {
    let top = 96;
    for (const p of INFO_PANELS) {
      const node = this.panels.get(p.id)!;
      const open = this.open.has(p.id);
      node.hidden = !open;
      if (!open) continue;
      // 開いているパネルを縦に積む（HUD の上端左・右端・下端を塞がない位置）。
      node.style.top = `${top}px`;
      top += 40;
    }
    this.canvas.hidden = !(this.open.has('resources') || this.altInfoActive());
  }

  private refresh(force: boolean): void {
    if (!force && this.open.size === 0) return;
    const w = this.ctx.world();
    const vision = this.ctx.vision?.() ?? null;
    if (this.open.has('score')) this.renderScore(w, vision);
    if (this.open.has('resources')) this.renderResources(w, vision);
    if (this.open.has('age')) this.renderAge(w);
    if (this.open.has('orders')) this.renderOrders();
  }

  private renderScore(w: World, vision: VisionBuffer | null): void {
    const body = this.bodies.get('score')!;
    body.textContent = '';
    for (const r of scoreRows(w, this.ctx.viewer, vision)) {
      const row = el('div', 'mt-info-row');
      const left = el('span');
      const sw = el('span', 'mt-side-swatch');
      sw.style.background = r.color;
      sw.style.display = 'inline-block';
      sw.style.marginRight = '6px';
      left.appendChild(sw);
      left.appendChild(
        el('span', undefined, `P${r.player + 1}${r.defeated ? '（敗北）' : ''}`),
      );
      row.appendChild(left);
      const q = r.estimated ? '?' : '';
      const pop = r.popCap > 0 ? `${r.pop}/${r.popCap}` : `${r.pop}${q}`;
      const right = el('span', r.estimated ? 'mt-info-est mt-num' : 'mt-num');
      right.textContent = `人口 ${pop}　${r.ageName}${q}　戦域 ${r.fronts}`;
      row.appendChild(right);
      body.appendChild(row);
    }
    body.appendChild(
      el('div', 'mt-info-est', '「?」は推定値（見えている範囲から数えたもの）。'),
    );
  }

  private renderResources(w: World, vision: VisionBuffer | null): void {
    const body = this.bodies.get('resources')!;
    body.textContent = '';
    const views = resourceNodeViews(w, vision);
    for (const r of resourceRemainingRows(views)) {
      const row = el('div', 'mt-info-row');
      row.appendChild(el('span', undefined, `${r.glyph} ${RESOURCE_IDS[r.resource] ?? ''}`));
      row.appendChild(el('span', 'mt-num', `${r.nodes} 箇所 / 残り ${r.remaining}`));
      body.appendChild(row);
    }
    body.appendChild(
      el('div', 'mt-info-est', '戦場では残量の多いところが濃く出る（薄いほど枯れかけ）。'),
    );
  }

  private renderAge(w: World): void {
    const body = this.bodies.get('age')!;
    body.textContent = '';
    const info = ageAdvanceInfo(w, this.ctx.viewer);
    if (info.nextAge < 0) {
      body.appendChild(el('div', undefined, '最終時代（これ以上進化しない）'));
      return;
    }
    body.appendChild(el('div', 'mt-info-title', `次: ${info.nextAgeName}`));
    if (info.missing.length === 0) {
      body.appendChild(el('div', undefined, 'いま進化できる（町の中心 / 城で解読を始める）'));
      return;
    }
    for (const m of info.missing) {
      const row = el('div', 'mt-info-row');
      row.appendChild(el('span', undefined, `あと ${m.label}`));
      row.appendChild(el('span', 'mt-num', m.kind === 'buildings' ? `${m.missing} 種類` : `${m.missing}`));
      body.appendChild(row);
    }
  }

  private renderOrders(): void {
    const body = this.bodies.get('orders')!;
    body.textContent = '';
    const lines = orderHistoryLines(this.ctx.stats?.() ?? null, this.ctx.viewer);
    if (lines.length === 0) {
      body.appendChild(el('div', 'mt-dim', 'まだ令を出していない'));
      return;
    }
    for (const l of lines) {
      const row = el('div', 'mt-info-row');
      const left = el('span');
      const flag = el('span', undefined, `${l.slotShape}${l.slot} `);
      flag.style.color = l.slotColor;
      left.appendChild(flag);
      left.appendChild(el('span', undefined, l.name));
      row.appendChild(left);
      row.appendChild(el('span', 'mt-num mt-dim', l.text));
      body.appendChild(row);
    }
  }

  // ---------------------------------------------------------------- canvas

  /**
   * `G` の残量オーバーレイと `Alt` の全体表示を描く。
   *
   * どちらも「戦場の上に重ねる」表示なので 1 枚の canvas にまとめている
   * （canvas を 2 枚重ねると合成コストが 2 倍になる）。
   */
  private drawOverlay(): void {
    const showRes = this.open.has('resources');
    const showAlt = this.altInfoActive();
    this.canvas.hidden = !(showRes || showAlt);
    if (this.canvas.hidden) return;

    const cam = this.ctx.camera?.() ?? null;
    if (cam === null) return;
    const wpx = Math.max(1, Math.floor(cam.viewW));
    const hpx = Math.max(1, Math.floor(cam.viewH));
    if (this.canvas.width !== wpx) this.canvas.width = wpx;
    if (this.canvas.height !== hpx) this.canvas.height = hpx;
    const g = this.canvas.getContext('2d');
    if (g === null) return;
    g.clearRect(0, 0, wpx, hpx);

    const w = this.ctx.world();
    const vision = this.ctx.vision?.() ?? null;

    if (showRes) {
      for (const v of resourceNodeViews(w, vision)) {
        const s = tileToScreen(cam, v.x, v.y);
        if (s.sx < -40 || s.sy < -40 || s.sx > wpx + 40 || s.sy > hpx + 40) continue;
        const rr = 6 + 8 * v.ratio;
        g.fillStyle = remainingColor(v.resource, v.ratio);
        g.beginPath();
        g.moveTo(s.sx, s.sy - rr / 2);
        g.lineTo(s.sx + rr, s.sy);
        g.lineTo(s.sx, s.sy + rr / 2);
        g.lineTo(s.sx - rr, s.sy);
        g.closePath();
        g.fill();
      }
    }

    if (showAlt) this.drawAltInfo(g, cam, w, vision, wpx, hpx);
  }

  /**
   * `Alt` の全体表示（`06§8`）: 全ユニットの体力バーと所属戦域の色。
   *
   * **申し送り**: 本来は `render/spriteLayer` が「全部の体力バーを出す」入力を
   * 受け取るのが筋（Y ソート済みの反復を再利用できる）。担当外のため UI 側で描いている。
   */
  private drawAltInfo(
    g: CanvasRenderingContext2D,
    cam: Camera,
    w: World,
    vision: VisionBuffer | null,
    wpx: number,
    hpx: number,
  ): void {
    const e = w.entities;
    for (let i = 0; i < e.highWater; i++) {
      if (e.alive[i] !== 1) continue;
      if (e.kind[i] !== EntityKind.Unit) continue;
      const tx = Math.floor(e.x[i]! / FX_ONE);
      const ty = Math.floor(e.y[i]! / FX_ONE);
      if (vision !== null && !vision.isVisible(tx, ty)) continue;
      const s = tileToScreen(cam, e.x[i]! / FX_ONE, e.y[i]! / FX_ONE);
      if (s.sx < -20 || s.sy < -20 || s.sx > wpx + 20 || s.sy > hpx + 20) continue;

      // 体力バー（緑 → 黄 → 赤。`05§15`）
      const max = e.hpMax[i]! > 0 ? e.hpMax[i]! : 1;
      const ratio = clamp01(e.hp[i]! / max);
      const bw = 18;
      const bx = s.sx - bw / 2;
      const by = s.sy - 26;
      g.fillStyle = 'rgba(0,0,0,0.55)';
      g.fillRect(bx, by, bw, 3);
      g.fillStyle = healthColor(ratio);
      g.fillRect(bx, by, bw * ratio, 3);

      // 所属戦域の色（色 + 形 + 番号の 3 重。`06§12`）
      const slot = e.frontId[i]!;
      if (slot >= 1 && slot <= MAX_FRONTS) {
        g.fillStyle = frontColor(slot);
        g.font = '10px sans-serif';
        g.textAlign = 'center';
        g.fillText(`${frontShape(slot)}${slot}`, s.sx, by - 2);
      }
    }
  }

  /** 効いている令（デバッグと目視確認のため公開。DOM を触らない）。 */
  effectiveOrders(): (string | null)[] {
    const w = this.ctx.world();
    const out: (string | null)[] = [];
    for (let slot = 1; slot <= MAX_FRONTS; slot++) {
      const f = w.fronts[frontIndex(this.ctx.viewer, slot)];
      out.push(f !== undefined && f.active ? effectiveOrderOf(f) : null);
    }
    return out;
  }
}

/** 資源ノードの定義数（テストの前提確認用）。 */
export const RESOURCE_NODE_KINDS = RESOURCE_NODE_DEFS.length;
