/**
 * movement.ts（経路追従 / 衝突押し出し / 軸入力）のテスト
 * worldgen には依存しない。既定の世界は全面 grass（TERRAINS[0]）で歩ける。
 */
import { describe, expect, it } from 'vitest';
import { ACTOR_RADIUS, MAP_H, MAP_W, Rng, TICK_SEC, type Vec2 } from '@ai-pet/shared';
import { IslandWorld, distance } from '../../packages/server/src/sim/world.ts';
import { createCritterActor, createPlayerActor } from '../../packages/server/src/sim/actors.ts';
import { clearAxisInput, setAxisInput, updateMovement } from '../../packages/server/src/sim/movement.ts';

function newWorld(): IslandWorld {
  return new IslandWorld(new Rng('t'));
}

function fill(world: IslandWorld, x0: number, y0: number, x1: number, y1: number, t: 'water' | 'grass'): void {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) world.setTerrain(x, y, t);
  }
}

const c = (x: number, y: number): Vec2 => ({ x: x + 0.5, y: y + 0.5 });

describe('updateMovement 経路追従', () => {
  it('経路に沿って進み、着いたら path が null になる', () => {
    const w = newWorld();
    const a = createCritterActor(w, { species: 'rabbit', pos: c(10, 10) });
    a.speed = 2;
    a.path = [c(11, 10), c(12, 10)];

    updateMovement(w, TICK_SEC); // 0.5タイル進む
    expect(a.pos.x).toBeGreaterThan(10.5);
    expect(a.pos.y).toBeCloseTo(10.5, 6);
    expect(a.path).not.toBeNull();

    for (let i = 0; i < 20; i++) updateMovement(w, TICK_SEC);
    expect(a.pos.x).toBeCloseTo(12.5, 2);
    expect(a.path).toBeNull();
  });

  it('1tickの予算で複数の経路点を消化できる', () => {
    const w = newWorld();
    const a = createCritterActor(w, { species: 'cat', pos: c(10, 10) });
    a.speed = 12; // 1tickで3タイル分
    a.path = [c(11, 10), c(12, 10), c(13, 10)];
    updateMovement(w, TICK_SEC);
    expect(a.pos.x).toBeCloseTo(13.5, 2);
    expect(a.path).toBeNull();
  });

  it('水には入らない（岸で止まる）', () => {
    const w = newWorld();
    fill(w, 15, 0, 20, 30, 'water');
    const a = createCritterActor(w, { species: 'frog', pos: c(10, 10) });
    a.speed = 3;
    // 水の中を目指す経路を与える（本来 nav が作らないが、防御を確認する）
    a.path = [{ x: 17.5, y: 10.5 }];
    for (let i = 0; i < 40; i++) updateMovement(w, TICK_SEC);
    expect(w.canStandAt(a.pos)).toBe(true);
    expect(a.pos.x).toBeLessThan(15);
  });

  it('マップ外に出ない', () => {
    const w = newWorld();
    const a = createPlayerActor(w, { name: 'ぽこ', pos: { x: 2, y: 2 } });
    setAxisInput(a, -1, -1);
    for (let i = 0; i < 60; i++) updateMovement(w, TICK_SEC);
    expect(a.pos.x).toBeGreaterThanOrEqual(ACTOR_RADIUS - 1e-9);
    expect(a.pos.y).toBeGreaterThanOrEqual(ACTOR_RADIUS - 1e-9);
    clearAxisInput(a);

    a.pos.x = MAP_W - 2;
    a.pos.y = MAP_H - 2;
    setAxisInput(a, 1, 1);
    for (let i = 0; i < 60; i++) updateMovement(w, TICK_SEC);
    expect(a.pos.x).toBeLessThanOrEqual(MAP_W - ACTOR_RADIUS + 1e-9);
    expect(a.pos.y).toBeLessThanOrEqual(MAP_H - ACTOR_RADIUS + 1e-9);
    clearAxisInput(a);
  });

  it('斜め入力で壁に当たったら軸ごとに滑る', () => {
    const w = newWorld();
    // x=12 の縦壁
    fill(w, 12, 0, 12, 30, 'water');
    const a = createPlayerActor(w, { name: 'もふ', pos: c(11, 10) });
    a.speed = 3;
    setAxisInput(a, 1, 1); // 右下へ。右は壁なので下だけ進む
    const x0 = a.pos.x;
    updateMovement(w, TICK_SEC);
    expect(a.pos.x).toBeCloseTo(x0, 6);
    expect(a.pos.y).toBeGreaterThan(10.5);
    clearAxisInput(a);
  });
});

describe('updateMovement 衝突', () => {
  it('重なった2体は押し出されて半径2つ分まで離れる', () => {
    const w = newWorld();
    const a = createCritterActor(w, { species: 'rabbit', pos: { x: 20.4, y: 20.5 } });
    const b = createCritterActor(w, { species: 'rabbit', pos: { x: 20.6, y: 20.5 } });
    updateMovement(w, TICK_SEC);
    expect(distance(a.pos, b.pos)).toBeGreaterThanOrEqual(ACTOR_RADIUS * 2 - 1e-6);
  });

  it('完全に同じ座標でも決定論的に分離する', () => {
    const w = newWorld();
    const a = createCritterActor(w, { species: 'cat', pos: { x: 30.5, y: 30.5 } });
    const b = createCritterActor(w, { species: 'cat', pos: { x: 30.5, y: 30.5 } });
    updateMovement(w, TICK_SEC);
    expect(distance(a.pos, b.pos)).toBeGreaterThan(0.3);
  });

  it('押し出しても水に入らない', () => {
    const w = newWorld();
    fill(w, 41, 0, 60, 60, 'water');
    const a = createCritterActor(w, { species: 'boar', pos: { x: 40.5, y: 20.5 } });
    const b = createCritterActor(w, { species: 'boar', pos: { x: 40.6, y: 20.5 } });
    updateMovement(w, TICK_SEC);
    expect(w.canStandAt(a.pos)).toBe(true);
    expect(w.canStandAt(b.pos)).toBe(true);
  });
});

describe('updateMovement anim と facing', () => {
  it('動いていれば walk、止まれば idle', () => {
    const w = newWorld();
    const a = createCritterActor(w, { species: 'bird', pos: c(10, 10) });
    a.speed = 2;
    a.path = [c(11, 10)];
    updateMovement(w, TICK_SEC);
    expect(a.anim).toBe('walk');
    a.path = null;
    updateMovement(w, TICK_SEC);
    expect(a.anim).toBe('idle');
  });

  it('sleep / act のときは anim を上書きしない', () => {
    const w = newWorld();
    const a = createCritterActor(w, { species: 'squirrel', pos: c(10, 10) });
    a.speed = 2;
    a.anim = 'sleep';
    a.path = [c(11, 10)];
    updateMovement(w, TICK_SEC);
    expect(a.anim).toBe('sleep');

    a.anim = 'act';
    updateMovement(w, TICK_SEC);
    expect(a.anim).toBe('act');
  });

  it('移動方向に facing が向く', () => {
    const w = newWorld();
    const a = createCritterActor(w, { species: 'rabbit', pos: c(10, 10) });
    a.speed = 2;

    a.path = [c(13, 10)];
    updateMovement(w, TICK_SEC);
    expect(a.facing).toBe('e');

    a.pos = c(10, 10);
    a.path = [c(7, 10)];
    updateMovement(w, TICK_SEC);
    expect(a.facing).toBe('w');

    a.pos = c(10, 10);
    a.path = [c(10, 13)];
    updateMovement(w, TICK_SEC);
    expect(a.facing).toBe('s');

    a.pos = c(10, 10);
    a.path = [c(10, 7)];
    updateMovement(w, TICK_SEC);
    expect(a.facing).toBe('n');
  });
});

describe('軸入力', () => {
  it('軸入力は経路より優先され、経路は破棄される', () => {
    const w = newWorld();
    const a = createPlayerActor(w, { name: 'てん', pos: c(10, 10) });
    a.speed = 4;
    a.path = [c(10, 20)]; // 下へ向かう経路
    setAxisInput(a, 1, 0); // 右へのキー入力
    expect(a.path).toBeNull();
    updateMovement(w, TICK_SEC);
    expect(a.pos.x).toBeCloseTo(11.5, 6);
    expect(a.pos.y).toBeCloseTo(10.5, 6);
    expect(a.facing).toBe('e');
    clearAxisInput(a);
  });

  it('斜め入力でも速度は正規化される', () => {
    const w = newWorld();
    const a = createPlayerActor(w, { name: 'ころ', pos: c(10, 10) });
    a.speed = 4;
    setAxisInput(a, 1, 1);
    updateMovement(w, TICK_SEC);
    expect(distance(a.pos, c(10, 10))).toBeCloseTo(1, 6);
    clearAxisInput(a);
  });

  it('clearAxisInput で止まる', () => {
    const w = newWorld();
    const a = createPlayerActor(w, { name: 'しろ', pos: c(10, 10) });
    a.speed = 4;
    setAxisInput(a, 1, 0);
    updateMovement(w, TICK_SEC);
    clearAxisInput(a);
    const x = a.pos.x;
    updateMovement(w, TICK_SEC);
    expect(a.pos.x).toBeCloseTo(x, 6);
    expect(a.anim).toBe('idle');
  });

  it('setAxisInput(0,0) は入力解除として扱う', () => {
    const w = newWorld();
    const a = createPlayerActor(w, { name: 'くろ', pos: c(10, 10) });
    a.speed = 4;
    setAxisInput(a, 1, 0);
    setAxisInput(a, 0, 0);
    updateMovement(w, TICK_SEC);
    expect(a.pos.x).toBeCloseTo(10.5, 6);
  });
});
