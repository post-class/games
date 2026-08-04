import { Scene, Vector3, type BufferGeometry, type LineSegments } from 'three';
import { describe, expect, it } from 'vitest';
import { SpaceDust } from '../src/render/SpaceDust';
import { shipDef } from '../src/content/ships';
import { spawnShip, World } from '../src/world/world';

describe('ジャンプ演出 (宇宙塵の筋)', () => {
  /** 線分の長さの平均を測る */
  function meanTail(scene: Scene): number {
    const mesh = scene.children[0] as LineSegments;
    const pos = (mesh.geometry as BufferGeometry).attributes.position;
    let sum = 0;
    const count = pos.count / 2;
    for (let i = 0; i < count; i++) {
      const dx = pos.getX(i * 2 + 1) - pos.getX(i * 2);
      const dy = pos.getY(i * 2 + 1) - pos.getY(i * 2);
      const dz = pos.getZ(i * 2 + 1) - pos.getZ(i * 2);
      sum += Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
    return sum / count;
  }

  it('warp を上げると塵が長い筋に伸びる', () => {
    const world = new World();
    const player = spawnShip(world, {
      def: shipDef('hornet'),
      faction: 'confed',
      pos: new Vector3(),
      speed: 0,
    });
    player.vel.set(0, 0, -200);

    const scene = new Scene();
    const dust = new SpaceDust(scene);
    dust.update(player);
    const normal = meanTail(scene);

    dust.setWarp(1);
    dust.update(player);
    const warped = meanTail(scene);

    expect(normal).toBeGreaterThan(0);
    // 明確に「流れている」と分かる差が必要
    expect(warped).toBeGreaterThan(normal * 10);

    // 戻せば元の長さに戻る
    dust.setWarp(0);
    dust.update(player);
    expect(meanTail(scene)).toBeCloseTo(normal, 3);
  });
});
