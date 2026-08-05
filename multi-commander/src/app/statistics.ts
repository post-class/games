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
  };
}

export function normalizeStatistics(raw: unknown): CampaignStatistics {
  const fallback = newStatistics();
  if (!raw || typeof raw !== 'object') return fallback;
  const r = raw as Partial<CampaignStatistics>;
  for (const k of ['shotsFired', 'hits', 'combatSeconds', 'missionsWon', 'missionsLost', 'longestWingmanSurvival', 'rescuedWingmen', 'abandonedWingmen'] as const) {
    const value = r[k];
    if (typeof value === 'number' && Number.isFinite(value)) fallback[k] = Math.max(0, value);
  }
  if (r.shipsFlown && typeof r.shipsFlown === 'object') {
    for (const [id, value] of Object.entries(r.shipsFlown)) {
      if (typeof value === 'number' && Number.isFinite(value)) fallback.shipsFlown[id] = Math.max(0, Math.floor(value));
    }
  }
  return fallback;
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
}
