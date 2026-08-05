import { Quaternion, Vector3 } from 'three';
import type { Faction, ShipDef } from '../content/ships';
import { gunDef, missileDef, type SeekerKind } from '../content/weapons';
import { newSubsystems } from '../sim/subsystems';
import {
  newInput,
  type AiRuntime,
  type Entity,
  type EntityKind,
  type MissileSlot,
  type ShipRuntime,
} from './entity';

export class World {
  entities: Entity[] = [];
  private nextId = 1;
  private index = new Map<number, Entity>();
  /** プレイヤー機の entity id */
  playerId = 0;
  /** 経過時間 (秒) */
  time = 0;

  get player(): Entity | undefined {
    const e = this.index.get(this.playerId);
    return e && e.alive ? e : undefined;
  }

  byId(id: number | undefined): Entity | undefined {
    if (id === undefined) return undefined;
    const e = this.index.get(id);
    return e && e.alive ? e : undefined;
  }

  add(e: Entity): Entity {
    this.entities.push(e);
    this.index.set(e.id, e);
    return e;
  }

  allocId(): number {
    return this.nextId++;
  }

  kill(e: Entity): void {
    e.alive = false;
  }

  /** 死んだエンティティを配列から取り除く。毎ステップ末に呼ぶ。 */
  compact(): Entity[] {
    const removed: Entity[] = [];
    let w = 0;
    for (let i = 0; i < this.entities.length; i++) {
      const e = this.entities[i];
      if (e.alive) {
        this.entities[w++] = e;
      } else {
        removed.push(e);
        this.index.delete(e.id);
      }
    }
    this.entities.length = w;
    return removed;
  }

  reset(): void {
    this.entities.length = 0;
    this.index.clear();
    this.nextId = 1;
    this.playerId = 0;
    this.time = 0;
  }

  ships(): Entity[] {
    return this.entities.filter((e) => e.kind === 'ship' && e.alive);
  }

  count(kind: EntityKind): number {
    let n = 0;
    for (const e of this.entities) if (e.alive && e.kind === kind) n++;
    return n;
  }
}

function baseEntity(world: World, kind: EntityKind, faction: Faction, pos: Vector3, quat: Quaternion): Entity {
  return {
    id: world.allocId(),
    alive: true,
    kind,
    faction,
    pos: pos.clone(),
    prevPos: pos.clone(),
    vel: new Vector3(),
    quat: quat.clone(),
    angVel: new Vector3(),
    radius: 1,
    renderPrevPos: pos.clone(),
    renderPrevQuat: quat.clone(),
  };
}

export function makeShipRuntime(def: ShipDef, fuelScale = 1): ShipRuntime {
  return {
    def,
    hull: def.hull,
    armor: { ...def.armor },
    shield: { front: def.shield.front, rear: def.shield.rear },
    energy: def.energy,
    fuel: def.fuel * fuelScale,
    fuelMax: def.fuel * fuelScale,
    shieldDelay: 0,
    collisionCooldown: 0,
    gunCooldown: def.guns.map(() => 0),
    missiles: def.missiles.map((m): MissileSlot => ({ ...m })),
    activeMissile: 0,
    flares: def.flares,
    flareCooldown: 0,
    lockProgress: 0,
    lockedByEnemy: false,
    kills: 0,
    // 部位損傷は戦闘機だけが持つ (艦艇は砲塔単位の別モデルにするまで対象外)
    subsystems:
      def.role === 'fighter' || def.role === 'bomber' ? newSubsystems() : undefined,
  };
}

export interface SpawnShipOptions {
  def: ShipDef;
  faction: Faction;
  pos: Vector3;
  quat?: Quaternion;
  /** 初速 (未指定なら前方へ maxSpeed*0.5) */
  speed?: number;
  label?: string;
  tag?: string;
  pilot?: string;
  /** 砲を差し替える (ロードアウト用) */
  gunOverride?: string;
  /** 副兵装を差し替える */
  missileOverride?: MissileSlot[];
  /** フレアの搭載数を差し替える */
  flareOverride?: number;
  /** AI を載せる (プレイヤー機は指定しない) */
  ai?: AiRuntime;
  /** エース敵として強調表示する */
  ace?: boolean;
  /** アフターバーナー燃料の倍率 (難易度から渡す) */
  fuelScale?: number;
}

export function spawnShip(world: World, o: SpawnShipOptions): Entity {
  const quat = o.quat ?? new Quaternion();
  const e = baseEntity(world, 'ship', o.faction, o.pos, quat);
  e.radius = o.def.radius;
  e.label = o.label ?? o.def.name;
  if (o.tag) e.tag = o.tag;
  e.input = newInput();

  const rt = makeShipRuntime(o.def, o.fuelScale ?? 1);
  if (o.gunOverride) {
    rt.def = { ...o.def, guns: o.def.guns.map((g) => ({ ...g, gunId: o.gunOverride! })) };
    rt.gunCooldown = rt.def.guns.map(() => 0);
  }
  if (o.missileOverride) rt.missiles = o.missileOverride.map((m) => ({ ...m }));
  if (o.flareOverride !== undefined) rt.flares = Math.max(0, Math.floor(o.flareOverride));
  if (o.pilot) rt.pilot = o.pilot;
  if (o.ace) rt.ace = true;
  e.ship = rt;
  if (o.ai) e.ai = o.ai;

  const speed = o.speed ?? o.def.maxSpeed * 0.5;
  e.vel.set(0, 0, -1).applyQuaternion(quat).multiplyScalar(speed);
  e.input.throttle = Math.min(1, speed / o.def.maxSpeed);
  return world.add(e);
}

export interface SpawnProjectileOptions {
  gunId: string;
  pos: Vector3;
  dir: Vector3;
  /** 発射母機の速度を加算する */
  inheritVel?: Vector3;
  ownerId: number;
  ownerFaction: Faction;
  fromPlayer: boolean;
  damageScale?: number;
}

export function spawnProjectile(world: World, o: SpawnProjectileOptions): Entity {
  const gun = gunDef(o.gunId);
  const q = new Quaternion().setFromUnitVectors(new Vector3(0, 0, -1), o.dir.clone().normalize());
  const e = baseEntity(world, 'projectile', o.ownerFaction, o.pos, q);
  e.radius = 1.5;
  e.vel.copy(o.dir).normalize().multiplyScalar(gun.speed);
  if (o.inheritVel) e.vel.add(o.inheritVel);
  e.projectile = {
    gun,
    damage: gun.damage * (o.damageScale ?? 1),
    life: gun.life,
    ownerId: o.ownerId,
    ownerFaction: o.ownerFaction,
    fromPlayer: o.fromPlayer,
  };
  return world.add(e);
}

export interface SpawnMissileOptions {
  missileId: string;
  pos: Vector3;
  dir: Vector3;
  inheritVel?: Vector3;
  ownerId: number;
  ownerFaction: Faction;
  fromPlayer: boolean;
  targetId?: number;
  seekerOverride?: SeekerKind;
}

export function spawnMissile(world: World, o: SpawnMissileOptions): Entity {
  const def = missileDef(o.missileId);
  const q = new Quaternion().setFromUnitVectors(new Vector3(0, 0, -1), o.dir.clone().normalize());
  const e = baseEntity(world, 'missile', o.ownerFaction, o.pos, q);
  e.radius = 3;
  e.vel.copy(o.dir).normalize().multiplyScalar(def.speed * 0.5);
  if (o.inheritVel) e.vel.add(o.inheritVel);
  e.missile = {
    def,
    seeker: o.seekerOverride ?? def.seeker,
    life: def.life,
    ownerId: o.ownerId,
    ownerFaction: o.ownerFaction,
    fromPlayer: o.fromPlayer,
    targetId: o.targetId,
    armTime: 0.25,
  };
  e.label = def.name;
  return world.add(e);
}

export function spawnFlare(world: World, o: { pos: Vector3; vel: Vector3; faction: Faction }): Entity {
  const e = baseEntity(world, 'flare', o.faction, o.pos, new Quaternion());
  e.radius = 2;
  e.vel.copy(o.vel);
  e.label = 'FLARE';
  // life は projectile ランタイムを流用せず missile.life 的な扱いにする
  e.projectile = {
    gun: gunDef('laser'),
    damage: 0,
    life: 4,
    ownerId: -1,
    ownerFaction: o.faction,
    fromPlayer: false,
  };
  return world.add(e);
}

export interface SpawnRockOptions {
  pos: Vector3;
  radius: number;
  /** 漂う速度 */
  vel?: Vector3;
  variant?: number;
  seed?: number;
}

/**
 * 小惑星を置く。
 * 撃てば壊れ、ぶつかれば痛い。回避と戦闘の両立を強いるための障害物。
 */
export function spawnRock(world: World, o: SpawnRockOptions): Entity {
  const e = baseEntity(world, 'rock', 'neutral', o.pos, randomQuat(o.seed ?? o.pos.x));
  e.radius = o.radius;
  e.label = '小惑星';
  if (o.vel) e.vel.copy(o.vel);
  e.rock = {
    // 大きい岩は頑丈。小さい岩は一撃で砕ける
    hull: 30 + o.radius * o.radius * 0.09,
    variant: o.variant ?? Math.abs(Math.floor(o.pos.x + o.pos.z)) % 4,
    spin: new Vector3(
      (Math.sin(o.pos.x * 0.37) * 0.5) * 0.6,
      (Math.sin(o.pos.y * 0.53 + 1) * 0.5) * 0.6,
      (Math.sin(o.pos.z * 0.41 + 2) * 0.5) * 0.6,
    ),
  };
  return world.add(e);
}

/** 座標から決まる向き。岩をばらばらの角度で置くために使う */
function randomQuat(seed: number): Quaternion {
  const ax = new Vector3(
    Math.sin(seed * 0.31),
    Math.cos(seed * 0.17),
    Math.sin(seed * 0.53),
  );
  if (ax.lengthSq() < 1e-6) ax.set(0, 1, 0);
  ax.normalize();
  return new Quaternion().setFromAxisAngle(ax, seed * 0.7);
}

export interface SpawnMineOptions {
  pos: Vector3;
  ownerFaction: Faction;
  triggerRadius?: number;
  damage?: number;
  blastRadius?: number;
}

/** 機雷を敷設する。敷設側以外が近づくと起爆する */
export function spawnMine(world: World, o: SpawnMineOptions): Entity {
  const e = baseEntity(world, 'mine', 'neutral', o.pos, new Quaternion());
  e.radius = 6;
  e.label = '機雷';
  e.mine = {
    triggerRadius: o.triggerRadius ?? 150,
    damage: o.damage ?? 140,
    blastRadius: o.blastRadius ?? 190,
    fuse: 0.75,
    armed: false,
    ownerFaction: o.ownerFaction,
    hull: 12,
  };
  return world.add(e);
}

export function spawnNav(
  world: World,
  o: { index: number; name: string; pos: Vector3; arriveRadius?: number },
): Entity {
  const e = baseEntity(world, 'nav', 'neutral', o.pos, new Quaternion());
  e.radius = 0;
  e.label = o.name;
  e.nav = {
    index: o.index,
    name: o.name,
    arriveRadius: o.arriveRadius ?? 900,
    reached: false,
  };
  return world.add(e);
}
