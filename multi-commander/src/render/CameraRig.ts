import { Quaternion, Vector3, type PerspectiveCamera } from 'three';
import { clamp, damp, forwardOf, upOf } from '../core/math';
import { rng } from '../core/rng';
import type { Entity } from '../world/entity';

export type ViewMode = 'cockpit' | 'chase';

const BASE_FOV = 70;

/**
 * カメラ制御。コクピット視点 (既定) と追尾視点を切り替える。
 * 被弾やアフターバーナーで揺れ・FOV キックを入れて速度感を出す。
 */
/** メッシュの前方基準 */
const FORWARD = new Vector3(0, 0, -1);

export class CameraRig {
  mode: ViewMode = 'cockpit';
  private shake = 0;
  private fovKick = 0;
  private warpFov = 0;
  private smoothedChasePos = new Vector3();
  private initialized = false;

  /** 撃墜演出でカメラを向けたい点 */
  private focusPos?: Vector3;
  private focusLeft = 0;
  private focusTotal = 0;

  private tmpQ = new Quaternion();
  private tmpV = new Vector3();
  private tmpV2 = new Vector3();

  constructor(private camera: PerspectiveCamera) {}

  toggle(): ViewMode {
    this.mode = this.mode === 'cockpit' ? 'chase' : 'cockpit';
    this.initialized = false;
    return this.mode;
  }

  addShake(strength: number): void {
    this.shake = Math.min(1.4, this.shake + strength);
  }

  /**
   * 指定した点を一時的に注視する (撃墜演出)。
   * 完全に奪わず、機首方向との間を補間するので操作感は残る。
   */
  focusOn(pos: Vector3, seconds: number): void {
    this.focusPos = pos.clone();
    this.focusLeft = seconds;
    this.focusTotal = seconds;
  }

  clearFocus(): void {
    this.focusPos = undefined;
    this.focusLeft = 0;
  }

  /**
   * ジャンプ演出の画角の追加分。
   * FOV はここで一括して決めるので、外から直接 camera.fov を触ると打ち消される。
   */
  setWarpFov(extra: number): void {
    this.warpFov = extra;
  }

  kickFov(amount: number): void {
    this.fovKick = clamp(this.fovKick + amount, -8, 16);
  }

  /** dtReal で呼ぶ (描画フレーム) */
  update(target: Entity | undefined, dt: number, abActive: boolean): void {
    if (!target) return;
    const q = target.quat;

    if (abActive) this.kickFov(28 * dt);
    this.fovKick = damp(this.fovKick, 0, 0.18, dt);
    this.shake = damp(this.shake, 0, 0.12, dt);

    if (this.mode === 'cockpit') {
      // 目の位置: 機体前方やや上
      const eye = this.tmpV.set(0, target.radius * 0.11 + 0.6, -target.radius * 0.28);
      eye.applyQuaternion(q).add(target.pos);
      this.camera.position.copy(eye);
      this.camera.quaternion.copy(q);
    } else {
      const back = forwardOf(q, this.tmpV).multiplyScalar(-target.radius * 4.2);
      const up = upOf(q, this.tmpV2).multiplyScalar(target.radius * 1.15);
      const want = back.add(up).add(target.pos);
      if (!this.initialized) {
        this.smoothedChasePos.copy(want);
        this.initialized = true;
      } else {
        this.smoothedChasePos.lerp(want, 1 - Math.pow(0.5, dt / 0.06));
      }
      this.camera.position.copy(this.smoothedChasePos);
      this.camera.quaternion.slerp(q, 1 - Math.pow(0.5, dt / 0.05));
      this.camera.lookAt(target.pos);
    }
    this.initialized = true;

    if (this.shake > 0.001) {
      const s = this.shake * this.shake * 1.6;
      this.tmpQ.set(rng.signed(0.012 * s), rng.signed(0.012 * s), rng.signed(0.012 * s), 1).normalize();
      this.camera.quaternion.multiply(this.tmpQ);
      this.camera.position.add(
        this.tmpV.set(rng.signed(s * 0.5), rng.signed(s * 0.5), rng.signed(s * 0.5)),
      );
    }

    // 撃墜演出: 爆発の方へ視線を寄せる
    if (this.focusPos && this.focusLeft > 0) {
      this.focusLeft -= dt;
      // 立ち上がりと終わりを緩やかにする
      const t = 1 - this.focusLeft / Math.max(0.001, this.focusTotal);
      const w = Math.min(1, Math.min(t, 1 - t) * 5) * 0.8;
      if (this.focusLeft <= 0) {
        this.focusPos = undefined;
      } else if (w > 0.001) {
        this.tmpV.copy(this.focusPos).sub(this.camera.position);
        if (this.tmpV.lengthSq() > 1e-6) {
          this.tmpQ.setFromUnitVectors(FORWARD, this.tmpV.normalize());
          this.camera.quaternion.slerp(this.tmpQ, w);
        }
      }
    }

    const fov = BASE_FOV + this.fovKick + this.warpFov;
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }
}
