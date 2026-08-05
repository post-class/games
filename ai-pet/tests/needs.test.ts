import { describe, expect, it } from 'vitest';
import { clampPersonality, type Personality } from '../shared/personality.js';
import { NEED_KEYS } from '../shared/types.js';
import {
  applyNeedsDelta,
  clampNeeds,
  decayNeeds,
  describeNeeds,
  initialNeeds,
  urgentNeed,
} from '../server/pet/needs.js';

const flat = (value: number): Personality =>
  clampPersonality({
    energy: value,
    clingy: value,
    willful: value,
    clever: value,
    social: value,
    gluttony: value,
    timid: value,
    mischief: value,
  });

const HOUR = 3_600_000;

describe('decayNeeds', () => {
  it('経過時間ゼロでは何も変わらない', () => {
    const needs = initialNeeds();
    const result = decayNeeds(needs, flat(50), 1000, 1000);
    expect(result.needs).toEqual(needs);
    expect(result.hoursElapsed).toBe(0);
  });

  it('時間が経つと満腹度と楽しさが下がる', () => {
    const needs = initialNeeds();
    const result = decayNeeds(needs, flat(50), 0, 5 * HOUR);
    expect(result.needs.hunger).toBeLessThan(needs.hunger);
    expect(result.needs.fun).toBeLessThan(needs.fun);
    expect(result.hoursElapsed).toBeCloseTo(5);
  });

  it('energy は休んでいる分だけ回復する', () => {
    const needs = { ...initialNeeds(), energy: 30 };
    const result = decayNeeds(needs, flat(50), 0, 4 * HOUR);
    expect(result.needs.energy).toBeGreaterThan(30);
  });

  it('食いしん坊なほど早く空腹になる', () => {
    const needs = initialNeeds();
    const greedy = decayNeeds(needs, flat(100), 0, 4 * HOUR).needs.hunger;
    const modest = decayNeeds(needs, flat(0), 0, 4 * HOUR).needs.hunger;
    expect(greedy).toBeLessThan(modest);
  });

  it('1日放置しても お世話ニーズが 底まで 落ちきらない（低プレッシャー設計）', () => {
    const result = decayNeeds(initialNeeds(), flat(50), 0, 24 * HOUR);
    for (const key of ['hunger', 'fun', 'clean'] as const) {
      expect(result.needs[key]).toBeGreaterThan(0);
    }
    // それでも「ちゃんと減っている」ことは分かる水準にする
    expect(result.needs.hunger).toBeLessThan(30);
  });

  it('3日放置でも下限で止まる', () => {
    const result = decayNeeds(initialNeeds(), flat(100), 0, 72 * HOUR);
    for (const key of ['hunger', 'fun', 'clean'] as const) {
      expect(result.needs[key]).toBeGreaterThanOrEqual(8);
    }
  });

  it('放置すると mood が下がるが 0 未満にはならない', () => {
    const needs = initialNeeds();
    const result = decayNeeds(needs, flat(50), 0, 200 * HOUR);
    expect(result.needs.mood).toBeLessThan(needs.mood);
    for (const key of NEED_KEYS) {
      expect(result.needs[key]).toBeGreaterThanOrEqual(0);
      expect(result.needs[key]).toBeLessThanOrEqual(100);
    }
  });

  it('世話が行き届いていれば mood は上がる', () => {
    const needs = { hunger: 95, fun: 95, clean: 95, energy: 90, mood: 40 };
    const result = decayNeeds(needs, flat(50), 0, 2 * HOUR);
    expect(result.needs.mood).toBeGreaterThan(40);
  });

  it('同じ入力なら必ず同じ結果になる（決定論）', () => {
    const needs = initialNeeds();
    const a = decayNeeds(needs, flat(70), 0, 3 * HOUR);
    const b = decayNeeds(needs, flat(70), 0, 3 * HOUR);
    expect(a).toEqual(b);
  });
});

describe('applyNeedsDelta', () => {
  it('アイテム効果を加算し 100 で止まる', () => {
    const result = applyNeedsDelta({ ...initialNeeds(), hunger: 90 }, { hunger: 25 });
    expect(result.hunger).toBe(100);
  });

  it('1回の変化幅は ±25 に制限される（LLM が暴れても壊れない）', () => {
    const result = applyNeedsDelta({ ...initialNeeds(), fun: 50 }, { fun: 999 });
    expect(result.fun).toBe(75);
    const down = applyNeedsDelta({ ...initialNeeds(), fun: 50 }, { fun: -999 });
    expect(down.fun).toBe(25);
  });

  it('数値でない値は無視する', () => {
    const needs = initialNeeds();
    const result = applyNeedsDelta(needs, { hunger: Number.NaN });
    expect(result.hunger).toBe(needs.hunger);
  });
});

describe('urgentNeed', () => {
  it('満たされているときは null', () => {
    expect(urgentNeed({ hunger: 80, fun: 80, clean: 80, energy: 80, mood: 80 })).toBeNull();
  });

  it('いちばん低いニーズを返す', () => {
    expect(urgentNeed({ hunger: 40, fun: 20, clean: 80, energy: 80, mood: 50 })).toBe('fun');
  });

  it('mood は「困っていること」には含めない', () => {
    expect(urgentNeed({ hunger: 90, fun: 90, clean: 90, energy: 90, mood: 1 })).toBeNull();
  });
});

describe('clampNeeds / describeNeeds', () => {
  it('範囲外の値を丸める', () => {
    const result = clampNeeds({ hunger: -50, fun: 500, clean: 50.4, energy: 50, mood: 50 });
    expect(result.hunger).toBe(0);
    expect(result.fun).toBe(100);
    expect(result.clean).toBe(50);
  });

  it('拗ねている状態が文章に出る', () => {
    const text = describeNeeds({ hunger: 10, fun: 10, clean: 10, energy: 10, mood: 10 });
    expect(text).toContain('拗ねている');
    expect(text).toContain('おなかがぺこぺこ');
  });
});
