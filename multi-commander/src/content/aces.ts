/**
 * 戦域をまたいで生き残る宿敵。
 *
 * エースは「そのミッションの強い敵」ではなく、遭遇・離脱・撃墜を
 * キャンペーンに持ち越す人物として扱う。保存データに未知の人物が
 * 入っていてもゲームを壊さないよう、ここで必ず正規化する。
 */

export interface AceDefinition {
  id: string;
  pilot: string;
  callsign: string;
  shipId: string;
  skill: number;
  bio: string;
}

export interface AceState {
  id: string;
  encounters: number;
  kills: number;
  skill: number;
  status: 'active' | 'killed';
  escaped: number;
  lastMission?: string;
  lastVictim?: string;
}

export const ACES: AceDefinition[] = [
  {
    id: 'bhurak',
    pilot: 'Bhurak nar Caxki',
    callsign: 'Caxki',
    shipId: 'dralthi',
    skill: 0.84,
    bio: '艦隊を沈めることだけを目的に飛ぶ、執拗な狩人。',
  },
  {
    id: 'khajja',
    pilot: 'Khajja nar Ragitika',
    callsign: '血塗られた爪',
    shipId: 'jalthi',
    skill: 0.9,
    bio: '撃墜した相手の名を覚え、次の借りを必ず返す。',
  },
  {
    id: 'dakhath',
    pilot: 'Dakhath «Deathstroke»',
    callsign: 'Deathstroke',
    shipId: 'dralthi',
    skill: 0.88,
    bio: '戦線の穴から現れ、帰投する船だけを狙う死刑執行人。',
  },
];

export function aceDef(id: string): AceDefinition | undefined {
  return ACES.find((a) => a.id === id);
}

export function aceIdForPilot(pilot: string | undefined): string | undefined {
  return ACES.find((a) => a.pilot === pilot)?.id;
}

export function newAceStates(): AceState[] {
  return ACES.map((a) => ({
    id: a.id,
    encounters: 0,
    kills: 0,
    skill: a.skill,
    status: 'active',
    escaped: 0,
  }));
}

export function normalizeAceStates(raw: unknown): AceState[] {
  const fallback = newAceStates();
  if (!Array.isArray(raw)) return fallback;
  const byId = new Map(fallback.map((a) => [a.id, a]));
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const p = item as Partial<AceState>;
    if (typeof p.id !== 'string') continue;
    const base = byId.get(p.id);
    if (!base) continue;
    base.encounters = integerOr(p.encounters, 0);
    base.kills = integerOr(p.kills, 0);
    base.skill = clamp(typeof p.skill === 'number' ? p.skill : base.skill, 0.5, 1);
    base.status = p.status === 'killed' ? 'killed' : 'active';
    base.escaped = integerOr(p.escaped, 0);
    base.lastMission = typeof p.lastMission === 'string' ? p.lastMission : undefined;
    base.lastVictim = typeof p.lastVictim === 'string' ? p.lastVictim : undefined;
  }
  return [...byId.values()];
}

export function aceState(states: AceState[], pilotOrId: string): AceState | undefined {
  const id = aceDef(pilotOrId)?.id ?? aceIdForPilot(pilotOrId) ?? pilotOrId;
  return states.find((a) => a.id === id);
}

export function recordAceEncounter(state: AceState, missionId: string): void {
  state.encounters += 1;
  state.lastMission = missionId;
}

export function recordAceEscape(state: AceState): void {
  if (state.status === 'killed') return;
  state.escaped += 1;
  state.skill = clamp(state.skill + 0.015, 0.5, 1);
}

export function recordAceKill(state: AceState): void {
  state.status = 'killed';
  state.kills += 1;
}

function integerOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
