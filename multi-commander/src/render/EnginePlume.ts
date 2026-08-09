import {
  AdditiveBlending,
  ConeGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  SphereGeometry,
  type Material,
  type Object3D,
} from 'three';
import { clamp01 } from '../core/math';
import type { ShipDef } from '../content/ships';
import type { Entity } from '../world/entity';

/**
 * エンジンの噴射炎。
 *
 * 機体メッシュとは別に、スロットルとアフターバーナーに応じて
 * 伸び縮みする加算合成のコーンを機体の後方に付ける。
 * 速度感と「今どれだけ出力を出しているか」が一目で分かるようにするための表現。
 */

const HALF_PI = Math.PI / 2;

/** 先端が +Z を向くコーン (噴射は機体後方 = +Z へ伸びる) */
const PLUME_GEO = (() => {
  const g = new ConeGeometry(0.5, 1, 12, 1, true);
  g.rotateX(HALF_PI);
  g.translate(0, 0, 0.5);
  return g;
})();
const CORE_GEO = new SphereGeometry(0.5, 10, 8);

const matCache = new Map<string, Material>();

function plumeMaterial(color: number, opacity: number): Material {
  const key = `${color}:${opacity}`;
  let m = matCache.get(key);
  if (!m) {
    m = new MeshBasicMaterial({
      color,
      transparent: true,
      opacity,
      blending: AdditiveBlending,
      depthWrite: false,
    });
    matCache.set(key, m);
  }
  return m;
}

interface Nozzle {
  /** 外側の炎 */
  outer: Mesh;
  /** 内側の白熱コア */
  inner: Mesh;
  /** 排気口の発光 */
  core: Mesh;
  baseRadius: number;
}

/** 機体定義からエンジン位置を推定する (メッシュ側の配置と対応させた値) */
function nozzlesFor(def: ShipDef): Array<{ pos: [number, number, number]; r: number }> {
  switch (def.visual.kind) {
    case 'arrow':
      return [
        { pos: [-1.15, 0, 5.6], r: 0.72 },
        { pos: [1.15, 0, 5.6], r: 0.72 },
      ];
    case 'delta':
      return [
        { pos: [-1.5, 0, 6.1], r: 0.82 },
        { pos: [1.5, 0, 6.1], r: 0.82 },
      ];
    case 'twin-boom':
      return [
        { pos: [-4.0, 0, 7.9], r: 0.85 },
        { pos: [4.0, 0, 7.9], r: 0.85 },
        { pos: [0, -0.2, 3.5], r: 0.6 },
      ];
    case 'bat':
      return [
        { pos: [-1.4, 0, 4.9], r: 0.88 },
        { pos: [1.4, 0, 4.9], r: 0.88 },
      ];
    case 'brick':
      return [
        { pos: [-1.7, 0, 7.1], r: 1.0 },
        { pos: [1.7, 0, 7.1], r: 1.0 },
        { pos: [0, 1.3, 7.0], r: 0.85 },
      ];
    case 'hauler':
      return [
        { pos: [-4.2, 0, 27.2], r: 2.2 },
        { pos: [4.2, 0, 27.2], r: 2.2 },
        { pos: [0, 4.2, 26.8], r: 1.8 },
      ];
    case 'warship':
      return [
        { pos: [-8, 0, 67.2], r: 4.2 },
        { pos: [8, 0, 67.2], r: 4.2 },
        { pos: [0, 6.5, 66.2], r: 3.4 },
        { pos: [0, -6.5, 66.2], r: 3.4 },
      ];
    default:
      return [{ pos: [0, 0, 5], r: 0.8 }];
  }
}

/**
 * 1機ぶんの噴射炎。機体メッシュと同じ親に付け、同じスケールで動かす。
 */
export class EnginePlume {
  readonly root = new Group();
  private nozzles: Nozzle[] = [];
  /** 表示上の出力 (急に変わらないよう補間する) */
  private level = 0;
  private abLevel = 0;
  /**
   * 距離帯ごとの増幅 (RenderSync が毎フレーム入れる)。
   * 遠い機体は噴射炎を伸ばして、影絵の中でも「動いている機体」だと分かるようにする。
   */
  visibilityBoost = 1;

  constructor(def: ShipDef, meshScale: number) {
    const color = def.visual.engine;
    // 星雲や太陽を背にしても埋もれないよう、加算合成の濃さを上げている
    const outerMat = plumeMaterial(color, 0.32);
    const innerMat = plumeMaterial(0xffffff, 0.42);
    const coreMat = plumeMaterial(color, 0.8);

    for (const n of nozzlesFor(def)) {
      const outer = new Mesh(PLUME_GEO, outerMat);
      const inner = new Mesh(PLUME_GEO, innerMat);
      const core = new Mesh(CORE_GEO, coreMat);
      outer.position.set(...n.pos);
      inner.position.set(...n.pos);
      core.position.set(...n.pos);
      core.scale.setScalar(n.r * 2.1);
      this.root.add(outer, inner, core);
      this.nozzles.push({ outer, inner, core, baseRadius: n.r });
    }
    this.root.scale.setScalar(meshScale);
  }

  /**
   * 出力に応じて炎を伸ばす。
   * dt で補間するので、スロットルを絞ってもすぐには消えない。
   */
  update(e: Entity, dt: number): void {
    const ship = e.ship;
    if (!ship) return;
    const def = ship.def;
    const speed = e.vel.length();
    const throttle = clamp01(e.input?.throttle ?? speed / Math.max(1, def.maxSpeed));
    const ab = !!e.input?.afterburner && ship.fuel > 0 && def.fuel > 0;

    const targetLevel = clamp01(throttle * 0.85 + (speed / Math.max(1, def.abSpeed)) * 0.3);
    const k = 1 - Math.pow(0.5, dt / 0.09);
    this.level += (targetLevel - this.level) * k;
    this.abLevel += ((ab ? 1 : 0) - this.abLevel) * (1 - Math.pow(0.5, dt / 0.12));

    const boost = Math.max(1, this.visibilityBoost);
    // 停止中でも排気口が灯っているようにわずかな下限を持たせる (遠距離の存在確認になる)
    const len = (Math.max(0.22, this.level) * 2.6 + this.abLevel * 6.0) * boost;
    const width = (0.75 + this.level * 0.2 + this.abLevel * 0.35) * (1 + (boost - 1) * 0.5);
    const visible = len > 0.05;

    for (const n of this.nozzles) {
      n.outer.visible = visible;
      n.inner.visible = visible;
      n.core.visible = visible;
      if (!visible) continue;
      const r = n.baseRadius;
      // わずかな揺らぎで炎らしさを出す
      const flicker = 0.92 + Math.sin((performance.now() * 0.02 + n.baseRadius * 31) % 6.283) * 0.08;
      n.outer.scale.set(r * 2.3 * width, r * 2.3 * width, r * len * 2.4 * flicker);
      n.inner.scale.set(r * 1.25 * width, r * 1.25 * width, r * len * 1.35 * flicker);
      n.core.scale.setScalar(r * (1.5 + this.abLevel * 0.7) * boost);
    }
  }
}

/** プレイヤー機など、噴射炎を持たせたいエンティティ用のファクトリ */
export function createPlume(def: ShipDef, meshScale: number): EnginePlume {
  return new EnginePlume(def, meshScale);
}

export function disposePlumeMaterials(): void {
  for (const m of matCache.values()) m.dispose();
  matCache.clear();
}

/** 機体メッシュに噴射炎を差し込む (RenderSync から使う) */
export function attachPlume(target: Object3D, plume: EnginePlume): void {
  target.add(plume.root);
}
