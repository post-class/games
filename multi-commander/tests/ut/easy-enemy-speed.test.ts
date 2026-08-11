import { describe, expect, it } from 'vitest';
import { DIFFICULTIES } from '../../src/app/settings';
import { TEST_ESCORT } from './fixtures/missions';
import { MissionRunner } from '../../src/mission/MissionRunner';
import { World } from '../../src/world/world';

function start(difficultyId: 'easy' | 'normal' | 'hard') {
  const source = TEST_ESCORT;
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
  return { enemy: enemy!, runner, world };
}

describe('easy difficulty enemy speed', () => {
  it('easy は敵機の初速・最高速を「ふつう」の 25% にする', () => {
    const easy = start('easy');
    const normal = start('normal');

    // 難易度プロファイルが唯一の出所 (MissionRunner に数値を書かない)
    expect(DIFFICULTIES.easy.enemySpeedScale).toBe(0.25);
    expect(easy.enemy.ship!.speedScale).toBe(DIFFICULTIES.easy.enemySpeedScale);
    expect(normal.enemy.ship!.speedScale).toBe(1);
    expect(easy.enemy.vel.length()).toBeCloseTo(normal.enemy.vel.length() * 0.25, 10);

    easy.runner.dispose();
    normal.runner.dispose();
  });

  it('NORMAL / HARD の敵速度は据え置き (1 倍)', () => {
    expect(DIFFICULTIES.normal.enemySpeedScale).toBe(1);
    expect(DIFFICULTIES.hard.enemySpeedScale).toBe(1);

    const hard = start('hard');
    expect(hard.enemy.ship!.speedScale).toBe(1);
    hard.runner.dispose();
  });

  it('easy でも味方機の速度は落とさない', () => {
    const easy = start('easy');
    const friendly = easy.world.entities.filter(
      (e) => e.alive && e.kind === 'ship' && e.faction === 'confed',
    );
    expect(friendly.length).toBeGreaterThan(0);
    for (const e of friendly) expect(e.ship!.speedScale).toBe(1);
    easy.runner.dispose();
  });
});
