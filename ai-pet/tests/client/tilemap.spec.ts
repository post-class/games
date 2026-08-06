/**
 * 地形チャンクの RLE ↔ タイル配列 変換（TileMap.applyChunk に渡す形）。
 * TileMap 本体は Pixi renderer が必要なので、ここでは変換部分だけを検証する。
 */
import { describe, expect, it } from 'vitest';
import { CHUNK, MAP_H, MAP_W, TERRAINS, rleDecode, rleEncode } from '@ai-pet/shared';
import { decodeChunkTerrain } from '../../packages/client/src/state/world.ts';
import { MockIsland, generateMockTerrain } from '../../packages/client/src/dev/mock.ts';

describe('RLE ↔ タイル配列', () => {
  it('rleEncode → decodeChunkTerrain で元に戻る', () => {
    const tiles: number[] = [];
    for (let i = 0; i < CHUNK * CHUNK; i++) tiles.push(i % 7 === 0 ? 3 : i % 3);
    expect(decodeChunkTerrain(rleEncode(tiles))).toEqual(tiles);
  });

  it('全部同じ値ならRLEは2要素', () => {
    const tiles = new Array<number>(CHUNK * CHUNK).fill(0);
    const rle = rleEncode(tiles);
    expect(rle).toEqual([0, CHUNK * CHUNK]);
    expect(decodeChunkTerrain(rle).length).toBe(CHUNK * CHUNK);
  });

  it('長さが CHUNK*CHUNK でなければ例外（壊れたチャンクを描かない）', () => {
    expect(() => decodeChunkTerrain(rleEncode([1, 1, 2]))).toThrow(/length mismatch/);
    expect(() => rleDecode([1, 3], 3)).not.toThrow();
  });

  it('展開後の値はすべて TERRAINS の範囲に収まる', () => {
    const island = new MockIsland('rle-test');
    const tiles = decodeChunkTerrain(island.chunkRle(4, 4));
    for (const t of tiles) {
      expect(t).toBeGreaterThanOrEqual(0);
      expect(t).toBeLessThan(TERRAINS.length);
    }
  });
});

describe('mock島（?mock=1 の描画確認用）', () => {
  it('同じseedなら同じ島（決定論）', () => {
    const a = generateMockTerrain('seed-a');
    const b = generateMockTerrain('seed-a');
    const c = generateMockTerrain('seed-b');
    expect(a.length).toBe(MAP_W * MAP_H);
    expect([...a]).toEqual([...b]);
    expect([...a]).not.toEqual([...c]);
  });

  it('中心は広場、外周は水（島になっている）', () => {
    const island = new MockIsland('shape');
    const plaza = TERRAINS.indexOf('plaza');
    const water = TERRAINS.indexOf('water');
    expect(island.terrainAt(MAP_W / 2, MAP_H / 2)).toBe(plaza);
    expect(island.terrainAt(0, 0)).toBe(water);
    expect(island.terrainAt(MAP_W - 1, MAP_H - 1)).toBe(water);
    expect(island.isWalkable(island.spawn)).toBe(true);
  });

  it('チャンクのRLEは全チャンクぶん取り出せる', () => {
    const island = new MockIsland('chunks');
    expect(island.chunkCount).toBe((MAP_W / CHUNK) * (MAP_H / CHUNK));
    for (const [cx, cy] of [
      [0, 0],
      [3, 5],
      [7, 7],
    ] as const) {
      expect(decodeChunkTerrain(island.chunkRle(cx, cy)).length).toBe(CHUNK * CHUNK);
    }
  });

  it('step でアクターが動き、水には入らない', () => {
    const island = new MockIsland('walk');
    const snap = island.snapshot();
    expect(snap.actors.length).toBeGreaterThan(20);
    let moved = 0;
    for (let i = 0; i < 40; i++) {
      const d = island.step(0.25);
      for (const u of d.upd) {
        if (u.x === undefined || u.y === undefined) continue;
        expect(island.isWalkable({ x: u.x, y: u.y })).toBe(true);
        moved++;
      }
    }
    expect(moved).toBeGreaterThan(0);
  });
});
