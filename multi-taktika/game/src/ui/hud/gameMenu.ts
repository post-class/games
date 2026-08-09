/**
 * ui/hud/gameMenu.ts — 試合中のメニューと一時停止（`06§11` の F10 / Pause）
 *
 * ■ 資料の定め（`06§11` の表）
 *   `F10`    メニュー（設定・投了・退出）。**投了＝服属。キャンペーンでは分岐に進む**
 *   `Pause`  一時停止。**キャンペーンとスカーミッシュのみ。オンラインでは効かない**
 *
 * ■ なぜ「投了」が要るのか
 * `03§10` は勝敗の 3 通りのうち 1 つを「服属 ― 相手が旗を巻いて降伏する」と定めている。
 * つまり**投了は負け方の 1 つとして仕様に入っている**。押す手段が無いと、
 * 勝てない試合を畳めないし、キャンペーンの分岐（服属ルート）にも入れない。
 * `02` の「この世界に滅亡はない」を成立させる操作でもある。
 *
 * ■ 一時停止をオンラインで効かせない理由
 * ロックステップは全端末が同じ tick を同じ順で進める前提なので、
 * 1 人が止めれば**全員が止まる**（＝止めた人が有利になる）。だから通信中は無効。
 * 資料の「オンラインでは効きません」はこの理由。
 *
 * ■ 層
 * ui 層。sim を変えるのは `Command`（`resign`）だけ。
 * 一時停止は**シムを進めないだけ**で、World には何も書かない
 * （World に「止まっている」状態を持たせると hash に入れる必要が出てデシンクの種になる）。
 */

import '@/styles/gameMenu.css';

import type { Command } from '@/sim/command';
import type { PlayerId } from '@/shared/types';
import { el, button } from '@/ui/screens/router';

/** メニューの結線先。 */
export interface GameMenuContext {
  readonly viewer: PlayerId;
  /** `Command` を積む（`resign` を出すのに使う）。 */
  emit(cmd: Command): void;
  /** 設定画面へ（試合を抜ける）。 */
  openSettings(): void;
  /** タイトルへ戻る（退出）。 */
  leave(): void;
  /** オンライン対戦中か（一時停止を無効にする）。 */
  isOnline(): boolean;
}

/** キー 1 つ → やること。`06§11` の表をそのまま関数にしたもの（テスト対象）。 */
export type GameMenuAction = 'toggleMenu' | 'togglePause' | 'close' | null;

/**
 * `F10` = メニュー開閉 / `Pause` = 一時停止 / `Escape` = 開いていれば閉じる。
 *
 * `Escape` はパネルを閉じるキー（`06§4`）なので、メニューが開いているときだけ拾う
 * （開いていないときに奪うと他のパネルが閉じられなくなる）。
 */
export function gameMenuKeyAction(key: string, menuOpen: boolean): GameMenuAction {
  if (key === 'F10') return 'toggleMenu';
  if (key === 'Pause') return 'togglePause';
  if (key === 'Escape' && menuOpen) return 'close';
  return null;
}

/** 一時停止できるか（`06§11`「オンラインでは効きません」）。 */
export function canPause(isOnline: boolean): boolean {
  return !isOnline;
}

/** 一時停止の表示文（押す前に何が起きるか分かる言い方にする）。 */
export function pauseLabel(paused: boolean, isOnline: boolean): string {
  if (isOnline) return '一時停止（オンラインでは使えません）';
  return paused ? '再開する' : '一時停止';
}

export class GameMenu {
  private readonly root: HTMLElement;
  private readonly pauseBtn: HTMLButtonElement;
  /** 投了の確認中か（**1 回押しただけでは負けない**）。 */
  private confirming = false;
  private readonly confirmRow: HTMLElement;
  private readonly resignBtn: HTMLButtonElement;

  private open = false;
  private paused = false;

  constructor(
    overlay: HTMLElement,
    private readonly ctx: GameMenuContext,
  ) {
    this.root = el('div', 'mt-gmenu');
    this.root.hidden = true;

    const box = el('div', 'mt-gmenu-box');
    box.appendChild(el('div', 'mt-gmenu-title', 'メニュー'));

    this.pauseBtn = button('mt-btn mt-gmenu-item', '一時停止', () => this.togglePause());
    box.appendChild(this.pauseBtn);
    box.appendChild(button('mt-btn mt-gmenu-item', '設定', () => this.ctx.openSettings()));

    // ---- 投了（＝服属）----
    this.resignBtn = button('mt-btn mt-gmenu-item mt-gmenu-resign', '投了する（服属）', () =>
      this.askResign(),
    );
    box.appendChild(this.resignBtn);
    this.confirmRow = el('div', 'mt-gmenu-confirm');
    this.confirmRow.hidden = true;
    this.confirmRow.appendChild(
      el(
        'p',
        'mt-gmenu-note',
        '旗を巻いて相手に服属します。滅亡ではないので、キャンペーンでは次の話へ続きます。',
      ),
    );
    const row = el('div', 'mt-gmenu-row');
    row.append(
      button('mt-btn mt-gmenu-yes', '服属する', () => this.doResign()),
      button('mt-btn', 'やめる', () => this.cancelResign()),
    );
    this.confirmRow.appendChild(row);
    box.appendChild(this.confirmRow);

    box.appendChild(button('mt-btn mt-gmenu-item', '退出（タイトルへ）', () => this.ctx.leave()));

    box.appendChild(el('p', 'mt-gmenu-hint', 'F10 で閉じる / Esc でも閉じます'));
    this.root.appendChild(box);
    // 外側を押しても閉じる（`06§11` の「パネルの外側をクリック」と同じ作法）
    this.root.addEventListener('pointerdown', (ev) => {
      if (ev.target === this.root) this.setOpen(false);
    });
    overlay.appendChild(this.root);
    this.syncPauseBtn();
  }

  /** 一時停止中か（`main.ts` のループがこれを見てシムを進めない）。 */
  isPaused(): boolean {
    return this.paused;
  }

  isOpen(): boolean {
    return this.open;
  }

  setOpen(open: boolean): void {
    this.open = open;
    this.root.hidden = !open;
    if (!open) this.cancelResign();
  }

  toggle(): void {
    this.setOpen(!this.open);
  }

  togglePause(): void {
    if (!canPause(this.ctx.isOnline())) return;
    this.paused = !this.paused;
    this.syncPauseBtn();
  }

  /** キー入力を渡す。処理したら true（呼び出し側が `preventDefault` する）。 */
  handleKey(key: string): boolean {
    const action = gameMenuKeyAction(key, this.open);
    if (action === null) return false;
    if (action === 'toggleMenu') this.toggle();
    else if (action === 'togglePause') this.togglePause();
    else this.setOpen(false);
    return true;
  }

  destroy(): void {
    this.root.remove();
  }

  private syncPauseBtn(): void {
    const online = this.ctx.isOnline();
    this.pauseBtn.textContent = pauseLabel(this.paused, online);
    this.pauseBtn.disabled = !canPause(online);
    this.root.classList.toggle('is-paused', this.paused);
  }

  private askResign(): void {
    this.confirming = true;
    this.confirmRow.hidden = false;
    this.resignBtn.hidden = true;
  }

  private cancelResign(): void {
    this.confirming = false;
    this.confirmRow.hidden = true;
    this.resignBtn.hidden = false;
  }

  private doResign(): void {
    if (!this.confirming) return;
    this.ctx.emit({ t: 'resign', p: this.ctx.viewer });
    this.cancelResign();
    this.setOpen(false);
    // 一時停止したまま投了すると決着の tick が進まないので解除する。
    this.paused = false;
    this.syncPauseBtn();
  }
}
