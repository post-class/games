/**
 * 農地が食料を産むことの検証（`buildings.json` の農地「**食料を継続産出**」）。
 *
 * ■ なぜ後から足したか（実測で見つけた抜け）
 * `spawnFarm`（建物 + 食料ノードの対を置く関数）は**マップ生成とテストからしか
 * 呼ばれていなかった**。プレイヤーや AI が建てた農地には食料ノードが載らず、
 * **建てても 1 も採れない**状態だった。
 *
 * これは AI だけの問題ではない。人間が農地を建てても同じで、
 * 盤上の果樹（1 マップに数個）が枯れたら食料の入り口が永久に無くなる。
 * 実測（AI 30 分）では農地 7 面を建てたのに食料が 192 で止まり、
 * 青銅の世の 500 に一度も届かなかった。
 */

import { describe, expect, it } from 'vitest';
import { createWorld } from '@/sim/core/world';
import { EntityKind, RESOURCE_IDS } from '@/shared/types';
import { isAliveIndex, idOfIndex, PROGRESS_DONE } from '@/sim/core/entity';
import { spawnBuilding } from '@/sim/systems/construction';
import { fxFromInt } from '@/sim/core/fx';
import { resourceNodeDef, FARM_BUILDING_TYPE } from '@/sim/core/gather';

function makeWorld() {
  return createWorld({
    seed: 5,
    playerCount: 2,
    mapWidthTiles: 64,
    mapHeightTiles: 64,
    entityCapacity: 256,
  });
}

/** 生きている資源ノードを ID ごとに数える。 */
function nodeCounts(w: ReturnType<typeof makeWorld>): Record<string, number> {
  const out: Record<string, number> = {};
  const e = w.entities;
  for (let i = 0; i < e.highWater; i++) {
    if (!isAliveIndex(e, i)) continue;
    if (e.kind[i] !== EntityKind.Resource) continue;
    if (e.amount[i]! <= 0) continue;
    const id = resourceNodeDef(e.typeId[i]!).id;
    out[id] = (out[id] ?? 0) + 1;
  }
  return out;
}

describe('農地', () => {
  it('完成すると食料の資源ノードが載る', () => {
    const w = makeWorld();
    expect(nodeCounts(w)['farm'] ?? 0).toBe(0);
    spawnBuilding(w, 0, 'farm', fxFromInt(20), fxFromInt(20));
    expect(nodeCounts(w)['farm']).toBe(1);
  });

  it('ノードは食料（`resources.json` の food）で、埋蔵量を持つ', () => {
    const w = makeWorld();
    spawnBuilding(w, 0, 'farm', fxFromInt(20), fxFromInt(20));
    const e = w.entities;
    let found = false;
    for (let i = 0; i < e.highWater; i++) {
      if (!isAliveIndex(e, i) || e.kind[i] !== EntityKind.Resource) continue;
      const def = resourceNodeDef(e.typeId[i]!);
      if (def.id !== 'farm') continue;
      found = true;
      expect(RESOURCE_IDS[def.resource]).toBe('food');
      expect(e.amount[i]!).toBeGreaterThan(0);
    }
    expect(found).toBe(true);
  });

  it('ノードは農地の建物に紐付く（枯れたらノードだけ差し替えて再建できる）', () => {
    const w = makeWorld();
    spawnBuilding(w, 0, 'farm', fxFromInt(20), fxFromInt(20));
    const e = w.entities;
    let buildingId: number | null = null;
    for (let i = 0; i < e.highWater; i++) {
      if (!isAliveIndex(e, i)) continue;
      if (e.kind[i] === EntityKind.Building && e.typeId[i] === FARM_BUILDING_TYPE) {
        buildingId = idOfIndex(e, i);
        expect(e.buildProgress[i]).toBe(PROGRESS_DONE);
      }
    }
    expect(buildingId, '農地の建物が見つからない').not.toBeNull();
    let linked = 0;
    for (let i = 0; i < e.highWater; i++) {
      if (!isAliveIndex(e, i) || e.kind[i] !== EntityKind.Resource) continue;
      if (e.homeId[i] === buildingId) linked++;
    }
    expect(linked, 'ノードが建物に紐付いていない').toBe(1);
  });

  it('ノードは所有者を持つ（他人の農地から採らせない）', () => {
    const w = makeWorld();
    spawnBuilding(w, 1, 'farm', fxFromInt(30), fxFromInt(30));
    const e = w.entities;
    for (let i = 0; i < e.highWater; i++) {
      if (!isAliveIndex(e, i) || e.kind[i] !== EntityKind.Resource) continue;
      if (resourceNodeDef(e.typeId[i]!).id !== 'farm') continue;
      expect(e.owner[i]).toBe(1);
    }
  });

  it('農地を 2 面置いたらノードも 2 個（1 面ごとに 1 個）', () => {
    const w = makeWorld();
    spawnBuilding(w, 0, 'farm', fxFromInt(20), fxFromInt(20));
    spawnBuilding(w, 0, 'farm', fxFromInt(28), fxFromInt(20));
    expect(nodeCounts(w)['farm']).toBe(2);
  });

  it('農地以外の建物ではノードが載らない', () => {
    const w = makeWorld();
    spawnBuilding(w, 0, 'house', fxFromInt(20), fxFromInt(20));
    expect(nodeCounts(w)['farm'] ?? 0).toBe(0);
  });
});
