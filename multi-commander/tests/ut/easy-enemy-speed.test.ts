import { describe, expect, it } from 'vitest';
import { DIFFICULTIES } from '../../src/app/settings';
import { missionDef } from '../../src/content/missions';
import { MissionRunner } from '../../src/mission/MissionRunner';
import { World } from '../../src/world/world';

function start(difficultyId: 'easy' | 'normal') {
  const source = missionDef('m2-escort');
  const def = {
    ...source,
    spawns: source.spawns.map((group) => ({ ...group, atNav: undefined, delay: undefined })),
  };
  const world = new World();
  const runner = new MissionRunner(
    world,
    def,
    { shipId: def.playerShipId },
    DIFFICULTIES[difficultyId],
  );
  runner.build();
  const enemy = world.entities.find((e) => e.alive && e.faction === 'kilrathi');
  expect(enemy?.ship).toBeTruthy();
  return { enemy: enemy!, runner };
}

describe('easy difficulty enemy speed', () => {
  it('easy reduces enemy initial and maximum speed to 50% of normal', () => {
    const easy = start('easy');
    const normal = start('normal');

    expect(easy.enemy.ship!.speedScale).toBe(0.5);
    expect(normal.enemy.ship!.speedScale).toBe(1);
    expect(easy.enemy.vel.length()).toBeCloseTo(normal.enemy.vel.length() * 0.5, 10);

    easy.runner.dispose();
    normal.runner.dispose();
  });
});
