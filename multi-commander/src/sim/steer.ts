import { Quaternion, Vector3 } from 'three';
import { clamp, forwardOf } from '../core/math';
import type { Entity } from '../world/entity';

/** 操縦入力 3 軸。`Entity.input` の pitch / yaw / roll と同じ規約。 */
export interface SteerCommand {
  /** + = 機首上げ */
  pitch: number;
  /** + = 右 */
  yaw: number;
  /** + = 右ロール */
  roll: number;
}

const _fwd = new Vector3();
const _axis = new Vector3();
const _invQ = new Quaternion();
const _to = new Vector3();

/**
 * 機首を目標方向へ向ける PD 制御。**操縦入力を返すだけ**の純関数。
 *
 * 敵味方の AI (`sim/ai.ts`) と、チュートリアルのお手本モード
 * (`ui/TutorialDemo.ts`) が同じ式を使う。お手本モードは求めた値を
 * 人間の入力と同じ経路 (`InputManager`) へ流すので、
 * 画面に出す「押しているキー」と実際の機動が食い違わない。
 *
 * @param gain 角度に対する舵の効き
 * @param bank ヨー方向へバンクさせる量 (見た目を航空機らしくする)
 */
export function steerCommand(
  e: Entity,
  desiredDir: Vector3,
  gain: number,
  bank = 0.5,
  out: SteerCommand = { pitch: 0, yaw: 0, roll: 0 },
): SteerCommand {
  const def = e.ship!.def;
  forwardOf(e.quat, _fwd);
  _axis.copy(_fwd).cross(desiredDir); // 長さ = sin(角度)
  _axis.applyQuaternion(_invQ.copy(e.quat).invert());
  const dot = _fwd.dot(desiredDir);
  // 真後ろ (dot<0) では sin が小さくなるので、旋回量を最大に押し上げる
  const boost = dot < 0 ? 1 / Math.max(0.25, _axis.length()) : 1;

  const kd = 0.28;
  out.pitch = clamp(_axis.x * gain * boost - (e.angVel.x / def.turn[0]) * kd, -1, 1);
  out.yaw = clamp(-_axis.y * gain * boost + (e.angVel.y / def.turn[1]) * kd, -1, 1);
  // ヨー方向へバンクさせて航空機らしい旋回に見せる
  out.roll = clamp(-_axis.z * gain - _axis.y * bank * boost, -1, 1);
  return out;
}

/** 指定した点へ機首を向ける操縦入力。目標が自機と同じ位置なら舵を切らない。 */
export function steerCommandToPoint(
  e: Entity,
  point: Vector3,
  gain: number,
  bank = 0.5,
  out: SteerCommand = { pitch: 0, yaw: 0, roll: 0 },
): SteerCommand {
  _to.copy(point).sub(e.pos);
  const len = _to.length();
  if (len < 1e-4) {
    out.pitch = 0;
    out.yaw = 0;
    out.roll = 0;
    return out;
  }
  return steerCommand(e, _to.divideScalar(len), gain, bank, out);
}
