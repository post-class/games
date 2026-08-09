import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { ReplayBuffer } from '../../src/app/replay';
import { shipDef } from '../../src/content/ships';
import { spawnShip, World } from '../../src/world/world';

describe('ReplayBuffer', () => {
  it('固定ステップを直近30秒に切り詰め、時間指定で近いフレームを返す', () => {
    const world = new World();
    const player = spawnShip(world, { def: shipDef('rapier'), faction: 'confed', pos: new Vector3(), speed: 0 });
    world.playerId = player.id;
    const enemy = spawnShip(world, { def: shipDef('kf03-greyhaul'), faction: 'kilrathi', pos: new Vector3(100, 0, -800), speed: 0 });
    const input = { pitch: 0.2, yaw: -0.1, roll: 0, throttle: 0.7 } as never;
    const replay = new ReplayBuffer();

    for (let i = 0; i < 2000; i++) {
      world.time += 1 / 60;
      player.pos.x = i;
      enemy.pos.z = -800 - i;
      replay.record(world, input, 1 / 60);
    }

    expect(replay.duration).toBeLessThanOrEqual(30);
    expect(replay.length).toBeGreaterThan(1700);
    const frame = replay.frameAtTime(10);
    expect(frame).toBeDefined();
    expect(frame?.ships.find((s) => s.player)?.forward).toHaveLength(3);
    expect(frame?.input.throttle).toBe(0.7);
    expect(replay.frameAtTime(-1)?.time).toBe(replay.frameAt(0)?.time);
    expect(replay.frameAtTime(999)?.time).toBe(replay.frameAt(replay.length - 1)?.time);
  });

  it('撃墜などのマーカーを現在フレームに保持する', () => {
    const world = new World();
    const player = spawnShip(world, { def: shipDef('rapier'), faction: 'confed', pos: new Vector3(), speed: 0 });
    world.playerId = player.id;
    const replay = new ReplayBuffer();
    replay.record(world, { pitch: 0, yaw: 0, roll: 0, throttle: 0 } as never, 1 / 60);
    replay.mark('敵エース 撃墜');
    expect(replay.recentMarkers()).toEqual(['0.0s　敵エース 撃墜']);
  });
});
