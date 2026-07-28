import { describe, it, expect } from "vitest";
import { Vector3, Quaternion } from "three";
import { World } from "../src/ecs/World";
import { CollisionSystem, segmentSphereHit } from "../src/game/systems/CollisionSystem";
import { EventBus } from "../src/util/EventBus";
import { Comp, Faction } from "../src/game/components";
import type { Transform, Health, Collider, Projectile } from "../src/game/components";

function addTarget(w: World, faction: Faction, pos: Vector3, radius = 10) {
  const e = w.createEntity();
  const t: Transform = {
    position: pos.clone(),
    quaternion: new Quaternion(),
    prevPosition: pos.clone(),
    prevQuaternion: new Quaternion(),
  };
  w.add(e, Comp.Transform, t);
  const h: Health = {
    shield: 50, shieldMax: 50, shieldRegenRate: 0, shieldRegenDelay: 99,
    armor: 30, armorMax: 30, hull: 40, hullMax: 40, lastHitTime: 0,
  };
  w.add(e, Comp.Health, h);
  w.add<Collider>(e, Comp.Collider, { radius });
  w.add(e, Comp.Faction, faction);
  return { e, h };
}

function addProjectile(w: World, from: Vector3, to: Vector3, faction: Faction, source: number) {
  const e = w.createEntity();
  const t: Transform = {
    position: to.clone(),
    quaternion: new Quaternion(),
    prevPosition: from.clone(),
    prevQuaternion: new Quaternion(),
  };
  w.add(e, Comp.Transform, t);
  w.add<Projectile>(e, Comp.Projectile, { damage: 20, source, sourceFaction: faction });
  return e;
}

describe("segmentSphereHit", () => {
  it("線分が球を貫くとヒット", () => {
    expect(segmentSphereHit(new Vector3(0, 0, -20), new Vector3(0, 0, 20), new Vector3(0, 0, 0), 5)).toBe(true);
  });
  it("外れるとミス", () => {
    expect(segmentSphereHit(new Vector3(0, 0, -20), new Vector3(0, 0, 20), new Vector3(100, 0, 0), 5)).toBe(false);
  });
});

describe("CollisionSystem: 弾が敵対機に当たるとダメージ", () => {
  it("敵→味方の被弾でシールドが減る", () => {
    const w = new World();
    const events = new EventBus();
    const sys = new CollisionSystem(events, () => 1);
    const shooter = w.createEntity();
    const { e: target, h } = addTarget(w, Faction.Ally, new Vector3(0, 0, 0));
    // 弾が前フレーム(-30) → 現フレーム(+30) で target(0,0,0) を通過。
    addProjectile(w, new Vector3(0, 0, -30), new Vector3(0, 0, 30), Faction.Enemy, shooter);
    let hit = 0;
    events.on("hit", () => hit++);
    sys.update(w, 1 / 60);
    expect(hit).toBe(1);
    expect(h.shield).toBe(30); // 50 - 20
    void target;
  });

  it("同陣営には当たらない (フレンドリーファイア無し)", () => {
    const w = new World();
    const events = new EventBus();
    const sys = new CollisionSystem(events, () => 1);
    const shooter = w.createEntity();
    const { h } = addTarget(w, Faction.Ally, new Vector3(0, 0, 0));
    addProjectile(w, new Vector3(0, 0, -30), new Vector3(0, 0, 30), Faction.Player, shooter);
    sys.update(w, 1 / 60);
    expect(h.shield).toBe(50); // 無傷
  });
});
