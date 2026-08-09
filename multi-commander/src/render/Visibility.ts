import { clamp, clamp01 } from '../core/math';

/**
 * 「敵機が見える」ための距離帯と表示強度。
 *
 * Three.js に依存しない純粋な計算だけを置く。
 * 実際のマテリアル・スプライトの操作は ShipVisibility.ts が行う。
 *
 * 距離帯の決め方（specs/02 ⑥ の要求をそのまま数値にしたもの）:
 * - `detail`     … 1km 以下。機体の面と塗装が見える。縁光は形を邪魔しない程度に抑える
 * - `silhouette` … 1〜3km。影絵として形が読める。縁光を最も強くして背景から輪郭を分離する
 * - `point`      … 3km 以上。機体そのものは数ピクセルなので、代わりに光点を出して存在を示す
 */
export type VisibilityBand = 'detail' | 'silhouette' | 'point';

/** 面と塗装が見える上限 (m) */
export const BAND_DETAIL_MAX = 1000;
/** 影絵として形が読める上限 (m)。これを超えたら光点で示す */
export const BAND_SILHOUETTE_MAX = 3000;

export function visibilityBand(distance: number): VisibilityBand {
  if (!(distance > 0)) return 'detail';
  if (distance < BAND_DETAIL_MAX) return 'detail';
  if (distance < BAND_SILHOUETTE_MAX) return 'silhouette';
  return 'point';
}

/**
 * 縁光の強さ。距離帯ごとに 3 段階だけ用意する。
 * 段階を離散にしているのは、マテリアルを陣営 3 色 × 3 段階の 9 個で共有し、
 * 機体ごとに新しいマテリアルを作らない (= ドローコールとシェーダを増やさない) ため。
 */
export function rimStrengthForBand(band: VisibilityBand): number {
  switch (band) {
    // 近距離は塗装を塗り潰さないよう控えめ
    case 'detail':
      return 0.55;
    // 影絵として読ませたい帯がいちばん強い
    case 'silhouette':
      return 1.35;
    // 光点が主役になるので、縁光は輪郭の芯を残す程度
    case 'point':
      return 1.0;
  }
}

/**
 * 縁光シェルの拡大率。
 * 遠いほど外側へ広げて、背景との間に暗くない縁を作る。
 * 近距離で広げすぎると機体が膨らんで見えるので 2% から始める。
 */
export function rimShellScale(distance: number): number {
  const t = clamp01((distance - 250) / (BAND_SILHOUETTE_MAX - 250));
  return 1.02 + 0.1 * t;
}

/** 光点の見かけの大きさ (ラジアン)。距離に比例させるので画面上ではほぼ一定 */
export const POINT_ANGULAR_SIZE = 0.03;

/**
 * 3km 以上で出す光点のワールド上の直径。
 * 距離に比例させることで、10km 先でも画面上の大きさが変わらない。
 */
export function pointSpriteScale(distance: number): number {
  return Math.max(24, distance * POINT_ANGULAR_SIZE);
}

/**
 * 光点を出すか。距離帯 `point` と同じ境界にそろえる。
 *
 * ただし艦艇のように機体そのものが光点より大きく映るものには出さない。
 * 出すと「艦の上に光の玉が乗る」だけで、可読性が上がらないため。
 */
export function showsPointLight(distance: number, radius = 0): boolean {
  if (visibilityBand(distance) !== 'point') return false;
  return pointSpriteScale(distance) > radius * 2.5;
}

/**
 * エンジン光の増幅。遠いほど噴射炎を伸ばして、
 * 影絵の中でも「動いている機体」だと分かるようにする。
 */
export function plumeVisibilityBoost(distance: number): number {
  return 1 + 0.9 * clamp01((distance - 500) / 2500);
}

/**
 * 砲口閃光の大きさ倍率。
 *
 * 自機の砲口はカメラの十数 m 先にあるため、ワールド単位で固定の大きさにすると
 * 「空中に浮いた黄色い丸」になる。カメラからの距離で絞って、
 * 画面上の大きさがほぼ一定になるようにする。
 */
export function muzzleFlashScale(cameraDistance: number): number {
  return clamp(cameraDistance / 70, 0.16, 1.5);
}

/**
 * 命中閃光の大きさ倍率。
 * 遠距離の命中が点にならないよう、距離に応じて拡大する。
 */
export function impactFlashScale(cameraDistance: number): number {
  return 1 + 1.6 * clamp01((cameraDistance - 200) / 1800);
}

/**
 * 曳光弾の長さ倍率。
 * 元の値は武器定義の `GunDef.tracer` で、ここでは全体の底上げだけを行う。
 * 武器ごとの差 (mass-driver 0.8 / ion-lance 2.2 など) は必ず保つ。
 */
export const TRACER_LENGTH_GAIN = 2.1;

export function tracerLengthScale(defTracer: number): number {
  const base = Number.isFinite(defTracer) && defTracer > 0 ? defTracer : 1;
  return base * TRACER_LENGTH_GAIN;
}

/** 曳光弾の太さ倍率。長さだけ伸ばすと糸のようになるので少しだけ太らせる */
export const TRACER_WIDTH_GAIN = 1.35;
