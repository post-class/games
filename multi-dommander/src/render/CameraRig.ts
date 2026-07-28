import { Vector3, type PerspectiveCamera } from "three";
import type { System } from "../ecs/System";
import type { World } from "../ecs/World";
import type { EntityId } from "../ecs/Entity";
import { Comp } from "../game/components";
import type { Renderable } from "../game/components";
import { clamp } from "../util/math";

const desiredPos = new Vector3();
const lookTarget = new Vector3();
const offsetLocal = new Vector3();
const shakeOffset = new Vector3();

/**
 * プレイヤー機を追従するチェイスカメラ (可変レート系)。
 * 機体後方やや上から追い、機首前方を見る。速度に応じて後退しダイナミックさを出す。
 */
export class CameraRig implements System {
  readonly name = "CameraRig";
  private initialized = false;
  private readonly baseFov: number;
  private shakeTrauma = 0;
  private fovOffset = 0;

  constructor(
    private readonly camera: PerspectiveCamera,
    private readonly getPlayer: () => EntityId | null,
    /** 追従の追随速度 (大きいほど機敏)。 */
    private readonly stiffness = 6,
  ) {
    this.baseFov = camera.fov;
  }

  /**
   * カメラシェイクを追加する。被弾・撃墜などの衝撃を伝える演出用。
   * @param intensity 0..1 のトラウマ値。複数回呼ぶと加算され上限1にクランプされる。
   */
  addShake(intensity: number): void {
    this.shakeTrauma = Math.min(1, this.shakeTrauma + intensity);
  }

  /**
   * FOVキックを追加する。被弾・撃墜・AB発動時などの速度感強調用。
   * @param amount FOVへの加算値(度数)。正で視野が広がり、負で狭まる。
   */
  kickFov(amount: number): void {
    this.fovOffset += amount;
  }

  update(world: World, dt: number): void {
    const player = this.getPlayer();
    if (player === null || !world.isAlive(player) || !world.has(player, Comp.Renderable)) return;
    const obj = world.getOrThrow<Renderable>(player, Comp.Renderable).object;

    // 機体ローカルの後方・上方オフセット。
    offsetLocal.set(0, 7, -34);
    desiredPos.copy(offsetLocal).applyQuaternion(obj.quaternion).add(obj.position);

    if (!this.initialized) {
      this.camera.position.copy(desiredPos);
      this.initialized = true;
    } else {
      const t = clamp(this.stiffness * dt, 0, 1);
      this.camera.position.lerp(desiredPos, t);
    }

    // カメラシェイク: lookAt 前に位置オフセットを加算。
    this.shakeTrauma = Math.max(0, this.shakeTrauma - dt * 2.5);
    if (this.shakeTrauma > 0.001) {
      const shakeAmt = this.shakeTrauma ** 2;
      const K = 1.5;
      shakeOffset.set(
        (Math.random() - 0.5) * shakeAmt * K,
        (Math.random() - 0.5) * shakeAmt * K,
        (Math.random() - 0.5) * shakeAmt * K,
      );
      this.camera.position.add(shakeOffset);
    }

    // 機首前方を注視。
    lookTarget.set(0, 2, 60).applyQuaternion(obj.quaternion).add(obj.position);
    this.camera.lookAt(lookTarget);

    // FOVキック: 減衰してから適用。ほぼ0のときは updateProjectionMatrix をスキップ。
    this.fovOffset *= Math.max(0, 1 - dt * 6);
    if (Math.abs(this.fovOffset) > 0.01) {
      this.camera.fov = this.baseFov + this.fovOffset;
      this.camera.updateProjectionMatrix();
    }
  }
}
