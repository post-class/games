import type { CampaignMode, CampaignOutcome, CampaignRoute } from '../content/campaign';

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
  campaignModes: Record<CampaignMode, number>;
  campaignNodes: Record<string, { wins: number; losses: number }>;
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
    campaignModes: { canon: 0, expanded: 0 },
    campaignNodes: {},
  };
}

export function normalizeStatistics(raw: unknown): CampaignStatistics {
  const fallback = newStatistics();
  if (!raw || typeof raw !== 'object') return fallback;
  const r = raw as Partial<CampaignStatistics>;
  for (const k of [
    'shotsFired', 'hits', 'combatSeconds', 'missionsWon', 'missionsLost', 'longestWingmanSurvival',
    'rescuedWingmen', 'abandonedWingmen', 'navsReached', 'escortAttempts', 'escortSuccesses', 'seriesScore', 'campaignWins', 'campaignLosses', 'advanceCount', 'retreatCount',
  ] as const) {
    const value = r[k];
    if (typeof value === 'number' && Number.isFinite(value)) {
      // 勝利点は敗北時に負になるため、他の累積カウンタと同じ clamp をしない。
      fallback[k] = k === 'seriesScore' ? value : Math.max(0, value);
    }
  }
  if (r.campaignModes && typeof r.campaignModes === 'object') {
    for (const mode of ['canon', 'expanded'] as const) {
      const value = r.campaignModes[mode];
      if (typeof value === 'number' && Number.isFinite(value)) fallback.campaignModes[mode] = Math.max(0, Math.floor(value));
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
    mode: CampaignMode;
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
  stats.campaignModes[result.mode] = (stats.campaignModes[result.mode] ?? 0) + 1;
  const node = (stats.campaignNodes[result.node] ??= { wins: 0, losses: 0 });
  if (result.outcome === 'win') node.wins += 1;
  else node.losses += 1;
}

export const recordSeriesOutcome = recordCampaignOutcome;

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
