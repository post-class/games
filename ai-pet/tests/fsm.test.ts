import { describe, expect, it } from 'vitest';
import { candidates, forceAction, initialFsm, pickAction, updateFsm } from '../src/sim/fsm.js';
import { clampPersonality, type Personality } from '../shared/personality.js';
import type { Needs, PetView } from '../shared/types.js';

/**
 * 自律行動の重み付け。LLM なしでも性格が行動に出ることを固定する。
 */

const NEEDS: Needs = { hunger: 70, fun: 70, clean: 70, energy: 70, mood: 70 };

const personality = (patch: Partial<Personality> = {}): Personality =>
  clampPersonality({
    energy: 50,
    clingy: 50,
    willful: 50,
    clever: 50,
    social: 50,
    gluttony: 50,
    timid: 50,
    mischief: 50,
    ...patch,
  } as Personality);

const weightOf = (list: ReturnType<typeof candidates>, action: string): number =>
  list.find((candidate) => candidate.action === action)?.weight ?? 0;

describe('candidates', () => {
  it('お腹が空いていると飼い主を見つめる重みが上がる', () => {
    const hungry = candidates({ ...NEEDS, hunger: 10 }, personality(), 12);
    const full = candidates({ ...NEEDS, hunger: 100 }, personality(), 12);
    expect(weightOf(hungry, 'stare_owner')).toBeGreaterThan(weightOf(full, 'stare_owner'));
  });

  it('夜は寝る重みが上がる', () => {
    const night = candidates(NEEDS, personality(), 23);
    const noon = candidates(NEEDS, personality(), 12);
    expect(weightOf(night, 'nap')).toBeGreaterThan(weightOf(noon, 'nap'));
  });

  it('いたずら好きは物を隠す', () => {
    const naughty = candidates(NEEDS, personality({ mischief: 100 }), 12);
    const good = candidates(NEEDS, personality({ mischief: 0 }), 12);
    expect(weightOf(naughty, 'hide_item')).toBeGreaterThan(0);
    expect(weightOf(good, 'hide_item')).toBe(0);
  });

  it('臆病だと窓の外を覗きにくい', () => {
    const timid = candidates(NEEDS, personality({ timid: 100 }), 12);
    const bold = candidates(NEEDS, personality({ timid: 0 }), 12);
    expect(weightOf(timid, 'peek_window')).toBeLessThan(weightOf(bold, 'peek_window'));
  });

  it('拗ねているときだけ隅に行く', () => {
    expect(weightOf(candidates({ ...NEEDS, mood: 10 }, personality(), 12), 'sulk_corner')).toBeGreaterThan(0);
    expect(weightOf(candidates(NEEDS, personality(), 12), 'sulk_corner')).toBe(0);
  });

  it('機嫌が良いときだけ跳ねて喜ぶ', () => {
    const happy = { ...NEEDS, mood: 90, fun: 90 };
    expect(weightOf(candidates(happy, personality(), 12), 'jump_joy')).toBeGreaterThan(0);
    expect(weightOf(candidates(NEEDS, personality(), 12), 'jump_joy')).toBe(0);
  });

  it('重みが 0 の候補は含めない', () => {
    for (const candidate of candidates(NEEDS, personality(), 12)) {
      expect(candidate.weight).toBeGreaterThan(0);
    }
  });
});

describe('pickAction', () => {
  it('乱数を固定すれば決定論的', () => {
    expect(pickAction(NEEDS, personality(), 12, () => 0.3)).toBe(
      pickAction(NEEDS, personality(), 12, () => 0.3),
    );
  });

  it('常に有効な行動を返す', () => {
    for (let i = 0; i < 50; i += 1) {
      const action = pickAction(NEEDS, personality(), i % 24, () => i / 50);
      expect(typeof action).toBe('string');
      expect(action.length).toBeGreaterThan(0);
    }
  });
});

describe('updateFsm', () => {
  const pet = (stage: PetView['stage']): PetView => ({
    id: 1,
    name: 'テスト',
    species: 'mocha',
    personality: personality(),
    needs: NEEDS,
    stage,
    ageHours: 1,
    careScore: 5,
    action: 'idle',
    emotion: 'curious',
    bornAt: 0,
  });

  it('たまごは動かない', () => {
    const state = { ...initialFsm(0), until: 0 };
    const result = updateFsm(state, pet('egg'), 1000, 16, () => 0.9);
    expect(result.state.action).toBe('idle');
  });

  it('行動の持続時間が過ぎたら切り替わる', () => {
    const state = { ...initialFsm(0), until: 0 };
    const result = updateFsm(state, pet('child'), 5000, 16, () => 0.5);
    expect(result.changed).toBe(true);
    expect(result.state.until).toBeGreaterThan(5000);
  });

  it('持続時間内は切り替わらない', () => {
    const state = { ...initialFsm(0), until: 10_000, action: 'nap' as const };
    const result = updateFsm(state, pet('child'), 1000, 16, () => 0.5);
    expect(result.changed).toBe(false);
    expect(result.state.action).toBe('nap');
  });

  it('歩いているときは目標へ近づき、向きが変わる', () => {
    const state = { ...initialFsm(0), until: 99_999, action: 'walk' as const, x: 0.2, targetX: 0.8 };
    const result = updateFsm(state, pet('child'), 1000, 500, () => 0.5);
    expect(result.state.x).toBeGreaterThan(0.2);
    expect(result.state.facing).toBe(1);
  });

  it('左へ歩くと向きが反転する', () => {
    const state = { ...initialFsm(0), until: 99_999, action: 'walk' as const, x: 0.8, targetX: 0.2 };
    const result = updateFsm(state, pet('child'), 1000, 500, () => 0.5);
    expect(result.state.x).toBeLessThan(0.8);
    expect(result.state.facing).toBe(-1);
  });

  it('歩かない行動では位置が動かない', () => {
    const state = { ...initialFsm(0), until: 99_999, action: 'nap' as const, x: 0.5, targetX: 0.9 };
    const result = updateFsm(state, pet('child'), 1000, 500, () => 0.5);
    expect(result.state.x).toBe(0.5);
  });
});

describe('forceAction', () => {
  it('外部から行動を差し込める（LLM の思いつき・世話の反応）', () => {
    const state = forceAction(initialFsm(0), 'jump_joy', 1000);
    expect(state.action).toBe('jump_joy');
    expect(state.until).toBeGreaterThan(1000);
  });

  it('歩きを差し込むと目標位置が決まる', () => {
    const state = forceAction(initialFsm(0), 'walk', 0, () => 0.5);
    expect(state.targetX).toBeCloseTo(0.5, 5);
  });
});
