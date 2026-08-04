import type { GrowthStage } from '../../shared/types.js';

/**
 * 成長は「経過時間」と「世話スコア」の両方で決まる。
 * 時間だけだと放置してても大人になり、世話だけだと連打で一気に育ってしまう。
 *
 * careScore は世話アクション1回で +1（1日の上限あり）。
 */

export interface GrowthThreshold {
  stage: GrowthStage;
  minAgeHours: number;
  minCareScore: number;
}

export const GROWTH_TABLE: GrowthThreshold[] = [
  { stage: 'egg', minAgeHours: 0, minCareScore: 0 },
  { stage: 'child', minAgeHours: 0.05, minCareScore: 3 },
  { stage: 'adult', minAgeHours: 24, minCareScore: 40 },
];

export function stageFor(ageHours: number, careScore: number): GrowthStage {
  let current: GrowthStage = 'egg';
  for (const row of GROWTH_TABLE) {
    if (ageHours >= row.minAgeHours && careScore >= row.minCareScore) {
      current = row.stage;
    }
  }
  return current;
}

export function ageHoursOf(bornAt: number, now: number): number {
  return Math.max(0, (now - bornAt) / 3_600_000);
}

/** 次の段階までの進捗（0〜1）。UI のゲージ用。 */
export function stageProgress(ageHours: number, careScore: number): number {
  const stage = stageFor(ageHours, careScore);
  const nextIndex = GROWTH_TABLE.findIndex((row) => row.stage === stage) + 1;
  const next = GROWTH_TABLE[nextIndex];
  if (!next) return 1;
  const byAge = next.minAgeHours > 0 ? Math.min(1, ageHours / next.minAgeHours) : 1;
  const byCare = next.minCareScore > 0 ? Math.min(1, careScore / next.minCareScore) : 1;
  return Math.min(byAge, byCare);
}
