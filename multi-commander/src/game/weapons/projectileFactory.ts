import { Vector3, Quaternion, type Scene, SphereGeometry, MeshBasicMaterial, Mesh } from "three";
import type { World } from "../../ecs/World";
import type { EntityId } from "../../ecs/Entity";
import { Comp, Faction } from "../components";
import type { Transform, RigidBody, Projectile, Missile, Decoy, Renderable, Lifetime, Collider } from "../components";
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
  overrideColor?: number,
): EntityId {
  const entity = world.createEntity();
  const q = new Quaternion();
  const speed = velocity.length();
  if (speed > 1e-3) {
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
  const color = overrideColor ?? (faction === Faction.Player || faction === Faction.Ally ? 0x66ffcc : 0xff5533);
  const mesh = createProjectileMesh(color);
  mesh.position.copy(origin);
  mesh.quaternion.copy(q);
  scene.add(mesh);
  world.add<Renderable>(entity, Comp.Renderable, { object: mesh });
  const life: Lifetime = { remaining: speed > 1e-3 ? range / speed : 1.5 };
  world.add(entity, Comp.Lifetime, life);
  return entity;
}

export interface MissileSpawnOpts {
  speed?: number;
  turnRate?: number;
  seeker?: "none" | "heat" | "aspect";
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
  opts?: MissileSpawnOpts,
): EntityId {
  const entity = world.createEntity();
  const q = new Quaternion();
  const dir = initialDir.clone().normalize();
  q.setFromUnitVectors(new Vector3(0, 0, 1), dir);
  const speed = opts?.speed ?? 320;
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
  const seeker = opts?.seeker ?? "heat";
  const missile: Missile = {
    damage,
    source,
    sourceFaction: faction,
    target: seeker === "none" ? null : target,
    turnRate: opts?.turnRate ?? 2.2,
    speed,
    seeker,
    flareSensitivity: seeker === "heat" ? 0.7 : seeker === "aspect" ? 0.15 : 0,
  };
  world.add(entity, Comp.Missile, missile);
  world.add<Collider>(entity, Comp.Collider, { radius: 2 });
  const mesh = createMissileMesh();
  mesh.position.copy(origin);
  mesh.quaternion.copy(q);
  scene.add(mesh);
  world.add<Renderable>(entity, Comp.Renderable, { object: mesh });
  const lifetime = speed > 0 ? (opts?.seeker === "none" ? 4 : 8) : 8;
  world.add<Lifetime>(entity, Comp.Lifetime, { remaining: lifetime });
  return entity;
}

/** デコイ(フレア)を生成。小さな発光球、微速でドリフト、約3秒で消滅。 */
export function spawnDecoy(world: World, scene: Scene, position: Vector3, faction: Faction): EntityId {
  const entity = world.createEntity();
  const q = new Quaternion();
  const transform: Transform = {
    position: position.clone(),
    quaternion: q.clone(),
    prevPosition: position.clone(),
    prevQuaternion: q.clone(),
  };
  world.add(entity, Comp.Transform, transform);
  // ランダムな微小速度でドリフト (散布効果)。
  const vel = new Vector3((Math.random() - 0.5) * 20, (Math.random() - 0.5) * 20, (Math.random() - 0.5) * 20);
  const rb: RigidBody = {
    velocity: vel,
    angularVelocity: new Vector3(),
    mass: 0.1,
    inertia: new Vector3(0.1, 0.1, 0.1),
  };
  world.add(entity, Comp.RigidBody, rb);
  const decoy: Decoy = { faction };
  world.add(entity, Comp.Decoy, decoy);
  world.add<Lifetime>(entity, Comp.Lifetime, { remaining: 3 });
  // 小さく明るい発光球。加算合成で目立たせる。
  const geo = new SphereGeometry(0.5, 8, 6);
  const mat = new MeshBasicMaterial({ color: 0xffff00, transparent: true, opacity: 0.9 });
  mat.blending = 2; // AdditiveBlending
  const mesh = new Mesh(geo, mat);
  mesh.position.copy(position);
  scene.add(mesh);
  world.add<Renderable>(entity, Comp.Renderable, { object: mesh });
  return entity;
}
