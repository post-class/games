import type { System } from "../../ecs/System";
import type { World } from "../../ecs/World";
import { Comp } from "../components";
import type { Transform, RigidBody, Lifetime } from "../components";

/**
 * 弾 (Projectile) を直線移動させ、Lifetime を減衰させて寿命切れを破棄する。
 * ミサイルの移動は MissileSystem が担当する。
 */
export class ProjectileSystem implements System {
  readonly name = "ProjectileSystem";

  update(world: World, dt: number): void {
    const projectiles = world.query(Comp.Projectile, Comp.Transform, Comp.RigidBody);
    for (const entity of projectiles) {
      const t = world.getOrThrow<Transform>(entity, Comp.Transform);
      const rb = world.getOrThrow<RigidBody>(entity, Comp.RigidBody);
      t.prevPosition.copy(t.position);
      t.position.addScaledVector(rb.velocity, dt);
    }

    // 全 Lifetime を減算 (弾・ミサイル・エフェクト共通)。
    const timed = world.query(Comp.Lifetime);
    for (const entity of timed) {
      const life = world.getOrThrow<Lifetime>(entity, Comp.Lifetime);
      life.remaining -= dt;
      if (life.remaining <= 0) world.destroyEntity(entity);
    }
  }
}
