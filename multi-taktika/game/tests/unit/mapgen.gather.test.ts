import { describe, it, expect } from 'vitest';
import { EntityKind, RESOURCE_IDS } from '@/shared/types';
import { createWorld } from '@/sim/core/world';
import { entityIndex } from '@/sim/core/entity';
import { generateMap, mapSizeForPlayers } from '@/sim/systems/mapgen';
import {
  RESOURCE_NODE_DEFS,
  findNearestResourceNodeIndex,
  resourceNodeDef,
} from '@/sim/core/gather';
import { FX_ONE } from '@/sim/core/fx';

/**
 * mapgen（M3）が置いた資源ノードを、economy（M4）が正しく解釈できるかの検証。
 *
 * ■ なぜこのテストが必要か
 * 両者は `EntityKind.Resource` の `typeId` を通してだけ繋がっているが、
 * この添字には**別空間の候補が 2 つある**:
 *   - `RESOURCE_IDS` の添字（0..3 = food/wood/stone/gold）
 *   - `RESOURCE_NODE_DEFS` の添字（0..7 = farm/hunt/fish/fruit/sheep/forest/stone_quarry/gold_mine）
 *
 * 並行実装の結果、mapgen が前者・gather が後者で書いていた時期があり、
 * **マップ上の木材・石材・金がすべて「食料」として解釈され、
 * 木・石・金の収入が丸ごとゼロになる**という不整合が起きた。
 * それぞれの単体テストは両方とも緑だったので、ここで境界を突き合わせる。
 */
describe('mapgen ↔ gather の資源ノード規約', () => {
  const size = mapSizeForPlayers('plain', 2);
  const w = createWorld({
    seed: 4242,
    playerCount: 2,
    mapWidthTiles: size,
    mapHeightTiles: size,
    entityCapacity: 4096,
  });
  const result = generateMap(w, { mapType: 'plain' });

  it('置かれた全ノードの typeId が RESOURCE_NODE_DEFS の範囲に収まる', () => {
    const e = w.entities;
    let count = 0;
    for (let i = 0; i < e.highWater; i++) {
      if (e.alive[i] !== 1 || e.kind[i] !== EntityKind.Resource) continue;
      count++;
      const typeId = e.typeId[i]!;
      expect(typeId, `index ${i}`).toBeLessThan(RESOURCE_NODE_DEFS.length);
      // 例外を投げずに引けること（範囲外なら resourceNodeDef が throw する）
      expect(() => resourceNodeDef(typeId)).not.toThrow();
    }
    expect(count).toBeGreaterThan(0);
  });

  it('ノードの種類と資源の対応が mapgen の意図どおり（森=木材, 石切場=石材, 金鉱=金, 果樹=食料）', () => {
    const e = w.entities;
    const byResource = new Map<number, Set<string>>();
    for (let i = 0; i < e.highWater; i++) {
      if (e.alive[i] !== 1 || e.kind[i] !== EntityKind.Resource) continue;
      const def = resourceNodeDef(e.typeId[i]!);
      const set = byResource.get(def.resource) ?? new Set<string>();
      set.add(def.id);
      byResource.set(def.resource, set);
    }
    const idx = (r: string): number => RESOURCE_IDS.indexOf(r as never);
    expect([...(byResource.get(idx('wood')) ?? [])]).toEqual(['forest']);
    expect([...(byResource.get(idx('stone')) ?? [])]).toEqual(['stone_quarry']);
    expect([...(byResource.get(idx('gold')) ?? [])]).toEqual(['gold_mine']);
    expect([...(byResource.get(idx('food')) ?? [])]).toEqual(['fruit']);
  });

  it('4 資源すべてが「拠点の近くで見つかる」（収入がゼロになる資源がない）', () => {
    // これが本来の不整合の症状。木材・石材・金が見つからなければ内政が成立しない。
    for (let p = 0; p < w.playerCount; p++) {
      const sx = w.map.starts[p * 2]!;
      const sy = w.map.starts[p * 2 + 1]!;
      for (const r of RESOURCE_IDS) {
        const found = findNearestResourceNodeIndex(w, sx, sy, RESOURCE_IDS.indexOf(r));
        expect(found, `${r} のノードが 1 つも見つからない`).toBeGreaterThanOrEqual(0);
        // 拠点のすぐ近くにあること（等距離配布の確認も兼ねる）
        const dx = (w.entities.x[found]! - sx) / FX_ONE;
        const dy = (w.entities.y[found]! - sy) / FX_ONE;
        const dist = Math.sqrt(dx * dx + dy * dy);
        expect(dist, `player ${p} の ${r} が遠すぎる（${dist.toFixed(1)} マス）`).toBeLessThan(40);
      }
    }
  });

  it('埋蔵量は resources.json の値どおり（mapgen 側で二重解釈していない）', () => {
    const e = w.entities;
    for (const node of result.nodes) {
      const i = entityIndex(node.id);
      const def = resourceNodeDef(e.typeId[i]!);
      // 争点の「豊かな」ノードは倍率が掛かっているので、通常ノードだけ突き合わせる
      if (node.rich) continue;
      expect(e.amount[i], `${def.id}`).toBe(def.deposit);
    }
  });
});
