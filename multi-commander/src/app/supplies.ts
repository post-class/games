/** 艦内の有限な弾薬。出撃のたびに減り、護衛や補給作戦で戻る。 */
export interface SupplyState {
  missiles: Record<string, number>;
  flares: number;
  spareParts: number;
}

export function newSupplies(): SupplyState {
  return {
    missiles: { dumbfire: 24, 'heat-seeker': 18, 'image-rec': 8, torpedo: 6 },
    flares: 72,
    spareParts: 12,
  };
}

export function normalizeSupplies(raw: unknown): SupplyState {
  const fallback = newSupplies();
  if (!raw || typeof raw !== 'object') return fallback;
  const r = raw as Partial<SupplyState>;
  if (r.missiles && typeof r.missiles === 'object') {
    for (const id of Object.keys(fallback.missiles)) {
      const v = r.missiles[id];
      if (typeof v === 'number' && Number.isFinite(v)) fallback.missiles[id] = Math.max(0, Math.floor(v));
    }
  }
  if (typeof r.flares === 'number' && Number.isFinite(r.flares)) fallback.flares = Math.max(0, Math.floor(r.flares));
  if (typeof r.spareParts === 'number' && Number.isFinite(r.spareParts)) fallback.spareParts = Math.max(0, Math.floor(r.spareParts));
  return fallback;
}

export function availableMissiles(supplies: SupplyState, missileId: string): number {
  const value = supplies.missiles?.[missileId];
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

export function clampLoadout(
  supplies: SupplyState,
  missiles: Array<{ missileId: string; count: number }> | undefined,
): Array<{ missileId: string; count: number }> | undefined {
  if (!missiles) return undefined;
  // 同じ種別が複数スロットに現れる定義もあり得るため、各行に在庫全量を
  // 適用してはいけない。先に割り当てた行から在庫を引いていく。
  const remaining = new Map<string, number>();
  return missiles
    .map((m) => {
      const available = remaining.get(m.missileId) ?? availableMissiles(supplies, m.missileId);
      const count = Math.min(nonNegativeCount(m.count), available);
      remaining.set(m.missileId, available - count);
      return { missileId: m.missileId, count };
    })
    .filter((m) => m.count > 0);
}

/** 難易度補正などで要求搭載数を増減させる。実在庫の上限は clampLoadout が適用する。 */
export function scaleLoadout(
  missiles: Array<{ missileId: string; count: number }> | undefined,
  scale: number,
): Array<{ missileId: string; count: number }> | undefined {
  if (!missiles) return undefined;
  const safeScale = Number.isFinite(scale) ? Math.max(0, scale) : 1;
  return missiles.map((m) => ({
    missileId: m.missileId,
    count: Math.max(0, Math.ceil(nonNegativeCount(m.count) * safeScale)),
  }));
}

export function consumeLoadout(supplies: SupplyState, missiles: Array<{ missileId: string; count: number }> | undefined): void {
  for (const m of missiles ?? []) {
    if (!Object.prototype.hasOwnProperty.call(supplies.missiles, m.missileId)) continue;
    supplies.missiles[m.missileId] = Math.max(0, availableMissiles(supplies, m.missileId) - nonNegativeCount(m.count));
  }
}

export function replenishForMission(supplies: SupplyState, outcome: 'win' | 'loss', escortLost: boolean): void {
  // 勝利時も無限補給にはしない。護衛を守れた任務だけ少し戻る。
  if (outcome === 'win' && !escortLost) {
    supplies.flares = Math.min(96, supplies.flares + 4);
    supplies.spareParts = Math.min(20, supplies.spareParts + 1);
  } else {
    supplies.spareParts = Math.max(0, supplies.spareParts - (escortLost ? 2 : 1));
  }
}

function nonNegativeCount(value: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}
