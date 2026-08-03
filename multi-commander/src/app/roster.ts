import {
  personalityOf,
  pilotDef,
  REPLACEMENT_POOL,
  STARTING_SQUADRON,
  type PilotDef,
} from '../content/pilots';

/**
 * 飛行隊の名簿の実行時状態。
 *
 * 「僚機が死んだら二度と出てこない」ことを担保するのがこのモジュールの主目的。
 * 撃墜数・関係値・負傷は localStorage に保存され、キャンペーンを通じて持ち越される。
 */

export type PilotStatus = 'active' | 'wounded' | 'dead';

export interface PilotState {
  id: string;
  status: PilotStatus;
  /** 現在の技量 (生き延びるほど伸びる) */
  skill: number;
  /** 通算撃墜数 */
  kills: number;
  /** 出撃回数 */
  sorties: number;
  /** 負傷で欠場する残りミッション数 */
  benchedFor: number;
  /**
   * プレイヤーとの関係 -1..+1。
   * 助けられた／置き去りにされたで動き、酒場の会話と無線の口調が変わる。
   */
  bond: number;
  /** 戦死した任務 (追悼用) */
  diedIn?: string;
  /** 戦死した章 */
  diedChapter?: number;
}

export interface RosterState {
  pilots: PilotState[];
  /** 補充候補の残り */
  reserves: string[];
  /** 直近の出撃で選んだ僚機 */
  lastWingman?: string;
}

export function newRoster(): RosterState {
  return {
    pilots: STARTING_SQUADRON.map((id) => freshPilot(id)),
    reserves: [...REPLACEMENT_POOL],
  };
}

function freshPilot(id: string): PilotState {
  const def = pilotDef(id);
  return {
    id,
    status: 'active',
    skill: def.skill,
    kills: 0,
    sorties: 0,
    benchedFor: 0,
    bond: 0,
  };
}

/** 保存データから復元する (未知の id は捨てる) */
export function normalizeRoster(raw: unknown): RosterState {
  const fallback = newRoster();
  if (!raw || typeof raw !== 'object') return fallback;
  const r = raw as Partial<RosterState>;
  if (!Array.isArray(r.pilots)) return fallback;
  const pilots: PilotState[] = [];
  for (const p of r.pilots) {
    if (!p || typeof p.id !== 'string') continue;
    try {
      pilotDef(p.id);
    } catch {
      continue;
    }
    pilots.push({
      id: p.id,
      status: p.status === 'dead' || p.status === 'wounded' ? p.status : 'active',
      skill: typeof p.skill === 'number' ? clamp01(p.skill) : pilotDef(p.id).skill,
      kills: numberOr(p.kills, 0),
      sorties: numberOr(p.sorties, 0),
      benchedFor: numberOr(p.benchedFor, 0),
      bond: typeof p.bond === 'number' ? Math.max(-1, Math.min(1, p.bond)) : 0,
      diedIn: typeof p.diedIn === 'string' ? p.diedIn : undefined,
      diedChapter: typeof p.diedChapter === 'number' ? p.diedChapter : undefined,
    });
  }
  if (pilots.length === 0) return fallback;
  const reserves = Array.isArray(r.reserves)
    ? r.reserves.filter((id): id is string => typeof id === 'string')
    : [...REPLACEMENT_POOL];
  return { pilots, reserves, lastWingman: r.lastWingman };
}

function numberOr(v: unknown, d: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
}
function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// ───────── 参照 ─────────

export function pilotState(roster: RosterState, id: string): PilotState | undefined {
  return roster.pilots.find((p) => p.id === id);
}

/** 今すぐ出撃できるパイロット */
export function availablePilots(roster: RosterState): PilotState[] {
  return roster.pilots.filter((p) => p.status === 'active' && p.benchedFor <= 0);
}

/** 名簿表示用。生存者を先に、戦死者を後ろにまとめる */
export function rosterForDisplay(roster: RosterState): PilotState[] {
  const rank = (p: PilotState) => (p.status === 'dead' ? 2 : p.status === 'wounded' ? 1 : 0);
  return [...roster.pilots].sort((a, b) => rank(a) - rank(b) || b.kills - a.kills);
}

export function defOf(p: PilotState): PilotDef {
  return pilotDef(p.id);
}

/** 撃墜数の順位表 (プレイヤーも含めて比較する) */
export interface KillBoardRow {
  name: string;
  kills: number;
  status: PilotStatus | 'player';
  isPlayer?: boolean;
}

export function killBoard(roster: RosterState, playerKills: number): KillBoardRow[] {
  const rows: KillBoardRow[] = roster.pilots.map((p) => ({
    name: defOf(p).callsign,
    kills: p.kills,
    status: p.status,
  }));
  rows.push({ name: 'あなた', kills: playerKills, status: 'player', isPlayer: true });
  rows.sort((a, b) => b.kills - a.kills);
  return rows;
}

// ───────── 出撃結果の反映 ─────────

export interface SortieOutcome {
  /** 出撃した僚機 */
  wingmanId?: string;
  /** その僚機が撃墜されたか */
  wingmanLost: boolean;
  /** 僚機が上げた撃墜数 */
  wingmanKills: number;
  /** 僚機の残ハル率 (0..1)。低いと負傷して欠場する */
  wingmanHullRatio: number;
  /** プレイヤーが僚機を守れたか (僚機が窮地で助けを求め、生還したか) */
  rescued: boolean;
  /** 僚機が助けを求めたのに応えなかったか */
  abandoned: boolean;
  /** ミッション名 (追悼用) */
  missionTitle: string;
  chapter: number;
}

/**
 * 出撃の結果を名簿へ反映する。
 *
 * - 戦死は取り返しがつかない (status = 'dead' で以後出撃候補から外れる)
 * - 生き延びれば技量が伸びる
 * - 大破して帰ると数ミッション欠場する
 * - 助けた／置き去りにしたで関係値が動く
 */
export function applySortie(roster: RosterState, outcome: SortieOutcome): void {
  // 欠場カウントを進める
  for (const p of roster.pilots) {
    if (p.status === 'wounded') {
      p.benchedFor = Math.max(0, p.benchedFor - 1);
      if (p.benchedFor === 0) p.status = 'active';
    }
  }

  const id = outcome.wingmanId;
  if (!id) return;
  const p = pilotState(roster, id);
  if (!p || p.status === 'dead') return;

  p.sorties += 1;
  p.kills += Math.max(0, outcome.wingmanKills);

  if (outcome.wingmanLost) {
    p.status = 'dead';
    p.benchedFor = 0;
    p.diedIn = outcome.missionTitle;
    p.diedChapter = outcome.chapter;
    // 置き去りにされて死んだ場合、他の隊員の心証も悪くなる
    if (outcome.abandoned) {
      for (const other of roster.pilots) {
        if (other.id === id || other.status === 'dead') continue;
        other.bond = Math.max(-1, other.bond - 0.25);
      }
    }
    fillVacancy(roster);
    return;
  }

  // 生還: 技量が伸びる
  const growth = personalityOf(id).growth;
  p.skill = clamp01(p.skill + 0.018 * growth);

  // 大破して帰ったら欠場
  if (outcome.wingmanHullRatio < 0.3) {
    p.status = 'wounded';
    p.benchedFor = outcome.wingmanHullRatio < 0.12 ? 3 : 2;
  }

  if (outcome.rescued) p.bond = Math.min(1, p.bond + 0.3);
  else if (outcome.abandoned) p.bond = Math.max(-1, p.bond - 0.35);
  else p.bond = Math.min(1, p.bond + 0.05);
}

/** 戦死者が出たら補充を1人入れる */
function fillVacancy(roster: RosterState): void {
  while (roster.reserves.length > 0) {
    const id = roster.reserves.shift()!;
    if (roster.pilots.some((p) => p.id === id)) continue;
    roster.pilots.push(freshPilot(id));
    return;
  }
}

/** 戦死者の一覧 (追悼画面用) */
export function fallen(roster: RosterState): PilotState[] {
  return roster.pilots.filter((p) => p.status === 'dead');
}

/** 出撃可能な僚機がいるか */
export function hasWingman(roster: RosterState): boolean {
  return availablePilots(roster).length > 0;
}

/** 既定で選ばれる僚機 (前回と同じ人がいればその人) */
export function defaultWingman(roster: RosterState): string | undefined {
  const avail = availablePilots(roster);
  if (avail.length === 0) return undefined;
  if (roster.lastWingman && avail.some((p) => p.id === roster.lastWingman)) {
    return roster.lastWingman;
  }
  // 技量が高い順
  return [...avail].sort((a, b) => b.skill - a.skill)[0].id;
}
