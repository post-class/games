import { bus } from '../core/events';
import { rng } from '../core/rng';
import type { Entity, ShipRuntime } from '../world/entity';

/**
 * サブシステム損傷。
 *
 * ハルに通ったダメージで、部位が確率的に壊れる。
 * HP が減るだけでは緊張が生まれないので、「何が使えなくなったか」を作るのが目的。
 *
 * 壊れ方は3段階:
 *   ok      … 正常
 *   damaged … 性能低下 (レーダーにノイズ、旋回が鈍る、片方の砲が渋る等)
 *   dead    … 機能喪失
 */

export type SubsystemId =
  | 'radar'
  | 'gunsLeft'
  | 'gunsRight'
  | 'turret'
  | 'engine'
  | 'shieldGen'
  | 'comms'
  | 'thrusters';

export type SubsystemState = 'ok' | 'damaged' | 'dead';

export interface SubsystemInfo {
  id: SubsystemId;
  label: string;
  /** 被弾したときに壊れやすさ (相対重み) */
  weight: number;
}

export const SUBSYSTEMS: SubsystemInfo[] = [
  { id: 'radar', label: 'レーダー', weight: 1.0 },
  { id: 'gunsLeft', label: '左舷砲', weight: 1.2 },
  { id: 'gunsRight', label: '右舷砲', weight: 1.2 },
  { id: 'turret', label: '砲塔', weight: 1.4 },
  { id: 'engine', label: 'エンジン', weight: 1.0 },
  { id: 'shieldGen', label: 'シールド発生器', weight: 0.9 },
  { id: 'comms', label: '通信機', weight: 0.7 },
  { id: 'thrusters', label: '姿勢制御', weight: 1.0 },
];

export type SubsystemMap = Record<SubsystemId, SubsystemState>;

export function newSubsystems(): SubsystemMap {
  return {
    radar: 'ok',
    gunsLeft: 'ok',
    gunsRight: 'ok',
    turret: 'ok',
    engine: 'ok',
    shieldGen: 'ok',
    comms: 'ok',
    thrusters: 'ok',
  };
}

/** 艦艇に存在する部位。戦闘機の左右砲は艦艇では使わない。 */
const CAPITAL_SUBSYSTEMS: ReadonlySet<SubsystemId> = new Set([
  'radar',
  'turret',
  'engine',
  'shieldGen',
  'comms',
  'thrusters',
]);

/** ハルダメージ1点あたりの故障判定確率の係数 */
const BREAK_RATE = 0.014;

/**
 * ハルに通ったダメージから部位故障を判定する。
 *
 * 被弾面によって壊れる部位が偏る (右から撃たれれば右舷砲が壊れやすい) ので、
 * プレイヤーは「どちらを向けて逃げるか」を考えることになる。
 */
export function rollSubsystemDamage(
  e: Entity,
  hullDamage: number,
  armorFace: 'front' | 'rear' | 'left' | 'right',
  rateScale = 1,
): SubsystemId | undefined {
  const ship = e.ship;
  if (!ship || hullDamage <= 0) return undefined;
  if (!ship.subsystems) ship.subsystems = newSubsystems();

  // ハルの残り割合が低いほど壊れやすい
  const hullRatio = ship.hull / Math.max(1, ship.def.hull);
  const chance = hullDamage * BREAK_RATE * (1.4 - hullRatio * 0.6) * rateScale;
  if (chance <= 0 || !rng.chance(Math.min(0.85, chance))) return undefined;

  // 被弾面に応じた重み付け
  const candidates: Array<{ id: SubsystemId; w: number }> = [];
  const isCapital = ship.def.role === 'capital';
  for (const info of SUBSYSTEMS) {
    if (isCapital ? !CAPITAL_SUBSYSTEMS.has(info.id) : info.id === 'turret') continue;
    if (ship.subsystems[info.id] === 'dead') continue;
    let w = info.weight;
    if (isCapital && armorFace !== 'rear') {
      // 艦艇の側面・正面は砲塔へ通りやすい。
      if (info.id === 'turret') w *= 3;
      if (info.id === 'engine') w *= 0.25;
    } else if (armorFace === 'left') {
      if (info.id === 'gunsLeft') w *= 3;
      if (info.id === 'gunsRight') w *= 0.25;
    } else if (armorFace === 'right') {
      if (info.id === 'gunsRight') w *= 3;
      if (info.id === 'gunsLeft') w *= 0.25;
    } else if (armorFace === 'rear') {
      if (info.id === 'engine') w *= 3;
      if (info.id === 'radar') w *= 0.3;
    } else {
      // 前面被弾はレーダーと砲に来やすい
      if (info.id === 'radar') w *= 2.4;
      if (info.id === 'engine') w *= 0.3;
    }
    candidates.push({ id: info.id, w });
  }
  if (candidates.length === 0) return undefined;

  let total = 0;
  for (const c of candidates) total += c.w;
  let pick = rng.next() * total;
  let chosen = candidates[candidates.length - 1].id;
  for (const c of candidates) {
    pick -= c.w;
    if (pick <= 0) {
      chosen = c.id;
      break;
    }
  }

  const before = ship.subsystems[chosen];
  const after: 'damaged' | 'dead' = before === 'ok' ? 'damaged' : 'dead';
  ship.subsystems[chosen] = after;
  const info = SUBSYSTEMS.find((s) => s.id === chosen)!;
  bus.emit('subsystemDamaged', {
    entity: e,
    id: chosen,
    label: info.label,
    state: after,
    isPlayer: false,
  });
  return chosen;
}

// ───────── 効果の参照 ─────────

export function stateOf(ship: ShipRuntime | undefined, id: SubsystemId): SubsystemState {
  return ship?.subsystems?.[id] ?? 'ok';
}

/** レーダーの信頼度 0..1 (0 で完全に使えない) */
export function radarQuality(ship: ShipRuntime | undefined): number {
  switch (stateOf(ship, 'radar')) {
    case 'dead':
      return 0;
    case 'damaged':
      return 0.45;
    default:
      return 1;
  }
}

/** エンジン出力の倍率 */
export function engineOutput(ship: ShipRuntime | undefined): number {
  switch (stateOf(ship, 'engine')) {
    case 'dead':
      return 0.4;
    case 'damaged':
      return 0.72;
    default:
      return 1;
  }
}

/** アフターバーナーが使えるか */
export function afterburnerAvailable(ship: ShipRuntime | undefined): boolean {
  return stateOf(ship, 'engine') !== 'dead';
}

/** 旋回性能の倍率 */
export function thrusterOutput(ship: ShipRuntime | undefined): number {
  switch (stateOf(ship, 'thrusters')) {
    case 'dead':
      return 0.45;
    case 'damaged':
      return 0.75;
    default:
      return 1;
  }
}

/** シールド再生の倍率 */
export function shieldRegenScale(ship: ShipRuntime | undefined): number {
  switch (stateOf(ship, 'shieldGen')) {
    case 'dead':
      return 0;
    case 'damaged':
      return 0.4;
    default:
      return 1;
  }
}

/** 僚機へ指示できるか */
export function commsAvailable(ship: ShipRuntime | undefined): boolean {
  return stateOf(ship, 'comms') !== 'dead';
}

/**
 * 砲口が撃てるか。
 * 機体ローカルの x 座標で左右を判定し、対応する砲が死んでいれば撃てない。
 * damaged のときは確率的に不発になる。
 */
export function gunOperational(ship: ShipRuntime | undefined, offsetX: number): boolean {
  const id: SubsystemId = ship?.def.role === 'capital'
    ? 'turret'
    : offsetX < 0
      ? 'gunsLeft'
      : 'gunsRight';
  const st = stateOf(ship, id);
  if (st === 'dead') return false;
  if (st === 'damaged') return !rng.chance(0.4);
  return true;
}

/** 壊れている部位があるか (HUD の警告用) */
export function hasDamage(ship: ShipRuntime | undefined): boolean {
  if (!ship?.subsystems) return false;
  for (const info of SUBSYSTEMS) {
    if (ship.subsystems[info.id] !== 'ok') return true;
  }
  return false;
}

/** 修理 (母艦帰投時などに使う) */
export function repairAll(ship: ShipRuntime): void {
  ship.subsystems = newSubsystems();
}
