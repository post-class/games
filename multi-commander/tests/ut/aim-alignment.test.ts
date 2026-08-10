import { Euler, PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { AIM_BASE_FOV_DEG, AIM_ORIGIN_Y, AIM_PITCH_OFFSET } from '../../src/core/aim';
import { shipDef } from '../../src/content/ships';
import { fireGuns, fireMissile } from '../../src/sim/weapons';
import { worldToScreen } from '../../src/hud/project';
import { spawnShip, World } from '../../src/world/world';

/**
 * 照準環と射線の一致。
 *
 * 「照準の上へ弾が飛ぶ」不具合の再発防止。HUD の照準環の縦位置 (AIM_ORIGIN_Y) と
 * 実際の弾の射線 (AIM_PITCH_OFFSET) が同じ定数から作られていることを、
 * **画面座標に投影して**確認する。定数を写した比較ではなく、
 * コクピット視点のカメラ (機体の姿勢をそのまま使う) で見た位置で判定する。
 */

const DT = 1 / 60;
const WIDTH = 1280;
const HEIGHT = 720;

function playerWithCamera(euler?: Euler) {
  const world = new World();
  const quat = euler ? new Quaternion().setFromEuler(euler) : new Quaternion();
  const player = spawnShip(world, {
    def: shipDef('hornet'),
    faction: 'confed',
    pos: new Vector3(),
    quat,
    // 弾は母機の速度を引き継ぐので、射線だけを見るために静止させる
    speed: 0,
  });
  world.playerId = player.id;

  // CameraRig のコクピット視点と同じ姿勢 (機体の quat をそのまま使う)
  const camera = new PerspectiveCamera(AIM_BASE_FOV_DEG, WIDTH / HEIGHT, 0.1, 1e6);
  camera.position.copy(player.pos);
  camera.quaternion.copy(player.quat);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  return { world, player, camera };
}

/** 射線上のはるか前方の点が、画面のどこに写るか */
function screenOfLine(
  camera: PerspectiveCamera,
  origin: Vector3,
  dir: Vector3,
): { x: number; y: number } {
  const far = origin.clone().addScaledVector(dir.clone().normalize(), 40000);
  const p = worldToScreen(camera, far, WIDTH, HEIGHT);
  expect(p.inFront).toBe(true);
  return { x: p.x, y: p.y };
}

describe('固定照準と射線', () => {
  it('AIM-01: 照準環の位置と主砲の射線が同じ画面位置になる', () => {
    const { world, player, camera } = playerWithCamera();
    player.input!.firePrimary = true;

    fireGuns(world, player, DT, 1, undefined, AIM_PITCH_OFFSET);
    const shots = world.entities.filter((e) => e.kind === 'projectile');
    expect(shots.length).toBeGreaterThan(0);

    for (const shot of shots) {
      const p = screenOfLine(camera, shot.pos, shot.vel);
      // 照準環は AIM_ORIGIN_Y の高さ・画面中央の横位置に描かれる
      expect(p.y).toBeCloseTo(AIM_ORIGIN_Y * HEIGHT, 0);
      expect(p.x).toBeCloseTo(WIDTH / 2, 0);
    }
  });

  it('AIM-02: ミサイルも照準環と同じ画面位置へ出る', () => {
    const { world, player, camera } = playerWithCamera();

    expect(fireMissile(world, player).fired).toBe(true);
    const missile = world.entities.find((e) => e.kind === 'missile');
    expect(missile).toBeDefined();

    const p = screenOfLine(camera, missile!.pos, missile!.vel);
    expect(p.y).toBeCloseTo(AIM_ORIGIN_Y * HEIGHT, 0);
    expect(p.x).toBeCloseTo(WIDTH / 2, 0);
  });

  it('AIM-03: 機体を傾けても照準環の位置と射線は一致する', () => {
    const { world, player, camera } = playerWithCamera(new Euler(0.24, -0.7, 0.35, 'XYZ'));
    player.input!.firePrimary = true;

    fireGuns(world, player, DT, 1, undefined, AIM_PITCH_OFFSET);
    const shot = world.entities.find((e) => e.kind === 'projectile');
    expect(shot).toBeDefined();

    const p = screenOfLine(camera, shot!.pos, shot!.vel);
    expect(p.y).toBeCloseTo(AIM_ORIGIN_Y * HEIGHT, 0);
    expect(p.x).toBeCloseTo(WIDTH / 2, 0);
  });

  it('AIM-04: 照準を画面中央に置く限り、射線の仰角補正は 0 である', () => {
    expect(AIM_ORIGIN_Y).toBe(0.5);
    expect(AIM_PITCH_OFFSET).toBeCloseTo(0, 12);
  });
});
