import type { System } from "../../ecs/System";
import type { World } from "../../ecs/World";
import type { EventBus } from "../../util/EventBus";
import type { VfxManager } from "../../render/VfxManager";

/**
 * weaponFired イベントを購読し、マズルフラッシュをマズル座標に発生させる。
 * 可変レート System (updateはno-op、イベント駆動のみ)。
 */
export class MuzzleFlashSystem implements System {
  readonly name = "MuzzleFlashSystem";

  constructor(
    events: EventBus,
    private readonly vfx: VfxManager,
  ) {
    events.on("weaponFired", (e) => {
      this.vfx.spawn("muzzleFlash", {
        position: e.muzzlePosition,
        direction: e.direction,
        kind: e.kind,
      });
    });
  }

  /** 可変レート更新スタブ (イベント駆動のみのため空実装)。 */
  update(_world: World, _dt: number): void {
    // イベント購読のみで完結するため何もしない。
  }
}
