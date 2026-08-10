/**
 * 戦域をまたいで生き残る宿敵（エース）。
 *
 * エースは「そのミッションの強い敵」ではなく、遭遇・離脱・撃墜を
 * キャンペーンに持ち越す人物として扱う。保存データに未知の人物が
 * 入っていてもゲームを壊さないよう、ここで必ず正規化する。
 *
 * ■ T2-3（2026-08-09）で本家由来の3名を新設定の人物へ差し替えた
 * - 人物データは `src/content/veil/people.ts` の名簿を単一の出典とし、
 *   `personId` で参照する。`skill` は `skillFromGrade(person.grade)` から導出し、
 *   ここでハードコードしない（戦闘級と技量の対応を1箇所に保つ）。
 * - `stance` は「誓約を守る側 / 拡張を望む急進派」の区別。第5章の
 *   「誓約を守る側と破る側が、敵味方の線と一致しなくなる」という物語の要点を
 *   データとして持たせるための軸で、陣営（`faction`）とは独立している。
 * - 陣営idは既存の `kilrathi`（th）を使う。資料表記は `kilrashi`（sh）だが、
 *   実装側の `Faction` は互換のため th のまま据え置く。
 */

import type { Faction } from './ships';
import { skillFromGrade, veilPerson } from './veil/people';

/**
 * 誓約に対する立場。
 * - `oath`: 古い決闘規約（誓約）を守る側。決闘中は砲門を閉じ、名を交換する。
 * - `radical`: 拡張を望む若い軍家（急進派）。誓約を破り、決闘空域ごと撃つ。
 */
export type AceStance = 'oath' | 'radical';

/** 決闘規約の内容。第5章・第6章のギミック実装（T6-5）から参照する。 */
export interface AceOathRules {
  /** 決闘の申し込みを行う（帝国艦隊の砲は決闘中沈黙する）。 */
  challenges: boolean;
  /** 交戦前に名を交換する儀礼を要求する。 */
  exchangeNames: boolean;
  /** 決闘中は決闘の当事者以外へ砲撃しない。 */
  noThirdPartyFire: boolean;
  /** 離脱を宣言した相手を追撃しない。 */
  noPursuitOnDisengage: boolean;
  /** 撃墜した相手の名をすべて記憶している（無線で引用する）。 */
  remembersNames: boolean;
  /** 誓約を破られたときの反応。 */
  onBroken: 'defend-duel' | 'withdraw' | 'avenge';
  /** 決闘の説明文（HUD・ブリーフィングに出す1行）。 */
  note: string;
}

/**
 * エースの口調（T4-⑯）。
 *
 * 交戦中の通信（名乗る／降伏を勧める／決闘を申し込む）と、再会時の第一声を
 * **人物ごとに** 持たせる。台詞を `dialogue.ts` 側の配列にまとめてしまうと
 * 「誰が言っても同じ」になり、名を記憶する誓約の設定が薄くなるため、
 * ここ（人物データ）を唯一の出所にする。
 *
 * 文章の組み立て（拒否理由の一句を足す等）は `dialogue.ts` が受け持つ。
 */
export interface AceVoice {
  /** こちらが名乗ったときの返答。 */
  name: string;
  /** 降伏を勧めたときの返答。 */
  surrender: string;
  /** 決闘を受けるときの返答。 */
  duelAccept: string;
  /** 決闘を断るときの返答（理由の一句は `dialogue.ts` が足す）。 */
  duelDecline: string;
  /** 初対面の第一声。 */
  greetFirst: string;
  /** 一度以上顔を合わせている相手への第一声。 */
  greetKnown: string;
  /** 逃げられた（こちらが取り逃がした）後の第一声。 */
  greetWary: string;
  /** 脱出ポッドを撃たれなかった（借りがある）後の第一声。 */
  greetDebt: string;
  /** 誰かの脱出ポッドを撃った者への第一声。 */
  greetGrudge: string;
}

export interface AceDefinition {
  id: string;
  /** 人物名簿（`VEIL_PEOPLE`）への参照。 */
  personId: string;
  pilot: string;
  callsign: string;
  shipId: string;
  /** `skillFromGrade(person.grade)` から導出した技量 0..1。 */
  skill: number;
  /** 所属陣営。既存の `Faction` id を使う。 */
  faction: Faction;
  /** 誓約を守る側か、誓約を破る急進派か。 */
  stance: AceStance;
  /** 誓約を守るエースのみ持つ決闘規約。 */
  oathRules?: AceOathRules;
  /** 交戦中の通信と再会の第一声（T4-⑯）。 */
  voice: AceVoice;
  bio: string;
  /**
   * 旧セーブ・旧ミッション定義に残る本家由来のパイロット名。
   * `aceIdForPilot()` の逆引きを壊さないために保持する（表示には使わない）。
   */
  legacyPilots?: readonly string[];
}

/**
 * エースとのやりとりの種類（T4-⑯）。
 * `log` に積み、再会時の第一声と「これまでのやりとり」の表示に使う。
 */
export type AceContactKind =
  | 'name'
  | 'surrender'
  | 'duel-accepted'
  | 'duel-declined'
  | 'spared'
  | 'executed'
  | 'escaped'
  | 'killed';

export interface AceContactEntry {
  kind: AceContactKind;
  /** そのやりとりが起きたミッションid。 */
  mission?: string;
}

/** 積み上げる `log` の上限。旧セーブとの互換のため、超えた分は古いものから捨てる。 */
export const ACE_LOG_LIMIT = 12;

export interface AceState {
  id: string;
  encounters: number;
  kills: number;
  skill: number;
  status: 'active' | 'killed';
  escaped: number;
  lastMission?: string;
  lastVictim?: string;
  /**
   * 撃墜後に脱出ポッドを**撃たなかった**回数（T4-⑯）。
   *
   * 座席を撃たなければ人物は回収されて次の章にまた出てくる。
   * そのため `recordAcePodSpared()` は `status` を `active` へ戻す。
   */
  spared: number;
  /** 撃墜後に脱出ポッドを**撃った**回数。撃った相手は二度と出てこない。 */
  executed: number;
  /** こちらの決闘の申し込みが受けられた回数。 */
  duelsAccepted: number;
  /** こちらの決闘の申し込みが断られた回数。 */
  duelsDeclined: number;
  /** 名を交換した回数。 */
  namesExchanged: number;
  /**
   * これまでのやりとり（古い順）。
   *
   * **任意フィールドである理由**: これを持たない旧セーブをそのまま読めるようにする。
   * 欠落時は `normalizeAceStates()` が空配列を入れる。
   */
  log?: AceContactEntry[];
}

/**
 * 艦隊全体の記憶（T4-⑯）。
 *
 * 誓約を守る側は「撃墜した相手の名をすべて記憶している」（`remembersNames`）。
 * したがって脱出ポッドを撃った事実は、撃たれた本人（もう出てこない）ではなく
 * **他のエースの態度**に返ってくる。そのための合計値。
 */
export interface AceFleetMemory {
  spared: number;
  executed: number;
}

/** 全エースの記録から艦隊全体の記憶を集計する。 */
export function aceFleetMemory(states: readonly AceState[]): AceFleetMemory {
  let spared = 0;
  let executed = 0;
  for (const s of states) {
    spared += Math.max(0, s.spared ?? 0);
    executed += Math.max(0, s.executed ?? 0);
  }
  return { spared, executed };
}

/** 再会時の態度。第一声の選択に使う。 */
export type AceAttitude = 'unmet' | 'known' | 'wary' | 'debt' | 'grudge';

/**
 * 再会時の態度を決める。
 *
 * 優先順位は次のとおり。**難易度には一切影響させない**（変えるのは台詞と AI の狙い方だけ）。
 * 1. まだ会っておらず、艦隊の記憶も無い → `unmet`
 * 2. この相手の座席を撃たずに帰した（かつ、誰の座席も撃っていない）→ `debt`
 * 3. 誰かの座席を撃っている → `grudge`
 * 4. 取り逃がしている → `wary`
 * 5. それ以外（顔は合わせている）→ `known`
 */
export function aceAttitude(state: AceState, fleet: AceFleetMemory): AceAttitude {
  const spared = Math.max(0, state.spared ?? 0);
  if (state.encounters <= 0 && fleet.executed <= 0 && fleet.spared <= 0) return 'unmet';
  if (spared > 0 && fleet.executed <= 0) return 'debt';
  if (fleet.executed > 0) return 'grudge';
  if (state.escaped > 0) return 'wary';
  return 'known';
}

/** 人物名簿から表示名・技量を引いて `AceDefinition` を組み立てる。 */
function defineAce(seed: {
  id: string;
  personId: string;
  shipId: string;
  faction: Faction;
  stance: AceStance;
  voice: AceVoice;
  bio: string;
  oathRules?: AceOathRules;
  legacyPilots?: readonly string[];
}): AceDefinition {
  const person = veilPerson(seed.personId);
  const def: AceDefinition = {
    id: seed.id,
    personId: person.id,
    pilot: person.name,
    callsign: person.epithet,
    shipId: seed.shipId,
    skill: skillFromGrade(person.grade),
    faction: seed.faction,
    stance: seed.stance,
    voice: seed.voice,
    bio: seed.bio,
  };
  if (seed.oathRules) def.oathRules = seed.oathRules;
  if (seed.legacyPilots) def.legacyPilots = seed.legacyPilots;
  return def;
}

/** ラギティカの誓約。第5章の単機決闘の骨格。 */
const RAGITIKA_OATH: AceOathRules = {
  challenges: true,
  exchangeNames: true,
  noThirdPartyFire: true,
  noPursuitOnDisengage: true,
  remembersNames: true,
  onBroken: 'defend-duel',
  note: '決闘の間、帝国の全砲は沈黙する。名を交換した相手の名は記憶に残る。',
};

/**
 * 宿敵5名。
 * 機体idは帝国機の新id（KF01〜KF06 / KB / KE 系）を直接参照する。
 */
export const ACES: AceDefinition[] = [
  defineAce({
    // 物語の中心人物。第5章で単機決闘、第8章で救難信号、第9章で位相迷路の中、第10章で旗艦護衛の分断。
    id: 'ragitika',
    personId: 'kilrashi-03',
    shipId: 'kf06-talon',
    faction: 'kilrathi',
    stance: 'oath',
    oathRules: RAGITIKA_OATH,
    // 荘重で、書式（誓約の手続き）を第一に語る。
    voice: {
      name: '受け取った。あなたの名は、勝敗の後も私の記録に残る。',
      surrender: '降伏は書式に無い。砲を下げる代わりに、名を下げるのか。',
      duelAccept: '受ける。帝国の砲は今から沈黙する。来い、一機で。',
      duelDecline: '今日は誓約を交わせない。',
      greetFirst: '初めて聞く声だ。名の無い相手を落とすのは好まない。',
      greetKnown: 'また会ったな。前の空域の飛び方は覚えている。',
      greetWary: '前は逃がした。あの時の癖は直したか。',
      greetDebt: 'あなたは私の座席を撃たなかった。……その借りは、今日も残っている。',
      greetGrudge: '座席を撃った者の名を、我々は忘れない。今日は書式を省く。',
    },
    bio: '撃墜した敵の名をすべて記憶し、戦場で一対一の誓約を守る決闘士。',
    legacyPilots: ['Khajja nar Ragitika'],
  }),
  defineAce({
    id: 'caxki',
    personId: 'kilrashi-02',
    shipId: 'kf03-greyhaul',
    faction: 'kilrathi',
    stance: 'oath',
    // 実務的で粘り強い。狩りの言葉で話す。
    voice: {
      name: '名か。控えた。長い追跡になるぞ、覚悟しておけ。',
      surrender: '降りる気はない。燃料が尽きるまで付き合う。',
      duelAccept: '面白い。他は手を出さん。二機だけで、燃料の限りやろう。',
      duelDecline: '悪いが、その申し出は受けられん。',
      greetFirst: '新顔だな。息が続くかどうか、見せてもらう。',
      greetKnown: 'その機体、前にも追った。今日も長くなりそうだ。',
      greetWary: '前は振り切られた。同じ手は通らんぞ。',
      greetDebt: '座席を撃たなかった件は聞いている。だから今日も追うだけだ。',
      greetGrudge: '座席を撃つ流儀か。ならこちらも余裕は残さん。',
    },
    bio: '重力圏での耐久追跡を得意とし、三つの空母戦で生還した巡航狩人。',
    legacyPilots: ['Bhurak nar Caxki'],
  }),
  defineAce({
    id: 'dakhas',
    personId: 'kilrashi-04',
    shipId: 'kb02-bastion',
    faction: 'kilrathi',
    stance: 'radical',
    // 急進派の執行者。短く、冷たく、手続きを嫌う。
    voice: {
      name: '名など要らん。番号で足りる。',
      surrender: '降伏を勧めるのはこちらの役だ。帰投線を空けろ。',
      duelAccept: '一対一？ 付き合ってやる。時間の無駄だがな。',
      duelDecline: '断る。',
      greetFirst: '帰投線に用があるなら、こちらが先だ。',
      greetKnown: 'また邪魔をするのか。学ばない相手は嫌いだ。',
      greetWary: '前は逃がしてやった。二度目は無い。',
      greetDebt: '座席を残した？ 甘いな。それが弱点だ。',
      greetGrudge: '座席を撃つのか。……ようやく話が合いそうだ。',
    },
    bio: '耐弾装甲を生かして危険な帰投線を護衛し、帰投する船だけを狙う執行者。',
    legacyPilots: ['Dakhath «Deathstroke»'],
  }),
  defineAce({
    id: 'seiraku',
    personId: 'kilrashi-05',
    shipId: 'kf03-greyhaul',
    faction: 'kilrathi',
    stance: 'oath',
    oathRules: {
      challenges: false,
      exchangeNames: true,
      noThirdPartyFire: false,
      noPursuitOnDisengage: true,
      remembersNames: false,
      onBroken: 'withdraw',
      note: '宗家の旗艦を守るためなら陽動と潜入を選ぶが、誓約の書式は崩さない。',
    },
    // 近衛隊長。丁寧だが、任務が最優先だとはっきり言う。
    voice: {
      name: '確かに受領した。礼儀には礼儀で返す。',
      surrender: '降伏の勧めは受け取った。だが私の任は旗艦の前に立つことだ。',
      duelAccept: '一対一に応じる。ただし旗艦から離れた空域でだ。',
      duelDecline: '申し訳ないが、その形は取れない。',
      greetFirst: '所属と名を。……無いなら、こちらから記す。',
      greetKnown: 'また前に立つことになったな。書式は前回どおりで良いか。',
      greetWary: '前回は追わなかった。それは追えなかったのとは違う。',
      greetDebt: '座席を撃たなかった件、宗家まで届いている。礼は言う。',
      greetGrudge: '座席を撃った報告を読んだ。……礼儀は今日で終いだ。',
    },
    bio: '陽動と潜入で三個中隊を足止めした灰冠近衛隊長。',
  }),
  defineAce({
    id: 'fen',
    personId: 'kilrashi-08',
    shipId: 'kf06-talon',
    faction: 'kilrathi',
    stance: 'radical',
    // 荒く、勢いで押す。誓約を「遅い」と言う。
    voice: {
      name: '名を送る暇があるなら舵を切れ。もう間に合わんぞ。',
      surrender: '降伏だと？ 家門の記録に何と書けばいい。',
      duelAccept: '一対一か。いいぞ、その方が速い。他は下がっていろ。',
      duelDecline: '書式は遅い。断る。',
      greetFirst: '新しい的だ。門は待ってくれんのでな、手早く済ませる。',
      greetKnown: 'お前か。前は仕留め損ねた。今日は詰める。',
      greetWary: '逃げ足だけは認める。今日は逃がさん。',
      greetDebt: '座席を残す余裕があったのか。次はこちらが残さん。',
      greetGrudge: '座席を撃った？ 誓約者どもが騒いでいたぞ。私は構わんが。',
    },
    bio: '高重力域の旋回戦術を帝国標準にした重戦闘機隊長。急進派の攻勢を率いる。',
  }),
];

/**
 * 急進派の分艦隊。名前を持つ個人ではなく「誓約を破る側の勢力」として扱う。
 * 第5章の決闘空域への介入、第8章の灯台襲撃、第10章の連合旗艦に登場する。
 *
 * エースと同じ `AceState` の持ち越し対象にはしない（個人ではないため）。
 * 出現規模は章の進行と `stance === 'radical'` のエースの生存で決まる。
 */
export interface RadicalSquadronDef {
  id: string;
  /** 表示名。 */
  name: string;
  /** 帝国内の勢力なので陣営は `kilrathi`。 */
  faction: Faction;
  /** 常に `radical`（誓約を破る側）。 */
  stance: Extract<AceStance, 'radical'>;
  /** 主力機のid（帝国機の新id）。 */
  shipIds: readonly string[];
  /** 分艦隊の中核となる急進派エースのid（`ACES` の部分集合）。 */
  aceIds: readonly string[];
  /** 章ごとの登場のしかた。 */
  appearances: readonly {
    /** 章番号 1..10。 */
    chapter: number;
    /** その章での役割。 */
    role: string;
    /** 破る誓約の内容（第5章の「誓約空域ごと撃つ」など）。 */
    breaks: string;
  }[];
  bio: string;
}

export const RADICAL_SQUADRON: RadicalSquadronDef = {
  id: 'radical-squadron',
  name: '急進派分艦隊（拡張派の若い軍家）',
  faction: 'kilrathi',
  stance: 'radical',
  shipIds: ['kf03-greyhaul', 'kf01-leonfang', 'kb02-bastion', 'kf06-talon'],
  aceIds: ['dakhas', 'fen'],
  appearances: [
    {
      chapter: 5,
      role: '決闘空域へ介入し、決闘中の二機をまとめて撃ち抜こうとする。',
      breaks: '決闘中は全砲を沈黙させるという大牙王の誓約。',
    },
    {
      chapter: 8,
      role: '五者署名を中継する通信灯台三基を襲撃する。',
      breaks: '共同設備の保全規約と、停戦の六十秒。',
    },
    {
      chapter: 10,
      role: '連合旗艦として最後の突撃を行う。',
      breaks: '五者通行協定そのもの（割られた門制御核の私有）。',
    },
  ],
  bio: '拡張を望む若い軍家の分艦隊。誓約ではなく門制御核を優先し、敵味方の線と誓約の線をずらす。',
};

export function aceDef(id: string): AceDefinition | undefined {
  return ACES.find((a) => a.id === id);
}

export function aceIdForPilot(pilot: string | undefined): string | undefined {
  if (!pilot) return undefined;
  return ACES.find((a) => a.pilot === pilot || a.legacyPilots?.includes(pilot))?.id;
}

/** 誓約を守る側 / 破る側でエースを絞り込む。 */
export function acesByStance(stance: AceStance): AceDefinition[] {
  return ACES.filter((a) => a.stance === stance);
}

export function newAceStates(): AceState[] {
  return ACES.map((a) => ({
    id: a.id,
    encounters: 0,
    kills: 0,
    skill: a.skill,
    status: 'active' as const,
    escaped: 0,
    spared: 0,
    executed: 0,
    duelsAccepted: 0,
    duelsDeclined: 0,
    namesExchanged: 0,
    log: [],
  }));
}

/**
 * 旧エースid → 新エースid の移行表。
 *
 * 方針: **未知idは無視ではなく、対応する新エースへ移行する。**
 * 旧3名はいずれも新名簿に相当する人物がいるため（Caxki→カクシ、
 * Ragitika→ラギティカ、Deathstroke→ダカス）、遭遇・撃墜・離脱の記録を
 * 引き継ぐ方が「戦域をまたいで生き残る宿敵」という設計に合う。
 * この表に無い未知idは、そのまま無視する。
 */
const LEGACY_ACE_IDS: Readonly<Record<string, string>> = {
  bhurak: 'caxki',
  khajja: 'ragitika',
  dakhath: 'dakhas',
};

export function normalizeAceStates(raw: unknown): AceState[] {
  const fallback = newAceStates();
  if (!Array.isArray(raw)) return fallback;
  const byId = new Map(fallback.map((a) => [a.id, a]));
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const p = item as Partial<AceState>;
    if (typeof p.id !== 'string') continue;
    // 旧idは新idへ読み替える。読み替え先が重複した場合は後から読んだ側が残る。
    const id = byId.has(p.id) ? p.id : LEGACY_ACE_IDS[p.id];
    const base = id ? byId.get(id) : undefined;
    if (!base) continue;
    base.encounters = integerOr(p.encounters, 0);
    base.kills = integerOr(p.kills, 0);
    base.skill = clamp(typeof p.skill === 'number' ? p.skill : base.skill, 0.5, 1);
    base.status = p.status === 'killed' ? 'killed' : 'active';
    base.escaped = integerOr(p.escaped, 0);
    base.lastMission = typeof p.lastMission === 'string' ? p.lastMission : undefined;
    base.lastVictim = typeof p.lastVictim === 'string' ? p.lastVictim : undefined;
    // T4-⑯ で足したフィールド。**旧セーブには存在しない**ので、
    // 欠落は 0 / 空配列として扱う（既定値は `newAceStates()` が入れてある）。
    base.spared = integerOr(p.spared, 0);
    base.executed = integerOr(p.executed, 0);
    base.duelsAccepted = integerOr(p.duelsAccepted, 0);
    base.duelsDeclined = integerOr(p.duelsDeclined, 0);
    base.namesExchanged = integerOr(p.namesExchanged, 0);
    base.log = normalizeAceLog(p.log);
  }
  return [...byId.values()];
}

const ACE_CONTACT_KINDS: readonly AceContactKind[] = [
  'name',
  'surrender',
  'duel-accepted',
  'duel-declined',
  'spared',
  'executed',
  'escaped',
  'killed',
];

function normalizeAceLog(raw: unknown): AceContactEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: AceContactEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const p = item as Partial<AceContactEntry>;
    if (!ACE_CONTACT_KINDS.includes(p.kind as AceContactKind)) continue;
    const entry: AceContactEntry = { kind: p.kind as AceContactKind };
    if (typeof p.mission === 'string') entry.mission = p.mission;
    out.push(entry);
  }
  return out.slice(-ACE_LOG_LIMIT);
}

export function aceState(states: AceState[], pilotOrId: string): AceState | undefined {
  const id = aceDef(pilotOrId)?.id ?? aceIdForPilot(pilotOrId) ?? LEGACY_ACE_IDS[pilotOrId] ?? pilotOrId;
  return states.find((a) => a.id === id);
}

export function recordAceEncounter(state: AceState, missionId: string): void {
  state.encounters += 1;
  state.lastMission = missionId;
}

export function recordAceEscape(state: AceState): void {
  if (state.status === 'killed') return;
  state.escaped += 1;
  state.skill = clamp(state.skill + 0.015, 0.5, 1);
}

export function recordAceKill(state: AceState): void {
  state.status = 'killed';
  state.kills += 1;
  recordAceContact(state, 'killed', state.lastMission);
}

/** やりとりを1件積む（古いものから捨てる）。 */
export function recordAceContact(
  state: AceState,
  kind: AceContactKind,
  missionId?: string,
): void {
  const log = (state.log ??= []);
  const entry: AceContactEntry = { kind };
  if (missionId) entry.mission = missionId;
  log.push(entry);
  if (log.length > ACE_LOG_LIMIT) log.splice(0, log.length - ACE_LOG_LIMIT);
}

/** 名を交換した。 */
export function recordAceNameExchange(state: AceState, missionId?: string): void {
  state.namesExchanged = Math.max(0, state.namesExchanged ?? 0) + 1;
  recordAceContact(state, 'name', missionId);
}

/** 降伏を勧めた（受け入れられなくても、勧めた事実は残る）。 */
export function recordAceSurrenderOffer(state: AceState, missionId?: string): void {
  recordAceContact(state, 'surrender', missionId);
}

/** 決闘の申し込みの結果を記録する。 */
export function recordAceDuel(state: AceState, accepted: boolean, missionId?: string): void {
  if (accepted) {
    state.duelsAccepted = Math.max(0, state.duelsAccepted ?? 0) + 1;
    recordAceContact(state, 'duel-accepted', missionId);
  } else {
    state.duelsDeclined = Math.max(0, state.duelsDeclined ?? 0) + 1;
    recordAceContact(state, 'duel-declined', missionId);
  }
}

/**
 * 撃墜後の脱出ポッドを**撃たなかった**。
 *
 * 座席が残れば人物は回収される。だから `status` を `active` へ戻す。
 * これが無いと「撃墜した宿敵は再出現しない」（`MissionRunner` の規則）に阻まれて、
 * 見逃した相手と二度と会えず、③④の「次の出撃で態度が変わる」が成立しない。
 * 撃墜そのものの記録（`kills`）と、そのミッションの戦果は取り消さない。
 */
export function recordAcePodSpared(state: AceState, missionId?: string): void {
  state.spared = Math.max(0, state.spared ?? 0) + 1;
  state.status = 'active';
  recordAceContact(state, 'spared', missionId);
}

/** 撃墜後の脱出ポッドを**撃った**。この人物は二度と出てこない。 */
export function recordAcePodExecuted(state: AceState, missionId?: string): void {
  state.executed = Math.max(0, state.executed ?? 0) + 1;
  state.status = 'killed';
  recordAceContact(state, 'executed', missionId);
}

// ───────── 決闘の申し込み（T4-⑯） ─────────

/** 決闘を断る理由。文面は `dialogue.ts` が組み立てる。 */
export type DuelRefusal =
  | 'no-challenge-rule'
  | 'name-first'
  | 'too-many-wingmen'
  | 'low-oath'
  | 'executed-pods';

/** 決闘を一対一と認める僚機の上限。これを超えて連れていると断られる。 */
export const DUEL_MAX_WINGMEN = 1;
/** 決闘に応じてもらえる「敵エースの誓約」の下限（0..100）。 */
export const DUEL_MIN_OATH = 30;

export interface DuelRequest {
  def: AceDefinition;
  /** その相手の記録。訓練出撃では記録を持たないので省略できる。 */
  state?: AceState;
  /** 「敵エースの誓約」0..100（`NarrativeState.aceOath`）。 */
  oath: number;
  /** 生存している自機の僚機の数。 */
  wingmen: number;
  /** この出撃で既に名を交換したか。 */
  namedThisSortie: boolean;
  /** 艦隊全体の記憶（座席を撃った実績はここから読む）。 */
  fleet: AceFleetMemory;
}

export interface DuelVerdict {
  accepted: boolean;
  reason?: DuelRefusal;
}

/**
 * 決闘の申し込みを受けるかどうか。
 *
 * 断る条件（この順に判定する）
 * 1. `oathRules.challenges !== true` — 決闘の項目を持たない流派（急進派とセイラク）は受けない
 * 2. `oathRules.exchangeNames === true` なのに、この出撃でまだ名乗っていない — 書式違反
 * 3. 僚機を `DUEL_MAX_WINGMEN` 機より多く連れている — 一対一にならない
 * 4. 「敵エースの誓約」が `DUEL_MIN_OATH` 未満 — 信用が足りない
 * 5. 誰かの脱出ポッドを撃っている（`fleet.executed > 0`）— 座席を撃つ者と誓約は結べない
 *
 * **技量差は条件に入れない。** 技量で断らせると「上手い人だけ決闘できる」ことになり、
 * 4状態が難易度を動かさないという規約と方向が逆になる。代わりに
 * 「書式を踏んだか」「一対一の形になっているか」だけで決める。
 */
export function evaluateDuelRequest(req: DuelRequest): DuelVerdict {
  const rules = req.def.oathRules;
  if (rules?.challenges !== true) return { accepted: false, reason: 'no-challenge-rule' };
  if (rules.exchangeNames && !req.namedThisSortie) {
    return { accepted: false, reason: 'name-first' };
  }
  if (req.wingmen > DUEL_MAX_WINGMEN) return { accepted: false, reason: 'too-many-wingmen' };
  if (req.oath < DUEL_MIN_OATH) return { accepted: false, reason: 'low-oath' };
  if (req.fleet.executed > 0) return { accepted: false, reason: 'executed-pods' };
  return { accepted: true };
}

function integerOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
