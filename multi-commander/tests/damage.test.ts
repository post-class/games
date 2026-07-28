import { describe, it, expect } from "vitest";
import { applyDamage } from "../src/game/systems/DamageSystem";
import type { Health } from "../src/game/components";

function makeHealth(): Health {
  return {
    shield: 100,
    shieldMax: 100,
    shieldRegenRate: 10,
    shieldRegenDelay: 4,
    armor: 60,
    armorMax: 60,
    hull: 80,
    hullMax: 80,
    lastHitTime: 0,
  };
}

describe("applyDamage: shield -> armor -> hull の順に適用", () => {
  it("シールド内のダメージはシールドのみ減らす", () => {
    const h = makeHealth();
    const r = applyDamage(h, 30, 1);
    expect(h.shield).toBe(70);
    expect(h.armor).toBe(60);
    expect(h.hull).toBe(80);
    expect(r.destroyed).toBe(false);
  });

  it("シールドを超えた分はアーマーに波及する", () => {
    const h = makeHealth();
    applyDamage(h, 130, 1); // shield100 + armor30
    expect(h.shield).toBe(0);
    expect(h.armor).toBe(30);
    expect(h.hull).toBe(80);
  });

  it("シールド+アーマーを超えた分はハルを削る", () => {
    const h = makeHealth();
    applyDamage(h, 180, 1); // shield100 + armor60 + hull20
    expect(h.shield).toBe(0);
    expect(h.armor).toBe(0);
    expect(h.hull).toBe(60);
  });

  it("ハルが0以下で destroyed=true", () => {
    const h = makeHealth();
    const r = applyDamage(h, 100 + 60 + 80, 1);
    expect(h.hull).toBeLessThanOrEqual(0);
    expect(r.destroyed).toBe(true);
  });

  it("被弾時刻が記録される", () => {
    const h = makeHealth();
    applyDamage(h, 10, 42);
    expect(h.lastHitTime).toBe(42);
  });
});
