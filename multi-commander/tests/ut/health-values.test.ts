import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { shipDef } from '../../src/content/ships';
import { applyDamage, healthValues } from '../../src/sim/damage';
import { spawnShip, World } from '../../src/world/world';

function testShip() {
  const world = new World();
  const entity = spawnShip(world, {
    def: shipDef('rapier'),
    faction: 'confed',
    pos: new Vector3(),
    speed: 0,
  });
  return { entity, world };
}

describe('healthValues', () => {
  it('機体定義の最大値と現在の部位別残量を返す', () => {
    const { entity } = testShip();
    const def = entity.ship!.def;
    const values = healthValues(entity);

    expect(values.shield.front).toEqual({ current: def.shield.front, max: def.shield.front });
    expect(values.shield.rear).toEqual({ current: def.shield.rear, max: def.shield.rear });
    expect(values.armor.front).toEqual({ current: def.armor.front, max: def.armor.front });
    expect(values.armor.rear).toEqual({ current: def.armor.rear, max: def.armor.rear });
    expect(values.armor.left).toEqual({ current: def.armor.left, max: def.armor.left });
    expect(values.armor.right).toEqual({ current: def.armor.right, max: def.armor.right });
    expect(values.hull).toEqual({ current: def.hull, max: def.hull });
  });

  it('正面ダメージ後も前面だけが減り、数値表示に反映される', () => {
    const { entity } = testShip();
    const def = entity.ship!.def;
    applyDamage(entity, 10, new Vector3(0, 0, -20));
    const values = healthValues(entity);

    expect(values.shield.front.current).toBe(def.shield.front - 10);
    expect(values.shield.rear.current).toBe(def.shield.rear);
    expect(values.armor.front.current).toBe(def.armor.front);
    expect(values.armor.left.current).toBe(def.armor.left);
    expect(values.armor.right.current).toBe(def.armor.right);
  });

  it('0未満と最大値超過を表示用の範囲に収める', () => {
    const { entity } = testShip();
    const ship = entity.ship!;
    ship.shield.front = -10;
    ship.shield.rear = ship.def.shield.rear + 10;
    ship.armor.left = -5;
    ship.armor.right = ship.def.armor.right + 5;
    ship.hull = ship.def.hull + 5;
    const values = healthValues(entity);

    expect(values.shield.front.current).toBe(0);
    expect(values.shield.rear.current).toBe(values.shield.rear.max);
    expect(values.armor.left.current).toBe(0);
    expect(values.armor.right.current).toBe(values.armor.right.max);
    expect(values.hull.current).toBe(values.hull.max);
  });
});
