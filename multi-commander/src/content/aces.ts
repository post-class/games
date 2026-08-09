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
  bio: string;
  /**
   * 旧セーブ・旧ミッション定義に残る本家由来のパイロット名。
   * `aceIdForPilot()` の逆引きを壊さないために保持する（表示には使わない）。
   */
  legacyPilots?: readonly string[];
}

export interface AceState {
  id: string;
  encounters: number;
  kills: number;
  skill: number;
  status: 'active' | 'killed';
  escaped: number;
  lastMission?: string;
  lastVictim?: string;
}

/** 人物名簿から表示名・技量を引いて `AceDefinition` を組み立てる。 */
function defineAce(seed: {
  id: string;
  personId: string;
  shipId: string;
  faction: Faction;
  stance: AceStance;
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
    bio: '撃墜した敵の名をすべて記憶し、戦場で一対一の誓約を守る決闘士。',
    legacyPilots: ['Khajja nar Ragitika'],
  }),
  defineAce({
    id: 'caxki',
    personId: 'kilrashi-02',
    shipId: 'kf03-greyhaul',
    faction: 'kilrathi',
    stance: 'oath',
    bio: '重力圏での耐久追跡を得意とし、三つの空母戦で生還した巡航狩人。',
    legacyPilots: ['Bhurak nar Caxki'],
  }),
  defineAce({
    id: 'dakhas',
    personId: 'kilrashi-04',
    shipId: 'kb02-bastion',
    faction: 'kilrathi',
    stance: 'radical',
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
    bio: '陽動と潜入で三個中隊を足止めした灰冠近衛隊長。',
  }),
  defineAce({
    id: 'fen',
    personId: 'kilrashi-08',
    shipId: 'kf06-talon',
    faction: 'kilrathi',
    stance: 'radical',
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
    status: 'active',
    escaped: 0,
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
  }
  return [...byId.values()];
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
}

function integerOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
