import {
  AdditiveBlending,
  BoxGeometry,
  CanvasTexture,
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  PointLight,
  SphereGeometry,
  type PerspectiveCamera,
  type Scene,
} from 'three';
import { PartBuilder } from './PartBuilder';
import { textureAlpha } from './textures';

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
const PANEL_ART = 'panelArt';
const PANEL_WEAR = 'panelWear';

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

  // 計器盤の面に貼るディテール (ラベル・傷・注意書き)。
  // 単色の面が広いと安っぽく見えるので、生成した overlay を薄く重ねる
  b.add(PLANE, PANEL_ART, { pos: [0, -0.56, -1.14], scale: [3.42, 0.74, 1], rot: [-0.35, 0, 0] });
  b.add(PLANE, PANEL_WEAR, { pos: [0, -0.235, -1.315], scale: [3.4, 0.22, 1], rot: [-0.25, 0, 0] });

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
 * 風防のガラス。
 *
 * 視界を塞がないことが絶対条件なので、映すのは
 * ①上端から差す反射のすじ ②拭き残しの汚れ ③被弾で入るひび の3つだけ。
 * 加算合成の薄い板をカメラの前に置き、機体の被害に応じて濃さを変える。
 */
function glassTexture(cracked: boolean): CanvasTexture {
  const w = 512;
  const h = 256;
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const g = cv.getContext('2d')!;
  g.clearRect(0, 0, w, h);

  // 上端から差し込む反射 (斜めのすじを数本)
  for (let i = 0; i < 4; i++) {
    const x = w * (0.1 + i * 0.26);
    const grad = g.createLinearGradient(x, 0, x + w * 0.16, h * 0.75);
    grad.addColorStop(0, 'rgba(180, 220, 255, 0.10)');
    grad.addColorStop(0.5, 'rgba(150, 200, 240, 0.03)');
    grad.addColorStop(1, 'rgba(150, 200, 240, 0)');
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x + w * 0.07, 0);
    g.lineTo(x + w * 0.2, h * 0.8);
    g.lineTo(x + w * 0.13, h * 0.8);
    g.closePath();
    g.fill();
  }
  // 拭き残しの汚れ (弧を描くムラ)
  g.strokeStyle = 'rgba(200, 215, 225, 0.018)';
  for (let i = 0; i < 5; i++) {
    g.lineWidth = 5 + i * 2;
    g.beginPath();
    g.arc(w * 0.5, h * 1.15, h * (0.55 + i * 0.08), Math.PI * 1.15, Math.PI * 1.85);
    g.stroke();
  }

  if (cracked) {
    // ひび: 視界の中央を避け、隅に小さく入れる。
    // 大きく入れると弾も敵も見えなくなり、被弾が「見えない」罰になってしまう
    g.lineWidth = 0.8;
    for (const [cx, cy] of [
      [w * 0.12, h * 0.22],
      [w * 0.88, h * 0.72],
      [w * 0.74, h * 0.14],
    ] as Array<[number, number]>) {
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * Math.PI * 2 + cx * 0.01;
        let x = cx;
        let y = cy;
        g.strokeStyle = 'rgba(225, 240, 255, 0.55)';
        g.beginPath();
        g.moveTo(x, y);
        for (let seg = 0; seg < 3; seg++) {
          const len = 4 + seg * 3;
          x += Math.cos(a + Math.sin(seg * 2.3) * 0.5) * len;
          y += Math.sin(a + Math.sin(seg * 1.7) * 0.5) * len;
          g.lineTo(x, y);
        }
        g.stroke();
      }
      // 着弾点
      g.fillStyle = 'rgba(235, 245, 255, 0.6)';
      g.beginPath();
      g.arc(cx, cy, 1.6, 0, Math.PI * 2);
      g.fill();
    }
  }
  return new CanvasTexture(cv);
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
  /** 風防のガラス (無傷 / ひび割れ の2枚を切り替える) */
  private glass: Mesh;
  private glassCracked: Mesh;

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
    // ── 風防のガラス ──
    // カメラの目前に置く薄い板。加算合成なので暗い宇宙では存在が消える
    const mk = (cracked: boolean): Mesh => {
      const m = new Mesh(
        PLANE,
        new MeshBasicMaterial({
          map: glassTexture(cracked),
          transparent: true,
          opacity: cracked ? 0 : 0.3,
          blending: AdditiveBlending,
          depthWrite: false,
          depthTest: false,
        }),
      );
      // near = 0.5 なので、それより手前には置けない
      m.position.set(0, 0.12, -0.62);
      m.scale.set(1.72, 0.86, 1);
      m.renderOrder = -1;
      return m;
    };
    this.glass = mk(false);
    this.glassCracked = mk(true);
    this.root.add(this.glass, this.glassCracked);

    // カメラの子にすることで、カメラの揺れ・FOV とズレなく一体で動く
    this.camera.add(this.root);
    scene.add(this.camera);
  }

  /**
   * 被害に応じてガラスの見え方を変える。
   * ハルが減るほど、ひびの入った板が濃くなる。
   */
  update(hullRatio: number): void {
    const hurt = Math.max(0, Math.min(1, (0.65 - hullRatio) / 0.5));
    (this.glassCracked.material as MeshBasicMaterial).opacity = hurt * 0.34;
    // ひびが目立つほど、綺麗な反射は引っ込める
    (this.glass.material as MeshBasicMaterial).opacity = 0.3 * (1 - hurt * 0.5);
  }

  setVisible(v: boolean): void {
    if (this.visible === v) return;
    this.visible = v;
    this.root.visible = v;
  }
}
