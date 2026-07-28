import { Vector3, Quaternion } from "three";
import type { System } from "../../ecs/System";
import type { World } from "../../ecs/World";
import { Comp } from "../components";
import type { Transform, RigidBody, Missile, Decoy, ThrusterInput } from "../components";
import { isHostile } from "../factions";

const desiredDir = new Vector3();
const curDir = new Vector3();
const targetFwd = new Vector3();
const targetQuat = new Quaternion();
const fwdZ = new Vector3(0, 0, 1);
const tmpVec = new Vector3();

/** シーカー未指定 (旧ミサイル互換) のデフォルト挙動。heat 相当。 */
const DEFAULT_SEEKER: NonNullable<Missile["seeker"]> = "heat";
const DEFAULT_FLARE_SENSITIVITY = 0.7;
/** 画像認識(aspect)シーカーのロスト距離。 */
const ASPECT_LOSE_LOCK_RANGE = 4000;

/**
 * 誘導ミサイルの移動と誘導。ターゲット方向へ turnRate で旋回し、常に前方へ speed で進む。
 * ターゲットが消滅したら直進する。
 * シーカー種別 (none/heat/aspect) ごとに誘導・デコイ耐性の挙動が異なる。
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

      const seeker = m.seeker ?? DEFAULT_SEEKER;

      // 無誘導(dumbfire): 誘導・デコイ判定を一切行わず直進のみ。
      if (seeker === "none") {
        curDir.copy(fwdZ).applyQuaternion(t.quaternion).multiplyScalar(m.speed);
        rb.velocity.copy(curDir);
        t.position.addScaledVector(rb.velocity, dt);
        continue;
      }

      const flareSensitivity = m.flareSensitivity ?? (seeker === "heat" ? DEFAULT_FLARE_SENSITIVITY : 0.15);

      // デコイ吸着判定: 近傍の敵対デコイがあれば一定確率でターゲット変更。
      // 既存ターゲットが生存中でも、デコイに引き剥がされる可能性がある。
      const decoys = world.query(Comp.Decoy, Comp.Transform);
      for (const decoyEntity of decoys) {
        const decoy = world.getOrThrow<Decoy>(decoyEntity, Comp.Decoy);
        // デコイの陣営とミサイルの発射元が敵対関係にあるか。
        if (!isHostile(decoy.faction, m.sourceFaction)) continue;
        const dt_transform = world.getOrThrow<Transform>(decoyEntity, Comp.Transform);
        tmpVec.copy(dt_transform.position).sub(t.position);
        const distSq = tmpVec.lengthSq();
        // 距離 300 以内のデコイに対して時定数的に吸着判定。
        if (distSq < 300 * 300) {
          // 毎フレーム flareSensitivity の確率で引き剥がす (dt=0.016 基準で正規化)。
          // フレームレート非依存にするため dt を乗算した確率に。
          const prob = flareSensitivity * (dt / 0.016);
          if (Math.random() < prob) {
            m.target = decoyEntity;
            break; // 1フレーム1回まで。
          }
        }
      }

      // aspect(画像認識): 有効射程外に出たらロストする。
      if (
        seeker === "aspect" &&
        m.target !== null &&
        world.isAlive(m.target) &&
        world.has(m.target, Comp.Transform)
      ) {
        const tt = world.getOrThrow<Transform>(m.target, Comp.Transform);
        tmpVec.copy(tt.position).sub(t.position);
        if (tmpVec.lengthSq() > ASPECT_LOSE_LOCK_RANGE * ASPECT_LOSE_LOCK_RANGE) {
          m.target = null;
        }
      }

      // 誘導: ターゲットが生存していれば方向を補正。
      if (m.target !== null && world.isAlive(m.target) && world.has(m.target, Comp.Transform)) {
        const tt = world.getOrThrow<Transform>(m.target, Comp.Transform);
        desiredDir.copy(tt.position).sub(t.position);
        if (desiredDir.lengthSq() > 1e-6) {
          desiredDir.normalize();

          let effectiveTurnRate = m.turnRate;

          if (seeker === "heat") {
            // 後方有利ボーナス: ミサイル前方向とターゲット前方向の内積で接近角を評価。
            curDir.copy(fwdZ).applyQuaternion(t.quaternion);
            targetFwd.copy(fwdZ).applyQuaternion(tt.quaternion);
            const dot = curDir.dot(targetFwd);
            if (dot > 0.5) {
              // 背後から追尾 (両者が同方向を向いている) : 誘導性能アップ。
              effectiveTurnRate *= 1.4;
            } else if (dot < -0.3) {
              // 正面から接近: 誘導性能ダウン。
              effectiveTurnRate *= 0.6;
            }

            // アフターバーナー使用中は熱源が強く誘導しやすい。
            if (world.has(m.target, Comp.ThrusterInput)) {
              const targetInput = world.getOrThrow<ThrusterInput>(m.target, Comp.ThrusterInput);
              if (targetInput.afterburner) {
                effectiveTurnRate *= 1.2;
              }
            }
          } else if (seeker === "aspect") {
            // 画像認識: 接近角に関係なく安定した誘導、やや高精度。
            effectiveTurnRate *= 1.1;
          }

          curDir.copy(fwdZ).applyQuaternion(t.quaternion);
          // 現在方向から目標方向へ turnRate*dt だけ回す。
          targetQuat.setFromUnitVectors(fwdZ, desiredDir);
          const maxStep = effectiveTurnRate * dt;
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
