import { Quaternion, Vector3 } from 'three';

/**
 * 砲口閃光を「機体の砲身」に張り付けるための座標変換。
 *
 * シミュレーション側 (`sim/weapons.ts`) は
 * `hardpoint.offset * def.hardpointScale` を機体の姿勢で回してワールド座標にし、
 * `weaponFired.muzzle` として飛ばしてくる。
 * 描画側はその点を機体ローカルへ戻して保持し、毎フレーム現在の姿勢で復元する。
 * こうすると閃光が機体と一緒に動き・回るので、空中に取り残されない。
 */

const _q = new Quaternion();

/** ワールド座標の砲口を、機体ローカルのオフセットへ戻す */
export function localMuzzleOffset(
  muzzleWorld: Vector3,
  shipPos: Vector3,
  shipQuat: Quaternion,
  out = new Vector3(),
): Vector3 {
  return out.copy(muzzleWorld).sub(shipPos).applyQuaternion(_q.copy(shipQuat).invert());
}

/** 機体ローカルのオフセットを、現在の姿勢でワールド座標へ戻す */
export function worldMuzzlePoint(
  local: Vector3,
  shipPos: Vector3,
  shipQuat: Quaternion,
  out = new Vector3(),
): Vector3 {
  return out.copy(local).applyQuaternion(shipQuat).add(shipPos);
}

/** ハードポイント定義からワールド座標の砲口を求める (sim 側と同じ式) */
export function hardpointWorldPoint(
  offset: readonly [number, number, number],
  hardpointScale: number,
  shipPos: Vector3,
  shipQuat: Quaternion,
  out = new Vector3(),
): Vector3 {
  return out
    .set(offset[0], offset[1], offset[2])
    .multiplyScalar(hardpointScale)
    .applyQuaternion(shipQuat)
    .add(shipPos);
}
