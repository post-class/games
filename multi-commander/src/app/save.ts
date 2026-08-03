import { CAMPAIGN_START, type CampaignNodeId } from '../content/campaign';
import { newRoster, normalizeRoster, type RosterState } from './roster';

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
  /** 護衛対象を一度も失っていないか */
  noEscortLost: boolean;
  /** 僚機を一度も失っていないか */
  noWingmanLost: boolean;
  /** 保存時刻 (表示用) */
  savedAt: number;
}

const KEY = 'multi-commander.campaign.v2';

export function newSave(): CampaignSave {
  return {
    node: CAMPAIGN_START,
    totalKills: 0,
    sorties: 0,
    cleared: [],
    roster: newRoster(),
    medals: [],
    acesKilled: 0,
    noEscortLost: true,
    noWingmanLost: true,
    savedAt: Date.now(),
  };
}

export function loadSave(): CampaignSave | undefined {
  try {
    const raw = localStorage.getItem(KEY);
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
      noEscortLost: parsed.noEscortLost !== false,
      noWingmanLost: parsed.noWingmanLost !== false,
      savedAt: parsed.savedAt ?? Date.now(),
    };
  } catch {
    return undefined;
  }
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
  } catch {
    /* ignore */
  }
}
