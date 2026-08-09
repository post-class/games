/**
 * T-M8-08: 増援の自動編入（`07§3`「半径に入った自軍ユニットは自動でその戦域に編入」）
 *
 * 完了条件: 半径に入った兵の `frontId` が変わる。手動（`manual = 1`）の兵は変わらない。
 */

import { describe, expect, it } from 'vitest';
import { EntityKind } from '@/shared/types';
import { createWorld, getFront, type World } from '@/sim/core/world';
import { entityIndex, spawnEntity } from '@/sim/core/entity';
import { fxFromInt, fxToInt } from '@/sim/core/fx';
import { unitDefById } from '@/sim/core/defs';
import { rebuildGrid } from '@/sim/core/grid';
import { allocateTerrain } from '@/sim/core/terrain';
import { frontEnrollment } from '@/sim/systems/frontEnrollment';

const MAP = 200;
const SOLDIER = 'clubman';

function makeWorld(): World {
  const w = createWorld({
    seed: 88,
    playerCount: 2,
    mapWidthTiles: MAP,
    mapHeightTiles: MAP,
    entityCapacity: 512,
  });
  allocateTerrain(w.map);
  for (const pl of w.players) pl.frontSlots = 6;
  return w;
}

function putUnit(w: World, owner: number, tx: number, ty: number, id = SOLDIER): number {
  const d = unitDefById(id);
  return entityIndex(
    spawnEntity(w.entities, {
      kind: EntityKind.Unit,
      owner,
      typeId: d.index,
      x: fxFromInt(tx),
      y: fxFromInt(ty),
      hpMax: d.hp,
    })
  );
}

/** 中心 (cx, cy) 半径 r マスの戦域を owner の slot に立てる。 */
function openFront(w: World, owner: number, slot: number, cx: number, cy: number, r: number): void {
  const f = getFront(w, owner, slot)!;
  f.active = true;
  f.x = fxFromInt(cx);
  f.y = fxFromInt(cy);
  f.radius = fxFromInt(r);
  f.lastEngageTick = 0;
}

function tickEnrollment(w: World, times = 1): void {
  for (let k = 0; k < times; k++) {
    rebuildGrid(w.grid, w.entities, w.tick);
    frontEnrollment(w);
    w.tick += 1;
  }
}

describe('T-M8-08 増援の自動編入', () => {
  it('半径に入った自軍の frontId が変わり、手動の兵と敵は変わらない', () => {
    const w = makeWorld();
    openFront(w, 0, 1, 60, 60, 15);

    const inside = putUnit(w, 0, 65, 60); // 半径内
    const manual = putUnit(w, 0, 66, 60); // 半径内だが手動操作中
    const outside = putUnit(w, 0, 90, 60); // 半径外（30 マス）
    const enemy = putUnit(w, 1, 64, 60); // 半径内だが敵
    w.entities.manual[manual] = 1;

    tickEnrollment(w);

    const e = w.entities;
    expect(e.frontId[inside]).toBe(1);
    expect(e.frontId[manual]).toBe(0); // 手動の兵は編入しない
    expect(e.frontId[outside]).toBe(0);
    expect(e.frontId[enemy]).toBe(0); // 敵は自軍の戦域に入らない
    expect(getFront(w, 0, 1)!.memberCount).toBe(1);
  });

  it('後から半径に入った増援も編入される（memberCount が増える）', () => {
    const w = makeWorld();
    openFront(w, 0, 1, 60, 60, 15);
    const first = putUnit(w, 0, 60, 60);
    tickEnrollment(w);
    expect(w.entities.frontId[first]).toBe(1);
    expect(getFront(w, 0, 1)!.memberCount).toBe(1);

    const reinforce = putUnit(w, 0, 70, 60);
    tickEnrollment(w);
    expect(w.entities.frontId[reinforce]).toBe(1);
    expect(getFront(w, 0, 1)!.memberCount).toBe(2);
  });

  it('半径外に出た兵は外れ、最後の令を保持する', () => {
    const w = makeWorld();
    openFront(w, 0, 1, 60, 60, 15);
    const f = getFront(w, 0, 1)!;
    f.order = 'retreat'; // ORDER_IDS の 6 番目 → lastOrder = 6
    const i = putUnit(w, 0, 60, 60);
    tickEnrollment(w);
    expect(w.entities.frontId[i]).toBe(1);

    // 中心が兵に追従しないように、戦域の中心を固定したまま兵だけ遠ざける。
    w.entities.x[i] = fxFromInt(200);
    tickEnrollment(w);
    expect(w.entities.frontId[i]).toBe(0);
    expect(w.entities.lastOrder[i]).toBe(6);
  });

  it('中心は所属ユニットの重心になる', () => {
    const w = makeWorld();
    openFront(w, 0, 1, 60, 60, 15);
    putUnit(w, 0, 56, 60);
    putUnit(w, 0, 64, 60);
    putUnit(w, 0, 60, 66);
    tickEnrollment(w);
    const f = getFront(w, 0, 1)!;
    expect(fxToInt(f.x)).toBe(60);
    expect(fxToInt(f.y)).toBe(62);
  });

  it('輪が重なった兵は slot 番号の小さい戦域に属する', () => {
    const w = makeWorld();
    openFront(w, 0, 2, 60, 60, 15);
    openFront(w, 0, 1, 66, 60, 15);
    const i = putUnit(w, 0, 63, 60); // 両方の半径内

    tickEnrollment(w);
    expect(w.entities.frontId[i]).toBe(1);
  });

  it('手動操作を始めた兵は戦域から外れる（同じ戦域の他の兵は残る）', () => {
    const w = makeWorld();
    openFront(w, 0, 1, 60, 60, 15);
    const a = putUnit(w, 0, 60, 60);
    const b = putUnit(w, 0, 61, 60);
    tickEnrollment(w);
    expect(w.entities.frontId[a]).toBe(1);

    w.entities.manual[a] = 1;
    tickEnrollment(w);
    expect(w.entities.frontId[a]).toBe(0);
    expect(w.entities.frontId[b]).toBe(1);
  });
});
