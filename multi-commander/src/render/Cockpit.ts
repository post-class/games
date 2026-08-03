import {
  BoxGeometry,
  CylinderGeometry,
  Group,
  PointLight,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  SphereGeometry,
  type PerspectiveCamera,
  type Scene,
} from 'three';
import { PartBuilder } from './PartBuilder';

/**
 * コクピット内装。カメラに追従させ、機体と一緒に揺れるようにする。
 *
 * 計器そのものは DOM 側 (HudView) が担当するので、ここでは
 * 「風防の枠・柱・計器盤の筐体・側面コンソール」といった構造物だけを作る。
 * 視界を塞がないよう、正面の広い範囲は必ず開けておく。
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
const RUBBER = 'rubber';
const SCREEN = 'screen';
const LAMP_G = 'lampG';
const LAMP_A = 'lampA';
const LAMP_R = 'lampR';
const EDGE = 'edge';

function material(key: string) {
  switch (key) {
    case FRAME:
      return new MeshStandardMaterial({ color: 0x2a333b, roughness: 0.6, metalness: 0.3, flatShading: true });
    case FRAME_DARK:
      return new MeshStandardMaterial({ color: 0x13181d, roughness: 0.85, metalness: 0.15, flatShading: true });
    case PANEL:
      return new MeshStandardMaterial({ color: 0x1a2127, roughness: 0.72, metalness: 0.2, flatShading: true });
    case RUBBER:
      return new MeshStandardMaterial({ color: 0x0b0e11, roughness: 0.95, metalness: 0.05 });
    case SCREEN:
      return new MeshBasicMaterial({ color: 0x0a2a22 });
    case LAMP_G:
      return new MeshBasicMaterial({ color: 0x54e0a0 });
    case LAMP_A:
      return new MeshBasicMaterial({ color: 0xffb347 });
    case LAMP_R:
      return new MeshBasicMaterial({ color: 0xff4d4d });
    case EDGE:
      // 計器盤の縁の発光ライン。宇宙と計器盤の境目を視覚的に区切る
      return new MeshBasicMaterial({ color: 0x4fbf96 });
    default:
      return new MeshStandardMaterial({ color: 0x333333 });
  }
}

/**
 * 内装を組む。
 *
 * 座標系はカメラ基準 (forward = -Z, up = +Y)。
 * 画面上のどこに来るかは NDC.y ≒ worldY / (dist * tan(FOV/2)) で決まる。
 * 既定 FOV 70° なので tan35° ≒ 0.70。
 * 計器パネル (DOM) は画面下 32vh を占めるので、その上端 (NDC.y ≒ -0.36) の
 * すぐ上に計器盤の縁 (コーミング) が来るように寸法を決めている。
 */
function buildInterior(): Object3D {
  const b = new PartBuilder();

  // ── 計器盤 ──
  // 縁 (コーミング)。ここが「計器の上端」として画面に見える基準線になる
  b.add(BOX, FRAME, { pos: [0, -0.24, -1.3], scale: [3.5, 0.1, 0.22], rot: [-0.25, 0, 0] });
  b.add(BOX, FRAME_DARK, { pos: [0, -0.2, -1.32], scale: [3.5, 0.035, 0.18], rot: [-0.25, 0, 0] });
  b.add(BOX, EDGE, { pos: [0, -0.195, -1.36], scale: [3.4, 0.018, 0.02], rot: [-0.25, 0, 0] });
  // 計器盤の前面 (DOM の計器パネルの背後に来る面)
  b.add(BOX, PANEL, { pos: [0, -0.58, -1.16], scale: [3.5, 0.78, 0.5], rot: [-0.35, 0, 0] });
  // 足元へ回り込む部分
  b.add(BOX, FRAME_DARK, { pos: [0, -1.1, -0.85], scale: [3.3, 0.9, 1.0] });

  // ── 計器盤の上に載る小物 (縁のすぐ上に覗く) ──
  for (const s of [-1, 1]) {
    // 補助スクリーンの筐体
    b.add(BOX, FRAME_DARK, { pos: [s * 1.12, -0.34, -1.24], scale: [0.5, 0.26, 0.1], rot: [-0.3, 0, 0] });
    b.add(PLANE, SCREEN, { pos: [s * 1.12, -0.32, -1.28], scale: [0.42, 0.18, 1], rot: [-0.3, 0, 0] });
  }
  // 警告灯の列
  const lamps = [LAMP_R, LAMP_A, LAMP_G, LAMP_G, LAMP_A, LAMP_R];
  lamps.forEach((key, i) => {
    b.add(SPH, key, { pos: [-0.42 + i * 0.168, -0.295, -1.29], scale: 0.035 });
  });
  // スイッチ列 (陰影のためのディテール)
  for (let i = 0; i < 8; i++) {
    b.addMirrored(BOX, FRAME, { pos: [0.62 + (i % 4) * 0.1, -0.36, -1.26], scale: [0.05, 0.045, 0.09], rot: [-0.3, 0, 0] });
  }

  // ── 風防の柱 (画面の左右上を斜めに走る) ──
  for (const s of [-1, 1]) {
    // 主柱: 計器盤の縁から後方上へ。視界を塞がないよう細く、画面隅に寄せる
    b.add(BOX, FRAME, { pos: [s * 1.58, 0.3, -1.02], scale: [0.06, 0.065, 2.1], rot: [0.62, s * 0.1, 0] });
    b.add(BOX, FRAME_DARK, { pos: [s * 1.54, 0.29, -1.01], scale: [0.028, 0.03, 2.05], rot: [0.62, s * 0.1, 0] });
    // 頬当て: 画面の下隅だけを締める小さな面
    b.add(BOX, PANEL, { pos: [s * 1.62, -0.5, -1.2], scale: [0.34, 0.5, 0.28], rot: [0, s * 0.22, s * 0.1] });
    // 側面の握り
    b.add(TUBE, FRAME, { pos: [s * 1.44, -0.3, -0.9], scale: [0.05, 0.05, 0.42], rot: [0.5, 0, 0] });
  }

  // ── 天蓋の縁 (画面上端に薄く) ──
  b.add(BOX, FRAME, { pos: [0, 0.79, -1.24], scale: [3.2, 0.07, 0.28], rot: [-0.12, 0, 0] });
  b.add(BOX, FRAME_DARK, { pos: [0, 0.755, -1.26], scale: [3.1, 0.025, 0.22], rot: [-0.12, 0, 0] });
  // 天蓋中央の桁 (奥行きを感じさせる細い桁)
  b.add(BOX, FRAME, { pos: [0, 0.9, -0.55], scale: [0.055, 0.055, 1.6], rot: [-0.06, 0, 0] });

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
 * カメラの子として吊る (カメラの near は 0.5 なので、内装は 0.6〜2.5 に収まる大きさにする)。
 */
export class Cockpit {
  readonly root = new Group();
  private interior: Object3D;
  private visible = true;

  constructor(scene: Scene, private camera: PerspectiveCamera) {
    this.interior = buildInterior();
    this.root.add(this.interior);
    // 計器盤の下から当てる淡い光。太陽の向きに関わらず内装の形が読めるようにする
    const glow = new PointLight(0x8fd8c0, 1.3, 3.2, 2);
    glow.position.set(0, -0.5, -0.9);
    this.root.add(glow);
    const fill = new PointLight(0x7796b8, 0.5, 4.5, 2);
    fill.position.set(0, 0.5, 0.2);
    this.root.add(fill);
    // カメラの子にすることで、カメラの揺れ・FOV とズレなく一体で動く
    this.camera.add(this.root);
    scene.add(this.camera);
  }

  setVisible(v: boolean): void {
    if (this.visible === v) return;
    this.visible = v;
    this.root.visible = v;
  }
}
