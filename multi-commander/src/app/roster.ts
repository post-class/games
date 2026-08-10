import {
  personalityOf,
  pilotDef,
  REPLACEMENT_POOL,
  STARTING_SQUADRON,
  type PilotDef,
} from '../content/pilots';
import { PROTAGONIST_BOND_LIMIT, protagonistInitialBond } from '../content/dialogue';

/**
 * 飛行隊の名簿の実行時状態。
 *
 * 「僚機が死んだら二度と出てこない」ことを担保するのがこのモジュールの主目的。
 * 撃墜数・関係値・負傷は localStorage に保存され、キャンペーンを通じて持ち越される。
 */

export type PilotStatus = 'active' | 'wounded' | 'dead' | 'transferred';

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
  /**
   * 前回の出撃以降に酒場で会話を終えたか（T3-⑪）。
   *
   * 出撃準備で僚機の `obedience` に上乗せされる。「話した相手は指示に早く応え、
   * 話していない相手は硬い」を、既存の bond → 性格補正の経路に載せるための旗。
   * 出撃を1回消化すると `applySortie` で降りる。
   */
  talkedSinceSortie?: boolean;
  /** 戦死した任務 (追悼用) */
  diedIn?: string;
  /** 戦死した章 */
  diedChapter?: number;
  /** 通算出撃に応じた昇進段階 */
  rank: number;
  /** 他艦隊との転属回数（新しい補充兵を受け入れた回数） */
  transfers: number;
  transferredIn?: boolean;
}

export interface RosterState {
  pilots: PilotState[];
  /** 補充候補の残り */
  reserves: string[];
  /** 直近の出撃で選んだ僚機 */
  lastWingman?: string;
  /** 僚機同士の関係値。未登録の組み合わせは 0。 */
  relations: Record<string, number>;
}

export function newRoster(): RosterState {
  return {
    pilots: STARTING_SQUADRON.map((id) => freshPilot(id)),
    reserves: [...REPLACEMENT_POOL],
    relations: {},
  };
}

function freshPilot(id: string): PilotState {
  // 初期技量は名簿定義の値（人物名簿の戦闘級から導出される）をそのまま使う。
  const def = pilotDef(id);
  return {
    id,
    status: 'active',
    skill: def.skill,
    kills: 0,
    sorties: 0,
    benchedFor: 0,
    bond: 0,
    rank: 0,
    transfers: 0,
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
    if (pilots.some((existing) => existing.id === p.id)) continue;
    const rawStatus = p.status === 'dead' || p.status === 'wounded' || p.status === 'transferred' ? p.status : 'active';
    const benchedFor = nonNegativeInt(p.benchedFor, 0);
    const normalizedStatus = rawStatus === 'wounded' && benchedFor === 0 ? 'active' : rawStatus;
    pilots.push({
      id: p.id,
      status: normalizedStatus,
      skill: typeof p.skill === 'number' ? clamp01(p.skill) : pilotDef(p.id).skill,
      kills: nonNegativeInt(p.kills, 0),
      sorties: nonNegativeInt(p.sorties, 0),
      benchedFor: normalizedStatus === 'wounded' ? Math.max(1, benchedFor) : 0,
      bond: typeof p.bond === 'number' ? Math.max(-1, Math.min(1, p.bond)) : 0,
      diedIn: typeof p.diedIn === 'string' ? p.diedIn : undefined,
      diedChapter: nonNegativeInt(p.diedChapter, 0) || undefined,
      rank: Math.min(3, nonNegativeInt(p.rank, 0)),
      transfers: nonNegativeInt(p.transfers, 0),
      transferredIn: p.transferredIn === true,
      talkedSinceSortie: p.talkedSinceSortie === true,
    });
  }
  if (pilots.length === 0) return fallback;
  const pilotIds = new Set(pilots.map((p) => p.id));
  const reserveIds = Array.isArray(r.reserves) ? r.reserves : REPLACEMENT_POOL;
  const reserves: string[] = [];
  for (const id of reserveIds) {
    if (typeof id !== 'string' || pilotIds.has(id) || reserves.includes(id)) continue;
    try {
      pilotDef(id);
      reserves.push(id);
    } catch {
      // 保存データに混入した未知の補充兵は、戦死時の補充処理で例外にしない。
    }
  }
  const relations: Record<string, number> = {};
  if (r.relations && typeof r.relations === 'object') {
    for (const [key, value] of Object.entries(r.relations)) {
      if (typeof value === 'number' && Number.isFinite(value)) relations[key] = Math.max(-1, Math.min(1, value));
    }
  }
  return { pilots, reserves, lastWingman: typeof r.lastWingman === 'string' ? r.lastWingman : undefined, relations };
}

function nonNegativeInt(v: unknown, d: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : d;
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
  const rank = (p: PilotState) => (p.status === 'dead' ? 3 : p.status === 'transferred' ? 2 : p.status === 'wounded' ? 1 : 0);
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

// ───────── 関係値 (bond) の見せ方 ─────────

/**
 * 関係値の段階（T3-⑪）。
 *
 * 以前は `信頼 / 不信 / ——` の3値に潰していたので、酒場で1回話しても
 * 表示が動かず「関係 ——」のままだった。bond を5段階に開き、
 * 一度の会話でも段階が動きうるようにする。並びは bond の昇順。
 */
export const RELATION_STAGES = ['不信', '初対面', '顔見知り', '信頼', '盟友'] as const;

export interface RelationStage {
  label: string;
  /** 0..RELATION_STAGES.length-1 */
  step: number;
  /** 段階の最大値（表示の分母） */
  max: number;
}

/** bond の境界。`>= 下限` で次の段階へ上がる。 */
const RELATION_THRESHOLDS = { distrust: -0.2, acquainted: 0.12, trust: 0.3, ally: 0.6 };

/**
 * bond（と「まだ一緒に飛んでいないか」）から段階を決める。
 *
 * 一度も出撃を共にしていない相手は、bond が中立でも `初対面`。
 * 出撃を共にした後は最低でも `顔見知り` になる。
 */
export function relationStage(p: Pick<PilotState, 'bond' | 'sorties'>): RelationStage {
  const max = RELATION_STAGES.length - 1;
  const bond = Number.isFinite(p.bond) ? p.bond : 0;
  let step: number;
  if (bond < RELATION_THRESHOLDS.distrust) step = 0;
  else if (bond < RELATION_THRESHOLDS.acquainted) step = p.sorties > 0 ? 2 : 1;
  else if (bond < RELATION_THRESHOLDS.trust) step = 2;
  else if (bond < RELATION_THRESHOLDS.ally) step = 3;
  else step = 4;
  return { label: RELATION_STAGES[step], step, max };
}

/**
 * 選任した主人公に応じて、まだ一緒に飛んでいない僚機の初期関係値を寄せる（T5-⑬c）。
 *
 * 隊長格を選べば僚機が最初から少し信頼していて、訓練生を選べば初対面から始まる。
 * **変えるのは関係値だけ**で、技量・機体・敵の強さ・難易度には触れない。
 *
 * - 動かすのは `sorties === 0` の隊員だけ。既に一緒に飛んだ相手の積み上げは書き換えない
 *   （再選択やロードで関係値が巻き戻らないようにするため）。
 * - 量は `PROTAGONIST_BOND_LIMIT`（±0.2）で丸める。`relationStage()` の5段階の刻みを
 *   壊さず、開始時点で「不信」に落ちる値も作らない。
 *
 * 同じ引数で何度呼んでも結果は同じ（冪等）。
 */
export function applyProtagonistInitialBond(roster: RosterState, protagonistId: string | undefined): number {
  const offset = protagonistInitialBond(protagonistId);
  const clamped = Math.max(-PROTAGONIST_BOND_LIMIT, Math.min(PROTAGONIST_BOND_LIMIT, offset));
  for (const p of roster.pilots) {
    if (p.sorties > 0) continue;
    p.bond = clamped;
  }
  return clamped;
}

/** bond を -1..+1 に収めて動かす。実際に動いた量を返す（端で止まったら 0）。 */
export function shiftBond(p: PilotState, delta: number): number {
  if (!Number.isFinite(delta) || delta === 0) return 0;
  const before = Number.isFinite(p.bond) ? p.bond : 0;
  const after = Math.max(-1, Math.min(1, before + delta));
  p.bond = after;
  return after - before;
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
  // 欠場カウントを進める。酒場で話した効果は1回の出撃で使い切る。
  for (const p of roster.pilots) {
    p.talkedSinceSortie = false;
    if (p.status === 'wounded') {
      p.benchedFor = Math.max(0, p.benchedFor - 1);
      if (p.benchedFor === 0) p.status = 'active';
    }
  }

  const id = outcome.wingmanId;
  if (!id) return;
  const p = pilotState(roster, id);
  if (!p || p.status !== 'active') return;
  const hullRatio =
    typeof outcome.wingmanHullRatio === 'number' && Number.isFinite(outcome.wingmanHullRatio)
      ? Math.max(0, Math.min(1, outcome.wingmanHullRatio))
      : 1;

  p.sorties = nonNegativeInt(p.sorties, 0) + 1;
  p.kills += nonNegativeInt(outcome.wingmanKills, 0);
  // 戦死しても、その出撃で条件を満たした昇進段階は記録する。
  p.rank = Math.min(3, Math.floor(p.sorties / 3));

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
        shiftRelation(roster, id, other.id, -0.15);
      }
    }
    fillVacancy(roster);
    return;
  }

  // 生還: 技量が伸びる
  const growth = personalityOf(id).growth;
  p.skill = clamp01(p.skill + 0.018 * growth);
  // 長期出撃者は前線の別飛行隊へ一時転属し、代わりに補充兵が来る。
  // 旧隊員を active のまま残すと、補充のたびに飛行隊が膨張する。
  if (p.sorties % 5 === 0 && hullRatio >= 0.3 && roster.reserves.length > 0) {
    const transferred = roster.reserves.shift()!;
    if (!roster.pilots.some((other) => other.id === transferred)) {
      p.transfers += 1;
      p.status = 'transferred';
      roster.pilots.push({ ...freshPilot(transferred), transferredIn: true });
    }
  }

  // 大破して帰ったら欠場
  if (hullRatio < 0.3) {
    p.status = 'wounded';
    p.benchedFor = hullRatio < 0.12 ? 3 : 2;
  }

  if (outcome.rescued) {
    p.bond = Math.min(1, p.bond + 0.3);
    for (const other of roster.pilots) if (other.id !== id && other.status !== 'dead') shiftRelation(roster, id, other.id, 0.1);
  } else if (outcome.abandoned) {
    p.bond = Math.max(-1, p.bond - 0.35);
    for (const other of roster.pilots) if (other.id !== id && other.status !== 'dead') shiftRelation(roster, id, other.id, -0.08);
  } else p.bond = Math.min(1, p.bond + 0.05);
}

/** 戦死者が出たら補充を1人入れる */
function fillVacancy(roster: RosterState): void {
  while (roster.reserves.length > 0) {
    const id = roster.reserves.shift()!;
    if (roster.pilots.some((p) => p.id === id)) continue;
    try {
      roster.pilots.push(freshPilot(id));
      return;
    } catch {
      // 破損した保存データの補充 id は読み飛ばして次候補を試す。
    }
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

export function relationKey(a: string, b: string): string {
  return [a, b].sort().join(':');
}

export function relationBetween(roster: RosterState, a: string, b: string): number {
  return Math.max(-1, Math.min(1, roster.relations[relationKey(a, b)] ?? 0));
}

function shiftRelation(roster: RosterState, a: string, b: string, amount: number): void {
  if (a === b) return;
  roster.relations ??= {};
  const key = relationKey(a, b);
  roster.relations[key] = Math.max(-1, Math.min(1, (roster.relations[key] ?? 0) + amount));
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
