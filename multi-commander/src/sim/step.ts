import type { FlightMode } from './flight';
import type { World } from '../world/world';
import { updateAi, type AiOptions } from './ai';
import {
  resolveProjectileHits,
  resolveShipCollisions,
  updateOrdnance,
} from './combat';
import { updateFlight, updateShipPower } from './flight';
import { findIncomingMissile, pruneTarget, updateLockedByEnemy } from './targeting';
import { fireGuns, updateMissileLock } from './weapons';

export interface StepOptions {
  flightMode: FlightMode;
  ai: Partial<AiOptions>;
  /** プレイヤーの照準アシスト (0 で無効) */
  aimAssist?: number;
}

/**
 * シミュレーションの1固定ステップ。
 * Game とテストで同じ順序を共有するため、ここに1本化している。
 * 描画補間用のスナップショットは呼び出し側の責任。
 */
export function simulateStep(world: World, dt: number, opts: StepOptions): void {
  world.time += dt;

  updateAi(world, dt, opts.ai);

  for (const e of world.entities) {
    if (!e.alive || e.kind !== 'ship' || !e.ship) continue;
    pruneTarget(world, e);
    updateMissileLock(world, e, dt);
    updateFlight(e, dt, opts.flightMode);
    updateShipPower(e, dt);
    // 照準アシストはプレイヤー機にだけ掛ける
    const assist =
      e.id === world.playerId && opts.aimAssist
        ? { targetId: e.ship.targetId, strength: opts.aimAssist }
        : undefined;
    fireGuns(world, e, dt, 1, assist);
  }

  updateOrdnance(world, dt);
  resolveProjectileHits(world);
  resolveShipCollisions(world);

  const player = world.player;
  if (player?.ship) {
    updateLockedByEnemy(world, player);
    player.ship.incomingMissileId = findIncomingMissile(world, player)?.id;
  }

  world.compact();
}

/** 描画補間用に1ステップ前の姿勢を記録する */
export function snapshotForRender(world: World): void {
  for (const e of world.entities) {
    e.renderPrevPos.copy(e.pos);
    e.renderPrevQuat.copy(e.quat);
  }
}
