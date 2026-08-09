/**
 * ui/hud/warnings.ts — 警告システム（T-M12-08。`05§6` の注記 / `05§15` / `06§4` / `06§12`）
 *
 * ■ 資料が要求していること
 *  - 「警告は画面の縁に赤いバッジで出るので、戦場を見ていなくても押されていることに
 *    気づけます」（`05§6` 末尾の注記）
 *  - 「赤いバッジ = 戦域が崩れかけている警告。**放置すると点滅が速くなる**」（`05§15`）
 *  - 「`Space` 次の警告地点へジャンプ。**赤 = 戦域が崩れかけ / 橙 = 村人が被害 /
 *    黄 = 人口上限**」（`06§4`）
 *  - 「警告は**点滅 + 音 + 縁のバッジの 3 重**で通知します」（`06§12`）
 *
 * ■ 3 重通知の担当
 *  1. 点滅 … `blinkPeriodMs` / `blinkAlpha`（放置時間で周期が短くなる）
 *  2. 音   … **M17（アセット）担当**。ここは `onSound` という「鳴らす口」だけ用意する
 *  3. 縁のバッジ … 画面左端のバッジ列 + 画面全体を囲む縁の枠（赤のときだけ強く出る）
 *
 * ■ 層の約束（手順書 §3.1）
 *  - `World` は**読むだけ**。状態を書き換えない。カメラ移動は `ctx.jumpTo` に委ねる。
 *  - `Space`（次の警告へ）と `Backspace`（直前の視点へ）のキー結線は `input` 層の仕事。
 *    ここは「**ジャンプ先の座標を返す API**」（`next()` / `jumpToNext()`）を出すだけ。
 *
 * ■ テスト方針
 *  DOM を持たない純関数（`collectWarnings` / `blinkPeriodMs` / `blinkAlpha` /
 *  `pickNextWarning`）に判定を全部出し、`tests/unit/ui.warnings.test.ts` がそこを検算する。
 */

import { EntityKind, type PlayerId } from '@/shared/types';
import { unitDef } from '@/sim/core/defs';
import { NO_DAMAGE_TICK } from '@/sim/core/entity';
import { TICK_RATE } from '@/sim/core/config';
import { FX_ONE } from '@/sim/core/fx';
import { isFrontWarning, ownFronts } from '@/sim/core/front';
import { homeCampX, homeCampY, isVillagerRole } from '@/sim/core/order';
import { getPlayer, type World } from '@/sim/core/world';
import { frontColor, frontShape } from '@/render/palette';

// ---------------------------------------------------------------- 種類と段階

/** 警告の種類（`06§4` の 3 種）。 */
export const WarnKind = {
  /** 赤: 戦域が崩れかけ（`isFrontWarning`）。 */
  FrontCollapse: 'frontCollapse',
  /** 橙: 村人が攻撃されている。 */
  VillagerAttacked: 'villagerAttacked',
  /** 黄: 人口上限。 */
  PopCap: 'popCap',
} as const;
export type WarnKindId = (typeof WarnKind)[keyof typeof WarnKind];

/** 警告の色（`05§15` の「赤いバッジ」を 3 段階に拡張したもの）。 */
export type WarnLevel = 'red' | 'orange' | 'yellow';

/** 種類 → 色。`06§4` の対応をここ 1 か所で固定する。 */
export const WARN_LEVEL: Readonly<Record<WarnKindId, WarnLevel>> = {
  [WarnKind.FrontCollapse]: 'red',
  [WarnKind.VillagerAttacked]: 'orange',
  [WarnKind.PopCap]: 'yellow',
};

/** 段階 → 実際の色。`05§15`（赤 = 危険 / 橙 / 黄）。 */
export const WARN_COLOR: Readonly<Record<WarnLevel, string>> = {
  red: '#c0562f',
  orange: '#d98032',
  yellow: '#e0b34a',
};

/**
 * 警告 1 件。**`id` は同じ原因なら毎回同じ文字列になる**こと。
 * 「放置すると点滅が速くなる」を出すために、この `id` で初回検出時刻を覚える。
 */
export interface Warning {
  readonly id: string;
  readonly kind: WarnKindId;
  readonly level: WarnLevel;
  /** バッジに出す短い文（アイコンだけに頼らない。`06§12`）。 */
  readonly label: string;
  /** ジャンプ先（マス単位。`Space` と同じ動作をさせるための座標）。 */
  readonly x: number;
  readonly y: number;
  /** 戦域に紐づく警告なら 1..6。無関係なら 0（色覚に依存しない旗の形・番号に使う）。 */
  readonly slot: number;
}

/** 警告 + 経過時間（点滅の速さを決めるのに使う）。 */
export interface ActiveWarning extends Warning {
  /** 初めて検出した時刻（ms）。 */
  readonly sinceMs: number;
  /** 放置している時間（ms）。 */
  readonly ageMs: number;
  /** 今の点滅周期（ms）。短いほど速い。 */
  readonly periodMs: number;
}

// ---------------------------------------------------------------- 閾値

/**
 * 「村人が攻撃されている」と見なす直近の時間（tick）。
 * 3 秒。1 発殴られてバッジが一瞬光るだけでは気づけないので、余韻を持たせる。
 */
export const VILLAGER_ATTACK_WINDOW_TICKS = Math.round(3 * TICK_RATE);

/**
 * 村人の警告をまとめる格子の一辺（マス）。
 * 1 人ずつバッジを出すと 10 個並んで縁が埋まるので、近い村人は 1 件に畳む。
 * 戦域の発生半径（15 マス）より小さくして「別の場所で襲われている」を分けて出す。
 */
export const VILLAGER_CLUSTER_TILES = 12;

/** 点滅周期の初期値（ms）。ゆっくり。 */
export const BLINK_PERIOD_START_MS = 900;
/** 点滅周期の下限（ms）。これ以上は速くならない。 */
export const BLINK_PERIOD_MIN_MS = 220;
/** この時間放置すると下限まで速くなる（ms）。 */
export const BLINK_ESCALATE_MS = 20000;
/** 点滅の最も暗いときの不透明度（完全に消すと「消えた」と誤解される）。 */
export const BLINK_MIN_ALPHA = 0.3;

// ---------------------------------------------------------------- 純関数

/**
 * 放置時間 → 点滅周期（ms）。**放置すると点滅が速くなる**（`05§15`）。
 * 0ms で `BLINK_PERIOD_START_MS`、`BLINK_ESCALATE_MS` 以降は `BLINK_PERIOD_MIN_MS` で一定。
 */
export function blinkPeriodMs(ageMs: number): number {
  if (ageMs <= 0) return BLINK_PERIOD_START_MS;
  if (ageMs >= BLINK_ESCALATE_MS) return BLINK_PERIOD_MIN_MS;
  const t = ageMs / BLINK_ESCALATE_MS;
  return BLINK_PERIOD_START_MS + (BLINK_PERIOD_MIN_MS - BLINK_PERIOD_START_MS) * t;
}

/** 点滅の位相（0..1）。`periodMs` が 0 以下なら常時点灯（0）。 */
export function blinkPhase(nowMs: number, periodMs: number): number {
  if (periodMs <= 0) return 0;
  const m = nowMs % periodMs;
  return (m < 0 ? m + periodMs : m) / periodMs;
}

/**
 * 点滅の不透明度（`BLINK_MIN_ALPHA`..1）。三角波なので周期の切れ目で飛ばない。
 * CSS アニメーションではなく値で返すのは、canvas（戦域指令ビューの輪）と
 * DOM（バッジ）で**同じ位相**を使うため。
 */
export function blinkAlpha(nowMs: number, periodMs: number): number {
  const p = blinkPhase(nowMs, periodMs);
  const tri = p < 0.5 ? p * 2 : (1 - p) * 2; // 0 → 1 → 0
  return BLINK_MIN_ALPHA + (1 - BLINK_MIN_ALPHA) * tri;
}

/** 点滅が「今 点いている」か（DOM のクラス付け替え用）。 */
export function blinkOn(nowMs: number, periodMs: number): boolean {
  return blinkPhase(nowMs, periodMs) < 0.5;
}

/**
 * 今出ている警告を全部集める（**World は読むだけ**）。
 *
 * 並び順は固定（赤 → 橙 → 黄、同じ色の中は戦域スロット昇順 / 格子座標昇順）。
 * `Space` の巡回順がフレームごとに揺れると「押しても同じ場所に戻る」ので、
 * 並びを決定的にしておくことが仕様（`06§4`「往復用」）の前提になる。
 */
export function collectWarnings(w: World, viewer: PlayerId): Warning[] {
  const out: Warning[] = [];

  // ---- 赤: 戦域が崩れかけ（輪が点滅し始めた戦域と同じ判定。`05§7-3`） ----
  for (const f of ownFronts(w, viewer)) {
    if (!isFrontWarning(f)) continue;
    out.push({
      id: `front:${f.slot}`,
      kind: WarnKind.FrontCollapse,
      level: WARN_LEVEL[WarnKind.FrontCollapse],
      label: `戦域 ${frontShape(f.slot)}${f.slot} が崩れかけ`,
      x: f.x / FX_ONE,
      y: f.y / FX_ONE,
      slot: f.slot,
    });
  }

  // ---- 橙: 村人が攻撃されている（近い村人は格子で 1 件に畳む） ----
  const e = w.entities;
  /** 格子キー → 合計座標と人数。反復順は昇順に並べ直すので Map でよい。 */
  const clusters = new Map<string, { sx: number; sy: number; n: number; gx: number; gy: number }>();
  for (let i = 0; i < e.highWater; i++) {
    if (e.alive[i] !== 1) continue;
    if (e.kind[i] !== EntityKind.Unit) continue;
    if (e.owner[i] !== viewer) continue;
    const t = e.lastDamagedTick[i]!;
    if (t === NO_DAMAGE_TICK) continue;
    if (w.tick - t > VILLAGER_ATTACK_WINDOW_TICKS) continue;
    if (!isVillagerRole(unitDef(e.typeId[i]!).roleIdx)) continue;
    const tx = e.x[i]! / FX_ONE;
    const ty = e.y[i]! / FX_ONE;
    const gx = Math.floor(tx / VILLAGER_CLUSTER_TILES);
    const gy = Math.floor(ty / VILLAGER_CLUSTER_TILES);
    const key = `${gy},${gx}`;
    const hit = clusters.get(key);
    if (hit === undefined) clusters.set(key, { sx: tx, sy: ty, n: 1, gx, gy });
    else {
      hit.sx += tx;
      hit.sy += ty;
      hit.n++;
    }
  }
  // (gy, gx) 昇順に整列（手順書 §16-2 と同じ全順序の考え方）
  const keys = [...clusters.keys()].sort((a, b) => {
    const ca = clusters.get(a)!;
    const cb = clusters.get(b)!;
    return ca.gy - cb.gy || ca.gx - cb.gx;
  });
  for (const key of keys) {
    const c = clusters.get(key)!;
    out.push({
      id: `villagers:${c.gy},${c.gx}`,
      kind: WarnKind.VillagerAttacked,
      level: WARN_LEVEL[WarnKind.VillagerAttacked],
      label: `村人 ${c.n} 人が被害`,
      x: c.sx / c.n,
      y: c.sy / c.n,
      slot: 0,
    });
  }

  // ---- 黄: 人口上限 ----
  const pl = getPlayer(w, viewer);
  if (pl !== undefined && pl.popCap > 0 && pl.pop >= pl.popCap) {
    out.push({
      id: 'popCap',
      kind: WarnKind.PopCap,
      level: WARN_LEVEL[WarnKind.PopCap],
      label: `人口上限 ${pl.pop}/${pl.popCap}`,
      // 家を建てる場所を探しに行くので本陣へ飛ばす（本陣は動かない。`05§7-4`）
      x: homeCampX(w, viewer) / FX_ONE,
      y: homeCampY(w, viewer) / FX_ONE,
      slot: 0,
    });
  }

  return out;
}

/**
 * `Space`（次の警告へ）の巡回。
 *
 * `lastId` が消えていても**先頭に戻るのではなく順序を保つ**ようにしたいので、
 * 見つからないときは先頭を返す（`06§4` の「警告を見て、元の作業に帰る」往復は
 * `Backspace` = カメラ履歴が担当するので、ここでは単純な巡回でよい）。
 */
export function pickNextWarning(list: readonly Warning[], lastId: string | null): Warning | null {
  if (list.length === 0) return null;
  if (lastId === null) return list[0]!;
  const i = list.findIndex((wn) => wn.id === lastId);
  if (i < 0) return list[0]!;
  return list[(i + 1) % list.length]!;
}

/** 警告 → ジャンプ先の座標（マス単位）。キー結線側が使う。 */
export function warningTarget(wn: Warning): { x: number; y: number } {
  return { x: wn.x, y: wn.y };
}

// ---------------------------------------------------------------- DOM

/** 警告システムが外に触るための窓口。 */
export interface WarningContext {
  world(): World;
  readonly viewer: PlayerId;
  /** その場所へ飛ぶ（マス単位）。`CameraController.jumpTo` をそのまま渡せばよい。 */
  jumpTo(tileX: number, tileY: number): void;
  /** バッジのクリックで戦域も選択したいとき（`06§4` の「選択状態になります」）。 */
  selectFront?(slot: number): void;
}

/** 警告を集め直す間隔（ms）。毎フレーム全エンティティを走査しない。 */
const SCAN_INTERVAL_MS = 200;

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
 * 画面の縁のバッジ列 + 縁の枠。
 *
 * 位置は**左端の中央に固定**（`05§1` / 手順書 §16-10）。
 * 上端左 = 資源 / 右端 = 戦域スロット / 下端 = 選択とコマンド が埋まっているので、
 * 唯一空いている辺に置く。ここも一度決めたら動かさない。
 */
export class WarningSystem {
  /** 音（M17）を鳴らす口。**ここでは鳴らさない**。親が差し替える。 */
  onSound: ((wn: Warning) => void) | null = null;

  private readonly ctx: WarningContext;
  private readonly root: HTMLElement;
  private readonly frame: HTMLElement;
  private readonly badgeWrap: HTMLElement;
  /** id → バッジ要素（作り直すと点滅の位相が飛ぶので使い回す）。 */
  private readonly badges = new Map<string, HTMLButtonElement>();
  /** id → 初回検出時刻（ms）。 */
  private readonly sinceMs = new Map<string, number>();

  private warnings: Warning[] = [];
  private lastScanMs = -1e9;
  private lastId: string | null = null;

  constructor(overlay: HTMLElement, ctx: WarningContext) {
    this.ctx = ctx;
    this.root = el('div', 'mt-warn');
    // 画面全体を囲む縁（`05§6` の「画面の縁に赤いバッジ」の“縁”の部分）。
    this.frame = el('div', 'mt-warn-frame');
    this.badgeWrap = el('div', 'mt-warn-badges');
    this.root.appendChild(this.badgeWrap);
    overlay.appendChild(this.frame);
    overlay.appendChild(this.root);
  }

  /** 今出ている警告（経過時間つき）。リプレイ・テスト・親の結線から読む。 */
  list(): ActiveWarning[] {
    const now = this.lastScanMs;
    return this.warnings.map((wn) => {
      const since = this.sinceMs.get(wn.id) ?? now;
      const ageMs = Math.max(0, now - since);
      return { ...wn, sinceMs: since, ageMs, periodMs: blinkPeriodMs(ageMs) };
    });
  }

  /** 警告が 1 件も無いか。 */
  isEmpty(): boolean {
    return this.warnings.length === 0;
  }

  /**
   * 次の警告を選ぶ（**カメラは動かさない**）。`Space` の実装が座標だけ欲しいとき用。
   */
  next(): Warning | null {
    const wn = pickNextWarning(this.warnings, this.lastId);
    if (wn === null) return null;
    this.lastId = wn.id;
    return wn;
  }

  /**
   * `Space` と同じ動作: 次の警告へ飛ぶ。戻り値は**ジャンプ先の座標**（無ければ null）。
   * 直前の視点へは `Backspace`（`CameraController.back`）で戻れる（`06§4`）。
   */
  jumpToNext(): { x: number; y: number; warning: Warning } | null {
    const wn = this.next();
    if (wn === null) return null;
    return this.jumpTo(wn);
  }

  /** 指定の警告へ飛ぶ（バッジのクリックと同じ）。 */
  jumpTo(wn: Warning): { x: number; y: number; warning: Warning } {
    const t = warningTarget(wn);
    this.ctx.jumpTo(t.x, t.y);
    if (wn.slot > 0) this.ctx.selectFront?.(wn.slot);
    this.lastId = wn.id;
    return { x: t.x, y: t.y, warning: wn };
  }

  /** 毎フレーム呼ぶ（走査は間引き、点滅だけ毎フレーム更新する）。 */
  update(nowMs: number): void {
    if (nowMs - this.lastScanMs >= SCAN_INTERVAL_MS) {
      this.lastScanMs = nowMs;
      this.rescan(nowMs);
    }
    this.animate(nowMs);
  }

  /** 片付け。 */
  destroy(): void {
    this.root.remove();
    this.frame.remove();
    this.badges.clear();
    this.sinceMs.clear();
  }

  // ------------------------------------------------------------ 内部

  private rescan(nowMs: number): void {
    const next = collectWarnings(this.ctx.world(), this.ctx.viewer);
    const seen = new Set<string>();
    for (const wn of next) {
      seen.add(wn.id);
      if (!this.sinceMs.has(wn.id)) {
        this.sinceMs.set(wn.id, nowMs);
        // 3 重通知の 2 つ目（音）。M17 が実装を差すまでは口だけ。
        this.onSound?.(wn);
      }
      this.ensureBadge(wn);
    }
    // 消えた警告は畳む（初回検出時刻も忘れる = 再発したら点滅がまた遅くなる）
    for (const [id, node] of [...this.badges]) {
      if (seen.has(id)) continue;
      node.remove();
      this.badges.delete(id);
      this.sinceMs.delete(id);
    }
    this.warnings = next;
    // バッジの並びを collectWarnings の順（赤 → 橙 → 黄）に揃える
    for (const wn of next) {
      const node = this.badges.get(wn.id);
      if (node !== undefined) this.badgeWrap.appendChild(node);
    }
  }

  private ensureBadge(wn: Warning): void {
    let node = this.badges.get(wn.id);
    if (node === undefined) {
      node = el('button', 'mt-warn-badge');
      node.type = 'button';
      node.append(el('span', 'mt-warn-mark', ''), el('span', 'mt-warn-text', ''));
      // クリックでその場所へ飛ぶ（`Space` と同じ。マウスのみで完結。`06§12`）
      node.addEventListener('click', () => {
        const cur = this.warnings.find((x) => x.id === wn.id);
        if (cur !== undefined) this.jumpTo(cur);
      });
      this.badges.set(wn.id, node);
      this.badgeWrap.appendChild(node);
    }
    const color = WARN_COLOR[wn.level];
    node.style.borderColor = color;
    node.style.color = color;
    node.classList.toggle('mt-warn-red', wn.level === 'red');
    const mark = node.querySelector('.mt-warn-mark');
    const text = node.querySelector('.mt-warn-text');
    // 色に頼らない手がかり: 戦域なら旗の形 + 番号、それ以外は記号（`06§12`）
    if (mark !== null) {
      mark.textContent = wn.slot > 0 ? `${frontShape(wn.slot)}${wn.slot}` : markOf(wn.kind);
      (mark as HTMLElement).style.color = wn.slot > 0 ? frontColor(wn.slot) : color;
    }
    if (text !== null) text.textContent = wn.label;
    node.title = `${wn.label} — クリック（または Space）でその場所へ`;
  }

  /** 点滅（毎フレーム）。放置時間が長い警告ほど速く点く。 */
  private animate(nowMs: number): void {
    let worst: WarnLevel | null = null;
    let worstAlpha = 0;
    for (const wn of this.warnings) {
      const node = this.badges.get(wn.id);
      if (node === undefined) continue;
      const ageMs = Math.max(0, nowMs - (this.sinceMs.get(wn.id) ?? nowMs));
      const alpha = blinkAlpha(nowMs, blinkPeriodMs(ageMs));
      node.style.opacity = alpha.toFixed(3);
      if (wn.level === 'red' && (worst !== 'red' || alpha > worstAlpha)) {
        worst = 'red';
        worstAlpha = alpha;
      } else if (worst === null) {
        worst = wn.level;
        worstAlpha = alpha;
      }
    }
    if (worst === null) {
      this.frame.style.opacity = '0';
      return;
    }
    // 縁の枠は赤の警告があるときだけはっきり出す（`05§15`「赤いバッジ」）
    this.frame.style.boxShadow = `inset 0 0 40px 8px ${WARN_COLOR[worst]}`;
    this.frame.style.opacity = (worst === 'red' ? worstAlpha : worstAlpha * 0.45).toFixed(3);
  }
}

/** 種類 → 色に頼らない記号。 */
function markOf(kind: WarnKindId): string {
  if (kind === WarnKind.VillagerAttacked) return '人';
  if (kind === WarnKind.PopCap) return '満';
  return '!';
}
