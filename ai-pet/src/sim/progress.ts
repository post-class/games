import type { PetView } from '../../shared/types.js';

/**
 * 成長ゲージ。閾値はサーバの growth.ts と同じ値。
 * クライアントは表示のためだけに使い、判定はサーバが行う。
 */

const NEXT_THRESHOLD: Record<PetView['stage'], { ageHours: number; careScore: number } | null> = {
  egg: { ageHours: 0.05, careScore: 3 },
  child: { ageHours: 24, careScore: 40 },
  adult: null,
};

export function stageProgressClient(pet: PetView): number {
  const next = NEXT_THRESHOLD[pet.stage];
  if (!next) return 1;
  const byAge = next.ageHours > 0 ? Math.min(1, pet.ageHours / next.ageHours) : 1;
  const byCare = next.careScore > 0 ? Math.min(1, pet.careScore / next.careScore) : 1;
  return Math.min(byAge, byCare);
}
