import {
  AdditiveBlending,
  CanvasTexture,
  Color,
  Mesh,
  ShaderMaterial,
  Sprite,
  SpriteMaterial,
  type Object3D,
  type Texture,
} from 'three';
import {
  pointSpriteScale,
  rimShellScale,
  rimStrengthForBand,
  showsPointLight,
  visibilityBand,
  type VisibilityBand,
} from './Visibility';

/**
 * 敵機を背景から浮かせるための縁光と、遠距離用の光点。
 *
 * ドローコールを増やさないための約束:
 * - 縁光は「船体のマージ済みジオメトリを使い回した 1 枚のシェル」だけ (機体あたり +1)
 * - マテリアルは陣営 3 色 × 距離帯 3 段階の 9 個をモジュール内で共有する。
 *   機体ごとに新しいマテリアルは作らない（作るとシェーダ切替とメモリが機体数に比例する）
 * - 光点は 3km 以上でのみ visible になるスプライト 1 枚
 */

/** 敵味方の色分け。敵=暖色 (赤)、味方=寒色 (青)、それ以外=白 */
export type FactionTone = 'hostile' | 'friendly' | 'neutral';

export const RIM_COLORS: Record<FactionTone, number> = {
  hostile: 0xff6b4a,
  friendly: 0x63b4ff,
  neutral: 0xdfe7ee,
};

export const RIM_MESH_NAME = 'rimLight';
export const POINT_LIGHT_NAME = 'farPointLight';

const rimCache = new Map<string, ShaderMaterial>();

const RIM_VERT = /* glsl */ `
varying vec3 vNormalW;
varying vec3 vViewW;
void main() {
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vNormalW = normalize(mat3(modelMatrix) * normal);
  vViewW = cameraPosition - worldPos.xyz;
  gl_Position = projectionMatrix * viewMatrix * worldPos;
}
`;

const RIM_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uStrength;
uniform float uPower;
varying vec3 vNormalW;
varying vec3 vViewW;
void main() {
  float ndv = abs(dot(normalize(vNormalW), normalize(vViewW)));
  float fresnel = pow(1.0 - clamp(ndv, 0.0, 1.0), uPower);
  float a = fresnel * uStrength;
  gl_FragColor = vec4(uColor * a, a);
}
`;

/**
 * 縁光マテリアル (陣営色 × 距離帯)。同じ組み合わせは必ず同じインスタンスを返す。
 */
export function rimMaterial(tone: FactionTone, band: VisibilityBand): ShaderMaterial {
  const key = `${tone}:${band}`;
  let mat = rimCache.get(key);
  if (!mat) {
    mat = new ShaderMaterial({
      vertexShader: RIM_VERT,
      fragmentShader: RIM_FRAG,
      uniforms: {
        uColor: { value: new Color(RIM_COLORS[tone]) },
        uStrength: { value: rimStrengthForBand(band) },
        // 近距離は縁を細く (塗装を残す)、遠距離は太く (輪郭を読ませる)
        uPower: { value: band === 'detail' ? 3.4 : band === 'silhouette' ? 2.1 : 2.6 },
      },
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    rimCache.set(key, mat);
  }
  return mat;
}

/** 既定のマテリアル (テンプレート生成時に付ける。実体では毎フレーム差し替える) */
export function defaultRimMaterial(): ShaderMaterial {
  return rimMaterial('neutral', 'silhouette');
}

let pointTex: Texture | undefined;
function pointTexture(): Texture {
  if (pointTex) return pointTex;
  const s = 64;
  const cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const ctx = cv.getContext('2d')!;
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.22, 'rgba(255,255,255,0.85)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.22)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  pointTex = new CanvasTexture(cv);
  return pointTex;
}

const pointMatCache = new Map<FactionTone, SpriteMaterial>();
function pointMaterial(tone: FactionTone): SpriteMaterial {
  let mat = pointMatCache.get(tone);
  if (!mat) {
    mat = new SpriteMaterial({
      map: pointTexture(),
      color: RIM_COLORS[tone],
      blending: AdditiveBlending,
      transparent: true,
      depthWrite: false,
      opacity: 0.9,
    });
    pointMatCache.set(tone, mat);
  }
  return mat;
}

/** 1機ぶんの視認補助。RenderSync が entity ごとに保持する */
export interface VisibilityAids {
  rim?: Mesh;
  point: Sprite;
}

/**
 * 機体メッシュに視認補助を取り付ける。
 * 縁光シェルはテンプレート側で作られているので、ここでは探して掴むだけ。
 */
export function attachVisibilityAids(obj: Object3D): VisibilityAids {
  const rim = obj.getObjectByName(RIM_MESH_NAME) as Mesh | undefined;
  const point = new Sprite(pointMaterial('neutral'));
  point.name = POINT_LIGHT_NAME;
  point.visible = false;
  // 機体本体より後に描く (遠距離では機体を包む光になる)
  point.renderOrder = 2;
  obj.add(point);
  return { rim, point };
}

/**
 * 距離帯に応じて縁光と光点を更新する。
 * マテリアルは共有インスタンスの差し替えなので、ここで新規生成は起きない。
 */
export function updateVisibilityAids(
  aids: VisibilityAids,
  tone: FactionTone,
  distance: number,
  radius = 0,
): VisibilityBand {
  const band = visibilityBand(distance);
  if (aids.rim) {
    const mat = rimMaterial(tone, band);
    if (aids.rim.material !== mat) aids.rim.material = mat;
    aids.rim.scale.setScalar(rimShellScale(distance));
  }
  const show = showsPointLight(distance, radius);
  aids.point.visible = show;
  if (show) {
    const mat = pointMaterial(tone);
    if (aids.point.material !== mat) aids.point.material = mat;
    aids.point.scale.setScalar(pointSpriteScale(distance));
  }
  return band;
}

export function disposeVisibilityMaterials(): void {
  for (const m of rimCache.values()) m.dispose();
  rimCache.clear();
  for (const m of pointMatCache.values()) m.dispose();
  pointMatCache.clear();
}
