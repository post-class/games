import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { bus } from '../src/core/events';
import { GUNS, MISSILES } from '../src/content/weapons';
import { applyDamage } from '../src/sim/damage';
import { resolveProjectileHits } from '../src/sim/combat';
import { fireGuns, fireMissile, updateMissileLock } from '../src/sim/weapons';
import { spawnShip, World } from '../src/world/world';
import { shipDef } from '../src/content/ships';

describe('武器プロファイル', () => {
  it('主砲4種は挙動・描画・音声の識別情報を持つ', () => {
    const guns = Object.values(GUNS);
    expect(guns).toHaveLength(4);
    expect(new Set(guns.map((g) => g.presentation.fireMode)).size).toBe(4);
    for (const gun of guns) {
      expect(gun.speed).toBeGreaterThan(0);
      expect(gun.refire).toBeGreaterThan(0);
      expect(gun.energyCost).toBeGreaterThan(0);
      expect(gun.presentation.maxBrightness).toBeGreaterThan(0);
      expect(gun.presentation.maxBrightness).toBeLessThanOrEqual(1);
      expect(gun.presentation.description.length).toBeGreaterThan(0);
    }
  });

  it('ミサイル4種は誘導・航跡・起爆情報を持つ', () => {
    const missiles = Object.values(MISSILES);
    expect(missiles).toHaveLength(4);
    expect(new Set(missiles.map((m) => m.audioProfile)).size).toBe(4);
    for (const missile of missiles) {
      expect(missile.armTime).toBeGreaterThan(0);
      expect(missile.description.length).toBeGreaterThan(0);
      expect(missile.blastRadius).toBeGreaterThan(0);
    }
  });
});

describe('武器固有の手応え', () => {
  it('発射反動は発射を止めると短時間で戻る', () => {
    const world = new World();
    const player = spawnShip(world, {
      def: shipDef('rapier'),
      faction: 'confed',
      pos: new Vector3(),
      speed: 0,
      gunOverride: 'mass-driver',
    });
    world.playerId = player.id;
    player.input!.firePrimary = true;
    fireGuns(world, player, 1 / 60);
    expect(Math.max(...player.ship!.gunRecoil)).toBeGreaterThan(0);
    player.input!.firePrimary = false;
    for (let i = 0; i < 30; i++) fireGuns(world, player, 1 / 60);
    expect(Math.max(...player.ship!.gunRecoil)).toBe(0);
  });

  it('ニュートロンガンは同じ基礎ダメージでもシールドを強く削る', () => {
    const world = new World();
    const target = spawnShip(world, {
      def: shipDef('dralthi'),
      faction: 'kilrathi',
      pos: new Vector3(),
      speed: 0,
    });
    const shieldBefore = target.ship!.shield.front;
    applyDamage(target, 10, new Vector3(0, 0, -20));
    const normalSpent = shieldBefore - target.ship!.shield.front;

    target.ship!.shield.front = shieldBefore;
    applyDamage(target, 10, new Vector3(0, 0, -20), { shieldMultiplier: 1.45 });
    const neutronSpent = shieldBefore - target.ship!.shield.front;
    expect(neutronSpent).toBeGreaterThan(normalSpent);
  });

  it('発射イベントと命中イベントに武器ID・距離・面が残る', () => {
    const world = new World();
    const player = spawnShip(world, {
      def: shipDef('rapier'),
      faction: 'confed',
      pos: new Vector3(),
      speed: 0,
    });
    world.playerId = player.id;
    const enemy = spawnShip(world, {
      def: shipDef('dralthi'),
      faction: 'kilrathi',
      pos: new Vector3(0, 0, -300),
      speed: 0,
      gunOverride: 'mass-driver',
    });
    enemy.ship!.shield.front = 0;
    enemy.ship!.shield.rear = 0;
    const events: Array<{ weaponId?: string; distance?: number; hitFace?: string }> = [];
    const off = bus.on('armorHit', (p) => {
      if (p.target === enemy) events.push(p);
    });
    player.input!.firePrimary = true;
    fireGuns(world, player, 1 / 60);
    for (let i = 0; i < 60; i++) {
      for (const e of world.entities) {
        if (e.kind === 'projectile' && e.projectile) {
          e.prevPos.copy(e.pos);
          e.pos.addScaledVector(e.vel, 1 / 60);
        }
      }
      // 直接の移動でも、イベント契約の確認には十分なため次の呼び出しを使う。
      resolveProjectileHits(world);
      if (events.length > 0) break;
    }
    off();
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].weaponId).toBe('laser');
    expect(events[0].distance).toBeGreaterThan(0);
    expect(['front', 'rear', 'left', 'right']).toContain(events[0].hitFace);
  });

  it('発射不可理由をイベントで通知し、魚雷は大型目標以外へ撃てない', () => {
    const world = new World();
    const player = spawnShip(world, {
      def: shipDef('rapier'),
      faction: 'confed',
      pos: new Vector3(),
      speed: 0,
      missileOverride: [{ missileId: 'torpedo', count: 1 }],
    });
    world.playerId = player.id;
    const enemy = spawnShip(world, {
      def: shipDef('dralthi'),
      faction: 'kilrathi',
      pos: new Vector3(0, 0, -1000),
      speed: 0,
    });
    player.ship!.targetId = enemy.id;
    const reasons: string[] = [];
    const off = bus.on('weaponDenied', (p) => reasons.push(p.reason));
    for (let i = 0; i < 360; i++) updateMissileLock(world, player, 1 / 60);
    expect(fireMissile(world, player)).toEqual({ fired: false, reason: 'invalid-target' });
    off();
    expect(reasons).toContain('invalid-target');
  });
});
