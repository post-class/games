import {
  banterIntro,
  banterReaction,
  banterReplyLabel,
  banterExchange,
  BANTER_CHOICES,
  type BanterChoice,
  type BanterTopic,
} from '../content/barBanter';
import {
  bondKey,
  bondLevel,
  PILOT_BOND_KINDS,
  type BondLevel,
  type PilotBond,
} from '../content/pilotBonds';
import { pilotDef } from '../content/pilots';

/**
 * 酒場の掛け合いへの割り込み（T8-②）。
 *
 * ■ これまでの酒場との違い
 * `src/app/barTalk.ts` は「プレイヤーと隊員1人」の2往復だった。ここで組み立てるのは
 *
 *   [前振り] → 掛け合い3行（隊員a → 隊員b → 隊員a） → 割り込み3択 → 反応2行
 *
 * で、**プレイヤーは会話の当事者ではなく、他人の会話に割り込む側**になる。
 * だから割り込みは**1回だけ**（`barTalk` の2往復と違い、口を挟んだら掛け合いは終わる）。
 *
 * ■ 設計上の核（非対称であること）
 * 「一番プレイヤーが好かれる選択」と「隊が一番噛み合う選択」を**別にする**。
 *   - 片方に肩入れ（`side-a` / `side-b`）: 味方した相手の `bond` は大きく伸びるが、
 *     もう片方の `bond` は削れ、**二人の仲（`RosterState.relations`）は下がる**。
 *   - なだめる（`defuse`）: 自分への `bond` の伸びは小さいが、**二人の仲が上がる**。
 * つまり「自分が好かれる」と「隊が回る」がトレードオフになる。ここが無いと、
 * 3択は「全部なだめれば最適」になって選ぶ意味が消える。
 *
 * ■ barTalk.ts と同じ約束
 * - このモジュールは**状態を持たない**。進行は `BanterState` を呼び出し側（`App.ts`）が持つ。
 * - **roster を書き換えない**。動く量は `BanterEffect` として返すだけで、
 *   `shiftBond` / relations への反映は呼び出し側が行う。
 * - 乱数を使わない。台詞の揺らぎは seed で決めるので、同じ入力なら必ず同じ会話になる。
 * - 難易度には一切効かせない（`pilotBonds.ts` と同じ扱い）。
 */

export interface BanterTurn {
  /** `a` / `b` は `PilotBond` の二人、`player` は割り込んだプレイヤー。 */
  speaker: 'a' | 'b' | 'player';
  /** 隊員の発言のときだけ入る（描画側が顔と名前を出すため）。 */
  pilotId?: string;
  text: string;
}

export interface BanterReply {
  id: string;
  label: string;
}

/** 介入で動く量。呼び出し側が roster へ反映する（このモジュールは書き換えない）。 */
export interface BanterEffect {
  bondDelta: Array<{ pilotId: string; delta: number }>;
  relationDelta: number;
}

export interface BanterView {
  bond: PilotBond;
  topic: BanterTopic;
  turns: BanterTurn[];
  /** 空配列なら介入済み（会話終了） */
  replies: BanterReply[];
  /** 二人の現在の仲（`bondLevel` の段階）と、直前の出撃で何が効いたかの1行 */
  level: BondLevel;
  reason?: string;
  /** 介入した結果の要約（介入前は undefined）。「Sable +0.12 / Raven -0.06 / 二人の仲 -0.05」の形 */
  outcome?: string;
}

/**
 * 直前の出撃で「この二人に何が起きたか」。`BarTalkFacts` と同じ発想で、
 * すべて省略可（初回の帰艦前は全部空）。
 */
export interface BanterFacts {
  /** 直前の出撃で僚機として飛んだ隊員の id（この二人のどちらかなら掛け合いの話題になる） */
  wingmanId?: string;
  /** その僚機が助けを求め、応えてもらった */
  rescued?: boolean;
  /** その僚機が助けを求めたのに、来てもらえなかった */
  abandoned?: boolean;
  /** 直近で失った隊員の名前（いれば追悼の話題になる） */
  fallenName?: string;
}

/** 掛け合いの進行。割り込みは1回だけなので、選んだ択を1つ持つだけ。 */
export interface BanterState {
  bondKey: string;
  chosen?: string;
}

export interface BanterInput {
  bond: PilotBond;
  /** 二人の仲の現在値 -1..+1（`relationBetween` の戻り値）。 */
  relation: number;
  /**
   * 台詞の揺らぎの種にする出撃回数。同じ帰艦の間は変わらないので、
   * 画面を開き直しても会話が変わらない。
   */
  sorties?: number;
  facts?: BanterFacts;
  state?: BanterState;
}

export function newBanter(bond: PilotBond): BanterState {
  return { bondKey: bondKey(bond.a, bond.b) };
}

/** 返事の id。`HubPanels` はこの文字列をそのまま返してくる。 */
function parseReplyId(id: string): BanterChoice | undefined {
  return BANTER_CHOICES.find((c) => c === id);
}

/**
 * 話題を決める。優先順位は「二人のどちらかの身に起きたこと」→「艦の出来事」→「普段」。
 *
 * 救援に応えた／応えなかったは僚機になった人にしか起きないので、
 * 同じ帰艦でも卓によって話題が変わる。
 */
export function banterTopic(bond: PilotBond, facts: BanterFacts): BanterTopic {
  const involved = facts.wingmanId === bond.a || facts.wingmanId === bond.b;
  if (involved && facts.rescued) return 'rescue';
  if (involved && facts.abandoned) return 'neglect';
  if (facts.fallenName) return 'mourning';
  if (involved) return 'aftermath';
  return 'idle';
}

/** 話題ごとの「二人の仲に効いた理由」。段階表示の隣に1行で出す。 */
function levelReason(topic: BanterTopic, facts: BanterFacts): string | undefined {
  switch (topic) {
    case 'rescue':
      return '直前の出撃: 救援要請に応えた';
    case 'neglect':
      return '直前の出撃: 救援要請に応えなかった';
    case 'aftermath':
      return '直前の出撃: この二人のどちらかが一緒に飛んだ';
    case 'mourning':
      return facts.fallenName ? `直前の出撃: ${facts.fallenName} を失った` : '直前の出撃: 隊員を失った';
    default:
      return '直前の出撃には、二人とも出ていない';
  }
}

// ───────── 介入の効果 ─────────
//
// 基準値に `PILOT_BOND_KINDS[kind].weight` を掛ける。
// `weight.side` は肩入れ（side-a / side-b）に、`weight.defuse` はなだめるに掛かる。
// 不和や喪失の共有では仲裁の重みが大きく、好敵手では肩入れの重みが大きい。

/** 肩入れ: 味方した側の bond。 */
const SIDE_WITH = 0.12;
/** 肩入れ: 味方しなかった側の bond（下がる）。 */
const SIDE_AGAINST = -0.06;
/** 肩入れ: 二人の仲（下がる）。片方を持ち上げると、隊の中の線が一本切れる。 */
const SIDE_RELATION = -0.05;
/** なだめる: 両方の bond（伸びは肩入れの半分以下）。 */
const DEFUSE_BOND = 0.05;
/** なだめる: 二人の仲（上がる）。プレイヤーへの見返りより、隊の噛み合いを取る選択。 */
const DEFUSE_RELATION = 0.1;

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/**
 * 3択それぞれで動く量。**bond も relations も書き換えない**（呼び出し側が反映する）。
 *
 * 肩入れは「自分の bond ＋ / 相手の bond − / 二人の仲 −」、
 * なだめるは「両方の bond 小さく＋ / 二人の仲 ＋」。この非対称がこの機能の核。
 */
export function banterEffect(bond: PilotBond, choice: BanterChoice): BanterEffect {
  const weight = PILOT_BOND_KINDS[bond.kind].weight;
  if (choice === 'defuse') {
    return {
      bondDelta: [
        { pilotId: bond.a, delta: round3(DEFUSE_BOND * weight.defuse) },
        { pilotId: bond.b, delta: round3(DEFUSE_BOND * weight.defuse) },
      ],
      relationDelta: round3(DEFUSE_RELATION * weight.defuse),
    };
  }
  const withId = choice === 'side-a' ? bond.a : bond.b;
  const againstId = choice === 'side-a' ? bond.b : bond.a;
  return {
    bondDelta: [
      { pilotId: withId, delta: round3(SIDE_WITH * weight.side) },
      { pilotId: againstId, delta: round3(SIDE_AGAINST * weight.side) },
    ],
    relationDelta: round3(SIDE_RELATION * weight.side),
  };
}

function signed(v: number): string {
  return `${v >= 0 ? '+' : '-'}${Math.abs(v).toFixed(2)}`;
}

/** 介入結果の要約1行。「Sable +0.12 / Raven -0.06 / 二人の仲 -0.05」の形。 */
function outcomeText(effect: BanterEffect): string {
  const parts = effect.bondDelta.map((d) => `${pilotDef(d.pilotId).callsign} ${signed(d.delta)}`);
  parts.push(`二人の仲 ${signed(effect.relationDelta)}`);
  return parts.join(' / ');
}

/**
 * 台詞の揺らぎを決める種。ペアと出撃回数で決まるので、同じ帰艦の間は変わらない。
 * （`barTalk.ts` の `seedOf` と同じ作り方。）
 */
function seedOf(bond: PilotBond, sorties: number): number {
  const key = bondKey(bond.a, bond.b);
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) % 100003;
  return hash + (Number.isFinite(sorties) ? Math.trunc(sorties) : 0);
}

/** 掛け合いの `a` / `b` を実際の pilotId に直す。 */
function pilotOf(bond: PilotBond, speaker: 'a' | 'b'): string {
  return speaker === 'a' ? bond.a : bond.b;
}

/**
 * いまの状態から掛け合いの表示物を組み立てる。
 *
 * `state.chosen` が無ければ掛け合い＋3択、あれば割り込みの1行と二人の反応まで出して
 * `replies` を空にする（＝会話終了の合図）。
 */
export function buildBanter(input: BanterInput): BanterView {
  const { bond } = input;
  const facts = input.facts ?? {};
  const topic = banterTopic(bond, facts);
  const seed = seedOf(bond, input.sorties ?? 0);
  const key = bondKey(bond.a, bond.b);
  const chosen = input.state?.bondKey === key ? parseReplyId(input.state.chosen ?? '') : undefined;

  const turns: BanterTurn[] = [];
  // 前振り（`idle` のときは無し）
  const intro = banterIntro(bond.kind, topic, seed, facts.fallenName);
  if (intro) turns.push({ speaker: intro.speaker, pilotId: pilotOf(bond, intro.speaker), text: intro.text });
  // ペア固有の掛け合い 3行（a → b → a）
  for (const line of banterExchange(bond.a, bond.b, seed)) {
    turns.push({ speaker: line.speaker, pilotId: pilotOf(bond, line.speaker), text: line.text });
  }

  let outcome: string | undefined;
  if (chosen) {
    // 割り込んだ言葉は、そのまま会話に残す（選択肢のラベルと同じ文）
    turns.push({ speaker: 'player', text: banterReplyLabel(bond.a, bond.b, chosen, seed) });
    const reaction = banterReaction(bond.kind, chosen, seed);
    turns.push({ speaker: 'a', pilotId: bond.a, text: reaction.a });
    turns.push({ speaker: 'b', pilotId: bond.b, text: reaction.b });
    outcome = outcomeText(banterEffect(bond, chosen));
  }

  const replies: BanterReply[] = chosen
    ? []
    : BANTER_CHOICES.map((choice) => ({
        id: choice,
        label: banterReplyLabel(bond.a, bond.b, choice, seed),
      }));

  return {
    bond,
    topic,
    turns,
    replies,
    level: bondLevel(input.relation),
    reason: levelReason(topic, facts),
    outcome,
  };
}

export interface BanterChoiceResult {
  /** 進んだ後の会話状態 */
  state: BanterState;
  /** この選択で動かすべき量（`bondDelta` の各要素は `shiftBond` に渡す） */
  effect: BanterEffect;
  /** これで掛け合いが終わったか */
  finished: boolean;
}

/** 効果なし。呼び出し側が配列を触っても影響が出ないよう、毎回作り直す。 */
function noEffect(): BanterEffect {
  return { bondDelta: [], relationDelta: 0 };
}

/**
 * 割り込みを1つ選んだ結果を返す。**roster は書き換えない**（呼び出し側が
 * `shiftBond` と relations へ反映する）。
 *
 * 割り込みは1回だけなので、すでに介入済みの状態・無効な id は効果 0 で現状を返す。
 */
export function chooseBanterReply(input: BanterInput, id: string): BanterChoiceResult {
  const key = bondKey(input.bond.a, input.bond.b);
  const state = input.state?.bondKey === key ? input.state : newBanter(input.bond);
  const already = parseReplyId(state.chosen ?? '');
  if (already) return { state, effect: noEffect(), finished: true };
  const choice = parseReplyId(id);
  if (!choice) return { state, effect: noEffect(), finished: false };
  return {
    state: { bondKey: key, chosen: choice },
    effect: banterEffect(input.bond, choice),
    finished: true,
  };
}
