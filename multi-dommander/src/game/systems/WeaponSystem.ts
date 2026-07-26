import { Vector3, type Scene } from "three";
import type { System } from "../../ecs/System";
import type { World } from "../../ecs/World";
import { Comp, Faction } from "../components";
import type { Transform, RigidBody, WeaponMount, ThrusterInput, Targeting } from "../components";
import { spawnProjectile, spawnMissile } from "../weapons/projectileFactory";
import type { EventBus } from "../../util/EventBus";

const fwd = new Vector3();
const muzzleWorld = new Vector3();
const projVel = new Vector3();

/**
 * 発射入力に応じてエネルギー砲/ミサイルを発射する。
 * エネルギー管理・クールダウン・弾速合成 (自機速度を加算) を扱う。
 */
export class WeaponSystem implements System {
  readonly name = "WeaponSystem";

  constructor(
    private readonly scene: Scene,
    private readonly events: EventBus,
  ) {}

  update(world: World, dt: number): void {
    const entities = world.query(Comp.WeaponMount, Comp.Transform, Comp.ThrusterInput);
    for (const entity of entities) {
      const wm = world.getOrThrow<WeaponMount>(entity, Comp.WeaponMount);
      const t = world.getOrThrow<Transform>(entity, Comp.Transform);
      const ti = world.getOrThrow<ThrusterInput>(entity, Comp.ThrusterInput);
      const faction = world.get<Faction>(entity, Comp.Faction) ?? Faction.Neutral;

      // クールダウン・エネルギー回復。
      wm.gunCooldown = Math.max(0, wm.gunCooldown - dt);
      wm.missileCooldown = Math.max(0, wm.missileCooldown - dt);
      wm.energy = Math.min(wm.energyMax, wm.energy + wm.energyRegen * dt);

      fwd.set(0, 0, 1).applyQuaternion(t.quaternion);

      // エネルギー砲。
      if (ti.firePrimary && wm.gunCooldown <= 0 && wm.energy >= wm.energyPerShot) {
        this.fireGun(world, entity, wm, t, faction);
      }

      // ミサイル。
      if (ti.fireMissile && wm.missileCooldown <= 0 && wm.missiles > 0) {
        this.fireMissile(world, entity, wm, t, faction);
      }
    }
  }

  private fireGun(
    world: World,
    entity: number,
    wm: WeaponMount,
    t: Transform,
    faction: Faction,
  ): void {
    const rb = world.get<RigidBody>(entity, Comp.RigidBody);
    // 弾速 = 砲口速度(前方) + 自機速度成分 (簡易)。
    projVel.copy(fwd).multiplyScalar(wm.gunProjectileSpeed);
    if (rb) projVel.add(rb.velocity);

    for (const hp of wm.hardpoints) {
      muzzleWorld.copy(hp).applyQuaternion(t.quaternion).add(t.position);
      spawnProjectile(
        world,
        this.scene,
        muzzleWorld,
        projVel,
        wm.gunDamage,
        entity,
        faction,
        wm.gunRange,
      );
    }
    wm.energy -= wm.energyPerShot;
    wm.gunCooldown = wm.gunFireInterval;
    this.events.emit("weaponFired", {
      shooter: entity,
      position: t.position.clone(),
      kind: "gun",
    });
  }

  private fireMissile(
    world: World,
    entity: number,
    wm: WeaponMount,
    t: Transform,
    faction: Faction,
  ): void {
    const targeting = world.get<Targeting>(entity, Comp.Targeting);
    // ロック完了時のみ誘導対象を付与。未ロックでも無誘導で発射可能。
    const target =
      targeting && targeting.lockProgress >= 1 ? targeting.target : null;
    const origin = wm.hardpoints[0]
      ? muzzleWorld.copy(wm.hardpoints[0]).applyQuaternion(t.quaternion).add(t.position).clone()
      : t.position.clone();
    spawnMissile(world, this.scene, origin, fwd.clone(), target, wm.gunDamage * 3.5, entity, faction);
    wm.missiles -= 1;
    wm.missileCooldown = wm.missileFireInterval;
    this.events.emit("weaponFired", {
      shooter: entity,
      position: t.position.clone(),
      kind: "missile",
    });
  }
}
