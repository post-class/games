/**
 * state/world.ts のロジック（Pixi非依存）
 * snapshot / delta / chunk の適用と、150ms補間バッファの振る舞いを検証する。
 */
import { describe, expect, it } from 'vitest';
import {
  CHUNK,
  INTERP_DELAY_MS,
  MAP_W,
  TERRAINS,
  encodeAnim,
  encodeFacing,
  rleEncode,
  type ActorWire,
} from '@ai-pet/shared';
import {
  WorldState,
  decodeChunkTerrain,
  interpolatedPos,
  kindFromWire,
  renderTime,
  sampleAt,
} from '../../packages/client/src/state/world.ts';

function wire(i: number, x: number, y: number, over: Partial<ActorWire> = {}): ActorWire {
  return {
    i,
    k: 0,
    s: 'rabbit',
    n: `どうぶつ${i}`,
    x,
    y,
    f: encodeFacing('s'),
    a: encodeAnim('idle'),
    ...over,
  };
}

describe('WorldState: snapshot', () => {
  it('アクターを取り込み、含まれないアクターは消える', () => {
    const w = new WorldState();
    w.applySnapshot({ tick: 10, actors: [wire(1, 5, 6), wire(2, 7, 8)] }, 1000);
    expect(w.actors.size).toBe(2);
    expect(w.actors.get(1)?.x).toBe(5);
    expect(w.tick).toBe(10);

    w.applySnapshot({ tick: 20, actors: [wire(2, 9, 9)] }, 1250);
    expect(w.actors.size).toBe(1);
    expect(w.actors.has(1)).toBe(false);
    expect(w.actors.get(2)?.y).toBe(9);
  });

  it('kindとfacing/animがワイヤから復元される', () => {
    const w = new WorldState();
    w.applySnapshot(
      {
        tick: 1,
        actors: [wire(1, 1, 1, { k: 2, s: 'a', f: encodeFacing('w'), a: encodeAnim('walk') })],
      },
      0,
    );
    const v = w.actors.get(1);
    expect(v?.kind).toBe('player');
    expect(v?.facing).toBe('w');
    expect(v?.anim).toBe('walk');
    expect(kindFromWire(1)).toBe('pet');
    expect(kindFromWire(0)).toBe('critter');
  });

  it('resources / placeables を入れ替える', () => {
    const w = new WorldState();
    w.applySnapshot(
      {
        tick: 1,
        actors: [],
        resources: [{ i: 100, ty: 'berry_tree', x: 3, y: 4, amt: 5, max: 6 }],
        placeables: [{ i: 200, ty: 'bench', x: 1, y: 2, o: 'p1' }],
      },
      0,
    );
    expect(w.resources.get(100)?.amount).toBe(5);
    expect(w.placeables.get(200)?.ownerId).toBe('p1');
  });
});

describe('WorldState: delta', () => {
  it('add / upd / rm が適用される', () => {
    const w = new WorldState();
    w.applyDelta({ tick: 1, add: [wire(1, 2, 2), wire(2, 3, 3)] }, 0);
    expect(w.actors.size).toBe(2);

    w.applyDelta({ tick: 2, upd: [{ i: 1, x: 4, f: encodeFacing('n'), a: encodeAnim('walk') }] }, 250);
    const v = w.actors.get(1);
    expect(v?.x).toBe(4);
    expect(v?.y).toBe(2); // yは差分に含まれないので保持される
    expect(v?.facing).toBe('n');
    expect(v?.anim).toBe('walk');

    w.applyDelta({ tick: 3, rm: [2] }, 500);
    expect(w.actors.has(2)).toBe(false);
    expect(w.actors.size).toBe(1);
  });

  it('未知IDのupdは無視する（addが届く前のupd）', () => {
    const w = new WorldState();
    w.applyDelta({ tick: 1, upd: [{ i: 99, x: 1, y: 1 }] }, 0);
    expect(w.actors.size).toBe(0);
  });

  it('resのamtで資源量を更新する', () => {
    const w = new WorldState();
    w.applySnapshot(
      { tick: 1, actors: [], resources: [{ i: 7, ty: 'field', x: 0, y: 0, amt: 10, max: 10 }] },
      0,
    );
    w.applyDelta({ tick: 2, res: [{ i: 7, amt: 3 }] }, 100);
    expect(w.resources.get(7)?.amount).toBe(3);
  });

  it('位置サンプルが時刻昇順で積まれる', () => {
    const w = new WorldState();
    w.applyDelta({ tick: 1, add: [wire(1, 0, 0)] }, 1000);
    w.applyDelta({ tick: 2, upd: [{ i: 1, x: 1, y: 0 }] }, 1250);
    w.applyDelta({ tick: 3, upd: [{ i: 1, x: 2, y: 0 }] }, 1500);
    const buf = w.actors.get(1)?.buf ?? [];
    expect(buf.map((s) => s.t)).toEqual([1000, 1250, 1500]);
    expect(buf.map((s) => s.x)).toEqual([0, 1, 2]);
  });

  it('古いサンプルは捨てられるが2点以上は残る', () => {
    const w = new WorldState();
    w.applyDelta({ tick: 1, add: [wire(1, 0, 0)] }, 0);
    for (let i = 1; i <= 40; i++) {
      w.applyDelta({ tick: 1 + i, upd: [{ i: 1, x: i, y: 0 }] }, i * 250);
    }
    const buf = w.actors.get(1)?.buf ?? [];
    expect(buf.length).toBeGreaterThanOrEqual(2);
    expect(buf.length).toBeLessThan(20);
  });
});

describe('WorldState: chunk', () => {
  it('RLEを展開して地形に書き込み、受信済みになる', () => {
    const w = new WorldState();
    const grass = TERRAINS.indexOf('grass');
    const water = TERRAINS.indexOf('water');
    const tiles: number[] = [];
    for (let i = 0; i < CHUNK * CHUNK; i++) tiles.push(i < CHUNK ? water : grass);

    expect(w.hasChunk(2, 3)).toBe(false);
    expect(w.terrainAt(2 * CHUNK, 3 * CHUNK)).toBe(-1); // 未受信は -1（描かない）

    const applied = w.applyChunk({ cx: 2, cy: 3, terrain: rleEncode(tiles) });
    expect(applied.tiles.length).toBe(CHUNK * CHUNK);
    expect(w.hasChunk(2, 3)).toBe(true);
    // チャンクの先頭行は water、2行目は grass
    expect(w.terrainAt(2 * CHUNK, 3 * CHUNK)).toBe(water);
    expect(w.terrainAt(2 * CHUNK, 3 * CHUNK + 1)).toBe(grass);
    // 隣のチャンクは未受信のまま
    expect(w.terrainAt(3 * CHUNK, 3 * CHUNK)).toBe(-1);
  });

  it('decodeChunkTerrain は長さが合わないと例外', () => {
    expect(() => decodeChunkTerrain([0, 4])).toThrow();
    expect(decodeChunkTerrain(rleEncode(new Array(CHUNK * CHUNK).fill(1))).length).toBe(CHUNK * CHUNK);
  });

  it('chunkに乗ってきた資源も取り込む', () => {
    const w = new WorldState();
    w.applyChunk({
      cx: 0,
      cy: 0,
      terrain: rleEncode(new Array(CHUNK * CHUNK).fill(0)),
      resources: [{ i: 42, ty: 'berry_tree', x: 1, y: 1, amt: 2, max: 6 }],
    });
    expect(w.resources.get(42)?.type).toBe('berry_tree');
  });

  it('地形配列はマップ全体ぶん確保されている', () => {
    const w = new WorldState();
    expect(w.terrain.length).toBe(MAP_W * MAP_W);
    expect(w.terrainAt(-1, 0)).toBe(-1);
    expect(w.terrainAt(MAP_W, 0)).toBe(-1);
  });
});

describe('補間（docs 05章 §6）', () => {
  it('2点の受信から中間時刻の位置が求まる', () => {
    const buf = [
      { t: 1000, x: 0, y: 0 },
      { t: 1200, x: 2, y: 4 },
    ];
    expect(sampleAt(buf, 1100)).toEqual({ x: 1, y: 2 });
    expect(sampleAt(buf, 1050)).toEqual({ x: 0.5, y: 1 });
  });

  it('3点以上でも該当区間だけを使う', () => {
    const buf = [
      { t: 0, x: 0, y: 0 },
      { t: 100, x: 10, y: 0 },
      { t: 200, x: 10, y: 10 },
    ];
    expect(sampleAt(buf, 50)).toEqual({ x: 5, y: 0 });
    expect(sampleAt(buf, 150)).toEqual({ x: 10, y: 5 });
  });

  it('受信が途切れたら最後の位置で止まる', () => {
    const buf = [
      { t: 0, x: 0, y: 0 },
      { t: 100, x: 5, y: 5 },
    ];
    expect(sampleAt(buf, 100)).toEqual({ x: 5, y: 5 });
    expect(sampleAt(buf, 5000)).toEqual({ x: 5, y: 5 });
  });

  it('先頭より前の時刻は先頭の位置、空なら null', () => {
    expect(sampleAt([{ t: 1000, x: 3, y: 3 }], 0)).toEqual({ x: 3, y: 3 });
    expect(sampleAt([], 0)).toBeNull();
  });

  it('描画時刻は now - 150ms', () => {
    expect(renderTime(1000)).toBe(1000 - INTERP_DELAY_MS);
  });

  it('interpolatedPos は150ms遅れの位置を返す', () => {
    const w = new WorldState();
    // t=0 で (0,0)、t=200 で (2,0) を受信
    w.applyDelta({ tick: 1, add: [wire(1, 0, 0)] }, 0);
    w.applyDelta({ tick: 2, upd: [{ i: 1, x: 2, y: 0 }] }, 200);
    const v = w.actors.get(1);
    expect(v).toBeDefined();
    if (!v) return;
    // now=250 → 描画時刻100 → 0と200の中間 → x=1
    expect(interpolatedPos(v, 250).x).toBeCloseTo(1, 6);
    // now=1000 → 描画時刻850 → 末尾で止まる
    expect(interpolatedPos(v, 1000).x).toBe(2);
  });

  it('同時刻に複数届いても順序が逆転しない', () => {
    const w = new WorldState();
    w.applyDelta({ tick: 1, add: [wire(1, 0, 0)] }, 500);
    w.applyDelta({ tick: 2, upd: [{ i: 1, x: 9, y: 9 }] }, 500);
    const buf = w.actors.get(1)?.buf ?? [];
    expect(buf.length).toBe(1);
    expect(buf[0]?.x).toBe(9);
  });
});

describe('WorldState: findPet', () => {
  it('ownerIdが一致するpetを返す', () => {
    const w = new WorldState();
    w.applySnapshot(
      {
        tick: 1,
        actors: [
          wire(1, 0, 0, { k: 1, s: 'mofi', o: 'me' }),
          wire(2, 0, 0, { k: 1, s: 'hakka', o: 'other' }),
        ],
      },
      0,
    );
    expect(w.findPet('me')?.id).toBe(1);
    expect(w.findPet('nobody')).toBeNull();
  });
});
