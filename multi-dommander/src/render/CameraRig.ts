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

/**
 * プレイヤー機を追従するチェイスカメラ (可変レート系)。
 * 機体後方やや上から追い、機首前方を見る。速度に応じて後退しダイナミックさを出す。
 */
export class CameraRig implements System {
  readonly name = "CameraRig";
  private initialized = false;

  constructor(
    private readonly camera: PerspectiveCamera,
    private readonly getPlayer: () => EntityId | null,
    /** 追従の追随速度 (大きいほど機敏)。 */
    private readonly stiffness = 6,
  ) {}

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

    // 機首前方を注視。
    lookTarget.set(0, 2, 60).applyQuaternion(obj.quaternion).add(obj.position);
    this.camera.lookAt(lookTarget);
  }
}
