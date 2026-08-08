import { Vector3 } from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import { bus } from '../../src/core/events';
import { GUNS, MISSILES } from '../../src/content/weapons';
import { applyDamage } from '../../src/sim/damage';
import { fireGuns } from '../../src/sim/weapons';
import { newSupplies, normalizeSupplies } from '../../src/app/supplies';
import { shipDef } from '../../src/content/ships';
import { spawnShip, World } from '../../src/world/world';

afterEach(() => bus.clear());

describe('武器拡張', () => {
  it('主砲6種とミサイル6種を定義する', () => {
    expect(Object.keys(GUNS)).toHaveLength(6);
    expect(Object.keys(MISSILES)).toHaveLength(6);
    expect(GUNS['pulse-cannon'].presentation.projectileCount).toBe(3);
    expect(GUNS['ion-lance'].presentation.fireMode).toBe('lance');
    expect(MISSILES['shield-breaker'].shieldMultiplier).toBe(1.8);
    expect(MISSILES['armor-breacher'].armorMultiplier).toBe(1.8);
  });

  it('パルスキャノンは砲口ごとに3発を生成し、消費は1回分だけ', () => {
    const world = new World();
    const player = spawnShip(world, {
      def: shipDef('hornet'),
      faction: 'confed',
      pos: new Vector3(),
      speed: 0,
      gunOverride: 'pulse-cannon',
    });
    world.playerId = player.id;
    const before = player.ship!.energy;
    const events: Array<{ shotCount?: number }> = [];
    const off = bus.on('weaponFired', (event) => events.push(event));

    player.input!.firePrimary = true;
    fireGuns(world, player, 1 / 60);
    off();

    expect(world.count('projectile')).toBe(player.ship!.def.guns.length * 3);
    expect(player.ship!.energy).toBe(before - player.ship!.def.guns.length * 10);
    expect(events).toHaveLength(player.ship!.def.guns.length);
    expect(events.every((event) => event.shotCount === 3)).toBe(true);
  });

  it('新ミサイルの倍率はシールドと装甲へ別々に適用される', () => {
    const world = new World();
    const target = spawnShip(world, {
      def: shipDef('dralthi'),
      faction: 'kilrathi',
      pos: new Vector3(),
      speed: 0,
    });
    const shieldBefore = target.ship!.shield.front;
    applyDamage(target, 10, new Vector3(0, 0, -20), { shieldMultiplier: 1.8 });
    const shieldSpent = shieldBefore - target.ship!.shield.front;
    expect(shieldSpent).toBeGreaterThan(10);

    target.ship!.shield.front = 0;
    const armorBefore = target.ship!.armor.front;
    applyDamage(target, 10, new Vector3(0, 0, -20), { armorMultiplier: 1.8 });
    const armorSpent = armorBefore - target.ship!.armor.front;
    expect(armorSpent).toBeGreaterThan(10);
  });

  it('既存セーブには新ミサイルを無償追加せず、新規在庫には追加する', () => {
    expect(newSupplies().missiles['shield-breaker']).toBe(8);
    expect(newSupplies().missiles['armor-breacher']).toBe(4);
    const migrated = normalizeSupplies({ missiles: { dumbfire: 3, torpedo: 1 } });
    expect(migrated.missiles['shield-breaker']).toBe(0);
    expect(migrated.missiles['armor-breacher']).toBe(0);
  });
});
