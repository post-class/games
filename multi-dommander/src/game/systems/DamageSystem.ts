import type { System } from "../../ecs/System";
import type { World } from "../../ecs/World";
import type { EntityId } from "../../ecs/Entity";
import { Comp, Faction } from "../components";
import type { Health, Transform } from "../components";
import type { EventBus } from "../../util/EventBus";

/**
 * ダメージを shield -> armor -> hull の順に適用する純関数。
 * 破壊されたら destroyed=true。
 */
export function applyDamage(health: Health, amount: number, now: number): { destroyed: boolean } {
  health.lastHitTime = now;
  let remaining = amount;
  if (health.shield > 0) {
    const absorbed = Math.min(health.shield, remaining);
    health.shield -= absorbed;
    remaining -= absorbed;
  }
  if (remaining > 0 && health.armor > 0) {
    const absorbed = Math.min(health.armor, remaining);
    health.armor -= absorbed;
    remaining -= absorbed;
  }
  if (remaining > 0) health.hull -= remaining;
  return { destroyed: health.hull <= 0 };
}

/**
 * 毎フレームのシールド再生と、撃墜判定を行う。
 * 実際の被弾ダメージは CollisionSystem が applyDamage 経由で適用する。
 */
export class DamageSystem implements System {
  readonly name = "DamageSystem";

  constructor(
    private readonly events: EventBus,
    private readonly getSimTime: () => number,
  ) {}

  update(world: World, dt: number): void {
    const now = this.getSimTime();
    const entities = world.query(Comp.Health, Comp.Transform);
    for (const entity of entities) {
      const h = world.getOrThrow<Health>(entity, Comp.Health);

      // 撃墜判定。
      if (h.hull <= 0) {
        this.destroy(world, entity);
        continue;
      }

      // シールド再生 (無被弾時間が閾値を超えたら)。
      if (h.shield < h.shieldMax && now - h.lastHitTime >= h.shieldRegenDelay) {
        h.shield = Math.min(h.shieldMax, h.shield + h.shieldRegenRate * dt);
      }
    }
  }

  private destroy(world: World, entity: EntityId): void {
    // 呼び出し元が Transform 保有をクエリ済み。
    const t = world.getOrThrow<Transform>(entity, Comp.Transform);
    const faction = world.get<Faction>(entity, Comp.Faction) ?? Faction.Neutral;
    this.events.emit("destroyed", {
      entity,
      position: t.position.clone(),
      faction,
    });
    world.destroyEntity(entity);
  }
}
