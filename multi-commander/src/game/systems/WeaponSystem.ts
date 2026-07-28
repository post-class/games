import { Vector3, type Scene } from "three";
import type { System } from "../../ecs/System";
import type { World } from "../../ecs/World";
import { Comp, Faction } from "../components";
import type { Transform, WeaponMount, ThrusterInput, Targeting } from "../components";
import type { AIController } from "../components/AIController";
import { spawnProjectile, spawnMissile } from "../weapons/projectileFactory";
import { WEAPON_DEFS } from "../weapons/WeaponDefs";
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

      // ミサイル (副兵装)。
      if (ti.fireMissile && wm.missileCooldown <= 0 && this.hasSecondaryAmmo(wm)) {
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
    projVel.copy(fwd).multiplyScalar(wm.gunProjectileSpeed);

    const color = wm.gunColor ?? (faction === Faction.Player || faction === Faction.Ally ? 0x66ffcc : 0xff5533);
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
        color,
      );
    }
    wm.energy -= wm.energyPerShot;
    wm.gunCooldown = wm.gunFireInterval;
    const muzzle = wm.hardpoints[0]
      ? muzzleWorld.copy(wm.hardpoints[0]).applyQuaternion(t.quaternion).add(t.position)
      : t.position;
    this.events.emit("weaponFired", {
      shooter: entity,
      position: t.position.clone(),
      muzzlePosition: muzzle.clone(),
      direction: fwd.clone(),
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

    // 副兵装のWeaponDefを解決。
    const secId = wm.secondaries?.[wm.activeSecondary ?? 0];
    const secDef = secId ? WEAPON_DEFS[secId] : undefined;

    // ロック要否をWeaponDefから判定。
    const lockRequired = secDef?.lockRequired ?? true;
    let target = targeting && targeting.lockProgress >= 1 ? targeting.target : null;
    if (!lockRequired && target === null) {
      target = targeting?.target ?? null;
    }
    // AI(敵/僚機)は Targeting を持たないため、AIの現在ターゲットを誘導対象にする。
    if (target === null) {
      const ai = world.get<AIController>(entity, Comp.AIController);
      if (ai && ai.target !== null && world.isAlive(ai.target)) target = ai.target;
    }

    // 残弾チェック (secondaryAmmo がある場合はそちらを消費)。
    if (wm.secondaryAmmo && secId) {
      const ammo = wm.secondaryAmmo[secId] ?? 0;
      if (ammo <= 0) return;
      wm.secondaryAmmo[secId] = ammo - 1;
    } else {
      wm.missiles -= 1;
    }

    const origin = wm.hardpoints[0]
      ? muzzleWorld.copy(wm.hardpoints[0]).applyQuaternion(t.quaternion).add(t.position).clone()
      : t.position.clone();
    const damage = secDef?.damage ?? wm.gunDamage * 3.5;
    const speed = secDef?.projectileSpeed ?? 320;
    const turnRate = secDef?.turnRate ?? 2.2;
    const seeker = secDef?.seeker ?? "heat";
    spawnMissile(world, this.scene, origin, fwd.clone(), target, damage, entity, faction, {
      speed, turnRate, seeker,
    });
    wm.missileCooldown = secDef?.fireInterval ?? wm.missileFireInterval;
    this.events.emit("weaponFired", {
      shooter: entity,
      position: t.position.clone(),
      muzzlePosition: origin.clone(),
      direction: fwd.clone(),
      kind: "missile",
    });
  }

  private hasSecondaryAmmo(wm: WeaponMount): boolean {
    if (wm.secondaryAmmo && wm.secondaries) {
      const secId = wm.secondaries[wm.activeSecondary ?? 0];
      if (secId) return (wm.secondaryAmmo[secId] ?? 0) > 0;
    }
    return wm.missiles > 0;
  }
}
