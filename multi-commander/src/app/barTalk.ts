import {
  barClosingLine,
  barOpeningLine,
  barReplyLabel,
  barResponseLine,
  type BarReplyKind,
  type BarTalkTopic,
} from '../content/pilotDialogue';
import type { PersonalityId } from '../content/pilots';
import { relationStage, type PilotState } from './roster';

/**
 * 酒場の往復会話（T3-⑪）。
 *
 * 以前の酒場は「1人につき1行を rng で引いて出す」だけで、こちらの返事が無く、
 * 関係値も `信頼 / 不信 / ——` の3値だった。ここでは
 *
 *   近況（相手） → 返事を2択（プレイヤー） → 反応（相手） → 返事を2択 → 締め（相手）
 *
 * の**2往復**を組み立てる。近況の内容は**直前の出撃で何が起きたか**で変わり、
 * 返事の選択で `bond` が動いて関係の段階（`relationStage`）に反映される。
 *
 * このモジュールは**状態を持たない**。会話の進行（何往復目か・何を選んだか）は
 * `BarTalkState` として `src/app/App.ts` が持ち、描画は `HubContext.barTalk`
 * 経由で `src/ui/HubPanels.ts` が行う。乱数を使わないので、同じ入力なら必ず
 * 同じ会話になる（画面を開き直すたびに文が変わると、返事の効果が読めない）。
 */

export interface BarTalkTurn {
  speaker: 'pilot' | 'player';
  text: string;
}

export interface BarTalkReply {
  id: string;
  label: string;
}

export interface BarTalkRelation {
  label: string;
  step: number;
  max: number;
  /**
   * 直前の出撃で関係に何が効いたかの1行（描画は任意）。
   * `BarTalkView` の必須3項目とは独立なので、使わなくても描画は成立する。
   */
  reason?: string;
}

export interface BarTalkView {
  pilotId: string;
  turns: BarTalkTurn[];
  /** 空配列なら会話終了 */
  replies: BarTalkReply[];
  relation: BarTalkRelation;
}

/** 直前の出撃で「この人に何が起きたか」。すべて省略可（初回の帰艦前は全部 false）。 */
export interface BarTalkFacts {
  /** 直前の出撃で僚機として一緒に飛んだ */
  flewWithPlayer?: boolean;
  /** 助けを求め、応えてもらった */
  rescued?: boolean;
  /** 助けを求めたのに、来てもらえなかった */
  abandoned?: boolean;
  /** プレイヤーが機体を失って帰投した */
  playerLost?: boolean;
  /** 直近で失った隊員の名前（いれば追悼の話題になる） */
  fallenName?: string;
}

/** 会話の進行。選んだ返事の id を順に積むだけ。 */
export interface BarTalkState {
  pilotId: string;
  chosen: string[];
}

export interface BarTalkInput {
  pilot: PilotState;
  personality: PersonalityId;
  facts?: BarTalkFacts;
  state?: BarTalkState;
}

/** 返事を選ぶ回数（=往復数） */
export const BAR_TALK_ROUNDS = 2;

export function newBarTalk(pilotId: string): BarTalkState {
  return { pilotId, chosen: [] };
}

/** 返事の id。`HubPanels` はこの文字列をそのまま返してくる。 */
function replyId(round: 1 | 2, kind: BarReplyKind): string {
  return `r${round}-${kind}`;
}

function parseReplyId(id: string): { round: 1 | 2; kind: BarReplyKind } | undefined {
  const m = /^r([12])-(warm|blunt)$/.exec(id);
  if (!m) return undefined;
  return { round: m[1] === '1' ? 1 : 2, kind: m[2] as BarReplyKind };
}

/**
 * 話題を決める。優先順位は「その人の身に起きたこと」→「艦の出来事」→「関係値」。
 *
 * 助けた／見捨てたは僚機として飛んだ人にしか起きないので、
 * 同じ帰艦でも人によって話題が変わる。
 */
export function barTalkTopic(pilot: PilotState, facts: BarTalkFacts = {}): BarTalkTopic {
  if (facts.flewWithPlayer && facts.rescued) return 'thanks';
  if (facts.flewWithPlayer && facts.abandoned) return 'silent';
  if (facts.fallenName) return 'mourning';
  if (facts.playerLost) return 'playerLoss';
  if (facts.flewWithPlayer) return 'flown';
  const stage = relationStage(pilot);
  if (stage.step >= 3) return 'friendly';
  if (stage.step === 0) return 'cold';
  return 'idle';
}

/** 話題ごとの「関係に効いた理由」。関係値の段階の隣に1行で出す。 */
function relationReason(topic: BarTalkTopic, facts: BarTalkFacts): string | undefined {
  switch (topic) {
    case 'thanks':
      return '直前の出撃: 救援要請に応えた';
    case 'silent':
      return '直前の出撃: 救援要請に応えなかった';
    case 'flown':
      return '直前の出撃: 僚機として一緒に飛んだ';
    case 'playerLoss':
      return '直前の出撃: あなたが機体を失って帰投した';
    case 'mourning':
      return facts.fallenName ? `直前の出撃: ${facts.fallenName} を失った` : '直前の出撃: 隊員を失った';
    default:
      return '直前の出撃では一緒に飛んでいない';
  }
}

/**
 * 返事1回で動く bond。
 *
 * 素の値は 1往復目 warm +0.10 / blunt -0.04、2往復目はその6割。
 * 見捨てた直後（`silent`）と関係が悪い相手（`cold`）だけは、謝るか突き放すかで
 * 動きが大きい。「話しかければ必ず上がる」ようにはしない。
 */
const REPLY_BOND_BASE: Record<BarReplyKind, number> = { warm: 0.1, blunt: -0.04 };
const TOPIC_BOND_SCALE: Partial<Record<BarTalkTopic, Record<BarReplyKind, number>>> = {
  silent: { warm: 1.6, blunt: 2.5 },
  cold: { warm: 1.4, blunt: 1.8 },
  thanks: { warm: 1, blunt: 1.5 },
  mourning: { warm: 1.2, blunt: 1.5 },
};

export function barReplyBond(topic: BarTalkTopic, round: 1 | 2, kind: BarReplyKind): number {
  const scale = TOPIC_BOND_SCALE[topic]?.[kind] ?? 1;
  const roundScale = round === 1 ? 1 : 0.6;
  return round2(REPLY_BOND_BASE[kind] * scale * roundScale);
}

function round2(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/** 台詞の揺らぎを決める種。人物と出撃回数で決まるので、同じ帰艦の間は変わらない。 */
function seedOf(pilot: PilotState): number {
  let hash = 0;
  for (let i = 0; i < pilot.id.length; i++) hash = (hash * 31 + pilot.id.charCodeAt(i)) % 100003;
  return hash + pilot.sorties;
}

/**
 * いまの状態から会話の表示物を組み立てる。
 *
 * `state.chosen` の長さが往復数。0 なら近況のみ、`BAR_TALK_ROUNDS` に達したら
 * `replies` が空になり会話が終わる。
 */
export function buildBarTalk(input: BarTalkInput): BarTalkView {
  const { pilot, personality } = input;
  const facts = input.facts ?? {};
  const topic = barTalkTopic(pilot, facts);
  const chosen = (input.state?.pilotId === pilot.id ? input.state?.chosen : undefined) ?? [];
  const seed = seedOf(pilot);

  const turns: BarTalkTurn[] = [
    { speaker: 'pilot', text: barOpeningLine(personality, topic, seed, facts.fallenName) },
  ];

  const first = parseReplyId(chosen[0] ?? '');
  if (first) {
    turns.push({ speaker: 'player', text: barReplyLabel(topic, 1, first.kind) });
    turns.push({ speaker: 'pilot', text: barResponseLine(personality, first.kind, seed + 1) });
  }
  const second = parseReplyId(chosen[1] ?? '');
  if (first && second) {
    turns.push({ speaker: 'player', text: barReplyLabel(topic, 2, second.kind) });
    turns.push({ speaker: 'pilot', text: barClosingLine(personality, second.kind, seed + 2) });
  }

  const round = first && second ? 3 : first ? 2 : 1;
  const replies: BarTalkReply[] =
    round > BAR_TALK_ROUNDS
      ? []
      : (['warm', 'blunt'] as const).map((kind) => ({
          id: replyId(round as 1 | 2, kind),
          label: barReplyLabel(topic, round as 1 | 2, kind),
        }));

  const stage = relationStage(pilot);
  return {
    pilotId: pilot.id,
    turns,
    replies,
    relation: { ...stage, reason: relationReason(topic, facts) },
  };
}

export interface BarTalkChoiceResult {
  /** 進んだ後の会話状態 */
  state: BarTalkState;
  /** この選択で bond に足すべき量（`shiftBond` に渡す。0 なら無効な選択） */
  bondDelta: number;
  /** これで会話が終わったか */
  finished: boolean;
}

/**
 * 返事を1つ選んだ結果を返す。**bond は書き換えない**（呼び出し側が
 * `shiftBond` で反映する）。無効な id・すでに終わった会話は無視して現状を返す。
 */
export function chooseBarReply(input: BarTalkInput, id: string): BarTalkChoiceResult {
  const state = input.state?.pilotId === input.pilot.id ? input.state : newBarTalk(input.pilot.id);
  const chosen = [...state.chosen];
  const parsed = parseReplyId(id);
  const expected = (chosen.length + 1) as 1 | 2;
  if (!parsed || chosen.length >= BAR_TALK_ROUNDS || parsed.round !== expected) {
    return { state, bondDelta: 0, finished: chosen.length >= BAR_TALK_ROUNDS };
  }
  const topic = barTalkTopic(input.pilot, input.facts ?? {});
  chosen.push(id);
  return {
    state: { pilotId: input.pilot.id, chosen },
    bondDelta: barReplyBond(topic, parsed.round, parsed.kind),
    finished: chosen.length >= BAR_TALK_ROUNDS,
  };
}
