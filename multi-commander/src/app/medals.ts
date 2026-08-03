/**
 * 階級と勲章。
 *
 * 「戦果が記録に残る」ことで、撃墜数が単なる数字ではなくなる。
 * 授与式はデブリーフィングの後に挟む。
 */

export interface Rank {
  id: string;
  label: string;
  /** この階級に上がるのに必要な出撃回数 */
  sorties: number;
  /** 必要な通算撃墜数 */
  kills: number;
}

export const RANKS: Rank[] = [
  { id: '2lt', label: '少尉', sorties: 0, kills: 0 },
  { id: '1lt', label: '中尉', sorties: 3, kills: 4 },
  { id: 'capt', label: '大尉', sorties: 6, kills: 10 },
  { id: 'maj', label: '少佐', sorties: 9, kills: 18 },
  { id: 'ltcol', label: '中佐', sorties: 12, kills: 28 },
  { id: 'col', label: '大佐', sorties: 16, kills: 40 },
];

export function rankFor(sorties: number, kills: number): Rank {
  let best = RANKS[0];
  for (const r of RANKS) {
    if (sorties >= r.sorties && kills >= r.kills) best = r;
  }
  return best;
}

export interface Medal {
  id: string;
  label: string;
  /** 授与理由の説明 */
  reason: string;
  /** 授与条件 */
  test: (s: MedalContext) => boolean;
}

export interface MedalContext {
  /** 通算撃墜数 */
  totalKills: number;
  /** 出撃回数 */
  sorties: number;
  /** クリアしたミッション数 */
  cleared: number;
  /** 直近の任務での撃墜数 */
  missionKills: number;
  /** 直近の任務で無傷だったか */
  flawless: boolean;
  /** エースを撃墜したか (通算) */
  acesKilled: number;
  /** 護衛対象を一度も失っていないか */
  noEscortLost: boolean;
  /** 僚機を一度も失っていないか */
  noWingmanLost: boolean;
}

export const MEDALS: Medal[] = [
  {
    id: 'bronze-star',
    label: 'ブロンズ・スター',
    reason: '初めての戦果に対して',
    test: (s) => s.totalKills >= 3,
  },
  {
    id: 'silver-star',
    label: 'シルバー・スター',
    reason: '継続的な戦果に対して',
    test: (s) => s.totalKills >= 12,
  },
  {
    id: 'gold-sun',
    label: 'ゴールデン・サン',
    reason: '傑出した戦果に対して',
    test: (s) => s.totalKills >= 25,
  },
  {
    id: 'ace-hunter',
    label: 'エース撃墜章',
    reason: '敵エースの撃墜に対して',
    test: (s) => s.acesKilled >= 1,
  },
  {
    id: 'clean-sheet',
    label: '無傷帰還章',
    reason: '無傷で任務を完遂したことに対して',
    test: (s) => s.flawless && s.missionKills >= 2,
  },
  {
    id: 'guardian',
    label: '護衛章',
    reason: '護衛対象を一度も失っていないことに対して',
    test: (s) => s.noEscortLost && s.cleared >= 3,
  },
  {
    id: 'wingman-cross',
    label: '僚友十字章',
    reason: '一人も僚機を失わずに戦い続けたことに対して',
    test: (s) => s.noWingmanLost && s.cleared >= 4,
  },
  {
    id: 'pilots-cross',
    label: 'パイロッツ・クロス',
    reason: '戦役の完遂に対して',
    test: (s) => s.cleared >= 6,
  },
];

/** まだ持っていない勲章のうち、条件を満たしたものを返す */
export function newlyEarned(ctx: MedalContext, owned: string[]): Medal[] {
  return MEDALS.filter((m) => !owned.includes(m.id) && m.test(ctx));
}

export function medalById(id: string): Medal | undefined {
  return MEDALS.find((m) => m.id === id);
}
