import {
  AdditiveBlending,
  CanvasTexture,
  CircleGeometry,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  Quaternion,
  Vector3,
  type Material,
  type Texture,
} from 'three';
import { Rng } from '../core/rng';
import type { Entity } from '../world/entity';

/**
 * 船体に残る戦闘の痕。
 *
 * 煙 (`Vfx.damageSmoke`) は「今壊れている」ことしか伝えない。
 * 焼け跡は消えないので「もう殴られた機体だ」と一目で分かり、
 * 帰投した自機を外部視点で見たときに、その出撃の記録として残る。
 *
 * 実体ごとに機体メッシュの子として貼る。テンプレートは共有なので焼き込めない。
 * 位置は entity id を種にした固定乱数なので、同じ機体なら毎回同じ場所が焦げる。
 */

const FORWARD = new Vector3(0, 0, 1);
const _q = new Quaternion();

/** 最大の焼け跡数。増やしすぎると面が黒く埋まる */
const MAX_MARKS = 6;

let scorchTex: Texture | undefined;
let emberTex: Texture | undefined;

/** 縁がぼやけた黒い染み */
function makeScorch(): Texture {
  const size = 128;
  const cv = document.createElement('canvas');
  cv.width = size;
  cv.height = size;
  const g = cv.getContext('2d')!;
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(8, 6, 5, 0.95)');
  grad.addColorStop(0.45, 'rgba(22, 16, 12, 0.75)');
  grad.addColorStop(0.78, 'rgba(30, 22, 16, 0.3)');
  grad.addColorStop(1, 'rgba(30, 22, 16, 0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  // 飛び散った煤
  g.fillStyle = 'rgba(10, 8, 6, 0.5)';
  for (let i = 0; i < 26; i++) {
    const a = (i / 26) * Math.PI * 2;
    const r = size * (0.3 + ((i * 37) % 20) / 100);
    const x = size / 2 + Math.cos(a) * r;
    const y = size / 2 + Math.sin(a) * r;
    g.beginPath();
    g.arc(x, y, size * 0.02 + ((i * 13) % 5) * 0.4, 0, Math.PI * 2);
    g.fill();
  }
  return new CanvasTexture(cv);
}

/** 中心が明るいオレンジの染み。焼け跡の中で燃えている部分 */
function makeEmber(): Texture {
  const size = 64;
  const cv = document.createElement('canvas');
  cv.width = size;
  cv.height = size;
  const g = cv.getContext('2d')!;
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(255, 220, 150, 0.95)');
  grad.addColorStop(0.35, 'rgba(255, 130, 40, 0.7)');
  grad.addColorStop(1, 'rgba(180, 50, 10, 0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return new CanvasTexture(cv);
}

interface Mark {
  scorch: Mesh;
  ember: Mesh;
  /** 点滅の位相 */
  phase: number;
}

/** 1機ぶんの傷。機体メッシュの子として保持する */
export class BattleDamage {
  private marks: Mark[] = [];
  private shown = 0;
  private radius: number;

  constructor(parent: Object3D, e: Entity) {
    this.radius = e.radius;
    scorchTex ??= makeScorch();
    emberTex ??= makeEmber();

    // 実体 id を種にすると、同じ機体では同じ場所が焦げる
    const rng = new Rng(e.id * 2654435761 + 7);
    const geo = new CircleGeometry(1, 12);

    for (let i = 0; i < MAX_MARKS; i++) {
      // 機体を包む球面上の点。そこから外向きに貼る
      const dir = new Vector3(rng.signed(1), rng.signed(0.7), rng.signed(1));
      if (dir.lengthSq() < 1e-4) dir.set(0, 1, 0);
      dir.normalize();
      const at = dir.clone().multiplyScalar(e.radius * 0.82);
      _q.setFromUnitVectors(FORWARD, dir);

      const size = e.radius * rng.range(0.26, 0.5);
      const scorch = new Mesh(
        geo,
        new MeshBasicMaterial({
          map: scorchTex,
          transparent: true,
          opacity: 0,
          depthWrite: false,
        }),
      );
      scorch.position.copy(at);
      scorch.quaternion.copy(_q);
      scorch.scale.setScalar(size);
      scorch.visible = false;
      scorch.renderOrder = 1;
      parent.add(scorch);

      const ember = new Mesh(
        geo,
        new MeshBasicMaterial({
          map: emberTex,
          transparent: true,
          opacity: 0,
          blending: AdditiveBlending,
          depthWrite: false,
        }),
      );
      // 焦げの中心よりわずかに外へ出して、焼け跡の上で光らせる
      ember.position.copy(dir).multiplyScalar(e.radius * 0.85);
      ember.quaternion.copy(_q);
      ember.scale.setScalar(size * 0.34);
      ember.visible = false;
      ember.renderOrder = 2;
      parent.add(ember);

      this.marks.push({ scorch, ember, phase: rng.range(0, 6.283) });
    }
  }

  /**
   * 残ハル率に応じて痕を増やす。
   * 一度出した痕は消さない (修理は母艦で行われる ＝ 次の出撃で新しいメッシュになる)。
   */
  update(e: Entity, time: number): void {
    const ship = e.ship;
    if (!ship) return;
    const ratio = ship.hull / Math.max(1, ship.def.hull);
    // 80% を切ってから、20% でほぼ全部
    const want = Math.round(Math.max(0, Math.min(1, (0.82 - ratio) / 0.62)) * MAX_MARKS);
    if (want > this.shown) this.shown = want;

    for (let i = 0; i < this.marks.length; i++) {
      const m = this.marks[i];
      const on = i < this.shown;
      if (m.scorch.visible !== on) {
        m.scorch.visible = on;
        m.ember.visible = on;
      }
      if (!on) continue;
      (m.scorch.material as MeshBasicMaterial).opacity = 1;
      // 深い損傷ほど強く、不規則に揺らぐ。明るくしすぎると一面オレンジに潰れる
      const heat = Math.min(0.75, Math.max(0, 0.5 - ratio) * 1.5);
      const flicker = 0.55 + Math.sin(time * 7 + m.phase) * 0.25 + Math.sin(time * 17 + m.phase) * 0.2;
      (m.ember.material as MeshBasicMaterial).opacity = Math.max(0, heat * flicker);
    }
    void this.radius;
  }

  dispose(): void {
    for (const m of this.marks) {
      m.scorch.removeFromParent();
      m.ember.removeFromParent();
      (m.scorch.material as Material).dispose();
      (m.ember.material as Material).dispose();
    }
    this.marks.length = 0;
  }
}
