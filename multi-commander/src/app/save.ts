import { CAMPAIGN_START, type CampaignNodeId } from '../content/campaign';
import { newAceStates, normalizeAceStates, type AceState } from '../content/aces';
import { newRoster, normalizeRoster, type RosterState } from './roster';
import { newFrontlineState, normalizeFrontline, type FrontlineState } from '../content/frontline';
import { newSupplies, normalizeSupplies, type SupplyState } from './supplies';
import { newStatistics, normalizeStatistics, type CampaignStatistics } from './statistics';

export type EndingQuality = 'victory' | 'pyrrhic' | 'draw' | 'defeat';

export interface CampaignSave {
  /** 現在のキャンペーンノード */
  node: CampaignNodeId;
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
}

const KEY = 'multi-commander.campaign.v3';
const LEGACY_KEY = 'multi-commander.campaign.v2';

export function newSave(): CampaignSave {
  return {
    node: CAMPAIGN_START,
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
    noEscortLost: true,
    noWingmanLost: true,
    savedAt: Date.now(),
  };
}

export function loadSave(): CampaignSave | undefined {
  try {
    const raw = localStorage.getItem(KEY) ?? localStorage.getItem(LEGACY_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Partial<CampaignSave>;
    if (typeof parsed.node !== 'string') return undefined;
    return {
      node: parsed.node,
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
    };
  } catch {
    return undefined;
  }
}

function normalizeDynamicMission(raw: unknown): CampaignSave['dynamicMission'] {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Partial<NonNullable<CampaignSave['dynamicMission']>>;
  if (typeof r.id !== 'string' || typeof r.returnNode !== 'string' || typeof r.seed !== 'number') return undefined;
  if (!['McCaffrey', 'Gimle', 'Vega'].includes(String(r.system))) return undefined;
  if (!['patrol', 'escort', 'strike', 'rescue', 'quiet', 'capital'].includes(String(r.kind))) return undefined;
  return { id: r.id, system: r.system!, kind: r.kind!, seed: r.seed, returnNode: r.returnNode };
}

function normalizeEnding(raw: unknown): CampaignSave['ending'] {
  return raw === 'victory' || raw === 'pyrrhic' || raw === 'draw' || raw === 'defeat' ? raw : undefined;
}

export function writeSave(save: CampaignSave): void {
  try {
    save.savedAt = Date.now();
    localStorage.setItem(KEY, JSON.stringify(save));
  } catch {
    /* 保存できなくてもプレイは続行できる */
  }
}

export function clearSave(): void {
  try {
    localStorage.removeItem(KEY);
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    /* ignore */
  }
}
