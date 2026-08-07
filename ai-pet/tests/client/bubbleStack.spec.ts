/**
 * 吹き出しの重なり回避（E-3）。
 *
 * `BubbleLayer.update()` はDOMを触るのでNode環境では回せないが、
 * 「重なった吹き出しを上へ逃がす」計算だけは純粋関数に切り出してあるので
 * ここで数値として固定しておく。
 */
import { describe, expect, it } from 'vitest';
import { stackBubbles, type BubbleBox } from '../../packages/client/src/ui/chat.ts';

/** 矩形は (y - h) 〜 y。重なっていれば true */
function overlaps(a: BubbleBox, b: BubbleBox): boolean {
  const hx = Math.abs(a.x - b.x) < (a.w + b.w) / 2;
  const vy = a.y > b.y - b.h && a.y - a.h < b.y;
  return hx && vy;
}

describe('stackBubbles', () => {
  it('重なっていなければ動かさない', () => {
    const boxes: BubbleBox[] = [
      { x: 100, y: 300, w: 120, h: 40 },
      { x: 400, y: 300, w: 120, h: 40 },
    ];
    expect(stackBubbles(boxes)).toEqual(boxes);
  });

  it('同じ場所に重なった2つは、下の子を残して上の子を持ち上げる', () => {
    const boxes: BubbleBox[] = [
      { x: 200, y: 300, w: 120, h: 40 },
      { x: 210, y: 296, w: 120, h: 40 },
    ];
    const out = stackBubbles(boxes);
    // 下（y=300）は動かない
    expect(out[0]?.y).toBe(300);
    // 上は下の矩形の上へ逃げる（300 - 40 - 隙間6）
    expect(out[1]?.y).toBe(254);
    expect(overlaps(out[0] as BubbleBox, out[1] as BubbleBox)).toBe(false);
  });

  it('3つ以上が重なっても順に上へ積む', () => {
    const boxes: BubbleBox[] = [
      { x: 200, y: 300, w: 120, h: 40 },
      { x: 200, y: 298, w: 120, h: 40 },
      { x: 200, y: 296, w: 120, h: 40 },
    ];
    const out = stackBubbles(boxes);
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        expect(overlaps(out[i] as BubbleBox, out[j] as BubbleBox)).toBe(false);
      }
    }
  });

  it('横に離れていれば縦が同じでも積み上げない', () => {
    const boxes: BubbleBox[] = [
      { x: 100, y: 300, w: 120, h: 40 },
      { x: 260, y: 300, w: 120, h: 40 },
    ];
    const out = stackBubbles(boxes);
    expect(out.map((b) => b.y)).toEqual([300, 300]);
  });

  it('画面の上へ押し出さない（下辺は高さぶん残す）', () => {
    const boxes: BubbleBox[] = [
      { x: 200, y: 60, w: 120, h: 40 },
      { x: 200, y: 58, w: 120, h: 40 },
    ];
    const out = stackBubbles(boxes);
    for (const b of out) expect(b.y).toBeGreaterThanOrEqual(b.h + 4);
  });

  it('入力の配列を書き換えない', () => {
    const boxes: BubbleBox[] = [
      { x: 200, y: 300, w: 120, h: 40 },
      { x: 200, y: 298, w: 120, h: 40 },
    ];
    stackBubbles(boxes);
    expect(boxes[1]?.y).toBe(298);
  });
});
