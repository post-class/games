/**
 * critter.ts（動物住民のユーティリティAI）のテスト
 *
 * worldgen には依存しない。既定の世界は全面 grass（TERRAINS[0]）で歩ける。
 * needs.ts / resource.ts はまだ存在しないため、critter.ts は既定実装つきの
 * 差し替え可能な継ぎ目（setCritterDeps）を持っている。ここではその既定実装を使う。
 */
import { describe, expect, it } from 'vitest';
import {
  CRITTER_WEIGHTS as SHARED_CRITTER_WEIGHTS,
  MAX_CRITTERS,
  RESOURCE,
  Rng,
  TICKS_PER_ISLAND_DAY,
  type Actor,
  type ResourceNode,
  type ResourceType,
  type Terrain,
  type Traits,
  type Vec2,
} from '@ai-pet/shared';
import { IslandWorld, distance } from '../../packages/server/src/sim/world.ts';
import { createCritterActor, createPlayerActor } from '../../packages/server/src/sim/actors.ts';
import { WorldClock } from '../../packages/server/src/sim/clock.ts';
import { NavService } from '../../packages/server/src/sim/nav.ts';
import { updateMovement } from '../../packages/server/src/sim/movement.ts';
import {
  CRITTER_WEIGHTS,
  CritterAI,
  chooseAction,
  crowdFactor,
  falloff,
  forgetCritter,
  scoreCandidates,
  type Candidate,
  type CritterContext,
} from '../../packages/server/src/sim/critter.ts';

// ---------- 足場 ----------

const DAY_TICK = Math.floor(TICKS_PER_ISLAND_DAY * 0.4); // 昼
const NIGHT_TICK = Math.floor(TICKS_PER_ISLAND_DAY * 0.85); // 夜

const c = (x: number, y: number): Vec2 => ({ x: x + 0.5, y: y + 0.5 });

function newWorld(): IslandWorld {
  return new IslandWorld(new Rng('critter-test'));
}

function newClock(opts?: { weather?: 'clear' | 'cloudy' | 'rain' | 'fog'; season?: 'spring' | 'summer' | 'autumn' | 'winter' }): WorldClock {
  const clock = new WorldClock(new Rng('clock'));
  clock.weather = opts?.weather ?? 'clear';
  clock.season = opts?.season ?? 'summer'; // 夏は nest 係数が最も低く、他の行動を観察しやすい
  return clock;
}

function ctxAt(clock: WorldClock, tick: number): CritterContext {
  return { tick, clock, isNight: clock.isNight(tick) };
}

const MID_TRAITS: Traits = { energy: 0.5, sociability: 0.5, caution: 0.5, gluttony: 0.5, curiosity: 0.5 };

function addCritter(world: IslandWorld, pos: Vec2, traits: Partial<Traits> = {}, species = 'rabbit'): Actor {
  const a = createCritterActor(world, { species, pos, traits: { ...MID_TRAITS, ...traits } });
  // 生成時の欲求は乱数で散らばるので、テストでは明示的に固定する
  a.needs = { hunger: 0, sleep: 0, social: 0, safety: 0, curiosity: 0 };
  forgetCritter(a);
  return a;
}

function addResource(world: IslandWorld, type: ResourceType, pos: Vec2, amount = 5): ResourceNode {
  const node: ResourceNode = {
    id: world.allocId(),
    type,
    pos,
    amount,
    max: Math.max(amount, 1),
    regenPerIslandHour: 1,
  };
  return world.addResource(node);
}

function fill(world: IslandWorld, x0: number, y0: number, x1: number, y1: number, t: Terrain): void {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) world.setTerrain(x, y, t);
}

function byKind(cands: readonly Candidate[], kind: string): Candidate | undefined {
  let best: Candidate | undefined;
  for (const cand of cands) if (cand.kind === kind && (!best || cand.score > best.score)) best = cand;
  return best;
}

function top(cands: readonly Candidate[]): Candidate {
  let best = cands[0] as Candidate;
  for (const cand of cands) if (cand.score > best.score) best = cand;
  return best;
}

// ---------- 小道具 ----------

describe('falloff', () => {
  it('距離0で1、scaleで0.5、遠いほど小さい', () => {
    expect(falloff(0, 20)).toBe(1);
    expect(falloff(20, 20)).toBeCloseTo(0.5, 6);
    expect(falloff(60, 20)).toBeLessThan(falloff(20, 20));
  });
});

// ---------- 欲求とスコア ----------

describe('scoreCandidates 空腹', () => {
  it('空腹なら eat が最上位になる', () => {
    const w = newWorld();
    const clock = newClock();
    const a = addCritter(w, c(20, 20));
    a.needs.hunger = 90;
    addResource(w, 'berry_tree', c(23, 20));

    const cands = scoreCandidates(w, a, ctxAt(clock, DAY_TICK));
    expect(top(cands).kind).toBe('eat');
  });

  it('満腹なら eat のスコアが下がり、最上位ではなくなる', () => {
    const w = newWorld();
    const clock = newClock();
    const a = addCritter(w, c(20, 20));
    addResource(w, 'berry_tree', c(23, 20));

    a.needs.hunger = 90;
    const hungry = byKind(scoreCandidates(w, a, ctxAt(clock, DAY_TICK)), 'eat');
    a.needs.hunger = 5;
    const full = scoreCandidates(w, a, ctxAt(clock, DAY_TICK));

    expect(hungry).toBeDefined();
    expect(byKind(full, 'eat')?.score ?? 0).toBeLessThan((hungry as Candidate).score * 0.1);
    expect(top(full).kind).not.toBe('eat');
  });

  it('資源が無ければ eat 候補が出ない', () => {
    const w = newWorld();
    const a = addCritter(w, c(20, 20));
    a.needs.hunger = 95;
    expect(byKind(scoreCandidates(w, a, ctxAt(newClock(), DAY_TICK)), 'eat')).toBeUndefined();
  });

  it('在庫0の資源では eat 候補が出ない', () => {
    const w = newWorld();
    const a = addCritter(w, c(20, 20));
    a.needs.hunger = 95;
    addResource(w, 'berry_tree', c(21, 20), 0);
    expect(byKind(scoreCandidates(w, a, ctxAt(newClock(), DAY_TICK)), 'eat')).toBeUndefined();
  });

  it('近い資源のほうが高スコア', () => {
    const w = newWorld();
    const clock = newClock();
    const nearA = addCritter(w, c(20, 20));
    const farA = addCritter(w, c(40, 20));
    nearA.needs.hunger = 70;
    farA.needs.hunger = 70;
    addResource(w, 'berry_tree', c(22, 20));

    const nearScore = byKind(scoreCandidates(w, nearA, ctxAt(clock, DAY_TICK)), 'eat')?.score ?? 0;
    const farScore = byKind(scoreCandidates(w, farA, ctxAt(clock, DAY_TICK)), 'eat')?.score ?? 0;
    expect(nearScore).toBeGreaterThan(farScore);
    expect(farScore).toBeGreaterThan(0);
  });

  it('荒れたタイルの資源はスコアが下がる', () => {
    const w = newWorld();
    const clock = newClock();
    const a = addCritter(w, c(20, 20));
    a.needs.hunger = 70;
    const node = addResource(w, 'berry_tree', c(23, 20));
    const clean = byKind(scoreCandidates(w, a, ctxAt(clock, DAY_TICK)), 'eat')?.score ?? 0;
    w.addDecay(Math.floor(node.pos.x), Math.floor(node.pos.y), RESOURCE.maxDecay);
    const dirty = byKind(scoreCandidates(w, a, ctxAt(clock, DAY_TICK)), 'eat')?.score ?? 0;
    expect(dirty).toBeLessThan(clean);
  });

  it('うさぎは釣り場を食料と見ないが、ねこは見る', () => {
    const w = newWorld();
    const clock = newClock();
    const rabbit = addCritter(w, c(20, 20), {}, 'rabbit');
    const cat = addCritter(w, c(20, 22), {}, 'cat');
    rabbit.needs.hunger = 90;
    cat.needs.hunger = 90;
    addResource(w, 'fishing_spot', c(21, 21));

    expect(byKind(scoreCandidates(w, rabbit, ctxAt(clock, DAY_TICK)), 'eat')).toBeUndefined();
    expect(byKind(scoreCandidates(w, cat, ctxAt(clock, DAY_TICK)), 'eat')).toBeDefined();
  });
});

// ---------- 時間帯 ----------

describe('scoreCandidates 時間帯', () => {
  it('夜は sleep が最上位になる', () => {
    const w = newWorld();
    const clock = newClock();
    const a = addCritter(w, c(20, 20));
    a.needs.sleep = 60;
    a.needs.hunger = 40;
    addResource(w, 'berry_tree', c(25, 20));
    addResource(w, 'water', c(24, 24));

    expect(top(scoreCandidates(w, a, ctxAt(clock, NIGHT_TICK))).kind).toBe('sleep');
  });

  it('昼は sleep のスコアが下がる', () => {
    const w = newWorld();
    const clock = newClock();
    const a = addCritter(w, c(20, 20));
    a.needs.sleep = 60;

    const night = byKind(scoreCandidates(w, a, ctxAt(clock, NIGHT_TICK)), 'sleep')?.score ?? 0;
    const day = byKind(scoreCandidates(w, a, ctxAt(clock, DAY_TICK)), 'sleep')?.score ?? 0;
    expect(day).toBeLessThan(night * 0.5);
  });

  it('昼は空腹なら eat が sleep に勝つ', () => {
    const w = newWorld();
    const clock = newClock();
    const a = addCritter(w, c(20, 20));
    a.needs.sleep = 60;
    a.needs.hunger = 60;
    addResource(w, 'berry_tree', c(23, 20));

    const cands = scoreCandidates(w, a, ctxAt(clock, DAY_TICK));
    expect((byKind(cands, 'eat')?.score ?? 0)).toBeGreaterThan(byKind(cands, 'sleep')?.score ?? 0);
  });
});

// ---------- 天気・季節 ----------

describe('scoreCandidates 天気と季節', () => {
  it('雨のとき屋外行動（eat / socialize / wander）のスコアが下がる', () => {
    const w = newWorld();
    const a = addCritter(w, c(20, 20));
    const b = addCritter(w, c(22, 20));
    a.needs.hunger = 70;
    a.needs.social = 70;
    a.needs.curiosity = 70;
    b.needs.social = 70;
    addResource(w, 'berry_tree', c(23, 20));

    const clear = scoreCandidates(w, a, ctxAt(newClock({ weather: 'clear' }), DAY_TICK));
    const rain = scoreCandidates(w, a, ctxAt(newClock({ weather: 'rain' }), DAY_TICK));

    for (const kind of ['eat', 'socialize', 'wander']) {
      const before = byKind(clear, kind)?.score ?? 0;
      const after = byKind(rain, kind)?.score ?? 0;
      expect(before).toBeGreaterThan(0);
      expect(after).toBeCloseTo(before * CRITTER_WEIGHTS.weather.rainOutdoor, 6);
    }
  });

  it('雨のときは森（木の下）へ向かう goto が最上位になる', () => {
    const w = newWorld();
    fill(w, 30, 18, 34, 22, 'forest');
    const a = addCritter(w, c(20, 20));
    a.needs.hunger = 30;
    a.needs.curiosity = 30;
    addResource(w, 'berry_tree', c(23, 20));

    const best = top(scoreCandidates(w, a, ctxAt(newClock({ weather: 'rain' }), DAY_TICK)));
    expect(best.kind).toBe('goto');
    expect(best.targetTile).toBeDefined();
    const t = best.targetTile as Vec2;
    expect(w.terrainAt(Math.floor(t.x), Math.floor(t.y))).toBe('forest');
  });

  it('晴れの日は森への避難候補が出ない', () => {
    const w = newWorld();
    fill(w, 30, 18, 34, 22, 'forest');
    const a = addCritter(w, c(20, 20));
    const cands = scoreCandidates(w, a, ctxAt(newClock({ weather: 'clear' }), DAY_TICK));
    expect(cands.filter((x) => x.kind === 'goto' && x.targetTile)).toHaveLength(0);
  });

  it('霧の日は探索範囲が狭くなり、遠い資源が見えない', () => {
    const w = newWorld();
    const a = addCritter(w, c(20, 20));
    // 空腹が切迫すると探索半径が広がる（最大2.5倍）ので、ここでは軽い空腹にする
    a.needs.hunger = 20;
    // 半径22*(0.8+0.2)=22 の内側だが、霧（×0.6=13.2）では外
    addResource(w, 'berry_tree', c(38, 20));

    expect(byKind(scoreCandidates(w, a, ctxAt(newClock({ weather: 'clear' }), DAY_TICK)), 'eat')).toBeDefined();
    expect(byKind(scoreCandidates(w, a, ctxAt(newClock({ weather: 'fog' }), DAY_TICK)), 'eat')).toBeUndefined();
  });

  it('冬は nest のスコアが夏より高い', () => {
    const w = newWorld();
    const a = addCritter(w, c(20, 20));
    a.needs.sleep = 50;
    a.needs.safety = 50;

    const summer = byKind(scoreCandidates(w, a, ctxAt(newClock({ season: 'summer' }), DAY_TICK)), 'nest')?.score ?? 0;
    const winter = byKind(scoreCandidates(w, a, ctxAt(newClock({ season: 'winter' }), DAY_TICK)), 'nest')?.score ?? 0;
    expect(winter).toBeGreaterThan(summer);
  });

  it('夏は drink のスコアが冬より高い', () => {
    const w = newWorld();
    const a = addCritter(w, c(20, 20));
    a.needs.hunger = 50;
    addResource(w, 'water', c(22, 20), 20);

    const summer = byKind(scoreCandidates(w, a, ctxAt(newClock({ season: 'summer' }), DAY_TICK)), 'drink')?.score ?? 0;
    const winter = byKind(scoreCandidates(w, a, ctxAt(newClock({ season: 'winter' }), DAY_TICK)), 'drink')?.score ?? 0;
    expect(summer).toBeGreaterThan(winter);
  });
});

// ---------- traits ----------

describe('scoreCandidates traits', () => {
  it('大食いな個体は eat のスコアが高い', () => {
    const w = newWorld();
    const clock = newClock();
    const glutton = addCritter(w, c(20, 20), { gluttony: 1 });
    const picky = addCritter(w, c(20, 24), { gluttony: 0 });
    glutton.needs.hunger = 70;
    picky.needs.hunger = 70;
    addResource(w, 'berry_tree', c(20, 22));

    const g = byKind(scoreCandidates(w, glutton, ctxAt(clock, DAY_TICK)), 'eat')?.score ?? 0;
    const p = byKind(scoreCandidates(w, picky, ctxAt(clock, DAY_TICK)), 'eat')?.score ?? 0;
    expect(g).toBeGreaterThan(p);
  });

  it('社交的な個体は socialize のスコアが高く、順位も上がる', () => {
    const w = newWorld();
    const clock = newClock();
    const social = addCritter(w, c(20, 20), { sociability: 1 });
    const shy = addCritter(w, c(40, 20), { sociability: 0 });
    const friendA = addCritter(w, c(21, 20));
    const friendB = addCritter(w, c(41, 20));
    for (const a of [social, shy, friendA, friendB]) a.needs.social = 75;

    const s = byKind(scoreCandidates(w, social, ctxAt(clock, DAY_TICK)), 'socialize')?.score ?? 0;
    const h = byKind(scoreCandidates(w, shy, ctxAt(clock, DAY_TICK)), 'socialize')?.score ?? 0;
    expect(s).toBeGreaterThan(h);
    expect(top(scoreCandidates(w, social, ctxAt(clock, DAY_TICK))).kind).toBe('socialize');
  });

  it('元気な個体は眠りにくい（sleep のスコアが低い）', () => {
    const w = newWorld();
    const clock = newClock();
    const lively = addCritter(w, c(20, 20), { energy: 1 });
    const sleepy = addCritter(w, c(40, 20), { energy: 0 });
    lively.needs.sleep = 70;
    sleepy.needs.sleep = 70;

    const l = byKind(scoreCandidates(w, lively, ctxAt(clock, NIGHT_TICK)), 'sleep')?.score ?? 0;
    const s = byKind(scoreCandidates(w, sleepy, ctxAt(clock, NIGHT_TICK)), 'sleep')?.score ?? 0;
    expect(l).toBeLessThan(s);
  });

  it('寝ている相手は socialize の相手にならない', () => {
    const w = newWorld();
    const a = addCritter(w, c(20, 20), { sociability: 1 });
    const b = addCritter(w, c(21, 20));
    a.needs.social = 80;
    b.anim = 'sleep';
    expect(byKind(scoreCandidates(w, a, ctxAt(newClock(), DAY_TICK)), 'socialize')).toBeUndefined();
  });
});

// ---------- 脅威 ----------

describe('scoreCandidates 脅威', () => {
  it('プレイヤーが近いと flee が最上位になる', () => {
    const w = newWorld();
    const a = addCritter(w, c(20, 20), { caution: 0.8 });
    a.needs.hunger = 80;
    addResource(w, 'berry_tree', c(21, 20));
    createPlayerActor(w, { name: 'p', pos: c(21, 21) });

    const cands = scoreCandidates(w, a, ctxAt(newClock(), DAY_TICK));
    const best = top(cands);
    expect(best.kind).toBe('flee');
    // 逃げ先は脅威から離れる方向
    const t = best.targetTile as Vec2;
    expect(distance(t, c(21, 21))).toBeGreaterThan(distance(a.pos, c(21, 21)));
  });

  it('脅威が遠ければ flee 候補は出ない', () => {
    const w = newWorld();
    const a = addCritter(w, c(20, 20));
    createPlayerActor(w, { name: 'p', pos: c(40, 40) });
    expect(byKind(scoreCandidates(w, a, ctxAt(newClock(), DAY_TICK)), 'flee')).toBeUndefined();
  });

  it('いのししは他個体に恐れられるが、いのしし同士では怖がらない', () => {
    const w = newWorld();
    const clock = newClock();
    const rabbit = addCritter(w, c(20, 20), { caution: 0.8 }, 'rabbit');
    addCritter(w, c(22, 20), {}, 'boar');
    expect(byKind(scoreCandidates(w, rabbit, ctxAt(clock, DAY_TICK)), 'flee')).toBeDefined();

    const w2 = newWorld();
    const boar = addCritter(w2, c(20, 20), { caution: 0.8 }, 'boar');
    addCritter(w2, c(22, 20), {}, 'boar');
    expect(byKind(scoreCandidates(w2, boar, ctxAt(clock, DAY_TICK)), 'flee')).toBeUndefined();
  });
});

// ---------- 重みの置き場所（D-7） ----------

describe('CRITTER_WEIGHTS', () => {
  it('shared/constants.ts の CRITTER_WEIGHTS をそのまま参照している', () => {
    // critter.ts の中に重みを持たない（定数は constants.ts に集約する方針）
    expect(CRITTER_WEIGHTS).toBe(SHARED_CRITTER_WEIGHTS);
  });
});

// ---------- 密集の緩和（D-7） ----------

describe('crowdFactor（密集の割引）', () => {
  const W = CRITTER_WEIGHTS.crowd;

  it('少人数（free体まで）は割り引かない', () => {
    const w = newWorld();
    const list: Actor[] = [];
    for (let i = 0; i < W.free; i++) list.push(addCritter(w, c(20, 20)));
    expect(crowdFactor(list, c(20, 20))).toBe(1);
  });

  it('free を超えると1体ごとに下がり、floor で止まる', () => {
    const w = newWorld();
    const list: Actor[] = [];
    for (let i = 0; i < W.free + 1; i++) list.push(addCritter(w, c(20, 20)));
    const one = crowdFactor(list, c(20, 20));
    expect(one).toBeCloseTo(1 - W.penaltyPerActor, 6);

    for (let i = 0; i < 20; i++) list.push(addCritter(w, c(20, 20)));
    expect(crowdFactor(list, c(20, 20))).toBe(W.floor);
  });

  it('半径の外にいる個体は数えない', () => {
    const w = newWorld();
    const far: Actor[] = [];
    for (let i = 0; i < 10; i++) far.push(addCritter(w, c(30 + i, 30)));
    expect(crowdFactor(far, c(20, 20))).toBe(1);
  });
});

describe('密集していると候補のスコアが下がる（D-7）', () => {
  it('相手のまわりが混んでいると socialize のスコアが下がる（が0にはならない）', () => {
    const mk = (extra: number): number => {
      const w = newWorld();
      const a = addCritter(w, c(20, 20));
      a.needs.social = 80;
      const partner = addCritter(w, c(22, 20));
      partner.needs.social = 80;
      // 相手のまわりに extra 体（同じタイル）を足す
      for (let i = 0; i < extra; i++) addCritter(w, c(22, 20));
      return byKind(scoreCandidates(w, a, ctxAt(newClock(), DAY_TICK)), 'socialize')?.score ?? 0;
    };
    const alone = mk(0);
    const crowded = mk(8);
    expect(alone).toBeGreaterThan(0);
    expect(crowded).toBeLessThan(alone);
    // 群れと繁殖を殺さないための床（floor 未満には落ちない）
    expect(crowded).toBeGreaterThanOrEqual(alone * CRITTER_WEIGHTS.crowd.floor - 1e-9);
  });

  it('混んでいる水場は drink のスコアが下がる', () => {
    const mk = (extra: number): number => {
      const w = newWorld();
      const a = addCritter(w, c(20, 20));
      a.needs.hunger = 60;
      addResource(w, 'water', c(24, 20), 20);
      for (let i = 0; i < extra; i++) addCritter(w, c(24, 20));
      return byKind(scoreCandidates(w, a, ctxAt(newClock(), DAY_TICK)), 'drink')?.score ?? 0;
    };
    expect(mk(8)).toBeLessThan(mk(0));
  });

  it('混んでいるベンチは goto のスコアが下がる', () => {
    const mk = (extra: number): number => {
      const w = newWorld();
      const a = addCritter(w, c(20, 20));
      w.addPlaceable({ id: w.allocId(), type: 'bench', pos: c(24, 20), ownerId: 'p1', attract: 12 });
      for (let i = 0; i < extra; i++) addCritter(w, c(24, 20));
      return byKind(scoreCandidates(w, a, ctxAt(newClock(), DAY_TICK)), 'goto')?.score ?? 0;
    };
    expect(mk(8)).toBeLessThan(mk(0));
  });

  it('空腹0の個体は水場へ行きたがらない（drinkIdleNeed）', () => {
    const w = newWorld();
    const a = addCritter(w, c(20, 20)); // needs は全部0
    addResource(w, 'water', c(21, 20), 20);
    const drink = byKind(scoreCandidates(w, a, ctxAt(newClock(), DAY_TICK)), 'drink');
    expect(drink).toBeDefined();
    // 水場が隣（距離1）でも徘徊に勝たない = 暇な個体が水際に溜まらない
    const wander = byKind(scoreCandidates(w, a, ctxAt(newClock(), DAY_TICK)), 'wander');
    expect((drink as Candidate).score).toBeLessThan((wander as Candidate).score);
  });

  it('空腹なら水は飲みに行く（drinkIdleNeed を下げても渇きは効く）', () => {
    const w = newWorld();
    const a = addCritter(w, c(20, 20));
    a.needs.hunger = 95;
    addResource(w, 'water', c(21, 20), 20);
    const drink = byKind(scoreCandidates(w, a, ctxAt(newClock(), DAY_TICK)), 'drink') as Candidate;
    const wander = byKind(scoreCandidates(w, a, ctxAt(newClock(), DAY_TICK)), 'wander') as Candidate;
    expect(drink.score).toBeGreaterThan(wander.score);
  });
});

describe('逃走先は歩けるタイル（D-7）', () => {
  it('海に向かって逃げない（袋小路でも陸を選ぶ）', () => {
    const w = newWorld();
    // 東側をすべて水にして、東へ逃げられない状況を作る
    fill(w, 22, 0, 40, 40, 'water');
    const a = addCritter(w, c(21, 20), { caution: 0.9 });
    createPlayerActor(w, { name: 'p', pos: c(19, 20) }); // 西から迫る = 素直に逃げると東（海）
    const flee = byKind(scoreCandidates(w, a, ctxAt(newClock(), DAY_TICK)), 'flee') as Candidate;
    expect(flee).toBeDefined();
    const t = flee.targetTile as Vec2;
    expect(w.isWalkableTile(Math.floor(t.x), Math.floor(t.y))).toBe(true);
  });
});

// ---------- 設置物 ----------

describe('scoreCandidates 設置物', () => {
  it('attract が大きいほど goto のスコアが高い', () => {
    const w = newWorld();
    const clock = newClock();
    const a = addCritter(w, c(20, 20));
    w.addPlaceable({ id: w.allocId(), type: 'bench', pos: c(24, 20), ownerId: 'p1', attract: 1 });
    const weak = byKind(scoreCandidates(w, a, ctxAt(clock, DAY_TICK)), 'goto')?.score ?? 0;

    const w2 = newWorld();
    const a2 = addCritter(w2, c(20, 20));
    w2.addPlaceable({ id: w2.allocId(), type: 'bench', pos: c(24, 20), ownerId: 'p1', attract: 12 });
    const strong = byKind(scoreCandidates(w2, a2, ctxAt(clock, DAY_TICK)), 'goto')?.score ?? 0;

    expect(weak).toBeGreaterThan(0);
    expect(strong).toBeGreaterThan(weak);
  });

  it('attract の強いベンチは、欲求が落ち着いている個体の最上位になる', () => {
    const w = newWorld();
    const a = addCritter(w, c(20, 20));
    a.needs.curiosity = 30;
    w.addPlaceable({ id: w.allocId(), type: 'bench', pos: c(22, 20), ownerId: 'p1', attract: 15 });
    const best = top(scoreCandidates(w, a, ctxAt(newClock(), DAY_TICK)));
    expect(best.kind).toBe('goto');
    expect(best.targetEntity).toBeDefined();
  });

  it('attract が0の設置物は候補にならない', () => {
    const w = newWorld();
    const a = addCritter(w, c(20, 20));
    w.addPlaceable({ id: w.allocId(), type: 'signboard', pos: c(22, 20), ownerId: 'p1', attract: 0 });
    expect(byKind(scoreCandidates(w, a, ctxAt(newClock(), DAY_TICK)), 'goto')).toBeUndefined();
  });
});

// ---------- ヒステリシス ----------

describe('chooseAction ヒステリシス', () => {
  it('僅差なら現在の行動を続ける', () => {
    const w = newWorld();
    const clock = newClock();
    const a = addCritter(w, c(20, 20));
    a.needs.sleep = 60;
    a.needs.hunger = 85;
    const food = addResource(w, 'berry_tree', c(25, 20));

    const cands = scoreCandidates(w, a, ctxAt(clock, NIGHT_TICK));
    const sleep = byKind(cands, 'sleep') as Candidate;
    const eat = byKind(cands, 'eat') as Candidate;
    // 前提: sleep がわずかに勝っている（差はヒステリシス未満）
    expect(sleep.score).toBeGreaterThan(eat.score);
    expect(sleep.score - eat.score).toBeLessThan(CRITTER_WEIGHTS.hysteresis);

    // 行動がなければ sleep を選ぶ
    expect(chooseAction(w, a, ctxAt(clock, NIGHT_TICK))?.kind).toBe('sleep');

    // すでに eat 中なら eat を続ける
    a.action = { kind: 'eat', targetEntity: food.id, startedAtTick: 0, durationTicks: 12 };
    expect(chooseAction(w, a, ctxAt(clock, NIGHT_TICK))?.kind).toBe('eat');
  });

  it('大差がつけばヒステリシスを越えて行動が切り替わる', () => {
    const w = newWorld();
    const clock = newClock();
    const a = addCritter(w, c(20, 20));
    a.needs.sleep = 95;
    const food = addResource(w, 'berry_tree', c(30, 20));
    a.action = { kind: 'eat', targetEntity: food.id, startedAtTick: 0, durationTicks: 12 };
    expect(chooseAction(w, a, ctxAt(clock, NIGHT_TICK))?.kind).toBe('sleep');
  });

  it('毎tick評価しても行動がちらつかない', () => {
    const w = newWorld();
    const clock = newClock();
    const a = addCritter(w, c(20, 20));
    a.needs.hunger = 70;
    a.needs.curiosity = 50;
    addResource(w, 'berry_tree', c(24, 20), 100);

    let switches = 0;
    let prev: string | null = null;
    for (let t = DAY_TICK; t < DAY_TICK + 60; t++) {
      const best = chooseAction(w, a, ctxAt(clock, t)) as Candidate;
      if (prev !== null && prev !== best.kind) switches++;
      prev = best.kind;
      a.action = {
        kind: best.kind,
        targetEntity: best.targetEntity,
        targetTile: best.targetTile,
        startedAtTick: t,
        durationTicks: 12,
      };
    }
    expect(switches).toBe(0);
  });
});

// ---------- CritterAI ----------

describe('CritterAI', () => {
  it('time slicing が効いている（1tickで全個体を評価しない）', () => {
    const w = newWorld();
    const clock = newClock();
    const ai = new CritterAI(w, new NavService(w), clock);
    for (let i = 0; i < 32; i++) addCritter(w, c(20 + (i % 8) * 2, 20 + Math.floor(i / 8) * 2));

    ai.update(DAY_TICK);
    const one = ai.stats().evaluated;
    expect(one).toBeGreaterThan(0);
    expect(one).toBeLessThanOrEqual(32 / CRITTER_WEIGHTS.sliceMod + 1);

    // 8tickで全員がちょうど1回評価される
    for (let t = 1; t < CRITTER_WEIGHTS.sliceMod; t++) ai.update(DAY_TICK + t);
    expect(ai.stats().evaluated).toBe(32);
  });

  it('プレイヤーは評価対象にしない', () => {
    const w = newWorld();
    const ai = new CritterAI(w, new NavService(w), newClock());
    for (let i = 0; i < 8; i++) createPlayerActor(w, { name: `p${i}`, pos: c(20 + i, 20) });
    for (let t = 0; t < CRITTER_WEIGHTS.sliceMod; t++) ai.update(DAY_TICK + t);
    expect(ai.stats().evaluated).toBe(0);
  });

  it('遠い資源へは nav にリクエストを出す（自分でA*しない）', () => {
    const w = newWorld();
    const nav = new NavService(w);
    const ai = new CritterAI(w, nav, newClock());
    const a = addCritter(w, c(20, 20));
    a.needs.hunger = 90;
    addResource(w, 'berry_tree', c(40, 20), 100);

    // 自分のスライスのtickで評価させる
    const tick = DAY_TICK + ((a.id - DAY_TICK) % CRITTER_WEIGHTS.sliceMod + CRITTER_WEIGHTS.sliceMod) % CRITTER_WEIGHTS.sliceMod;
    ai.update(tick);
    expect(a.action?.kind).toBe('eat');
    expect(nav.pending()).toBe(1);
  });

  it('1tickに出す経路リクエストは上限を超えない', () => {
    const w = newWorld();
    const nav = new NavService(w);
    const ai = new CritterAI(w, nav, newClock());
    // 全個体を同じスライスに乗せる（idを8の倍数間隔にする）
    for (let i = 0; i < 40; i++) {
      const a = addCritter(w, c(20 + (i % 10), 20 + Math.floor(i / 10)));
      a.needs.hunger = 95;
    }
    addResource(w, 'berry_tree', c(60, 60), 1000);
    for (let t = 0; t < CRITTER_WEIGHTS.sliceMod; t++) {
      nav.update();
      const before = nav.pending();
      ai.update(DAY_TICK + t);
      expect(nav.pending() - before).toBeLessThanOrEqual(CRITTER_WEIGHTS.navRequestsPerTick);
    }
  });

  it('採食が完了すると資源が減り、空腹が満たされる', () => {
    const w = newWorld();
    const nav = new NavService(w);
    const ai = new CritterAI(w, nav, newClock());
    const a = addCritter(w, c(20, 20));
    a.needs.hunger = 90;
    const node = addResource(w, 'berry_tree', c(20, 20), 6);

    a.action = { kind: 'eat', targetEntity: node.id, startedAtTick: 0, durationTicks: CRITTER_WEIGHTS.duration.eat };
    for (let t = 1; t <= CRITTER_WEIGHTS.duration.eat + 2; t++) ai.resolveActions(t);

    expect(node.amount).toBeLessThan(6);
    expect(a.needs.hunger).toBeLessThan(90);
    expect(a.action).toBeNull();
    expect(a.anim).not.toBe('act');
    // 収穫で荒廃度が上がる
    expect(w.decayAt(20, 20)).toBeGreaterThan(0);
  });

  it('就寝中は anim が sleep になり、完了で眠気が減る', () => {
    const w = newWorld();
    const ai = new CritterAI(w, new NavService(w), newClock());
    const a = addCritter(w, c(20, 20));
    a.needs.sleep = 90;
    a.action = { kind: 'sleep', startedAtTick: 0, durationTicks: 10 };

    ai.resolveActions(1);
    expect(a.anim).toBe('sleep');
    for (let t = 2; t <= 12; t++) ai.resolveActions(t);
    expect(a.needs.sleep).toBeLessThan(90);
    expect(a.anim).toBe('idle');
  });

  it('巣づくりが完了すると安全欲が満たされ、次の寝床になる', () => {
    const w = newWorld();
    const ai = new CritterAI(w, new NavService(w), newClock());
    const a = addCritter(w, c(20, 20));
    a.needs.safety = 80;
    a.needs.sleep = 60;
    a.action = { kind: 'nest', targetTile: c(20, 20), startedAtTick: 0, durationTicks: 4 };
    for (let t = 1; t <= 6; t++) ai.resolveActions(t);
    expect(a.needs.safety).toBeLessThan(80);

    const cands = scoreCandidates(w, a, ctxAt(newClock(), NIGHT_TICK));
    const sleep = byKind(cands, 'sleep') as Candidate;
    expect(sleep.targetTile).toEqual(c(20, 20));
  });

  it('対象の資源が消えたら行動を破棄する', () => {
    const w = newWorld();
    const ai = new CritterAI(w, new NavService(w), newClock());
    const a = addCritter(w, c(20, 20));
    const node = addResource(w, 'berry_tree', c(30, 20));
    a.action = { kind: 'eat', targetEntity: node.id, startedAtTick: 0, durationTicks: 12 };
    w.resources.delete(node.id);
    ai.resolveActions(1);
    expect(a.action).toBeNull();
  });

  it('着かない目的地は打ち切る（水の向こう側など）', () => {
    const w = newWorld();
    fill(w, 25, 0, 27, 127, 'water');
    const ai = new CritterAI(w, new NavService(w), newClock());
    const a = addCritter(w, c(20, 20));
    a.action = { kind: 'goto', targetTile: c(40, 20), startedAtTick: 0, durationTicks: 12 };
    for (let t = 1; t <= CRITTER_WEIGHTS.travelTimeoutTicks + 2; t++) ai.resolveActions(t);
    expect(a.action).toBeNull();
  });

  it('relation.ts が入れた targetのない flee も安全に完了する', () => {
    const w = newWorld();
    const ai = new CritterAI(w, new NavService(w), newClock());
    const a = addCritter(w, c(20, 20));
    a.action = { kind: 'flee', startedAtTick: 0, durationTicks: 8 };
    for (let t = 1; t <= 10; t++) ai.resolveActions(t);
    expect(a.action).toBeNull();
  });

  it('stats() が行動の内訳を返す', () => {
    const w = newWorld();
    const ai = new CritterAI(w, new NavService(w), newClock());
    for (let i = 0; i < 16; i++) {
      const a = addCritter(w, c(20 + i, 20));
      a.needs.sleep = 80;
    }
    for (let t = 0; t < CRITTER_WEIGHTS.sliceMod; t++) ai.update(NIGHT_TICK + t);
    const s = ai.stats();
    expect(s.evaluated).toBe(16);
    expect(s.switched).toBeGreaterThan(0);
    expect(s.byAction['sleep']).toBeGreaterThan(0);
  });
});

// ---------- 集団としての振る舞い ----------

describe('集団としての振る舞い', () => {
  it('夜は6割以上が就寝する', () => {
    const w = newWorld();
    const nav = new NavService(w);
    const clock = newClock();
    const ai = new CritterAI(w, nav, clock);
    for (let i = 0; i < 60; i++) {
      const a = addCritter(w, c(20 + (i % 10) * 2, 20 + Math.floor(i / 10) * 2), {
        energy: (i % 5) / 4,
        gluttony: (i % 4) / 3,
      });
      // 夜の入り口の想定値（1島日ぶんの眠気が溜まっている）
      a.needs.sleep = 55 + (i % 20);
      a.needs.hunger = 30 + (i % 30);
      a.needs.social = 20 + (i % 25);
    }
    for (let i = 0; i < 12; i++) addResource(w, 'berry_tree', c(24 + i, 34), 100);
    addResource(w, 'water', c(30, 40), 1000);

    for (let t = 0; t < 200; t++) {
      const tick = NIGHT_TICK + t;
      ai.update(tick);
      nav.update();
      updateMovement(w, 0.25);
    }

    let sleeping = 0;
    for (const a of w.actors.values()) if (a.action?.kind === 'sleep') sleeping++;
    expect(sleeping / 60).toBeGreaterThan(0.6);
  });

  it('雨の日は森の近くに集まる', () => {
    const w = newWorld();
    fill(w, 40, 40, 46, 46, 'forest');
    const nav = new NavService(w);
    const ai = new CritterAI(w, nav, newClock({ weather: 'rain' }));
    const critters: Actor[] = [];
    for (let i = 0; i < 24; i++) {
      const a = addCritter(w, c(30 + (i % 6), 30 + Math.floor(i / 6)));
      a.needs.hunger = 25 + (i % 10);
      a.needs.curiosity = 20 + (i % 10);
      critters.push(a);
    }
    const grove = c(43, 43);
    const before = critters.reduce((s, a) => s + distance(a.pos, grove), 0) / critters.length;

    for (let t = 0; t < 300; t++) {
      ai.update(DAY_TICK + t);
      nav.update();
      updateMovement(w, 0.25);
    }
    const after = critters.reduce((s, a) => s + distance(a.pos, grove), 0) / critters.length;
    expect(after).toBeLessThan(before * 0.5);
  });

  it('食料が1本しかなければ同じ資源に集まる（ケンカの素地）', () => {
    const w = newWorld();
    const nav = new NavService(w);
    const ai = new CritterAI(w, nav, newClock());
    const critters: Actor[] = [];
    for (let i = 0; i < 16; i++) {
      const a = addCritter(w, c(20 + (i % 4), 20 + Math.floor(i / 4)));
      a.needs.hunger = 85 + (i % 10);
      critters.push(a);
    }
    const node = addResource(w, 'berry_tree', c(26, 26), 10_000);

    // 同じ資源を対象に、かつ至近距離で eat している個体の同時数（relation.ts の競合判定と同条件）
    let maxCompeting = 0;
    for (let t = 0; t < 120; t++) {
      ai.update(DAY_TICK + t);
      nav.update();
      updateMovement(w, 0.25);
      const eating = critters.filter((a) => a.action?.kind === 'eat' && a.action.targetEntity === node.id);
      let closePairs = 0;
      for (const a of eating) {
        if (eating.some((b) => b.id !== a.id && distance(a.pos, b.pos) <= 2)) closePairs++;
      }
      maxCompeting = Math.max(maxCompeting, closePairs);
    }
    expect(maxCompeting).toBeGreaterThanOrEqual(2);
  });
});

// ---------- 負荷 ----------

describe('負荷', () => {
  it('120体で100tick回しても例外が出ず、1tickの処理が軽い', () => {
    const w = newWorld();
    fill(w, 60, 60, 70, 70, 'forest');
    const nav = new NavService(w);
    const clock = newClock();
    const ai = new CritterAI(w, nav, clock);

    for (let i = 0; i < MAX_CRITTERS; i++) {
      const a = addCritter(w, c(20 + (i % 12) * 3, 20 + Math.floor(i / 12) * 3), {
        energy: (i % 7) / 6,
        sociability: (i % 5) / 4,
        caution: (i % 3) / 2,
        gluttony: (i % 4) / 3,
        curiosity: (i % 6) / 5,
      });
      a.needs = { hunger: (i * 7) % 100, sleep: (i * 11) % 100, social: (i * 13) % 100, safety: (i * 3) % 40, curiosity: (i * 17) % 100 };
    }
    for (let i = 0; i < 180; i++) addResource(w, i % 3 === 0 ? 'field' : 'berry_tree', c(10 + ((i * 5) % 100), 10 + ((i * 7) % 100)), 50);
    for (let i = 0; i < 12; i++) addResource(w, 'water', c(15 + i * 8, 100), 1000);
    for (let i = 0; i < 6; i++) w.addPlaceable({ id: w.allocId(), type: 'bench', pos: c(30 + i * 10, 60), ownerId: 'p1', attract: 6 });

    const t0 = performance.now();
    const ticks = 100;
    for (let t = 0; t < ticks; t++) {
      ai.update(DAY_TICK + t);
      nav.update();
      updateMovement(w, 0.25);
    }
    const perTick = (performance.now() - t0) / ticks;

    expect(w.countActors('critter')).toBe(MAX_CRITTERS);
    expect(ai.stats().evaluated).toBeGreaterThan(0);
    // 目標は tick 全体で 40ms。critterAI + nav + movement でこの範囲に収まっていること
    expect(perTick).toBeLessThan(20);
  });
});
