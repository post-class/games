import {
  BoxGeometry,
  CircleGeometry,
  ConeGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  SphereGeometry,
  TorusGeometry,
  type BufferGeometry,
  type Material,
} from 'three';
import { Rng } from '../core/rng';
import { VISUAL_BASE_HALF_LENGTH, type ShipDef, type VisualDef } from '../content/ships';
import { PartBuilder } from './PartBuilder';

/**
 * 手続き生成による機体メッシュ。外部アセットに依存しない。
 *
 * 1機ぶんのジオメトリはマテリアルごとにマージしてから ShipDef 単位でキャッシュし、
 * 実体は Object3D.clone() で複製する (ジオメトリとマテリアルは共有される)。
 * これで細部を増やしてもドローコールと生成コストが膨らまない。
 */

// ───────── 共有プリミティブ (すべて forward = -Z 基準) ─────────

const HALF_PI = Math.PI / 2;
const BOX = new BoxGeometry(1, 1, 1);
const SPH = new SphereGeometry(0.5, 14, 10);
const CYL_LOW = rotZ(new CylinderGeometry(0.5, 0.5, 1, 8, 1, false));
const TUBE = rotZ(new CylinderGeometry(0.5, 0.5, 1, 14, 1, true));
const CONE = coneZ(new ConeGeometry(0.5, 1, 14));
const CONE_LOW = coneZ(new ConeGeometry(0.5, 1, 8));
const DISC = new CircleGeometry(0.5, 18);
const RING = new TorusGeometry(0.42, 0.09, 8, 20);

function rotZ(g: BufferGeometry): BufferGeometry {
  g.rotateX(HALF_PI);
  return g;
}
function coneZ(g: BufferGeometry): BufferGeometry {
  g.rotateX(-HALF_PI);
  return g;
}

// ───────── マテリアル ─────────

const matCache = new Map<string, Material>();

function cached(key: string, make: () => Material): Material {
  let m = matCache.get(key);
  if (!m) {
    m = make();
    matCache.set(key, m);
  }
  return m;
}

/** マテリアルキーを解決する。`種類:16進色` の形式。 */
function resolveMaterial(key: string): Material {
  const [kind, hex] = key.split(':');
  const color = hex ? Number.parseInt(hex, 16) : 0xffffff;
  switch (kind) {
    case 'hull':
      return cached(key, () =>
        new MeshStandardMaterial({
          color,
          roughness: 0.62,
          metalness: 0.22,
          envMapIntensity: 0.45,
          flatShading: true,
        }),
      );
    case 'accent':
      return cached(key, () =>
        new MeshStandardMaterial({
          color,
          roughness: 0.45,
          metalness: 0.3,
          envMapIntensity: 0.6,
          flatShading: true,
        }),
      );
    case 'panel':
      // 装甲板の継ぎ目・凹み。船体色を暗く落とした色
      return cached(key, () =>
        new MeshStandardMaterial({
          color: darken(color, 0.3),
          roughness: 0.8,
          metalness: 0.2,
          flatShading: true,
        }),
      );
    case 'dark':
      return cached(key, () =>
        new MeshStandardMaterial({ color: 0x171c22, roughness: 0.85, metalness: 0.25, flatShading: true }),
      );
    case 'metal':
      return cached(key, () =>
        new MeshStandardMaterial({
          color: 0x5a626c,
          roughness: 0.34,
          metalness: 0.8,
          envMapIntensity: 0.8,
          flatShading: true,
        }),
      );
    case 'glass':
      return cached(key, () =>
        new MeshStandardMaterial({
          color: 0x0a1c2a,
          roughness: 0.08,
          metalness: 0.9,
          envMapIntensity: 1.6,
          emissive: 0x0e2c42,
          emissiveIntensity: 0.5,
        }),
      );
    case 'glow':
      return cached(key, () => new MeshBasicMaterial({ color }));
    default:
      return cached('fallback', () => new MeshStandardMaterial({ color: 0x888888 }));
  }
}

function darken(color: number, f: number): number {
  const r = Math.round(((color >> 16) & 0xff) * f);
  const g = Math.round(((color >> 8) & 0xff) * f);
  const b = Math.round((color & 0xff) * f);
  return (r << 16) | (g << 8) | b;
}

function hex(n: number): string {
  return n.toString(16).padStart(6, '0');
}

/** 1機ぶんのマテリアルキー集合 */
interface Keys {
  hull: string;
  accent: string;
  panel: string;
  dark: string;
  metal: string;
  glass: string;
  glow: string;
  red: string;
  green: string;
  white: string;
}

function keysFor(v: VisualDef): Keys {
  return {
    hull: `hull:${hex(v.hull)}`,
    accent: `accent:${hex(v.accent)}`,
    panel: `panel:${hex(v.hull)}`,
    dark: 'dark:',
    metal: 'metal:',
    glass: 'glass:',
    glow: `glow:${hex(v.engine)}`,
    red: 'glow:ff3322',
    green: 'glow:33ff66',
    white: 'glow:ffffff',
  };
}

// ───────── 共通ディテール ─────────

/** 装甲板の継ぎ目。薄い板を表面にわずかに浮かせて置く。 */
function seam(
  b: PartBuilder,
  k: Keys,
  pos: [number, number, number],
  size: [number, number, number],
  rot?: [number, number, number],
): void {
  b.add(BOX, k.panel, { pos, scale: size, rot });
}

/** 小さな出っ張り (グリーブル)。決定的な乱数で散らす。 */
function greebles(
  b: PartBuilder,
  k: Keys,
  rng: Rng,
  count: number,
  bounds: { x: [number, number]; y: [number, number]; z: [number, number] },
): void {
  for (let i = 0; i < count; i++) {
    const x = rng.range(bounds.x[0], bounds.x[1]);
    const y = rng.range(bounds.y[0], bounds.y[1]);
    const z = rng.range(bounds.z[0], bounds.z[1]);
    const w = rng.range(0.18, 0.5);
    const h = rng.range(0.1, 0.28);
    const d = rng.range(0.3, 1.1);
    const key = rng.chance(0.35) ? k.dark : k.panel;
    b.addMirrored(BOX, key, { pos: [Math.abs(x), y, z], scale: [w, h, d] });
  }
}

/** エンジン。ナセル + 冷却リング + 発光ディスク + 内炎。 */
function engine(
  b: PartBuilder,
  k: Keys,
  pos: [number, number, number],
  r: number,
  len: number,
): void {
  const [x, y, z] = pos;
  b.add(TUBE, k.dark, { pos: [x, y, z], scale: [r * 2, r * 2, len] });
  b.add(CYL_LOW, k.metal, { pos: [x, y, z - len * 0.5], scale: [r * 2.05, r * 2.05, len * 0.16] });
  b.add(RING, k.accent, { pos: [x, y, z + len * 0.38], scale: r * 2.2 });
  // 排気口の発光。奥に向かって細くなる内炎を重ねる
  b.add(DISC, k.glow, { pos: [x, y, z + len * 0.5 + 0.02], scale: r * 1.7, rot: [0, Math.PI, 0] });
  b.add(CONE, k.glow, {
    pos: [x, y, z + len * 0.5 + r * 0.9],
    scale: [r * 1.4, r * 1.4, r * 2.2],
    rot: [Math.PI, 0, 0],
  });
}

/** コックピット。ガラスドームと骨組み。 */
function canopy(b: PartBuilder, k: Keys, pos: [number, number, number], size: [number, number, number]): void {
  const [x, y, z] = pos;
  b.add(SPH, k.glass, { pos: [x, y, z], scale: size });
  // 前後のフレーム
  b.add(BOX, k.dark, { pos: [x, y + size[1] * 0.1, z - size[2] * 0.48], scale: [size[0] * 1.06, size[1] * 0.9, 0.22] });
  b.add(BOX, k.dark, { pos: [x, y + size[1] * 0.1, z + size[2] * 0.48], scale: [size[0] * 1.06, size[1] * 0.9, 0.22] });
  // 中央の桁
  b.add(BOX, k.dark, { pos: [x, y + size[1] * 0.46, z], scale: [0.16, 0.16, size[2] * 0.96] });
  // 計器盤の反射 (座席側の暗い塊)
  b.add(BOX, k.dark, { pos: [x, y - size[1] * 0.3, z + size[2] * 0.1], scale: [size[0] * 0.7, size[1] * 0.4, size[2] * 0.5] });
}

/** 砲身。ShipDef の hardpoint 位置に実際に生やす。 */
function barrels(b: PartBuilder, k: Keys, def: ShipDef): void {
  for (const hp of def.guns) {
    const [x, y, z] = hp.offset;
    const len = 2.6;
    b.add(TUBE, k.metal, { pos: [x, y, z + len * 0.35], scale: [0.34, 0.34, len] });
    b.add(CYL_LOW, k.dark, { pos: [x, y, z - 0.15], scale: [0.42, 0.42, 0.5] });
    // 砲身基部のフェアリング
    b.add(BOX, k.panel, { pos: [x, y, z + len * 0.95], scale: [0.7, 0.5, 1.2] });
  }
}

/** 翼下のミサイルパイロン */
function pylons(b: PartBuilder, k: Keys, spots: Array<[number, number, number]>): void {
  for (const [x, y, z] of spots) {
    b.addMirrored(BOX, k.dark, { pos: [x, y + 0.28, z], scale: [0.22, 0.55, 1.4] });
    b.addMirrored(CYL_LOW, k.metal, { pos: [x, y, z], scale: [0.55, 0.55, 3.2] });
    b.addMirrored(CONE_LOW, k.metal, { pos: [x, y, z - 1.9], scale: [0.55, 0.55, 1.2] });
    b.addMirrored(BOX, k.accent, { pos: [x, y, z + 1.3], scale: [1.1, 0.1, 0.7] });
  }
}

/** 航行灯 (左舷=赤 / 右舷=緑 / 尾部=白) */
function navLights(
  b: PartBuilder,
  k: Keys,
  left: [number, number, number],
  tail: [number, number, number],
): void {
  const s = 0.3;
  b.add(SPH, k.red, { pos: left, scale: s });
  b.add(SPH, k.green, { pos: [-left[0], left[1], left[2]], scale: s });
  b.add(SPH, k.white, { pos: tail, scale: s * 0.8 });
}

/** 機首のセンサー窓とアンテナ */
function noseSensors(b: PartBuilder, k: Keys, z: number, w: number): void {
  b.add(BOX, k.glass, { pos: [0, -w * 0.25, z], scale: [w * 0.8, w * 0.3, 0.5] });
  b.add(TUBE, k.metal, { pos: [0, w * 0.55, z + 1.4], scale: [0.1, 0.1, 2.4], rot: [-0.35, 0, 0] });
}

// ───────── 機体ごとのビルダー ─────────
// いずれも「半長 8 前後」で組む (VISUAL_BASE_HALF_LENGTH と対応)

function buildArrow(def: ShipDef, k: Keys, rng: Rng): PartBuilder {
  const b = new PartBuilder();
  // 胴体: 前方が細い箱を段積みにして絞り込む
  b.add(BOX, k.hull, { pos: [0, 0, 0.6], scale: [1.9, 1.5, 7.4] });
  b.add(BOX, k.hull, { pos: [0, 0.1, -3.6], scale: [1.4, 1.1, 2.6] });
  b.add(CONE, k.hull, { pos: [0, 0.05, -6.1], scale: [1.25, 1.0, 3.2] });
  noseSensors(b, k, -5.2, 1.1);
  // 背骨と側面の継ぎ目
  seam(b, k, [0, 0.78, 0.4], [0.5, 0.12, 6.6]);
  b.addMirrored(BOX, k.panel, { pos: [0.98, 0, 0.4], scale: [0.08, 1.1, 6.2] });
  b.addMirrored(BOX, k.accent, { pos: [0.99, 0.35, -1.4], scale: [0.1, 0.28, 2.4] });

  canopy(b, k, [0, 0.85, -2.0], [1.5, 1.15, 2.9]);

  // 後退翼 + 翼端の垂直板
  b.addMirrored(BOX, k.hull, { pos: [3.0, -0.05, 0.9], scale: [5.4, 0.3, 2.5], rot: [0, 0.34, -0.05] });
  b.addMirrored(BOX, k.accent, { pos: [4.6, 0.02, 1.6], scale: [2.1, 0.22, 1.3], rot: [0, 0.34, -0.05] });
  b.addMirrored(BOX, k.hull, { pos: [5.3, 0.55, 1.5], scale: [0.32, 1.5, 1.7], rot: [0.18, 0, 0] });
  b.addMirrored(BOX, k.panel, { pos: [2.2, 0.12, 0.9], scale: [2.6, 0.06, 0.16], rot: [0, 0.34, 0] });
  // 翼根フェアリング
  b.addMirrored(BOX, k.hull, { pos: [1.2, 0.05, 0.9], scale: [1.2, 0.9, 4.2] });

  // 垂直尾翼
  b.add(BOX, k.accent, { pos: [0, 1.25, 2.9], scale: [0.24, 2.1, 2.2], rot: [-0.26, 0, 0] });
  b.add(BOX, k.panel, { pos: [0, 2.1, 3.4], scale: [0.3, 0.1, 1.1], rot: [-0.26, 0, 0] });

  barrels(b, k, def);
  if (def.missiles.length) pylons(b, k, [[2.6, -0.45, 1.0]]);
  engine(b, k, [-1.15, 0, 4.3], 0.72, 2.5);
  engine(b, k, [1.15, 0, 4.3], 0.72, 2.5);
  navLights(b, k, [5.4, 0.75, 1.5], [0, 2.2, 3.6]);
  greebles(b, k, rng, 12, { x: [0.5, 1.0], y: [-0.7, 0.7], z: [-2, 4] });
  return b;
}

function buildDelta(def: ShipDef, k: Keys, rng: Rng): PartBuilder {
  const b = new PartBuilder();
  b.add(BOX, k.hull, { pos: [0, 0, 0.5], scale: [2.3, 1.6, 8.2] });
  b.add(CONE, k.hull, { pos: [0, 0, -6.4], scale: [1.6, 1.25, 4.0] });
  noseSensors(b, k, -5.6, 1.3);
  seam(b, k, [0, 0.83, 0.5], [0.7, 0.12, 7.4]);
  b.addMirrored(BOX, k.panel, { pos: [1.18, 0, 0.5], scale: [0.08, 1.2, 7.0] });

  canopy(b, k, [0, 0.92, -2.4], [1.7, 1.2, 3.3]);

  // デルタ翼 (前縁後退 + 翼端下がり)
  b.addMirrored(BOX, k.hull, { pos: [3.7, -0.1, 1.5], scale: [6.6, 0.34, 4.4], rot: [0, 0.46, -0.06] });
  b.addMirrored(BOX, k.accent, { pos: [5.6, -0.06, 2.6], scale: [2.6, 0.26, 2.0], rot: [0, 0.46, -0.06] });
  b.addMirrored(BOX, k.panel, { pos: [3.0, 0.1, 1.4], scale: [3.4, 0.06, 0.18], rot: [0, 0.46, 0] });
  // 翼端の砲座ポッド
  b.addMirrored(TUBE, k.dark, { pos: [6.3, -0.05, 0.2], scale: [0.6, 0.6, 3.4] });
  b.addMirrored(CONE_LOW, k.metal, { pos: [6.3, -0.05, -1.9], scale: [0.6, 0.6, 1.1] });
  // ストレーキ
  b.addMirrored(BOX, k.hull, { pos: [1.5, 0.25, -2.6], scale: [1.6, 0.16, 2.6], rot: [0, -0.2, 0] });

  b.add(BOX, k.accent, { pos: [0, 1.45, 3.4], scale: [0.28, 2.3, 2.6], rot: [-0.22, 0, 0] });
  b.addMirrored(BOX, k.hull, { pos: [1.6, 0.9, 3.6], scale: [0.24, 1.5, 1.8], rot: [-0.15, 0, 0.25] });

  barrels(b, k, def);
  if (def.missiles.length) pylons(b, k, [[3.2, -0.5, 1.6]]);
  engine(b, k, [-1.5, 0, 4.7], 0.82, 2.7);
  engine(b, k, [1.5, 0, 4.7], 0.82, 2.7);
  navLights(b, k, [6.6, 0.2, 2.6], [0, 2.5, 4.2]);
  greebles(b, k, rng, 14, { x: [0.6, 1.2], y: [-0.75, 0.8], z: [-2.5, 4.4] });
  return b;
}

function buildTwinBoom(def: ShipDef, k: Keys, rng: Rng): PartBuilder {
  const b = new PartBuilder();
  // 中央ポッド
  b.add(BOX, k.hull, { pos: [0, 0, -0.8], scale: [2.6, 1.9, 6.2] });
  b.add(CONE, k.hull, { pos: [0, 0, -5.4], scale: [1.7, 1.4, 3.4] });
  noseSensors(b, k, -4.6, 1.4);
  canopy(b, k, [0, 1.05, -2.4], [1.8, 1.3, 3.1]);
  seam(b, k, [0, 1.0, -0.6], [0.8, 0.12, 5.2]);

  // 双ブーム
  for (const s of [-1, 1]) {
    b.add(TUBE, k.hull, { pos: [s * 4.0, 0, 0.4], scale: [1.7, 1.7, 12.4] });
    b.add(CONE, k.hull, { pos: [s * 4.0, 0, -6.4], scale: [1.7, 1.7, 2.8] });
    b.add(RING, k.accent, { pos: [s * 4.0, 0, -3.4], scale: 1.9 });
    b.add(RING, k.accent, { pos: [s * 4.0, 0, 2.2], scale: 1.9 });
    b.add(BOX, k.accent, { pos: [s * 4.0, 1.5, 5.0], scale: [0.28, 2.4, 2.2], rot: [-0.16, 0, 0] });
    b.add(BOX, k.glass, { pos: [s * 4.0, 0.2, -5.0], scale: [0.8, 0.4, 0.5] });
  }

  // ブームを繋ぐ主翼と水平尾翼
  b.add(BOX, k.hull, { pos: [0, -0.2, 1.3], scale: [9.4, 0.38, 3.6] });
  b.add(BOX, k.panel, { pos: [0, 0.0, 1.3], scale: [9.0, 0.08, 0.2] });
  b.add(BOX, k.accent, { pos: [0, 1.25, 5.6], scale: [9.4, 0.32, 1.9] });
  b.addMirrored(BOX, k.hull, { pos: [5.6, -0.1, 1.2], scale: [1.8, 0.3, 2.6], rot: [0, 0.3, 0.1] });

  barrels(b, k, def);
  if (def.missiles.length) pylons(b, k, [[2.2, -0.6, 1.4]]);
  engine(b, k, [-4.0, 0, 6.6], 0.85, 2.4);
  engine(b, k, [4.0, 0, 6.6], 0.85, 2.4);
  engine(b, k, [0, -0.2, 2.6], 0.6, 1.6);
  navLights(b, k, [6.4, -0.05, 1.2], [0, 1.6, 6.4]);
  greebles(b, k, rng, 16, { x: [0.7, 4.6], y: [-0.9, 0.9], z: [-3, 5] });
  return b;
}

function buildBat(def: ShipDef, k: Keys, rng: Rng): PartBuilder {
  const b = new PartBuilder();
  // 平たい中央胴体
  b.add(BOX, k.hull, { pos: [0, 0, 0.4], scale: [3.2, 1.5, 6.6] });
  b.add(CONE, k.hull, { pos: [0, 0, -4.6], scale: [2.0, 1.3, 3.0] });
  noseSensors(b, k, -4.0, 1.3);
  canopy(b, k, [0, 0.9, -1.4], [1.9, 1.05, 2.7]);

  // コウモリ翼: 前進した外翼 + 骨のような桁
  for (const s of [-1, 1]) {
    b.add(BOX, k.hull, { pos: [s * 4.5, 0, -0.5], scale: [8.6, 0.36, 5.0], rot: [0, s * -0.28, 0] });
    b.add(BOX, k.accent, { pos: [s * 7.8, 0.16, -2.3], scale: [3.0, 0.3, 2.2], rot: [0, s * -0.5, s * 0.3] });
    // 翼の骨 (放射状の桁)
    for (let i = 0; i < 3; i++) {
      b.add(BOX, k.panel, {
        pos: [s * (2.4 + i * 1.9), 0.2, -0.4 - i * 0.7],
        scale: [0.16, 0.14, 4.2 - i * 0.7],
        rot: [0, s * -0.28, 0],
      });
    }
    // 翼下の砲ポッド
    b.add(TUBE, k.dark, { pos: [s * 5.2, -0.25, -2.4], scale: [0.62, 0.62, 3.6] });
    b.add(CONE_LOW, k.metal, { pos: [s * 5.2, -0.25, -4.4], scale: [0.62, 0.62, 1.0] });
    // 翼端の爪
    b.add(CONE, k.accent, { pos: [s * 8.9, 0.35, -3.6], scale: [0.5, 0.5, 1.8], rot: [0, s * -0.5, 0] });
  }
  seam(b, k, [0, 0.78, 0.4], [1.0, 0.12, 6.0]);

  barrels(b, k, def);
  engine(b, k, [-1.4, 0, 3.7], 0.88, 2.3);
  engine(b, k, [1.4, 0, 3.7], 0.88, 2.3);
  navLights(b, k, [8.8, 0.4, -3.4], [0, 0.9, 3.6]);
  greebles(b, k, rng, 12, { x: [0.6, 1.5], y: [-0.7, 0.75], z: [-2, 3.4] });
  return b;
}

function buildBrick(def: ShipDef, k: Keys, rng: Rng): PartBuilder {
  const b = new PartBuilder();
  // 重厚な角ばった胴体
  b.add(BOX, k.hull, { pos: [0, 0, 0], scale: [4.6, 3.1, 10.2] });
  b.add(BOX, k.hull, { pos: [0, 0.1, -5.8], scale: [3.4, 2.3, 3.0] });
  b.add(CONE, k.accent, { pos: [0, 0.1, -8.2], scale: [2.0, 1.6, 2.8] });
  noseSensors(b, k, -7.0, 1.6);
  // 装甲板の段差
  for (let i = 0; i < 4; i++) {
    b.addMirrored(BOX, k.panel, { pos: [2.33, 0.2, -3.4 + i * 2.4], scale: [0.12, 2.2, 0.28] });
  }
  seam(b, k, [0, 1.58, 0], [2.2, 0.14, 9.0]);
  b.add(BOX, k.glass, { pos: [0, 1.35, -4.4], scale: [2.4, 0.9, 2.0] });
  b.add(BOX, k.dark, { pos: [0, 1.75, -4.4], scale: [2.6, 0.3, 2.2] });

  for (const s of [-1, 1]) {
    // 側面の武装パイロンと砲
    b.add(BOX, k.accent, { pos: [s * 3.3, -0.4, -0.6], scale: [1.7, 1.7, 7.2] });
    b.add(TUBE, k.dark, { pos: [s * 3.3, -0.4, -5.0], scale: [0.72, 0.72, 4.0] });
    b.add(CONE_LOW, k.metal, { pos: [s * 3.3, -0.4, -7.2], scale: [0.72, 0.72, 1.2] });
    // 上部の安定板
    b.add(BOX, k.accent, { pos: [s * 2.4, 2.4, 3.4], scale: [0.42, 3.0, 3.0], rot: [-0.1, 0, s * 0.25] });
    // ラジエーター
    b.add(BOX, k.dark, { pos: [s * 2.45, -1.2, 2.2], scale: [0.2, 1.2, 4.4] });
  }

  barrels(b, k, def);
  if (def.missiles.length) pylons(b, k, [[2.4, -1.6, 0.5]]);
  engine(b, k, [-1.7, 0, 5.6], 1.0, 2.8);
  engine(b, k, [1.7, 0, 5.6], 1.0, 2.8);
  engine(b, k, [0, 1.3, 5.6], 0.85, 2.4);
  navLights(b, k, [4.2, 1.0, -1.0], [0, 3.6, 4.4]);
  greebles(b, k, rng, 18, { x: [0.8, 2.2], y: [-1.4, 1.4], z: [-4, 5] });
  return b;
}

function buildHauler(def: ShipDef, k: Keys, rng: Rng): PartBuilder {
  const b = new PartBuilder();
  // 背骨
  b.add(BOX, k.hull, { pos: [0, 0, 0], scale: [5.4, 5.4, 46] });
  b.add(BOX, k.panel, { pos: [0, 2.75, 0], scale: [4.4, 0.2, 44] });
  // 艦橋
  b.add(BOX, k.hull, { pos: [0, 3.8, -16], scale: [7.4, 4.4, 9.4] });
  b.add(BOX, k.glass, { pos: [0, 4.9, -20.4], scale: [5.6, 1.5, 1.2] });
  b.add(BOX, k.dark, { pos: [0, 6.2, -16], scale: [5.0, 0.5, 6.0] });
  b.add(TUBE, k.metal, { pos: [0, 7.6, -14], scale: [0.3, 0.3, 5.0], rot: [-0.4, 0, 0] });
  b.add(CONE, k.hull, { pos: [0, 0, -25.5], scale: [4.6, 4.6, 6.0] });

  // コンテナ列 (段ごとに色を変えて情報量を出す)
  for (let i = 0; i < 4; i++) {
    const z = -6 + i * 10;
    for (const s of [-1, 1]) {
      b.add(BOX, k.accent, { pos: [s * 6.6, 0, z], scale: [7.2, 7.2, 8.6] });
      b.add(BOX, k.dark, { pos: [s * 6.6, 0, z], scale: [7.4, 1.0, 1.0] });
      b.add(BOX, k.panel, { pos: [s * 6.6, 3.7, z], scale: [6.6, 0.2, 7.6] });
      b.add(BOX, k.dark, { pos: [s * 10.3, 0, z], scale: [0.4, 5.2, 6.4] });
      b.add(SPH, k.white, { pos: [s * 6.6, 3.9, z - 4.0], scale: 0.42 });
    }
    // 連結架
    b.add(BOX, k.metal, { pos: [0, 0, z - 5], scale: [15.5, 0.7, 0.7] });
  }

  // ラジエーターと補助構造
  for (const s of [-1, 1]) {
    b.add(BOX, k.dark, { pos: [s * 3.2, 6.4, 8], scale: [0.4, 9.4, 12] });
    b.add(BOX, k.panel, { pos: [s * 3.2, 6.4, 8], scale: [0.5, 0.3, 11] });
  }
  barrels(b, k, def);
  engine(b, k, [-4.2, 0, 24], 2.2, 6.2);
  engine(b, k, [4.2, 0, 24], 2.2, 6.2);
  engine(b, k, [0, 4.2, 24], 1.8, 5.4);
  navLights(b, k, [10.6, 4.2, -6], [0, 6.6, 22]);
  greebles(b, k, rng, 26, { x: [1, 4.5], y: [-2.5, 2.5], z: [-20, 20] });
  return b;
}

function buildWarship(def: ShipDef, k: Keys, rng: Rng): PartBuilder {
  const b = new PartBuilder();
  // 主船体 (前後で断面を変える)
  b.add(BOX, k.hull, { pos: [0, 0, 0], scale: [22, 12, 118] });
  b.add(BOX, k.hull, { pos: [0, 0, -44], scale: [17, 10, 34] });
  b.add(CONE, k.hull, { pos: [0, 0, -74], scale: [16, 9.5, 24] });
  b.add(BOX, k.panel, { pos: [0, 6.1, 0], scale: [18, 0.4, 110] });
  b.add(BOX, k.panel, { pos: [0, -6.1, 0], scale: [18, 0.4, 110] });

  // 飛行甲板と格納庫開口 (内側を発光させて「生きている艦」に見せる)
  b.add(BOX, k.accent, { pos: [0, -5.6, -6], scale: [34, 3.2, 70] });
  b.add(BOX, k.dark, { pos: [0, -7.4, -6], scale: [30, 0.6, 64] });
  b.add(BOX, k.dark, { pos: [0, -7.6, -42], scale: [7.5, 5.5, 14] });
  b.add(BOX, k.glow, { pos: [0, -7.6, -48.6], scale: [6.0, 4.0, 0.4] });
  for (let i = 0; i < 8; i++) {
    b.addMirrored(BOX, k.white, { pos: [14.5, -7.2, -34 + i * 8], scale: [1.2, 0.2, 0.5] });
  }

  // 艦橋 (層構造 + 窓 + マスト)
  b.add(BOX, k.hull, { pos: [0, 9.5, 8], scale: [13, 9, 23] });
  b.add(BOX, k.hull, { pos: [0, 15, 10], scale: [9, 4, 15] });
  b.add(BOX, k.glass, { pos: [0, 12.6, -3.2], scale: [9.5, 2.0, 0.8] });
  b.add(BOX, k.glass, { pos: [0, 16.4, 3.6], scale: [7.0, 1.6, 0.8] });
  b.add(TUBE, k.metal, { pos: [0, 22, 12], scale: [1.1, 1.1, 16], rot: [HALF_PI, 0, 0] });
  b.add(SPH, k.red, { pos: [0, 30, 12], scale: 1.1 });
  // レーダーアレイ
  b.add(BOX, k.dark, { pos: [0, 20.5, 4], scale: [7.0, 5.0, 0.5], rot: [0, 0, 0.2] });
  b.add(BOX, k.metal, { pos: [0, 20.5, 4.4], scale: [6.4, 4.4, 0.2], rot: [0, 0, 0.2] });

  // 舷側の砲塔・スポンソン・装甲帯
  for (const s of [-1, 1]) {
    for (let i = 0; i < 5; i++) {
      const z = -44 + i * 24;
      b.add(BOX, k.accent, { pos: [s * 11.6, 4.4, z], scale: [4.4, 4.4, 6.4] });
      b.add(SPH, k.dark, { pos: [s * 12.4, 6.2, z], scale: 3.0 });
      b.add(TUBE, k.metal, { pos: [s * 13.4, 6.4, z - 5.4], scale: [0.85, 0.85, 8.4], rot: [0, s * 0.16, 0] });
      b.add(TUBE, k.metal, { pos: [s * 11.4, 6.4, z - 5.4], scale: [0.85, 0.85, 8.4], rot: [0, s * 0.16, 0] });
    }
    b.add(BOX, k.accent, { pos: [s * 12, 2, 44], scale: [3.4, 16, 26] });
    b.add(BOX, k.dark, { pos: [s * 12.2, 2, 44], scale: [0.4, 13, 22] });
    // 舷側の航行灯列
    for (let i = 0; i < 6; i++) {
      b.add(SPH, k.white, { pos: [s * 11.2, 0.4, -50 + i * 20], scale: 0.55 });
    }
  }

  barrels(b, k, def);
  engine(b, k, [-8, 0, 61], 4.2, 12);
  engine(b, k, [8, 0, 61], 4.2, 12);
  engine(b, k, [0, 6.5, 61], 3.4, 10);
  engine(b, k, [0, -6.5, 61], 3.4, 10);
  navLights(b, k, [12.6, 8.6, -60], [0, 18, 58]);
  greebles(b, k, rng, 44, { x: [2, 10], y: [-5, 6], z: [-60, 55] });
  return b;
}

const BUILDERS: Record<VisualDef['kind'], (def: ShipDef, k: Keys, rng: Rng) => PartBuilder> = {
  arrow: buildArrow,
  delta: buildDelta,
  'twin-boom': buildTwinBoom,
  bat: buildBat,
  brick: buildBrick,
  hauler: buildHauler,
  warship: buildWarship,
};

// ───────── 公開 API ─────────

/** ShipDef ごとに組んだテンプレート。実体は clone() で作る。 */
const templates = new Map<string, Object3D>();

function buildTemplate(def: ShipDef): Object3D {
  const k = keysFor(def.visual);
  // 機体 id を種にすることで、同型機のグリーブル配置は毎回同じになる
  let seed = 0;
  for (let i = 0; i < def.id.length; i++) seed = (seed * 31 + def.id.charCodeAt(i)) >>> 0;
  const builder = BUILDERS[def.visual.kind] ?? buildArrow;
  const group = builder(def, k, new Rng(seed || 1)).build(resolveMaterial);
  group.scale.setScalar(def.size / VISUAL_BASE_HALF_LENGTH[def.visual.kind]);
  const root = new Group();
  root.add(group);
  return root;
}

/**
 * 機体定義からメッシュを作る。
 * visual.gltf が指定されていれば将来そちらへ差し替えられるよう入口を分けてある。
 */
export function createShipMesh(def: ShipDef): Object3D {
  let tpl = templates.get(def.id);
  if (!tpl) {
    tpl = buildTemplate(def);
    templates.set(def.id, tpl);
  }
  const obj = tpl.clone();
  obj.userData.shipId = def.id;
  return obj;
}

/** 弾のメッシュ (細長い発光体) */
export function createTracerMesh(color: number, lengthScale = 1): Object3D {
  const mesh = new Mesh(TUBE, resolveMaterial(`glow:${hex(color)}`));
  mesh.scale.set(1.2, 1.2, 15 * lengthScale);
  return mesh;
}

/** ミサイルのメッシュ */
export function createMissileMesh(color: number): Object3D {
  const b = new PartBuilder();
  const k: Keys = {
    ...keysFor({ kind: 'arrow', hull: 0xdddddd, accent: 0x8a8f96, engine: color }),
  };
  b.add(TUBE, k.metal, { pos: [0, 0, 0], scale: [1.4, 1.4, 6.4] });
  b.add(CONE, k.hull, { pos: [0, 0, -4.0], scale: [1.4, 1.4, 2.2] });
  b.add(RING, k.accent, { pos: [0, 0, 1.0], scale: 1.6 });
  for (const s of [-1, 1]) {
    b.add(BOX, k.accent, { pos: [s * 1.0, 0, 2.4], scale: [2.0, 0.14, 1.5] });
    b.add(BOX, k.accent, { pos: [0, s * 1.0, 2.4], scale: [0.14, 2.0, 1.5] });
  }
  b.add(DISC, k.glow, { pos: [0, 0, 3.3], scale: 1.3, rot: [0, Math.PI, 0] });
  b.add(CONE, k.glow, { pos: [0, 0, 4.6], scale: [1.0, 1.0, 2.6], rot: [Math.PI, 0, 0] });
  return b.build(resolveMaterial);
}

// ───────── 障害物 ─────────

const rockTemplates = new Map<number, Object3D>();

/**
 * 小惑星。球を分割した面をランダムに膨らませると重いので、
 * 大小の塊を寄せ集めて「ごつごつした塊」に見せる。
 */
function buildRockTemplate(variant: number): Object3D {
  const rng = new Rng(1000 + variant * 977);
  const b = new PartBuilder();
  // 宇宙は黒いので、岩は実際の岩より明るくしないと形が読めない
  const body = `hull:${hex([0x9b9384, 0x8d8880, 0xa6987f, 0x847f78][variant % 4])}`;
  const dark = `dark:${hex(0x413c37)}`;

  // 中核
  b.add(SPH, body, { scale: [1, 0.86 + rng.range(0, 0.2), 0.92 + rng.range(0, 0.2)] });
  // 外周の塊
  const lumps = 7 + variant;
  for (let i = 0; i < lumps; i++) {
    const th = rng.range(0, Math.PI * 2);
    const ph = rng.range(-1.1, 1.1);
    const r = 0.34 + rng.range(0, 0.16);
    b.add(SPH, body, {
      pos: [
        Math.cos(th) * Math.cos(ph) * 0.42,
        Math.sin(ph) * 0.36,
        Math.sin(th) * Math.cos(ph) * 0.42,
      ],
      scale: [r, r * rng.range(0.7, 1.2), r * rng.range(0.7, 1.2)],
      rot: [th, ph, 0],
    });
  }
  // クレーター風の暗い窪み
  for (let i = 0; i < 5; i++) {
    const th = rng.range(0, Math.PI * 2);
    const ph = rng.range(-1.2, 1.2);
    const d = 0.44;
    b.add(DISC, dark, {
      pos: [Math.cos(th) * Math.cos(ph) * d, Math.sin(ph) * d, Math.sin(th) * Math.cos(ph) * d],
      scale: rng.range(0.14, 0.3),
      rot: [ph, th, 0],
    });
  }
  const group = b.build(resolveMaterial);
  const root = new Group();
  root.add(group);
  return root;
}

/** 小惑星のメッシュ。radius=1 相当で作り、呼び出し側でスケールする */
export function createRockMesh(variant: number): Object3D {
  const v = ((variant % 4) + 4) % 4;
  let tpl = rockTemplates.get(v);
  if (!tpl) {
    tpl = buildRockTemplate(v);
    rockTemplates.set(v, tpl);
  }
  return tpl.clone();
}

let mineTemplate: Object3D | undefined;

/** 機雷。棘つきの球。起爆前は赤い灯が点く (点滅は RenderSync 側) */
export function createMineMesh(): Object3D {
  if (!mineTemplate) {
    const b = new PartBuilder();
    const body = `metal:${hex(0x3b3f44)}`;
    const spike = `dark:${hex(0x23262a)}`;
    b.add(SPH, body, { scale: 1 });
    // 6方向の起爆棘
    const dirs: Array<[number, number, number]> = [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
    ];
    for (const [x, y, z] of dirs) {
      b.add(CYL_LOW, spike, {
        pos: [x * 0.62, y * 0.62, z * 0.62],
        scale: [0.12, 0.12, 0.5],
        rot: [y !== 0 ? HALF_PI : 0, x !== 0 ? HALF_PI : 0, 0],
      });
      b.add(SPH, spike, { pos: [x * 0.86, y * 0.86, z * 0.86], scale: 0.16 });
    }
    b.add(RING, `accent:${hex(0x6a7078)}`, { scale: 1.7, rot: [HALF_PI, 0, 0] });
    const group = b.build(resolveMaterial);
    const root = new Group();
    root.add(group);
    // 警告灯。RenderSync が emissiveIntensity ではなく visible で点滅させる
    const lamp = new Mesh(SPH, resolveMaterial(`glow:${hex(0xff4a3a)}`));
    lamp.scale.setScalar(0.3);
    lamp.position.set(0, 0.55, 0);
    lamp.name = 'lamp';
    root.add(lamp);
    mineTemplate = root;
  }
  return mineTemplate.clone();
}

export function disposeMaterialCache(): void {
  for (const m of matCache.values()) m.dispose();
  matCache.clear();
  templates.clear();
  rockTemplates.clear();
  mineTemplate = undefined;
}
