import { Euler, Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { AIM_PITCH_OFFSET } from '../../src/core/aim';
import { LOCAL_FORWARD, LOCAL_RIGHT, leadPoint } from '../../src/core/math';
import { shipDef } from '../../src/content/ships';
import { updateOrdnance } from '../../src/sim/combat';
import { fireMissile, updateMissileLock } from '../../src/sim/weapons';
import { spawnShip, World } from '../../src/world/world';

const DT = 1 / 60;

function playerShip(world: World, id = 'rapier') {
  const player = spawnShip(world, {
    def: shipDef(id),
    faction: 'confed',
    pos: new Vector3(),
    quat: new Quaternion(),
    speed: 0,
  });
  world.playerId = player.id;
  return player;
}

function fixedReticleDirection(player: ReturnType<typeof playerShip>): Vector3 {
  return LOCAL_FORWARD.clone()
    .applyQuaternion(new Quaternion().setFromAxisAngle(LOCAL_RIGHT, AIM_PITCH_OFFSET))
    .applyQuaternion(player.quat)
    .normalize();
}

function missileDirection(missile: { quat: Quaternion }): Vector3 {
  return LOCAL_FORWARD.clone().applyQuaternion(missile.quat).normalize();
}

function angleBetween(a: Vector3, b: Vector3): number {
  return Math.acos(Math.max(-1, Math.min(1, a.dot(b))));
}

function lockTarget(world: World, player: ReturnType<typeof playerShip>, position: Vector3) {
  const target = spawnShip(world, {
    def: shipDef('kf03-greyhaul'),
    faction: 'kilrathi',
    pos: position,
    speed: 0,
  });
  player.ship!.targetId = target.id;
  player.ship!.activeMissile = 1;
  for (let i = 0; i < 90; i++) updateMissileLock(world, player, DT);
  return target;
}

describe('ミサイル照準', () => {
  it('MSL-01: 固定照準線上のダムファイア弾は照準方向へ出る', () => {
    const world = new World();
    const player = playerShip(world, 'hornet');

    expect(fireMissile(world, player).fired).toBe(true);
    const missile = world.entities.find((e) => e.kind === 'missile');
    expect(missile).toBeDefined();
    expect(angleBetween(missileDirection(missile!), fixedReticleDirection(player))).toBeLessThan(
      Math.PI / 180,
    );
  });

  it('MSL-02: AI 機のミサイルは機首正面の基準方向を維持する', () => {
    const world = new World();
    const player = playerShip(world, 'hornet');
    world.playerId = 0;
    player.quat.setFromEuler(new Euler(0.15, -0.6, 0.2, 'XYZ'));
    const expectedNose = LOCAL_FORWARD.clone().applyQuaternion(player.quat).normalize();

    expect(fireMissile(world, player).fired).toBe(true);
    const missile = world.entities.find((e) => e.kind === 'missile');
    expect(missile).toBeDefined();
    expect(angleBetween(missileDirection(missile!), expectedNose)).toBeLessThan(Math.PI / 180);
  });

  it('MSL-03: ロック済み誘導弾も固定照準線から発射され、目標 ID を引き継ぐ', () => {
    const world = new World();
    const player = playerShip(world);
    const target = lockTarget(world, player, fixedReticleDirection(player).multiplyScalar(2500));

    expect(player.ship!.lockedId).toBe(target.id);
    expect(fireMissile(world, player).fired).toBe(true);
    const missile = world.entities.find((e) => e.kind === 'missile');
    expect(missile?.missile?.targetId).toBe(target.id);
    expect(angleBetween(missileDirection(missile!), fixedReticleDirection(player))).toBeLessThan(
      Math.PI / 180,
    );
  });

  it('MSL-04: 誘導弾は移動する目標への予測方向へ近づく', () => {
    const world = new World();
    const player = playerShip(world);
    const target = lockTarget(world, player, fixedReticleDirection(player).multiplyScalar(2500));
    target.vel.set(120, 0, 0);

    expect(fireMissile(world, player).fired).toBe(true);
    const missile = world.entities.find((e) => e.kind === 'missile');
    expect(missile).toBeDefined();

    const firstError = angleBetween(
      missile!.vel.clone().normalize(),
      leadPoint(missile!.pos, target.pos, target.vel, missile!.vel.length(), new Vector3())
        .sub(missile!.pos)
        .normalize(),
    );
    for (let i = 0; i < 30; i++) {
      target.pos.addScaledVector(target.vel, DT);
      updateOrdnance(world, DT);
    }
    const lastError = angleBetween(
      missile!.vel.clone().normalize(),
      leadPoint(missile!.pos, target.pos, target.vel, missile!.vel.length(), new Vector3())
        .sub(missile!.pos)
        .normalize(),
    );
    expect(lastError).toBeLessThan(firstError);
  });

  it('MSL-05: 機体を旋回させても照準方向はワールドへ正しく変換される', () => {
    const world = new World();
    const player = playerShip(world, 'hornet');
    player.quat
      .multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.8))
      .multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -0.25));

    expect(fireMissile(world, player).fired).toBe(true);
    const missile = world.entities.find((e) => e.kind === 'missile');
    expect(missile).toBeDefined();
    expect(angleBetween(missileDirection(missile!), fixedReticleDirection(player))).toBeLessThan(
      Math.PI / 180,
    );
  });

  it('MSL-06: 弾切れと未ロックの誘導弾は発射せず状態を変更しない', () => {
    const world = new World();
    const player = playerShip(world);
    for (const slot of player.ship!.missiles) slot.count = 0;
    expect(fireMissile(world, player)).toEqual({ fired: false, reason: 'no-ammo' });
    expect(world.count('missile')).toBe(0);

    const seekerWorld = new World();
    const seekerPlayer = playerShip(seekerWorld);
    seekerPlayer.ship!.activeMissile = 1;
    const before = seekerPlayer.ship!.missiles[1].count;
    expect(fireMissile(seekerWorld, seekerPlayer)).toEqual({ fired: false, reason: 'no-lock' });
    expect(seekerPlayer.ship!.missiles[1].count).toBe(before);
    expect(seekerWorld.count('missile')).toBe(0);
  });
});
