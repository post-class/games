/**
 * 画面上の固定照準の縦位置 (0 = 上端、0.5 = 画面中央)。
 *
 * ここが**唯一の出所**で、次の3つが必ず同じ値から作られる。
 * - HUD の固定照準環の位置 (`hud/HudView.ts` の `reticleSvg`)
 * - プレイヤーの主砲・ミサイルの射線 (`AIM_PITCH_OFFSET`)
 * - マウス操縦のニュートラル位置 (`app/input.ts`)
 *
 * 値は **0.5 (画面中央)**。コクピット視点のカメラは機体の姿勢をそのまま使う
 * (`render/CameraRig.ts`: `camera.quaternion = 機体の q`) ので、
 * 機首方向＝射線が投影されるのは画面中央である。
 * 以前は「下部計器を除いた視界の中央」として 0.35 を採り、
 * 弾だけを `AIM_PITCH_OFFSET` 分だけ上へ曲げていたため、
 * 照準環を画面中央へ直した後に**弾が照準の上へ飛ぶ**状態になっていた。
 */
export const AIM_ORIGIN_Y = 0.5;

/** 通常時のカメラ視野角。照準用の射線補正も同じ基準で求める。 */
export const AIM_BASE_FOV_DEG = 70;

/**
 * 固定照準が画面中央から上へずれた分の、機首からの仰角 (rad)。
 * 照準を画面中央に置いている限り 0 になり、弾は機首正面へ出る。
 */
export const AIM_PITCH_OFFSET = Math.atan(
  (1 - AIM_ORIGIN_Y * 2) * Math.tan((AIM_BASE_FOV_DEG * Math.PI) / 360),
);
