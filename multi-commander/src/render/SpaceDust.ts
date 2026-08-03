import {
  BufferAttribute,
  BufferGeometry,
  LineBasicMaterial,
  LineSegments,
  Vector3,
  type Scene,
} from 'three';
import { Rng } from '../core/rng';
import type { Entity } from '../world/entity';

/** 塵を配置する立方体の半辺長 */
const FIELD = 340;
/** 粒の数 */
const COUNT = 260;

const _v = new Vector3();

/**
 * 宇宙塵。
 *
 * 何も無い空間では速度が分からないので、自機の周囲に細かい粒を漂わせ、
 * 速度に応じて線分に伸ばす。速いほど長い筋になり、止まれば点に戻る。
 * 自機を中心とした立方体の中で位置を折り返すので、無限に続いて見える。
 */
export class SpaceDust {
  private geo = new BufferGeometry();
  private positions: Float32Array;
  private points: Float32Array;
  private mesh: LineSegments;
  private center = new Vector3();
  private initialized = false;
  /** ジャンプ演出の強さ (0..1)。塵を長い筋に伸ばす */
  private warp = 0;
  private mat: LineBasicMaterial;

  constructor(scene: Scene) {
    // 線分1本 = 2頂点
    this.positions = new Float32Array(COUNT * 6);
    this.points = new Float32Array(COUNT * 3);
    const rng = new Rng(0x51a7e1);
    for (let i = 0; i < COUNT; i++) {
      this.points[i * 3] = rng.signed(FIELD);
      this.points[i * 3 + 1] = rng.signed(FIELD);
      this.points[i * 3 + 2] = rng.signed(FIELD);
    }
    this.geo.setAttribute('position', new BufferAttribute(this.positions, 3));
    this.mat = new LineBasicMaterial({
      color: 0x9fb4c8,
      transparent: true,
      opacity: 0.26,
      depthWrite: false,
    });
    this.mesh = new LineSegments(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  setVisible(v: boolean): void {
    this.mesh.visible = v;
  }

  /**
   * ジャンプ演出。
   * オートパイロットは実際には毎秒数千単位で移動するが、
   * 自機の速度ベクトルは巡航速度のままなので、そのままでは筋が伸びない。
   * ここで明示的に伸ばして「星が流れる」絵を作る。
   */
  setWarp(v: number): void {
    this.warp = Math.max(0, Math.min(1, v));
    this.mat.opacity = 0.26 + this.warp * 0.55;
    this.mat.color.setHex(this.warp > 0.5 ? 0xcfe4ff : 0x9fb4c8);
  }

  /** 自機を中心に塵を巻き取り、速度方向へ伸ばす */
  update(player: Entity | undefined): void {
    if (!player) {
      this.mesh.visible = false;
      return;
    }
    const p = player.pos;
    if (!this.initialized) {
      this.center.copy(p);
      this.initialized = true;
    }

    // 中心から離れた粒は反対側へ折り返す
    const dx = p.x - this.center.x;
    const dy = p.y - this.center.y;
    const dz = p.z - this.center.z;
    this.center.copy(p);

    // 速度に応じた尾の長さ。停止時は点に見えるくらい短く
    const speed = player.vel.length();
    // 進行方向の逆へ伸ばす (自機の横を流れていくように見せる)
    const tail = Math.min(17, speed * 0.04) + this.warp * 320;
    _v.copy(player.vel);
    if (speed > 1e-3) _v.multiplyScalar(-tail / speed);
    else _v.set(0, 0, 0);

    const pts = this.points;
    const pos = this.positions;
    for (let i = 0; i < COUNT; i++) {
      const i3 = i * 3;
      // 自機の移動ぶんだけ相対位置をずらす
      let x = pts[i3] - dx;
      let y = pts[i3 + 1] - dy;
      let z = pts[i3 + 2] - dz;
      // 立方体の外に出たら反対側へ
      if (x > FIELD) x -= FIELD * 2;
      else if (x < -FIELD) x += FIELD * 2;
      if (y > FIELD) y -= FIELD * 2;
      else if (y < -FIELD) y += FIELD * 2;
      if (z > FIELD) z -= FIELD * 2;
      else if (z < -FIELD) z += FIELD * 2;
      pts[i3] = x;
      pts[i3 + 1] = y;
      pts[i3 + 2] = z;

      const i6 = i * 6;
      pos[i6] = p.x + x;
      pos[i6 + 1] = p.y + y;
      pos[i6 + 2] = p.z + z;
      pos[i6 + 3] = p.x + x + _v.x;
      pos[i6 + 4] = p.y + y + _v.y;
      pos[i6 + 5] = p.z + z + _v.z;
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.computeBoundingSphere();
  }
}
