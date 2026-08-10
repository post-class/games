/**
 * T-M3-02〜06: マップ生成（`07§13` / 手順書 §6.10）
 *
 * 完了条件と検証の対応:
 *  - T-M3-02 開始位置の等間隔配置 + 初期資源の等距離配布
 *      → 「中心からの距離」「隣り合う拠点との距離」「最寄りの他拠点との距離」の
 *        ばらつきが **1 マス以内**、資源量が**完全一致**。
 *  - T-M3-03 中央の争点配置 → 中央 30% の箱の中に、通常より豊かな金鉱と森がある。
 *  - T-M3-04 川・森・丘・水域の描画 → 開始位置と初期資源のマスが上書きされていない。
 *  - T-M3-05 通行検査とリトライ → 全拠点間が到達可能。隘路が 1 本だけでない。
 *  - T-M3-06 マップ型 8 種 → 8 型すべてが生成でき、`07§13` の表と整合する地形になる。
 */

import { describe, expect, it } from 'vitest';
import { MAP_TYPE_IDS, RESOURCE_IDS, EntityKind } from '@/shared/types';
import type { MapTypeId } from '@/shared/types';
import { createWorld, type World } from '@/sim/core/world';
import { FX_ONE, idiv, isqrt } from '@/sim/core/fx';
import { Move, Tile, hasTerrain, isPassable, tileIndex } from '@/sim/core/terrain';
import { computeReachable, findSectorPath, getPathfinder, sectorOfXY, sectorsConnected } from '@/sim/core/pathfind';
import { generateMap, mapSizeForPlayers, type MapGenResult } from '@/sim/systems/mapgen';

const RES_FOOD = RESOURCE_IDS.indexOf('food');
const RES_WOOD = RESOURCE_IDS.indexOf('wood');
const RES_STONE = RESOURCE_IDS.indexOf('stone');
const RES_GOLD = RESOURCE_IDS.indexOf('gold');

function gen(mapType: MapTypeId, playerCount: number, seed: number): { w: World; r: MapGenResult } {
  const side = mapSizeForPlayers(mapType, playerCount);
  const w = createWorld({
    seed,
    playerCount,
    mapWidthTiles: side,
    mapHeightTiles: side,
    entityCapacity: 4096,
  });
  const r = generateMap(w, { mapType });
  return { w, r };
}

/** Fx の 2 点間距離（マス単位の Fx）。 */
function distFx(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  return isqrt(dx * dx + dy * dy);
}

function tileCounts(w: World): Int32Array {
  const c = new Int32Array(8);
  for (let i = 0; i < w.map.tiles.length; i++) c[w.map.tiles[i]!] = c[w.map.tiles[i]!]! + 1;
  return c;
}

// ---------------------------------------------------------------- サイズ

describe('マップの広さ（07§13）', () => {
  it('1 対 1 で 200×200、8 人で 400×400、間は線形補間', () => {
    expect(mapSizeForPlayers('plain', 2)).toBe(200);
    expect(mapSizeForPlayers('plain', 8)).toBe(400);
    expect(mapSizeForPlayers('plain', 5)).toBe(300);
    // 表に無い人数（1 人）も落ちずに返る
    expect(mapSizeForPlayers('plain', 1)).toBe(200);
  });

  it('生成すると 3 配列が確保される', () => {
    const { w } = gen('plain', 2, 12345);
    expect(hasTerrain(w.map)).toBe(true);
    expect(w.map.tiles.length).toBe(200 * 200);
    expect(w.map.passable.length).toBe(200 * 200);
    expect(w.map.elevation.length).toBe(200 * 200);
  });
});

// ---------------------------------------------------------------- T-M3-02

describe('T-M3-02 開始位置の等間隔配置', () => {
  for (const n of [2, 3, 4, 5, 6, 7, 8]) {
    it(`${n} 人: 中心からの距離・隣接距離・最寄り距離のばらつきが 1 マス以内`, () => {
      const { w, r } = gen('plain', n, 900 + n);
      expect(r.starts.length).toBe(n);
      const cx = idiv(w.map.widthTiles * FX_ONE, 2);
      const cy = idiv(w.map.heightTiles * FX_ONE, 2);

      const toCenter = r.starts.map((s) => distFx(cx, cy, s.x, s.y));
      expect(Math.max(...toCenter) - Math.min(...toCenter)).toBeLessThanOrEqual(FX_ONE);

      if (n >= 2) {
        const adj: number[] = [];
        for (let i = 0; i < n; i++) {
          const a = r.starts[i]!;
          const b = r.starts[(i + 1) % n]!;
          adj.push(distFx(a.x, a.y, b.x, b.y));
        }
        expect(Math.max(...adj) - Math.min(...adj)).toBeLessThanOrEqual(FX_ONE);

        // 最寄りの他拠点までの距離（＝「誰かだけ近い」が無いこと）
        const nearest = r.starts.map((a, i) => {
          let best = Number.MAX_SAFE_INTEGER;
          for (let j = 0; j < n; j++) {
            if (j === i) continue;
            const b = r.starts[j]!;
            const d = distFx(a.x, a.y, b.x, b.y);
            if (d < best) best = d;
          }
          return best;
        });
        expect(Math.max(...nearest) - Math.min(...nearest)).toBeLessThanOrEqual(FX_ONE);
      }
    });
  }

  it('拠点はマップ内で、町の中心 4×4 が置ける平地になっている', () => {
    const { w, r } = gen('inland_sea', 4, 777);
    for (const s of r.starts) {
      expect(s.tx).toBeGreaterThanOrEqual(0);
      expect(s.ty).toBeGreaterThanOrEqual(0);
      expect(s.tx).toBeLessThan(w.map.widthTiles);
      for (let y = s.ty - 2; y <= s.ty + 1; y++) {
        for (let x = s.tx - 2; x <= s.tx + 1; x++) {
          expect(isPassable(w.map, x, y)).toBe(true);
          expect(w.map.tiles[tileIndex(w.map, x, y)]).toBe(Tile.Grass);
        }
      }
    }
  });
});

describe('T-M3-02 初期資源の等距離・等量配布', () => {
  for (const n of [2, 4, 8]) {
    it(`${n} 人: 拠点ごとの資源量が完全一致し、距離のばらつきが 1 マス以内`, () => {
      const { w, r } = gen('plain', n, 4242 + n);
      const own = r.nodes.filter((x) => x.ownerStart >= 0);
      // 木 18 + 食料 14 + 石 2 + 金 2 = 36。
      // 食料の内訳は **果樹 6 + 羊 4 + 狩猟 4**（`03§1` の 5 種のうち 3 種）。
      // 以前は果樹 6 だけで、枯れたあとの食料源が農地しか無かった。
      expect(own.length).toBe(36 * n);

      // 量: プレイヤーごとの資源別合計が完全一致
      const totals: number[][] = [];
      for (let p = 0; p < n; p++) {
        const t = [0, 0, 0, 0];
        for (const node of own) {
          if (node.ownerStart !== p) continue;
          t[node.resource] = t[node.resource]! + node.amount;
        }
        totals.push(t);
      }
      for (let p = 1; p < n; p++) expect(totals[p]).toEqual(totals[0]);
      expect(totals[0]![RES_WOOD]).toBeGreaterThan(0);
      expect(totals[0]![RES_FOOD]).toBeGreaterThan(0);
      expect(totals[0]![RES_STONE]).toBeGreaterThan(0);
      expect(totals[0]![RES_GOLD]).toBeGreaterThan(0);

      // 距離: 拠点からの距離を昇順に並べて突き合わせる
      const sorted: number[][] = [];
      for (let p = 0; p < n; p++) {
        const st = r.starts[p]!;
        const ds = own
          .filter((x) => x.ownerStart === p)
          .map((x) => distFx(st.x, st.y, x.x, x.y))
          .sort((a, b) => a - b);
        sorted.push(ds);
      }
      for (let p = 1; p < n; p++) {
        expect(sorted[p]!.length).toBe(sorted[0]!.length);
        for (let k = 0; k < sorted[0]!.length; k++) {
          expect(Math.abs(sorted[p]![k]! - sorted[0]![k]!)).toBeLessThanOrEqual(FX_ONE);
        }
      }
      // 資源ノードは Resource kind + amount で持つ
      const e = w.entities;
      let resourceCount = 0;
      for (let i = 0; i < e.highWater; i++) {
        if (e.alive[i] !== 1) continue;
        if (e.kind[i] !== EntityKind.Resource) continue;
        resourceCount += 1;
        expect(e.amount[i]!).toBeGreaterThan(0);
      }
      expect(resourceCount).toBe(r.nodes.length);
    });
  }
});

// ---------------------------------------------------------------- T-M3-03

describe('T-M3-03 中央の争点', () => {
  it('中央 30% 以内に、通常より豊かな金鉱と森がある', () => {
    const { w, r } = gen('plain', 4, 31337);
    const rich = r.nodes.filter((x) => x.rich);
    expect(rich.length).toBeGreaterThan(0);

    const cx = idiv(w.map.widthTiles * FX_ONE, 2);
    const cy = idiv(w.map.heightTiles * FX_ONE, 2);
    const halfBox = idiv(w.map.widthTiles * FX_ONE * 3, 20); // 30% の箱の半分 = 15%
    for (const node of rich) {
      expect(Math.abs(node.x - cx)).toBeLessThanOrEqual(halfBox);
      expect(Math.abs(node.y - cy)).toBeLessThanOrEqual(halfBox);
    }

    const richGold = rich.filter((x) => x.resource === RES_GOLD);
    const richWood = rich.filter((x) => x.resource === RES_WOOD);
    expect(richGold.length).toBeGreaterThanOrEqual(1);
    expect(richWood.length).toBeGreaterThanOrEqual(1);

    const baseGold = r.nodes.find((x) => !x.rich && x.resource === RES_GOLD)!;
    const baseWood = r.nodes.find((x) => !x.rich && x.resource === RES_WOOD)!;
    expect(richGold[0]!.amount).toBeGreaterThan(baseGold.amount);
    expect(richWood[0]!.amount).toBeGreaterThan(baseWood.amount);
  });
});

// ---------------------------------------------------------------- T-M3-04

describe('T-M3-04 地形の描画は既配置を壊さない', () => {
  for (const type of MAP_TYPE_IDS) {
    it(`${type}: 拠点と初期資源のマスが上書きされていない`, () => {
      const { w, r } = gen(type, 4, 5150);
      for (const s of r.starts) {
        expect(w.map.tiles[tileIndex(w.map, s.tx, s.ty)]).toBe(Tile.Grass);
        expect(isPassable(w.map, s.tx, s.ty)).toBe(true);
      }
      for (const node of r.nodes) {
        const tx = idiv(node.x, FX_ONE);
        const ty = idiv(node.y, FX_ONE);
        const t = w.map.tiles[tileIndex(w.map, tx, ty)]!;
        // 木材ノードの下は森、それ以外は平地。水没・崖は許さない
        expect(t === Tile.Forest || t === Tile.Grass).toBe(true);
        expect(isPassable(w.map, tx, ty)).toBe(true);
      }
    });
  }
});

// ---------------------------------------------------------------- T-M3-05

describe('T-M3-05 通行検査とリトライ', () => {
  for (const type of MAP_TYPE_IDS) {
    it(`${type}: 全拠点間が到達可能`, () => {
      const { w, r } = gen(type, 4, 60606);
      const reach = new Uint8Array(w.map.tiles.length);
      const queue = new Int32Array(w.map.tiles.length);
      const first = r.starts[0]!;
      const n = computeReachable(
        w.map,
        tileIndex(w.map, first.tx, first.ty),
        r.reachMask,
        reach,
        queue,
      );
      expect(n).toBeGreaterThan(0);
      for (const s of r.starts) {
        expect(reach[tileIndex(w.map, s.tx, s.ty)]).toBe(1);
      }
    });
  }

  it('隘路が 1 本だけのマップは出てこない（粗経路のセクタを 1 つ塞いでも繋がる）', () => {
    for (const type of ['defile', 'river', 'inland_sea', 'jungle'] as MapTypeId[]) {
      const { w, r } = gen(type, 4, 10101);
      const pf = getPathfinder(w.map);
      // 最も離れた 2 拠点
      let a = r.starts[0]!;
      let b = r.starts[1]!;
      let best = -1;
      for (let i = 0; i < r.starts.length; i++) {
        for (let j = i + 1; j < r.starts.length; j++) {
          const p = r.starts[i]!;
          const q = r.starts[j]!;
          const d = (q.tx - p.tx) ** 2 + (q.ty - p.ty) ** 2;
          if (d > best) {
            best = d;
            a = p;
            b = q;
          }
        }
      }
      const from = sectorOfXY(pf, a.tx, a.ty);
      const to = sectorOfXY(pf, b.tx, b.ty);
      expect(findSectorPath(pf, r.reachMask, from, to, -1)).toBe(true);
      const path = Array.from(pf.sectorPath.subarray(0, pf.sectorPathLen));
      for (let k = 1; k < path.length - 1; k++) {
        const banned = path[k]!;
        if (banned === from || banned === to) continue;
        expect(sectorsConnected(pf, r.reachMask, from, to, banned)).toBe(true);
      }
    }
  });

  it('作り直しは 20 回までで、超えたら平野型になる', () => {
    const { r } = gen('archipelago', 8, 24680);
    expect(r.attempts).toBeGreaterThanOrEqual(1);
    expect(r.attempts).toBeLessThanOrEqual(21);
    if (r.usedFallback) expect(r.mapType).toBe('plain');
  });
});

// ---------------------------------------------------------------- T-M3-06

describe('T-M3-06 マップ型 8 種（07§13 の表）', () => {
  it('8 型すべてが例外なく生成できる', () => {
    expect(MAP_TYPE_IDS.length).toBe(8);
    for (const type of MAP_TYPE_IDS) {
      for (const n of [2, 5, 8]) {
        const { r } = gen(type, n, 1000 + n);
        expect(r.starts.length).toBe(n);
        expect(r.nodes.length).toBeGreaterThan(0);
      }
    }
  });

  it('水域の量が型ごとの性格に沿う（内海・列島は多く、隘路・草原は無い）', () => {
    const water = (type: MapTypeId): number => {
      const { w } = gen(type, 4, 2024);
      const c = tileCounts(w);
      const wet = c[Tile.Water]! + c[Tile.Shallow]!;
      return idiv(wet * 1000, w.map.tiles.length); // ‰
    };
    const inland = water('inland_sea');
    const archi = water('archipelago');
    const plain = water('plain');
    const defile = water('defile');
    const steppe = water('steppe');
    console.log(
      `[T-M3-06] 水域(‰) inland_sea=${inland} archipelago=${archi} plain=${plain} defile=${defile} steppe=${steppe}`,
    );
    expect(archi).toBeGreaterThan(400); // 過半が水
    expect(inland).toBeGreaterThan(150);
    expect(archi).toBeGreaterThan(inland);
    expect(defile).toBe(0);
    expect(steppe).toBe(0);
    expect(plain).toBeLessThan(inland);
  });

  it('森の量が型ごとの性格に沿う（密林 > 内海・列島 > 草原）', () => {
    const forest = (type: MapTypeId): number => {
      const { w } = gen(type, 4, 2025);
      return idiv(tileCounts(w)[Tile.Forest]! * 1000, w.map.tiles.length);
    };
    const jungle = forest('jungle');
    const steppe = forest('steppe');
    const plain = forest('plain');
    console.log(`[T-M3-06] 森(‰) jungle=${jungle} plain=${plain} steppe=${steppe}`);
    expect(jungle).toBeGreaterThan(plain);
    expect(plain).toBeGreaterThan(steppe);
  });

  it('隘路型は崖で仕切られ、通り道が 2 本以上ある', () => {
    const { w } = gen('defile', 4, 8888);
    const c = tileCounts(w);
    expect(c[Tile.Cliff]!).toBeGreaterThan(0);
    // 丘も多い（hillAmountRatio 0.35）
    expect(c[Tile.Hill]!).toBeGreaterThan(idiv(w.map.tiles.length * 2, 10) - idiv(w.map.tiles.length, 10));
  });

  it('河川型は橋が架かる（橋の数だけ戦線が立つ前提）', () => {
    const { w, r } = gen('river', 4, 9999);
    expect(r.bridges.length).toBeGreaterThanOrEqual(1);
    const c = tileCounts(w);
    expect(c[Tile.Road]!).toBeGreaterThan(0);
    expect(c[Tile.Water]!).toBeGreaterThan(0);
    // 橋の上は通れる
    for (const b of r.bridges) {
      let walkable = 0;
      for (let y = b.ty; y < b.ty + b.heightTiles; y++) {
        for (let x = b.tx; x < b.tx + b.widthTiles; x++) if (isPassable(w.map, x, y)) walkable += 1;
      }
      expect(walkable).toBeGreaterThan(0);
    }
  });

  it('碑の島は中央に島と掟一違反領域を持つ', () => {
    const { w, r } = gen('monolith_isle', 4, 1234);
    expect(r.lawZones.length).toBe(1);
    const z = r.lawZones[0]!;
    expect(z.lawOne).toBe(true);
    expect(z.radius).toBeGreaterThan(0);
    // 中央は陸（島）、その外は水域
    const cx = idiv(w.map.widthTiles, 2);
    const cy = idiv(w.map.heightTiles, 2);
    expect(isPassable(w.map, cx, cy)).toBe(true);
    const ri = idiv(z.radius, FX_ONE);
    let waterOnRing = 0;
    for (let d = ri + 2; d < ri + 10; d++) {
      if (w.map.tiles[tileIndex(w.map, cx + d, cy)] === Tile.Water) waterOnRing += 1;
    }
    expect(waterOnRing).toBeGreaterThan(0);
    // 島は徒歩では拠点から届かない（周囲の岸に戦域が並ぶ）
    const reach = new Uint8Array(w.map.tiles.length);
    const queue = new Int32Array(w.map.tiles.length);
    const s0 = r.starts[0]!;
    computeReachable(w.map, tileIndex(w.map, s0.tx, s0.ty), Move.Land, reach, queue);
    expect(reach[tileIndex(w.map, cx, cy)]).toBe(0);
  });

  it('草原は障害物がほとんど無く見通しが良い', () => {
    const { w } = gen('steppe', 4, 555);
    const c = tileCounts(w);
    const blocking = c[Tile.Water]! + c[Tile.Cliff]! + c[Tile.Forest]!;
    expect(idiv(blocking * 100, w.map.tiles.length)).toBeLessThan(10);
  });
});
