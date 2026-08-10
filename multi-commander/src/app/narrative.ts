/**
 * THE VEIL FRONT — キャンペーンの選択結果（「管理する4状態」）。
 *
 * 出典: `ストーリー_十章作戦記録.html` §03 Consequence design。
 * 章末の FIELD CHOICE と出撃結果を、次の出撃の「景色」へ変換するための状態だけを持つ。
 *
 * ── 実装規約（§03 の実装規約をそのまま守る）──────────────────────
 * **難易度パラメータは絶対に変えない。**
 * この状態から派生させてよいのは、
 *   - 味方の顔ぶれ（僚機の出撃可否と人数）
 *   - 援護（セレシオン護衛船 / オルド重力固定 / キルラシー側の協力）
 *   - 搭載兵装の上限（ミサイル搭載数の倍率）
 *   - 無線・会話の内容
 * だけである。敵のHP・攻撃力・弾速・命中補正・出現数といった難易度側の値へは
 * 一切影響させない（AI_CODING.md「難易度補正は対象を明確にする」に従う）。
 * 状態が低い＝ゲームが難しくなる、ではなく、状態が低い＝孤立して戦う、が正しい。
 * ────────────────────────────────────────────────
 */

/** 第8章の通信灯台の本数（＝冗長回線の最大数） */
export const MAX_RELAYS = 3;

/** 4状態の値域（信頼値系） */
const MIN_TRUST = 0;
const MAX_TRUST = 100;
/** 信頼値の初期値。中庸から始め、選択で上下する */
const INITIAL_TRUST = 50;

/** 帰還者の立場。勢力を問わず同じ名簿に並ぶ（十章作戦記録 CHAPTER 10） */
export type ReturneeKind = 'civilian' | 'wingman' | 'enemy-ace' | 'ally-faction';

/**
 * 帰還者1名の構造化記録。
 *
 * `NarrativeState.returnees`（名前の配列）は互換のため残し、こちらが正となる詳細記録。
 */
export interface ReturneeEntry {
  /** 表示名（民間人は船名や「〈アストラ・メイ〉乗員」等でもよい） */
  name: string;
  /** 帰還した章（1..10）。訓練出撃など章外は省略 */
  chapter?: number;
  /** 立場: 民間人 / 僚機 / 敵エース / 他勢力 */
  kind: ReturneeKind;
  /** 人物id（名簿にいる人物のみ） */
  personId?: string;
}

/** 名前だけで追加したときの既定の立場（救助した民間人が最も多いため） */
const DEFAULT_RETURNEE_KIND: ReturneeKind = 'civilian';

/** 最終無線の読み上げ順（同じ章の中での並び） */
const RETURNEE_KIND_ORDER: Record<ReturneeKind, number> = {
  civilian: 0,
  wingman: 1,
  'enemy-ace': 2,
  'ally-faction': 3,
};

export interface NarrativeState {
  /** 帰還者名簿。勢力を問わず、帰還した者の名前。最終無線で読み上げる */
  returnees: string[];
  /**
   * 帰還者の構造化記録（章・立場・人物id）。
   *
   * **任意フィールドである理由**: `returnees` しか持たない旧セーブと、
   * `normalizeNarrative` の出力形を変えないため。欠落時は `returneeEntries()` が
   * `returnees` から復元するので、最終無線の読み上げは常に成立する。
   */
  returneeLog?: ReturneeEntry[];
  /**
   * 名前の付かない帰還者の増減（人数）。章末の選択が積む。
   *
   * **任意フィールドである理由**: `returneeLog` と同じく、旧セーブと
   * `normalizeNarrative` の出力形を変えないため。欠落時は 0 として扱う。
   */
  returneeCredit?: number;
  /**
   * 第8章で残した通信灯台の回線数（0..3）。
   *
   * 仕様: 「三本すべてが残れば認証記録と後続の支援通信が完全に残り、
   * 失われた回線の数だけ次章の通信と援護が細る」。第9章・第10章の援護量に効く。
   *
   * **任意フィールドである理由**: 第8章に到達していないセーブと、
   * `normalizeNarrative` の出力形を変えないため。欠落時は「未到達」として扱う。
   */
  relaysHeld?: number;
  /** 航路信頼 0..100。セレシオン／オルドの支援内容を決める */
  routeTrust: number;
  /** 軍令信用 0..100。搭載兵装・僚機・司令部の無線を決める */
  commandTrust: number;
  /** 敵エースの誓約 0..100。ラギティカ／ヴァルカーンの協力条件を決める */
  aceOath: number;
  /** 章ごとの選択結果 chapterId -> choiceId */
  choices: Record<string, string>;
}

/** 4状態への増減。省略した項目は変化しない */
export interface NarrativeDelta {
  /** 追加する帰還者の名前（章順・追加順を保つ） */
  returnees?: readonly string[];
  /**
   * 名前が判っていない帰還者の増減（人数）。
   *
   * 帰還者の一次情報は「出撃結果から記録された名前」だが、章末の選択には
   * 「救難を優先したので余分に帰れた／追撃を選んだので帰せなかった」という
   * 名前の付かない増減がある。それをここで人数として持つ。
   * 名簿の読み上げ（`returneeRollCall`）には出さず、指標にだけ効く。
   */
  returneeCredit?: number;
  routeTrust?: number;
  commandTrust?: number;
  aceOath?: number;
}

/** 章末の選択が持つ効果。`src/content/veil/` へは依存せず、引数で受け取る */
export type ChoiceEffects = NarrativeDelta;

/** 初期状態。3つの信頼値は中庸（50）から始まり、名簿と選択記録は空 */
export function newNarrative(): NarrativeState {
  return {
    returnees: [],
    routeTrust: INITIAL_TRUST,
    commandTrust: INITIAL_TRUST,
    aceOath: INITIAL_TRUST,
    choices: {},
  };
}

/**
 * 保存データから復元する。
 *
 * 型が違う・欠落している・値域外の場合も必ず正常な状態を返す
 * （`normalizeRoster` / `normalizeFrontline` と同じ流儀: fallback を作って上書きする）。
 */
export function normalizeNarrative(raw: unknown): NarrativeState {
  const fallback = newNarrative();
  if (!raw || typeof raw !== 'object') return fallback;
  const r = raw as Partial<NarrativeState>;

  if (Array.isArray(r.returnees)) {
    for (const name of r.returnees) {
      if (typeof name !== 'string') continue;
      const trimmed = name.trim();
      if (trimmed.length === 0 || fallback.returnees.includes(trimmed)) continue;
      fallback.returnees.push(trimmed);
    }
  }

  // 構造化記録は「あれば正規化して採用、なければキーを増やさない」。
  // 旧セーブ（returnees だけ）の形をそのまま保つため、欠落時に空配列を足さない。
  if (Array.isArray(r.returneeLog)) {
    const entries: ReturneeEntry[] = [];
    const seen = new Set<string>();
    for (const raw of r.returneeLog) {
      const entry = normalizeReturneeEntry(raw);
      if (!entry) continue;
      const key = entry.personId ?? entry.name;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push(entry);
      if (!fallback.returnees.includes(entry.name)) fallback.returnees.push(entry.name);
    }
    fallback.returneeLog = entries;
  }

  // 灯台の残存回線数。0〜3にクランプし、欠落時はキーを増やさない
  if (r.relaysHeld !== undefined) {
    fallback.relaysHeld = clamp(Math.round(numberOr(r.relaysHeld, 0)), 0, MAX_RELAYS);
  }

  // 名前の付かないクレジットも、欠落時はキーを増やさない（旧セーブの形を保つ）
  if (r.returneeCredit !== undefined) {
    fallback.returneeCredit = Math.round(numberOr(r.returneeCredit, 0));
  }

  fallback.routeTrust = clamp(numberOr(r.routeTrust, fallback.routeTrust), MIN_TRUST, MAX_TRUST);
  fallback.commandTrust = clamp(numberOr(r.commandTrust, fallback.commandTrust), MIN_TRUST, MAX_TRUST);
  fallback.aceOath = clamp(numberOr(r.aceOath, fallback.aceOath), MIN_TRUST, MAX_TRUST);

  if (r.choices && typeof r.choices === 'object' && !Array.isArray(r.choices)) {
    for (const [chapterId, choiceId] of Object.entries(r.choices)) {
      if (typeof chapterId !== 'string' || chapterId.length === 0) continue;
      if (typeof choiceId !== 'string' || choiceId.length === 0) continue;
      fallback.choices[chapterId] = choiceId;
    }
  }

  return fallback;
}

/**
 * 章の選択を適用する。
 *
 * 同じ `chapterId` で二度呼ばれても二重加算しない。
 * 既に記録がある場合は何もせず `false` を返す（デブリーフィングの再表示や
 * セーブ復元直後の再適用で信頼値が伸びていくのを防ぐ）。
 *
 * @returns 適用したら true、既に適用済みなら false
 */
export function applyChoice(
  state: NarrativeState,
  chapterId: string,
  choiceId: string,
  effects: ChoiceEffects = {},
): boolean {
  if (typeof chapterId !== 'string' || chapterId.length === 0) return false;
  if (typeof choiceId !== 'string' || choiceId.length === 0) return false;
  if (Object.prototype.hasOwnProperty.call(state.choices, chapterId)) return false;
  state.choices[chapterId] = choiceId;
  adjustNarrative(state, effects);
  return true;
}

/** 章の選択が既に確定しているか */
export function hasChoice(state: NarrativeState, chapterId: string): boolean {
  return Object.prototype.hasOwnProperty.call(state.choices, chapterId);
}

/** 章で選んだ選択肢 */
export function choiceOf(state: NarrativeState, chapterId: string): string | undefined {
  return state.choices[chapterId];
}

/**
 * 帰還者を名簿へ追加する。重複は無視する。
 *
 * 追加順（＝章順）を保持する。第10章の最終無線はこの順で読み上げる。
 *
 * @returns 実際に追加した件数
 */
export function addReturnees(
  state: NarrativeState,
  names: readonly string[],
  meta: { chapter?: number; kind?: ReturneeKind } = {},
): number {
  if (!Array.isArray(names)) return 0;
  let added = 0;
  for (const name of names) {
    if (typeof name !== 'string') continue;
    const trimmed = name.trim();
    if (trimmed.length === 0 || state.returnees.includes(trimmed)) continue;
    state.returnees.push(trimmed);
    pushEntry(state, { name: trimmed, chapter: meta.chapter, kind: meta.kind ?? DEFAULT_RETURNEE_KIND });
    added += 1;
  }
  return added;
}

/**
 * 帰還者を構造化記録として追加する。名前の配列（`returnees`）も同時に更新する。
 *
 * 重複排除のキーは `personId ?? name`。同名の民間人が別の章で出ても潰さないため、
 * 名簿にいる人物は必ず `personId` を渡す。
 *
 * @returns 実際に追加した件数
 */
export function addReturneeEntries(state: NarrativeState, entries: readonly ReturneeEntry[]): number {
  if (!Array.isArray(entries)) return 0;
  let added = 0;
  for (const raw of entries) {
    const entry = normalizeReturneeEntry(raw);
    if (!entry) continue;
    if (!pushEntry(state, entry)) continue;
    if (!state.returnees.includes(entry.name)) state.returnees.push(entry.name);
    added += 1;
  }
  return added;
}

/** 構造化記録へ1件追加する。既に同じキーがあれば false */
function pushEntry(state: NarrativeState, entry: ReturneeEntry): boolean {
  const log = (state.returneeLog ??= []);
  const key = entry.personId ?? entry.name;
  if (log.some((e) => (e.personId ?? e.name) === key)) return false;
  log.push(entry);
  return true;
}

function normalizeReturneeEntry(raw: unknown): ReturneeEntry | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Partial<ReturneeEntry>;
  if (typeof r.name !== 'string') return undefined;
  const name = r.name.trim();
  if (name.length === 0) return undefined;
  const entry: ReturneeEntry = {
    name,
    kind: isReturneeKind(r.kind) ? r.kind : DEFAULT_RETURNEE_KIND,
  };
  if (typeof r.chapter === 'number' && Number.isFinite(r.chapter)) {
    const chapter = Math.floor(r.chapter);
    if (chapter >= 1) entry.chapter = chapter;
  }
  if (typeof r.personId === 'string' && r.personId.trim().length > 0) entry.personId = r.personId.trim();
  return entry;
}

function isReturneeKind(value: unknown): value is ReturneeKind {
  return value === 'civilian' || value === 'wingman' || value === 'enemy-ace' || value === 'ally-faction';
}

/**
 * 構造化記録を取り出す。
 *
 * `returneeLog` を持たない旧セーブでは `returnees`（名前だけ）から復元する。
 * 章・立場が分からないので章外・民間人として扱うが、名前は必ず読み上げられる。
 */
export function returneeEntries(state: NarrativeState): ReturneeEntry[] {
  const log = Array.isArray(state.returneeLog) ? state.returneeLog : [];
  // 名前からの復元で二重に並べないため、記録済みの名前も突き合わせる。
  const seen = new Set<string>();
  for (const entry of log) {
    seen.add(entry.name);
    if (entry.personId) seen.add(entry.personId);
  }
  const restored: ReturneeEntry[] = [];
  for (const name of Array.isArray(state.returnees) ? state.returnees : []) {
    if (typeof name !== 'string') continue;
    const trimmed = name.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    restored.push({ name: trimmed, kind: DEFAULT_RETURNEE_KIND });
  }
  return [...log, ...restored];
}

/**
 * 最終無線の読み上げ順に並べた帰還者名簿。
 *
 * 並び順は
 *   1. 章順（章外＝`chapter` 省略は最後）
 *   2. 同じ章の中では立場順（民間人 → 僚機 → 敵エース → 他勢力）
 *   3. 同じ立場の中では追加順
 * で、勢力は混在させる。第1章で拾った民間人と第5章で救った敵エースが同じ一覧に並ぶ。
 */
export function returneeRollCall(state: NarrativeState): ReturneeEntry[] {
  // Array.prototype.sort は安定なので、比較が等しい要素は追加順のまま残る。
  return returneeEntries(state).sort((a, b) => {
    const ca = a.chapter ?? Number.POSITIVE_INFINITY;
    const cb = b.chapter ?? Number.POSITIVE_INFINITY;
    if (ca !== cb) return ca - cb;
    return RETURNEE_KIND_ORDER[a.kind] - RETURNEE_KIND_ORDER[b.kind];
  });
}

/**
 * 最終画面に出す「戦績」の表示文。
 *
 * 十章作戦記録の仕様どおり、**撃墜数は戦績にしない**。
 * 読み上げられる名前の数だけがプレイヤーの戦績である（UI実装は T7-6）。
 */
export function returneeScoreLabel(state: NarrativeState): string {
  const count = returneeRollCall(state).length;
  return count === 0 ? '帰還者 0名' : `帰還者 ${count}名`;
}

/**
 * 4状態への増減を適用する下位関数。信頼値は 0..100 でクランプする。
 *
 * 出撃結果からの反映（T4-2）も章末の選択（`applyChoice`）も、最終的にここを通す。
 */
export function adjustNarrative(state: NarrativeState, delta: NarrativeDelta): void {
  if (!delta) return;
  if (delta.returnees) addReturnees(state, delta.returnees);
  if (delta.returneeCredit !== undefined) {
    // 符号付きで積む。「追撃を選んだので帰せなかった」というマイナスを
    // ここで 0 に切り上げると、名簿がまだ空の序盤で減点が消えてしまう。
    // 最終的な指標は `returneeScore()` が 0..100 にクランプする。
    state.returneeCredit = Math.round(numberOr(state.returneeCredit, 0) + numberOr(delta.returneeCredit, 0));
  }
  state.routeTrust = shift(state.routeTrust, delta.routeTrust);
  state.commandTrust = shift(state.commandTrust, delta.commandTrust);
  state.aceOath = shift(state.aceOath, delta.aceOath);
}

function shift(current: number, amount: number | undefined): number {
  const base = clamp(numberOr(current, INITIAL_TRUST), MIN_TRUST, MAX_TRUST);
  if (amount === undefined) return base;
  return clamp(base + numberOr(amount, 0), MIN_TRUST, MAX_TRUST);
}

// ───────── 表示用 ─────────

/** 状態の段階ラベル（5段階） */
export type NarrativeGrade = '最低' | '低' | '中' | '高' | '最高';

export interface NarrativeGauge {
  /** 表示名 */
  label: string;
  /** 0..100 */
  value: number;
  /** 段階ラベル */
  grade: NarrativeGrade;
}

export interface NarrativeSummary {
  /** 帰還者。人数と、名簿（読み上げ順） */
  returnees: { label: string; count: number; names: string[]; grade: NarrativeGrade; value: number };
  routeTrust: NarrativeGauge;
  commandTrust: NarrativeGauge;
  aceOath: NarrativeGauge;
}

/**
 * 段階ラベル。
 * 0-24 = 最低 / 25-44 = 低 / 45-59 = 中 / 60-79 = 高 / 80-100 = 最高
 */
export function narrativeGrade(value: number): NarrativeGrade {
  const v = clamp(numberOr(value, 0), MIN_TRUST, MAX_TRUST);
  if (v < 25) return '最低';
  if (v < 45) return '低';
  if (v < 60) return '中';
  if (v < 80) return '高';
  return '最高';
}

/**
 * 帰還者名簿を 0..100 の指標へ写す。
 * 10人で満点。名簿は積み上がる一方なので、上限で飽和させる。
 */
export function returneeScore(state: NarrativeState): number {
  // 名簿に載った人数 + 符号付きのクレジットを、他3状態と同じ 0..100 の尺度へ写す。
  // クレジットが負でも名簿の人数は減らないので、下限は 0 でクランプする。
  const heads = state.returnees.length + numberOr(state.returneeCredit, 0);
  return clamp(heads * 10, MIN_TRUST, MAX_TRUST);
}

/**
 * 第8章で残した回線数を記録する。0..3 にクランプする。
 *
 * 「1基でも残れば承認は成立するが、残した本数だけ次章が濃くなる」ので、
 * 成否ではなく本数そのものを持つ。
 */
export function recordRelaysHeld(state: NarrativeState, held: number): void {
  state.relaysHeld = clamp(Math.round(numberOr(held, 0)), 0, MAX_RELAYS);
}

/** 残した回線数。第8章に到達していなければ undefined */
export function relaysHeld(state: NarrativeState): number | undefined {
  return state.relaysHeld === undefined ? undefined : clamp(state.relaysHeld, 0, MAX_RELAYS);
}

/** UI 表示用に各状態の値と段階ラベルを返す */
export function narrativeSummary(state: NarrativeState): NarrativeSummary {
  const score = returneeScore(state);
  return {
    returnees: {
      label: '帰還者',
      count: state.returnees.length,
      names: [...state.returnees],
      value: score,
      grade: narrativeGrade(score),
    },
    routeTrust: gauge('航路信頼', state.routeTrust),
    commandTrust: gauge('軍令信用', state.commandTrust),
    aceOath: gauge('敵エースの誓約', state.aceOath),
  };
}

function gauge(label: string, value: number): NarrativeGauge {
  const v = clamp(numberOr(value, 0), MIN_TRUST, MAX_TRUST);
  return { label, value: v, grade: narrativeGrade(v) };
}

// ───────── 派生値（次章の援護内容） ─────────

/** キルラシー側の協力段階 */
export type KilrashiSupport = 'none' | 'ceasefire' | 'joint';

/**
 * 4状態から決まる次章の援護内容。
 *
 * **ここで返す値は難易度ではない。** 敵の強さ・数・命中補正は一切含めない。
 * 含めるのは「誰が一緒に飛ぶか」「何を持って行けるか」「誰が撃ってこないか」だけ。
 */
export interface SupportLevel {
  /** 出撃できる僚機数 0..2（帰還者名簿から） */
  wingmanSlots: number;
  /** セレシオンの護衛船が付くか（航路信頼から） */
  serecionEscort: boolean;
  /** オルドの重力固定支援が受けられるか（航路信頼から） */
  ordoGravityLock: boolean;
  /** 搭載兵装の上限倍率 0.6..1.2（軍令信用から） */
  missileBudget: number;
  /** キルラシー側の協力条件（敵エースの誓約から） */
  kilrashiSupport: KilrashiSupport;
  /** 司令部の無線の温度（軍令信用から）。台詞の選択にのみ使う */
  commandRadioTone: 'cold' | 'formal' | 'warm';
}

/**
 * 次章の援護内容を決める。
 *
 * しきい値:
 * - 僚機数 : 帰還者指標 >= 60 で 2機 / >= 30 で 1機 / それ未満は単機
 * - 護衛船 : 航路信頼 >= 60、重力固定 : 航路信頼 >= 80
 * - 搭載倍率: 0.6 + 軍令信用/100 * 0.6（50 でちょうど 0.9）
 * - キルラシー: 誓約 >= 75 で共同作戦 / >= 40 で停戦 / それ未満は協力なし
 */
export function supportLevel(state: NarrativeState): SupportLevel {
  const score = returneeScore(state);
  const routeTrust = clamp(numberOr(state.routeTrust, 0), MIN_TRUST, MAX_TRUST);
  const commandTrust = clamp(numberOr(state.commandTrust, 0), MIN_TRUST, MAX_TRUST);
  const aceOath = clamp(numberOr(state.aceOath, 0), MIN_TRUST, MAX_TRUST);
  return {
    wingmanSlots: score >= 60 ? 2 : score >= 30 ? 1 : 0,
    serecionEscort: routeTrust >= 60,
    ordoGravityLock: routeTrust >= 80,
    // 端数が搭載数計算で揺れないよう、小数第2位で丸める。
    missileBudget: Math.round((0.6 + (commandTrust / 100) * 0.6) * 100) / 100,
    kilrashiSupport: aceOath >= 75 ? 'joint' : aceOath >= 40 ? 'ceasefire' : 'none',
    commandRadioTone: commandTrust >= 70 ? 'warm' : commandTrust >= 35 ? 'formal' : 'cold',
  };
}

// ───────── 出撃結果 → 4状態（T2-③）─────────

/**
 * 出撃1回の「飛んだ結果」。4状態を動かす一次情報はここだけである。
 *
 * `MissionRunner.summary()` から作れる値だけで構成する（`src/mission/` へは依存しない）。
 * 撃墜数は**含めない**。十章作戦記録 §03 の規約どおり、戦績は「誰を帰したか」で数える。
 */
export interface SortieFacts {
  /** rescue 目標で回収した対象の数（味方・民間） */
  rescued: number;
  /** 敵陣営の脱出ポッド・被弾艦を回収した数 */
  enemyRescued: number;
  /** 生存させた護衛対象・輸送船の数 */
  escortSurvivors: number;
  /** 出現した護衛対象・輸送船の総数（0 なら護衛対象のない出撃） */
  escortTotal: number;
  /** 生還した僚機の数（名前付きで名簿に載る分） */
  wingmenSurvived: number;
  /** 戦死した僚機の数 */
  wingmenLost: number;
  /** 失った中立・非敵対勢力の艦船数（民間損害） */
  civilianLosses: number;
  /** 自機の射撃が味方・非敵対に命中した回数（誤射） */
  friendlyFireHits: number;
  /** 自機が撃った弾の数 */
  shotsFired: number;
  /** 自機を失ったか（撃墜・脱出） */
  playerLost: boolean;
  /** 未達成に終わった目標の数 */
  objectivesFailed: number;
  /** 達成度の3段階（`MissionGrade` と同じ語） */
  grade: 'complete' | 'partial' | 'failed';
}

/** 4状態の並び順（デブリーフの表示順）。 */
export type NarrativeKey = 'returnees' | 'routeTrust' | 'commandTrust' | 'aceOath';

export const NARRATIVE_LABEL: Record<NarrativeKey, string> = {
  returnees: '帰還者',
  routeTrust: '航路信頼',
  commandTrust: '軍令信用',
  aceOath: '敵エースの誓約',
};

/** 増減1件の理由。「なぜ動いたか」を読ませるために必ず添える。 */
export interface NarrativeReason {
  /** 例 '救助3名' 'Sable 戦死' */
  text: string;
  /** その理由が動かした量（符号つき） */
  delta: number;
}

/** 1状態あたりの内訳。プラス側とマイナス側を分けて持つ（合計だけにしない）。 */
export interface NarrativeLine {
  key: NarrativeKey;
  label: string;
  /** 合計（プラス側 + マイナス側、クランプ後） */
  delta: number;
  gains: NarrativeReason[];
  losses: NarrativeReason[];
}

export interface SortieNarrativeResult {
  /**
   * `adjustNarrative` へそのまま渡せる増減。
   *
   * **注意**: 生還した僚機は「名前」として名簿へ載る（`addReturneeEntries`）ため、
   * `returneeCredit` には含めない。二重計上を避けるためで、
   * 表示用の `lines` には僚機の生還も理由として並ぶ。
   */
  delta: NarrativeDelta;
  /** デブリーフに1行ずつ出す内訳 */
  lines: NarrativeLine[];
  /**
   * `delta.returneeCredit` から差し引いてある「名前で名簿に載る人数」。
   *
   * 呼び出し側は名簿へ追加した実数を数え、載らなかった分（同名で重複した等）を
   * クレジットとして埋め戻す。これをしないと表示した合計と指標がずれる。
   */
  namedHeads: number;
}

/**
 * 1回の出撃で4状態が動く上限。
 *
 * **章末の選択（1択あたり総量 8・1状態あたり最大 5）より必ず大きく取る。**
 * 「プレイの結果より選択が重い」状態を作らないための、この機能の中心の値である。
 */
export const SORTIE_TRUST_CAP = 12;
/** 帰還者（人数）の1出撃あたりの上限。指標では ±60 に相当する */
export const SORTIE_HEAD_CAP = 6;

const GRADE_TEXT: Record<SortieFacts['grade'], string> = {
  complete: '任務達成',
  partial: '部分達成',
  failed: '任務失敗',
};
const GRADE_COMMAND_DELTA: Record<SortieFacts['grade'], number> = {
  complete: 8,
  partial: 3,
  failed: -6,
};

/** 内訳を組み立てるための小さな入れ物 */
class LineBuilder {
  readonly gains: NarrativeReason[] = [];
  readonly losses: NarrativeReason[] = [];

  add(delta: number, text: string): void {
    if (!Number.isFinite(delta) || delta === 0) return;
    (delta > 0 ? this.gains : this.losses).push({ text, delta });
  }

  /** クランプ後の合計 */
  total(cap: number): number {
    const sum = [...this.gains, ...this.losses].reduce((a, r) => a + r.delta, 0);
    return clamp(sum, -cap, cap);
  }

  build(key: NarrativeKey, cap: number): NarrativeLine | undefined {
    if (this.gains.length === 0 && this.losses.length === 0) return undefined;
    return { key, label: NARRATIVE_LABEL[key], delta: this.total(cap), gains: this.gains, losses: this.losses };
  }
}

/**
 * 出撃結果を4状態の増減へ写す（T2-③）。
 *
 * 配分の考え方:
 * - **飛んだ結果が主役**。1状態あたり最大 ±12（帰還者は ±6 名 = 指標 ±60）まで動く。
 * - **章末の選択は方針の表明**。1択あたり総量 8・1状態あたり最大 5 に抑えている
 *   （`src/content/veil/chapters.ts`）。同じ状態で比べて 12 対 5 になるので、
 *   「選択だけで最低から最高へ飛ぶ」ことは起こらない。
 * - **難易度は一切動かさない**。ここで返すのは4状態だけで、敵の強さ・数・命中には触れない。
 */
export function sortieNarrative(facts: SortieFacts): SortieNarrativeResult {
  const f = normalizeFacts(facts);

  // ── 帰還者（人数）──
  const heads = new LineBuilder();
  if (f.rescued > 0) heads.add(f.rescued, `救助 ${f.rescued}名`);
  if (f.enemyRescued > 0) heads.add(f.enemyRescued, `敵側の救難 ${f.enemyRescued}名`);
  if (f.escortSurvivors > 0) heads.add(f.escortSurvivors, `護衛対象 ${f.escortSurvivors}隻を生存`);
  if (f.wingmenSurvived > 0) heads.add(f.wingmenSurvived, `僚機 ${f.wingmenSurvived}名が生還`);
  if (f.wingmenLost > 0) heads.add(-f.wingmenLost, `僚機 ${f.wingmenLost}名が戦死`);
  if (f.civilianLosses > 0) heads.add(-f.civilianLosses, `民間 ${f.civilianLosses}隻を喪失`);
  if (f.escortTotal > f.escortSurvivors) {
    heads.add(-(f.escortTotal - f.escortSurvivors), `護衛対象 ${f.escortTotal - f.escortSurvivors}隻を喪失`);
  }
  if (f.playerLost) heads.add(-1, '自機喪失（自分が帰れなかった）');

  // ── 航路信頼（中立規約の順守と民間損害）──
  const route = new LineBuilder();
  if (f.civilianLosses > 0) route.add(-Math.min(12, f.civilianLosses * 4), `民間損害 ${f.civilianLosses}隻`);
  if (f.friendlyFireHits > 0) route.add(-Math.min(8, f.friendlyFireHits * 2), `誤射 ${f.friendlyFireHits}発`);
  if (f.escortTotal > 0 && f.escortSurvivors === f.escortTotal) {
    route.add(3, `護衛対象 ${f.escortTotal}隻すべて生存`);
  }
  if (f.escortTotal > f.escortSurvivors) {
    route.add(-Math.min(9, (f.escortTotal - f.escortSurvivors) * 3), '護衛対象の喪失');
  }
  // 「損なわなかった」加点は、護衛対象を失った出撃には出さない
  // （輸送船を失っても誤射がなければ航路信頼が上がる、という読み違いを防ぐ）
  if (f.friendlyFireHits === 0 && f.civilianLosses === 0 && f.escortSurvivors >= f.escortTotal) {
    route.add(4, '誤射・民間損害なし');
  }
  if (f.shotsFired === 0) route.add(4, '一発も撃たずに完了');

  // ── 軍令信用（命令順守と損害の最小化）──
  const command = new LineBuilder();
  command.add(GRADE_COMMAND_DELTA[f.grade], GRADE_TEXT[f.grade]);
  if (f.objectivesFailed > 0) command.add(-Math.min(6, f.objectivesFailed * 2), `未達成の条件 ${f.objectivesFailed}件`);
  if (f.wingmenLost > 0) command.add(-Math.min(8, f.wingmenLost * 4), `僚機 ${f.wingmenLost}名を失った`);
  if (f.playerLost) command.add(-5, '機体喪失');

  // ── 敵エースの誓約（救難優先と誤射）──
  const oath = new LineBuilder();
  if (f.enemyRescued > 0) oath.add(Math.min(10, f.enemyRescued * 5), `敵側の救難 ${f.enemyRescued}件`);
  if (f.rescued > 0) oath.add(2, '救難を優先した');
  if (f.friendlyFireHits > 0) oath.add(-Math.min(6, f.friendlyFireHits * 2), `誤射 ${f.friendlyFireHits}発`);

  const lines: NarrativeLine[] = [];
  for (const [key, builder, cap] of [
    ['returnees', heads, SORTIE_HEAD_CAP],
    ['routeTrust', route, SORTIE_TRUST_CAP],
    ['commandTrust', command, SORTIE_TRUST_CAP],
    ['aceOath', oath, SORTIE_TRUST_CAP],
  ] as Array<[NarrativeKey, LineBuilder, number]>) {
    const line = builder.build(key, cap);
    if (line) lines.push(line);
  }

  // 生還した僚機は名前で名簿に載る（= 名簿の人数として1名分の指標になる）ので、
  // クレジット（名前のない人数）からは差し引く。名簿へ実際に何名載ったかは
  // 呼び出し側しか知らないため、載らなかった分は `namedHeads` を見て埋め戻す。
  const headTotal = heads.total(SORTIE_HEAD_CAP);
  const credit = headTotal - f.wingmenSurvived;
  const delta: NarrativeDelta = {
    routeTrust: route.total(SORTIE_TRUST_CAP),
    commandTrust: command.total(SORTIE_TRUST_CAP),
    aceOath: oath.total(SORTIE_TRUST_CAP),
  };
  if (credit !== 0) delta.returneeCredit = credit;
  return { delta, lines, namedHeads: f.wingmenSurvived };
}

function normalizeFacts(raw: SortieFacts): SortieFacts {
  const count = (v: unknown) => Math.max(0, Math.round(numberOr(v, 0)));
  const escortTotal = count(raw?.escortTotal);
  return {
    rescued: count(raw?.rescued),
    enemyRescued: count(raw?.enemyRescued),
    escortTotal,
    escortSurvivors: Math.min(escortTotal, count(raw?.escortSurvivors)),
    wingmenSurvived: count(raw?.wingmenSurvived),
    wingmenLost: count(raw?.wingmenLost),
    civilianLosses: count(raw?.civilianLosses),
    friendlyFireHits: count(raw?.friendlyFireHits),
    shotsFired: count(raw?.shotsFired),
    playerLost: !!raw?.playerLost,
    objectivesFailed: count(raw?.objectivesFailed),
    grade: raw?.grade === 'complete' || raw?.grade === 'partial' ? raw.grade : 'failed',
  };
}

// ───────── 共通ヘルパ（roster.ts / frontline.ts と同じ流儀）─────────

function numberOr(v: unknown, d: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}
