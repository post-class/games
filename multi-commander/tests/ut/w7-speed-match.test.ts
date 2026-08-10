/**
 * W7-4 目標速度へ同期（`;`）の計算と、W7-6 の CommsMenu 側の口。
 *
 * 検証するのは次の2点。
 * 1. `speedMatchThrottle()` が「最高速度に対する目標速度の割合」を返し、
 *    追いつけないときも 100% で止まる（アフターバーナーは自動化しない）
 * 2. `CommsMenu.invokeBaseItem()` が、メニューを開かずに基本項目（1..5）の
 *    action を `onPick` へ流す
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { speedMatchThrottle } from '../../src/sim/flight';
import { CommsMenu, type CommsAction } from '../../src/ui/CommsMenu';
import { installFakeDom, type FakeDom } from './fake-dom';

// ───────── ① 〜 ③ 速度設定の計算 ─────────

describe('speedMatchThrottle', () => {
  it('① 目標の速度 / 自機の最高速度 をそのまま速度設定にする', () => {
    expect(speedMatchThrottle(400, 240)).toBe(0.6);
    // 停止している目標に合わせれば 0%（減速の指示になる）
    expect(speedMatchThrottle(400, 0)).toBe(0);
  });

  it('② 目標が自機の最高速度より速いときは 100% で止める（AB は自動化しない）', () => {
    expect(speedMatchThrottle(400, 520)).toBe(1);
    expect(speedMatchThrottle(400, 400)).toBe(1);
  });

  it('③ 最高速度が 0 以下／値が取れないときは undefined（呼び出し側が案内を出す）', () => {
    expect(speedMatchThrottle(0, 240)).toBeUndefined();
    expect(speedMatchThrottle(-10, 240)).toBeUndefined();
    expect(speedMatchThrottle(Number.NaN, 240)).toBeUndefined();
    // 目標が無い＝速度が取れないときも案内へ回す
    expect(speedMatchThrottle(400, Number.NaN)).toBeUndefined();
  });

  it('負の速度でも 0..1 に収まる', () => {
    expect(speedMatchThrottle(400, -50)).toBe(0);
  });
});

// ───────── W7-6 メニューを開かずに命令する口 ─────────

describe('CommsMenu.invokeBaseItem', () => {
  let dom: FakeDom;
  let picked: CommsAction[];
  let menu: CommsMenu;

  beforeEach(() => {
    dom = installFakeDom();
    picked = [];
    menu = new CommsMenu(document.body as unknown as HTMLElement, (a) => picked.push(a));
  });
  afterEach(() => {
    menu.dispose();
    dom.restore();
  });

  it('0..4 が基本項目の action を onPick へ流す（メニューの並びと同じ順）', () => {
    for (let i = 0; i < 5; i += 1) {
      expect(menu.invokeBaseItem(i)).toBe(true);
    }
    expect(picked).toEqual([
      { kind: 'order', order: 'form' },
      { kind: 'order', order: 'attack-my-target' },
      { kind: 'order', order: 'break-and-attack' },
      { kind: 'order', order: 'help-me' },
      { kind: 'report' },
    ]);
  });

  it('メニューを開いたときの表示順と一致する（指の位置を動かさない）', () => {
    menu.setOpen(true);
    const shown = menu.items().slice(0, 5).map((it) => it.action);
    menu.setOpen(false);
    for (let i = 0; i < 5; i += 1) menu.invokeBaseItem(i);
    expect(picked).toEqual(shown);
  });

  it('範囲外は false を返し、onPick を呼ばない', () => {
    expect(menu.invokeBaseItem(-1)).toBe(false);
    expect(menu.invokeBaseItem(5)).toBe(false);
    expect(menu.invokeBaseItem(99)).toBe(false);
    expect(picked).toEqual([]);
  });

  it('メニューは開かないまま（open / page を変えない）', () => {
    expect(menu.open).toBe(false);
    expect(menu.invokeBaseItem(1)).toBe(true);
    expect(menu.open).toBe(false);
    expect(menu.currentPage).toBe('main');
    expect(picked).toHaveLength(1);
  });

  it('開いている最中に呼んでも開いたまま（閉じさせない）', () => {
    menu.setOpen(true);
    menu.invokeBaseItem(0);
    expect(menu.open).toBe(true);
    expect(menu.currentPage).toBe('main');
  });

  it('エースページにいてもエース項目ではなく基本項目を流す', () => {
    menu.setOpen(true);
    menu.setAceTarget('カクシ');
    menu.pickIndex(5); // エースページへ
    expect(menu.currentPage).toBe('ace');
    expect(menu.invokeBaseItem(0)).toBe(true);
    expect(picked).toEqual([{ kind: 'order', order: 'form' }]);
    // ページは変えない
    expect(menu.currentPage).toBe('ace');
  });
});
