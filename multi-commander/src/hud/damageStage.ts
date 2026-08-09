/**
 * 被弾の深刻さを段階で表す（T1-② 「自機の危険を段階で伝える」）。
 *
 * 「シールド健全 → シールド喪失 → 装甲被弾 → ハル被弾 → ハル危険域」を
 * **ここ一箇所**で決める。HUD の文字・赤い縁取り・警報音・撃墜前の警告は
 * すべてこの関数の結果を読むので、「表示は危険域なのに音が鳴らない」といった
 * 食い違いが起きない。
 */

export type DamageStage =
  | 'shield-ok'
  | 'shield-down'
  | 'armor-hit'
  | 'hull-hit'
  | 'hull-critical';

/** 段階の重さ。escalation（悪化）の判定に使う。 */
export const DAMAGE_STAGE_ORDER: readonly DamageStage[] = [
  'shield-ok',
  'shield-down',
  'armor-hit',
  'hull-hit',
  'hull-critical',
];

/** 画面周辺を赤くし、脱出を明示する境目。ハル残量の比率。 */
export const HULL_DANGER_RATIO = 0.3;

/** シールドを「落ちた」と扱う残量。既存の `シールド低下` 警告灯と同じ値。 */
export const SHIELD_DOWN_RATIO = 0.15;

/** 満タン判定の許容誤差（浮動小数の丸めで「被弾」と誤判定しないため）。 */
const FULL_EPSILON = 1e-3;

export interface DamageRatios {
  shieldFront: number;
  shieldRear: number;
  armor: { front: number; rear: number; left: number; right: number };
  hull: number;
}

/**
 * 現在の段階。重い側から判定する。
 *
 * ハル危険域はハル残量だけで決める（装甲が残っていても、ハルが薄ければ死ぬ）。
 */
export function damageStage(h: DamageRatios): DamageStage {
  if (h.hull <= HULL_DANGER_RATIO) return 'hull-critical';
  if (h.hull < 1 - FULL_EPSILON) return 'hull-hit';
  const armorMin = Math.min(h.armor.front, h.armor.rear, h.armor.left, h.armor.right);
  if (armorMin < 1 - FULL_EPSILON) return 'armor-hit';
  if (h.shieldFront < SHIELD_DOWN_RATIO && h.shieldRear < SHIELD_DOWN_RATIO) return 'shield-down';
  return 'shield-ok';
}

/** `a` が `b` より深刻か。段階が進んだときだけ警告を出すために使う。 */
export function stageWorsened(from: DamageStage, to: DamageStage): boolean {
  return DAMAGE_STAGE_ORDER.indexOf(to) > DAMAGE_STAGE_ORDER.indexOf(from);
}

/** 段階の見出し。HUD にそのまま出す短い文字列。 */
export function damageStageLabel(stage: DamageStage): string {
  switch (stage) {
    case 'shield-down':
      return 'シールド喪失';
    case 'armor-hit':
      return '装甲被弾';
    case 'hull-hit':
      return 'ハル被弾';
    case 'hull-critical':
      return 'ハル危険域';
    default:
      return '';
  }
}

/** 段階ごとの追記（何をすべきか）。警告を「指示」として読ませる。 */
export function damageStageAdvice(stage: DamageStage): string {
  switch (stage) {
    case 'shield-down':
      return '被弾が装甲に通る — 距離を取れ';
    case 'armor-hit':
      return '装甲が削れている — 回避を優先';
    case 'hull-hit':
      return '船体に到達 — 帰投を検討';
    case 'hull-critical':
      return 'Alt+E で脱出できる';
    default:
      return '';
  }
}
