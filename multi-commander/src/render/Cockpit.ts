import {
  BoxGeometry,
  CylinderGeometry,
  Euler,
  Group,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  PointLight,
  Quaternion,
  SphereGeometry,
  Vector3,
  type PerspectiveCamera,
  type Scene,
} from 'three';
import { PartBuilder } from './PartBuilder';
import { textureAlpha } from './textures';

/**
 * コクピット内装。カメラに追従させ、機体と一緒に揺れるようにする。
 *
 * 計器そのものは DOM 側 (HudView) が担当するので、ここでは
 * 「風防の枠・柱・天蓋・計器盤の筐体・側面コンソール」といった構造物だけを作る。
 *
 * 構図の方針 (specs/02_改善案の詳細.md ⑦):
 *   - 上下左右を黒帯で狭めるのではなく、風防の枠を実際に描いて四隅を締める。
 *   - **画面中央 60% (|NDC| <= 0.3) には一切入り込まない。**
 *     部品は NDC 指定 (`at()` / `spanX()` / `spanY()`) で置き、
 *     `intrudesCenterWindow()` で機械的に検証できるようにしている。
 *   - 部品はすべてカメラの near 面 (0.5) より手前に置かない。
 *     near 面を跨いだ部品は途中で切られて「宙に浮いた斜めの棒」に見えるため
 *     (旧実装の主柱がこれだった)。`nearestDistance()` で検証する。
 */

const HALF_PI = Math.PI / 2;
const BOX = new BoxGeometry(1, 1, 1);
const TUBE = (() => {
  const g = new CylinderGeometry(0.5, 0.5, 1, 10, 1, false);
  g.rotateX(HALF_PI);
  return g;
})();
const SPH = new SphereGeometry(0.5, 10, 8);
const PLANE = new PlaneGeometry(1, 1);

/** 内装の色。機体の外装より暗く、計器の緑が映える色味にする。 */
const FRAME = 'frame';
const FRAME_DARK = 'frameDark';
const PANEL = 'panel';
const SCREEN = 'screen';
const LAMP_G = 'lampG';
const LAMP_A = 'lampA';
const LAMP_R = 'lampR';
const PANEL_ART = 'panelArt';
const PANEL_WEAR = 'panelWear';
const RIVET = 'rivet';

/*
 * 内装のマテリアルは 6種だけ (FRAME / FRAME_DARK / RIVET / PANEL / SCREEN / ランプ)。
 * PartBuilder がマテリアル単位でジオメトリを畳むので、この 6種の中で部品を増やす限り
 * ドローコールは増えない。新しい色を足すたびに 1ドローコール増えるので足さない。
 *
 * シーン側には AmbientLight + HemisphereLight + 太陽 + 補助光 + 環境マップがあり
 * (SceneSetup)、内装は至近距離でそれを全部受ける。素の色が明るいと
 * 「無地の明るい灰色の板」になってしまうので、内装の色は外装よりかなり暗くし、
 * 環境マップの寄与も `envMapIntensity` で抑えて、形は陰影とリブで出す。
 */
function material(key: string) {
  switch (key) {
    case FRAME:
      return new MeshStandardMaterial({
        color: 0x1c2329,
        roughness: 0.78,
        metalness: 0.18,
        envMapIntensity: 0.25,
        flatShading: true,
      });
    case FRAME_DARK:
      return new MeshStandardMaterial({
        color: 0x0b0e11,
        roughness: 0.92,
        metalness: 0.08,
        envMapIntensity: 0.12,
        flatShading: true,
      });
    case RIVET:
      return new MeshStandardMaterial({
        color: 0x2d353c,
        roughness: 0.5,
        metalness: 0.45,
        envMapIntensity: 0.35,
        flatShading: true,
      });
    case PANEL:
      return new MeshStandardMaterial({
        color: 0x121820,
        roughness: 0.85,
        metalness: 0.12,
        envMapIntensity: 0.15,
        flatShading: true,
      });
    case SCREEN:
      return new MeshBasicMaterial({ color: 0x0a2a22 });
    case LAMP_G:
      return new MeshBasicMaterial({ color: 0x54e0a0 });
    case LAMP_A:
      return new MeshBasicMaterial({ color: 0xffb347 });
    case LAMP_R:
      return new MeshBasicMaterial({ color: 0xff4d4d });
    case PANEL_ART:
      // 計器盤のラベル類。透過画像なので下の面の色が透ける
      return new MeshBasicMaterial({
        map: textureAlpha('panel-overlay'),
        transparent: true,
        opacity: 0.85,
        depthWrite: false,
      });
    case PANEL_WEAR:
      return new MeshBasicMaterial({
        map: textureAlpha('panel-wear'),
        transparent: true,
        opacity: 0.5,
        depthWrite: false,
      });
    default:
      return new MeshStandardMaterial({ color: 0x333333 });
  }
}

// ───────── 画面座標 (NDC) と内装の座標の対応 ─────────

/** 構図を決めた基準の画面比。16:9 (1280×720 / 1366×768) を基準にする。 */
export const REF_ASPECT = 16 / 9;
/** 基準の画角。CameraRig の BASE_FOV と同じ。 */
export const REF_FOV = 70;
const TAN_HALF_REF_FOV = Math.tan(((REF_FOV / 2) * Math.PI) / 180); // ≒ 0.7002
/** カメラの near 面。SceneSetup の PerspectiveCamera と同じ。 */
export const CAMERA_NEAR = 0.5;

/** 距離 dist の面で、NDC.y 1.0 に相当する縦の長さ */
function unitY(dist: number): number {
  return dist * TAN_HALF_REF_FOV;
}
/** 距離 dist の面で、NDC.x 1.0 に相当する横の長さ */
function unitX(dist: number): number {
  return unitY(dist) * REF_ASPECT;
}
/** 画面上の位置 (NDC) と前方距離から内装の座標を出す */
function at(ndcX: number, ndcY: number, dist: number): [number, number, number] {
  return [ndcX * unitX(dist), ndcY * unitY(dist), -dist];
}
/** 画面上の横幅 (NDC) を距離 dist での長さに直す */
function spanX(ndcW: number, dist: number): number {
  return ndcW * unitX(dist);
}
/** 画面上の高さ (NDC) を距離 dist での長さに直す */
function spanY(ndcH: number, dist: number): number {
  return ndcH * unitY(dist);
}

// ───────── 構図の基準値 ─────────

/** 風防の枠を置く距離 */
const WIN = 1.42;
/** 計器盤を置く距離 */
const DASH = 1.3;

/**
 * 風防の開口部 (NDC)。ここより内側には構造物を置かない。
 * 中央 60% (|NDC| <= 0.3) に対して、横は 0.70、縦は上 0.575 / 下 -0.48 なので
 * 余裕がある。下端は DOM 計器盤 (`.mc-cockpit`) の上端と揃えている
 * (720px 高で計器盤 150px + メッセージ帯 38px → NDC.y ≒ -0.478)。
 */
const OPEN_SIDE = 0.7;
const OPEN_TOP = 0.66;
const OPEN_BOTTOM = -0.4;

/**
 * 「中央 60% を抜く」の判定に使う矩形の大きさ (画面全体に対する割合)。
 * 画面中央から左右 30% / 上下 30% なので、NDC では |x| <= 0.6 / |y| <= 0.6。
 * 枠 (天蓋・柱) はこの矩形の外に置く。
 * 計器盤の下端だけは例外で、DOM 計器盤 (`.mc-cockpit`) の上端に合わせている
 * (計器を読ませるための面なので、装飾 OFF の現状と同じ高さより上げない)。
 */
export const CENTER_CLEAR_RATIO = 0.6;
/** 計器盤より上の構造物 (枠・天蓋・柱) が守る中央の空き矩形 (NDC 半幅) */
export const CENTER_CLEAR_HALF = CENTER_CLEAR_RATIO;

// ───────── 部品の定義 ─────────

export type CockpitGeoKind = 'box' | 'tube' | 'sphere' | 'plane';

/**
 * 部品の役割。
 * 'frame' = 風防の枠・柱・天蓋・側壁 (中央 60% の外に置く)
 * 'dash'  = 計器盤の筐体 (DOM 計器盤の上端より下に置く)
 */
export type CockpitZone = 'frame' | 'dash';

/** 内装の部品 1つ。位置・向き・寸法だけを持つ純データ (検証できるように外へ出す)。 */
export interface CockpitPart {
  readonly geo: CockpitGeoKind;
  readonly mat: string;
  readonly zone: CockpitZone;
  readonly pos: readonly [number, number, number];
  readonly rot: readonly [number, number, number];
  readonly scale: readonly [number, number, number];
}

interface Place {
  pos: [number, number, number];
  rot?: [number, number, number];
  scale?: [number, number, number] | number;
  zone?: CockpitZone;
}

function part(geo: CockpitGeoKind, mat: string, o: Place): CockpitPart {
  const scale = o.scale ?? 1;
  return {
    geo,
    mat,
    zone: o.zone ?? 'frame',
    pos: o.pos,
    rot: o.rot ?? [0, 0, 0],
    scale: typeof scale === 'number' ? [scale, scale, scale] : scale,
  };
}

/** 左右対称に 2つ返す (x と rot.y / rot.z を反転) */
function mirrored(geo: CockpitGeoKind, mat: string, o: Place): CockpitPart[] {
  const a = part(geo, mat, o);
  return [
    a,
    {
      ...a,
      pos: [-a.pos[0], a.pos[1], a.pos[2]],
      rot: [a.rot[0], -a.rot[1], -a.rot[2]],
    },
  ];
}

/**
 * 内装の全部品。
 *
 * 「風防の枠 (開口部の縁)」→「天蓋」→「側壁」→「計器盤」の順に組む。
 * 枠は開口部の縁に沿った細い桁で、その外側を天蓋と側壁が
 * カメラ側へ後退しながら覆う。後退することで遠近が付き、
 * 「黒帯」ではなく「囲まれた風防」として読める。
 */
export function cockpitParts(): CockpitPart[] {
  const p: CockpitPart[] = [];

  // ── 天蓋の縁 (開口部の上辺) ──
  // 上辺は NDC.y 0.675〜0.795。中央 60% の上限 0.6 より上に置く。
  p.push(part('box', FRAME, {
    pos: at(0, 0.735, WIN),
    scale: [spanX(1.33, WIN), spanY(0.12, WIN), 0.17],
    rot: [-0.1, 0, 0],
  }));
  // 開口部の縁の暗いリップ (枠と宇宙の境目を締める)
  p.push(part('box', FRAME_DARK, {
    pos: at(0, 0.693, WIN + 0.02),
    scale: [spanX(1.32, WIN), spanY(0.035, WIN), 0.13],
  }));

  // ── 上の隅を落とす斜めの梁 (開口部の角を斜めに落とす) ──
  // NDC (0.64, 0.735) → (0.715, 0.475)。中央 60% の角 (0.6, 0.6) の外側を通る。
  {
    const innerX = 0.64;
    const innerY = 0.735;
    const outerX = OPEN_SIDE + 0.015;
    const outerY = 0.475;
    const dx = spanX(outerX - innerX, WIN);
    const dy = spanY(outerY - innerY, WIN);
    const len = Math.hypot(dx, dy);
    const ang = Math.atan2(dy, dx);
    p.push(...mirrored('box', FRAME, {
      pos: at((innerX + outerX) / 2, (innerY + outerY) / 2, WIN),
      scale: [len, spanY(0.105, WIN), 0.16],
      rot: [0, 0, ang],
    }));
  }

  // ── 風防の柱 (開口部の左右) ──
  // NDC.x 0.70〜0.81。中央 60% の 0.6 より外。
  p.push(...mirrored('box', FRAME, {
    pos: at(0.755, 0.0375, WIN),
    scale: [spanX(0.11, WIN), spanY(0.9, WIN), 0.17],
  }));
  p.push(...mirrored('box', FRAME_DARK, {
    pos: at(OPEN_SIDE + 0.015, 0.0375, WIN + 0.02),
    scale: [spanX(0.035, WIN), spanY(0.88, WIN), 0.13],
  }));
  // 柱の面を無地にしないための帯とリベット。
  // 柱は正面を向いた広い面なので、そのままだと光を一様に受けて灰色の板に見える。
  // 少し手前へ出した帯 (面の向きが変わる) と、暗い溝で明暗を作る。
  for (const y of [-0.34, -0.1, 0.15, 0.38]) {
    p.push(...mirrored('box', FRAME, {
      pos: at(0.755, y, WIN - 0.06),
      // 手前へ出すぶん画面上では大きく写るので、柱の幅 (0.11) より細くして
      // 開口部の縁からはみ出さないようにする
      scale: [spanX(0.1, WIN), spanY(0.028, WIN), 0.16],
    }));
    p.push(...mirrored('box', FRAME_DARK, {
      pos: at(0.755, y - 0.022, WIN - 0.07),
      scale: [spanX(0.104, WIN), spanY(0.012, WIN), 0.15],
    }));
  }
  for (const y of [-0.26, -0.02, 0.23, 0.46]) {
    p.push(...mirrored('sphere', RIVET, { pos: at(0.723, y, WIN - 0.1), scale: 0.02 }));
    p.push(...mirrored('sphere', RIVET, { pos: at(0.788, y, WIN - 0.1), scale: 0.02 }));
  }

  // ── 天蓋 (開口部の上辺からカメラ側へ後退する天井) ──
  // 遠端が上辺の高さ、近端は画面の上へ抜ける。近端の距離は 0.75 で near(0.5) より手前。
  p.push(part('box', FRAME_DARK, {
    pos: [0, 0.828, -1.07],
    scale: [3.7, 0.09, 0.7],
    rot: [-0.3, 0, 0],
  }));
  // 天井の桁 (遠近が分かるように 2本)
  p.push(part('box', FRAME, { pos: [0, 0.711, -1.22], scale: [3.4, 0.055, 0.075], rot: [-0.3, 0, 0] }));
  p.push(part('box', FRAME, { pos: [0, 0.81, -0.9], scale: [3.4, 0.055, 0.075], rot: [-0.3, 0, 0] }));
  // 天井中央の背骨
  p.push(part('box', FRAME, { pos: [0, 0.762, -1.05], scale: [0.075, 0.075, 0.62], rot: [-0.3, 0, 0] }));
  // 桁のリベット (天井を見上げたときの質感)
  for (let i = 0; i < 7; i++) {
    p.push(part('sphere', RIVET, { pos: [-0.75 + i * 0.25, 0.678, -1.215], scale: 0.026 }));
  }

  // ── 側壁 (柱の外側からカメラ側へ後退する壁) ──
  // rot.y でカメラ側へ広がらせ、画面の外へ抜けさせる。
  p.push(...mirrored('box', FRAME_DARK, {
    pos: [1.455, -0.05, -1.07],
    scale: [0.12, 2.2, 0.72],
    rot: [0, 0.25, 0],
  }));
  /*
   * 側壁のリブ。
   * 壁は 1枚の広い面なので、そのままだと明るい灰色のスラブに見える。
   * 壁の内側に、奥から手前へ 3本の縦リブ (壁より明るい FRAME) を立てて
   * 継ぎ目と陰影を作る。壁の x は rot.y 0.25 のぶん奥ほど内側へ寄るので、
   * 世界座標 x = 1.455 + 0.2474 * z0 / 世界座標 z = -1.07 + 0.9689 * z0 に沿わせ、
   * そこから 0.07 だけ内側 (機内側) へ出す。
   */
  for (const z0 of [-0.3, 0, 0.3]) {
    p.push(...mirrored('box', FRAME, {
      pos: [1.455 + 0.2474 * z0 - 0.07, -0.05, -1.07 + 0.9689 * z0],
      scale: [0.045, 1.9, 0.055],
      rot: [0, 0.25, 0],
    }));
  }
  // 壁と天蓋の境目に走る桁 (上の隅の輪郭を出す)
  p.push(...mirrored('box', FRAME, {
    pos: [1.4, 0.62, -1.07],
    scale: [0.09, 0.07, 0.68],
    rot: [0, 0.25, 0],
  }));
  // 頬当て (下の隅を締める side console)
  p.push(...mirrored('box', PANEL, {
    pos: [1.3, -0.32, -1.25],
    scale: [0.3, 0.3, 0.16],
    rot: [0, 0.3, 0],
  }));
  // 頬当ての天面の暗い面取りと縁。無地の板に見えないようにする
  p.push(...mirrored('box', FRAME_DARK, {
    pos: [1.3, -0.175, -1.245],
    scale: [0.31, 0.035, 0.17],
    rot: [0.22, 0.3, 0],
  }));
  p.push(...mirrored('box', FRAME, {
    pos: [1.285, -0.4, -1.262],
    scale: [0.29, 0.03, 0.14],
    rot: [0, 0.3, 0],
  }));
  p.push(...mirrored('plane', SCREEN, {
    pos: [1.24, -0.3, -1.29],
    scale: [0.16, 0.12, 1],
    rot: [0, 0.3, 0],
  }));
  p.push(...mirrored('sphere', RIVET, { pos: [1.245, -0.205, -1.293], scale: 0.019 }));
  p.push(...mirrored('sphere', RIVET, { pos: [1.335, -0.205, -1.265], scale: 0.019 }));
  // 側面の握り
  p.push(...mirrored('tube', FRAME, {
    pos: [1.28, -0.34, -1.15],
    scale: [0.05, 0.05, 0.4],
    rot: [0.35, 0, 0],
  }));

  // ── 計器盤 ──
  // 縁 (コーミング) の上端を開口部の下端 (NDC -0.40) に合わせる。
  // DOM の計器パネルの上端 (720px 高で NDC -0.478) のすぐ上なので、
  // 3D の筐体と DOM の計器が 1枚の計器盤として繋がって見える。
  p.push(part('box', FRAME, { pos: [0, -0.5, -DASH], scale: [3.5, 0.1, 0.22], rot: [-0.25, 0, 0], zone: 'dash' }));
  p.push(part('box', FRAME_DARK, { pos: [0, -0.46, -1.32], scale: [3.5, 0.035, 0.18], rot: [-0.25, 0, 0], zone: 'dash' }));
  // 縁のいちばん手前の細いリップ。
  // ここには以前 MeshBasicMaterial の発光ライン (0x4fbf96) を置いていたが、
  // 光源に影響されない原色なので、開口部の下端に明るい緑の横線が全幅に走って見えた。
  // 発光はやめて、金属の面として陰影に任せる。
  p.push(part('box', FRAME, { pos: [0, -0.4555, -1.363], scale: [3.4, 0.022, 0.03], rot: [-0.25, 0, 0], zone: 'dash' }));
  // 計器盤の前面 (DOM の計器パネルの背後に来る面)。画面の下端まで覆う
  p.push(part('box', PANEL, { pos: [0, -0.84, -1.16], scale: [3.5, 0.78, 0.5], rot: [-0.35, 0, 0], zone: 'dash' }));
  // 計器盤の面に貼るディテール (ラベル・傷・注意書き)
  p.push(part('plane', PANEL_ART, { pos: [0, -0.82, -1.14], scale: [3.42, 0.74, 1], rot: [-0.35, 0, 0], zone: 'dash' }));
  p.push(part('plane', PANEL_WEAR, { pos: [0, -0.5, -1.315], scale: [3.4, 0.22, 1], rot: [-0.25, 0, 0], zone: 'dash' }));

  // ── 計器盤の上に載る小物 (縁のすぐ上に覗く) ──
  for (const s of [-1, 1]) {
    p.push(part('box', FRAME_DARK, { pos: [s * 1.12, -0.6, -1.24], scale: [0.5, 0.26, 0.1], rot: [-0.3, 0, 0], zone: 'dash' }));
    p.push(part('plane', SCREEN, { pos: [s * 1.12, -0.58, -1.28], scale: [0.42, 0.18, 1], rot: [-0.3, 0, 0], zone: 'dash' }));
  }
  const lamps = [LAMP_R, LAMP_A, LAMP_G, LAMP_G, LAMP_A, LAMP_R];
  lamps.forEach((key, i) => {
    p.push(part('sphere', key, { pos: [-0.42 + i * 0.168, -0.555, -1.29], scale: 0.035, zone: 'dash' }));
  });
  for (let i = 0; i < 8; i++) {
    p.push(...mirrored('box', FRAME, {
      pos: [0.62 + (i % 4) * 0.1, -0.62, -1.26],
      scale: [0.05, 0.045, 0.09],
      rot: [-0.3, 0, 0],
      zone: 'dash',
    }));
  }

  return p;
}

/** 開口部 (NDC) を外へ知らせる。テストとドキュメントの参照用。 */
export const COCKPIT_OPENING = {
  side: OPEN_SIDE,
  top: OPEN_TOP,
  bottom: OPEN_BOTTOM,
} as const;

/** 計器盤の上端 (NDC)。ここより上に計器盤の部品を出さない。 */
export const DASH_TOP_NDC = OPEN_BOTTOM;

// ───────── 構図の検証 (純関数) ─────────

export interface ViewSpec {
  aspect: number;
  fovDeg: number;
}

/** 部品の 8隅を出す。tube / sphere は外接する箱、plane は厚み 0 として扱う。 */
function corners(p: CockpitPart): Vector3[] {
  const hx = p.scale[0] / 2;
  const hy = p.scale[1] / 2;
  const hz = p.geo === 'plane' ? 0 : p.scale[2] / 2;
  // PartBuilder と同じ Euler (既定順序 XYZ) で回す
  const q = new Quaternion().setFromEuler(new Euler(p.rot[0], p.rot[1], p.rot[2]));
  const out: Vector3[] = [];
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        out.push(
          new Vector3(sx * hx, sy * hy, sz * hz).applyQuaternion(q).add(new Vector3(p.pos[0], p.pos[1], p.pos[2])),
        );
      }
    }
  }
  return out;
}

/** 部品のいちばんカメラに近い点までの距離 (前方 -Z を正とする) */
export function nearestDistance(p: CockpitPart): number {
  let near = Infinity;
  for (const c of corners(p)) near = Math.min(near, -c.z);
  return near;
}

/**
 * 画角と画面比の補正。
 *
 * 内装は 16:9 / FOV 70 の構図で作ってあるので、そのままだと
 *  - 16:9 より横長の画面では枠が画面中央へ寄る
 *  - アフターバーナーで FOV が広がると枠が中央へ寄り、計器盤が DOM 計器盤とずれる
 * という 2つのズレが出る。内装を x/y だけ拡大して、画面上の位置を一定に保つ。
 * (z は変えないので near 面との余裕は変わらない)
 */
export function viewCompensation(view: ViewSpec): { sx: number; sy: number } {
  const k = Math.tan(((view.fovDeg / 2) * Math.PI) / 180) / TAN_HALF_REF_FOV;
  // 4:3 側では枠が外へ逃げるだけなので補正しない (視界が広がる方向)
  const wide = Math.max(1, view.aspect / REF_ASPECT);
  return { sx: k * wide, sy: k };
}

/** 部品の 8隅を画面へ投影した点 (NDC) */
export function partNdcPoints(p: CockpitPart, view: ViewSpec): Array<[number, number]> {
  const tanHalf = Math.tan(((view.fovDeg / 2) * Math.PI) / 180);
  const { sx, sy } = viewCompensation(view);
  return corners(p).map((c) => {
    const dist = Math.max(1e-4, -c.z);
    const halfH = dist * tanHalf;
    return [(c.x * sx) / (halfH * view.aspect), (c.y * sy) / halfH] as [number, number];
  });
}

/** 部品が画面上で占める外接矩形 (NDC)。 */
export function partNdcBounds(p: CockpitPart, view: ViewSpec): {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
} {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [x, y] of partNdcPoints(p, view)) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  return { minX, maxX, minY, maxY };
}

/**
 * 部品が画面中央の矩形へ入り込んでいるか。
 *
 * 部品は箱なので投影した 8点の凸包が画面上の形になる。
 * 凸包と矩形はどちらも凸なので、分離軸 (矩形の 2軸 + 凸包の各辺の法線) で判定する。
 * 外接矩形で判定すると斜めの梁が実際より広く出て、隅を締められないため。
 *
 * half は NDC の半幅。既定の 0.6 は「画面中央から左右 30% / 上下 30%」= 中央 60%。
 */
export function intrudesCenterWindow(
  p: CockpitPart,
  view: ViewSpec,
  half = CENTER_CLEAR_HALF,
): boolean {
  const pts = partNdcPoints(p, view);
  const rect: Array<[number, number]> = [
    [-half, -half],
    [half, -half],
    [half, half],
    [-half, half],
  ];
  const axes: Array<[number, number]> = [[1, 0], [0, 1]];
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const dx = pts[j][0] - pts[i][0];
      const dy = pts[j][1] - pts[i][1];
      const len = Math.hypot(dx, dy);
      if (len > 1e-6) axes.push([-dy / len, dx / len]);
    }
  }
  for (const [ax, ay] of axes) {
    let aMin = Infinity;
    let aMax = -Infinity;
    for (const [x, y] of pts) {
      const d = x * ax + y * ay;
      aMin = Math.min(aMin, d);
      aMax = Math.max(aMax, d);
    }
    let bMin = Infinity;
    let bMax = -Infinity;
    for (const [x, y] of rect) {
      const d = x * ax + y * ay;
      bMin = Math.min(bMin, d);
      bMax = Math.max(bMax, d);
    }
    // 1つでも分離できる軸があれば重なっていない
    if (aMax <= bMin || bMax <= aMin) return false;
  }
  return true;
}

// ───────── 組み立て ─────────

function geometryOf(kind: CockpitGeoKind) {
  switch (kind) {
    case 'tube':
      return TUBE;
    case 'sphere':
      return SPH;
    case 'plane':
      return PLANE;
    default:
      return BOX;
  }
}

function buildInterior(): Object3D {
  const b = new PartBuilder();
  for (const p of cockpitParts()) {
    b.add(geometryOf(p.geo), p.mat, {
      pos: [p.pos[0], p.pos[1], p.pos[2]],
      rot: [p.rot[0], p.rot[1], p.rot[2]],
      scale: [p.scale[0], p.scale[1], p.scale[2]],
    });
  }
  const materials = new Map<string, ReturnType<typeof material>>();
  return b.build((key) => {
    let m = materials.get(key);
    if (!m) {
      m = material(key);
      materials.set(key, m);
    }
    return m;
  });
}

/**
 * カメラに固定されるコクピット。
 *
 * シーン全体のスケールと桁が違うので、専用のスケールで縮めてから
 * カメラの子として吊る (カメラの near は 0.5 なので、内装は 0.7〜2.0 に収まる大きさにする)。
 */
export class Cockpit {
  readonly root = new Group();
  private interior: Object3D;
  private visible = true;
  private glow: PointLight;

  constructor(scene: Scene, private camera: PerspectiveCamera) {
    this.interior = buildInterior();
    this.root.add(this.interior);
    // 計器盤の下から当てる淡い光。太陽の向きに関わらず内装の形が読めるようにする
    this.glow = new PointLight(0x8fd8c0, 1.3, 3.2, 2);
    this.glow.position.set(0, -0.5, -0.9);
    this.root.add(this.glow);
    // 天蓋と側壁を照らす弱い光。枠の面が真っ黒に落ちないようにする。
    // 強くすると側壁が「無地の明るい灰色の板」になるので、リブの陰影が出る強さで止める。
    const fill = new PointLight(0x7796b8, 0.22, 3.6, 2);
    fill.position.set(0, 0.05, 0.35);
    this.root.add(fill);
    // カメラの子にすることで、カメラの揺れと一体で動く
    this.camera.add(this.root);
    scene.add(this.camera);
    this.syncToView();
    // 画角・画面比が変わっても構図を保つ。描画直前に見て次フレームへ反映する
    for (const child of this.interior.children) {
      child.onBeforeRender = () => this.syncToView();
    }
  }

  /** 画面比と画角の変化を打ち消して、枠の画面上の位置を一定に保つ */
  syncToView(): void {
    const { sx, sy } = viewCompensation({
      aspect: this.camera.aspect || REF_ASPECT,
      fovDeg: this.camera.fov || REF_FOV,
    });
    if (this.root.scale.x !== sx || this.root.scale.y !== sy) this.root.scale.set(sx, sy, 1);
  }

  /**
   * 損傷に応じて内装の光を変える。
   * 風防のひび割れオーバーレイは視界を優先して廃止したので、
   * 「機内が非常灯の色に変わる」ことで損傷を伝える。
   */
  update(hullRatio: number): void {
    this.syncToView();
    const t = Math.max(0, Math.min(1, (0.6 - hullRatio) / 0.6));
    // 緑 → 橙 へ寄せる (点滅はさせない)
    const r = 0x8f + Math.round((0xff - 0x8f) * t);
    const g = 0xd8 - Math.round((0xd8 - 0x8a) * t);
    const b = 0xc0 - Math.round((0xc0 - 0x5a) * t);
    this.glow.color.setRGB(r / 255, g / 255, b / 255);
    this.glow.intensity = 1.3 + t * 0.5;
  }

  setVisible(v: boolean): void {
    // 毎フレーム呼ばれる経路なので、ここでも構図の補正を掛けておく
    this.syncToView();
    if (this.visible === v) return;
    this.visible = v;
    this.root.visible = v;
  }
}
