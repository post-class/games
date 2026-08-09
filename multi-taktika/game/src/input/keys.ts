/**
 * input/keys.ts — キーボード操作（`06§3` / `06§5` / `06§7`。T-M5-04 / 07）
 *
 * M5 で実装する範囲:
 *  | 矢印キー            | スクロール（押されている状態を `scrollKeys` で公開）      |
 *  | `F1`〜`F4`          | 視点の呼び出し（`Ctrl`+ で記憶）                          |
 *  | `Backspace`         | 直前の視点へ（連続で履歴を遡る）                          |
 *  | `H`                 | 町の中心へ（2 回で次の町の中心へ）                        |
 *  | `1`〜`6`            | 戦域を選択して視点移動（`Alt`+ は視点を動かさない）        |
 *  | `Shift`+`1`〜`6`    | 令をセット（`setOrder` Command。遅延は sim 側が持つ）      |
 *  | `7`〜`0`            | 部隊グループ（`Ctrl`+ 登録 / `Ctrl`+`Shift`+ 追加）        |
 *  | `Ctrl`+`A`          | 全戦闘ユニット（**戦域の兵は含めない**）                  |
 *  | `Ctrl`+`Shift`+`A`  | 戦域の兵も含める                                          |
 *  | `Esc`               | ①手動を令に戻す → ②選択解除（`06§3` の上から 1 つだけ）   |
 *  | `Space`             | 次の警告（崩れかけの戦域）へ                              |
 *  | `Tab`               | 戦域指令ビュー（M12）。ここではコールバックを呼ぶだけ     |
 *
 * **令の遅延を UI で隠したり先行反映してはいけない**（手順書 §16-4）。
 * ここは `setOrder` を送るだけで、届く時刻の判断は sim（`orderDelivery`）が持つ。
 */

import { ORDER_IDS, type OrderId } from '@/shared/types';
import { orderDefById } from '@/sim/core/defs';
import { isFrontWarning, ownFronts } from '@/sim/core/front';
import { FX_ONE } from '@/sim/core/fx';
import { MAX_FRONTS } from '@/sim/core/world';
import type { InputContext } from './env';
import { UNIT_GROUP_COUNT, selectAllCombatUnits } from './selection';

/** 押されている方向キー（`camera.update` に渡す）。 */
export interface ScrollKeyState {
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
}

/** `7`〜`0` → グループ番号 0..3（`06§3` の並び）。 */
const GROUP_KEYS = ['7', '8', '9', '0'] as const;

export class KeyboardInput {
  /** 押されている方向キー。 */
  readonly scrollKeys: ScrollKeyState = { left: false, right: false, up: false, down: false };
  /** 選択中の戦域スロット（1..6。0 = 未選択）。令をどの戦域に渡すかを決める。 */
  selectedFront = 0;
  /** `Tab`（戦域指令ビュー）を押されたときに呼ばれる。M12 で実装を差す。 */
  onToggleOverview: (() => void) | null = null;

  private detachFns: (() => void)[] = [];

  constructor(private readonly ctx: InputContext) {}

  // ------------------------------------------------------------ 判定（DOM 不要）

  /**
   * キーが押された。**戻り値 true なら既定動作を止める**（`preventDefault`）。
   *
   * @param key `KeyboardEvent.key`
   */
  onKeyDown(key: string, mods: { shift: boolean; ctrl: boolean; alt: boolean }): boolean {
    // ---- 方向キー ----
    switch (key) {
      case 'ArrowLeft':
        this.scrollKeys.left = true;
        return true;
      case 'ArrowRight':
        this.scrollKeys.right = true;
        return true;
      case 'ArrowUp':
        this.scrollKeys.up = true;
        return true;
      case 'ArrowDown':
        this.scrollKeys.down = true;
        return true;
      default:
        break;
    }

    // ---- 視点 ----
    if (key === 'Backspace') {
      this.ctx.cam.back();
      return true;
    }
    if (key === 'h' || key === 'H') {
      this.ctx.cam.home(this.ctx.world(), this.ctx.viewer);
      return true;
    }
    if (key === 'F1' || key === 'F2' || key === 'F3' || key === 'F4') {
      const slot = Number(key.slice(1)) - 1;
      if (mods.ctrl) this.ctx.cam.saveSlot(slot);
      else this.ctx.cam.recallSlot(slot);
      return true;
    }
    if (key === 'Tab') {
      this.onToggleOverview?.();
      return true;
    }

    // ---- 選択 ----
    if (key === 'a' || key === 'A') {
      if (!mods.ctrl) return false;
      // `Ctrl`+`A` は戦域の兵を含めない（手順書 §16-6）
      const ids = selectAllCombatUnits(this.ctx.world(), this.ctx.viewer, mods.shift);
      this.ctx.selection.set(ids);
      this.ctx.onChange?.();
      return true;
    }
    if (key === 'Escape') {
      this.escape();
      return true;
    }
    if (key === ' ') {
      this.jumpToNextWarning();
      return true;
    }

    // ---- 部隊グループ（`7`〜`0`） ----
    const gi = GROUP_KEYS.indexOf(key as (typeof GROUP_KEYS)[number]);
    if (gi >= 0 && gi < UNIT_GROUP_COUNT) {
      if (mods.ctrl && mods.shift) this.ctx.selection.addToGroup(gi);
      else if (mods.ctrl) this.ctx.selection.setGroup(gi);
      else {
        const r = this.ctx.selection.recallGroup(gi);
        if (r.ok && r.jump) this.jumpToSelection();
      }
      this.ctx.onChange?.();
      return true;
    }

    // ---- 戦域（`1`〜`6`）と令（`Shift`+`1`〜`6`） ----
    const n = Number(key);
    if (Number.isInteger(n) && n >= 1 && n <= MAX_FRONTS) {
      if (mods.shift) this.setOrder(n);
      else this.selectFront(n, !mods.alt);
      return true;
    }
    return false;
  }

  /** キーが離された。 */
  onKeyUp(key: string): void {
    switch (key) {
      case 'ArrowLeft':
        this.scrollKeys.left = false;
        break;
      case 'ArrowRight':
        this.scrollKeys.right = false;
        break;
      case 'ArrowUp':
        this.scrollKeys.up = false;
        break;
      case 'ArrowDown':
        this.scrollKeys.down = false;
        break;
      default:
        break;
    }
  }

  /** 押しっぱなしの状態を全部落とす（ウィンドウがフォーカスを失ったとき）。 */
  releaseAll(): void {
    this.scrollKeys.left = false;
    this.scrollKeys.right = false;
    this.scrollKeys.up = false;
    this.scrollKeys.down = false;
  }

  /**
   * `Esc`（`06§3`「上から 1 つだけ実行」）。
   * M5 では ②手動操作を令に戻す → ③選択解除 の 2 段だけ実装する
   * （①パネルを閉じる・④メニューは M12）。
   */
  escape(): void {
    const sel = this.ctx.selection;
    if (sel.size() > 0) {
      this.ctx.emit({ t: 'releaseManual', p: this.ctx.viewer, units: [...sel.list()] });
      sel.clear();
      this.ctx.onChange?.();
    }
  }

  /**
   * 戦域を選ぶ（`1`〜`6`）。空きスロットは無反応（`06§1`）。
   * @param moveCamera false なら視点を動かさない（`Alt`+`1`〜`6`）
   */
  selectFront(slot: number, moveCamera: boolean): boolean {
    const w = this.ctx.world();
    const f = ownFronts(w, this.ctx.viewer).find((x) => x.slot === slot);
    if (f === undefined) return false;
    this.selectedFront = slot;
    if (moveCamera) this.ctx.cam.jumpTo(f.x / FX_ONE, f.y / FX_ONE);
    this.ctx.onChange?.();
    return true;
  }

  /**
   * 令をセットする（`Shift`+`1`〜`6`）。
   * 選択中の戦域が無ければ、番号に対応する戦域が立っていればそこへ渡す。
   */
  setOrder(orderNumber: number): boolean {
    const w = this.ctx.world();
    const fronts = ownFronts(w, this.ctx.viewer);
    const slot = this.selectedFront > 0 ? this.selectedFront : 0;
    const target = fronts.find((f) => f.slot === slot);
    if (target === undefined) return false;
    const id = ORDER_IDS[orderNumber - 1] as OrderId | undefined;
    if (id === undefined) return false;
    const def = orderDefById(id);
    this.ctx.emit({ t: 'setOrder', p: this.ctx.viewer, front: target.slot, order: id, tier: def.tier });
    return true;
  }

  /** `Space`: 次の警告（崩れかけの戦域）へ飛ぶ。 */
  jumpToNextWarning(): boolean {
    const w = this.ctx.world();
    const warn = ownFronts(w, this.ctx.viewer).filter(isFrontWarning);
    if (warn.length === 0) return false;
    const f = warn[0]!;
    this.selectedFront = f.slot;
    this.ctx.cam.jumpTo(f.x / FX_ONE, f.y / FX_ONE);
    this.ctx.onChange?.();
    return true;
  }

  /** 選択している部隊の重心へ視点を飛ばす（グループの 2 回押し）。 */
  jumpToSelection(): boolean {
    const w = this.ctx.world();
    const e = w.entities;
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (const id of this.ctx.selection.list()) {
      const i = id & 0xffff;
      if (i >= e.highWater || e.alive[i] !== 1) continue;
      sx += e.x[i]!;
      sy += e.y[i]!;
      n++;
    }
    if (n === 0) return false;
    this.ctx.cam.jumpTo(sx / n / FX_ONE, sy / n / FX_ONE);
    return true;
  }

  // ------------------------------------------------------------ DOM 結線

  /** window にイベントを繋ぐ。戻り値を呼ぶと外れる。 */
  attach(target: Window = window): () => void {
    const onDown = (ev: KeyboardEvent): void => {
      // 入力欄にフォーカスがあるときは邪魔しない
      const t = ev.target as { tagName?: string } | null;
      if (t?.tagName === 'INPUT' || t?.tagName === 'TEXTAREA') return;
      const handled = this.onKeyDown(ev.key, {
        shift: ev.shiftKey,
        ctrl: ev.ctrlKey || ev.metaKey,
        alt: ev.altKey,
      });
      if (handled) ev.preventDefault();
    };
    const onUp = (ev: KeyboardEvent): void => this.onKeyUp(ev.key);
    const onBlur = (): void => this.releaseAll();

    target.addEventListener('keydown', onDown);
    target.addEventListener('keyup', onUp);
    target.addEventListener('blur', onBlur);
    const detach = (): void => {
      target.removeEventListener('keydown', onDown);
      target.removeEventListener('keyup', onUp);
      target.removeEventListener('blur', onBlur);
    };
    this.detachFns.push(detach);
    return detach;
  }

  detachAll(): void {
    for (const f of this.detachFns) f();
    this.detachFns = [];
  }
}
