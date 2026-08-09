/**
 * ui/hud/frontCommandView.ts — 戦域指令ビュー（T-M12-03。`05§7` の 8 項目 / `06§1` / `07§7`）
 *
 * ■ 何をする画面か（`05§7`）
 *  「本作の中核画面です。キー 1 つで対戦画面から切り替わり、**全戦線を一枚に俯瞰**します。
 *   ここでやることは操作ではなく判断だけ ―― どの戦域を捨て、どの戦域に増援を送るかです。」
 *
 * ■ `05§7` の 8 項目との対応（実装箇所）
 *  1 戦域（赤）      … 自軍の輪。**輪の太さが優勢・劣勢**（`ringLineWidth`）
 *  2 戦域（青）      … 同時に最大 6 つ（`MAX_FRONTS`）。色 + 形 + 番号の 3 重表示（`06§12`）
 *  3 戦域（黄）      … `isFrontWarning` で**輪が点滅**（`warnings.ts` の `blinkAlpha` と同位相）
 *  4 本陣            … `homeCampX/Y`。動かない。城・大天幕も発信点として小さく描く
 *  5 令の伝達線      … 本陣 → 各戦域の点線。伝達中は**流れ**、届いた瞬間に**実線**
 *  6 令スロット      … 各戦域のチップに 1 枚（二重旗なら上下 2 段）
 *  7 空きスロット    … 右の一覧。**枠が余っていても戦域が立っていなければ使えない**
 *  8 敵拠点          … 既知の敵の町の中心・城・大天幕（攻め込む先）
 *
 * ■ 敵の情報を漏らさない（`07§7` / 手順書 §16-5）
 *  敵の戦域は `visibleEnemyFronts()` が返す `FrontRing`（owner / slot / x / y / radius）
 *  **だけ**を描く。この型には兵種・数・令・優勢度が入っていないので、
 *  「囮」（少数の兵で戦域を立てて攻められていると誤認させる）が壊れない。
 *  `w.fronts` を直接読まないこと。ここが唯一の防波堤である。
 *  敵拠点は「既知（一度見た）建物の形」だけを使う（体力も中身も出さない）。
 *
 * ■ 試合は止まらない（手順書 §8）
 *  これは Screen ではなく HUD の**オーバーレイ**。開いている間もシムが進む。
 *
 * ■ 層の約束（手順書 §3.1 / §16-4）
 *  World は読むだけ。令をセットするのは `orderCards.ts` の `setOrderCommand`（= Command）だけで、
 *  遅延を UI 側で先行反映しない。
 *
 * ■ テスト方針
 *  座標変換・輪の太さ・伝達線の状態・当たり判定を DOM の外に出し、
 *  `tests/unit/ui.frontCommand.test.ts` がそこを検算する。canvas / DOM は目視確認（`V`）。
 */

import { EntityKind, NEUTRAL_OWNER, type PlayerId } from '@/shared/types';
import type { Command } from '@/sim/command';
import { buildingDef, buildingIndex, orderDefById } from '@/sim/core/defs';
import { FX_ONE } from '@/sim/core/fx';
import {
  effectiveOrderOf,
  isFrontWarning,
  ownFronts,
  visibleEnemyFronts,
  type FrontRing,
} from '@/sim/core/front';
import { homeCampX, homeCampY, isOrderSourceIndex } from '@/sim/core/order';
import { MAX_FRONTS, areAllies, getPlayer, type Front, type World } from '@/sim/core/world';
import { GOLD, frontColor, frontShape, playerColor } from '@/render/palette';
import { VisionState, type VisionBuffer } from '@/render/vision';
import { OrderPendingTracker, hasDoubleFlag } from './orderCards';
import { blinkAlpha, blinkPeriodMs } from './warnings';

// ---------------------------------------------------------------- 純関数: 配置

/** 俯瞰図を収める矩形（px）。 */
export interface ViewBox {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/**
 * 表示領域にマップ全体を**縦横比を保って**収める矩形を返す。
 *
 * 幅は固定しない（ウィンドウを広げたら領域も広がる。手順書 §8.2）。
 * `padPx` は左右の余白 20px を渡す想定。
 */
export function fitMapBox(
  viewW: number,
  viewH: number,
  mapW: number,
  mapH: number,
  padPx: number,
): ViewBox {
  const availW = Math.max(1, viewW - padPx * 2);
  const availH = Math.max(1, viewH - padPx * 2);
  if (mapW <= 0 || mapH <= 0) return { x: padPx, y: padPx, w: availW, h: availH };
  const scale = Math.min(availW / mapW, availH / mapH);
  const w = mapW * scale;
  const h = mapH * scale;
  return { x: padPx + (availW - w) / 2, y: padPx + (availH - h) / 2, w, h };
}

/** マス座標 → 俯瞰図の px 座標。 */
export function projectTile(
  box: ViewBox,
  mapW: number,
  mapH: number,
  tx: number,
  ty: number,
): { x: number; y: number } {
  if (mapW <= 0 || mapH <= 0) return { x: box.x, y: box.y };
  return { x: box.x + (tx / mapW) * box.w, y: box.y + (ty / mapH) * box.h };
}

/** マス単位の半径 → px（縦横のスケールが違う場合は小さい方に合わせる）。 */
export function projectRadius(box: ViewBox, mapW: number, mapH: number, rTiles: number): number {
  if (mapW <= 0 || mapH <= 0) return 0;
  return rTiles * Math.min(box.w / mapW, box.h / mapH);
}

// ---------------------------------------------------------------- 純関数: 輪の太さ

/** 輪の最小の太さ（px。劣勢の極）。 */
export const RING_MIN_PX = 2;
/** 輪の最大の太さ（px。優勢の極）。 */
export const RING_MAX_PX = 11;

/**
 * 優勢度（Fx。-FX_ONE..FX_ONE）→ 輪の太さ（px）。
 * **輪の太さが優勢・劣勢を表します**（`05§7-1`）。太い = 優勢。
 */
export function ringLineWidth(advantageFx: number): number {
  const adv = Math.max(-FX_ONE, Math.min(FX_ONE, advantageFx)) / FX_ONE;
  return RING_MIN_PX + ((adv + 1) / 2) * (RING_MAX_PX - RING_MIN_PX);
}

// ---------------------------------------------------------------- 純関数: 伝達線

/** 伝達線の見え方（`05§7-5`）。 */
export type DeliveryStyle =
  /** 令がまだ 1 枚も無い（線を引かない）。 */
  | 'none'
  /** 切り替え直後。点線が**流れる**。 */
  | 'flowing'
  /** 届いた。**実線**になる。 */
  | 'solid';

/** 伝達線の入力（World を組まずに検算できるように値だけ取る）。 */
export interface DeliveryLineInput {
  readonly hasPending: boolean;
  readonly hasOrder: boolean;
  readonly startTick: number;
  readonly deliverAtTick: number;
  readonly nowTick: number;
}

/** 伝達線の状態。 */
export interface DeliveryLineState {
  readonly style: DeliveryStyle;
  /** 本陣から戦域までのどこまで届いたか（0..1）。`solid` は 1。 */
  readonly progress: number;
  readonly remainTicks: number;
}

/**
 * 伝達線の状態（`05§7-5`「切り替え直後は線が流れ、届いた瞬間に実線になります」）。
 *
 * **伝達中は実線にしない**こと。線の見え方が「押した瞬間に効かない」ことの唯一の説明なので、
 * ここを親切心で先に実線にすると設計が崩れる（手順書 §16-4）。
 */
export function deliveryLineState(inp: DeliveryLineInput): DeliveryLineState {
  if (inp.hasPending) {
    const total = Math.max(1, inp.deliverAtTick - inp.startTick);
    const remain = Math.max(0, inp.deliverAtTick - inp.nowTick);
    const progress = Math.max(0, Math.min(1, 1 - remain / total));
    return { style: 'flowing', progress, remainTicks: remain };
  }
  if (inp.hasOrder) return { style: 'solid', progress: 1, remainTicks: 0 };
  return { style: 'none', progress: 0, remainTicks: 0 };
}

/** 点線の 1 周期の長さ（px）。 */
export const DASH_LEN_PX = 14;
/** 点線が流れる速さ（px / 秒）。 */
export const DASH_SPEED_PX_PER_SEC = 46;

/**
 * 点線を流すためのオフセット（px、0..DASH_LEN_PX）。
 * 本陣 → 戦域の向きに流したいので**負の方向**へ進める。
 */
export function dashOffsetPx(nowMs: number, dashLen = DASH_LEN_PX): number {
  const travel = (nowMs / 1000) * DASH_SPEED_PX_PER_SEC;
  const m = travel % dashLen;
  return -(m < 0 ? m + dashLen : m);
}

// ---------------------------------------------------------------- 純関数: 当たり判定

/** 俯瞰図に置いた輪 1 つ（クリック判定と DOM チップの配置に使う）。 */
export interface RingPoint {
  /** 自軍の輪ならスロット 1..6。敵の輪は 0（クリック対象にしない）。 */
  readonly slot: number;
  readonly x: number;
  readonly y: number;
  readonly r: number;
}

/** クリックの許容余白（px）。小さい輪でも押せるように。 */
export const HIT_PAD_PX = 10;

/**
 * クリック位置 → 戦域スロット（0 = どれでもない）。
 * 重なっている場合は**中心が近い方**を選ぶ（大きい輪の中の小さい輪を押せるように）。
 */
export function hitTestFronts(points: readonly RingPoint[], px: number, py: number): number {
  let best = 0;
  let bestD = Number.POSITIVE_INFINITY;
  for (const p of points) {
    if (p.slot <= 0) continue;
    const dx = px - p.x;
    const dy = py - p.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d > p.r + HIT_PAD_PX) continue;
    if (d < bestD) {
      bestD = d;
      best = p.slot;
    }
  }
  return best;
}

/** 自軍の戦域を俯瞰図の座標に写す（純関数。テストで検算する）。 */
export function frontRingPoints(
  fronts: readonly Front[],
  box: ViewBox,
  mapW: number,
  mapH: number,
): RingPoint[] {
  return fronts.map((f) => {
    const p = projectTile(box, mapW, mapH, f.x / FX_ONE, f.y / FX_ONE);
    return { slot: f.slot, x: p.x, y: p.y, r: projectRadius(box, mapW, mapH, f.radius / FX_ONE) };
  });
}

/**
 * 敵の戦域を俯瞰図の座標に写す。
 * **入力は `FrontRing` だけ**（中心・半径・番号・持ち主のみ）。
 * `Front` を渡せないようにしてあるのが情報漏れ防止の要（`07§7`）。
 */
export function enemyRingPoints(
  rings: readonly FrontRing[],
  box: ViewBox,
  mapW: number,
  mapH: number,
): (RingPoint & { owner: PlayerId })[] {
  return rings.map((ring) => {
    const p = projectTile(box, mapW, mapH, ring.x / FX_ONE, ring.y / FX_ONE);
    return {
      slot: 0, // クリック対象にしない（敵の戦域に令は出せない）
      owner: ring.owner,
      x: p.x,
      y: p.y,
      r: projectRadius(box, mapW, mapH, ring.radius / FX_ONE),
    };
  });
}

// ---------------------------------------------------------------- 敵拠点 / 発信点

/** 「拠点」として俯瞰に出す建物（`05§7-8` の「攻め込む先」）。 */
const BASE_BUILDING_IDS = ['town_center', 'castle', 'great_tent'] as const;

/** 拠点建物の typeId 集合（起動時に 1 回だけ引く）。 */
const BASE_TYPE_IDS: readonly number[] = BASE_BUILDING_IDS.map((id) => buildingIndex(id));

/** 俯瞰に出す拠点 1 つ。 */
export interface BasePoint {
  readonly owner: number;
  readonly typeId: number;
  /** マス座標。 */
  readonly x: number;
  readonly y: number;
  readonly name: string;
}

/**
 * 敵拠点（`05§7-8`）。**既知（一度でも見た）建物の「形」だけ**を使う（`07§7`）。
 *
 * 視界の外の建物は既に壊れている可能性があるが、それは資料が意図した嘘
 * （「建物は嘘をつく」`07§7`）なのでそのまま出す。体力や中身は一切出さない。
 */
export function collectEnemyBases(w: World, viewer: PlayerId, vision: VisionBuffer): BasePoint[] {
  const out: BasePoint[] = [];
  const map = w.map;
  /** 同じ建物が複数マスに記録されているので、代表点 1 つに畳む。 */
  const seen = new Set<string>();
  for (let ty = 0; ty < map.heightTiles; ty++) {
    for (let tx = 0; tx < map.widthTiles; tx++) {
      if (vision.stateAt(tx, ty) === VisionState.Unexplored) continue;
      const typeId = vision.rememberedBuilding(tx, ty);
      if (typeId < 0) continue;
      if (!BASE_TYPE_IDS.includes(typeId)) continue;
      const owner = vision.knownOwner[ty * map.widthTiles + tx] ?? NEUTRAL_OWNER;
      if (owner === NEUTRAL_OWNER) continue;
      if (owner === viewer) continue;
      if (areAllies(w, owner as PlayerId, viewer)) continue;
      // 建物 1 棟ぶん（最大 5×5）の格子に畳む
      const key = `${owner}:${typeId}:${Math.floor(ty / 5)},${Math.floor(tx / 5)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ owner, typeId, x: tx + 0.5, y: ty + 0.5, name: buildingDef(typeId).name });
    }
  }
  return out;
}

/**
 * 自軍の令の発信点（本陣 + 城 + 大天幕）。**先頭が本陣**（不動。`05§7-4`）。
 * 伝達線の始点をどこにするかは「最寄りの発信点」（`07§4`）なので、
 * ここで全部集めて距離で選ぶ。
 */
export function collectOrderSources(w: World, viewer: PlayerId): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [
    { x: homeCampX(w, viewer) / FX_ONE, y: homeCampY(w, viewer) / FX_ONE },
  ];
  const e = w.entities;
  for (let i = 0; i < e.highWater; i++) {
    if (e.alive[i] !== 1) continue;
    if (e.kind[i] !== EntityKind.Building) continue;
    if (!isOrderSourceIndex(w, i, viewer)) continue;
    out.push({ x: e.x[i]! / FX_ONE, y: e.y[i]! / FX_ONE });
  }
  return out;
}

/** 点の集合から一番近いものを選ぶ（伝達線の始点）。空なら null。 */
export function nearestPoint(
  points: readonly { x: number; y: number }[],
  x: number,
  y: number,
): { x: number; y: number } | null {
  let best: { x: number; y: number } | null = null;
  let bestD = Number.POSITIVE_INFINITY;
  for (const p of points) {
    const dx = p.x - x;
    const dy = p.y - y;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

// ---------------------------------------------------------------- DOM

/** 戦域指令ビューが外に触るための窓口。 */
export interface FrontCommandContext {
  world(): World;
  readonly viewer: PlayerId;
  vision(): VisionBuffer;
  emit(cmd: Command): void;
  /** 戦域を選ぶ（`1`〜`6` と同じ。視点は動かさない = `Alt`+`1`〜`6` 相当）。 */
  selectFront(slot: number): void;
  /** 今選ばれている戦域スロット（0 = 未選択）。 */
  selectedFront(): number;
  /** その場所へ視点を飛ばす（俯瞰から対戦画面に戻るとき）。 */
  jumpTo(tileX: number, tileY: number): void;
  /** 令カードパネルを開く（`05§8`「戦域を選ぶと開くパネル」）。 */
  openOrderCards?(slot: number): void;
  /** 開閉が変わったことの通知（親が入力モードを切り替えたいとき）。 */
  onToggle?(open: boolean): void;
}

/** 左右の余白（px）。手順書 §8.2。 */
const PAD_PX = 20;
/** 文字の塗り直し間隔（ms）。canvas は毎フレーム描く。 */
const TEXT_INTERVAL_MS = 100;
/** 敵拠点の走査間隔（ms）。マップ全面を舐めるので毎フレームはやらない。 */
const BASE_SCAN_INTERVAL_MS = 700;

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

/**
 * 戦域指令ビュー本体。
 *
 * 構造:
 *  - `canvas` … 輪・本陣・伝達線・敵拠点（絵）
 *  - `canvas` の上に絶対配置した DOM チップ … 令スロット（文字。クリックで選択）
 *  - 右の列 … 6 スロットの一覧（空き・未解禁の理由がここで分かる）
 */
export class FrontCommandView {
  private readonly ctx: FrontCommandContext;
  private readonly root: HTMLElement;
  private readonly stage: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly c2d: CanvasRenderingContext2D;
  private readonly chipWrap: HTMLElement;
  private readonly chips = new Map<number, ChipNode>();
  private readonly slotRows: SlotRow[] = [];
  private readonly legend: HTMLElement;
  private readonly tracker = new OrderPendingTracker();

  private open_ = false;
  private box: ViewBox = { x: 0, y: 0, w: 1, h: 1 };
  private points: RingPoint[] = [];
  private bases: BasePoint[] = [];
  private lastBaseScanMs = -1e9;
  private lastTextMs = -1e9;
  /** 警告の初回検出時刻（点滅を「放置すると速く」するため）。 */
  private readonly warnSince = new Map<number, number>();

  constructor(overlay: HTMLElement, ctx: FrontCommandContext) {
    this.ctx = ctx;
    this.root = el('div', 'mt-fcv');
    this.root.hidden = true;

    // ---- ヘッダは最小限（手順書 §8.2。メインの俯瞰図を狭めない） ----
    const head = el('div', 'mt-fcv-head');
    head.append(
      el('span', 'mt-fcv-title', '戦域指令'),
      el('span', 'mt-fcv-hint', '輪の太さ = 優勢 / 点滅 = 崩れかけ / 点線 = まだ届いていない令'),
    );
    const close = el('button', 'mt-fcv-close', '閉じる (Tab)');
    close.type = 'button';
    close.addEventListener('click', () => this.close());
    head.appendChild(close);
    this.root.appendChild(head);

    const body = el('div', 'mt-fcv-body');

    // ---- 俯瞰図 ----
    this.stage = el('div', 'mt-fcv-stage');
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'mt-fcv-map';
    const c = this.canvas.getContext('2d');
    if (c === null) throw new Error('FrontCommandView: 2d コンテキストが取れない');
    this.c2d = c;
    this.chipWrap = el('div', 'mt-fcv-chips');
    this.stage.append(this.canvas, this.chipWrap);
    // 輪のクリックで戦域を選び、令カードパネルを開く（マウスのみで完結。`06§12`）
    this.canvas.addEventListener('click', (ev: MouseEvent) => this.onStageClick(ev));
    this.canvas.addEventListener('dblclick', (ev: MouseEvent) => this.onStageDblClick(ev));
    body.appendChild(this.stage);

    // ---- 右の列: 6 スロットの一覧（令スロット / 空き / 未解禁） ----
    const side = el('div', 'mt-fcv-side');
    for (let slot = 1; slot <= MAX_FRONTS; slot++) {
      const row = el('button', 'mt-fcv-row');
      row.type = 'button';
      const flag = el('span', 'mt-fcv-row-flag', `${frontShape(slot)}${slot}`);
      flag.style.color = frontColor(slot);
      const upper = el('span', 'mt-fcv-row-upper', '—');
      const lower = el('span', 'mt-fcv-row-lower', '');
      const state = el('span', 'mt-fcv-row-state', '');
      row.append(flag, upper, lower, state);
      row.addEventListener('click', () => this.selectSlot(slot));
      side.appendChild(row);
      this.slotRows.push({ root: row, upper, lower, state });
    }
    this.legend = el('div', 'mt-fcv-legend', '');
    side.appendChild(this.legend);
    body.appendChild(side);

    this.root.appendChild(body);
    overlay.appendChild(this.root);
  }

  /** 開いているか。 */
  isOpen(): boolean {
    return this.open_;
  }

  /** `Tab`（開閉）。戻り値は開いたか。 */
  toggle(): boolean {
    if (this.open_) {
      this.close();
      return false;
    }
    this.open();
    return true;
  }

  open(): void {
    this.open_ = true;
    this.root.hidden = false;
    this.lastTextMs = -1e9;
    this.lastBaseScanMs = -1e9;
    this.ctx.onToggle?.(true);
  }

  close(): void {
    this.open_ = false;
    this.root.hidden = true;
    this.ctx.onToggle?.(false);
  }

  /** 今の輪の配置（テスト・親の結線から読む）。 */
  ringPoints(): readonly RingPoint[] {
    return this.points;
  }

  /** 毎フレーム呼ぶ。**開いている間もシムは進む**（オーバーレイなので）。 */
  update(nowMs: number): void {
    const w = this.ctx.world();
    const fronts = ownFronts(w, this.ctx.viewer);
    // 伝達の開始 tick は閉じている間も観測しておく（開いた瞬間に線の割合が正しく出る）
    this.tracker.observe(w, fronts);
    this.trackWarnings(fronts, nowMs);
    if (!this.open_) return;

    this.resize();
    if (nowMs - this.lastBaseScanMs >= BASE_SCAN_INTERVAL_MS) {
      this.lastBaseScanMs = nowMs;
      this.bases = collectEnemyBases(w, this.ctx.viewer, this.ctx.vision());
    }
    this.draw(w, fronts, nowMs);
    if (nowMs - this.lastTextMs < TEXT_INTERVAL_MS) return;
    this.lastTextMs = nowMs;
    this.updateChips(w, fronts);
    this.updateSide(w, fronts);
  }

  destroy(): void {
    this.root.remove();
    this.chips.clear();
    this.tracker.clear();
    this.warnSince.clear();
  }

  // ------------------------------------------------------------ 内部: 入力

  private onStageClick(ev: MouseEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    const slot = hitTestFronts(this.points, ev.clientX - rect.left, ev.clientY - rect.top);
    if (slot === 0) return;
    this.selectSlot(slot);
  }

  /** ダブルクリックでその戦域へ視点を飛ばして俯瞰を閉じる（対戦画面へ戻る）。 */
  private onStageDblClick(ev: MouseEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    const slot = hitTestFronts(this.points, ev.clientX - rect.left, ev.clientY - rect.top);
    if (slot === 0) return;
    const f = ownFronts(this.ctx.world(), this.ctx.viewer).find((x) => x.slot === slot);
    if (f === undefined) return;
    this.ctx.jumpTo(f.x / FX_ONE, f.y / FX_ONE);
    this.close();
  }

  /**
   * 戦域を選ぶ。**空きスロットは無反応**（`06§1`「空きスロットの番号は反応しません」）。
   * 選べたら令カードパネルを開く（`05§8`「戦域を選ぶと開くパネル」）。
   */
  private selectSlot(slot: number): boolean {
    const f = ownFronts(this.ctx.world(), this.ctx.viewer).find((x) => x.slot === slot);
    if (f === undefined) return false;
    this.ctx.selectFront(slot);
    this.ctx.openOrderCards?.(slot);
    return true;
  }

  // ------------------------------------------------------------ 内部: 描画

  private resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const cw = Math.max(1, Math.floor(this.stage.clientWidth));
    const ch = Math.max(1, Math.floor(this.stage.clientHeight));
    const pw = Math.floor(cw * dpr);
    const ph = Math.floor(ch * dpr);
    if (this.canvas.width !== pw || this.canvas.height !== ph) {
      this.canvas.width = pw;
      this.canvas.height = ph;
      this.canvas.style.width = `${cw}px`;
      this.canvas.style.height = `${ch}px`;
    }
    this.c2d.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private draw(w: World, fronts: readonly Front[], nowMs: number): void {
    const ctx = this.c2d;
    const cw = this.canvas.width / (window.devicePixelRatio || 1);
    const ch = this.canvas.height / (window.devicePixelRatio || 1);
    const mapW = w.map.widthTiles;
    const mapH = w.map.heightTiles;
    this.box = fitMapBox(cw, ch, mapW, mapH, PAD_PX);
    const box = this.box;

    ctx.clearRect(0, 0, cw, ch);

    // ---- マップの枠（地形は描かない。ここは「判断」の画面なので情報を絞る） ----
    ctx.strokeStyle = 'rgba(74,58,30,0.9)';
    ctx.lineWidth = 1;
    ctx.strokeRect(box.x, box.y, box.w, box.h);

    const sources = collectOrderSources(w, this.ctx.viewer);
    const home = sources[0]!;
    const homePx = projectTile(box, mapW, mapH, home.x, home.y);

    // ---- 8 敵拠点（攻め込む先。既知の形だけ） ----
    for (const b of this.bases) {
      const p = projectTile(box, mapW, mapH, b.x, b.y);
      ctx.fillStyle = playerColor(b.owner);
      ctx.globalAlpha = 0.9;
      drawDiamond(ctx, p.x, p.y, 7);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // ---- 5 令の伝達線（本陣 → 各戦域。点線が流れ、届いたら実線） ----
    for (const f of fronts) {
      const to = projectTile(box, mapW, mapH, f.x / FX_ONE, f.y / FX_ONE);
      const src = nearestPoint(sources, f.x / FX_ONE, f.y / FX_ONE) ?? home;
      const from = projectTile(box, mapW, mapH, src.x, src.y);
      const st = deliveryLineState({
        hasPending: f.pendingOrder !== null,
        hasOrder: f.order !== null || f.orderLower !== null,
        startTick: this.tracker.startOf(f.slot) ?? f.pendingOrder?.deliverAtTick ?? w.tick,
        deliverAtTick: f.pendingOrder?.deliverAtTick ?? w.tick,
        nowTick: w.tick,
      });
      if (st.style === 'none') continue;
      ctx.strokeStyle = frontColor(f.slot);
      ctx.lineWidth = 2;
      if (st.style === 'flowing') {
        // 点線が流れる = まだ届いていない（`05§15` の「点線」の意味）
        ctx.setLineDash([7, 7]);
        ctx.lineDashOffset = dashOffsetPx(nowMs);
        ctx.globalAlpha = 0.85;
        ctx.beginPath();
        ctx.moveTo(from.x, from.y);
        ctx.lineTo(to.x, to.y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.lineDashOffset = 0;
        // どこまで届いたかを実線で（線が「流れている」ことを目で追えるように）
        ctx.globalAlpha = 1;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(from.x, from.y);
        ctx.lineTo(
          from.x + (to.x - from.x) * st.progress,
          from.y + (to.y - from.y) * st.progress,
        );
        ctx.stroke();
      } else {
        // 届いた = 実線
        ctx.globalAlpha = 1;
        ctx.beginPath();
        ctx.moveTo(from.x, from.y);
        ctx.lineTo(to.x, to.y);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    // ---- 敵の戦域（**中心と半径だけ**。`07§7` / §16-5） ----
    for (const ring of enemyRingPoints(visibleEnemyFronts(w, this.ctx.viewer), box, mapW, mapH)) {
      ctx.strokeStyle = playerColor(ring.owner);
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.arc(ring.x, ring.y, Math.max(4, ring.r), 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // ---- 1〜3 自軍の戦域（太さ = 優勢度 / 点滅 = 崩れかけ） ----
    this.points = frontRingPoints(fronts, box, mapW, mapH);
    const selected = this.ctx.selectedFront();
    for (const f of fronts) {
      const p = this.points.find((x) => x.slot === f.slot);
      if (p === undefined) continue;
      const warn = isFrontWarning(f);
      const since = this.warnSince.get(f.slot);
      const alpha = warn ? blinkAlpha(nowMs, blinkPeriodMs(Math.max(0, nowMs - (since ?? nowMs)))) : 1;
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = frontColor(f.slot);
      ctx.lineWidth = ringLineWidth(f.advantage);
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(6, p.r), 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
      // 選択中の戦域は金の縁（`05§15`「今これが選ばれている」）
      if (f.slot === selected) {
        ctx.strokeStyle = GOLD;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(p.x, p.y, Math.max(6, p.r) + ctx.lineWidth + 5, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // ---- 4 本陣（動かない） + 発信点（城・大天幕） ----
    for (let k = 1; k < sources.length; k++) {
      const p = projectTile(box, mapW, mapH, sources[k]!.x, sources[k]!.y);
      ctx.strokeStyle = GOLD;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle = GOLD;
    drawDiamond(ctx, homePx.x, homePx.y, 9);
    ctx.fillStyle = '#14100c';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('本', homePx.x, homePx.y + 0.5);
  }

  // ------------------------------------------------------------ 内部: 文字

  /** 崩れかけを初めて見た時刻を覚える（点滅を「放置すると速く」するため）。 */
  private trackWarnings(fronts: readonly Front[], nowMs: number): void {
    const live = new Set<number>();
    for (const f of fronts) {
      if (!isFrontWarning(f)) continue;
      live.add(f.slot);
      if (!this.warnSince.has(f.slot)) this.warnSince.set(f.slot, nowMs);
    }
    for (const slot of [...this.warnSince.keys()]) {
      if (!live.has(slot)) this.warnSince.delete(slot);
    }
  }

  /** 6 令スロットのチップ（俯瞰図の上に重ねる文字）。 */
  private updateChips(w: World, fronts: readonly Front[]): void {
    const dual = hasDoubleFlag(w, this.ctx.viewer);
    const alive = new Set<number>();
    for (const f of fronts) {
      alive.add(f.slot);
      let chip = this.chips.get(f.slot);
      if (chip === undefined) {
        const root = el('button', 'mt-fcv-chip');
        root.type = 'button';
        const flag = el('span', 'mt-fcv-chip-flag', `${frontShape(f.slot)}${f.slot}`);
        flag.style.color = frontColor(f.slot);
        const upper = el('span', 'mt-fcv-chip-upper', '');
        const lower = el('span', 'mt-fcv-chip-lower', '');
        root.append(flag, upper, lower);
        root.addEventListener('click', () => this.selectSlot(f.slot));
        this.chipWrap.appendChild(root);
        chip = { root, upper, lower };
        this.chips.set(f.slot, chip);
      }
      const p = this.points.find((x) => x.slot === f.slot);
      if (p !== undefined) {
        chip.root.style.left = `${Math.round(p.x)}px`;
        chip.root.style.top = `${Math.round(p.y + Math.max(6, p.r) + 6)}px`;
      }
      chip.root.style.borderColor = frontColor(f.slot);
      chip.root.classList.toggle('mt-fcv-chip-selected', f.slot === this.ctx.selectedFront());
      chip.root.classList.toggle('mt-fcv-chip-warn', isFrontWarning(f));
      // 6 令スロット（セット済み）。二重旗なら上下 2 段（`05§7-6` / `05§10`）
      chip.upper.textContent = pendingSuffix(f, orderName(f.order) ?? '令なし');
      chip.lower.hidden = !dual;
      if (dual) chip.lower.textContent = orderName(f.orderLower) ?? '（下段 空き）';
    }
    for (const [slot, chip] of [...this.chips]) {
      if (alive.has(slot)) continue;
      chip.root.remove();
      this.chips.delete(slot);
    }
  }

  /** 右の列（令スロット / 空きスロット / 未解禁）。 */
  private updateSide(w: World, fronts: readonly Front[]): void {
    const pl = getPlayer(w, this.ctx.viewer);
    const usable = pl?.frontSlots ?? 1;
    const dual = hasDoubleFlag(w, this.ctx.viewer);
    for (let slot = 1; slot <= MAX_FRONTS; slot++) {
      const row = this.slotRows[slot - 1]!;
      const f = fronts.find((x) => x.slot === slot);
      const unlocked = slot <= usable;
      row.root.classList.toggle('mt-fcv-row-locked', !unlocked);
      row.root.classList.toggle('mt-fcv-row-active', f !== undefined);
      row.root.classList.toggle('mt-fcv-row-warn', f !== undefined && isFrontWarning(f));
      row.root.classList.toggle('mt-fcv-row-selected', slot === this.ctx.selectedFront());
      row.lower.hidden = !dual || f === undefined;
      if (f === undefined) {
        row.upper.textContent = unlocked ? '空きスロット' : '未解禁';
        row.lower.textContent = '';
        // 7 空きスロット: **枠が余っていても戦域が立っていなければ使えない**（`05§7-7`）
        row.state.textContent = unlocked ? '戦域なし' : '時代・城・旗竿';
        row.root.title = unlocked
          ? '枠は空いていますが、戦域が立っていないので令は使えません（`05§7-7`）'
          : '未解禁のスロット（時代 / 城 1 棟ごとに +1 / 研究「旗竿」で +1）';
        continue;
      }
      row.upper.textContent = pendingSuffix(f, orderName(f.order) ?? '令なし');
      row.lower.textContent = dual ? `下段: ${orderName(f.orderLower) ?? '空き'}` : '';
      const adv = f.advantage / FX_ONE;
      row.state.textContent = `${isFrontWarning(f) ? '崩れかけ ' : ''}優勢 ${adv >= 0 ? '+' : ''}${(adv * 100).toFixed(0)}% / ${f.memberCount} 体`;
      row.root.title = `戦域 ${slot}: クリックで選択して令を渡す`;
    }
    this.legend.textContent = `本陣は動きません。遠い戦域ほど令が届くまで時間がかかります（有効な令: ${fronts
      .map((f) => orderName(effectiveOrderOf(f)) ?? '—')
      .join(' / ')}）`;
  }
}

interface ChipNode {
  readonly root: HTMLButtonElement;
  readonly upper: HTMLElement;
  readonly lower: HTMLElement;
}

interface SlotRow {
  readonly root: HTMLButtonElement;
  readonly upper: HTMLElement;
  readonly lower: HTMLElement;
  readonly state: HTMLElement;
}

/** 令 ID → 表示名。null は null のまま返す。 */
function orderName(id: string | null): string | null {
  if (id === null) return null;
  return orderDefById(id).name;
}

/** 伝達中なら「（伝達中）」を足す。**先行反映はしない**（§16-4）。 */
function pendingSuffix(f: Front, base: string): string {
  if (f.pendingOrder === null) return base;
  return `${base} → ${orderDefById(f.pendingOrder.id).name}（伝達中）`;
}

/** 拠点・本陣に使う菱形（`fill` は呼び出し側で設定済み）。 */
function drawDiamond(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.lineTo(x + r, y);
  ctx.lineTo(x, y + r);
  ctx.lineTo(x - r, y);
  ctx.closePath();
  ctx.fill();
}
