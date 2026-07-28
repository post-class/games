import { Vector3 } from "three";
import type { System } from "../../ecs/System";
import type { World } from "../../ecs/World";
import { Comp } from "../components";
import type { Transform, RigidBody, FlightModel, ThrusterInput } from "../components";
import { PHYSICS } from "../../config/physicsConfig";
import { clamp, clampLength, dampFactor, integrateOrientation } from "../../util/math";

const forwardDir = new Vector3();
const desiredVel = new Vector3();
const thrustLocal = new Vector3();
const thrustWorld = new Vector3();
const accel = new Vector3();

/**
 * 飛行モデル。固定dtで積分する。姿勢はクォータニオン。
 * flightAssist で2つの操作モードを切り替える:
 * - true  = WCアーケード方式: 速度ベクトルが機首方向へ追従する ("向いた方向へ飛ぶ")。
 *           スロットルで目標速度を指定し、旋回すると速度も新しい機首方向へ振れる。
 * - false = ニュートン純慣性: 機体ローカル推力を積分。推力を切っても等速直線運動を続ける。
 * 角運動は両モード共通 (トルク積分 + 無入力軸の減衰でキビキビ止まる)。
 */
export class FlightModelSystem implements System {
  readonly name = "FlightModelSystem";

  update(world: World, dt: number): void {
    const entities = world.query(
      Comp.Transform,
      Comp.RigidBody,
      Comp.FlightModel,
      Comp.ThrusterInput,
    );

    for (const entity of entities) {
      const t = world.getOrThrow<Transform>(entity, Comp.Transform);
      const rb = world.getOrThrow<RigidBody>(entity, Comp.RigidBody);
      const fm = world.getOrThrow<FlightModel>(entity, Comp.FlightModel);
      const ti = world.getOrThrow<ThrusterInput>(entity, Comp.ThrusterInput);

      // 前フレーム値を保存 (描画補間用)。
      t.prevPosition.copy(t.position);
      t.prevQuaternion.copy(t.quaternion);

      // --- 角運動 (両モード共通) ---
      // トルク = 入力 * 最大トルク。角加速度 = トルク / 慣性。
      // ピッチ(x軸)は「+入力=機首上げ」の規約に合わせて符号を反転する
      // (機体+x軸まわりの正回転は幾何的に機首を下げるため)。
      rb.angularVelocity.x += (-ti.angular.x * fm.angularThrust.x / rb.inertia.x) * dt;
      rb.angularVelocity.y += (ti.angular.y * fm.angularThrust.y / rb.inertia.y) * dt;
      rb.angularVelocity.z += (ti.angular.z * fm.angularThrust.z / rb.inertia.z) * dt;

      // 無入力の軸は減衰させ、キー/操作を離すと旋回が素早く止まる (WCのキビキビ感)。
      const af = dampFactor(fm.angularDamping, dt);
      if (Math.abs(ti.angular.x) < 1e-3) rb.angularVelocity.x *= af;
      if (Math.abs(ti.angular.y) < 1e-3) rb.angularVelocity.y *= af;
      if (Math.abs(ti.angular.z) < 1e-3) rb.angularVelocity.z *= af;
      clampLength(rb.angularVelocity, PHYSICS.maxAngularSpeed);

      integrateOrientation(t.quaternion, rb.angularVelocity, dt);

      // --- 並進 ---
      const abActive = ti.afterburner;
      if (fm.flightAssist) {
        // WCアーケード: 機首方向 × 目標速度 へ速度を追従させる。
        const throttle = clamp(ti.linear.z, 0, 1);
        const targetSpeed = abActive ? fm.afterburnerMaxSpeed : fm.maxLinearSpeed * throttle;
        forwardDir.set(0, 0, 1).applyQuaternion(t.quaternion);
        desiredVel.copy(forwardDir).multiplyScalar(targetSpeed);
        // フレームレート非依存の指数追従。AB時はより機敏に。
        const rate = abActive ? PHYSICS.arcadeAfterburnerResponse : PHYSICS.arcadeVelResponse;
        rb.velocity.lerp(desiredVel, 1 - Math.exp(-rate * dt));
      } else {
        // ニュートン: 機体ローカル推力を積分。純慣性。
        const thrustScale = abActive ? 1.8 : 1;
        thrustLocal.set(
          ti.linear.x * fm.linearThrust.x,
          ti.linear.y * fm.linearThrust.y,
          ti.linear.z * fm.linearThrust.z * thrustScale,
        );
        thrustWorld.copy(thrustLocal).applyQuaternion(t.quaternion);
        accel.copy(thrustWorld).divideScalar(rb.mass);
        rb.velocity.addScaledVector(accel, dt);
        clampLength(rb.velocity, fm.afterburnerMaxSpeed * PHYSICS.assistOffSpeedMultiplier);
      }

      t.position.addScaledVector(rb.velocity, dt);
    }
  }
}
