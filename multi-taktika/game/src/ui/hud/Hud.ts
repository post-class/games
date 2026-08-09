/**
 * ui/hud/Hud.ts — 最小 HUD（T-M5-06。`05§6` の 12 項目 / `05§1` の不変条件）
 *
 * ■ 位置は固定（`05§1` / 手順書 §16-10。**絶対に動かさない**）
 *   資源・人口 = 上端左 / ミニマップ = その下 / 戦域スロット = 右端 /
 *   選択対象・選択一覧・コマンドグリッド・生産キュー = 下端
 *
 * ■ `05§6` の 12 項目との対応
 *   1 資源表示（増減バー付き） 2 人口 3 ミニマップ 4 戦域スロット（点灯）
 *   5 戦域スロット（空き）     6 選択中の対象 7 体力バー 8 選択一覧
 *   9 コマンドグリッド        10 生産キュー 11 戦場ビュー（Canvas 側）
 *  12 部隊（Canvas 側の足元の輪）
 *
 * ■ 規約（`AI_CODING.md` / 手順書 §8.2）
 *   左右の余白 20px / 本文 16px 基準 / ヘッダは最小限（タイトル行を置かない）。
 *   幅は固定しない（ウィンドウを広げたら領域も広がる）。
 *
 * ■ マウスのみで完結（`05§8.1`）
 *   戦域スロットのクリックで選択、列の一番上の俯瞰ボタンで戦域指令ビュー（= `Tab`）。
 */

import { EntityKind, RESOURCE_COUNT, type PlayerId } from '@/shared/types';
import type { Command } from '@/sim/command';
import { buildingDef, orderDefById, unitDef } from '@/sim/core/defs';
import { PROGRESS_DONE, resolveIndex } from '@/sim/core/entity';
import { FX_ONE } from '@/sim/core/fx';
import { effectiveOrderOf, isFrontWarning, ownFronts } from '@/sim/core/front';
import { MAX_FRONTS, getPlayer, type World } from '@/sim/core/world';
import { GOLD, frontColor, frontShape, healthColor, resourceColor, resourceGlyph } from '@/render/palette';
import type { VisionBuffer } from '@/render/vision';
import type { CameraController } from '@/input/camera';
import type { Selection } from '@/input/selection';
import { groupSelectionByType } from '@/input/selection';
import { GRID_KEYS, buildCommandGrid, type GridButton } from './commandGrid';
import { Minimap } from './minimap';

/** HUD が外の世界に触るための窓口。 */
export interface HudContext {
  world(): World;
  readonly viewer: PlayerId;
  readonly selection: Selection;
  readonly cam: CameraController;
  vision(): VisionBuffer;
  emit(cmd: Command): void;
  /** 戦域スロットのクリック（`1`〜`6` と同じ。マウスのみ運用のため）。 */
  selectFront(slot: number): void;
  /** 俯瞰ボタン（= `Tab`）。 */
  toggleOverview(): void;
  /** 建設の「置くモード」に入る。 */
  beginPlacement(buildingId: string): void;
  /** デバッグ行（描画 ms など）。 */
  debugText(): string;
}

/** 資源の増減（毎分）を測るための標本。 */
interface IncomeSample {
  atMs: number;
  values: number[];
}

/** テキストの更新間隔（ms）。毎フレーム DOM を触らない。 */
const TEXT_INTERVAL_MS = 100;
/** ミニマップの地形を描き直す間隔（ms）。 */
const MINIMAP_TERRAIN_INTERVAL_MS = 250;
/** 資源の増減を測る間隔（ms）。 */
const INCOME_INTERVAL_MS = 3000;

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

export class Hud {
  private readonly root: HTMLElement;
  private readonly ctx: HudContext;

  // 上端左: 資源と人口
  private readonly resValues: HTMLElement[] = [];
  private readonly resBars: HTMLElement[] = [];
  private readonly popText: HTMLElement;
  private readonly popBar: HTMLElement;

  // ミニマップ
  private readonly minimap: Minimap;

  // 右端: 戦域スロット
  private readonly slotNodes: HTMLElement[] = [];
  private readonly slotLabels: HTMLElement[] = [];
  private readonly slotOrders: HTMLElement[] = [];
  private readonly slotBars: HTMLElement[] = [];

  // 下端
  private readonly selName: HTMLElement;
  private readonly selHpBar: HTMLElement;
  private readonly selHpText: HTMLElement;
  private readonly selList: HTMLElement;
  private readonly gridNodes: HTMLButtonElement[] = [];
  private readonly queueNodes: HTMLElement[] = [];
  private readonly debugLine: HTMLElement;

  private lastTextMs = 0;
  private lastTerrainMs = 0;
  private income: IncomeSample = { atMs: 0, values: new Array<number>(RESOURCE_COUNT).fill(0) };
  private incomePerMin: number[] = new Array<number>(RESOURCE_COUNT).fill(0);
  private grid: GridButton[] = [];

  constructor(overlay: HTMLElement, ctx: HudContext) {
    this.ctx = ctx;
    this.root = el('div', 'mt-hud');

    // ---------------- 上端左: 資源 4 種 + 人口（`05§6-1` / `05§6-2`） ----------------
    const top = el('div', 'mt-top');
    const resWrap = el('div', 'mt-res');
    for (let r = 0; r < RESOURCE_COUNT; r++) {
      const item = el('div', 'mt-res-item');
      const icon = el('span', 'mt-res-icon', resourceGlyph(r));
      icon.style.color = resourceColor(r);
      const value = el('span', 'mt-res-value', '0');
      const bar = el('div', 'mt-res-bar');
      const fill = el('div', 'mt-res-bar-fill');
      fill.style.background = resourceColor(r);
      bar.appendChild(fill);
      item.append(icon, value, bar);
      resWrap.appendChild(item);
      this.resValues.push(value);
      this.resBars.push(fill);
    }
    const popItem = el('div', 'mt-res-item mt-pop');
    const popIcon = el('span', 'mt-res-icon', '人');
    this.popText = el('span', 'mt-res-value', '0/0');
    this.popBar = el('div', 'mt-res-bar-fill');
    const popBarWrap = el('div', 'mt-res-bar');
    popBarWrap.appendChild(this.popBar);
    popItem.append(popIcon, this.popText, popBarWrap);
    resWrap.appendChild(popItem);
    top.appendChild(resWrap);

    // ---------------- ミニマップ（`05§6-3`） ----------------
    this.minimap = new Minimap();
    const mmWrap = el('div', 'mt-minimap-wrap');
    mmWrap.appendChild(this.minimap.canvas);
    this.minimap.canvas.addEventListener('mousedown', (ev: MouseEvent) => {
      const rect = this.minimap.canvas.getBoundingClientRect();
      const t = this.minimap.toTile(ev.clientX - rect.left, ev.clientY - rect.top, ctx.world());
      // 左クリック = その地点へジャンプ（`06§7`）
      if (ev.button === 0) this.ctx.cam.jumpTo(t.x, t.y);
      ev.preventDefault();
    });
    this.minimap.canvas.addEventListener('contextmenu', (ev: MouseEvent) => ev.preventDefault());
    top.appendChild(mmWrap);
    this.root.appendChild(top);

    // ---------------- 右端: 戦域スロット列（`05§6-4` / `05§6-5`） ----------------
    const right = el('div', 'mt-right');
    const overview = el('button', 'mt-overview', '俯瞰 (Tab)');
    overview.addEventListener('click', () => this.ctx.toggleOverview());
    right.appendChild(overview);
    for (let slot = 1; slot <= MAX_FRONTS; slot++) {
      const node = el('button', 'mt-slot');
      const flag = el('span', 'mt-slot-flag', `${frontShape(slot)}${slot}`);
      flag.style.color = frontColor(slot);
      const order = el('span', 'mt-slot-order', '—');
      const bar = el('div', 'mt-slot-bar');
      const fill = el('div', 'mt-slot-bar-fill');
      fill.style.background = frontColor(slot);
      bar.appendChild(fill);
      node.append(flag, order, bar);
      node.addEventListener('click', () => this.ctx.selectFront(slot));
      right.appendChild(node);
      this.slotNodes.push(node);
      this.slotLabels.push(flag);
      this.slotOrders.push(order);
      this.slotBars.push(fill);
    }
    this.root.appendChild(right);

    // ---------------- 下端: 選択・コマンド・生産キュー ----------------
    const bottom = el('div', 'mt-bottom');

    const selPanel = el('div', 'mt-sel');
    this.selName = el('div', 'mt-sel-name', '—');
    const hpWrap = el('div', 'mt-sel-hp');
    this.selHpBar = el('div', 'mt-sel-hp-fill');
    hpWrap.appendChild(this.selHpBar);
    this.selHpText = el('div', 'mt-sel-hp-text', '');
    this.selList = el('div', 'mt-sel-list');
    selPanel.append(this.selName, hpWrap, this.selHpText, this.selList);
    bottom.appendChild(selPanel);

    // コマンドグリッド（3 段 12 ボタン。キーは QWER/ASDF/ZXCV と一対一）
    const gridPanel = el('div', 'mt-grid');
    for (let k = 0; k < GRID_KEYS.length; k++) {
      const b = el('button', 'mt-grid-btn');
      const key = el('span', 'mt-grid-key', GRID_KEYS[k]!);
      const label = el('span', 'mt-grid-label', '');
      b.append(key, label);
      b.addEventListener('click', () => this.pressGrid(k));
      gridPanel.appendChild(b);
      this.gridNodes.push(b);
    }
    bottom.appendChild(gridPanel);

    // 生産キュー（最大 5 件。`05§6-10`）
    const queuePanel = el('div', 'mt-queue');
    for (let k = 0; k < 5; k++) {
      const slot = el('div', 'mt-queue-slot', '');
      queuePanel.appendChild(slot);
      this.queueNodes.push(slot);
    }
    bottom.appendChild(queuePanel);
    this.root.appendChild(bottom);

    this.debugLine = el('div', 'mt-debug', '');
    this.root.appendChild(this.debugLine);

    overlay.appendChild(this.root);
  }

  /** キーボードから `QWER/ASDF/ZXCV` を押したときの入口（並びが一対一）。 */
  pressGridKey(key: string): boolean {
    const k = GRID_KEYS.indexOf(key.toUpperCase());
    if (k < 0) return false;
    return this.pressGrid(k);
  }

  private pressGrid(k: number): boolean {
    const b = this.grid[k];
    if (b === undefined || !b.enabled) return false;
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

  /** 毎フレーム呼ぶ（中で間引く）。 */
  update(nowMs: number): void {
    const w = this.ctx.world();
    if (nowMs - this.lastTerrainMs >= MINIMAP_TERRAIN_INTERVAL_MS) {
      this.lastTerrainMs = nowMs;
      this.minimap.redrawTerrain(w, this.ctx.vision());
      this.minimap.drawOverlay(w, this.ctx.viewer, this.ctx.vision(), this.ctx.cam.cam);
    }
    if (nowMs - this.lastTextMs < TEXT_INTERVAL_MS) return;
    this.lastTextMs = nowMs;

    this.updateResources(w, nowMs);
    this.updateFronts(w);
    this.updateSelection(w);
    this.debugLine.textContent = this.ctx.debugText();
  }

  /** 資源 4 種と人口（増減バー付き）。 */
  private updateResources(w: World, nowMs: number): void {
    const pl = getPlayer(w, this.ctx.viewer);
    if (pl === undefined) return;

    // 増減（毎分）の測定。描画層なので Date/performance を使ってよい（決定論の対象外）
    if (nowMs - this.income.atMs >= INCOME_INTERVAL_MS) {
      if (this.income.atMs > 0) {
        const dtMin = (nowMs - this.income.atMs) / 60000;
        for (let r = 0; r < RESOURCE_COUNT; r++) {
          const now = pl.resources[r]! / FX_ONE;
          this.incomePerMin[r] = (now - this.income.values[r]!) / dtMin;
        }
      }
      this.income = {
        atMs: nowMs,
        values: Array.from({ length: RESOURCE_COUNT }, (_, r) => pl.resources[r]! / FX_ONE),
      };
    }

    for (let r = 0; r < RESOURCE_COUNT; r++) {
      this.resValues[r]!.textContent = String(Math.floor(pl.resources[r]! / FX_ONE));
      // 毎分 300 で満杯とみなす細いバー
      const ratio = Math.max(0, Math.min(1, (this.incomePerMin[r] ?? 0) / 300));
      this.resBars[r]!.style.width = `${Math.round(ratio * 100)}%`;
    }
    this.popText.textContent = `${pl.pop}/${pl.popCap}`;
    const popRatio = pl.popCap > 0 ? pl.pop / pl.popCap : 0;
    this.popBar.style.width = `${Math.round(Math.min(1, popRatio) * 100)}%`;
    // 上限に当たったら赤く（`05§6-2`）
    this.popBar.style.background = popRatio >= 1 ? '#c0562f' : '#e8ded0';
  }

  /** 戦域スロット列（点灯 / 空き / 崩れかけの点滅）。 */
  private updateFronts(w: World): void {
    const pl = getPlayer(w, this.ctx.viewer);
    const fronts = ownFronts(w, this.ctx.viewer);
    const usable = pl?.frontSlots ?? 1;
    for (let slot = 1; slot <= MAX_FRONTS; slot++) {
      const node = this.slotNodes[slot - 1]!;
      const f = fronts.find((x) => x.slot === slot);
      const unlocked = slot <= usable;
      node.classList.toggle('mt-slot-locked', !unlocked);
      node.classList.toggle('mt-slot-active', f !== undefined);
      node.classList.toggle('mt-slot-warn', f !== undefined && isFrontWarning(f));
      if (f === undefined) {
        this.slotOrders[slot - 1]!.textContent = unlocked ? '空き' : '未解禁';
        this.slotBars[slot - 1]!.style.width = '0%';
        continue;
      }
      const order = effectiveOrderOf(f);
      const pending = f.pendingOrder !== null;
      this.slotOrders[slot - 1]!.textContent =
        (order === null ? '令なし' : orderDefById(order).name) + (pending ? '（伝達中）' : '');
      // 輪の太さ = 優勢度、と同じ情報をバーの長さで出す
      const adv = f.advantage / FX_ONE;
      this.slotBars[slot - 1]!.style.width = `${Math.round(((adv + 1) / 2) * 100)}%`;
    }
  }

  /** 選択対象・体力バー・選択一覧・コマンドグリッド・生産キュー。 */
  private updateSelection(w: World): void {
    const e = w.entities;
    const ids = this.ctx.selection.list();
    if (ids.length === 0) {
      this.selName.textContent = '—';
      this.selHpBar.style.width = '0%';
      this.selHpText.textContent = '';
      this.selList.textContent = '';
      this.setGrid([]);
      this.setQueue(-1, w);
      return;
    }
    const head = ids[0]!;
    const i = resolveIndex(e, head);
    if (i < 0) return;

    // 6 選択中の対象（複数選択時は先頭の 1 体。`05§6-6`）
    const name = nameOf(w, i);
    this.selName.textContent = ids.length > 1 ? `${name} 他 ${ids.length - 1}` : name;

    // 7 体力バー（建設中は進捗を兼ねる。`05§9-2`）
    const hp = e.hp[i]!;
    const max = e.hpMax[i]!;
    const ratio = max > 0 ? Math.max(0, Math.min(1, hp / max)) : 0;
    this.selHpBar.style.width = `${Math.round(ratio * 100)}%`;
    this.selHpBar.style.background = healthColor(ratio);
    const building = e.buildProgress[i]! > 0 && e.buildProgress[i]! < PROGRESS_DONE;
    this.selHpText.textContent = `${Math.round(hp / FX_ONE)} / ${Math.round(max / FX_ONE)}${building ? '（建設中）' : ''}`;

    // 8 選択一覧（種類ごと。クリックで絞り込み）
    this.selList.textContent = '';
    for (const g of groupSelectionByType(w, ids)) {
      const idx = resolveIndex(e, g.ids[0]!);
      if (idx < 0) continue;
      const chip = el('button', 'mt-chip', `${nameOf(w, idx)} ×${g.ids.length}`);
      chip.addEventListener('click', (ev: MouseEvent) => {
        // `Ctrl`+クリックでその種類を除外（`06§5`）
        if (ev.ctrlKey || ev.metaKey) this.ctx.selection.remove(g.ids);
        else this.ctx.selection.set(g.ids);
      });
      this.selList.appendChild(chip);
    }

    // 9 コマンドグリッド
    this.setGrid(buildCommandGrid(w, this.ctx.viewer, ids));
    // 10 生産キュー
    this.setQueue(i, w);
  }

  private setGrid(grid: GridButton[]): void {
    this.grid = grid;
    for (let k = 0; k < this.gridNodes.length; k++) {
      const node = this.gridNodes[k]!;
      const b = grid[k];
      const label = node.querySelector('.mt-grid-label');
      if (b === undefined) {
        node.classList.add('mt-grid-empty');
        node.classList.remove('mt-grid-disabled');
        if (label !== null) label.textContent = '';
        node.title = '';
        continue;
      }
      node.classList.remove('mt-grid-empty');
      node.classList.toggle('mt-grid-disabled', !b.enabled);
      if (label !== null) label.textContent = b.label;
      // 暗いボタンの理由（時代不足 / 資源不足 / 文明が持てない）はカーソルを乗せると出る
      node.title = b.enabled ? b.hint : `${b.hint} — ${b.reason}`;
    }
  }

  private setQueue(buildingIdx: number, w: World): void {
    const e = w.entities;
    for (let k = 0; k < this.queueNodes.length; k++) {
      const node = this.queueNodes[k]!;
      if (buildingIdx < 0) {
        node.textContent = '';
        node.classList.remove('mt-queue-filled');
        continue;
      }
      const count = e.queueCount[buildingIdx]!;
      if (k >= count) {
        node.textContent = '';
        node.classList.remove('mt-queue-filled');
        continue;
      }
      const q = e.queueUnit[buildingIdx * 10 + k]!;
      if (q <= 0) {
        node.textContent = '';
        node.classList.remove('mt-queue-filled');
        continue;
      }
      const def = unitDef(q - 1);
      const pct = k === 0 ? Math.round((e.prodProgress[buildingIdx]! / FX_ONE) * 100) : 0;
      node.textContent = k === 0 ? `${def.name} ${pct}%` : def.name;
      node.classList.add('mt-queue-filled');
      node.style.borderColor = k === 0 ? GOLD : 'transparent';
    }
  }
}

/** エンティティの表示名（文明ごとの呼び名は定義側が持つ）。 */
function nameOf(w: World, i: number): string {
  const e = w.entities;
  const kind = e.kind[i]!;
  if (kind === EntityKind.Unit) return unitDef(e.typeId[i]!).name;
  if (kind === EntityKind.Building || kind === EntityKind.Attachment) {
    return buildingDef(e.typeId[i]!).name;
  }
  return '資源';
}
