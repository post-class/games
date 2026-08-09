import {
  campaignNode,
  campaignStart,
  hasCampaignNode,
  isCampaignMode,
  isTerminal,
  newCampaignProgress,
  resolveCampaignOutcome,
  type CampaignHistoryEntry,
  type CampaignMode,
  type CampaignNodeId,
  isGateOutcome,
  type CampaignOutcome,
  type GateOutcome,
} from '../content/campaign';
import { PROTAGONISTS } from '../content/veil/people';
import { newNarrative, normalizeNarrative, type NarrativeState } from './narrative';
import { newAceStates, normalizeAceStates, type AceState } from '../content/aces';
import { newRoster, normalizeRoster, type RosterState } from './roster';
import { migrateFrontlineSystemId, newFrontlineState, normalizeFrontline, type FrontlineState } from '../content/frontline';
import { newSupplies, normalizeSupplies, type SupplyState } from './supplies';
import { newStatistics, normalizeStatistics, recordCampaignOutcome, type CampaignStatistics } from './statistics';

export type EndingQuality = 'victory' | 'pyrrhic' | 'draw' | 'defeat';

export interface LastSortieCondition {
  outcome: 'win' | 'loss';
  shipId: string;
  hullRatio: number;
  escortLost: boolean;
  missiles: Record<string, number>;
  flares: number;
}

export interface CampaignSave {
  /** 現在のキャンペーンノード */
  node: CampaignNodeId;
  /** canon=Enyo 起点の本家寄せ、expanded=従来の McCaffrey 起点、veil=THE VEIL FRONT 十章 */
  campaignMode: CampaignMode;
  /** 主人公として選んだ人物id（`confed-01`〜`-05`）。選択前は未定義 */
  protagonistId?: string;
  /** 選択結果で管理する4状態（帰還者／航路信頼／軍令信用／敵エースの誓約） */
  narrative: NarrativeState;
  /** 第10章で選んだ門の管理方法。選択前は未定義。`ending` とは独立の軸 */
  gateOutcome?: GateOutcome;
  /** 戦役シリーズの勝利点。totalKills とは別の進行値 */
  seriesScore: number;
  /** 勝敗分岐の見える記録 */
  campaignHistory: CampaignHistoryEntry[];
  /** 直前の勝敗が残した戦況メッセージ */
  campaignSituation: string;
  /** 通算撃墜数 */
  totalKills: number;
  /** 出撃回数 */
  sorties: number;
  /** クリアしたミッション id */
  cleared: string[];
  /** 飛行隊の名簿 (戦死は永続) */
  roster: RosterState;
  /** 授与済みの勲章 id */
  medals: string[];
  /** 撃墜したエースの数 */
  acesKilled: number;
  /** 宿敵の遭遇履歴。status=killed の人物は以後出現しない */
  aceStates: AceState[];
  /** 星系ごとの戦況と、次に挿入する動的作戦 */
  frontline: FrontlineState;
  dynamicMission?: import('../content/frontline').DynamicMissionRef;
  /** 艦内の有限資源 */
  supplies: SupplyState;
  /** 累積プレイ統計 */
  statistics: CampaignStatistics;
  /** 戦役の勝ち方。終端に着くまで未定義 */
  ending?: EndingQuality;
  /** 護衛対象を一度も失っていないか */
  noEscortLost: boolean;
  /** 僚機を一度も失っていないか */
  noWingmanLost: boolean;
  /** 保存時刻 (表示用) */
  savedAt: number;
  /** 帰艦直後の機体・兵装状態。次の格納庫判断に残す */
  lastSortie?: LastSortieCondition;
}

/**
 * 保存キーの版は上げない。
 *
 * 追加した `narrative` / `protagonistId` / `gateOutcome` はいずれも欠落耐性がある
 * （`parseSave` が `normalizeNarrative()` で既定値を作り、未知の主人公id・門の結末は
 * `undefined` に落とす）。旧 v3・v2 セーブをそのまま読み続けられるので、
 * 版を上げてプレイヤーの進行を捨てる理由がない。
 */
const KEY = 'multi-commander.campaign.v3';
const LEGACY_KEY = 'multi-commander.campaign.v2';
const SLOT_KEY_PREFIX = 'multi-commander.campaign.slot.v1.';
export const SAVE_SLOT_COUNT = 8;

export function newSave(mode: CampaignMode = 'expanded'): CampaignSave {
  return newCampaignSave(mode);
}

/** 新しい save を明示したモードで作る。既存の newSave() は expanded のまま。 */
export function newCampaignSave(mode: CampaignMode): CampaignSave {
  const progress = newCampaignProgress(mode);
  return {
    node: progress.currentNode,
    campaignMode: mode,
    seriesScore: progress.score,
    campaignHistory: [],
    campaignSituation: progress.lastSituation,
    totalKills: 0,
    sorties: 0,
    cleared: [],
    roster: newRoster(),
    medals: [],
    acesKilled: 0,
    aceStates: newAceStates(),
    frontline: newFrontlineState(),
    supplies: newSupplies(),
    statistics: newStatistics(),
    // 主人公（protagonistId）と門の結末（gateOutcome）は選択前なので未定義のまま。
    narrative: newNarrative(),
    noEscortLost: true,
    noWingmanLost: true,
    savedAt: Date.now(),
  };
}

export function loadSave(): CampaignSave | undefined {
  try {
    const raw = localStorage.getItem(KEY) ?? localStorage.getItem(LEGACY_KEY);
    return raw ? parseSave(raw) : undefined;
  } catch {
    return undefined;
  }
}

function parseSave(raw: string): CampaignSave | undefined {
  const parsed = JSON.parse(raw) as Partial<CampaignSave>;
  if (typeof parsed.node !== 'string') return undefined;
  const campaignMode: CampaignMode = isCampaignMode(parsed.campaignMode) ? parsed.campaignMode : 'expanded';
  const node = isTerminal(parsed.node) || hasCampaignNode(parsed.node, campaignMode) ? parsed.node : campaignStart(campaignMode);
  return {
    node,
    campaignMode,
    protagonistId: normalizeProtagonistId(parsed.protagonistId),
    narrative: normalizeNarrative(parsed.narrative),
    gateOutcome: isGateOutcome(parsed.gateOutcome) ? parsed.gateOutcome : undefined,
    seriesScore: finiteNumber(parsed.seriesScore, 0),
    campaignHistory: normalizeCampaignHistory(parsed.campaignHistory, campaignMode),
    campaignSituation: typeof parsed.campaignSituation === 'string'
      ? parsed.campaignSituation
      : isTerminal(node) ? '戦役の終端に到達した。' : campaignNode(node, campaignMode).situation,
    totalKills: parsed.totalKills ?? 0,
    sorties: parsed.sorties ?? 0,
    cleared: Array.isArray(parsed.cleared) ? parsed.cleared : [],
    roster: normalizeRoster(parsed.roster),
    medals: Array.isArray(parsed.medals) ? parsed.medals.filter((m) => typeof m === 'string') : [],
    acesKilled: parsed.acesKilled ?? 0,
    aceStates: normalizeAceStates(parsed.aceStates),
    frontline: normalizeFrontline(parsed.frontline),
    dynamicMission: normalizeDynamicMission(parsed.dynamicMission),
    supplies: normalizeSupplies(parsed.supplies),
    statistics: normalizeStatistics(parsed.statistics),
    ending: normalizeEnding(parsed.ending),
    noEscortLost: parsed.noEscortLost !== false,
      noWingmanLost: parsed.noWingmanLost !== false,
      savedAt: parsed.savedAt ?? Date.now(),
      lastSortie: normalizeLastSortie(parsed.lastSortie),
  };
}

function slotKey(slot: number): string {
  return `${SLOT_KEY_PREFIX}${Math.max(0, Math.min(SAVE_SLOT_COUNT - 1, Math.floor(slot)))}`;
}

export function loadSaveSlot(slot: number): CampaignSave | undefined {
  try {
    const raw = localStorage.getItem(slotKey(slot));
    return raw ? parseSave(raw) : undefined;
  } catch {
    return undefined;
  }
}

export function saveToSlot(save: CampaignSave, slot: number): void {
  try {
    save.savedAt = Date.now();
    localStorage.setItem(slotKey(slot), JSON.stringify(save));
  } catch {
    /* 保存できなくてもゲームは続行できる */
  }
}

export function clearSaveSlot(slot: number): void {
  try {
    localStorage.removeItem(slotKey(slot));
  } catch {
    /* ignore */
  }
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function normalizeCampaignHistory(raw: unknown, mode: CampaignMode): CampaignHistoryEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry): CampaignHistoryEntry[] => {
    if (!entry || typeof entry !== 'object') return [];
    const r = entry as Partial<CampaignHistoryEntry>;
    if (typeof r.node !== 'string' || !hasCampaignNode(r.node, mode)) return [];
    if (r.outcome !== 'win' && r.outcome !== 'loss') return [];
    if (typeof r.nextNode !== 'string' || (!isTerminal(r.nextNode) && !hasCampaignNode(r.nextNode, mode))) return [];
    if (r.route !== 'advance' && r.route !== 'hold' && r.route !== 'retreat') return [];
    return [{
      node: r.node,
      outcome: r.outcome,
      points: finiteNumber(r.points, 0),
      nextNode: r.nextNode,
      route: r.route,
    }];
  });
}

function normalizeDynamicMission(raw: unknown): CampaignSave['dynamicMission'] {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Partial<NonNullable<CampaignSave['dynamicMission']>>;
  if (typeof r.id !== 'string' || typeof r.returnNode !== 'string' || typeof r.seed !== 'number') return undefined;
  // 旧セーブの戦域名（McCaffrey / Gimle / Vega）は新戦域idへ移行して残す。
  // 判別できない値だけ、進行中の動的作戦を捨てる（次回ハブで再選択できる）。
  const system = migrateFrontlineSystemId(r.system);
  if (!system) return undefined;
  if (!['patrol', 'escort', 'strike', 'rescue', 'quiet', 'capital'].includes(String(r.kind))) return undefined;
  return { id: r.id, system, kind: r.kind!, seed: r.seed, returnNode: r.returnNode };
}

/** 主人公id。`PROTAGONISTS`（confed-01〜-05）にあるidだけ許可し、未知の値は捨てる */
function normalizeProtagonistId(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  return PROTAGONISTS.some((person) => person.id === raw) ? raw : undefined;
}

function normalizeEnding(raw: unknown): CampaignSave['ending'] {
  return raw === 'victory' || raw === 'pyrrhic' || raw === 'draw' || raw === 'defeat' ? raw : undefined;
}

function normalizeLastSortie(raw: unknown): LastSortieCondition | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Partial<LastSortieCondition>;
  if ((r.outcome !== 'win' && r.outcome !== 'loss') || typeof r.shipId !== 'string') return undefined;
  const missiles: Record<string, number> = {};
  if (r.missiles && typeof r.missiles === 'object') {
    for (const [id, count] of Object.entries(r.missiles)) {
      if (typeof count === 'number' && Number.isFinite(count)) missiles[id] = Math.max(0, Math.floor(count));
    }
  }
  return {
    outcome: r.outcome,
    shipId: r.shipId,
    hullRatio: finiteNumber(r.hullRatio, 0),
    escortLost: r.escortLost === true,
    missiles,
    flares: Math.max(0, Math.floor(finiteNumber(r.flares, 0))),
  };
}

export function writeSave(save: CampaignSave): void {
  try {
    save.savedAt = Date.now();
    localStorage.setItem(KEY, JSON.stringify(save));
  } catch {
    /* 保存できなくてもプレイは続行できる */
  }
}

/**
 * 固定キャンペーンの debrief 結果を save に反映する統合用 API。
 * App が既存の advance 呼び出しから置き換えるだけで、node・勝利点・
 * 戦況メッセージ・履歴・統計を一つの操作で同期できる。
 */
export function advanceCampaignSave(save: CampaignSave, outcome: CampaignOutcome) {
  const progress = {
    mode: save.campaignMode,
    currentNode: save.node,
    score: save.seriesScore,
    history: save.campaignHistory.map((entry) => ({ ...entry })),
    lastSituation: save.campaignSituation,
  };
  const transition = resolveCampaignOutcome(progress, outcome);
  save.node = transition.nextNode;
  save.seriesScore = transition.score;
  save.campaignHistory = progress.history;
  save.campaignSituation = transition.situation;
  recordCampaignOutcome(save.statistics, {
    mode: save.campaignMode,
    node: transition.node,
    outcome,
    points: transition.points,
    route: transition.route,
  });
  if (transition.nextNode === 'victory') save.ending = 'victory';
  if (transition.nextNode === 'defeat') save.ending = 'defeat';
  return transition;
}

export function clearSave(): void {
  try {
    localStorage.removeItem(KEY);
    localStorage.removeItem(LEGACY_KEY);
    for (let i = 0; i < SAVE_SLOT_COUNT; i++) localStorage.removeItem(slotKey(i));
  } catch {
    /* ignore */
  }
}
