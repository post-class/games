import {
  DoubleSide,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Quaternion,
  Vector3,
  type Object3D,
} from 'three';
import { Rng } from '../core/rng';
import type { Entity } from '../world/entity';
import { textureAlpha } from './textures';

/**
 * 機体表面のデカール（国籍標識・機体番号・キルマーク・注意書き）。
 *
 * 無地の面が広いことが「試作品らしさ」の正体だったので、
 * 「量産され、整備兵に番号を書かれた兵器」に見せるための貼り込み。
 *
 * ジオメトリの UV は部品ごとに 0..1 なので、テクスチャを面に貼ると寸法が破綻する。
 * そこでデカールは**独立した平面**として機体の上面・側面に置く。
 * 位置は機体 id を種にした固定乱数なので、同じ機体なら同じ所に入る。
 */

const _q = new Quaternion();
const UP = new Vector3(0, 1, 0);
const FORWARD = new Vector3(0, 0, 1);
const PLANE = new PlaneGeometry(1, 1);

/** 陣営ごとの貼り分け */
interface DecalPlan {
  id: string;
  /** 機体半径に対する**高さ**。幅は aspect を掛けて決まる */
  size: number;
  /** 貼る面: 'top' = 上面, 'side' = 舷側 */
  face: 'top' | 'side';
  /** 機首からの位置 (-1 = 機首, +1 = 尾部) */
  along: number;
  /** 縦横比 (幅 / 高さ) */
  aspect?: number;
}

const CONFED: DecalPlan[] = [
  { id: 'decal-star', size: 0.3, face: 'top', along: 0.3 },
  { id: 'decal-numbers', size: 0.12, face: 'side', along: 0.4, aspect: 5 },
  { id: 'decal-warnings', size: 0.13, face: 'side', along: -0.25 },
];

const KILRATHI: DecalPlan[] = [
  { id: 'decal-claw', size: 0.34, face: 'top', along: 0.25 },
  { id: 'decal-warnings', size: 0.12, face: 'side', along: -0.2 },
];

/** エース機だけに付けるキルマーク */
const ACE_MARK: DecalPlan = { id: 'decal-kills', size: 0.26, face: 'side', along: 0.08, aspect: 0.29 };

/** 機体1機ぶんのデカール。機体メッシュの子として貼る */
export function attachDecals(parent: Object3D, e: Entity): void {
  const ship = e.ship;
  if (!ship) return;
  // 艦艇は面が大きすぎて位置合わせが破綻するので、戦闘機と輸送艦だけ
  if (ship.def.role === 'capital') return;

  const kilrathi = ship.def.visual.style === 'kilrathi';
  const plans = [...(kilrathi ? KILRATHI : CONFED)];
  if (ship.ace) plans.push(ACE_MARK);

  const rng = new Rng(e.id * 40503 + 11);
  const r = e.radius;

  for (const plan of plans) {
    const w = r * plan.size * (plan.aspect ?? 1);
    const h = r * plan.size;
    const z = plan.along * r * 0.55;

    if (plan.face === 'top') {
      const m = decal(plan.id, w, h);
      // 上面に水平に寝かせる
      m.quaternion.setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 2);
      // 機体の上面はだいたいこの高さ。浮いて見えないよう控えめに乗せる
      m.position.set(0, r * 0.09, z);
      parent.add(m);
    } else {
      // 左右の舷側に1枚ずつ。左右で向きを反転させる
      for (const s of [-1, 1]) {
        const m = decal(plan.id, w, h);
        _q.setFromAxisAngle(UP, (s * Math.PI) / 2);
        m.quaternion.copy(_q);
        m.position.set(s * r * 0.17, r * (0.01 + rng.range(0, 0.03)), z);
        parent.add(m);
      }
    }
  }
  void FORWARD;
}

function decal(id: string, w: number, h: number): Mesh {
  const m = new Mesh(
    PLANE,
    new MeshBasicMaterial({
      map: textureAlpha(id),
      transparent: true,
      // 裏返った面でも消えないように両面
      side: DoubleSide,
      depthWrite: false,
      // 船体より確実に手前に出す
      polygonOffset: true,
      polygonOffsetFactor: -2,
      opacity: 0.9,
    }),
  );
  m.scale.set(w, h, 1);
  m.renderOrder = 1;
  return m;
}
