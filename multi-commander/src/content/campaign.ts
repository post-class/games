/**
 * 戦役の進行データ。
 *
 * 戦役は **THE VEIL FRONT（十章）だけ**である。以前は本家寄せの `canon` と
 * 独自拡張の `expanded` を `save.campaignMode` で切り替えていたが、両方とも
 * 削除した（本編が十章に一本化されたため）。したがってグラフは `VEIL_CAMPAIGN`
 * ただ一つで、`campaignGraph()` などはモード引数を取らない。
 */

import { VEIL_CHAPTERS, type VeilChapter } from './veil/chapters';

export type CampaignNodeId = string;
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
  /** MISSIONS のキー */
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
  /**
   * その章で相手になる勢力・機種の並び。
   * 表示にはまだ使っていないが、章データとして持たせている。
   */
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
    enemyComposition: data.enemyComposition ?? ['敵戦闘機部隊'],
  };
}


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
 * ではなく `lossSituation` の未達成記録として残す（敗北ルートという分岐は持たない）。
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

export function campaignGraph(): CampaignGraph {
  return VEIL_CAMPAIGN;
}

export function campaignStart(): CampaignNodeId {
  return VEIL_CAMPAIGN_START;
}

export function totalChapters(): number {
  return VEIL_TOTAL_CHAPTERS;
}

export function hasCampaignNode(id: CampaignNodeId): boolean {
  return !!campaignGraph()[id];
}

export function campaignNode(id: CampaignNodeId): CampaignNode {
  const n = campaignGraph()[id];
  if (!n) throw new Error(`unknown campaign node: ${id}`);
  return n;
}

export function isTerminal(id: CampaignNodeId): boolean {
  return id === VICTORY || id === DEFEAT;
}

export function advance(id: CampaignNodeId, outcome: CampaignOutcome): CampaignNodeId {
  const node = campaignNode(id);
  return outcome === 'win' ? node.onWin : node.onLoss;
}

export function newCampaignProgress(): CampaignProgress {
  return {
    currentNode: campaignStart(),
    score: 0,
    history: [],
    lastSituation: campaignNode(campaignStart()).situation,
  };
}

/** 勝敗を一度だけ進め、次ノード・勝利点・戦況文・履歴を同時に返す。 */
export function resolveCampaignOutcome(progress: CampaignProgress, outcome: CampaignOutcome): CampaignTransition {
  if (isTerminal(progress.currentNode)) throw new Error(`campaign is already terminal: ${progress.currentNode}`);
  const node = campaignNode(progress.currentNode);
  const nextNode = advance(progress.currentNode, outcome);
  const points = outcome === 'win' ? node.victoryPoints : -node.victoryPoints;
  const route = outcome === 'win' ? node.onWinRoute : node.onLossRoute;
  const situation = outcome === 'win' ? node.winSituation : node.lossSituation;
  const nextSituation = isTerminal(nextNode)
    ? (nextNode === VICTORY ? '戦役勝利。戦況図は連邦の勝利を示している。' : '戦役敗北。戦況図は連邦の撤退を示している。')
    : campaignNode(nextNode).situation;
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
  currentNode: CampaignNodeId,
  history: readonly CampaignHistoryEntry[] = [],
): CampaignMapNode[] {
  const graph = campaignGraph();
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
  if (!current) throw new Error(`unknown campaign node: ${currentNode}`);
  current.status = 'current';
  const node = campaignNode(currentNode);
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
export function reachableCampaignNodes(start: CampaignNodeId): CampaignNodeId[] {
  const seen = new Set<CampaignNodeId>();
  const visit = (id: CampaignNodeId): void => {
    if (isTerminal(id) || seen.has(id)) return;
    seen.add(id);
    const node = campaignNode(id);
    visit(node.onWin);
    visit(node.onLoss);
  };
  visit(start);
  return [...seen];
}

/** 章の中でのミッションの位置。1章に1本しか無い章では total が 1 になる。 */
export interface ChapterPosition {
  chapter: number;
  totalChapters: number;
  /** 章内の 1-based 序数 */
  index: number;
  /** 章内のミッション総数 */
  total: number;
}

/**
 * 章の中で、そのノードが何本目のミッションかを返す。
 *
 * 章内の並び順はノード id の昇順で安定させる。十章キャンペーンは1章1本なので
 * 実際には常に 1/1 になるが、章内に複数本を置いたときに表示が経路で揺れないよう
 * ここで順番を固定しておく。
 *
 * 終端（victory / defeat）はグラフにノードが無いので、呼び出し側で
 * `isTerminal()` を先に見る。ここはノードが存在する前提でよい
 * （`campaignNode()` の既存の振る舞いに合わせ、無ければ投げる）。
 */
export function chapterPosition(id: CampaignNodeId): ChapterPosition {
  const graph = campaignGraph();
  const node = campaignNode(id);
  const siblings = Object.keys(graph)
    .filter((key) => graph[key].chapter === node.chapter)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    chapter: node.chapter,
    totalChapters: totalChapters(),
    index: Math.max(1, siblings.indexOf(id) + 1),
    total: Math.max(1, siblings.length),
  };
}

/**
 * 「いま何章の何本目か」の表示文（W6）。
 *
 * ポーズ画面とブリーフィング画面が同じ文字列を使うため、組み立てはここ1か所に置く
 * （App 側は DOM 依存で単体テストしづらいので、純関数として切り出している）。
 * 章内に1本しか無い章（veil の全章）では章内表記を省く
 * （「1本目/全1本」は情報が無いのに横幅を食う）。
 */
export function chapterProgressText(position: ChapterPosition): string {
  const chapter = `第${position.chapter}章 / 全${position.totalChapters}章`;
  const within = position.total > 1 ? `　ミッション ${position.index}/${position.total}` : '';
  return `${chapter}${within}`;
}
