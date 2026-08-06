/**
 * nav.ts（A* / 直進判定 / NavService）のテスト
 *
 * worldgen には依存させない。地形はこのファイル内で手で作る。
 * Uint8Array の初期値0は TERRAINS[0] = 'grass' なので、既定の世界は全面歩ける草地になる。
 */
import { describe, expect, it } from 'vitest';
import { MAP_W, Rng, type Vec2 } from '@ai-pet/shared';
import { IslandWorld } from '../../packages/server/src/sim/world.ts';
import { createCritterActor } from '../../packages/server/src/sim/actors.ts';
import {
  NAV_REQUESTS_PER_TICK,
  NavService,
  findPath,
  hasLineOfWalk,
  nearestWalkable,
} from '../../packages/server/src/sim/nav.ts';

function newWorld(): IslandWorld {
  return new IslandWorld(new Rng('t'));
}

/** 矩形を指定地形で塗る */
function fill(world: IslandWorld, x0: number, y0: number, x1: number, y1: number, t: 'water' | 'grass'): void {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) world.setTerrain(x, y, t);
  }
}

const c = (x: number, y: number): Vec2 => ({ x: x + 0.5, y: y + 0.5 });

describe('findPath', () => {
  it('障害物がなければ直線的な最短経路を返し、from は含まない', () => {
    const w = newWorld();
    const path = findPath(w, c(10, 10), c(20, 10));
    expect(path).not.toBeNull();
    const p = path as Vec2[];
    expect(p.length).toBe(10);
    expect(p[0]).toEqual(c(11, 10));
    expect(p[p.length - 1]).toEqual(c(20, 10));
  });

  it('同じタイル内なら空配列を返す', () => {
    const w = newWorld();
    expect(findPath(w, { x: 10.1, y: 10.1 }, { x: 10.9, y: 10.9 })).toEqual([]);
  });

  it('壁があれば迂回する（経路長が直線より長くなる）', () => {
    const w = newWorld();
    // x=15 の縦壁。y=0..20 だけ塞ぎ、y=21 に隙間を残す
    fill(w, 15, 0, 15, 20, 'water');
    const path = findPath(w, c(10, 10), c(20, 10));
    expect(path).not.toBeNull();
    const p = path as Vec2[];
    expect(p.length).toBeGreaterThan(10);
    // 経路が水を通らない
    for (const step of p) {
      expect(w.isWalkableTile(Math.floor(step.x), Math.floor(step.y))).toBe(true);
    }
  });

  it('到達不能なら null', () => {
    const w = newWorld();
    // 目的地を水で完全に囲む
    fill(w, 30, 30, 40, 40, 'water');
    fill(w, 33, 33, 37, 37, 'grass');
    const path = findPath(w, c(10, 10), c(35, 35));
    expect(path).toBeNull();
  });

  it('目的地が歩けないタイルなら null', () => {
    const w = newWorld();
    fill(w, 50, 50, 52, 52, 'water');
    expect(findPath(w, c(10, 10), c(51, 51))).toBeNull();
  });

  it('maxNodes を超えたら null（無限ループ防止）', () => {
    const w = newWorld();
    // 迂回が必要な壁を置き、ノード上限を小さくする
    fill(w, 15, 0, 15, 100, 'water');
    expect(findPath(w, c(2, 50), c(100, 50), { maxNodes: 20 })).toBeNull();
    // 上限を戻せば見つかる
    expect(findPath(w, c(2, 50), c(100, 50), { maxNodes: 40000 })).not.toBeNull();
  });

  it('マップ外は null', () => {
    const w = newWorld();
    expect(findPath(w, c(10, 10), { x: MAP_W + 5, y: 10 })).toBeNull();
  });
});

describe('hasLineOfWalk', () => {
  it('近距離で障害物がなければ true', () => {
    const w = newWorld();
    expect(hasLineOfWalk(w, c(10, 10), c(18, 10))).toBe(true);
  });

  it('12タイルより遠ければ false', () => {
    const w = newWorld();
    expect(hasLineOfWalk(w, c(10, 10), c(30, 10))).toBe(false);
  });

  it('間に水があれば false', () => {
    const w = newWorld();
    fill(w, 14, 5, 14, 15, 'water');
    expect(hasLineOfWalk(w, c(10, 10), c(18, 10))).toBe(false);
  });

  it('目的地が水なら false', () => {
    const w = newWorld();
    fill(w, 18, 10, 18, 10, 'water');
    expect(hasLineOfWalk(w, c(10, 10), c(18, 10))).toBe(false);
  });
});

describe('nearestWalkable', () => {
  it('歩けるタイルならそのタイル中心を返す', () => {
    const w = newWorld();
    expect(nearestWalkable(w, { x: 10.2, y: 10.9 })).toEqual(c(10, 10));
  });

  it('水の中なら最も近い陸のタイル中心を返す', () => {
    const w = newWorld();
    fill(w, 20, 20, 24, 24, 'water');
    const got = nearestWalkable(w, c(22, 20));
    expect(got).not.toBeNull();
    const g = got as Vec2;
    expect(w.isWalkableTile(Math.floor(g.x), Math.floor(g.y))).toBe(true);
    // y=19 の陸がすぐ上にある
    expect(g.y).toBeCloseTo(19.5, 6);
  });

  it('maxRadius 内に歩けるタイルがなければ null', () => {
    const w = newWorld();
    fill(w, 40, 40, 70, 70, 'water');
    expect(nearestWalkable(w, c(55, 55), 3)).toBeNull();
  });
});

describe('NavService', () => {
  it('1tick で最大8件しか処理しない', () => {
    const w = newWorld();
    const nav = new NavService(w);
    const ids: number[] = [];
    for (let i = 0; i < 20; i++) {
      const a = createCritterActor(w, { species: 'rabbit', pos: c(2 + i, 2) });
      ids.push(a.id);
      // 直進最適化が効かない距離にする
      nav.request(a.id, c(2 + i, 60));
    }
    expect(nav.pending()).toBe(20);
    expect(nav.update()).toBe(NAV_REQUESTS_PER_TICK);
    expect(nav.pending()).toBe(20 - NAV_REQUESTS_PER_TICK);
    expect(nav.update()).toBe(NAV_REQUESTS_PER_TICK);
    expect(nav.update()).toBe(4);
    expect(nav.pending()).toBe(0);
    for (const id of ids) expect(w.actor(id)?.path).not.toBeNull();
  });

  it('同じアクターの重複リクエストは最新だけ残る', () => {
    const w = newWorld();
    const nav = new NavService(w);
    const a = createCritterActor(w, { species: 'cat', pos: c(5, 5) });
    nav.request(a.id, c(5, 40));
    nav.request(a.id, c(5, 50));
    expect(nav.pending()).toBe(1);
    nav.update();
    const path = a.path as Vec2[];
    expect(path[path.length - 1]).toEqual(c(5, 50));
  });

  it('近距離で直進できるなら A* を使わず1点の経路にする', () => {
    const w = newWorld();
    const nav = new NavService(w);
    const a = createCritterActor(w, { species: 'bird', pos: c(5, 5) });
    nav.request(a.id, c(11, 5));
    nav.update();
    expect(a.path).toEqual([c(11, 5)]);
    expect(nav.straightCount).toBe(1);
    expect(nav.astarCount).toBe(0);
  });

  it('目的地が水なら近くの陸へ寄せて経路を作る', () => {
    const w = newWorld();
    fill(w, 20, 20, 40, 40, 'water');
    const nav = new NavService(w);
    const a = createCritterActor(w, { species: 'frog', pos: c(5, 5) });
    nav.request(a.id, c(30, 30));
    nav.update();
    expect(a.path).not.toBeNull();
    const path = a.path as Vec2[];
    const last = path[path.length - 1] as Vec2;
    expect(w.isWalkableTile(Math.floor(last.x), Math.floor(last.y))).toBe(true);
  });

  it('clear で保留中のリクエストを取り消せる', () => {
    const w = newWorld();
    const nav = new NavService(w);
    const a = createCritterActor(w, { species: 'squirrel', pos: c(5, 5) });
    nav.request(a.id, c(5, 60));
    nav.clear(a.id);
    expect(nav.pending()).toBe(0);
    expect(nav.update()).toBe(0);
  });

  it('退場したアクターのリクエストは件数に数えない', () => {
    const w = newWorld();
    const nav = new NavService(w);
    const a = createCritterActor(w, { species: 'boar', pos: c(5, 5) });
    nav.request(a.id, c(5, 60));
    w.removeActor(a.id);
    expect(nav.update()).toBe(0);
  });
});
