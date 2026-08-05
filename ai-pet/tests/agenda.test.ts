import { describe, expect, it } from 'vitest';
import {
  forceAction,
  initialAgenda,
  NOVELTY_MS,
  pickSpot,
  pickSpotAction,
  spotScores,
  updateAgenda,
  type AgendaState,
} from '../src/sim/agenda.js';
import { clampPersonality, type Personality } from '../shared/personality.js';
import { findSpot, SPOTS, zoneAt } from '../shared/world.js';
import type { Needs, PetView } from '../shared/types.js';

/**
 * 自律行動。LLM なしでも「性格とニーズで行き先が変わる」ことを固定する。
 * 乱数を差し込めるので、すべて決定論的に検証できる。
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

const weightOf = (list: ReturnType<typeof spotScores>, id: string): number =>
  list.find((entry) => entry.spot.id === id)?.weight ?? 0;

const pet = (patch: Partial<PetView> = {}): PetView => ({
  id: 1,
  name: 'テスト',
  species: 'mocha',
  personality: personality(),
  needs: NEEDS,
  stage: 'child',
  ageHours: 10,
  careScore: 5,
  action: 'idle',
  emotion: 'curious',
  bornAt: 0,
  ...patch,
});

describe('spotScores', () => {
  it('お腹が空いていると、ごはんのおさらが強くなる', () => {
    const hungry = spotScores({ ...NEEDS, hunger: 5 }, personality(), 12, 0.5);
    const full = spotScores({ ...NEEDS, hunger: 100 }, personality(), 12, 0.5);
    expect(weightOf(hungry, 'bowl')).toBeGreaterThan(weightOf(full, 'bowl'));
  });

  it('眠いとベッドが強くなる', () => {
    const sleepy = spotScores({ ...NEEDS, energy: 5 }, personality(), 12, 0.5);
    const awake = spotScores({ ...NEEDS, energy: 100 }, personality(), 12, 0.5);
    expect(weightOf(sleepy, 'bed')).toBeGreaterThan(weightOf(awake, 'bed'));
  });

  it('夜だけの場所は夜に強く、昼だけの場所は昼に強い', () => {
    const night = spotScores(NEEDS, personality(), 23, 0.5);
    const noon = spotScores(NEEDS, personality(), 12, 0.5);
    expect(weightOf(night, 'starspot')).toBeGreaterThan(weightOf(noon, 'starspot'));
    expect(weightOf(noon, 'butterfly')).toBeGreaterThan(weightOf(night, 'butterfly'));
  });

  it('臆病な子は屋外を避ける', () => {
    const timid = spotScores(NEEDS, personality({ timid: 100 }), 12, 0.5);
    const bold = spotScores(NEEDS, personality({ timid: 0 }), 12, 0.5);
    const outdoorSpot = SPOTS.find((spot) => !zoneAt(spot.x).indoor)!;
    expect(weightOf(timid, outdoorSpot.id)).toBeLessThan(weightOf(bold, outdoorSpot.id));
  });

  it('いたずら好きは土を掘りに行きたがる', () => {
    const naughty = spotScores(NEEDS, personality({ mischief: 100 }), 12, 0.5);
    const good = spotScores(NEEDS, personality({ mischief: 0 }), 12, 0.5);
    expect(weightOf(naughty, 'dirt')).toBeGreaterThan(weightOf(good, 'dirt'));
  });

  it('遠い場所は選ばれにくい', () => {
    const fromLeft = spotScores(NEEDS, personality(), 12, 0.02);
    const fromRight = spotScores(NEEDS, personality(), 12, 0.98);
    expect(weightOf(fromLeft, 'bed')).toBeGreaterThan(weightOf(fromRight, 'bed'));
  });

  it('元気な子は遠出をいやがりにくい', () => {
    const far = 'starspot';
    const lively = spotScores(NEEDS, personality({ energy: 100, timid: 0 }), 23, 0.02);
    const lazy = spotScores(NEEDS, personality({ energy: 0, timid: 0 }), 23, 0.02);
    // 素点は同じなので、比が 1 を超えるのは距離のペナルティが軽いということ。
    expect(weightOf(lively, far) / weightOf(lazy, far)).toBeGreaterThan(1);
  });

  it('さっき行った場所は魅力が落ちて、時間が経つと戻る', () => {
    const now = 1_000_000;
    const fresh = spotScores(NEEDS, personality(), 12, 0.5, { rug: now }, now);
    const stale = spotScores(NEEDS, personality(), 12, 0.5, { rug: now - NOVELTY_MS }, now);
    expect(weightOf(fresh, 'rug')).toBeLessThan(weightOf(stale, 'rug'));
  });

  it('重みが 0 の候補は含めない', () => {
    for (const entry of spotScores(NEEDS, personality(), 12, 0.5)) {
      expect(entry.weight).toBeGreaterThan(0);
    }
  });
});

describe('pickSpot', () => {
  it('乱数を固定すれば決定論的', () => {
    const a = pickSpot(NEEDS, personality(), 12, 0.5, {}, 0, () => 0.3);
    const b = pickSpot(NEEDS, personality(), 12, 0.5, {}, 0, () => 0.3);
    expect(a.id).toBe(b.id);
  });

  it('どんな乱数でも必ず実在するスポットを返す', () => {
    for (let i = 0; i < 40; i += 1) {
      const spot = pickSpot(NEEDS, personality(), i % 24, (i % 10) / 10, {}, 0, () => i / 40);
      expect(findSpot(spot.id)).toBeDefined();
    }
  });
});

describe('pickSpotAction', () => {
  it('そのスポットにある行動しか返さない', () => {
    for (const spot of SPOTS) {
      for (let i = 0; i < 10; i += 1) {
        expect(spot.actions).toContain(pickSpotAction(spot, personality(), () => i / 10));
      }
    }
  });

  it('元気な子は動きのある行動を選びやすい', () => {
    const toybox = findSpot('toybox')!;
    // jump_joy（動きのある行動）は最後の候補。重みが上がると当たりやすくなる。
    const livelyPicks = countAction(toybox, personality({ energy: 100 }), 'jump_joy');
    const lazyPicks = countAction(toybox, personality({ energy: 0 }), 'jump_joy');
    expect(livelyPicks).toBeGreaterThan(lazyPicks);
  });
});

function countAction(
  spot: (typeof SPOTS)[number],
  p: Personality,
  action: string,
): number {
  let hits = 0;
  for (let i = 0; i < 100; i += 1) {
    if (pickSpotAction(spot, p, () => i / 100) === action) hits += 1;
  }
  return hits;
}

describe('updateAgenda', () => {
  it('たまごは動かない', () => {
    const state = { ...initialAgenda(0), until: 0 };
    const result = updateAgenda(state, pet({ stage: 'egg' }), 1000, 16, () => 0.9);
    expect(result.state.action).toBe('idle');
    expect(result.state.x).toBe(state.x);
  });

  it('滞在が終わると次の行き先へ歩き出す', () => {
    const state = { ...initialAgenda(0), until: 0 };
    // ぶらぶら歩きに入らない乱数（WANDER_CHANCE より大きい）を使う。
    const result = updateAgenda(state, pet(), 5000, 16, () => 0.5);
    expect(result.changed).toBe(true);
    expect(['travel', 'act']).toContain(result.state.phase);
  });

  it('滞在中は行動が変わらない', () => {
    const state: AgendaState = { ...initialAgenda(0), until: 10_000, action: 'nap', phase: 'act' };
    const result = updateAgenda(state, pet(), 1000, 16, () => 0.5);
    expect(result.changed).toBe(false);
    expect(result.state.action).toBe('nap');
  });

  it('移動中は目標へ近づき、向きが変わる', () => {
    const state: AgendaState = {
      ...initialAgenda(0),
      phase: 'travel',
      action: 'walk',
      until: 99_999,
      x: 0.2,
      targetX: 0.8,
    };
    const result = updateAgenda(state, pet(), 1000, 500, () => 0.5);
    expect(result.state.x).toBeGreaterThan(0.2);
    expect(result.state.facing).toBe(1);
  });

  it('左へ歩くと向きが反転する', () => {
    const state: AgendaState = {
      ...initialAgenda(0),
      phase: 'travel',
      action: 'walk',
      until: 99_999,
      x: 0.8,
      targetX: 0.2,
    };
    const result = updateAgenda(state, pet(), 1000, 500, () => 0.5);
    expect(result.state.x).toBeLessThan(0.8);
    expect(result.state.facing).toBe(-1);
  });

  it('着いたら滞在に切り替わり、そのスポットの行動をする', () => {
    const spot = findSpot('puddle')!;
    const state: AgendaState = {
      ...initialAgenda(0),
      phase: 'travel',
      action: 'walk',
      spotId: spot.id,
      until: 99_999,
      x: spot.x,
      depth: spot.depth,
      targetX: spot.x,
      targetDepth: spot.depth,
    };
    const result = updateAgenda(state, pet(), 1000, 16, () => 0.5);
    expect(result.state.phase).toBe('act');
    expect(spot.actions).toContain(result.state.action);
    expect(result.event?.spotId).toBe(spot.id);
    expect(result.state.lastVisit[spot.id]).toBe(1000);
  });

  it('発見はそのスポットに定義された文だけを返す', () => {
    const spot = findSpot('dirt')!;
    const state: AgendaState = {
      ...initialAgenda(0),
      phase: 'travel',
      spotId: spot.id,
      until: 99_999,
      x: spot.x,
      targetX: spot.x,
      depth: spot.depth,
      targetDepth: spot.depth,
    };
    // rand=0 は「発見あり」側に倒れる（0.5 未満）。
    const result = updateAgenda(state, pet(), 1000, 16, () => 0);
    expect(spot.finds).toContain(result.event?.find);
  });

  it('滞在が終わっても、行動は必ず有効な値のまま', () => {
    let state = initialAgenda(0);
    let now = 0;
    for (let i = 0; i < 200; i += 1) {
      now += 1000;
      state = updateAgenda(state, pet(), now, 1000, () => ((i * 37) % 100) / 100).state;
      expect(state.x).toBeGreaterThanOrEqual(0);
      expect(state.x).toBeLessThanOrEqual(1);
      expect(state.depth).toBeGreaterThanOrEqual(0);
      expect(state.depth).toBeLessThanOrEqual(1);
    }
  });
});

describe('forceAction', () => {
  it('外部から行動を差し込める（世話・LLM の思いつき）', () => {
    const state = forceAction(initialAgenda(0), 'jump_joy', 1000);
    expect(state.action).toBe('jump_joy');
    expect(state.phase).toBe('act');
    expect(state.until).toBeGreaterThan(1000);
  });

  it('差し込んでも位置は動かない（その場で反応する）', () => {
    const base = { ...initialAgenda(0), x: 0.42 };
    expect(forceAction(base, 'nuzzle', 0).x).toBe(0.42);
  });
});
