/**
 * 右下の丸いアクションボタン3つ（E-2）
 *
 * 宣伝資料 `docs/01_ゲーム宣伝用資料/images/screen-talk.png` の**右下の3つの丸ボタン**を作る。
 * 撫でる（肉球）／水やり（じょうろ）／収穫（かご）で、
 * ねらいは「**キー操作（B/F/L やクリック）を知らなくてもタッチだけで遊べる**」こと。
 *
 * ## 設計の判断
 *
 * - サーバ機能は増やさない。既存の `interact` をそのまま送る
 *   （`{ t:'interact', targetId, act:'pet'|'water'|'harvest' }`）
 * - **押す前に押せるか分かるようにする。** 実装済みの経路では、遠い対象に対して
 *   押してから「遠くて手がとどきません」の警告が返ってくるだけで、事前に分からなかった
 * - 距離のしきい値は**サーバと合わせる**（ペット1.2 / 資源2）。
 *   クライアントが甘い値を持つと「押せたのに警告が返る」ことになり、
 *   厳しい値を持つと「サーバは受けるのに押せない」ことになる
 * - `main.ts` は配線の集約点で衝突しやすいため、**依存は注入**にした（`ActionButtonsDeps`）。
 *   対象の探索は純粋関数（`pickPetTarget` / `pickResourceTarget`）に切り出してテストしている
 * - 判定は `update()` を毎フレーム呼ぶ形にした。イベント駆動にすると
 *   「歩いて範囲に入った」を拾う経路（移動・delta受信・予測移動）が3つに散る。
 *   DOMの書き換えは**状態が変わったフレームだけ**なので毎フレームでも負荷は増えない（AI_CODING §12）
 *
 * ## 落とし穴
 *
 * - **`.hud` に `pointer-events: none` が掛かっている**（AI_CODING §7 / M8申し送り2）。
 *   親に `#hud` を渡されてもクリックが canvas に取られないよう、ボタン側で `auto` を明示している
 * - スマホでは `touchPad` の設置ボタンが同じ右下に出る。重ならないよう
 *   `body.has-pad` のときは**縦並びにして上へ逃がす**（CSSは `style.css` の `.actions`）
 *
 * 制約: parameter property 禁止 / enum 禁止 / 相対import は `.ts` 込み
 */

/** ボタンの種類。`interact` の `act` と同じ値にしてそのまま送る */
export type ActionKind = 'pet' | 'water' | 'harvest';

/** 表示順（宣伝資料の左から: 肉球・じょうろ・かご） */
export const ACTION_ORDER: readonly ActionKind[] = ['pet', 'water', 'harvest'];

/**
 * ペットに触れる距離（タイル）。
 * `main.ts` のクリック判定と同じ 1.2（サーバの `petAction.ts` の `ACT_RANGE` も 1.2）
 */
export const PET_REACH = 1.2;
/** 資源に手が届く距離（タイル）。サーバ `sim/interact.ts` の `INTERACT_RANGE` と同じ 2 */
export const RESOURCE_REACH = 2;
/**
 * 連打を抑える間隔（ms）。
 * サーバの `INTERACT_COOLDOWN_TICKS`（= TICK_HZ 4tick = 1秒）と同じにしている。
 * これが無いと押しっぱなしで警告（`rate`）だけが通知欄に積もる。
 */
export const INTERACT_COOLDOWN_MS = 1000;

/** 収穫できる資源の種類。サーバ `interact.ts` の `HARVESTABLE` と同じ */
export const HARVESTABLE_TYPES: ReadonlySet<string> = new Set(['berry_tree', 'field', 'fishing_spot']);
/** 水やりできる資源の種類。サーバ `interact.ts` の `WATERABLE` と同じ */
export const WATERABLE_TYPES: ReadonlySet<string> = new Set(['field', 'berry_tree']);
/** これ未満の在庫は「もう採れない」。サーバ `MIN_HARVESTABLE` と同じ */
export const MIN_HARVESTABLE = 1;

/** 位置だけを見る最小の型（`ActorView` / `ResourceView` の両方が満たす） */
export interface PointLike {
  x: number;
  y: number;
}

/** 対象になれる資源（`state/world.ts` の `ResourceView` がそのまま入る） */
export interface ResourceLike extends PointLike {
  id: number;
  type: string;
  amount: number;
}

/** 選ばれた資源。`type` は判定の精度を上げるための任意項目 */
export interface ResourceTarget {
  id: number;
  amount: number;
  type?: string;
}

/** 押せない理由。ツールチップの文言と `data-reason`（E2E/デバッグ用）に使う */
export type DisabledReason = 'ok' | 'no_target' | 'empty' | 'cooldown';

/** ボタン1つの状態 */
export interface ActionState {
  act: ActionKind;
  enabled: boolean;
  /** 送信に使う対象ID。押せないときは null になり得る */
  targetId: number | null;
  reason: DisabledReason;
}

export interface ActionButtonsDeps {
  /** 撫でられるペットの entityId。範囲外・不在なら null */
  petTarget: () => number | null;
  /**
   * その行動の対象になる資源。範囲内に無ければ null。
   * `act` を見て「収穫できるもの／水をやれるもの」を選び分けられるようにしている
   * （いちばん近い資源を1つ返す作りだと、手前の空の畑が奥の木の実を隠してしまう）。
   * 引数を使わない実装（`() => ...`）を渡してもよい。
   */
  resourceTarget: (act: 'water' | 'harvest') => ResourceTarget | null;
  send: (msg: { t: 'interact'; targetId: number; act: ActionKind }) => void;
  /** 案内（チュートリアル）と効果音のフック。押せたときだけ呼ぶ */
  onUsed?: (act: ActionKind) => void;
  /** テスト用の時計。既定は `performance.now()` */
  now?: () => number;
}

// ---------- 純粋関数（テスト対象） ----------

/** タイル座標の距離 */
export function tileDistance(a: PointLike, b: PointLike): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * 撫でられるペットを選ぶ。範囲外・不在なら null。
 * ペットは1匹なので「いちばん近い」ではなく距離判定だけでよい。
 */
export function pickPetTarget(
  self: PointLike,
  pet: (PointLike & { id: number }) | null,
  reach: number = PET_REACH,
): number | null {
  if (!pet) return null;
  return tileDistance(self, pet) <= reach ? pet.id : null;
}

/**
 * その行動の対象になる、いちばん近い資源を選ぶ。
 *
 * **行動ごとに絞ってから距離で選ぶ**のが要点。
 * 「いちばん近い資源」を先に決めてしまうと、目の前の水場や空の畑が
 * 少し奥の収穫できる木を隠してしまい、収穫ボタンが押せないように見える。
 */
export function pickResourceTarget(
  act: 'water' | 'harvest',
  self: PointLike,
  resources: Iterable<ResourceLike>,
  reach: number = RESOURCE_REACH,
): ResourceTarget | null {
  let best: ResourceTarget | null = null;
  let bestD = reach;
  for (const r of resources) {
    if (act === 'harvest') {
      if (!HARVESTABLE_TYPES.has(r.type) || r.amount < MIN_HARVESTABLE) continue;
    } else if (!WATERABLE_TYPES.has(r.type)) continue;
    const d = tileDistance(self, r);
    if (d <= bestD) {
      bestD = d;
      best = { id: r.id, amount: r.amount, type: r.type };
    }
  }
  return best;
}

/**
 * ボタン1つの状態を決める。
 *
 * `type` が入っていない対象（種類を渡さない簡易な `deps` 実装）でも壊れないよう、
 * 種類の判定は「分かっているときだけ」効かせる。
 */
export function resolveAction(
  act: ActionKind,
  targets: { pet: number | null; resource: ResourceTarget | null },
  timing?: { nowMs: number; cooldownUntilMs: number },
): ActionState {
  if (act === 'pet') {
    // 撫でるはサーバ側にクールダウンが無い（なつき度+1が上限100で止まるだけ）
    const id = targets.pet;
    return { act, enabled: id !== null, targetId: id, reason: id === null ? 'no_target' : 'ok' };
  }

  const res = targets.resource;
  if (!res) return { act, enabled: false, targetId: null, reason: 'no_target' };
  if (act === 'harvest') {
    if (res.type !== undefined && !HARVESTABLE_TYPES.has(res.type)) {
      return { act, enabled: false, targetId: null, reason: 'no_target' };
    }
    if (res.amount < MIN_HARVESTABLE) {
      return { act, enabled: false, targetId: res.id, reason: 'empty' };
    }
  } else if (res.type !== undefined && !WATERABLE_TYPES.has(res.type)) {
    return { act, enabled: false, targetId: null, reason: 'no_target' };
  }

  if (timing && timing.nowMs < timing.cooldownUntilMs) {
    return { act, enabled: false, targetId: res.id, reason: 'cooldown' };
  }
  return { act, enabled: true, targetId: res.id, reason: 'ok' };
}

/** ボタンの名前（読み上げとツールチップの主部） */
export function actionLabel(act: ActionKind): string {
  return act === 'pet' ? 'なでる' : act === 'water' ? 'みずやり' : 'しゅうかく';
}

/** ツールチップの文。押せない理由を**押す前に**日本語で見せる */
export function actionTitle(state: ActionState): string {
  const name = actionLabel(state.act);
  switch (state.reason) {
    case 'ok':
      return name;
    case 'empty':
      return `${name}（もう採れるものがありません）`;
    case 'cooldown':
      return `${name}（すこし待ってください）`;
    default:
      return state.act === 'pet' ? `${name}（ペットに近づいてください）` : `${name}（近くに対象がありません）`;
  }
}

// ---------- アイコン ----------
// 絵文字は端末ごとに形が変わるのでSVGで描く（petGauge.ts と同じ方針）。
// 色は 04_スタイルガイド.md のパレット（--purple-dp / --sky / --ink）から採る。

const ICON_PAW =
  '<svg viewBox="0 0 24 24" aria-hidden="true">' +
  '<g fill="#7c63c4" stroke="#4a3b2a" stroke-width="1.3" stroke-linejoin="round">' +
  '<path d="M12 12.4c3.2 0 5.4 2.2 5.4 4.3 0 1.8-1.6 2.7-3 2.4-1.6-.4-3.2-.4-4.8 0' +
  '-1.4.3-3-.6-3-2.4 0-2.1 2.2-4.3 5.4-4.3Z"/>' +
  '<ellipse cx="6.6" cy="10.4" rx="2.1" ry="2.6"/><ellipse cx="17.4" cy="10.4" rx="2.1" ry="2.6"/>' +
  '<ellipse cx="9.7" cy="6.2" rx="1.9" ry="2.4"/><ellipse cx="14.3" cy="6.2" rx="1.9" ry="2.4"/>' +
  '</g></svg>';

const ICON_CAN =
  '<svg viewBox="0 0 24 24" aria-hidden="true">' +
  '<g stroke="#4a3b2a" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round">' +
  '<path d="M6 10h9v7a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2v-7Z" fill="#7c63c4"/>' +
  '<path d="M15 12l4-3v7l-4-2z" fill="#7c63c4"/>' +
  '<path d="M8.5 10V8.6a2.5 2.5 0 0 1 5 0V10" fill="none"/>' +
  '<path d="M20.4 5.2c.9 1.2.9 2.4 0 3.2" fill="none" stroke="#9fd8ee" stroke-width="1.6"/>' +
  '</g></svg>';

const ICON_BASKET =
  '<svg viewBox="0 0 24 24" aria-hidden="true">' +
  '<g stroke="#4a3b2a" stroke-width="1.3" stroke-linejoin="round">' +
  '<path d="M4.5 11h15l-1.4 7.2a2 2 0 0 1-2 1.6H7.9a2 2 0 0 1-2-1.6L4.5 11Z" fill="#e0a86a"/>' +
  '<rect x="3.4" y="9" width="17.2" height="2.6" rx="1.3" fill="#a8825c"/>' +
  '<path d="M8.4 9c0-2.6 1.6-4.4 3.6-4.4S15.6 6.4 15.6 9" fill="none"/>' +
  '</g></svg>';

const ICONS: Record<ActionKind, string> = { pet: ICON_PAW, water: ICON_CAN, harvest: ICON_BASKET };

// ---------- 本体 ----------

export class ActionButtons {
  private deps: ActionButtonsDeps;
  private root: HTMLElement;
  private buttons = new Map<ActionKind, HTMLButtonElement>();
  /** 直前に描いた状態。DOMの書き換えを変化時だけにするため持つ */
  private painted = new Map<ActionKind, string>();
  /** 資源へのインタラクトが再び押せるようになる時刻（ms） */
  private cooldownUntilMs = 0;
  private now: () => number;

  // 注意: Node の type-stripping で動かすため parameter property は使えない
  /**
   * @param parent 既定は `body`。`#hud` を渡してもよいが、
   *   `.hud` は `pointer-events: none` なのでボタン側で `auto` を明示している
   */
  constructor(deps: ActionButtonsDeps, parent?: HTMLElement | null) {
    this.deps = deps;
    this.now = deps.now ?? (() => performance.now());

    this.root = document.createElement('div');
    this.root.className = 'actions';
    this.root.dataset['testid'] = 'action-buttons';
    this.root.setAttribute('role', 'group');
    this.root.setAttribute('aria-label', 'アクション');
    this.root.innerHTML = ACTION_ORDER.map(
      (act) =>
        `<button class="act-btn" type="button" data-act="${act}" data-testid="act-${act}"` +
        ` aria-label="${actionLabel(act)}" title="${actionLabel(act)}">${ICONS[act]}</button>`,
    ).join('');

    (parent ?? document.body).appendChild(this.root);
    // チャット欄の幅を詰めるために使う（スマホで右下の列と重ならないようにする）
    document.body.classList.add('has-actions');

    for (const act of ACTION_ORDER) {
      const btn = this.root.querySelector(`[data-act="${act}"]`) as HTMLButtonElement;
      this.buttons.set(act, btn);
    }
    // 1か所で受ける（ボタンごとに登録しない）。SVGを踏んでも closest で拾える
    this.root.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement | null)?.closest('.act-btn') as HTMLButtonElement | null;
      const act = btn?.dataset['act'] as ActionKind | undefined;
      if (!act || !btn || btn.disabled) return;
      this.press(act);
    });

    this.update();
  }

  /** 毎フレーム呼ばれ、押せる／押せないを更新する */
  update(): void {
    const nowMs = this.now();
    const targets = { pet: this.deps.petTarget(), resource: null as ResourceTarget | null };
    for (const act of ACTION_ORDER) {
      if (act !== 'pet') targets.resource = this.deps.resourceTarget(act);
      const state = resolveAction(act, targets, { nowMs, cooldownUntilMs: this.cooldownUntilMs });
      this.paint(state);
    }
  }

  /**
   * ボタンを押したときの送信。
   * 押せない状態でも呼ばれ得る（キーボードのEnterなど）ので、ここでも状態を作り直して確認する。
   */
  press(act: ActionKind): boolean {
    const nowMs = this.now();
    const targets = {
      pet: act === 'pet' ? this.deps.petTarget() : null,
      resource: act === 'pet' ? null : this.deps.resourceTarget(act),
    };
    const state = resolveAction(act, targets, { nowMs, cooldownUntilMs: this.cooldownUntilMs });
    if (!state.enabled || state.targetId === null) {
      this.paint(state);
      return false;
    }
    this.deps.send({ t: 'interact', targetId: state.targetId, act });
    // 資源側だけサーバにクールダウンがある。撫でるは連打してよい
    if (act !== 'pet') this.cooldownUntilMs = nowMs + INTERACT_COOLDOWN_MS;
    this.deps.onUsed?.(act);
    this.update();
    return true;
  }

  /** ペットが居ないとき（タマゴ選択中）は列ごと隠す */
  setVisible(visible: boolean): void {
    this.root.classList.toggle('hidden', !visible);
  }

  destroy(): void {
    this.root.remove();
    document.body.classList.remove('has-actions');
  }

  /** DOMは状態が変わったときだけ書く（毎フレーム呼ばれるため） */
  private paint(state: ActionState): void {
    const btn = this.buttons.get(state.act);
    if (!btn) return;
    const key = `${state.enabled ? 1 : 0}:${state.reason}`;
    if (this.painted.get(state.act) === key) return;
    this.painted.set(state.act, key);
    btn.disabled = !state.enabled;
    btn.dataset['reason'] = state.reason;
    btn.title = actionTitle(state);
    btn.setAttribute('aria-label', actionTitle(state));
  }
}
