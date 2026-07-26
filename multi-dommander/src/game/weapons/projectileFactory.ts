import { Vector3, Quaternion, type Scene } from "three";
import type { World } from "../../ecs/World";
import type { EntityId } from "../../ecs/Entity";
import { Comp, Faction } from "../components";
import type { Transform, RigidBody, Projectile, Missile, Renderable, Lifetime, Collider } from "../components";
import { createProjectileMesh, createMissileMesh } from "../../render/MeshFactory";

/** エネルギー砲の弾を生成。velocity はワールド系の弾速ベクトル。 */
export function spawnProjectile(
  world: World,
  scene: Scene,
  origin: Vector3,
  velocity: Vector3,
  damage: number,
  source: EntityId,
  faction: Faction,
  range: number,
): EntityId {
  const entity = world.createEntity();
  const q = new Quaternion();
  const speed = velocity.length();
  if (speed > 1e-3) {
    // メッシュを進行方向に向ける (+z を velocity へ)。
    q.setFromUnitVectors(new Vector3(0, 0, 1), velocity.clone().divideScalar(speed));
  }
  const transform: Transform = {
    position: origin.clone(),
    quaternion: q.clone(),
    prevPosition: origin.clone(),
    prevQuaternion: q.clone(),
  };
  world.add(entity, Comp.Transform, transform);
  const rb: RigidBody = {
    velocity: velocity.clone(),
    angularVelocity: new Vector3(),
    mass: 1,
    inertia: new Vector3(1, 1, 1),
  };
  world.add(entity, Comp.RigidBody, rb);
  const proj: Projectile = { damage, source, sourceFaction: faction };
  world.add(entity, Comp.Projectile, proj);
  const color = faction === Faction.Player || faction === Faction.Ally ? 0x66ffcc : 0xff5533;
  const mesh = createProjectileMesh(color);
  mesh.position.copy(origin);
  mesh.quaternion.copy(q);
  scene.add(mesh);
  world.add<Renderable>(entity, Comp.Renderable, { object: mesh });
  const life: Lifetime = { remaining: speed > 1e-3 ? range / speed : 1.5 };
  world.add(entity, Comp.Lifetime, life);
  return entity;
}

/** 誘導ミサイルを生成。 */
export function spawnMissile(
  world: World,
  scene: Scene,
  origin: Vector3,
  initialDir: Vector3,
  target: EntityId | null,
  damage: number,
  source: EntityId,
  faction: Faction,
): EntityId {
  const entity = world.createEntity();
  const q = new Quaternion();
  const dir = initialDir.clone().normalize();
  q.setFromUnitVectors(new Vector3(0, 0, 1), dir);
  const speed = 320;
  const transform: Transform = {
    position: origin.clone(),
    quaternion: q.clone(),
    prevPosition: origin.clone(),
    prevQuaternion: q.clone(),
  };
  world.add(entity, Comp.Transform, transform);
  const rb: RigidBody = {
    velocity: dir.clone().multiplyScalar(speed),
    angularVelocity: new Vector3(),
    mass: 1,
    inertia: new Vector3(1, 1, 1),
  };
  world.add(entity, Comp.RigidBody, rb);
  const missile: Missile = {
    damage,
    source,
    sourceFaction: faction,
    target,
    turnRate: 2.2,
    speed,
  };
  world.add(entity, Comp.Missile, missile);
  world.add<Collider>(entity, Comp.Collider, { radius: 2 });
  const mesh = createMissileMesh();
  mesh.position.copy(origin);
  mesh.quaternion.copy(q);
  scene.add(mesh);
  world.add<Renderable>(entity, Comp.Renderable, { object: mesh });
  world.add<Lifetime>(entity, Comp.Lifetime, { remaining: 8 });
  return entity;
}
