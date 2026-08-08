/**
 * ペットのゲージパネル（E-1）の値の扱い。
 *
 * ここで守りたいのは**空腹値の向きを間違えないこと**。
 * `Needs.hunger` は「0=満たされている / 100=空腹」の需要値なので、
 * そのままバーに入れると満腹のときに空っぽに見える（逆に餓死寸前が満タンに見える）。
 */
import { describe, expect, it } from 'vitest';
import {
  affectionRatio,
  barWidthPercent,
  clamp01,
  fullnessRatio,
  gaugeLabel,
  gaugeLevel,
} from '../../packages/client/src/ui/petGauge.ts';

describe('E-1 なつき度のバー', () => {
  it('0..100 が 0..1 になる', () => {
    expect(affectionRatio(0)).toBe(0);
    expect(affectionRatio(50)).toBeCloseTo(0.5);
    expect(affectionRatio(100)).toBe(1);
  });

  it('範囲外はクランプする（壊れた値でレイアウトが崩れない）', () => {
    expect(affectionRatio(-10)).toBe(0);
    expect(affectionRatio(999)).toBe(1);
  });
});

describe('E-1 おなかのバー', () => {
  it('hunger は反転して入る（0=満たされ→満タン / 100=空腹→空）', () => {
    expect(fullnessRatio(0)).toBe(1);
    expect(fullnessRatio(100)).toBe(0);
    expect(fullnessRatio(25)).toBeCloseTo(0.75);
  });

  it('満腹のときにバーが空にならない（向きを間違えたら落ちる）', () => {
    expect(fullnessRatio(0)).toBeGreaterThan(fullnessRatio(80));
  });
});

describe('E-1 バーの見た目', () => {
  it('NaN は 0 として扱う（未受信でも例外にしない）', () => {
    expect(clamp01(Number.NaN)).toBe(0);
    expect(clamp01(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('0 は幅0だが、わずかでも残っていれば見える太さにする', () => {
    expect(barWidthPercent(0)).toBe(0);
    // 1% を素直に描くと角丸に食われて「空」と区別が付かない
    expect(barWidthPercent(0.01)).toBeGreaterThanOrEqual(4);
    expect(barWidthPercent(1)).toBe(100);
  });

  it('低いときだけ色が変わる（気づかせるため）', () => {
    expect(gaugeLevel(0.1)).toBe('low');
    expect(gaugeLevel(0.4)).toBe('mid');
    expect(gaugeLevel(0.9)).toBe('high');
  });

  it('未受信は「？」と出す（0% と区別する）', () => {
    expect(gaugeLabel('affection', null)).toContain('？');
    expect(gaugeLabel('fullness', null)).toContain('？');
    expect(gaugeLabel('affection', 0)).toContain('0%');
    expect(gaugeLabel('fullness', 1)).toContain('100%');
  });
});
