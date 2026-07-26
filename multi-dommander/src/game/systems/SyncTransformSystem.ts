import type { System } from "../../ecs/System";
import type { World } from "../../ecs/World";
import { Comp } from "../components";
import type { Transform, Renderable } from "../components";

/**
 * ECS Transform を Three.js Object3D に反映する (可変レート系)。
 * alpha で前フレームと現フレームを補間し、固定60Hz物理でも滑らかに描画する。
 */
export class SyncTransformSystem implements System {
  readonly name = "SyncTransformSystem";

  update(world: World, _dt: number, alpha: number): void {
    const entities = world.query(Comp.Transform, Comp.Renderable);
    for (const entity of entities) {
      const t = world.getOrThrow<Transform>(entity, Comp.Transform);
      const r = world.getOrThrow<Renderable>(entity, Comp.Renderable);
      // 位置: 線形補間。
      r.object.position.lerpVectors(t.prevPosition, t.position, alpha);
      // 姿勢: 球面線形補間。
      r.object.quaternion.copy(t.prevQuaternion).slerp(t.quaternion, alpha);
    }
  }
}
