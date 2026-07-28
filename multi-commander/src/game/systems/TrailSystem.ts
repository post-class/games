import type { System } from "../../ecs/System";
import type { World } from "../../ecs/World";
import type { VfxManager } from "../../render/VfxManager";
import { Comp } from "../components";
import type { Transform } from "../components";

/**
 * 弾とミサイルの軌跡(トレイル)を生成する。
 * 各弾/ミサイルの現在位置に定期的にトレイルPointsをspawnする。
 * 可変レート System。
 */
export class TrailSystem implements System {
  readonly name = "TrailSystem";
  /** トレイル生成の間引きカウンタ (毎フレームだと過剰なので適度に間引く)。 */
  private accumTime = 0;
  /** 弾トレイル生成間隔 (秒)。 */
  private readonly gunTrailInterval = 0.02;
  /** ミサイルトレイル生成間隔 (秒)。 */
  private readonly missileTrailInterval = 0.05;

  constructor(private readonly vfx: VfxManager) {}

  update(world: World, dt: number): void {
    this.accumTime += dt;
    // 間引き判定: 弾は20ms間隔、ミサイルは50ms間隔
    const shouldSpawnGun = this.accumTime >= this.gunTrailInterval;
    const shouldSpawnMissile = this.accumTime >= this.missileTrailInterval;
    if (!shouldSpawnGun && !shouldSpawnMissile) return;

    // 弾トレイル
    if (shouldSpawnGun) {
      for (const id of world.query(Comp.Projectile, Comp.Transform)) {
        const t = world.getOrThrow<Transform>(id, Comp.Transform);
        this.vfx.spawn("trail", { position: t.position, kind: "gun" });
      }
    }

    // ミサイルトレイル
    if (shouldSpawnMissile) {
      for (const id of world.query(Comp.Missile, Comp.Transform)) {
        const t = world.getOrThrow<Transform>(id, Comp.Transform);
        this.vfx.spawn("trail", { position: t.position, kind: "missile" });
      }
    }

    // 累積時間リセット
    if (this.accumTime >= this.missileTrailInterval) {
      this.accumTime = 0;
    }
  }
}
