import { describe, expect, it } from 'vitest';
import {
  clampPersonality,
  describePersonality,
  dominantTraits,
  randomPersonality,
  traitBand,
  TRAIT_KEYS,
} from '../shared/personality.js';

/**
 * 性格ベクトル → プロンプト文の変換は、キャラクター崩壊を防ぐ仕組みの土台。
 * 数値がそのまま文章の強さに反映されることをテストで固定する。
 */

describe('traitBand', () => {
  it('低・中・高の3段に落とす', () => {
    expect(traitBand(0)).toBe(0);
    expect(traitBand(33)).toBe(0);
    expect(traitBand(34)).toBe(1);
    expect(traitBand(66)).toBe(1);
    expect(traitBand(67)).toBe(2);
    expect(traitBand(100)).toBe(2);
  });
});

describe('describePersonality', () => {
  it('全8軸を必ず含める（履歴が伸びても記述量が一定になる）', () => {
    const text = describePersonality(clampPersonality(blank() as never));
    for (const label of ['元気', '甘えん坊', 'わがまま', '賢さ', '社交性', '食いしん坊', '臆病さ', 'いたずら']) {
      expect(text).toContain(label);
    }
    expect(text.split('\n')).toHaveLength(TRAIT_KEYS.length);
  });

  it('極端な軸には強調を付ける', () => {
    const high = describePersonality(
      clampPersonality({ ...blank(), clingy: 95 } as never),
    );
    expect(high).toContain('（とても強い特徴）');
  });

  it('中間の値には強調を付けない', () => {
    const mid = describePersonality(clampPersonality(blank() as never));
    expect(mid).not.toContain('（とても強い特徴）');
  });

  it('高い値と低い値で説明文が変わる', () => {
    const lazy = describePersonality(clampPersonality({ ...blank(), energy: 5 } as never));
    const hyper = describePersonality(clampPersonality({ ...blank(), energy: 95 } as never));
    expect(lazy).toContain('だらけていて');
    expect(hyper).toContain('じっとしていられない');
  });
});

describe('dominantTraits', () => {
  it('上位2軸を返す', () => {
    const result = dominantTraits(
      clampPersonality({ ...blank(), mischief: 90, gluttony: 80 } as never),
    );
    expect(result).toEqual(['mischief', 'gluttony']);
  });
});

describe('randomPersonality', () => {
  it('乱数を差し替えれば決定論的になる', () => {
    const a = randomPersonality(() => 0.5);
    const b = randomPersonality(() => 0.5);
    expect(a).toEqual(b);
  });

  it('すべての軸が 0〜100 に収まる', () => {
    let seed = 0;
    const rand = () => {
      seed += 0.137;
      return seed % 1;
    };
    for (let i = 0; i < 50; i += 1) {
      const personality = randomPersonality(rand);
      for (const key of TRAIT_KEYS) {
        expect(personality[key]).toBeGreaterThanOrEqual(0);
        expect(personality[key]).toBeLessThanOrEqual(100);
      }
    }
  });

  it('端に寄った分布になる（個性が出る）', () => {
    // 一様分布なら 0.1 は 10 付近だが、端寄せの変換で 10 未満になる。
    expect(randomPersonality(() => 0.1).energy).toBeLessThan(10);
    expect(randomPersonality(() => 0.9).energy).toBeGreaterThan(90);
  });
});

function blank(): Record<string, number> {
  return Object.fromEntries(TRAIT_KEYS.map((key) => [key, 50]));
}
