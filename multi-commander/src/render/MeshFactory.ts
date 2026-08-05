import {
  BoxGeometry,
  Box3,
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
  Vector3,
  type BufferGeometry,
  type Material,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinnedObject } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { Rng } from '../core/rng';
import { VISUAL_BASE_HALF_LENGTH, type ShipDef, type VisualDef } from '../content/ships';
import { PartBuilder } from './PartBuilder';
import { ShipVisualLifecycle } from './ShipVisualLifecycle';
import { ROCK_TEXTURES, texture } from './textures';

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
/** 平たい輪。艦のレーダーアンテナなどに使う */
const TORUS_FLAT = new TorusGeometry(0.46, 0.045, 6, 24);

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
    case 'hullGrime':
      // 汚れを乗せた船体。UV は部品ごと 0..1 なので、
      // パネル継ぎ目のような「寸法のある模様」は使えない。
      // 煤・退色のような寸法を持たない汚れだけを薄く乗せる。
      return cached(key, () => {
        const [, tint, style] = key.split(':');
        return new MeshStandardMaterial({
          // map は乗算されるので、汚れの明度ぶん船体色を持ち上げて元の色味を保つ
          color: lighten(Number.parseInt(tint, 16), 1.6),
          map: texture(style === 'k' ? 'grime-kilrathi' : 'grime-confed', { repeat: 2 }),
          roughness: 0.7,
          metalness: 0.18,
          envMapIntensity: 0.4,
          flatShading: true,
        });
      });
    case 'accent':
      return cached(key, () =>
        new MeshStandardMaterial({
          color,
          // 塗装された金属。鏡のようにすると日向の面が白く飛ぶ
          roughness: 0.55,
          metalness: 0.22,
          envMapIntensity: 0.35,
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
          roughness: 0.42,
          metalness: 0.72,
          envMapIntensity: 0.55,
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
    case 'rock':
      // 小惑星の岩肌。`rock:<バリエーション番号>` で、色ではなく貼る画像を選ぶ。
      // UV は球の 0..1 なので、繰り返し回数で模様の粗さを決める
      return cached(key, () =>
        new MeshStandardMaterial({
          // テクスチャをそのまま出したいので乗算色は白に近く保つ
          color: 0xdedad2,
          map: texture(ROCK_TEXTURES[Math.abs(Number(hex) || 0) % ROCK_TEXTURES.length], {
            repeat: 3,
          }),
          roughness: 0.95,
          metalness: 0.05,
        }),
      );
    case 'lamp':
      // 窓や甲板灯。glow (全白の Basic) を使うとブルームで棒状に潰れるので、
      // 自発光を抑えた Standard を使い、光っていることだけを伝える
      return cached(key, () =>
        new MeshStandardMaterial({
          color: darken(color, 0.5),
          emissive: color,
          emissiveIntensity: 0.85,
          roughness: 0.6,
          metalness: 0.1,
        }),
      );
    default:
      return cached('fallback', () => new MeshStandardMaterial({ color: 0x888888 }));
  }
}

/** 色を明るくする。テクスチャの乗算で沈む分を補う */
function lighten(color: number, f: number): number {
  const r = Math.min(255, Math.round(((color >> 16) & 0xff) * f));
  const g = Math.min(255, Math.round(((color >> 8) & 0xff) * f));
  const b = Math.min(255, Math.round((color & 0xff) * f));
  return (r << 16) | (g << 8) | b;
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
  /** 甲板灯・作業灯 (控えめな自発光) */
  lamp: string;
  /** 居住区の窓 */
  windowLit: string;
}

function keysFor(v: VisualDef): Keys {
  return {
    hull: `hullGrime:${hex(v.hull)}:${v.style === 'kilrathi' ? 'k' : 'c'}`,
    accent: `accent:${hex(v.accent)}`,
    panel: `panel:${hex(v.hull)}`,
    dark: 'dark:',
    metal: 'metal:',
    glass: 'glass:',
    glow: `glow:${hex(v.engine)}`,
    red: 'glow:ff3322',
    green: 'glow:33ff66',
    white: 'glow:ffffff',
    lamp: 'lamp:ffe9c0',
    windowLit: 'lamp:9fd4ff',
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

/**
 * キルラシーの造形の癖。
 *
 * 骨格 (kind) は連邦と共用しつつ、爪・牙・肋・赤い単眼を足して
 * 「猫の帝国の機体」と一目で分かるようにする。
 * len は機体の半長、w は半幅の目安。
 */
function clawMotifs(b: PartBuilder, k: Keys, len: number, w: number): void {
  const claw = k.accent;
  // 機首の牙 (上下から挟む2本の爪)
  for (const sy of [-1, 1]) {
    b.add(CONE, claw, {
      pos: [0, sy * w * 0.16, -len * 1.06],
      scale: [w * 0.13, w * 0.13, len * 0.3],
      rot: [sy * 0.22, 0, 0],
    });
  }
  // 舷側から前へ伸びる爪 (内側へわずかに湾曲させる)
  b.addMirrored(CONE, claw, {
    pos: [w * 0.52, 0, -len * 0.72],
    scale: [w * 0.1, w * 0.1, len * 0.42],
    rot: [0, 0.12, 0],
  });
  // 背の肋 (等間隔に並ぶ骨)
  const ribs = 5;
  for (let i = 0; i < ribs; i++) {
    const t = i / (ribs - 1);
    const z = -len * 0.45 + t * len * 0.95;
    const h = w * (0.16 - t * 0.06);
    b.add(BOX, claw, { pos: [0, w * 0.2 + h * 0.5, z], scale: [w * 0.06, h, w * 0.1] });
  }
  // 赤い単眼 (センサー)。機首の下に1つだけ光らせる
  b.add(SPH, k.red, { pos: [0, -w * 0.13, -len * 0.92], scale: w * 0.1 });
  b.add(CYL_LOW, k.dark, {
    pos: [0, -w * 0.13, -len * 0.86],
    scale: [w * 0.15, w * 0.15, w * 0.1],
    rot: [HALF_PI, 0, 0],
  });
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

/**
 * 艦艇。
 *
 * 「大きい戦闘機」に見えないことが最優先。そのために
 * ①段のある厚い船体 ②繰り返す構造リブ ③居住区の小さな窓の列
 * ④開いた格納庫 ⑤大小のグリーブル を重ねる。
 * 人が住んでいる大きさの手掛かりを、機体には無い密度で置く。
 */
function buildWarship(_def: ShipDef, k: Keys, rng: Rng): PartBuilder {
  const b = new PartBuilder();
  const L = 118; // 船体長の基準

  // ── 主船体: 段を付けて厚みを出す ──
  b.add(BOX, k.hull, { pos: [0, 0, 0], scale: [22, 13, L] });
  b.add(BOX, k.hull, { pos: [0, 7.2, -4], scale: [17.5, 3.2, L * 0.82] });
  b.add(BOX, k.hull, { pos: [0, -7.4, -2], scale: [18.5, 3.0, L * 0.86] });
  b.add(BOX, k.hull, { pos: [0, 0, -46], scale: [17, 10.5, 30] });
  b.add(CONE, k.hull, { pos: [0, 0, -74], scale: [16.5, 10, 26] });
  // 艦首の衝角と装甲帯
  b.add(BOX, k.accent, { pos: [0, 0, -72], scale: [6, 3.2, 20] });
  for (const s of [-1, 1]) {
    b.add(BOX, k.accent, { pos: [s * 11.4, 0, -10], scale: [1.4, 9, L * 0.8] });
    b.add(BOX, k.panel, { pos: [s * 12.2, 0, -10], scale: [0.5, 6.5, L * 0.76] });
  }

  // ── 構造リブ: 等間隔の肋材。長さの手掛かりになる ──
  for (let i = 0; i < 13; i++) {
    const z = -58 + i * 9.6;
    b.add(BOX, k.panel, { pos: [0, 0, z], scale: [23.2, 13.6, 1.1] });
    b.addMirrored(BOX, k.dark, { pos: [11.9, 0, z], scale: [0.5, 11, 2.2] });
  }

  // ── 居住区の窓列: 小さく暗い光を大量に並べる ──
  for (let row = 0; row < 3; row++) {
    const y = 4.6 - row * 4.6;
    for (let i = 0; i < 22; i++) {
      if (rng.chance(0.22)) continue; // 消えている部屋があるほうが生活感が出る
      const z = -52 + i * 4.9;
      b.addMirrored(BOX, k.windowLit, { pos: [11.35, y, z], scale: [0.25, 0.55, 1.5] });
    }
  }

  // ── 飛行甲板と格納庫 ──
  b.add(BOX, k.accent, { pos: [0, -6.2, -6], scale: [34, 3.4, 72] });
  b.add(BOX, k.dark, { pos: [0, -8.1, -6], scale: [30, 0.7, 66] });
  // 開口部 (奥に照らされた床が見える)
  b.add(BOX, k.dark, { pos: [0, -8.2, -44], scale: [8.5, 6.0, 16] });
  b.add(BOX, k.lamp, { pos: [0, -9.6, -44], scale: [7.0, 0.3, 14] });
  b.add(DISC, k.glow, { pos: [0, -8.2, -52.2], scale: 5.4, rot: [0, Math.PI, 0] });
  // 甲板の誘導灯 (点ではなく短い線を間隔を空けて置く)
  for (let i = 0; i < 9; i++) {
    b.addMirrored(BOX, k.lamp, { pos: [15.6, -7.6, -36 + i * 8.4], scale: [1.0, 0.22, 2.4] });
  }
  // 着艦誘導のミラーとアレスティング構造
  b.addMirrored(BOX, k.metal, { pos: [16.4, -4.8, -20], scale: [2.6, 0.4, 6.0] });

  // ── 艦橋 ──
  b.add(BOX, k.hull, { pos: [0, 10.4, 10], scale: [13.5, 9, 24] });
  b.add(BOX, k.hull, { pos: [0, 16, 12], scale: [9.5, 4.2, 16] });
  b.add(BOX, k.panel, { pos: [0, 15.1, 12], scale: [10.2, 0.5, 15] });
  b.add(BOX, k.glass, { pos: [0, 13.4, -2.4], scale: [10.5, 2.2, 0.9] });
  b.add(BOX, k.glass, { pos: [0, 17.4, 4.4], scale: [7.4, 1.7, 0.9] });
  for (const s of [-1, 1]) {
    b.add(BOX, k.glass, { pos: [s * 6.9, 13.4, 10], scale: [0.9, 2.0, 14] });
  }
  // マスト・レーダー・アンテナ
  b.add(TUBE, k.metal, { pos: [0, 23, 13], scale: [1.2, 1.2, 18], rot: [HALF_PI, 0, 0] });
  b.add(SPH, k.red, { pos: [0, 32, 13], scale: 1.2 });
  b.add(BOX, k.dark, { pos: [0, 21.5, 5], scale: [7.4, 5.2, 0.6], rot: [0, 0, 0.22] });
  b.add(BOX, k.metal, { pos: [0, 21.5, 5.5], scale: [6.8, 4.6, 0.25], rot: [0, 0, 0.22] });
  b.add(TORUS_FLAT, k.metal, { pos: [0, 19, 22], scale: 3.4, rot: [0.5, 0, 0] });
  for (const s of [-1, 1]) {
    b.add(TUBE, k.metal, { pos: [s * 5, 20, 20], scale: [0.3, 0.3, 9], rot: [HALF_PI, 0, 0] });
  }

  // ── 砲塔の台座 (砲塔自体は RenderSync が実体に付ける) ──
  for (const s of [-1, 1]) {
    for (let i = 0; i < 5; i++) {
      const z = -44 + i * 24;
      b.add(BOX, k.accent, { pos: [s * 11.2, 5.0, z], scale: [5.0, 5.0, 7.0] });
      b.add(CYL_LOW, k.dark, { pos: [s * 12.0, 7.4, z], scale: [4.0, 4.0, 1.4], rot: [HALF_PI, 0, 0] });
    }
    // スポンソン (艦尾の張り出し)
    b.add(BOX, k.accent, { pos: [s * 12, 2, 44], scale: [3.6, 16, 26] });
    b.add(BOX, k.dark, { pos: [s * 12.4, 2, 44], scale: [0.5, 13, 22] });
    b.add(BOX, k.panel, { pos: [s * 12, -6, 44], scale: [3.8, 2.0, 24] });
  }

  // ── 機関部 ──
  engine(b, k, [-8, 0, 61], 4.4, 13);
  engine(b, k, [8, 0, 61], 4.4, 13);
  engine(b, k, [0, 6.8, 61], 3.4, 11);
  engine(b, k, [0, -6.8, 61], 3.4, 11);
  b.add(BOX, k.panel, { pos: [0, 0, 58], scale: [23, 14, 6] });

  navLights(b, k, [12.8, 8.8, -60], [0, 18.5, 58]);
  // 大小のグリーブルを2段階で撒く (近づくほど密度が出る)
  greebles(b, k, rng, 52, { x: [2, 10.5], y: [-5, 6.5], z: [-60, 55] });
  greebles(b, k, rng, 30, { x: [0, 6], y: [6.6, 8.4], z: [-50, 48] });
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
const gltfLoader = new GLTFLoader();
const gltfTemplates = new Map<string, Promise<Object3D>>();

/**
 * 外部アセットの指定を正規化する。data/blob/javascript URL はゲームの
 * 同梱アセット指定として扱わず、相対パス・絶対パス・http(s) URL のみ許可する。
 */
export function gltfUrlFor(value: string | undefined): string | undefined {
  const url = value?.trim();
  if (!url || /[\u0000-\u001f\u007f]/.test(url)) return undefined;
  // 相対 URL、/ から始まる URL、http(s) だけを許可する。
  // GLTFLoader に任意スキームを渡さないことで、アセット指定の境界を明確にする。
  if (/^[a-z][a-z\d+.-]*:/i.test(url) && !/^https?:\/\//i.test(url)) return undefined;
  return url;
}

function hasRenderableMesh(root: Object3D): boolean {
  let found = false;
  root.traverse((node) => {
    if ((node as Object3D & { isMesh?: boolean }).isMesh === true) found = true;
  });
  return found;
}

/** GLTF の原点を中央へ寄せ、最大辺が 1 のテンプレートへ正規化する。 */
function prepareGltfTemplate(scene: Object3D): Object3D {
  const model = scene;
  model.updateMatrixWorld(true);
  const bounds = new Box3().setFromObject(model);
  if (bounds.isEmpty() || !hasRenderableMesh(model)) throw new Error('GLTF scene has no renderable mesh');

  const dimensions = bounds.getSize(new Vector3());
  const longestSide = Math.max(dimensions.x, dimensions.y, dimensions.z);
  if (!Number.isFinite(longestSide) || longestSide <= 1e-6) throw new Error('GLTF scene has no measurable size');

  // 手続き生成側は機体の中心を原点に置く。原点がずれたモデルでも、
  // 噴射炎・デカール・砲塔との相対位置が大きく破綻しないよう中央へ寄せる。
  model.position.sub(bounds.getCenter(new Vector3()));
  model.scale.setScalar(1 / longestSide);
  model.updateMatrixWorld(true);
  return model;
}

function gltfTemplateFor(url: string): Promise<Object3D> {
  const cached = gltfTemplates.get(url);
  if (cached) return cached;

  const pending = new Promise<Object3D>((resolve, reject) => {
    gltfLoader.load(
      url,
      (gltf) => {
        try {
          // キャッシュするテンプレートは共有し、実体ごとに SkeletonUtils.clone() する。
          resolve(prepareGltfTemplate(gltf.scene));
        } catch (error) {
          reject(error);
        }
      },
      undefined,
      (error) => reject(error),
    );
  });
  gltfTemplates.set(url, pending);
  // 壊れたアセットを永久にキャッシュせず、修正後の再試行を可能にする。
  void pending.catch(() => {
    if (gltfTemplates.get(url) === pending) gltfTemplates.delete(url);
  });
  return pending;
}

function replaceShipVisual(target: Object3D, visual: Object3D): void {
  const previous = target.userData.shipVisual as Object3D | undefined;
  if (previous?.parent === target) target.remove(previous);
  target.add(visual);
  target.userData.shipVisual = visual;
  target.userData.shipVisualSource = 'gltf';
}

export interface ShipVisualRequest {
  readonly state: ShipVisualLifecycle['state'];
  cancel(): void;
}

/**
 * 指定された GLTF を非同期で読み込み、成功時だけ target のビジュアル子を交換する。
 * 戻り値を cancel すれば、エンティティ消滅後の遅延ロードを安全に無効化できる。
 */
export function requestShipVisual(
  def: ShipDef,
  target: Object3D,
  onFailure?: (error: unknown) => void,
): ShipVisualRequest {
  const url = gltfUrlFor(def.visual.gltf);
  const lifecycle = new ShipVisualLifecycle(
    (visual) => replaceShipVisual(target, visual),
    onFailure,
  );
  if (url) {
    lifecycle.start(() =>
      gltfTemplateFor(url).then((template) => {
        const instance = cloneSkinnedObject(template);
        instance.scale.setScalar(def.size * 2);
        instance.updateMatrixWorld(true);
        return instance;
      }),
    );
  }
  return lifecycle;
}

function buildTemplate(def: ShipDef): Object3D {
  const k = keysFor(def.visual);
  // 機体 id を種にすることで、同型機のグリーブル配置は毎回同じになる
  let seed = 0;
  for (let i = 0; i < def.id.length; i++) seed = (seed * 31 + def.id.charCodeAt(i)) >>> 0;
  const builder = BUILDERS[def.visual.kind] ?? buildArrow;
  const parts = builder(def, k, new Rng(seed || 1));
  // 陣営の癖を上乗せする (骨格は共用しつつ シルエット を変える)
  if (def.visual.style === 'kilrathi') {
    const len = VISUAL_BASE_HALF_LENGTH[def.visual.kind];
    clawMotifs(parts, k, len, len * (def.visual.kind === 'hauler' || def.visual.kind === 'warship' ? 0.3 : 0.9));
  }
  const group = parts.build(resolveMaterial);
  group.scale.setScalar(def.size / VISUAL_BASE_HALF_LENGTH[def.visual.kind]);
  const root = new Group();
  root.add(group);
  root.userData.shipVisual = group;
  root.userData.shipVisualSource = 'procedural';
  return root;
}

/**
 * 機体定義からメッシュを作る。
 * visual.gltf の指定があっても、ここでは同期の手続き生成を返す。
 * GLTF の非同期差し替えは requestShipVisual() が担当する。
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
  // 岩肌は生成テクスチャで出す。色は明るめに乗算して、黒い宇宙でも形が読めるようにする
  const body = `rock:${variant}`;
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

/**
 * 艦艇の砲塔。的を追って回るので、機体テンプレートとは別に実体へ付ける。
 *
 * `Object3D.lookAt()` が向けるのは +Z なので、砲身は +Z 向きに組む
 * (機体メッシュの前方 -Z とは逆)。
 */
export function createTurretMesh(visual: VisualDef): Object3D {
  const k = keysFor(visual);
  const b = new PartBuilder();
  // 台座 (回らない部分に見えるよう低く広く)
  b.add(CYL_LOW, k.dark, { pos: [0, -0.5, 0], scale: [3.4, 3.4, 1.2], rot: [HALF_PI, 0, 0] });
  // 砲塔の箱と防盾
  b.add(BOX, k.accent, { pos: [0, 0.5, 0], scale: [3.0, 1.8, 3.4] });
  b.add(SPH, k.metal, { pos: [0, 1.0, 0], scale: 2.1 });
  b.add(BOX, k.panel, { pos: [0, 0.9, 1.5], scale: [2.4, 1.4, 0.5] });
  // 連装砲身 (+Z)
  for (const s of [-1, 1]) {
    b.add(TUBE, k.metal, { pos: [s * 0.7, 0.9, 3.4], scale: [0.42, 0.42, 5.2] });
    b.add(CYL_LOW, k.dark, { pos: [s * 0.7, 0.9, 6.1], scale: [0.5, 0.5, 0.5] });
  }
  const group = b.build(resolveMaterial);
  const root = new Group();
  root.add(group);
  return root;
}

export function disposeMaterialCache(): void {
  for (const m of matCache.values()) m.dispose();
  matCache.clear();
  templates.clear();
  gltfTemplates.clear();
  rockTemplates.clear();
  mineTemplate = undefined;
}
