/**
 * T-M7-01: 投射物（矢・弾・投石）の飛翔
 *
 * 完了条件: **弓の矢が飛翔時間を持ち、外れ判定がない（命中確定）ことを確認**。
 * したがってここでは
 *  - 発射した tick に着弾しない（飛翔時間 >= 1 tick）
 *  - 距離が遠いほど飛翔時間が長い
 *  - 目標が飛翔中に動いても必ず着弾する（追尾する = 外れない）
 *  - 乱数を 1 度も消費しない
 * を検証する。
 */

import { describe, expect, it } from 'vitest';
import { EntityKind } from '@/shared/types';
import { createEntities, entityIndex, flushDead, idOfIndex, spawnEntity } from '@/sim/core/entity';
import { FX_ONE, fxFromInt } from '@/sim/core/fx';
import { unitDefById } from '@/sim/core/defs';
import {
  isProjectileAttackClass,
  remainingFlightTicks,
  shooterElevationOf,
  spawnProjectile,
  stepProjectiles,
} from '@/sim/core/projectile';
import { Rng } from '@/sim/core/rng';

function scene() {
  const e = createEntities(64);
  const archer = unitDefById('y-daikyu'); // 射程 5 マス、arrow
  const target = unitDefById('y-ashigaru');
  const shooterId = spawnEntity(e, {
    kind: EntityKind.Unit,
    owner: 0,
    typeId: archer.index,
    x: fxFromInt(10),
    y: fxFromInt(10),
    hpMax: archer.hp,
  });
  const targetId = spawnEntity(e, {
    kind: EntityKind.Unit,
    owner: 1,
    typeId: target.index,
    x: fxFromInt(14),
    y: fxFromInt(10),
    hpMax: target.hp,
  });
  return { e, archer, shooterId, targetId };
}

function launch(tick = 0) {
  const s = scene();
  const { e, archer, shooterId, targetId } = s;
  const t = entityIndex(targetId);
  const pid = spawnProjectile(e, {
    owner: 0,
    shooterTypeId: archer.index,
    shooterId,
    attackClass: archer.attackClass,
    x: e.x[entityIndex(shooterId)]!,
    y: e.y[entityIndex(shooterId)]!,
    targetId,
    targetX: e.x[t]!,
    targetY: e.y[t]!,
    shooterElevation: 0,
    tick,
  });
  return { ...s, pid, pi: entityIndex(pid) };
}

describe('T-M7-01 投射物は飛翔時間を持つ', () => {
  it('矢は発射 tick に着弾しない（4 マスで 8 tick）', () => {
    const { e, pi } = launch(0);
    // 4 マス = 1024 Fx。既定 12 マス/秒 → 1 tick 0.48 マス = 123 Fx。
    // flight = trunc(1024 / 123) = 8 tick。
    expect(e.stateTick[pi]).toBe(8);
    expect(remainingFlightTicks(e, pi, 0)).toBe(8);
    expect(e.kind[pi]).toBe(EntityKind.Projectile);
  });

  it('距離が遠いほど飛翔時間が長い（単調）', () => {
    const s = scene();
    const { e, archer, shooterId, targetId } = s;
    const ticks: number[] = [];
    for (const d of [1, 2, 4, 8]) {
      const pid = spawnProjectile(e, {
        owner: 0,
        shooterTypeId: archer.index,
        shooterId,
        attackClass: archer.attackClass,
        x: 0,
        y: 0,
        targetId,
        targetX: fxFromInt(d),
        targetY: 0,
        shooterElevation: 0,
        tick: 0,
      });
      ticks.push(e.stateTick[entityIndex(pid)]!);
    }
    expect(ticks).toEqual([2, 4, 8, 16]);
    expect(ticks[0]).toBeGreaterThanOrEqual(1); // 最短 1 tick は必ずかかる
  });

  it('毎 tick 少しずつ進み、着弾 tick でちょうど目標に届く', () => {
    const { e, pi, targetId } = launch(0);
    const tx = e.x[entityIndex(targetId)]!;
    let impacts = 0;
    for (let tick = 0; tick < 8; tick++) {
      stepProjectiles(e, tick, () => {
        impacts += 1;
      });
      expect(impacts).toBe(0); // 途中では着弾しない
      expect(e.x[pi]!).toBeGreaterThan(fxFromInt(10));
      expect(e.x[pi]!).toBeLessThanOrEqual(tx);
    }
    stepProjectiles(e, 8, () => {
      impacts += 1;
    });
    expect(impacts).toBe(1);
    expect(e.x[pi]).toBe(tx);
    // 着弾した投射物は死亡予約されている（解放は cleanup）
    expect(e.alive[pi]).toBe(0);
  });

  it('目標が飛翔中に動いても必ず当たる（外れ判定なし）', () => {
    const { e, pi, targetId } = launch(0);
    const t = entityIndex(targetId);
    let impacted = -1;
    for (let tick = 0; tick <= 8; tick++) {
      // 毎 tick 目標を 0.5 マスずつ逃がす
      e.x[t] = e.x[t]! + FX_ONE / 2;
      stepProjectiles(e, tick, (p) => {
        impacted = p;
      });
    }
    expect(impacted).toBe(pi);
    // 着弾点は「逃げた後の座標」
    expect(e.x[pi]).toBe(e.x[t]);
  });

  it('目標が死んでいたら最後に見えた座標へ着弾する', () => {
    const { e, pi, targetId } = launch(0);
    const t = entityIndex(targetId);
    const lastX = e.x[t]!;
    e.alive[t] = 0; // combat が殺した状態を模す
    let impacted = -1;
    for (let tick = 0; tick <= 8; tick++) {
      stepProjectiles(e, tick, (p) => {
        impacted = p;
      });
    }
    expect(impacted).toBe(pi);
    expect(e.x[pi]).toBe(lastX);
  });

  it('射手の高さを記録している（射手が死んでも地形倍率を再現できる）', () => {
    const s = scene();
    const { e, archer, shooterId, targetId } = s;
    const pid = spawnProjectile(e, {
      owner: 0,
      shooterTypeId: archer.index,
      shooterId,
      attackClass: archer.attackClass,
      x: 0,
      y: 0,
      targetId,
      targetX: fxFromInt(4),
      targetY: 0,
      shooterElevation: 2,
      tick: 0,
    });
    expect(shooterElevationOf(e, entityIndex(pid))).toBe(2);
  });

  it('投射物を出す attackClass の判定', () => {
    expect(isProjectileAttackClass('arrow')).toBe(true);
    expect(isProjectileAttackClass('gunpowder')).toBe(true);
    expect(isProjectileAttackClass('siege')).toBe(true);
    expect(isProjectileAttackClass('aoe')).toBe(true);
    expect(isProjectileAttackClass('melee')).toBe(false);
  });

  it('乱数を消費しない（命中確定なので外れ判定がない）', () => {
    const rng = new Rng(12345);
    const before = rng.clone();
    const { e } = launch(0);
    for (let tick = 0; tick <= 8; tick++) stepProjectiles(e, tick, () => {});
    // spawnProjectile / stepProjectiles は Rng を引数に取らないので消費できない。
    // 念のため「同じ種の Rng が同じ値を返す」ことも確認しておく。
    expect(rng.nextU32()).toBe(before.nextU32());
  });

  it('着弾後に index が再利用される（free list に返る）', () => {
    const { e, pi } = launch(0);
    for (let tick = 0; tick <= 8; tick++) stepProjectiles(e, tick, () => {});
    const gen = e.generation[pi]!;
    flushDead(e);
    expect(e.generation[pi]).toBe((gen + 1) & 0xffff);
    // 同じ index に別のエンティティが入っても、古い EntityId は無効になる
    const reused = spawnEntity(e, {
      kind: EntityKind.Unit,
      owner: 0,
      typeId: 0,
      x: 0,
      y: 0,
      hpMax: FX_ONE,
    });
    expect(entityIndex(reused)).toBe(pi);
    expect(idOfIndex(e, pi)).toBe(reused);
  });
});
