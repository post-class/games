/**
 * sim/core/projectile.ts — 投射物（矢・弾・投石）の生成と飛翔（T-M7-01）
 *
 * 設計の要点:
 *  - **飛翔時間を持つが、命中は確定**（`07§6` に外れ判定は無い）。
 *    したがって **乱数を一切使わない**。着弾 tick は発射時に距離から決まる。
 *  - 目標が動いても当たる。毎 tick 残り tick 数で割り直して追尾する
 *    （「当たらないことがある」を作らないため。当たり判定を距離で取ると
 *     高速な目標に対して取りこぼしが出て、端末差ではなく仕様の穴になる）。
 *  - 目標が着弾前に死んだ場合は **最後に見えた座標へ着弾する**。
 *    単体攻撃なら不発、範囲攻撃ならその場で炸裂する（投石が空振りしても
 *    周囲の味方を削るのが `07§6`「友軍被害」の意図に合う）。
 *
 * SoA の使い方（`entity.ts` に投射物専用の列を足さずに済ませている）:
 *  | 列          | 用途                                             |
 *  |-------------|--------------------------------------------------|
 *  | `typeId`    | **射手のユニット typeId**（atk / role / aoe を引く） |
 *  | `owner`     | 射手の所有者（友軍被害の判定に使う）              |
 *  | `homeId`    | 射手の EntityId（死んでいても可。戦域の集計に使う）|
 *  | `target`    | 目標の EntityId                                   |
 *  | `destX/Y`   | 着弾点（目標が生きている間は毎 tick 更新）        |
 *  | `stateTick` | **着弾 tick**                                     |
 *  | `carryKind` | 射手の高さ + 1（0 = 不明）。地形倍率の再現用      |
 *  | `vx/vy`     | 速度（Fx / tick）。描画の補間用に持たせている     |
 *
 * `carryKind` は Uint8 なので高さは 0..254 まで表せる。地形の段数は
 * これより十分小さい（M3 の `elevation` も Uint8Array）。
 */

import type { EntityId, PlayerId } from '@/shared/types';
import { EntityKind } from '@/shared/types';
import type { Entities } from './entity';
import { UnitState, entityIndex, isAlive, markDeadIndex, spawnEntity } from './entity';
import type { Fx } from './fx';
import { FX_ONE, fx, idiv, isqrt } from './fx';
import { TICK_RATE, cfgNum } from './config';

/** `carryKind` に入れる「高さ不明」。 */
export const ELEVATION_UNKNOWN = 0;

/** `carryKind` に格納できる高さの上限（Uint8 の 255 から +1 のオフセットを引いた値）。 */
const ELEVATION_MAX = 254;

/**
 * 投射物の飛翔速度（マス/秒）と最短飛翔 tick。
 *
 * `config.json` に `projectile.*` は **まだ無い**（M1 時点で 07 資料に数値が無かった）。
 * `cfgNumPending` で引いているので、キーが追加されればそちらが優先される。
 * 既定値の根拠: 矢は 25 tick/秒 で 1 tick 約 0.5 マス進む速さ（弓の射程 5 マスを約 10 tick = 0.4 秒）。
 * 投石は目に見えて遅くしたいので約半分。
 */
function projectileSpeedPerTick(attackClass: string): Fx {
  const tilesPerSec =
    attackClass === 'aoe'
      ? cfgNum('projectile.aoeSpeedTilesPerSec')
      : attackClass === 'siege' || attackClass === 'gunpowder'
        ? cfgNum('projectile.boltSpeedTilesPerSec')
        : cfgNum('projectile.arrowSpeedTilesPerSec');
  // マス/秒 → Fx/tick。fx() は読み取り時の 1 回だけなので状態に float は入らない。
  const perTick = fx(tilesPerSec / TICK_RATE);
  return perTick > 0 ? perTick : 1;
}

/** 最短飛翔 tick（0 tick 着弾＝即着弾を避ける。1 tick 以上必ずかかる）。 */
function minFlightTicks(): number {
  const v = cfgNum('projectile.minFlightTicks');
  return v >= 1 ? Math.trunc(v) : 1;
}

/** `attackClass` が投射物を飛ばすものか（近接は飛ばさない）。 */
export function isProjectileAttackClass(attackClass: string): boolean {
  return (
    attackClass === 'arrow' ||
    attackClass === 'gunpowder' ||
    attackClass === 'siege' ||
    attackClass === 'aoe'
  );
}

/** `spawnProjectile` の引数。 */
export interface ProjectileSpec {
  /** 射手の所有者。 */
  readonly owner: PlayerId;
  /** 射手のユニット typeId。 */
  readonly shooterTypeId: number;
  /** 射手の EntityId。 */
  readonly shooterId: EntityId;
  /** 射手の attackClass（速度の決定に使う）。 */
  readonly attackClass: string;
  /** 発射位置（Fx）。 */
  readonly x: Fx;
  readonly y: Fx;
  /** 目標の EntityId。 */
  readonly targetId: EntityId;
  /** 目標の位置（Fx）。 */
  readonly targetX: Fx;
  readonly targetY: Fx;
  /** 射手の立っているタイルの高さ。 */
  readonly shooterElevation: number;
  /** 現在の tick。 */
  readonly tick: number;
}

/**
 * 投射物を 1 個生成する。戻り値は投射物の EntityId。
 * **乱数を使わない**（着弾 tick は距離と速度だけで決まる）。
 */
export function spawnProjectile(e: Entities, spec: ProjectileSpec): EntityId {
  const dx = spec.targetX - spec.x;
  const dy = spec.targetY - spec.y;
  // isqrt(Fx²) = Fx。fxSqrt ではなくこちらを使う（distSq の単位は Fx²）。
  const dist = isqrt(dx * dx + dy * dy);
  const speed = projectileSpeedPerTick(spec.attackClass);
  const minTicks = minFlightTicks();
  const raw = idiv(dist, speed);
  const flight = raw > minTicks ? raw : minTicks;

  const id = spawnEntity(e, {
    kind: EntityKind.Projectile,
    owner: spec.owner,
    typeId: spec.shooterTypeId,
    x: spec.x,
    y: spec.y,
    // 投射物は撃ち落とせない。HP は「生存フラグ」としてだけ持つ。
    hpMax: FX_ONE,
  });
  const i = entityIndex(id);
  e.state[i] = UnitState.Moving;
  e.stateTick[i] = spec.tick + flight;
  e.target[i] = spec.targetId;
  e.homeId[i] = spec.shooterId;
  e.destX[i] = spec.targetX;
  e.destY[i] = spec.targetY;
  e.vx[i] = idiv(dx, flight);
  e.vy[i] = idiv(dy, flight);
  const elev = spec.shooterElevation;
  e.carryKind[i] = elev >= 0 && elev <= ELEVATION_MAX ? elev + 1 : ELEVATION_UNKNOWN;
  return id;
}

/** 投射物の残り飛翔 tick（0 = 今 tick 着弾）。 */
export function remainingFlightTicks(e: Entities, i: number, tick: number): number {
  const r = e.stateTick[i]! - tick;
  return r > 0 ? r : 0;
}

/** 投射物に記録された射手の高さ（不明なら -1）。 */
export function shooterElevationOf(e: Entities, i: number): number {
  const v = e.carryKind[i]!;
  return v === ELEVATION_UNKNOWN ? -1 : v - 1;
}

/**
 * 着弾ハンドラ。`combat.ts` が渡す。
 * @param projectileIndex 着弾した投射物の index
 */
export type ImpactHandler = (projectileIndex: number) => void;

/**
 * 全投射物を 1 tick 進め、着弾したものに `onImpact` を呼んでから死亡予約する。
 *
 * 反復は **index 昇順**。同一 tick に複数着弾しても処理順は index で決まる。
 * 実際の index 解放は tick 末の `cleanup`（`flushDead`）なので、
 * `onImpact` の中で投射物の座標や `typeId` を安全に読める。
 *
 * @returns 着弾した個数
 */
export function stepProjectiles(
  e: Entities,
  tick: number,
  onImpact: ImpactHandler
): number {
  let impacts = 0;
  for (let i = 0; i < e.highWater; i++) {
    if (e.alive[i] !== 1) continue;
    if (e.kind[i] !== EntityKind.Projectile) continue;

    // 目標が生きている間は着弾点を追尾する（命中確定）。
    const targetId = e.target[i]!;
    if (isAlive(e, targetId)) {
      const t = entityIndex(targetId);
      e.destX[i] = e.x[t]!;
      e.destY[i] = e.y[t]!;
    }

    const remain = e.stateTick[i]! - tick;
    if (remain <= 0) {
      // 着弾。座標を着弾点に合わせてからハンドラを呼ぶ（範囲攻撃の中心になる）。
      e.x[i] = e.destX[i]!;
      e.y[i] = e.destY[i]!;
      e.vx[i] = 0;
      e.vy[i] = 0;
      onImpact(i);
      markDeadIndex(e, i);
      impacts += 1;
      continue;
    }

    // 残り tick で割り直す。目標が動いても必ず着弾 tick に届く。
    const vx = idiv(e.destX[i]! - e.x[i]!, remain);
    const vy = idiv(e.destY[i]! - e.y[i]!, remain);
    e.vx[i] = vx;
    e.vy[i] = vy;
    e.x[i] = e.x[i]! + vx;
    e.y[i] = e.y[i]! + vy;
  }
  return impacts;
}
