/**
 * needs.ts（欲求の増減・睡眠回復・餓死ダメージ・切迫度カーブ）のテスト
 * 島時間は実時間60分なので、実機では確認できない「1島時間あたりの量」をここで担保する。
 */
import { describe, expect, it } from 'vitest';
import {
  NEEDS,
  Rng,
  TICKS_PER_ISLAND_DAY,
  TICKS_PER_ISLAND_HOUR,
  TICK_SEC,
  type Actor,
  type Traits,
} from '@ai-pet/shared';
import { IslandWorld } from '../../packages/server/src/sim/world.ts';
import { WorldClock } from '../../packages/server/src/sim/clock.ts';
import { createCritterActor, createPlayerActor } from '../../packages/server/src/sim/actors.ts';
import {
  applySleepRecovery,
  applyStarvation,
  relieveNeed,
  updateNeeds,
  urgency,
} from '../../packages/server/src/sim/needs.ts';

const NIGHT_TICK = Math.floor(TICKS_PER_ISLAND_DAY * 0.75);

function newWorld(): IslandWorld {
  return new IslandWorld(new Rng('needs'));
}

function newClock(): WorldClock {
  return new WorldClock(new Rng('needs'));
}

/** traits を指定した動物。欲求は0（満たされた状態）から始める */
function critter(world: IslandWorld, traits: Partial<Traits> = {}, x = 10.5): Actor {
  const a = createCritterActor(world, {
    species: 'rabbit',
    pos: { x, y: 10.5 },
    traits: { energy: 0.5, sociability: 0.5, caution: 0.5, gluttony: 0.5, curiosity: 0.5, ...traits },
  });
  a.needs.hunger = 0;
  a.needs.sleep = 0;
  a.needs.social = 0;
  a.needs.safety = 0;
  a.needs.curiosity = 0;
  return a;
}

function run(world: IslandWorld, clock: WorldClock, ticks: number, from = 0): void {
  for (let t = from + 1; t <= from + ticks; t++) updateNeeds(world, t, clock);
}

describe('updateNeeds 増加速度', () => {
  it('1島時間で定数どおりの量だけ欲求が増える', () => {
    const w = newWorld();
    const a = critter(w);
    run(w, newClock(), TICKS_PER_ISLAND_HOUR);

    expect(a.needs.hunger).toBeCloseTo(NEEDS.hungerPerIslandHour, 6);
    expect(a.needs.sleep).toBeCloseTo(NEEDS.sleepPerIslandHour, 6);
    expect(a.needs.social).toBeCloseTo(NEEDS.socialPerIslandHour, 6);
    expect(a.needs.curiosity).toBeCloseTo(NEEDS.curiosityPerIslandHour, 6);
  });

  it('プレイヤーの欲求は増えない', () => {
    const w = newWorld();
    const p = createPlayerActor(w, { name: 'りょう' });
    run(w, newClock(), TICKS_PER_ISLAND_HOUR * 3);
    expect(p.needs.hunger).toBe(0);
    expect(p.needs.sleep).toBe(0);
  });

  it('ペットも欲求が増える', () => {
    const w = newWorld();
    const pet = createCritterActor(w, { species: 'rabbit', pos: { x: 10.5, y: 10.5 } });
    pet.kind = 'pet';
    pet.needs.hunger = 0;
    run(w, newClock(), TICKS_PER_ISLAND_HOUR);
    expect(pet.needs.hunger).toBeGreaterThan(0);
  });

  it('traits で速度が変わる（大食い→空腹が速い / energy高→眠気が遅い / 社交的→社交欲が速い）', () => {
    const w = newWorld();
    const glutton = critter(w, { gluttony: 1 }, 10.5);
    const light = critter(w, { gluttony: 0 }, 20.5);
    const lively = critter(w, { energy: 1 }, 30.5);
    const lazy = critter(w, { energy: 0 }, 40.5);
    const social = critter(w, { sociability: 1 }, 50.5);
    const shy = critter(w, { sociability: 0 }, 60.5);

    run(w, newClock(), TICKS_PER_ISLAND_HOUR);

    expect(glutton.needs.hunger).toBeGreaterThan(light.needs.hunger);
    expect(glutton.needs.hunger / light.needs.hunger).toBeCloseTo(1.4 / 0.6, 5);
    expect(lively.needs.sleep).toBeLessThan(lazy.needs.sleep);
    expect(social.needs.social).toBeGreaterThan(shy.needs.social);
  });

  it('夜は眠気の増加が速い', () => {
    const day = newWorld();
    const dayCritter = critter(day);
    run(day, newClock(), TICKS_PER_ISLAND_HOUR);

    const night = newWorld();
    const nightCritter = critter(night);
    run(night, newClock(), TICKS_PER_ISLAND_HOUR, NIGHT_TICK);

    expect(nightCritter.needs.sleep / dayCritter.needs.sleep).toBeCloseTo(NEEDS.sleepNightMultiplier, 5);
    // 空腹は夜でも変わらない
    expect(nightCritter.needs.hunger).toBeCloseTo(dayCritter.needs.hunger, 6);
  });

  it('安全欲は時間とともに収まる', () => {
    const w = newWorld();
    const a = critter(w);
    a.needs.safety = 50;
    run(w, newClock(), TICKS_PER_ISLAND_HOUR);
    expect(a.needs.safety).toBeCloseTo(50 - NEEDS.safetyRecoverPerIslandHour, 6);
  });
});

describe('睡眠', () => {
  it('寝ていると眠気が回復し、空腹の進みが半分になる', () => {
    const w = newWorld();
    const sleeper = critter(w, {}, 10.5);
    sleeper.anim = 'sleep';
    sleeper.needs.sleep = 80;
    const awake = critter(w, {}, 20.5);

    run(w, newClock(), TICKS_PER_ISLAND_HOUR);

    expect(sleeper.needs.sleep).toBeCloseTo(80 - NEEDS.sleepReliefPerIslandHour, 5);
    expect(sleeper.needs.hunger).toBeCloseTo(awake.needs.hunger * NEEDS.sleepHungerMultiplier, 6);
    // 寝ている間は社交欲・好奇心も募らない
    expect(sleeper.needs.social).toBe(0);
    expect(sleeper.needs.curiosity).toBe(0);
  });

  it('applySleepRecovery を単体で呼んでも1島時間ぶんが定数どおり', () => {
    const w = newWorld();
    const a = critter(w);
    a.needs.sleep = 100;
    for (let i = 0; i < TICKS_PER_ISLAND_HOUR; i++) applySleepRecovery(a, TICK_SEC);
    expect(a.needs.sleep).toBeCloseTo(100 - NEEDS.sleepReliefPerIslandHour, 5);
  });

  it('眠気は0未満にならない', () => {
    const w = newWorld();
    const a = critter(w);
    a.needs.sleep = 5;
    for (let i = 0; i < TICKS_PER_ISLAND_HOUR * 5; i++) applySleepRecovery(a, TICK_SEC);
    expect(a.needs.sleep).toBe(0);
  });
});

describe('relieveNeed', () => {
  it('欲求を減らし、0未満にはしない', () => {
    const w = newWorld();
    const a = critter(w);
    a.needs.hunger = 60;
    relieveNeed(a, 'hunger', NEEDS.eatRelief);
    expect(a.needs.hunger).toBeCloseTo(60 - NEEDS.eatRelief, 6);
    relieveNeed(a, 'hunger', 999);
    expect(a.needs.hunger).toBe(0);
  });

  it('0以下や不正な量では何も起きない', () => {
    const w = newWorld();
    const a = critter(w);
    a.needs.social = 30;
    relieveNeed(a, 'social', 0);
    relieveNeed(a, 'social', -10);
    relieveNeed(a, 'social', Number.NaN);
    expect(a.needs.social).toBe(30);
  });
});

describe('欲求の範囲', () => {
  it('長時間回しても 0..100 を超えない', () => {
    const w = newWorld();
    const a = critter(w);
    run(w, newClock(), TICKS_PER_ISLAND_DAY * 2);
    for (const v of Object.values(a.needs)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
    expect(a.needs.hunger).toBe(100); // 1島日で使い切る速さなので上限に張り付く
    expect(a.health).toBeGreaterThanOrEqual(0);
  });
});

describe('空腹による健康の増減', () => {
  it('空腹が限界だと health が定数どおり減る', () => {
    const w = newWorld();
    const a = critter(w);
    a.needs.hunger = 100;
    for (let i = 0; i < TICKS_PER_ISLAND_HOUR; i++) applyStarvation(a, TICK_SEC);
    expect(a.health).toBeCloseTo(100 - NEEDS.starvationHealthPerIslandHour, 5);
  });

  it('updateNeeds 経由でも空腹が続くと health が減る（0未満にはならない）', () => {
    const w = newWorld();
    const a = critter(w);
    a.needs.hunger = 100;
    run(w, newClock(), TICKS_PER_ISLAND_HOUR * 2);
    expect(a.health).toBeLessThan(100);
    run(w, newClock(), TICKS_PER_ISLAND_DAY * 2, TICKS_PER_ISLAND_HOUR * 2);
    expect(a.health).toBe(0);
  });

  it('空腹が落ち着いていれば health は戻る（100を超えない）', () => {
    const w = newWorld();
    const a = critter(w);
    a.health = 50;
    for (let i = 0; i < TICKS_PER_ISLAND_HOUR; i++) applyStarvation(a, TICK_SEC);
    expect(a.health).toBeCloseTo(50 + NEEDS.healthRecoverPerIslandHour, 5);

    a.health = 100;
    for (let i = 0; i < TICKS_PER_ISLAND_HOUR; i++) applyStarvation(a, TICK_SEC);
    expect(a.health).toBe(100);
  });

  it('中途半端な空腹では回復もダメージも起きない', () => {
    const w = newWorld();
    const a = critter(w);
    a.health = 50;
    a.needs.hunger = NEEDS.healthRecoverHungerBelow + 10;
    for (let i = 0; i < TICKS_PER_ISLAND_HOUR; i++) applyStarvation(a, TICK_SEC);
    expect(a.health).toBe(50);
  });
});

describe('urgency', () => {
  it('0で0、100で1', () => {
    expect(urgency(0)).toBe(0);
    expect(urgency(100)).toBeCloseTo(1, 10);
    expect(urgency(-10)).toBe(0);
    expect(urgency(200)).toBeCloseTo(1, 10);
  });

  it('単調増加である', () => {
    let prev = -1;
    for (let v = 0; v <= 100; v += 0.5) {
      const u = urgency(v);
      expect(u).toBeGreaterThanOrEqual(prev);
      prev = u;
    }
  });

  it('前半は緩く、後半で急に上がるカーブになっている', () => {
    // 半分の空腹では大したことがない
    expect(urgency(50)).toBeLessThan(0.2);
    // 前半50の伸びより、後半の 80→100 の伸びのほうがずっと大きい
    const early = urgency(50) - urgency(30);
    const late = urgency(100) - urgency(80);
    expect(late).toBeGreaterThan(early * 3);
    // 限界間近では確実に他の行動に勝てる高さになる
    expect(urgency(90)).toBeGreaterThan(0.7);
    expect(urgency(80)).toBeGreaterThan(urgency(50) * 3);
  });
});
