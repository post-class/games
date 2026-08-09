/**
 * 戦役の進行データ。
 *
 * `CAMPAIGN` は既存版との互換性を保つため、McCaffrey 開始の独自拡張
 * ルートとして残している。本家寄せのルートは `CANON_CAMPAIGN` に分離し、
 * App は save.campaignMode に応じて `campaignGraph()` を選べる。
 */

import { VEIL_CHAPTERS, type VeilChapter } from './veil/chapters';

export type CampaignNodeId = string;
export type CampaignMode = 'canon' | 'expanded' | 'veil';
export type CampaignOutcome = 'win' | 'loss';
export type CampaignRoute = 'advance' | 'hold' | 'retreat';
export type CampaignMissionType =
  | 'patrol'
  | 'escort'
  | 'strike'
  | 'defense'
  | 'recon'
  | 'rescue'
  | 'intercept'
  | 'capital';

/** 終端 */
export const VICTORY = 'victory';
export const DEFEAT = 'defeat';

export interface CampaignNode {
  /** MISSIONS のキー。canon では既存の戦闘定義へ接続するための adapter key */
  missionId: string;
  /** 戦役シリーズ名 */
  series: string;
  /** `series` の表示用別名。外部 UI が明示的な名前を必要とする場合に使う */
  seriesName: string;
  /** UI で星系名として表示する場所 */
  system: string;
  /** 任務の役割。撃墜数以外の勝敗条件を説明するためのドメイン情報 */
  missionType: CampaignMissionType;
  /** 勝利条件／敗北条件の表示文 */
  victoryCondition: string;
  defeatCondition: string;
  /** このシリーズで勝ったときに得る勝利点 */
  victoryPoints: number;
  /** 勝敗後に戦況図へ表示するメッセージ */
  situation: string;
  winSituation: string;
  lossSituation: string;
  /** 勝敗後の遷移先 */
  onWin: CampaignNodeId;
  onLoss: CampaignNodeId;
  /** 各分岐を戦役マップでどう表示するか */
  onWinRoute: CampaignRoute;
  onLossRoute: CampaignRoute;
  /** 進行表示用の章番号 */
  chapter: number;
  /** 敗北ルートのミッションか */
  losingRoute?: boolean;
  /** canon／拡張ルートで台詞と敵編成を差し替えるための安定したキー */
  dialogueKey: string;
  enemyComposition: string[];
}

export type CampaignGraph = Record<CampaignNodeId, CampaignNode>;

export interface CampaignHistoryEntry {
  node: CampaignNodeId;
  outcome: CampaignOutcome;
  points: number;
  nextNode: CampaignNodeId;
  route: CampaignRoute;
}

/** App/save が保持するキャンペーン固有の最小進行状態 */
export interface CampaignProgress {
  mode: CampaignMode;
  currentNode: CampaignNodeId;
  score: number;
  history: CampaignHistoryEntry[];
  lastSituation: string;
}

export interface CampaignTransition {
  outcome: CampaignOutcome;
  node: CampaignNodeId;
  nextNode: CampaignNodeId;
  points: number;
  score: number;
  route: CampaignRoute;
  situation: string;
  nextSituation: string;
  terminal: boolean;
  history: CampaignHistoryEntry;
}

export type CampaignMapStatus =
  | 'current'
  | 'completed-win'
  | 'completed-loss'
  | 'reachable'
  | 'unreached'
  | 'terminal';

export interface CampaignMapNode {
  id: CampaignNodeId;
  status: CampaignMapStatus;
  node?: CampaignNode;
  /** 現在ノードからこのノードへ来る分岐 */
  incoming?: CampaignOutcome;
}

function makeNode(data: {
  missionId: string;
  series: string;
  system: string;
  missionType: CampaignMissionType;
  victoryCondition: string;
  defeatCondition: string;
  victoryPoints: number;
  situation?: string;
  winSituation: string;
  lossSituation: string;
  onWin: CampaignNodeId;
  onLoss: CampaignNodeId;
  chapter: number;
  losingRoute?: boolean;
  dialogueKey?: string;
  enemyComposition?: string[];
  onWinRoute?: CampaignRoute;
  onLossRoute?: CampaignRoute;
}): CampaignNode {
  return {
    ...data,
    seriesName: data.series,
    situation: data.situation ?? `${data.system} — ${data.series} の戦況を確認中。`,
    onWinRoute: data.onWinRoute ?? 'advance',
    onLossRoute: data.onLossRoute ?? 'retreat',
    dialogueKey: data.dialogueKey ?? data.missionId,
    enemyComposition: data.enemyComposition ?? ['敵戦闘機部隊'],
  };
}

// ───────── 現行独自拡張ルート (互換 API: CAMPAIGN) ─────────

export const CAMPAIGN: CampaignGraph = {
  'm1-patrol': makeNode({
    missionId: 'm1-patrol', series: 'McCaffrey 外縁哨戒', system: 'McCaffrey', missionType: 'patrol',
    victoryCondition: '航路ブイを確認し、敵偵察隊を排除して帰投する', defeatCondition: '哨戒線を維持できず敵に情報を渡す', victoryPoints: 2,
    winSituation: 'McCaffrey の航路監視を回復した。前進護衛へ移る。', lossSituation: 'McCaffrey の哨戒線が破られた。艦隊は撤退線を準備する。',
    onWin: 'm2-escort', onLoss: 'l1-retreat', chapter: 1, dialogueKey: 'expanded-mccaffrey-patrol', enemyComposition: ['Salthi 偵察隊', 'Dralthi 偵察隊'],
  }),
  'm2-escort': makeNode({
    missionId: 'm2-escort', series: 'McCaffrey 補給線', system: 'McCaffrey', missionType: 'escort',
    victoryCondition: '輸送船エルバを集合点まで護衛する', defeatCondition: '輸送船エルバを失う', victoryPoints: 3,
    winSituation: '補給線がつながり、Gimle への強襲準備が整った。', lossSituation: '補給線が崩れ、前線は防衛態勢へ後退する。',
    onWin: 'm2b-recon', onLoss: 'l1-retreat', chapter: 2, dialogueKey: 'expanded-mccaffrey-escort', enemyComposition: ['Dralthi 襲撃隊', 'Krant 増援'],
  }),
  'm2b-recon': makeNode({
    missionId: 'm2b-recon', series: 'Gimle 前進偵察', system: 'Gimle', missionType: 'recon',
    victoryCondition: '前進基地の情報を持ち帰る', defeatCondition: '偵察に失敗し、基地への強襲を断念する', victoryPoints: 2,
    winSituation: 'Gimle の敵補給所が露見した。強襲コースへ進む。', lossSituation: 'Gimle の敵基地を叩けない。Tiger’s Claw は防衛線へ回る。',
    onWin: 'm3-strike', onLoss: 'm4-defend', chapter: 3, dialogueKey: 'expanded-gimle-recon', enemyComposition: ['Krant 偵察隊', 'Ralari 支援艦'],
  }),
  'm3-strike': makeNode({
    missionId: 'm3-strike', series: 'Gimle 前進基地攻略', system: 'Gimle', missionType: 'strike',
    victoryCondition: '前進補給所の輸送艦を破壊する', defeatCondition: '敵補給所を破壊できず撤退する', victoryPoints: 4,
    winSituation: 'Gimle の敵補給能力が落ちた。救難航路を開く。', lossSituation: 'Gimle の敵補給所が健在だ。最後の防衛線へ下がる。',
    onWin: 'm3b-sar', onLoss: 'l2-last-stand', chapter: 4, dialogueKey: 'expanded-gimle-strike', enemyComposition: ['Krant 護衛隊', 'Dorkir 輸送艦'],
  }),
  'm3b-sar': makeNode({
    missionId: 'm3b-sar', series: 'Gimle 救難回廊', system: 'Gimle', missionType: 'rescue',
    victoryCondition: '撃墜された僚機と難民船を救出して帰投する', defeatCondition: '救難対象を失う', victoryPoints: 2,
    winSituation: '救難回廊が確保された。防衛線を押し戻せる。', lossSituation: '救難対象は失われたが、艦隊は防衛へ合流する。',
    onWin: 'm4-defend', onLoss: 'm4-defend', chapter: 5, dialogueKey: 'expanded-gimle-rescue', enemyComposition: ['Salthi 襲撃隊', 'Dralthi 追撃隊'],
  }),
  'm4-defend': makeNode({
    missionId: 'm4-defend', series: 'Vega 防衛線', system: 'Vega', missionType: 'defense',
    victoryCondition: 'Tiger’s Claw と防衛拠点を守り抜く', defeatCondition: '防衛線を維持できず最後の拠点へ退く', victoryPoints: 3,
    winSituation: 'Vega の防衛線は安定した。敵エースを迎撃する。', lossSituation: 'Vega の防衛線が崩れた。最後の抵抗へ移る。',
    onWin: 'm5-ace', onLoss: 'l2-last-stand', chapter: 6, dialogueKey: 'expanded-vega-defense', enemyComposition: ['B族爆撃隊', 'Krant 攻撃隊'],
  }),
  'm5-ace': makeNode({
    missionId: 'm5-ace', series: 'Vega エース迎撃', system: 'Vega', missionType: 'intercept',
    victoryCondition: '敵エース《血塗られた爪》の部隊を撃退する', defeatCondition: '敵エースを逃がし戦線を崩す', victoryPoints: 4,
    winSituation: '敵エースが退いた。旗艦攻撃の窓が開いた。', lossSituation: '敵エースが戦線を押し広げた。最後の抵抗へ戻る。',
    onWin: 'm5b-intercept', onLoss: 'l2-last-stand', chapter: 7, dialogueKey: 'expanded-vega-ace', enemyComposition: ['敵エース部隊', 'Krant 精鋭隊'],
  }),
  'm5b-intercept': makeNode({
    missionId: 'm5b-intercept', series: 'Vega 跳躍航路遮断', system: 'Vega', missionType: 'intercept',
    victoryCondition: '敵爆撃隊を跳躍点へ到達させない', defeatCondition: '爆撃隊を止められず艦隊を退避させる', victoryPoints: 3,
    winSituation: '敵爆撃隊を止めた。旗艦への最終攻撃に進む。', lossSituation: '爆撃隊が跳躍点へ向かった。最後の抵抗に賭ける。',
    onWin: 'm6-flagship', onLoss: 'l2-last-stand', chapter: 8, dialogueKey: 'expanded-vega-intercept', enemyComposition: ['敵爆撃隊', 'Ralari 護衛艦'],
  }),
  'm6-flagship': makeNode({
    missionId: 'm6-flagship', series: 'Vega 旗艦決戦', system: 'Vega', missionType: 'capital',
    victoryCondition: '敵駆逐艦カクタグを撃沈し、帰投する', defeatCondition: '旗艦攻撃に失敗する', victoryPoints: 6,
    winSituation: 'Vega Sector の敵主力は退いた。戦役は勝利で終わる。', lossSituation: 'Tiger’s Claw は最後の抵抗へ追い込まれた。',
    onWin: VICTORY, onLoss: 'l2-last-stand', chapter: 9, dialogueKey: 'expanded-vega-flagship', enemyComposition: ['Ralari 旗艦', 'Krant 護衛隊'],
  }),
  'l1-retreat': makeNode({
    missionId: 'l1-retreat', series: 'McCaffrey 撤退線', system: 'McCaffrey', missionType: 'defense',
    victoryCondition: '撤退船団を守り、Gimle への航路を確保する', defeatCondition: '撤退船団と後衛を失う', victoryPoints: 2,
    winSituation: '撤退は成功した。Gimle の偵察へ復帰できる。', lossSituation: 'McCaffrey の後衛は崩壊した。最後の抵抗へ退く。',
    onWin: 'm2b-recon', onLoss: 'l2-last-stand', chapter: 3, losingRoute: true, onWinRoute: 'advance', onLossRoute: 'retreat', dialogueKey: 'expanded-retreat-one', enemyComposition: ['Dralthi 追撃隊', 'Krant 後衛攻撃隊'],
  }),
  'l2-last-stand': makeNode({
    missionId: 'l2-last-stand', series: 'Vega 最後の抵抗', system: 'Vega', missionType: 'defense',
    victoryCondition: '最後の防衛線を維持し、反攻の機会を作る', defeatCondition: 'Tiger’s Claw の防衛線が崩壊する', victoryPoints: 3,
    winSituation: '最後の抵抗は成功した。Vega のエース迎撃へ戻る。', lossSituation: 'Vega Sector の連邦艦隊は崩壊した。',
    onWin: 'm5-ace', onLoss: DEFEAT, chapter: 6, losingRoute: true, onWinRoute: 'advance', onLossRoute: 'retreat', dialogueKey: 'expanded-last-stand', enemyComposition: ['Krant 精鋭隊', 'Ralari 攻撃艦'],
  }),
};

/** 現行独自ルートを明示する別名。既存の CAMPAIGN は変更しない。 */
export const EXPANDED_CAMPAIGN = CAMPAIGN;
export const CAMPAIGN_START: CampaignNodeId = 'm1-patrol';
export const EXPANDED_CAMPAIGN_START = CAMPAIGN_START;

// ───────── 本家寄せ canon route (Enyo 起点) ─────────

export const CANON_CAMPAIGN: CampaignGraph = {
  'canon-enyo-patrol': makeNode({
    missionId: 'm1-patrol', series: 'Enyo Series', system: 'Enyo', missionType: 'patrol',
    victoryCondition: 'Enyo の航路を哨戒し、Kilrathi 偵察隊を退ける', defeatCondition: '偵察隊に航路情報を持ち帰られる', victoryPoints: 2,
    winSituation: 'Enyo の連邦航路を確保。McAuliffe への前進護衛に移る。', lossSituation: 'Enyo の航路が露見。防衛線を維持しながら後退する。',
    onWin: 'canon-mcauliffe-escort', onLoss: 'canon-enyo-defense', chapter: 1, dialogueKey: 'canon-enyo-patrol', enemyComposition: ['Salthi 偵察隊', 'Dralthi 偵察隊'],
  }),
  'canon-enyo-defense': makeNode({
    missionId: 'm4-defend', series: 'Enyo Series', system: 'Enyo', missionType: 'defense',
    victoryCondition: 'Enyo の防衛拠点を守り、撤退船団を送り出す', defeatCondition: 'Enyo の防衛拠点と撤退船団を失う', victoryPoints: 2,
    winSituation: 'Enyo の戦線はかろうじて保たれた。McAuliffe への進路を開く。', lossSituation: 'Enyo は陥落した。連邦の戦役はここで終わる。',
    onWin: 'canon-mcauliffe-escort', onLoss: DEFEAT, chapter: 2, losingRoute: true, onWinRoute: 'advance', onLossRoute: 'retreat', dialogueKey: 'canon-enyo-defense', enemyComposition: ['Krant 攻撃隊', 'Dorkir 爆撃隊'],
  }),
  'canon-mcauliffe-escort': makeNode({
    missionId: 'm2-escort', series: 'McAuliffe Series', system: 'McAuliffe', missionType: 'escort',
    victoryCondition: '補給船団を McAuliffe の集合点まで護衛する', defeatCondition: '補給船団を失い、前進補給を断たれる', victoryPoints: 3,
    winSituation: 'McAuliffe の補給線がつながった。Gateway への強襲を準備する。', lossSituation: 'McAuliffe の補給線が崩れた。防衛任務へ後退する。',
    onWin: 'canon-gateway-strike', onLoss: 'canon-mcauliffe-defense', chapter: 3, dialogueKey: 'canon-mcauliffe-escort', enemyComposition: ['Dralthi 襲撃隊', 'Krant 増援'],
  }),
  'canon-mcauliffe-defense': makeNode({
    missionId: 'l1-retreat', series: 'McAuliffe Series', system: 'McAuliffe', missionType: 'defense',
    victoryCondition: '後退中の艦隊を守り、補給拠点を再確保する', defeatCondition: '後退船団を失い、Enyo 方面へさらに退く', victoryPoints: 2,
    winSituation: 'McAuliffe の戦線を持ち直した。Gateway 攻撃へ復帰する。', lossSituation: 'McAuliffe も危険になった。Enyo の防衛へ退く。',
    onWin: 'canon-gateway-strike', onLoss: 'canon-enyo-defense', chapter: 4, losingRoute: true, onWinRoute: 'advance', onLossRoute: 'retreat', dialogueKey: 'canon-mcauliffe-defense', enemyComposition: ['Dralthi 追撃隊', 'Krant 攻撃隊'],
  }),
  'canon-gateway-strike': makeNode({
    missionId: 'm3-strike', series: 'Gateway Series', system: 'Gateway', missionType: 'strike',
    victoryCondition: 'Gateway の敵前進基地と補給艦を破壊する', defeatCondition: '敵前進基地を破壊できず、Gateway の防衛に回る', victoryPoints: 4,
    winSituation: 'Gateway の敵補給能力を破壊。敵迎撃隊を追う。', lossSituation: 'Gateway の敵基地は健在。防衛線で敵を止める。',
    onWin: 'canon-gateway-intercept', onLoss: 'canon-gateway-defense', chapter: 5, dialogueKey: 'canon-gateway-strike', enemyComposition: ['Krant 護衛隊', 'Dorkir 補給艦'],
  }),
  'canon-gateway-defense': makeNode({
    missionId: 'm4-defend', series: 'Gateway Series', system: 'Gateway', missionType: 'defense',
    victoryCondition: 'Gateway の Nav beacon と艦隊を防衛する', defeatCondition: 'Gateway の防衛線が崩壊する', victoryPoints: 2,
    winSituation: 'Gateway の防衛に成功。最終迎撃へ進む。', lossSituation: 'Gateway の防衛に失敗した。戦役は敗北に終わる。',
    onWin: 'canon-gateway-intercept', onLoss: DEFEAT, chapter: 6, losingRoute: true, onWinRoute: 'advance', onLossRoute: 'retreat', dialogueKey: 'canon-gateway-defense', enemyComposition: ['Ralari 攻撃艦', 'Krant 爆撃隊'],
  }),
  'canon-gateway-intercept': makeNode({
    missionId: 'm5b-intercept', series: 'Gateway Series', system: 'Gateway', missionType: 'intercept',
    victoryCondition: '敵爆撃隊を迎撃し、Gateway の跳躍点を確保する', defeatCondition: '敵爆撃隊の侵入を許す', victoryPoints: 5,
    winSituation: 'Gateway Sector の主力は退いた。連邦軍の戦役勝利だ。', lossSituation: 'Gateway の防衛は崩れた。最後の防衛戦へ移る。',
    onWin: VICTORY, onLoss: 'canon-gateway-defense', chapter: 7, dialogueKey: 'canon-gateway-intercept', enemyComposition: ['敵爆撃隊', 'Ralari 護衛艦'],
  }),
};

export const CANON_CAMPAIGN_START: CampaignNodeId = 'canon-enyo-patrol';
export const CANON_TOTAL_CHAPTERS = 7;
export const TOTAL_CHAPTERS = 9;

// ───────── THE VEIL FRONT / 十章キャンペーン (veil) ─────────

/**
 * 章ごとの任務性格・勝利点・敵編成。表示文（作戦名／戦域名／主目標／タグライン）は
 * `VEIL_CHAPTERS` から生成するので、ここには文字列を二重に置かない。
 */
const VEIL_NODE_TRAITS: Record<string, { missionType: CampaignMissionType; victoryPoints: number; enemyComposition: string[] }> = {
  'veil-ch01': { missionType: 'rescue', victoryPoints: 2, enemyComposition: ['キルラシー先遣隊', '救難妨害の襲撃機'] },
  'veil-ch02': { missionType: 'recon', victoryPoints: 2, enemyComposition: ['識別偽装ドローン群', '二重応答の擬装編隊'] },
  'veil-ch03': { missionType: 'escort', victoryPoints: 3, enemyComposition: ['ニューロウム熱紋機雷帯', '帝国哨戒機'] },
  'veil-ch04': { missionType: 'rescue', victoryPoints: 3, enemyComposition: ['オルド重力アンカー', '移動残骸帯', '無許可通過を狙う私掠機'] },
  'veil-ch05': { missionType: 'intercept', victoryPoints: 4, enemyComposition: ['決闘士ラギティカ（KF03 グレイハウル）', '急進派分艦隊'] },
  'veil-ch06': { missionType: 'strike', victoryPoints: 3, enemyComposition: ['ニューロウム中継器群', '学習型ドローン飽和'] },
  'veil-ch07': { missionType: 'escort', victoryPoints: 4, enemyComposition: ['連邦哨戒機（足止め）', '帝国急進派の追跡隊'] },
  'veil-ch08': { missionType: 'defense', victoryPoints: 4, enemyComposition: ['急進派突撃隊', '通信灯台を狙う爆撃機'] },
  'veil-ch09': { missionType: 'recon', victoryPoints: 5, enemyComposition: ['位相反射体', '幻影僚機'] },
  'veil-ch10': { missionType: 'capital', victoryPoints: 6, enemyComposition: ['急進派連合旗艦', '旗艦護衛隊'] },
};

function veilNodeTraits(id: string): { missionType: CampaignMissionType; victoryPoints: number; enemyComposition: string[] } {
  const traits = VEIL_NODE_TRAITS[id];
  if (!traits) throw new Error(`missing veil node traits: ${id}`);
  return traits;
}

/**
 * 章メタから戦役ノードを作る。
 *
 * 敗北時も次章へ進める（`onLoss` は次章）。第1章で学ぶ「達成しなかった勝利条件が
 * 記録として残る」という原則をキャンペーン全体に適用するため、失敗はルート分岐
 * ではなく `lossSituation` の未達成記録として残す。したがって `losingRoute` は使わない。
 * 例外は第10章のみで、門制御を選べなかった敗北はキャンペーンが成立しないため
 * `DEFEAT` へ落とす（呼び出し側で `onLoss` を明示指定する）。
 */
function makeVeilNode(chapter: VeilChapter, onWin: CampaignNodeId, onLoss: CampaignNodeId): CampaignNode {
  const traits = veilNodeTraits(chapter.id);
  return makeNode({
    missionId: chapter.missionId,
    series: chapter.operation,
    system: chapter.theaterName,
    missionType: traits.missionType,
    victoryCondition: chapter.objective,
    defeatCondition: `${chapter.objective}を達成できないまま帰投する`,
    victoryPoints: traits.victoryPoints,
    situation: `${chapter.theaterName} — ${chapter.operation}。${chapter.tagline}`,
    winSituation: `${chapter.operation} 達成。「${chapter.objective}」を記録に残した。`,
    lossSituation: `${chapter.operation} 未達。「${chapter.objective}」が未達成の勝利条件として記録に残る。`,
    onWin,
    onLoss,
    chapter: chapter.chapter,
    // 敗北でも次章へ進むため、敗北側の戦役マップ表示は撤退ではなく hold（戦線維持）にする。
    onWinRoute: 'advance',
    onLossRoute: 'hold',
    dialogueKey: chapter.id,
    enemyComposition: traits.enemyComposition,
  });
}

export const VEIL_CAMPAIGN: CampaignGraph = (() => {
  const graph: CampaignGraph = {};
  for (const chapter of VEIL_CHAPTERS) {
    const last = chapter.chapter >= VEIL_CHAPTERS.length;
    const next = last ? VICTORY : `veil-ch${String(chapter.chapter + 1).padStart(2, '0')}`;
    // 第10章の敗北だけはキャンペーンが破綻するため DEFEAT。それ以外は敗北でも次章へ。
    graph[chapter.id] = makeVeilNode(chapter, next, last ? DEFEAT : next);
  }
  return graph;
})();

export const VEIL_CAMPAIGN_START: CampaignNodeId = 'veil-ch01';
export const VEIL_TOTAL_CHAPTERS = 10;

/**
 * 第10章で選んだ門の管理方法。既存の `EndingQuality`（勝敗の質）とは別軸で、
 * 「門をどう扱ったか」だけを表す。
 */
export type GateOutcome = 'closed' | 'limited-open' | 'joint-custody';

/** 第10章の選択肢id → 門の管理方法 */
const GATE_OUTCOME_BY_CHOICE: Record<string, GateOutcome> = {
  'seal-gate': 'closed',
  'limited-open': 'limited-open',
  'joint-custody': 'joint-custody',
};

export function isGateOutcome(value: unknown): value is GateOutcome {
  return value === 'closed' || value === 'limited-open' || value === 'joint-custody';
}

/** 第10章（`veil-ch10`）の選択肢idを門の管理方法へ変換する。未知のidは例外にする。 */
export function gateOutcomeFromChoice(optionId: string): GateOutcome {
  const outcome = GATE_OUTCOME_BY_CHOICE[optionId];
  if (!outcome) throw new Error(`unknown gate choice option: ${optionId}`);
  return outcome;
}

export function isCampaignMode(value: unknown): value is CampaignMode {
  return value === 'canon' || value === 'expanded' || value === 'veil';
}

export function campaignGraph(mode: CampaignMode = 'expanded'): CampaignGraph {
  if (mode === 'canon') return CANON_CAMPAIGN;
  if (mode === 'veil') return VEIL_CAMPAIGN;
  return CAMPAIGN;
}

export function campaignStart(mode: CampaignMode = 'expanded'): CampaignNodeId {
  if (mode === 'canon') return CANON_CAMPAIGN_START;
  if (mode === 'veil') return VEIL_CAMPAIGN_START;
  return CAMPAIGN_START;
}

export function totalChapters(mode: CampaignMode = 'expanded'): number {
  if (mode === 'canon') return CANON_TOTAL_CHAPTERS;
  if (mode === 'veil') return VEIL_TOTAL_CHAPTERS;
  return TOTAL_CHAPTERS;
}

export function hasCampaignNode(id: CampaignNodeId, mode: CampaignMode = 'expanded'): boolean {
  return !!campaignGraph(mode)[id];
}

export function campaignNode(id: CampaignNodeId, mode: CampaignMode = 'expanded'): CampaignNode {
  const n = campaignGraph(mode)[id];
  if (!n) throw new Error(`unknown ${mode} campaign node: ${id}`);
  return n;
}

export function isTerminal(id: CampaignNodeId): boolean {
  return id === VICTORY || id === DEFEAT;
}

export function advance(id: CampaignNodeId, outcome: CampaignOutcome, mode: CampaignMode = 'expanded'): CampaignNodeId {
  const node = campaignNode(id, mode);
  return outcome === 'win' ? node.onWin : node.onLoss;
}

export function newCampaignProgress(mode: CampaignMode = 'expanded'): CampaignProgress {
  return {
    mode,
    currentNode: campaignStart(mode),
    score: 0,
    history: [],
    lastSituation: campaignNode(campaignStart(mode), mode).situation,
  };
}

/** 勝敗を一度だけ進め、次ノード・勝利点・戦況文・履歴を同時に返す。 */
export function resolveCampaignOutcome(progress: CampaignProgress, outcome: CampaignOutcome): CampaignTransition {
  if (isTerminal(progress.currentNode)) throw new Error(`campaign is already terminal: ${progress.currentNode}`);
  const node = campaignNode(progress.currentNode, progress.mode);
  const nextNode = advance(progress.currentNode, outcome, progress.mode);
  const points = outcome === 'win' ? node.victoryPoints : -node.victoryPoints;
  const route = outcome === 'win' ? node.onWinRoute : node.onLossRoute;
  const situation = outcome === 'win' ? node.winSituation : node.lossSituation;
  const nextSituation = isTerminal(nextNode)
    ? (nextNode === VICTORY ? '戦役勝利。戦況図は連邦の勝利を示している。' : '戦役敗北。戦況図は連邦の撤退を示している。')
    : campaignNode(nextNode, progress.mode).situation;
  const history: CampaignHistoryEntry = { node: progress.currentNode, outcome, points, nextNode, route };
  progress.currentNode = nextNode;
  progress.score += points;
  progress.history.push(history);
  progress.lastSituation = situation;
  return { outcome, node: history.node, nextNode, points, score: progress.score, route, situation, nextSituation, terminal: isTerminal(nextNode), history };
}

/** `resolveCampaignOutcome` の状態を変更しない版。App の debrief 表示にも使える。 */
export function previewCampaignOutcome(progress: Readonly<CampaignProgress>, outcome: CampaignOutcome): CampaignTransition {
  const copy: CampaignProgress = { ...progress, history: progress.history.map((entry) => ({ ...entry })) };
  return resolveCampaignOutcome(copy, outcome);
}

/** 現在ノード、到達済みノード、次に選べる勝敗分岐を UI 用の状態へ変換する。 */
export function campaignMap(
  mode: CampaignMode,
  currentNode: CampaignNodeId,
  history: readonly CampaignHistoryEntry[] = [],
): CampaignMapNode[] {
  const graph = campaignGraph(mode);
  const completed = new Map<CampaignNodeId, CampaignOutcome>();
  for (const entry of history) completed.set(entry.node, entry.outcome);
  const result: CampaignMapNode[] = Object.entries(graph).map(([id, node]) => ({ id, node, status: 'unreached' }));
  const byId = new Map(result.map((item) => [item.id, item]));
  for (const [id, outcome] of completed) {
    const item = byId.get(id);
    if (item) item.status = outcome === 'win' ? 'completed-win' : 'completed-loss';
  }
  if (isTerminal(currentNode)) {
    result.push({ id: currentNode, status: 'terminal' });
    return result;
  }
  const current = byId.get(currentNode);
  if (!current) throw new Error(`unknown ${mode} campaign node: ${currentNode}`);
  current.status = 'current';
  const node = campaignNode(currentNode, mode);
  for (const [next, incoming] of [[node.onWin, 'win'], [node.onLoss, 'loss']] as const) {
    if (isTerminal(next)) {
      result.push({ id: next, status: 'reachable', incoming });
      continue;
    }
    const item = byId.get(next);
    if (item && item.status === 'unreached') {
      item.status = 'reachable';
      item.incoming = incoming;
    }
  }
  return result;
}

export const getCampaignMap = campaignMap;

/** 指定ノードから勝敗分岐を辿って構造上到達できる全ノードを返す。 */
export function reachableCampaignNodes(start: CampaignNodeId, mode: CampaignMode = 'expanded'): CampaignNodeId[] {
  const seen = new Set<CampaignNodeId>();
  const visit = (id: CampaignNodeId): void => {
    if (isTerminal(id) || seen.has(id)) return;
    seen.add(id);
    const node = campaignNode(id, mode);
    visit(node.onWin);
    visit(node.onLoss);
  };
  visit(start);
  return [...seen];
}
