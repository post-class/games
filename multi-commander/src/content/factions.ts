import type { Faction } from './ships';

/** 陣営の敵対関係。neutral はどちらとも交戦しない。 */
export function isHostile(a: Faction, b: Faction): boolean {
  if (a === 'neutral' || b === 'neutral') return false;
  return a !== b;
}

export function factionLabel(f: Faction): string {
  switch (f) {
    case 'confed':
      return '連邦';
    case 'kilrathi':
      return 'キルラシー';
    default:
      return '中立';
  }
}

/** HUD の色 (プレイヤー陣営を味方色として扱う) */
export function factionColor(f: Faction, playerFaction: Faction): string {
  if (f === 'neutral') return 'var(--neutral)';
  return f === playerFaction ? 'var(--friend)' : 'var(--enemy)';
}
