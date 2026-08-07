/**
 * 地形描画の見た目を決めるロジック（B-1 バリエーション / B-2 遷移タイル / G-4 荒廃度）。
 *
 * 実際の焼成（RenderTexture への描画）はGPUが要るのでここでは検証できないが、
 * `renderer.render()` を差し替えれば「どのタイルにどのテクスチャを割り当てたか」までは追える。
 * 見た目が乱数で揺れないこと（同じseedで同じ島）がM1の完了条件なので、決定論を重点的に見る。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Container, Sprite, Texture, type Renderer } from 'pixi.js';
import { CHUNK, TERRAINS, type Terrain } from '@ai-pet/shared';
import {
  EDGE_E,
  EDGE_MASK_MAX,
  EDGE_N,
  EDGE_PAIRS,
  EDGE_S,
  EDGE_W,
  TILE_VARIANTS,
  TileMap,
  decayTint,
  edgeKey,
  edgeMask,
  tileVariant,
  type TerrainTextures,
} from '../../packages/client/src/render/tilemap.ts';
import { edgeTileNames, terrainVariantNames } from '../../packages/client/src/render/assets.ts';

describe('B-1 タイルのバリエーション', () => {
  it('同じ座標なら常に同じ variant（Math.random を使っていない）', () => {
    for (const [x, y] of [
      [0, 0],
      [3, 17],
      [127, 127],
      [64, 65],
    ] as const) {
      const first = tileVariant(x, y, TILE_VARIANTS);
      for (let i = 0; i < 20; i++) expect(tileVariant(x, y, TILE_VARIANTS)).toBe(first);
    }
  });

  it('範囲は 0..count-1 に収まり、count<=1 なら常に0', () => {
    for (let y = 0; y < 32; y++) {
      for (let x = 0; x < 32; x++) {
        const v = tileVariant(x, y, TILE_VARIANTS);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(TILE_VARIANTS);
        expect(tileVariant(x, y, 1)).toBe(0);
        expect(tileVariant(x, y, 0)).toBe(0);
      }
    }
  });

  it('4種がまばらに散る（同じ模様の連続が目に付かない程度にばらける）', () => {
    const count = [0, 0, 0, 0];
    for (let y = 0; y < 128; y++) {
      for (let x = 0; x < 128; x++) {
        const v = tileVariant(x, y, TILE_VARIANTS);
        count[v] = (count[v] as number) + 1;
      }
    }
    // 均等（4096）から大きく偏らないこと
    for (const c of count) {
      expect(c).toBeGreaterThan(4096 * 0.8);
      expect(c).toBeLessThan(4096 * 1.2);
    }
    // 横に4枚続けて同じ variant になる箇所が多すぎない
    let runs = 0;
    for (let y = 0; y < 128; y++) {
      for (let x = 0; x < 125; x++) {
        const v = tileVariant(x, y, TILE_VARIANTS);
        if (
          tileVariant(x + 1, y, TILE_VARIANTS) === v &&
          tileVariant(x + 2, y, TILE_VARIANTS) === v &&
          tileVariant(x + 3, y, TILE_VARIANTS) === v
        ) {
          runs++;
        }
      }
    }
    // 一様乱択なら 16000/4^3 = 250 前後。桁で外れていたら模様が縞になっている
    expect(runs).toBeLessThan(500);
  });

  it('負の座標でも落ちない（地図外を参照しても例外にしない）', () => {
    expect(tileVariant(-1, -1, TILE_VARIANTS)).toBeGreaterThanOrEqual(0);
    expect(tileVariant(-1, -1, TILE_VARIANTS)).toBeLessThan(TILE_VARIANTS);
  });
});

describe('B-2 遷移マスク', () => {
  /** 隣接の集合から sample 関数を作る（未受信は undefined を返す） */
  function sampler(map: Partial<Record<'n' | 'e' | 's' | 'w', Terrain | undefined>>) {
    return (dx: number, dy: number): Terrain | undefined => {
      if (dx === 0 && dy === -1) return map.n;
      if (dx === 1 && dy === 0) return map.e;
      if (dx === 0 && dy === 1) return map.s;
      if (dx === -1 && dy === 0) return map.w;
      return undefined;
    };
  }

  it('16パターンすべてのビットが正しく立つ', () => {
    for (let mask = 0; mask <= EDGE_MASK_MAX; mask++) {
      const m = sampler({
        n: (mask & EDGE_N) !== 0 ? 'sand' : 'grass',
        e: (mask & EDGE_E) !== 0 ? 'sand' : 'grass',
        s: (mask & EDGE_S) !== 0 ? 'sand' : 'grass',
        w: (mask & EDGE_W) !== 0 ? 'sand' : 'grass',
      });
      expect(edgeMask(m, 'sand')).toBe(mask);
    }
  });

  it('ビットの割り当ては 上=1 右=2 下=4 左=8', () => {
    expect(edgeMask(sampler({ n: 'water' }), 'water')).toBe(1);
    expect(edgeMask(sampler({ e: 'water' }), 'water')).toBe(2);
    expect(edgeMask(sampler({ s: 'water' }), 'water')).toBe(4);
    expect(edgeMask(sampler({ w: 'water' }), 'water')).toBe(8);
    expect([EDGE_N, EDGE_E, EDGE_S, EDGE_W]).toEqual([1, 2, 4, 8]);
  });

  it('未受信（undefined）は境界とみなさない', () => {
    expect(edgeMask(sampler({}), 'sand')).toBe(0);
    expect(edgeMask(sampler({ n: undefined, e: 'sand' }), 'sand')).toBe(EDGE_E);
  });

  it('境界は4つ、キーはアセット名と一致する', () => {
    expect(EDGE_PAIRS.length).toBe(4);
    expect(edgeKey('sand', 'water', 5)).toBe('edge_sand_water_5');
    for (const p of EDGE_PAIRS) {
      expect(TERRAINS).toContain(p.from);
      expect(TERRAINS).toContain(p.to);
    }
  });
});

describe('G-4 荒廃度の tint', () => {
  it('0 はそのまま、100 は枯れ色（#a8926e）', () => {
    expect(decayTint(0)).toBe(0xffffff);
    expect(decayTint(100)).toBe(0xa8926e);
  });

  it('途中はチャンネルごとの線形補間', () => {
    const mid = decayTint(50);
    expect((mid >> 16) & 0xff).toBe(Math.round((0xff + 0xa8) / 2));
    expect((mid >> 8) & 0xff).toBe(Math.round((0xff + 0x92) / 2));
    expect(mid & 0xff).toBe(Math.round((0xff + 0x6e) / 2));
  });

  it('範囲外はクランプする（壊れた値で色が飛ばない）', () => {
    expect(decayTint(-10)).toBe(0xffffff);
    expect(decayTint(999)).toBe(0xa8926e);
  });

  it('荒廃度が上がるほど暗く・黄色寄りになる（単調）', () => {
    let prev = 0x100;
    for (let d = 0; d <= 100; d += 5) {
      const b = decayTint(d) & 0xff;
      expect(b).toBeLessThanOrEqual(prev);
      prev = b;
    }
  });
});

// ==================== 焼成（renderer を差し替えて中身を見る） ====================

interface BakeCall {
  clear: boolean;
  /** そのパスで可視だったスプライトの (タイルindex, テクスチャ名) */
  drawn: [number, string][];
}

/** テクスチャに名前を付けて、焼成でどれが選ばれたか判定できるようにする */
function makeTextures(): { textures: TerrainTextures; nameOf: Map<Texture, string> } {
  const nameOf = new Map<Texture, string>();
  const base = {} as Record<Terrain, Texture>;
  const variants = {} as Record<Terrain, Texture[]>;
  for (const t of TERRAINS) {
    const b = new Texture();
    nameOf.set(b, `tile_${t}`);
    base[t] = b;
    const vs: Texture[] = [];
    for (let v = 0; v < TILE_VARIANTS; v++) {
      const tex = new Texture();
      nameOf.set(tex, `tile_${t}_${v}`);
      vs.push(tex);
    }
    variants[t] = vs;
  }
  const edges = new Map<string, Texture>();
  for (const p of EDGE_PAIRS) {
    for (let m = 1; m <= EDGE_MASK_MAX; m++) {
      const key = edgeKey(p.from, p.to, m);
      const tex = new Texture();
      nameOf.set(tex, key);
      edges.set(key, tex);
    }
  }
  return { textures: { base, variants, edges }, nameOf };
}

/** render() を記録するだけの偽レンダラ。GPUには触らない */
function makeHarness() {
  const { textures, nameOf } = makeTextures();
  const calls: BakeCall[] = [];
  const renderer = {
    render(opts: { container: Container; clear?: boolean }): void {
      const drawn: [number, string][] = [];
      opts.container.children.forEach((child, i) => {
        const s = child as Sprite;
        if (!s.visible) return;
        drawn.push([i, nameOf.get(s.texture) ?? '?']);
      });
      calls.push({ clear: opts.clear !== false, drawn });
    },
  } as unknown as Renderer;
  const map = new TileMap(renderer, { ground: new Container() }, textures, 8);
  return { map, calls };
}

const G = TERRAINS.indexOf('grass');
const S = TERRAINS.indexOf('sand');

/** 全部草のチャンク */
function grassChunk(): number[] {
  return new Array<number>(CHUNK * CHUNK).fill(G);
}

describe('チャンクの焼成', () => {
  it('基本パスは clear=true で256枚すべて、バリエーションが座標どおりに選ばれる', () => {
    const { map, calls } = makeHarness();
    map.applyChunk(1, 2, grassChunk());
    const base = calls[0] as BakeCall;
    expect(base.clear).toBe(true);
    expect(base.drawn.length).toBe(CHUNK * CHUNK);
    for (const [i, name] of base.drawn) {
      const gx = 1 * CHUNK + (i % CHUNK);
      const gy = 2 * CHUNK + Math.floor(i / CHUNK);
      expect(name).toBe(`tile_grass_${tileVariant(gx, gy, TILE_VARIANTS)}`);
    }
  });

  it('同じチャンクを2回適用しても同じ絵になる（決定論）', () => {
    const a = makeHarness();
    a.map.applyChunk(3, 3, grassChunk());
    const b = makeHarness();
    b.map.applyChunk(3, 3, grassChunk());
    expect(a.calls).toEqual(b.calls);
  });

  it('境界があると遷移パスが clear=false で重なる', () => {
    const { map, calls } = makeHarness();
    const tiles = grassChunk();
    // 左半分を砂にする（縦の境界がチャンク内に立つ）
    for (let y = 0; y < CHUNK; y++) for (let x = 0; x < 8; x++) tiles[y * CHUNK + x] = S;
    map.applyChunk(0, 0, tiles);
    expect(calls.length).toBe(2);
    const edge = calls[1] as BakeCall;
    expect(edge.clear).toBe(false);
    // 草側（x=8）の列だけに、左が砂のマスク（EDGE_W）が乗る
    expect(edge.drawn.length).toBe(CHUNK);
    for (const [i, name] of edge.drawn) {
      expect(i % CHUNK).toBe(8);
      expect(name).toBe(edgeKey('grass', 'sand', EDGE_W));
    }
  });

  it('未受信の隣チャンクは「同じ地形」とみなす（穴を空けない）', () => {
    const { map, calls } = makeHarness();
    const tiles = grassChunk();
    // 右端の列を砂に。隣チャンク(1,0)は未受信なので、砂タイルの右には境界を立てない
    for (let y = 0; y < CHUNK; y++) tiles[y * CHUNK + (CHUNK - 1)] = S;
    map.applyChunk(0, 0, tiles);
    const edge = calls[1] as BakeCall;
    for (const [, name] of edge.drawn) {
      // 草側に「右が砂」のマスクだけが立つ（EDGE_E）
      expect(name).toBe(edgeKey('grass', 'sand', EDGE_E));
    }
    expect(edge.drawn.length).toBe(CHUNK);
  });

  it('隣チャンクを受信すると、既存チャンクも焼き直して境界が出る', () => {
    const { map, calls } = makeHarness();
    map.applyChunk(0, 0, grassChunk());
    expect(calls.length).toBe(1); // 全部草なので遷移パスは無い
    // 右隣を全部砂で受信 → (0,0) の右端に草↔砂の境界が現れる
    const sand = new Array<number>(CHUNK * CHUNK).fill(S);
    calls.length = 0;
    map.applyChunk(1, 0, sand);
    // 自分の焼成（基本のみ。砂の右隣＝(2,0)は未受信）＋ (0,0) の焼き直し（基本＋遷移）
    const reBaked = calls.filter((c) => c.clear === false);
    expect(reBaked.length).toBe(1);
    for (const [i, name] of (reBaked[0] as BakeCall).drawn) {
      expect(i % CHUNK).toBe(CHUNK - 1);
      expect(name).toBe(edgeKey('grass', 'sand', EDGE_E));
    }
  });

  it('バリエーションが無い地形は tile_<terrain>.png に落ちる', () => {
    const { textures } = makeTextures();
    const bare: TerrainTextures = { base: textures.base, variants: {} as Record<Terrain, Texture[]>, edges: new Map() };
    for (const t of TERRAINS) (bare.variants as Record<Terrain, Texture[]>)[t] = [];
    const calls: BakeCall[] = [];
    const renderer = {
      render(opts: { container: Container; clear?: boolean }): void {
        const drawn: [number, string][] = [];
        opts.container.children.forEach((child, i) => {
          const s = child as Sprite;
          if (s.visible) drawn.push([i, s.texture === bare.base.grass ? 'tile_grass' : '?']);
        });
        calls.push({ clear: opts.clear !== false, drawn });
      },
    } as unknown as Renderer;
    const map = new TileMap(renderer, { ground: new Container() }, bare, 8);
    map.applyChunk(0, 0, grassChunk());
    for (const [, name] of (calls[0] as BakeCall).drawn) expect(name).toBe('tile_grass');
  });

  it('壊れた長さのチャンク・荒廃度は受け付けない', () => {
    const { map } = makeHarness();
    expect(() => map.applyChunk(0, 0, [1, 2, 3])).toThrow(/期待長/);
    map.applyChunk(0, 0, grassChunk());
    expect(() => map.setChunkDecay(0, 0, [1, 2, 3])).toThrow(/期待長/);
  });

  it('荒廃度を入れると tint が付く（未設定なら 0xffffff）', () => {
    const { map } = makeHarness();
    map.applyChunk(0, 0, grassChunk());
    const decay = new Array<number>(CHUNK * CHUNK).fill(0);
    decay[5] = 100;
    decay[6] = 50;
    // 焼成で tint を読み取るために、もう一度 render の中身を見る
    const tints: number[] = [];
    const renderer = (map as unknown as { renderer: { render: (o: { container: Container }) => void } }).renderer;
    const orig = renderer.render;
    renderer.render = (opts: { container: Container }): void => {
      tints.length = 0;
      for (const child of opts.container.children) tints.push((child as Sprite).tint);
    };
    map.setChunkDecay(0, 0, decay);
    renderer.render = orig;
    expect(tints[5]).toBe(0xa8926e);
    expect(tints[6]).toBe(decayTint(50));
    expect(tints[0]).toBe(0xffffff);
  });
});

describe('プレースホルダのアセット名', () => {
  const manifestPath = fileURLToPath(
    new URL('../../packages/client/public/assets/placeholder/manifest.json', import.meta.url),
  );
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { files: string[] };

  it('バリエーション24枚・遷移60枚を要求する', () => {
    expect(terrainVariantNames().length).toBe(TERRAINS.length * TILE_VARIANTS);
    expect(edgeTileNames().length).toBe(EDGE_PAIRS.length * EDGE_MASK_MAX);
  });

  it('要求する名前がすべて placeholder に存在する（tools/placeholder.ts の取りこぼし検出）', () => {
    const files = new Set(manifest.files);
    for (const n of [...terrainVariantNames(), ...edgeTileNames()]) {
      expect(files.has(n), `${n} が placeholder に無い`).toBe(true);
    }
    // 従来の tile_<terrain>.png も残っている（後方互換）
    for (const t of TERRAINS) expect(files.has(`tile_${t}.png`)).toBe(true);
  });
});
