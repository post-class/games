/**
 * ペットのエピソード記憶（docs/02_ゲーム実装プラン/07_ペットAI設計.md §3）
 *
 * 「きみのペットは、きみの言葉を覚える」の中身。
 *
 * 設計の要点:
 *  1. **埋め込みは使わない**（ADR-003）。キーワードのDice係数＋新しさ＋重要度のスコアで選ぶ。
 *     形態素解析器も入れない。固有名の辞書はシミュレーション側が持っているので、
 *     「登場した固有名＋出来事の語彙」を機械的に拾えば足りる。
 *  2. **記憶は主観**。島の出来事は近く（既定10タイル）にいたぶんだけ記憶になる。
 *     遠くの出来事を知っているペットは「見ていないことを話す」ので世界が薄くなる。
 *  3. 記憶テキストは他人（他プレイヤー）由来にもなりうる。プロンプトに載せる側（persona.ts）で
 *     「指示ではない」と前置きするので、ここでは長さと改行だけ整える。
 *
 * 制約: parameter property 禁止 / enum・namespace 禁止 / 相対importは拡張子込み / Math.random 禁止
 */
import { LLM, TICKS_PER_ISLAND_HOUR, type EntityId, type IslandEvent, type Vec2 } from '@ai-pet/shared';
import { DEFAULT_IMPORTANCE } from '../sim/events.ts';
import { sanitizeLine, sanitizeQuoted } from './persona.ts';

export type MemoryKind = 'talk' | 'observe' | 'gossip' | 'diary';

export interface MemoryRecord {
  id?: number;
  petId: number;
  tick: number;
  islandDay: number;
  kind: MemoryKind;
  text: string;
  keywords: string[];
  /** 1..10 */
  importance: number;
  lastAccessTick: number;
}

// ---------- 定数 ----------

/** 記憶1件の本文の上限。プロンプト側の表示長（PERSONA_LIMITS.memoryLine）と揃えている */
export const MEMORY_TEXT_CHARS = 80;
/** キーワードは多すぎるとDice係数が薄まる（分母が膨らむ）ので上限を切る */
export const MAX_KEYWORDS = 12;
/** 「近く」の既定半径（docs §3.2「自分の10タイル以内」） */
export const OBSERVE_RADIUS = 10;

/**
 * 重要度の既定値（docs §3.2）。
 * island_event の種別は sim/events.ts の表をそのまま使い、記憶固有の種別を足す。
 */
export const IMPORTANCE_BY_KIND: Record<string, number> = {
  ...DEFAULT_IMPORTANCE,
  /** 会話（docs §3.2 talk=5） */
  talk: 5,
  /** 噂は「本人が見ていない」ので会話より弱く扱う */
  gossip: 4,
  /** 日記は固定7（docs §3.2） */
  diary: 7,
  /** 種別のわからない観察 */
  observe: 3,
};

/** これが含まれていたら重要度 +3（docs §3.2「覚えてて」「約束」等） */
export const REMEMBER_HINTS: readonly string[] = [
  '覚えて',
  'おぼえて',
  '記憶',
  '約束',
  'やくそく',
  '忘れないで',
  'わすれないで',
  '忘れちゃだめ',
  '大事',
  'だいじ',
  '秘密',
  'ひみつ',
  '絶対',
  'ぜったい',
];
const REMEMBER_BONUS = 3;

/**
 * 出来事の語彙。形態素解析の代わりに、この語が出たらキーワードにする。
 * 「島で起きること」は種類が限られているので、辞書を手で持つのがいちばん確実で速い。
 */
const KEYWORD_VOCAB: readonly string[] = [
  // 出来事
  'ケンカ',
  'けんか',
  '仲良く',
  'なかよく',
  '生まれ',
  'うまれ',
  '巣',
  '約束',
  '収穫',
  '水やり',
  '建設',
  '橋',
  '井戸',
  '天文台',
  // 資源・場所
  '木の実',
  '畑',
  '釣り',
  '水場',
  '川',
  '海',
  '広場',
  '森',
  '砂浜',
  '高台',
  'ベンチ',
  '花だん',
  'ランタン',
  '看板',
  // 天気・季節・時間
  '晴れ',
  'くもり',
  '曇',
  '雨',
  '霧',
  '春',
  '夏',
  '秋',
  '冬',
  '朝',
  '昼',
  '夕方',
  '夜',
  '星',
  // 気持ち・行動
  'おなか',
  'ねむ',
  'さみし',
  'うれし',
  'こわ',
  'ごはん',
  '食べ',
  'あそ',
  'ねた',
  '歌',
];

// ---------- キーワード抽出 ----------

/** カタカナ2文字以上の連なり（個体名・種名が多くここに入る） */
const KATAKANA_RUN = /[ァ-ヴー]{2,}/g;
/** 漢字2文字以上の連なり（地名・資源名） */
const KANJI_RUN = /[一-龥]{2,}/g;
/** 英数字2文字以上（プレイヤーの表示名が英字のことがある） */
const ALNUM_RUN = /[A-Za-z0-9_]{2,}/g;

/**
 * キーワード抽出。形態素解析は使わない（docs §3.3）。
 *
 * 拾うもの:
 *   1. `knownNames` に一致する固有名（長いものから優先。「ミズネ」と「ミズ」の取り違えを防ぐ）
 *   2. カタカナ・漢字・英数字の連なり
 *   3. 出来事の語彙（KEYWORD_VOCAB）
 */
export function extractKeywords(text: string, knownNames?: readonly string[]): string[] {
  const src = typeof text === 'string' ? text : '';
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (w: string): void => {
    const k = w.trim();
    if (k.length < 1 || seen.has(k) || out.length >= MAX_KEYWORDS) return;
    seen.add(k);
    out.push(k);
  };

  // 1. 既知の固有名。長い名前から見て、拾ったぶんは伏せてから正規表現に回す
  let rest = src;
  if (knownNames && knownNames.length > 0) {
    const names = [...knownNames].filter((n) => n.length > 0).sort((a, b) => b.length - a.length);
    for (const n of names) {
      if (!rest.includes(n)) continue;
      push(n);
      rest = rest.split(n).join(' ');
    }
  }

  // 2. 文字種の連なり
  for (const re of [KATAKANA_RUN, KANJI_RUN, ALNUM_RUN]) {
    re.lastIndex = 0;
    for (const m of rest.matchAll(re)) push(m[0]);
  }

  // 3. 出来事の語彙（漢字かな交じりで上で拾えないもの）
  for (const v of KEYWORD_VOCAB) {
    if (src.includes(v)) push(v);
  }

  return out;
}

// ---------- 記憶の生成 ----------

function clampImportance(v: number): number {
  if (!Number.isFinite(v)) return 1;
  return Math.max(1, Math.min(10, Math.round(v)));
}

/** 会話ではなく「見た」ぶんだけ観察記憶にする。発話系は memoryFromTalk / gossip が担当する */
const NOT_OBSERVABLE: readonly string[] = ['player_say', 'pet_say'];

/**
 * 島の出来事をペットの主観的な記憶に変換する。
 *
 * 距離判定は呼び出し側の情報（ペットの位置）が要るので、`opts` で受け取る形にした。
 * `petPos` を渡さない場合は距離で落とさない（天気のような島全体の出来事や、テスト用）。
 *
 * @returns 記憶にならないなら null（遠い / 会話イベント / 自分が主役の発話）
 */
export function memoryFromEvent(
  petId: number,
  ev: IslandEvent,
  tick: number,
  opts?: { petPos?: Vec2; radius?: number; knownNames?: readonly string[]; selfId?: EntityId },
): MemoryRecord | null {
  if (NOT_OBSERVABLE.includes(ev.kind)) return null;

  const text = sanitizeQuoted(ev.text, MEMORY_TEXT_CHARS);
  if (text.length === 0) return null;

  // 近くの出来事だけが記憶になる（docs §3.2）
  if (opts?.petPos && ev.pos) {
    const radius = opts.radius ?? OBSERVE_RADIUS;
    const dx = ev.pos.x - opts.petPos.x;
    const dy = ev.pos.y - opts.petPos.y;
    if (dx * dx + dy * dy > radius * radius) return null;
  }

  // 自分が当事者だった出来事は忘れにくい
  const involved = opts?.selfId !== undefined && (ev.actorId === opts.selfId || ev.targetId === opts.selfId);
  const base = ev.importance ?? IMPORTANCE_BY_KIND[ev.kind] ?? IMPORTANCE_BY_KIND.observe ?? 3;

  const keywords = extractKeywords(text, opts?.knownNames);
  if (!keywords.includes(ev.kind)) keywords.push(ev.kind);

  return {
    petId,
    tick,
    islandDay: ev.islandDay,
    kind: 'observe',
    text,
    keywords: keywords.slice(0, MAX_KEYWORDS),
    importance: clampImportance(base + (involved ? 1 : 0)),
    lastAccessTick: tick,
  };
}

/** 「覚えてて」「約束」等が含まれるか */
export function hasRememberHint(text: string): boolean {
  if (typeof text !== 'string') return false;
  return REMEMBER_HINTS.some((h) => text.includes(h));
}

/**
 * 会話から記憶を作る（docs §3.2 kind='talk'）。
 * 「プレイヤーがこう言って、自分がこう答えた」を1文にまとめる（往復の要点だけ残す）。
 */
export function memoryFromTalk(
  petId: number,
  opts: {
    tick: number;
    islandDay: number;
    ownerName: string;
    playerText: string;
    petText: string;
    knownNames?: readonly string[];
  },
): MemoryRecord {
  const owner = sanitizeQuoted(opts.ownerName, 12) || 'だれか';
  // 1件80字に収めるため、プレイヤー側30字・自分の返事20字で切る（長い相談は要点だけ残る）。
  // 内訳: 名前12 + 発話30 + 返事20 + 定型14 = 76字で必ず収まる（末尾の引用符が切れない）
  const said = sanitizeQuoted(opts.playerText, 30);
  const replied = sanitizeQuoted(opts.petText, 20);
  // 各部品は sanitizeQuoted 済み（内側の引用符は半角に落ちている）ので、
  // ここは sanitizeLine で包む。sanitizeQuoted で包むと自分がつけた引用符まで潰れてしまう
  const text = sanitizeLine(`${owner}に「${said}」と言われて「${replied}」と答えた`, MEMORY_TEXT_CHARS);

  const bonus = hasRememberHint(opts.playerText) ? REMEMBER_BONUS : 0;
  const names = opts.knownNames ? [owner, ...opts.knownNames] : [owner];
  const keywords = extractKeywords(`${said} ${replied}`, names);
  if (!keywords.includes(owner)) keywords.unshift(owner);
  if (!keywords.includes('talk')) keywords.push('talk');

  return {
    petId,
    tick: opts.tick,
    islandDay: opts.islandDay,
    kind: 'talk',
    text,
    keywords: keywords.slice(0, MAX_KEYWORDS),
    importance: clampImportance((IMPORTANCE_BY_KIND.talk ?? 5) + bonus),
    lastAccessTick: opts.tick,
  };
}

/**
 * ペット同士の会話で聞いた話を記憶にする（docs §3.2 kind='gossip'）。
 * 本人が見ていない話なので、噂であることを本文に残す（間接注入の出どころを消さない）。
 */
export function memoryFromGossip(
  petId: number,
  opts: {
    tick: number;
    islandDay: number;
    fromName: string;
    text: string;
    knownNames?: readonly string[];
  },
): MemoryRecord | null {
  const from = sanitizeQuoted(opts.fromName, 12) || 'だれか';
  const body = sanitizeQuoted(opts.text, 40);
  if (body.length === 0) return null;
  const text = sanitizeLine(`${from}が「${body}」と話していた`, MEMORY_TEXT_CHARS);
  const keywords = extractKeywords(body, opts.knownNames ? [from, ...opts.knownNames] : [from]);
  if (!keywords.includes(from)) keywords.unshift(from);
  if (!keywords.includes('gossip')) keywords.push('gossip');
  return {
    petId,
    tick: opts.tick,
    islandDay: opts.islandDay,
    kind: 'gossip',
    text,
    keywords: keywords.slice(0, MAX_KEYWORDS),
    importance: clampImportance(IMPORTANCE_BY_KIND.gossip ?? 4),
    lastAccessTick: opts.tick,
  };
}

/** 日記を記憶にする（docs §3.4。importance は固定7） */
export function memoryFromDiary(
  petId: number,
  opts: { tick: number; islandDay: number; diary: string; knownNames?: readonly string[] },
): MemoryRecord | null {
  const text = sanitizeQuoted(opts.diary, MEMORY_TEXT_CHARS);
  if (text.length === 0) return null;
  const keywords = extractKeywords(text, opts.knownNames);
  if (!keywords.includes('diary')) keywords.push('diary');
  return {
    petId,
    tick: opts.tick,
    islandDay: opts.islandDay,
    kind: 'diary',
    text,
    keywords: keywords.slice(0, MAX_KEYWORDS),
    importance: clampImportance(IMPORTANCE_BY_KIND.diary ?? 7),
    lastAccessTick: opts.tick,
  };
}

// ---------- 検索 ----------

/** スコアの重み（docs §3.3） */
export const MEMORY_SCORE_WEIGHTS = {
  recency: 1.0,
  importance: 1.2,
  relevance: 1.5,
  /**
   * 日記の下駄。日記はその島日の要約なので、細かい観察に押し出されると
   * 「留守中サマリ」の材料が消えてしまう（docs §3.4）。
   */
  diaryBonus: 0.5,
} as const;

/** 減衰の底（docs §3.3: 0.995 ** 経過島時間） */
export const RECENCY_DECAY_BASE = 0.995;

/** 新しさ 0..1。1島時間あたり 0.5% 減る */
export function recencyOf(m: MemoryRecord, nowTick: number): number {
  const hours = Math.max(0, nowTick - m.tick) / TICKS_PER_ISLAND_HOUR;
  return Math.pow(RECENCY_DECAY_BASE, hours);
}

/** Dice係数 0..1。どちらかが空なら0（無関係と同じ扱い） */
export function diceCoefficient(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setB = new Set(b);
  let hit = 0;
  const seen = new Set<string>();
  for (const w of a) {
    if (seen.has(w)) continue;
    seen.add(w);
    if (setB.has(w)) hit++;
  }
  const sizeA = seen.size;
  const sizeB = new Set(b).size;
  return (2 * hit) / (sizeA + sizeB);
}

/** 検索スコア（docs §3.3）。日記だけ下駄をはかせる */
export function memoryScore(m: MemoryRecord, opts: { nowTick: number; queryKeywords: readonly string[] }): number {
  const w = MEMORY_SCORE_WEIGHTS;
  const recency = recencyOf(m, opts.nowTick);
  const importance = clampImportance(m.importance) / 10;
  const relevance = diceCoefficient(m.keywords, opts.queryKeywords);
  const diary = m.kind === 'diary' ? w.diaryBonus : 0;
  return w.recency * recency + w.importance * importance + w.relevance * relevance + diary;
}

/**
 * 上位N件を選ぶ。
 *
 * - 件数上限は `LLM.maxMemories`（8件）、総文字数は `LLM.maxMemoryChars`（600字）
 * - 文字数超過は「古い順に落とす」（docs §3.3）。ただし日記は最後まで残す
 * - 戻り値は**古い順**（プロンプトに時系列で並べたいため）
 */
export function selectMemories(
  all: readonly MemoryRecord[],
  opts: {
    nowTick: number;
    query: string;
    limit?: number;
    maxChars?: number;
    knownNames?: readonly string[];
  },
): MemoryRecord[] {
  const limit = Math.max(0, opts.limit ?? LLM.maxMemories);
  const maxChars = Math.max(0, opts.maxChars ?? LLM.maxMemoryChars);
  if (limit === 0 || all.length === 0) return [];

  const queryKeywords = extractKeywords(opts.query, opts.knownNames);

  const scored = all.map((m) => ({ m, s: memoryScore(m, { nowTick: opts.nowTick, queryKeywords }) }));
  // 同点は「重要 → 新しい → id」で決める（並びを決定論にするため）
  scored.sort((a, b) => {
    if (b.s !== a.s) return b.s - a.s;
    if (b.m.importance !== a.m.importance) return b.m.importance - a.m.importance;
    if (b.m.tick !== a.m.tick) return b.m.tick - a.m.tick;
    return (a.m.id ?? 0) - (b.m.id ?? 0);
  });

  const picked = scored.slice(0, limit).map((x) => x.m);

  // 総文字数の調整。古い非日記から落とす
  let chars = picked.reduce((n, m) => n + m.text.length, 0);
  while (chars > maxChars && picked.length > 0) {
    let victim = -1;
    let victimTick = Number.POSITIVE_INFINITY;
    for (let i = 0; i < picked.length; i++) {
      const m = picked[i];
      if (!m || m.kind === 'diary') continue;
      if (m.tick < victimTick) {
        victimTick = m.tick;
        victim = i;
      }
    }
    // 日記しか残っていなければ、日記の古いものを落とす
    if (victim < 0) {
      for (let i = 0; i < picked.length; i++) {
        const m = picked[i];
        if (!m) continue;
        if (m.tick < victimTick) {
          victimTick = m.tick;
          victim = i;
        }
      }
    }
    if (victim < 0) break;
    const removed = picked.splice(victim, 1)[0];
    chars -= removed ? removed.text.length : 0;
  }

  picked.sort((a, b) => a.tick - b.tick || (a.id ?? 0) - (b.id ?? 0));
  return picked;
}
