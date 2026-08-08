/**
 * 島に散らす小オブジェクトのテスト（docs/03_宣伝用との乖離是正プラン C-4）。
 *
 * ここで守りたいのは5つ:
 * - 歩行不可のもの（岩・焚き火）を置いても**到達できない陸が0**であること（AI_CODING.md §8）
 * - 茂みと切り株は**歩けるまま**であること（見た目だけの飾りで歩行判定を増やさない）
 * - `attract` が全部0であること（餌の無い場所に動物が群がって餓死する。M3で踏んだ罠）
 * - 同じseedなら同じ配置（決定論）
 * - 焚き火は広場の近くに1つで、種別名が `campfire`（`lights.ts` が夜に光らせる名前）
 */
import { describe, expect, it } from 'vitest';
import { MAP_H, MAP_W, type Placeable, type PlaceableType } from '@ai-pet/shared';
import type { IslandWorld } from '../../packages/server/src/sim/world.ts';
import { tileIndex } from '../../packages/server/src/sim/world.ts';
import { BUILD_TUNING } from '../../packages/server/src/sim/build.ts';
import {
  generateIsland,
  reachableFromSpawn,
  walkableTileCount,
} from '../../packages/server/src/sim/worldgen.ts';
import { lightSpecFor } from '../../packages/client/src/render/lights.ts';

/** 生成が重いのでseedごとに1回だけ作る */
const SEEDS = ['pokomofu-2', 'pokomofu-001', 'shizuka-no-shima', 'seed-2026-08-06'] as const;

/** C-4 の4種 */
const DECOR_TYPES: readonly PlaceableType[] = ['campfire', 'rock', 'stump', 'bush'];
/** 歩けるままにするもの（見た目だけ） */
const WALKABLE_DECOR: readonly PlaceableType[] = ['stump', 'bush'];
/** 歩行不可にしてよいもの */
const SOLID_DECOR: readonly PlaceableType[] = ['campfire', 'rock'];

function decor(world: IslandWorld): Placeable[] {
  return [...world.placeables.values()].filter((p) => DECOR_TYPES.includes(p.type));
}

describe('scatterSmallObjects: 決定論', () => {
  it('同じseedなら種別・位置・attractまで一致する', () => {
    const a = generateIsland('decor-seed');
    const b = generateIsland('decor-seed');
    expect(decor(a)).toEqual(decor(b));
    // 歩行不可タイル（岩・焚き火の footprint を含む）も一致すること
    expect(Array.from(a.solid)).toEqual(Array.from(b.solid));
  });

  it('違うseedなら散らばる場所が変わる', () => {
    const a = decor(generateIsland('decor-alpha')).map((p) => `${p.type}@${p.pos.x},${p.pos.y}`);
    const b = decor(generateIsland('decor-beta')).map((p) => `${p.type}@${p.pos.x},${p.pos.y}`);
    expect(a).not.toEqual(b);
  });
});

describe('scatterSmallObjects: attract', () => {
  it('4種すべて attract 0（餌の無い場所に動物を集めない）', () => {
    for (const t of DECOR_TYPES) {
      expect(BUILD_TUNING.attract[t], t).toBe(0);
    }
  });

  it('置かれた設置物の attract も0', () => {
    for (const p of decor(generateIsland('decor-attract'))) expect(p.attract, p.type).toBe(0);
  });
});

describe('焚き火は lights.ts が夜に光らせる名前になっている', () => {
  it('種別名 campfire に光の仕様がある', () => {
    const spec = lightSpecFor('campfire');
    expect(spec).not.toBeNull();
    // 焚き火は揺れる（ランタンと違って明滅する）
    expect((spec as { flicker: number }).flicker).toBeGreaterThan(0);
  });
});

describe.each(SEEDS)('scatterSmallObjects(%s)', (seed) => {
  const world = generateIsland(seed);
  const items = decor(world);

  it('4種すべてが島に置かれている', () => {
    for (const t of DECOR_TYPES) {
      expect(items.filter((p) => p.type === t).length, t).toBeGreaterThan(0);
    }
  });

  it('焚き火は1つだけで、広場の中心から8タイル以内にある', () => {
    const fires = items.filter((p) => p.type === 'campfire');
    expect(fires.length).toBe(1);
    const f = fires[0] as Placeable;
    // 広場は spawn を中心から3タイル南へずらして作るので、spawn からの距離で見る
    const d = Math.hypot(f.pos.x - world.spawn.x, f.pos.y - world.spawn.y);
    expect(d, `焚き火が広場から遠い: ${d.toFixed(1)}`).toBeLessThanOrEqual(11);
  });

  it('到達できない陸が0（歩行不可の岩・焚き火を置いた後の再検査）', () => {
    expect(reachableFromSpawn(world).size).toBe(walkableTileCount(world));
  });

  it('茂みと切り株のタイルは歩けるまま', () => {
    for (const p of items) {
      if (!WALKABLE_DECOR.includes(p.type)) continue;
      const x = Math.floor(p.pos.x);
      const y = Math.floor(p.pos.y);
      expect(world.isSolid(x, y), `${p.type}@${x},${y} が歩行不可になっている`).toBe(false);
      expect(world.isWalkableTile(x, y), `${p.type}@${x},${y} が歩けない`).toBe(true);
    }
  });

  it('岩と焚き火のタイルは歩行不可', () => {
    for (const p of items) {
      if (!SOLID_DECOR.includes(p.type)) continue;
      expect(world.isSolid(Math.floor(p.pos.x), Math.floor(p.pos.y)), p.type).toBe(true);
    }
  });

  it('資源（木の実の木・畑・釣り場）の上には置かない', () => {
    for (const p of items) {
      const i = tileIndex(Math.floor(p.pos.x), Math.floor(p.pos.y));
      expect(world.resourceAt[i], `${p.type} が資源に重なっている`).toBe(0);
    }
  });

  it('小道と畑の土（dirt）の上には置かない', () => {
    for (const p of items) {
      expect(world.terrainAt(Math.floor(p.pos.x), Math.floor(p.pos.y)), p.type).not.toBe('dirt');
    }
  });

  it('spawn のまわり3タイルは空けてある（最初のベンチを置ける）', () => {
    for (const p of items) {
      const d = Math.hypot(p.pos.x - world.spawn.x, p.pos.y - world.spawn.y);
      expect(d, `${p.type} が spawn に近すぎる`).toBeGreaterThan(3);
    }
  });

  it('設置物同士が隣り合わない（2タイル以上離れている）', () => {
    const all = [...world.placeables.values()];
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const a = all[i] as Placeable;
        const b = all[j] as Placeable;
        // 柵は1本を隣接タイルに並べるので除く（`placeFences` の仕様）
        if (a.type.startsWith('fence') && b.type.startsWith('fence')) continue;
        if (!DECOR_TYPES.includes(a.type) && !DECOR_TYPES.includes(b.type)) continue;
        const d = Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y);
        expect(d, `${a.type} と ${b.type} が近すぎる`).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it('島の外・外周には出ない', () => {
    for (const p of items) {
      expect(p.pos.x).toBeGreaterThan(1);
      expect(p.pos.y).toBeGreaterThan(1);
      expect(p.pos.x).toBeLessThan(MAP_W - 1);
      expect(p.pos.y).toBeLessThan(MAP_H - 1);
    }
  });

  it('設置物の総数は100件以内（帯域と placeablesNear の全走査を抑える）', () => {
    expect(world.placeables.size).toBeLessThanOrEqual(100);
  });
});
