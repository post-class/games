import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { DIFFICULTIES } from '../../src/app/settings';
import { clampLoadout, newSupplies, scaleLoadout } from '../../src/app/supplies';
import { GUNS } from '../../src/content/weapons';
import { shipDef } from '../../src/content/ships';
import { resolveProjectileHits } from '../../src/sim/combat';
import { fireGuns, fireMissile } from '../../src/sim/weapons';
import { primaryGunSpeed } from '../../src/sim/targeting';
import { spawnShip, World } from '../../src/world/world';

function playerWorld(missiles?: Array<{ missileId: string; count: number }>): {
  world: World;
  player: ReturnType<typeof spawnShip>;
} {
  const world = new World();
  const player = spawnShip(world, {
    def: shipDef('rapier'),
    faction: 'confed',
    pos: new Vector3(),
    speed: 0,
    missileOverride: missiles,
  });
  world.playerId = player.id;
  return { world, player };
}

function firstProjectile(world: World) {
  return world.entities.find((e) => e.kind === 'projectile' && e.projectile);
}

describe('EASY プレイヤー攻撃補正', () => {
  it('EASYだけに指定された主砲・ミサイル補正値を持つ', () => {
    expect(DIFFICULTIES.easy.playerGunSpeedScale).toBe(1.35);
    expect(DIFFICULTIES.easy.playerGunHitRadiusScale).toBe(1.8);
    expect(DIFFICULTIES.easy.playerMissileSpeedScale).toBe(1.35);
    expect(DIFFICULTIES.easy.playerMissileTriggerScale).toBe(1.5);
    expect(DIFFICULTIES.easy.playerMissileBlastScale).toBe(1.25);
    expect(DIFFICULTIES.easy.playerMissileCountScale).toBe(2);
    for (const profile of [DIFFICULTIES.normal, DIFFICULTIES.hard]) {
      expect(profile.playerGunSpeedScale).toBe(1);
      expect(profile.playerGunHitRadiusScale).toBe(1);
      expect(profile.playerMissileSpeedScale).toBe(1);
      expect(profile.playerMissileTriggerScale).toBe(1);
      expect(profile.playerMissileBlastScale).toBe(1);
      expect(profile.playerMissileCountScale).toBe(1);
    }
  });

  it('プレイヤー主砲の弾速とITTSの代表速度が同じ倍率になる', () => {
    const { world, player } = playerWorld();
    const normal = primaryGunSpeed(player);
    player.input!.firePrimary = true;
    fireGuns(world, player, 1 / 60, 1, undefined, 0, DIFFICULTIES.easy);
    const projectile = firstProjectile(world);
    expect(projectile).toBeDefined();
    expect(projectile!.vel.length()).toBeCloseTo(GUNS.laser.speed * DIFFICULTIES.easy.playerGunSpeedScale, 5);
    expect(primaryGunSpeed(player, DIFFICULTIES.easy.playerGunSpeedScale)).toBeCloseTo(
      normal * DIFFICULTIES.easy.playerGunSpeedScale,
      5,
    );
  });

  it('EASYの主砲だけは通常なら外れる軽いずれでも命中する', () => {
    const targetOffset = shipDef('dralthi').radius * 1.4;

    const normal = playerWorld();
    const normalTarget = spawnShip(normal.world, {
      def: shipDef('dralthi'),
      faction: 'kilrathi',
      pos: new Vector3(targetOffset, 0, -100),
      speed: 0,
    });
    normal.player.input!.firePrimary = true;
    fireGuns(normal.world, normal.player, 1 / 60);
    const normalProjectile = firstProjectile(normal.world)!;
    normalProjectile.prevPos.set(0, 0, 0);
    normalProjectile.pos.set(0, 0, -200);
    resolveProjectileHits(normal.world);
    expect(normalTarget.alive).toBe(true);
    expect(normalProjectile.alive).toBe(true);

    const easy = playerWorld();
    const easyTarget = spawnShip(easy.world, {
      def: shipDef('dralthi'),
      faction: 'kilrathi',
      pos: new Vector3(targetOffset, 0, -100),
      speed: 0,
    });
    easy.player.input!.firePrimary = true;
    fireGuns(easy.world, easy.player, 1 / 60, 1, undefined, 0, DIFFICULTIES.easy);
    const easyProjectile = firstProjectile(easy.world)!;
    easyProjectile.prevPos.set(0, 0, 0);
    easyProjectile.pos.set(0, 0, -200);
    resolveProjectileHits(easy.world);
    expect(easyProjectile.alive).toBe(false);
    expect(easyTarget.alive).toBe(true);
    expect(easyTarget.ship!.shield.front + easyTarget.ship!.shield.rear).toBeLessThan(
      easyTarget.ship!.def.shield.front + easyTarget.ship!.def.shield.rear,
    );
  });

  it('EASYのプレイヤーミサイルだけ速度・起爆・爆発の補正を持つ', () => {
    const normal = playerWorld([{ missileId: 'dumbfire', count: 1 }]);
    expect(fireMissile(normal.world, normal.player).fired).toBe(true);
    const normalMissile = normal.world.entities.find((e) => e.kind === 'missile')!;

    const easy = playerWorld([{ missileId: 'dumbfire', count: 1 }]);
    expect(fireMissile(easy.world, easy.player, DIFFICULTIES.easy).fired).toBe(true);
    const easyMissile = easy.world.entities.find((e) => e.kind === 'missile')!;
    expect(easyMissile.vel.length()).toBeCloseTo(
      normalMissile.vel.length() * DIFFICULTIES.easy.playerMissileSpeedScale,
      5,
    );
    expect(easyMissile.missile!.triggerScale).toBe(DIFFICULTIES.easy.playerMissileTriggerScale);
    expect(easyMissile.missile!.blastScale).toBe(DIFFICULTIES.easy.playerMissileBlastScale);
    expect(normalMissile.missile!.triggerScale).toBe(1);
    expect(normalMissile.missile!.blastScale).toBe(1);
  });

  it('EASYの要求搭載数を増やしても実在庫を超えず、消費できる', () => {
    const supplies = newSupplies();
    const requested = scaleLoadout([{ missileId: 'dumbfire', count: 4 }], DIFFICULTIES.easy.playerMissileCountScale);
    expect(requested).toEqual([{ missileId: 'dumbfire', count: 8 }]);
    const load = clampLoadout(supplies, requested);
    expect(load).toEqual([{ missileId: 'dumbfire', count: 8 }]);

    const scarce = { ...newSupplies(), missiles: { ...newSupplies().missiles, dumbfire: 5 } };
    expect(clampLoadout(scarce, requested)).toEqual([{ missileId: 'dumbfire', count: 5 }]);
  });
});
