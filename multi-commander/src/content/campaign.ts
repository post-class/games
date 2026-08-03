/**
 * 分岐キャンペーン。
 * 失敗してもゲームオーバーにはならず、戦況が悪化する敗北ルートへ分岐する。
 * 敗北ルートで勝てば勝ちルートに合流できる (WC の「持ち直せる」構造)。
 */

export type CampaignNodeId = string;

/** 終端 */
export const VICTORY = 'victory';
export const DEFEAT = 'defeat';

export interface CampaignNode {
  /** MISSIONS のキー */
  missionId: string;
  /** 勝ったときの次ノード (VICTORY で完全勝利) */
  onWin: CampaignNodeId;
  /** 負けたときの次ノード (DEFEAT で完全敗北) */
  onLoss: CampaignNodeId;
  /** 進行表示用の章番号 */
  chapter: number;
  /** 敗北ルートのミッションか */
  losingRoute?: boolean;
}

export const CAMPAIGN: Record<CampaignNodeId, CampaignNode> = {
  'm1-patrol': { missionId: 'm1-patrol', onWin: 'm2-escort', onLoss: 'l1-retreat', chapter: 1 },
  'm2-escort': { missionId: 'm2-escort', onWin: 'm2b-recon', onLoss: 'l1-retreat', chapter: 2 },
  // 偵察に失敗しても拠点は残る。強襲を飛ばして防衛戦へ落ちる
  'm2b-recon': { missionId: 'm2b-recon', onWin: 'm3-strike', onLoss: 'm4-defend', chapter: 3 },
  'm3-strike': { missionId: 'm3-strike', onWin: 'm3b-sar', onLoss: 'l2-last-stand', chapter: 4 },
  // 救助は失敗しても戦線は動かない。人を失っただけで先へ進む
  'm3b-sar': { missionId: 'm3b-sar', onWin: 'm4-defend', onLoss: 'm4-defend', chapter: 5 },
  'm4-defend': { missionId: 'm4-defend', onWin: 'm5-ace', onLoss: 'l2-last-stand', chapter: 6 },
  'm5-ace': { missionId: 'm5-ace', onWin: 'm5b-intercept', onLoss: 'l2-last-stand', chapter: 7 },
  'm5b-intercept': {
    missionId: 'm5b-intercept',
    onWin: 'm6-flagship',
    onLoss: 'l2-last-stand',
    chapter: 8,
  },
  'm6-flagship': { missionId: 'm6-flagship', onWin: VICTORY, onLoss: 'l2-last-stand', chapter: 9 },

  // 敗北ルート: 勝てば本線に合流する
  'l1-retreat': {
    missionId: 'l1-retreat',
    onWin: 'm2b-recon',
    onLoss: 'l2-last-stand',
    chapter: 3,
    losingRoute: true,
  },
  'l2-last-stand': {
    missionId: 'l2-last-stand',
    onWin: 'm5-ace',
    onLoss: DEFEAT,
    chapter: 6,
    losingRoute: true,
  },
};

export const CAMPAIGN_START: CampaignNodeId = 'm1-patrol';
/** 章の総数 (進行表示用) */
export const TOTAL_CHAPTERS = 9;

export function campaignNode(id: CampaignNodeId): CampaignNode {
  const n = CAMPAIGN[id];
  if (!n) throw new Error(`unknown campaign node: ${id}`);
  return n;
}

export function isTerminal(id: CampaignNodeId): boolean {
  return id === VICTORY || id === DEFEAT;
}

export function advance(id: CampaignNodeId, outcome: 'win' | 'loss'): CampaignNodeId {
  const node = campaignNode(id);
  return outcome === 'win' ? node.onWin : node.onLoss;
}
