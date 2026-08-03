import { Quaternion, Vector3 } from 'three';
import type { ArmorFace, Entity, ShieldFace } from '../world/entity';

/** 被弾するとこの秒数だけシールド再生が止まる (連続した交戦でダメージが蓄積する) */
export const SHIELD_RECHARGE_DELAY = 4.5;

export interface DamageResult {
  /** シールドで受け止めた量 */
  shieldAbsorbed: number;
  /** アーマーが削られた量 */
  armorAbsorbed: number;
  /** ハルに通った量 */
  hullDamage: number;
  shieldFace: ShieldFace;
  armorFace: ArmorFace;
  /** この一撃で撃墜されたか */
  destroyed: boolean;
}

const _local = new Vector3();
const _invQ = new Quaternion();

/**
 * 被弾点から見た被弾面を求める。
 * 前後 (front/rear) はシールド、4象限 (front/rear/left/right) はアーマーに対応。
 */
export function hitFaces(
  target: Entity,
  hitPoint: Vector3,
): { shieldFace: ShieldFace; armorFace: ArmorFace } {
  _local.copy(hitPoint).sub(target.pos).applyQuaternion(_invQ.copy(target.quat).invert());
  // ローカル規約: forward = -Z
  const front = _local.z < 0;
  const shieldFace: ShieldFace = front ? 'front' : 'rear';
  let armorFace: ArmorFace;
  if (Math.abs(_local.z) >= Math.abs(_local.x)) {
    armorFace = front ? 'front' : 'rear';
  } else {
    armorFace = _local.x >= 0 ? 'right' : 'left';
  }
  return { shieldFace, armorFace };
}

/**
 * ダメージを シールド → アーマー → ハル の順に通す。
 * 貫通した分だけ次の層へ流れるので、シールドが残っているうちは船体が守られる。
 */
export function applyDamage(target: Entity, amount: number, hitPoint: Vector3): DamageResult {
  const ship = target.ship;
  const { shieldFace, armorFace } = hitFaces(target, hitPoint);
  const result: DamageResult = {
    shieldAbsorbed: 0,
    armorAbsorbed: 0,
    hullDamage: 0,
    shieldFace,
    armorFace,
    destroyed: false,
  };
  if (!ship || amount <= 0 || ship.hull <= 0) return result;

  ship.shieldDelay = SHIELD_RECHARGE_DELAY;
  let remaining = amount;

  const shield = ship.shield[shieldFace];
  if (shield > 0) {
    const absorbed = Math.min(shield, remaining);
    ship.shield[shieldFace] = shield - absorbed;
    remaining -= absorbed;
    result.shieldAbsorbed = absorbed;
  }

  if (remaining > 0) {
    const armor = ship.armor[armorFace];
    if (armor > 0) {
      const absorbed = Math.min(armor, remaining);
      ship.armor[armorFace] = armor - absorbed;
      // アーマーは半分の効率で吸収する (抜けた分がハルに通る)
      remaining -= absorbed;
      result.armorAbsorbed = absorbed;
    }
  }

  if (remaining > 0) {
    ship.hull = Math.max(0, ship.hull - remaining);
    result.hullDamage = remaining;
    if (ship.hull <= 0) result.destroyed = true;
  }

  return result;
}

/** 爆風など、方向を持たない全周ダメージ */
export function applySplashDamage(target: Entity, amount: number, origin: Vector3): DamageResult {
  return applyDamage(target, amount, origin);
}

/** HUD 表示用: シールド/アーマー/ハルの残存率 */
export function healthRatios(e: Entity): {
  shieldFront: number;
  shieldRear: number;
  armor: Record<ArmorFace, number>;
  hull: number;
} {
  const ship = e.ship!;
  const def = ship.def;
  const r = (v: number, max: number) => (max <= 0 ? 0 : Math.max(0, Math.min(1, v / max)));
  return {
    shieldFront: r(ship.shield.front, def.shield.front),
    shieldRear: r(ship.shield.rear, def.shield.rear),
    armor: {
      front: r(ship.armor.front, def.armor.front),
      rear: r(ship.armor.rear, def.armor.rear),
      left: r(ship.armor.left, def.armor.left),
      right: r(ship.armor.right, def.armor.right),
    },
    hull: r(ship.hull, def.hull),
  };
}
