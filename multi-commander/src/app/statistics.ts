import type { CampaignOutcome, CampaignRoute } from '../content/campaign';
import type { ReturneeEntry, ReturneeKind } from './narrative';

export interface CampaignStatistics {
  shotsFired: number;
  hits: number;
  combatSeconds: number;
  missionsWon: number;
  missionsLost: number;
  shipsFlown: Record<string, number>;
  longestWingmanSurvival: number;
  rescuedWingmen: number;
  abandonedWingmen: number;
  navsReached: number;
  escortAttempts: number;
  escortSuccesses: number;
  /** 戦役シリーズの勝利点。任務の撃墜数とは分離する */
  seriesScore: number;
  campaignWins: number;
  campaignLosses: number;
  advanceCount: number;
  retreatCount: number;
  campaignNodes: Record<string, { wins: number; losses: number }>;
  /**
   * 帰還者の累計人数（勢力を問わない）。
   * `rescuedWingmen` は僚機の救出回数なので意味が異なる。こちらは最終無線で
   * 読み上げる名前の総数で、十章作戦記録が言う唯一の戦績。
   */
  returneesTotal: number;
  /** 立場ごとの帰還者数 */
  returneesByKind: Record<ReturneeKind, number>;
}

export function newStatistics(): CampaignStatistics {
  return {
    shotsFired: 0,
    hits: 0,
    combatSeconds: 0,
    missionsWon: 0,
    missionsLost: 0,
    shipsFlown: {},
    longestWingmanSurvival: 0,
    rescuedWingmen: 0,
    abandonedWingmen: 0,
    navsReached: 0,
    escortAttempts: 0,
    escortSuccesses: 0,
    seriesScore: 0,
    campaignWins: 0,
    campaignLosses: 0,
    advanceCount: 0,
    retreatCount: 0,
    campaignNodes: {},
    returneesTotal: 0,
    returneesByKind: { civilian: 0, wingman: 0, 'enemy-ace': 0, 'ally-faction': 0 },
  };
}

export function normalizeStatistics(raw: unknown): CampaignStatistics {
  const fallback = newStatistics();
  if (!raw || typeof raw !== 'object') return fallback;
  const r = raw as Partial<CampaignStatistics>;
  for (const k of [
    'shotsFired', 'hits', 'combatSeconds', 'missionsWon', 'missionsLost', 'longestWingmanSurvival',
    'rescuedWingmen', 'abandonedWingmen', 'navsReached', 'escortAttempts', 'escortSuccesses', 'seriesScore', 'campaignWins', 'campaignLosses', 'advanceCount', 'retreatCount',
    'returneesTotal',
  ] as const) {
    const value = r[k];
    if (typeof value === 'number' && Number.isFinite(value)) {
      // 勝利点は敗北時に負になるため、他の累積カウンタと同じ clamp をしない。
      fallback[k] = k === 'seriesScore' ? value : Math.max(0, value);
    }
  }
  if (r.returneesByKind && typeof r.returneesByKind === 'object') {
    for (const kind of ['civilian', 'wingman', 'enemy-ace', 'ally-faction'] as const) {
      const value = r.returneesByKind[kind];
      if (typeof value === 'number' && Number.isFinite(value)) fallback.returneesByKind[kind] = Math.max(0, Math.floor(value));
    }
  }
  if (r.campaignNodes && typeof r.campaignNodes === 'object') {
    for (const [id, value] of Object.entries(r.campaignNodes)) {
      if (!value || typeof value !== 'object') continue;
      const wins = (value as { wins?: unknown }).wins;
      const losses = (value as { losses?: unknown }).losses;
      fallback.campaignNodes[id] = {
        wins: typeof wins === 'number' && Number.isFinite(wins) ? Math.max(0, Math.floor(wins)) : 0,
        losses: typeof losses === 'number' && Number.isFinite(losses) ? Math.max(0, Math.floor(losses)) : 0,
      };
    }
  }
  if (r.shipsFlown && typeof r.shipsFlown === 'object') {
    for (const [id, value] of Object.entries(r.shipsFlown)) {
      if (typeof value === 'number' && Number.isFinite(value)) fallback.shipsFlown[id] = Math.max(0, Math.floor(value));
    }
  }
  return fallback;
}

/** 戦役ノードの勝敗を、通常のミッション統計と別の粒度で記録する。 */
export function recordCampaignOutcome(
  stats: CampaignStatistics,
  result: {
    node: string;
    outcome: CampaignOutcome;
    points: number;
    route: CampaignRoute;
  },
): void {
  const points = Number.isFinite(result.points) ? result.points : 0;
  stats.seriesScore += points;
  if (result.outcome === 'win') stats.campaignWins += 1;
  else stats.campaignLosses += 1;
  if (result.route === 'advance') stats.advanceCount += 1;
  if (result.route === 'retreat') stats.retreatCount += 1;
  const node = (stats.campaignNodes[result.node] ??= { wins: 0, losses: 0 });
  if (result.outcome === 'win') node.wins += 1;
  else node.losses += 1;
}

export const recordSeriesOutcome = recordCampaignOutcome;

/**
 * 帰還者を統計へ累計する。名簿（`NarrativeState`）への追加と対で呼ぶ。
 *
 * 既存の撃墜・救出カウンタの意味は変えない。ここは「読み上げる名前の数」だけを積む。
 */
export function recordReturnees(stats: CampaignStatistics, entries: readonly ReturneeEntry[]): number {
  if (!Array.isArray(entries)) return 0;
  let added = 0;
  for (const entry of entries) {
    if (!entry || typeof entry.name !== 'string' || entry.name.trim().length === 0) continue;
    stats.returneesTotal += 1;
    const kind: ReturneeKind | undefined = entry.kind in stats.returneesByKind ? entry.kind : undefined;
    if (kind) stats.returneesByKind[kind] += 1;
    added += 1;
  }
  return added;
}

export function recordMissionStatistics(
  stats: CampaignStatistics,
  result: {
    outcome: 'win' | 'loss';
    shipId: string;
    seconds: number;
    shotsFired: number;
    hits: number;
    wingmanHullRatio: number;
    wingmanRescued: boolean;
    wingmanAbandoned: boolean;
    navsReached?: number;
    escortSuccess?: boolean;
  },
): void {
  stats.shotsFired += Math.max(0, result.shotsFired);
  stats.hits += Math.max(0, result.hits);
  stats.combatSeconds += Math.max(0, result.seconds);
  if (result.outcome === 'win') stats.missionsWon += 1;
  else stats.missionsLost += 1;
  stats.shipsFlown[result.shipId] = (stats.shipsFlown[result.shipId] ?? 0) + 1;
  stats.longestWingmanSurvival = Math.max(stats.longestWingmanSurvival, Math.max(0, result.seconds * result.wingmanHullRatio));
  if (result.wingmanRescued) stats.rescuedWingmen += 1;
  if (result.wingmanAbandoned) stats.abandonedWingmen += 1;
  stats.navsReached += Math.max(0, Math.floor(result.navsReached ?? 0));
  if (result.escortSuccess !== undefined) {
    stats.escortAttempts += 1;
    if (result.escortSuccess) stats.escortSuccesses += 1;
  }
}
