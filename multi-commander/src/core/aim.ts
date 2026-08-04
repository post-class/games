/**
 * 画面上の固定照準の縦位置 (0 = 上端、0.5 = 画面中央)。
 * 入力のニュートラル位置とプレイヤー主砲の射線で共有する。
 */
export const AIM_ORIGIN_Y = 0.35;

/** 通常時のカメラ視野角。照準用の射線補正も同じ基準で求める。 */
export const AIM_BASE_FOV_DEG = 70;

/** 固定照準が画面中央から上へずれた分の、機首からの仰角 (rad)。 */
export const AIM_PITCH_OFFSET = Math.atan(
  (1 - AIM_ORIGIN_Y * 2) * Math.tan((AIM_BASE_FOV_DEG * Math.PI) / 360),
);
