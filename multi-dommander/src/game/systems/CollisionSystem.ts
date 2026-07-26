import { Vector3 } from "three";
import type { System } from "../../ecs/System";
import type { World } from "../../ecs/World";
import { Comp, Faction } from "../components";
import type { Transform, Health, Collider, Projectile, Missile } from "../components";
import { applyDamage } from "./DamageSystem";
import type { EventBus } from "../../util/EventBus";

const seg = new Vector3();
const toCenter = new Vector3();
const closest = new Vector3();

/**
 * 線分(前フレーム位置->現在位置)と球の交差判定。高速弾のすり抜け対策。
 * ヒットすれば true。
 */
export function segmentSphereHit(
  p0: Vector3,
  p1: Vector3,
  center: Vector3,
  radius: number,
): boolean {
  seg.copy(p1).sub(p0);
  const segLenSq = seg.lengthSq();
  if (segLenSq < 1e-9) {
    return p0.distanceToSquared(center) <= radius * radius;
  }
  toCenter.copy(center).sub(p0);
  let t = toCenter.dot(seg) / segLenSq;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  closest.copy(p0).addScaledVector(seg, t);
  return closest.distanceToSquared(center) <= radius * radius;
}

/**
 * 弾/ミサイルと Health 保有エンティティの衝突を総当たりで判定し、ダメージを適用する。
 * エンティティ数が少ない前提 (O(n*m))。
 */
export class CollisionSystem implements System {
  readonly name = "CollisionSystem";

  constructor(
    private readonly events: EventBus,
    private readonly getSimTime: () => number,
  ) {}

  update(world: World, _dt: number): void {
    const targets = world.query(Comp.Transform, Comp.Health, Comp.Collider, Comp.Faction);
    if (targets.length === 0) return;
    const now = this.getSimTime();

    // --- エネルギー砲 (線分スイープ) ---
    const projectiles = world.query(Comp.Projectile, Comp.Transform);
    for (const proj of projectiles) {
      if (!world.isAlive(proj)) continue;
      const pt = world.getOrThrow<Transform>(proj, Comp.Transform);
      const p = world.getOrThrow<Projectile>(proj, Comp.Projectile);
      for (const target of targets) {
        if (target === p.source) continue;
        const tf = world.get<Faction>(target, Comp.Faction);
        if (tf === p.sourceFaction) continue;
        const tt = world.getOrThrow<Transform>(target, Comp.Transform);
        const col = world.getOrThrow<Collider>(target, Comp.Collider);
        if (segmentSphereHit(pt.prevPosition, pt.position, tt.position, col.radius)) {
          this.hit(world, target, proj, p.source, p.damage, tt.position, now);
          world.destroyEntity(proj);
          break;
        }
      }
    }

    // --- ミサイル (球判定) ---
    const missiles = world.query(Comp.Missile, Comp.Transform, Comp.Collider);
    for (const mis of missiles) {
      if (!world.isAlive(mis)) continue;
      const mt = world.getOrThrow<Transform>(mis, Comp.Transform);
      const m = world.getOrThrow<Missile>(mis, Comp.Missile);
      const mcol = world.getOrThrow<Collider>(mis, Comp.Collider);
      for (const target of targets) {
        if (target === m.source) continue;
        const tf = world.get<Faction>(target, Comp.Faction);
        if (tf === m.sourceFaction) continue;
        const tt = world.getOrThrow<Transform>(target, Comp.Transform);
        const col = world.getOrThrow<Collider>(target, Comp.Collider);
        const r = col.radius + mcol.radius;
        if (segmentSphereHit(mt.prevPosition, mt.position, tt.position, r)) {
          this.hit(world, target, mis, m.source, m.damage, tt.position, now);
          world.destroyEntity(mis);
          break;
        }
      }
    }
  }

  private hit(
    world: World,
    target: number,
    _projectile: number,
    source: number,
    damage: number,
    position: Vector3,
    now: number,
  ): void {
    const health = world.getOrThrow<Health>(target, Comp.Health);
    applyDamage(health, damage, now);
    this.events.emit("hit", { target, source, damage, position: position.clone() });
  }
}
