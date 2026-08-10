import { Euler, Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { AIM_PITCH_OFFSET } from '../../src/core/aim';
import { forwardOf, LOCAL_FORWARD, LOCAL_RIGHT } from '../../src/core/math';
import { shipDef } from '../../src/content/ships';
import { targetUnderReticle } from '../../src/sim/targeting';
import { spawnShip, World } from '../../src/world/world';
import type { Entity } from '../../src/world/entity';

/**
 * W7-5 照準下の目標を選択（`I`）。
 *
 * 判定の向きが**機首前方ではなく照準の射線**であることが要点。
 * `AIM_PITCH_OFFSET` は現状 0（照準が画面中央）なので、
 * 射線と機首の差を見るケースでは明示的な仰角を渡して確認する。
 */

/** 照準がはっきり機首より上を向く状況（約 12 度）。定数の 0 とは独立に検証する */
const TILTED_PITCH = (12 * Math.PI) / 180;

function playerShip(world: World, quat = new Quaternion()): Entity {
  const player = spawnShip(world, {
    def: shipDef('hornet'),
    faction: 'confed',
    pos: new Vector3(),
    quat,
    speed: 0,
  });
  world.playerId = player.id;
  return player;
}

/** 照準の射線（実装と同じ作り方: 機首前方を機体右軸まわりに回す） */
function reticleDir(self: Entity, aimPitchOffset: number): Vector3 {
  return LOCAL_FORWARD.clone()
    .applyQuaternion(new Quaternion().setFromAxisAngle(LOCAL_RIGHT, aimPitchOffset))
    .applyQuaternion(self.quat)
    .normalize();
}

/** `dir` から機体右軸まわりに `deg` だけずらした向き */
function tiltedFrom(self: Entity, aimPitchOffset: number, deg: number): Vector3 {
  return reticleDir(self, aimPitchOffset + (deg * Math.PI) / 180);
}

function spawnAt(world: World, dir: Vector3, dist: number, faction: 'kilrathi' | 'neutral') {
  return spawnShip(world, {
    def: shipDef(faction === 'kilrathi' ? 'kf03-greyhaul' : 'hornet'),
    faction,
    pos: dir.clone().normalize().multiplyScalar(dist),
    speed: 0,
  });
}

describe('照準下の目標を選択 (targetUnderReticle)', () => {
  it('W7T-01: 照準の射線上の相手を選び、ターゲットに設定する', () => {
    const world = new World();
    const player = playerShip(world, new Quaternion().setFromEuler(new Euler(0.2, -0.6, 0.3)));
    const enemy = spawnAt(world, reticleDir(player, AIM_PITCH_OFFSET), 3000, 'kilrathi');

    expect(targetUnderReticle(world, player, AIM_PITCH_OFFSET)?.id).toBe(enemy.id);
    expect(player.ship!.targetId).toBe(enemy.id);
  });

  it('W7T-02: 機首前方だが照準から 15 度ずれた相手は選ばない', () => {
    const world = new World();
    const player = playerShip(world);
    // 射線から 15 度（許容 10 度の外）。機首前方の広い円錐 (Y) には入る配置
    const dir = tiltedFrom(player, AIM_PITCH_OFFSET, 15);
    expect(dir.dot(forwardOf(player.quat, new Vector3()))).toBeGreaterThan(0.75);
    spawnAt(world, dir, 3000, 'kilrathi');

    expect(targetUnderReticle(world, player, AIM_PITCH_OFFSET)).toBeUndefined();
  });

  it('W7T-03: 敵と非敵対が同じ角度なら敵を選ぶ', () => {
    const world = new World();
    const player = playerShip(world);
    const aim = reticleDir(player, AIM_PITCH_OFFSET);
    // 非敵対を先に、かつ近い位置に置いても敵が選ばれる（微差の加点で敵優先）
    const civilian = spawnAt(world, aim, 2000, 'neutral');
    const enemy = spawnAt(world, aim, 2400, 'kilrathi');

    const picked = targetUnderReticle(world, player, AIM_PITCH_OFFSET);
    expect(picked?.id).toBe(enemy.id);
    expect(picked?.id).not.toBe(civilian.id);
  });

  it('W7T-04: 該当なしなら undefined を返し、ターゲットを設定しない', () => {
    const world = new World();
    const player = playerShip(world);
    // 真後ろと真横。どちらも許容角の外
    spawnAt(world, reticleDir(player, AIM_PITCH_OFFSET).negate(), 3000, 'kilrathi');
    spawnAt(world, tiltedFrom(player, AIM_PITCH_OFFSET, 90), 3000, 'neutral');

    expect(targetUnderReticle(world, player, AIM_PITCH_OFFSET)).toBeUndefined();
    expect(player.ship!.targetId).toBeUndefined();
  });

  it('W7T-05: 照準のピッチ差ぶんだけ上にいる相手も選べる（機首ベクトル判定なら落ちる）', () => {
    const world = new World();
    const player = playerShip(world);
    const aim = reticleDir(player, TILTED_PITCH);
    const nose = forwardOf(player.quat, new Vector3());
    // 照準の射線上（cos = 1）だが、機首からは 12 度ずれていて許容 10 度の外
    expect(aim.dot(nose)).toBeLessThan(0.985);
    const enemy = spawnAt(world, aim, 3000, 'kilrathi');

    expect(targetUnderReticle(world, player, TILTED_PITCH)?.id).toBe(enemy.id);
    // 同じ配置を機首前方（仰角 0）で判定すると掴めない = 射線を使っている証拠
    player.ship!.targetId = undefined;
    expect(targetUnderReticle(world, player, 0)).toBeUndefined();
    expect(enemy.alive).toBe(true);
  });

  it('W7T-06: 非敵対しかいなければ非敵対を選べる（第2章の識別用）', () => {
    const world = new World();
    const player = playerShip(world);
    const civilian = spawnAt(world, reticleDir(player, AIM_PITCH_OFFSET), 2500, 'neutral');

    expect(targetUnderReticle(world, player, AIM_PITCH_OFFSET)?.id).toBe(civilian.id);
  });
});
