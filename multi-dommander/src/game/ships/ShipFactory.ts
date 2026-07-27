import { Vector3, Quaternion } from "three";
import type { World } from "../../ecs/World";
import type { EntityId } from "../../ecs/Entity";
import { Comp, Faction } from "../components";
import type {
  Transform,
  RigidBody,
  FlightModel,
  ThrusterInput,
  Health,
  WeaponMount,
  Renderable,
  Collider,
  ShipInfo,
} from "../components";
import type { ShipDefinition } from "./ShipDefinition";
import { createShipMesh } from "../../render/MeshFactory";
import type { Scene } from "three";

export interface SpawnOptions {
  position: Vector3;
  quaternion?: Quaternion;
  faction: Faction;
}

/**
 * 難易度によるステータス補正。省略した項目は等倍 (=補正なし)。
 * - healthMul: シールド/アーマー/ハルの最大値・現在値に乗算。
 * - damageMul: 砲ダメージに乗算。
 * - fireIntervalMul: 連射間隔に乗算 (大きいほど遅い)。
 */
export interface SpawnMods {
  healthMul?: number;
  damageMul?: number;
  fireIntervalMul?: number;
}

/** ShipDefinition から ECS エンティティを生成し、メッシュをシーンに追加する。 */
export function spawnShip(
  world: World,
  scene: Scene,
  def: ShipDefinition,
  opts: SpawnOptions,
  mods: SpawnMods = {},
): EntityId {
  const healthMul = mods.healthMul ?? 1;
  const damageMul = mods.damageMul ?? 1;
  const fireIntervalMul = mods.fireIntervalMul ?? 1;
  const entity = world.createEntity();
  const quaternion = opts.quaternion ?? new Quaternion();

  const transform: Transform = {
    position: opts.position.clone(),
    quaternion: quaternion.clone(),
    prevPosition: opts.position.clone(),
    prevQuaternion: quaternion.clone(),
  };
  world.add(entity, Comp.Transform, transform);

  const rigid: RigidBody = {
    velocity: new Vector3(),
    angularVelocity: new Vector3(),
    mass: def.mass,
    inertia: new Vector3(def.inertia[0], def.inertia[1], def.inertia[2]),
  };
  world.add(entity, Comp.RigidBody, rigid);

  const flight: FlightModel = {
    maxLinearSpeed: def.flight.maxLinearSpeed,
    afterburnerMaxSpeed: def.flight.afterburnerMaxSpeed,
    linearThrust: new Vector3(...def.flight.linearThrust),
    angularThrust: new Vector3(...def.flight.angularThrust),
    linearDamping: def.flight.linearDamping,
    angularDamping: def.flight.angularDamping,
    flightAssist: true,
  };
  world.add(entity, Comp.FlightModel, flight);

  const input: ThrusterInput = {
    linear: new Vector3(),
    angular: new Vector3(),
    afterburner: false,
    firePrimary: false,
    fireMissile: false,
  };
  world.add(entity, Comp.ThrusterInput, input);

  const shieldMax = def.health.shieldMax * healthMul;
  const armorMax = def.health.armorMax * healthMul;
  const hullMax = def.health.hullMax * healthMul;
  const health: Health = {
    shield: shieldMax,
    shieldMax,
    shieldRegenRate: def.health.shieldRegenRate,
    shieldRegenDelay: def.health.shieldRegenDelay,
    armor: armorMax,
    armorMax,
    hull: hullMax,
    hullMax,
    lastHitTime: -999,
  };
  world.add(entity, Comp.Health, health);

  const weapon: WeaponMount = {
    gunCooldown: 0,
    gunFireInterval: def.weapon.gunFireInterval * fireIntervalMul,
    gunDamage: def.weapon.gunDamage * damageMul,
    gunProjectileSpeed: def.weapon.gunProjectileSpeed,
    gunRange: def.weapon.gunRange,
    energy: def.weapon.energyMax,
    energyMax: def.weapon.energyMax,
    energyRegen: def.weapon.energyRegen,
    energyPerShot: def.weapon.energyPerShot,
    hardpoints: def.hardpoints.map((h) => new Vector3(...h)),
    missiles: def.weapon.missiles,
    missileCooldown: 0,
    missileFireInterval: def.weapon.missileFireInterval,
  };
  world.add(entity, Comp.WeaponMount, weapon);

  const collider: Collider = { radius: def.radius };
  world.add(entity, Comp.Collider, collider);

  world.add(entity, Comp.Faction, opts.faction);

  const info: ShipInfo = { displayName: def.displayName, shipId: def.id };
  world.add(entity, Comp.ShipInfo, info);

  const mesh = createShipMesh(def);
  mesh.position.copy(transform.position);
  mesh.quaternion.copy(transform.quaternion);
  scene.add(mesh);
  const renderable: Renderable = { object: mesh };
  world.add(entity, Comp.Renderable, renderable);

  return entity;
}
