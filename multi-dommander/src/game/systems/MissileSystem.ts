import { Vector3, Quaternion } from "three";
import type { System } from "../../ecs/System";
import type { World } from "../../ecs/World";
import { Comp } from "../components";
import type { Transform, RigidBody, Missile } from "../components";

const desiredDir = new Vector3();
const curDir = new Vector3();
const targetQuat = new Quaternion();
const fwdZ = new Vector3(0, 0, 1);

/**
 * 誘導ミサイルの移動と誘導。ターゲット方向へ turnRate で旋回し、常に前方へ speed で進む。
 * ターゲットが消滅したら直進する。
 */
export class MissileSystem implements System {
  readonly name = "MissileSystem";

  update(world: World, dt: number): void {
    const missiles = world.query(Comp.Missile, Comp.Transform, Comp.RigidBody);
    for (const entity of missiles) {
      const m = world.getOrThrow<Missile>(entity, Comp.Missile);
      const t = world.getOrThrow<Transform>(entity, Comp.Transform);
      const rb = world.getOrThrow<RigidBody>(entity, Comp.RigidBody);
      t.prevPosition.copy(t.position);
      t.prevQuaternion.copy(t.quaternion);

      // 誘導: ターゲットが生存していれば方向を補正。
      if (m.target !== null && world.isAlive(m.target) && world.has(m.target, Comp.Transform)) {
        const tt = world.getOrThrow<Transform>(m.target, Comp.Transform);
        desiredDir.copy(tt.position).sub(t.position);
        if (desiredDir.lengthSq() > 1e-6) {
          desiredDir.normalize();
          curDir.copy(fwdZ).applyQuaternion(t.quaternion);
          // 現在方向から目標方向へ turnRate*dt だけ回す。
          targetQuat.setFromUnitVectors(fwdZ, desiredDir);
          const maxStep = m.turnRate * dt;
          t.quaternion.rotateTowards(targetQuat, maxStep);
        }
      }

      // 常に機首方向へ進む。
      curDir.copy(fwdZ).applyQuaternion(t.quaternion).multiplyScalar(m.speed);
      rb.velocity.copy(curDir);
      t.position.addScaledVector(rb.velocity, dt);
    }
  }
}
