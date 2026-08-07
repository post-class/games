/**
 * ペットの日記（記憶の圧縮）と留守中サマリ（docs/02_ゲーム実装プラン/07_ペットAI設計.md §3.4 / 06章 §5）
 *
 * 宣伝資料の「ログインすると、留守中に何が起きたかをペットが日記みたいに教えてくれる」を成立させる部分。
 *
 * 設計の要点:
 *  1. **日記はLLM・留守中サマリはLLMなし**。日記は島日の終わりに1回だけ（20秒待てる）だが、
 *     留守中サマリはログイン直後に即出したいので、**すでに書かれた日記を並べるだけ**にする。
 *     ここでLLMを呼ぶと「ログインして最初に見る画面」が数秒空白になり、体験がいちばん悪くなる。
 *  2. **例外を投げない**。LLMが落ちていても「その日の最重要イベント3件を機械的に連結した日記」が出る。
 *     日記が出ないと翌日の会話に「きのう」が無くなるので、空にするより機械的でも残す方がよい。
 *  3. **フォールバック時に既存の長期記憶を壊さない**。`summary` は前のものを**先頭に残したまま**
 *     日記1文を足して400字で切る（`mergeSummary`）。LLMが失敗した日に記憶が消えるのは最悪の壊れ方。
 *  4. **同じペットで二重に走らせない**。島日境界の判定は呼び出し側にあり、tickの取りこぼしや
 *     早送りで2回呼ばれることがある。走っている promise を共有し、書き終えた島日は再生成しない。
 *
 * 制約: parameter property 禁止 / enum・namespace 禁止 / 相対importは拡張子込み / Math.random 禁止
 */
import { LLM, type PetSpecies } from '@ai-pet/shared';
import type { LlmClient } from '../llm/client.ts';
import type { PetRepo } from '../db/petRepo.ts';
import type { IslandEventRecord, Repo } from '../db/repo.ts';
import type { WorldClock } from '../sim/clock.ts';
import { buildDiaryPrompt, sanitizeLine, sanitizeQuoted, sanitizeSummary } from './persona.ts';
import { memoryFromDiary, type MemoryRecord } from './memory.ts';
import { DiarySchema, parseDiary } from './schema.ts';

// ---------- 公開する型 ----------

export interface DiaryResult {
  petId: number;
  islandDay: number;
  /** 1〜3文の日記 */
  diary: string;
  /** 更新後の長期記憶（400字以内） */
  summary: string;
  /** 懐き度の変化（-3..+3） */
  moodDelta: number;
  fallback: boolean;
  errorKind?: string;
}

export interface AwaySummary {
  /** 3〜5行。プレイヤーに見せる文 */
  lines: string[];
  islandDaysPassed: number;
  /** 材料が無くて汎用文になった場合 true */
  generic: boolean;
}

// ---------- 定数 ----------

/** 日記の材料にする記憶の件数（docs §3.4「importance上位12件」） */
export const DIARY_MEMORY_LIMIT = 12;
/** 日記の本文の上限。DiarySchema の maxLength と揃えている */
export const DIARY_MAX_CHARS = 120;
/** 日記の出力トークン上限（概算300tokens＋余裕） */
const DIARY_MAX_TOKENS = 500;
/** フォールバックで機械的に連結するイベント数（docs §6「最重要イベント3件」） */
const FALLBACK_EVENT_COUNT = 3;

/** 留守中サマリの行数（docs 06章 §5「3〜5行」） */
export const AWAY_MIN_LINES = 3;
export const AWAY_MAX_LINES = 5;
/** 1行の上限。40〜60字に収める（スマホで2行に折り返す程度） */
export const AWAY_LINE_CHARS = 60;
/** 留守中サマリに載せる日記の件数 */
const AWAY_DIARY_COUNT = 3;
/** 島の出来事はこの重要度以上だけを拾う（born/died=8, quarrel/befriend=6） */
const AWAY_EVENT_MIN_IMPORTANCE = 6;
const AWAY_EVENT_FETCH = 20;

/** 記憶の剪定で残す島日数。これより古い「重要でない」記憶は捨てる（日記は残る） */
export const MEMORY_KEEP_ISLAND_DAYS = 7;
/** この重要度以上は剪定しない（`pruneMemories` の既定と同じ7＝日記と同格の記憶） */
const MEMORY_KEEP_IMPORTANCE = 7;

/**
 * 記憶が1件も無かった島日の日記。
 * 「何もなかった日」も日記にしておかないと、翌日の会話で前日が抜け落ちる。
 * 種ごとに口調を変えてあるので、静かな日が続いてもペットらしさが残る。
 */
const QUIET_DAY_LINES: Record<PetSpecies, readonly string[]> = {
  mofi: ['きょうはずっとねてたよぉ。しずかな一日だったねぇ。', 'なんにもなかったけど、ひなたがあたたかかったよぉ。'],
  mizune: ['とくに何もなかった。ふうん、こういう日もある。', '静かな日だった。水の音だけ聞いてた。'],
  hakka: ['きょうはおだやかでした。畑を見て回っただけ。', 'なにも起きない日。こういう日がいちばんありがたい。'],
  momona: ['きょうはひまだった！おなかすいたなぁ。', 'なんにもなかったの。だからずっと木の実さがしてた。'],
  hoshira: ['なにもない日でした。空だけが流れていきました。', 'しずかな一日。星の音がよくきこえました。'],
};

/** 留守中サマリの材料が無いときの汎用文（宣伝資料の「日記みたいに教えてくれる」を最低限成立させる） */
const AWAY_GENERIC_LINES: readonly string[] = [
  '島はしずかだったみたい',
  'かわったことは なかったよ',
  'ずっとこのあたりで まってた',
  'みんな げんきにしてたよ',
];

/** 行数が足りないときの埋め草。日記や出来事の「あと」に足す */
const AWAY_FILLER_LINES: readonly string[] = [
  'ほかは いつもどおりだったよ',
  'きみがいないあいだも 島はうごいてた',
  'また いっしょに島をまわろう',
];

// ---------- 小さな道具 ----------

/** 決定論の小さなハッシュ（FNV-1a）。Math.random は使わない */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** 配列から決定論的に1つ選ぶ */
function pick<T>(list: readonly T[], seed: string): T | undefined {
  if (list.length === 0) return undefined;
  return list[fnv1a(seed) % list.length];
}

/** LLMのJSON文字列を安全に読む。壊れていたら null（呼び出し側でフォールバック） */
function safeJson(text: string): unknown {
  const t = text.trim();
  if (t.length === 0) return null;
  try {
    return JSON.parse(t);
  } catch {
    // ```json ... ``` のような囲みが混ざるケースだけは救う（構造化出力でも稀に起きる）
    const start = t.indexOf('{');
    const end = t.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(t.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

/**
 * 長期記憶の合成。**既存を先頭に残す**のが要点。
 *
 * - 既存がすでに上限なら足さない（削るくらいなら足さない方が記憶を守れる）
 * - 末尾で切るので、戻り値は必ず既存の文字列から始まる
 */
export function mergeSummary(prev: string, add: string): string {
  const base = sanitizeSummary(prev);
  const line = sanitizeQuoted(add, DIARY_MAX_CHARS);
  if (line.length === 0) return base;
  if (base.length === 0) return line.slice(0, LLM.maxSummaryChars);
  if (base.length >= LLM.maxSummaryChars) return base;
  return `${base} ${line}`.slice(0, LLM.maxSummaryChars);
}

/** importance の高い順に並べ替える。同点は「古い順（時系列）→ id」で決定論にする */
function byImportanceDesc(a: MemoryRecord, b: MemoryRecord): number {
  if (b.importance !== a.importance) return b.importance - a.importance;
  if (a.tick !== b.tick) return a.tick - b.tick;
  return (a.id ?? 0) - (b.id ?? 0);
}

/** 日記1件を保存するのに必要な最小の情報。PetRow をそのまま渡せる形にしてある */
interface DiaryDraft {
  pet: { id: number; persona: { species: PetSpecies }; summary: string };
  islandDay: number;
  tick: number;
  diary: string;
  summary: string;
  moodDelta: number;
  fallback: boolean;
  errorKind?: string;
}

// ---------- 本体 ----------

export class ReflectionService {
  private llm: LlmClient;
  private petRepo: PetRepo;
  private repo: Repo;
  private clock: WorldClock;

  /** 走っている日記生成。同じペットで二重に走らせないためのガード */
  private inFlight = new Map<number, Promise<DiaryResult>>();

  private counters = {
    diaries: 0,
    fallback: 0,
    quietDays: 0,
    /** 二重呼び出しをガードした回数 */
    deduped: 0,
    away: 0,
    awayGeneric: 0,
    pruned: 0,
    byError: {} as Record<string, number>,
  };

  // 注意: Node の type-stripping で動かすため parameter property は使えない
  constructor(llm: LlmClient, petRepo: PetRepo, repo: Repo, clock: WorldClock) {
    this.llm = llm;
    this.petRepo = petRepo;
    this.repo = repo;
    this.clock = clock;
  }

  /**
   * 島日の終わりに1匹ぶんの日記を書く。
   * 失敗しても例外は投げず、機械的な要約にフォールバックする。
   */
  writeDiary(opts: { petId: number; islandDay: number; tick: number; ownerVisited: boolean }): Promise<DiaryResult> {
    // 走っている生成があればそれを共有する（LLMを2回呼ばない）
    const running = this.inFlight.get(opts.petId);
    if (running) {
      this.counters.deduped++;
      return running;
    }
    const task = this.writeDiaryInner(opts).finally(() => {
      this.inFlight.delete(opts.petId);
    });
    this.inFlight.set(opts.petId, task);
    return task;
  }

  private async writeDiaryInner(opts: {
    petId: number;
    islandDay: number;
    tick: number;
    ownerVisited: boolean;
  }): Promise<DiaryResult> {
    const { petId, islandDay, tick } = opts;

    const pet = this.petRepo.findPetById(petId);
    if (!pet) {
      return this.fail(petId, islandDay, '', '', 'no_pet');
    }

    // すでにこの島日の日記があるなら書き直さない。
    // 判定をDB（pet_memory）でやるのが要点で、こうすると再起動や早送りをまたいでも二重に書かない
    const existingDiary = this.existingDiaryOf(petId, islandDay);
    if (existingDiary) {
      this.counters.deduped++;
      return {
        petId,
        islandDay,
        diary: existingDiary,
        summary: pet.summary,
        moodDelta: 0,
        fallback: false,
        errorKind: 'written',
      };
    }

    // その日の記憶（日記は材料にしない）を importance 上位12件だけ渡す
    const all = this.safeMemoriesOfDay(petId, islandDay).filter((m) => m.kind !== 'diary');
    const picked = [...all].sort(byImportanceDesc).slice(0, DIARY_MEMORY_LIMIT);

    // 記憶が1件も無い島日はLLMを呼ばない（「何もなかった日」も日記にする）
    if (picked.length === 0) {
      this.counters.quietDays++;
      const quiet =
        pick(QUIET_DAY_LINES[pet.persona.species] ?? QUIET_DAY_LINES.mofi, `${petId}/${islandDay}`) ??
        'しずかな一日だった。';
      return this.finish({
        pet,
        islandDay,
        tick,
        diary: quiet,
        // 何もない日で長期記憶を書き換える理由はない。既存をそのまま残す
        summary: sanitizeSummary(pet.summary),
        moodDelta: 0,
        fallback: true,
        errorKind: 'no_memories',
      });
    }

    const clockState = this.clock.state(tick);
    const messages = buildDiaryPrompt({
      persona: pet.persona,
      affection: pet.affection,
      clock: {
        // 「終わった島日」の日記なので、時計の現在値ではなく渡された島日を使う
        islandDay,
        season: clockState.season,
        timeOfDay: clockState.timeOfDay,
        weather: clockState.weather,
      },
      summary: pet.summary,
      memories: picked.map((m) => ({ text: m.text, islandDay: m.islandDay, kind: m.kind })),
      ownerName: this.ownerNameOf(pet.playerId),
      ownerVisited: opts.ownerVisited,
    });

    const result = await this.llm.complete({
      purpose: 'diary',
      messages,
      maxTokens: DIARY_MAX_TOKENS,
      schema: DiarySchema as unknown as Record<string, unknown>,
      playerId: pet.playerId,
    });

    if (!result.ok) {
      return this.finish(this.mechanical(pet, picked, islandDay, tick, result.errorKind));
    }

    const parsed = parseDiary(safeJson(result.text));
    if (!parsed) {
      // JSON崩れ・空応答。LLMは動いているがこちらでは使えないので機械的な要約に落とす
      return this.finish(this.mechanical(pet, picked, islandDay, tick, 'parse'));
    }

    const diary = sanitizeQuoted(parsed.diary, DIARY_MAX_CHARS);
    if (diary.length === 0) {
      return this.finish(this.mechanical(pet, picked, islandDay, tick, 'empty'));
    }

    // summaryUpdate が空なら「既存＋日記」に落とす（長期記憶を空にしない）
    const updated = sanitizeSummary(parsed.summaryUpdate);
    const summary = updated.length > 0 ? updated : mergeSummary(pet.summary, diary);

    return this.finish({
      pet,
      islandDay,
      tick,
      diary,
      summary,
      moodDelta: Math.max(-3, Math.min(3, Math.round(parsed.moodDelta))),
      fallback: false,
    });
  }

  /**
   * 留守中サマリを作る。**LLMは使わない**（既に書かれた日記と島の出来事を並べるだけ）。
   * ログイン直後に即座に出したいので、待たせない設計にする。
   */
  buildAwaySummary(opts: {
    petId: number;
    islandId: string;
    sinceIslandDay: number;
    currentIslandDay: number;
    petName: string;
  }): AwaySummary {
    this.counters.away++;
    const passed = Math.max(0, Math.trunc(opts.currentIslandDay) - Math.trunc(opts.sinceIslandDay));
    const name = sanitizeQuoted(opts.petName, 12) || 'ペット';
    const say = (body: string): string => this.awayLine(name, body);

    const lines: string[] = [passed > 0 ? say(`島で${passed}日すぎたよ`) : say('まだそんなに時間はたっていないよ')];

    // 1. 日記（新しい順に最大3件を選び、読ませるときは古い順に並べる）
    const diaries = this.awayDiaries(opts.petId, opts.sinceIslandDay);
    for (const d of diaries) lines.push(say(d.text));

    // 2. 島の重要な出来事。日記で埋まっていない残りの行に入れる
    // 日記に同じことが書かれている出来事は落とす（同じ話を2行使うと3〜5行の枠がもったいない）
    const events = this.awayEvents(
      opts.islandId,
      opts.sinceIslandDay,
      AWAY_MAX_LINES - lines.length,
      diaries.map((d) => d.text),
    );
    for (const text of events) lines.push(say(text));

    const generic = diaries.length === 0 && events.length === 0;
    if (generic) {
      this.counters.awayGeneric++;
      for (let i = 0; lines.length < AWAY_MIN_LINES; i++) {
        const body = AWAY_GENERIC_LINES[(fnv1a(`${opts.petId}/${passed}`) + i) % AWAY_GENERIC_LINES.length];
        lines.push(say(body ?? 'しずかだったよ'));
      }
    } else {
      // 材料はあるが行が足りない場合の埋め草（3行を下回らせない）
      for (let i = 0; lines.length < AWAY_MIN_LINES; i++) {
        const body = AWAY_FILLER_LINES[(fnv1a(`${opts.petId}/${passed}/f`) + i) % AWAY_FILLER_LINES.length];
        lines.push(say(body ?? 'いつもどおりだったよ'));
      }
    }

    return { lines: lines.slice(0, AWAY_MAX_LINES), islandDaysPassed: passed, generic };
  }

  /** 日記を書いたあとの記憶の剪定（無限に増えないように） */
  pruneOldMemories(petId: number, currentIslandDay: number): number {
    const before = Math.trunc(currentIslandDay) - MEMORY_KEEP_ISLAND_DAYS;
    if (before <= 0) return 0;
    try {
      const n = this.petRepo.pruneMemories(petId, {
        beforeIslandDay: before,
        keepImportanceAtLeast: MEMORY_KEEP_IMPORTANCE,
      });
      this.counters.pruned += n;
      return n;
    } catch (e) {
      console.error('[reflection] 記憶の剪定に失敗', e);
      return 0;
    }
  }

  stats(): Record<string, unknown> {
    return {
      ...this.counters,
      fallbackRatio:
        this.counters.diaries === 0 ? 0 : Math.round((this.counters.fallback / this.counters.diaries) * 100) / 100,
    };
  }

  // ---------- 内部（日記） ----------

  /** その日の最重要イベントを機械的に連結して日記にする（docs §6 のフォールバック） */
  private mechanical(
    pet: DiaryDraft['pet'],
    picked: readonly MemoryRecord[],
    islandDay: number,
    tick: number,
    errorKind: string,
  ): DiaryDraft {
    const parts: string[] = [];
    for (const m of picked.slice(0, FALLBACK_EVENT_COUNT)) {
      const t = sanitizeQuoted(m.text, 40);
      if (t.length > 0) parts.push(t);
    }
    const body = parts.length > 0 ? parts.join('。') : 'しずかな一日だった';
    const diary = sanitizeLine(`${islandDay}日目。${body}。`, DIARY_MAX_CHARS);
    return {
      pet,
      islandDay,
      tick,
      diary,
      // ここが肝。**既存のsummaryを先頭に残したまま**日記1文だけ足す
      summary: mergeSummary(pet.summary, diary),
      moodDelta: 0,
      fallback: true,
      errorKind,
    };
  }

  /** 日記を保存し、長期記憶を更新して結果を返す。DBが落ちても結果は返す */
  private finish(o: DiaryDraft): DiaryResult {
    this.counters.diaries++;
    if (o.fallback) {
      this.counters.fallback++;
      const key = o.errorKind ?? 'unknown';
      this.counters.byError[key] = (this.counters.byError[key] ?? 0) + 1;
    }

    try {
      const mem = memoryFromDiary(o.pet.id, { tick: o.tick, islandDay: o.islandDay, diary: o.diary });
      if (mem) this.petRepo.insertMemories([mem]);
    } catch (e) {
      console.error('[reflection] 日記の保存に失敗', e);
    }

    const summary = sanitizeSummary(o.summary);
    try {
      this.petRepo.updatePet(o.pet.id, { summary });
      o.pet.summary = summary;
    } catch (e) {
      console.error('[reflection] 長期記憶の保存に失敗', e);
    }

    return {
      petId: o.pet.id,
      islandDay: o.islandDay,
      diary: o.diary,
      summary,
      moodDelta: Math.max(-3, Math.min(3, Math.round(o.moodDelta))),
      fallback: o.fallback,
      ...(o.errorKind ? { errorKind: o.errorKind } : {}),
    };
  }

  /** ペットが見つからない等、日記を書く土台が無いとき */
  private fail(petId: number, islandDay: number, diary: string, summary: string, errorKind: string): DiaryResult {
    this.counters.diaries++;
    this.counters.fallback++;
    this.counters.byError[errorKind] = (this.counters.byError[errorKind] ?? 0) + 1;
    return { petId, islandDay, diary, summary, moodDelta: 0, fallback: true, errorKind };
  }

  private existingDiaryOf(petId: number, islandDay: number): string | null {
    for (const m of this.safeMemoriesOfDay(petId, islandDay)) {
      if (m.kind === 'diary') return m.text;
    }
    return null;
  }

  private safeMemoriesOfDay(petId: number, islandDay: number): MemoryRecord[] {
    try {
      return this.petRepo.memoriesOfDay(petId, islandDay);
    } catch (e) {
      console.error('[reflection] その日の記憶の読み出しに失敗', e);
      return [];
    }
  }

  private ownerNameOf(playerId: string): string {
    try {
      return this.repo.findPlayerById(playerId)?.displayName ?? 'きみ';
    } catch {
      return 'きみ';
    }
  }

  // ---------- 内部（留守中サマリ） ----------

  /** ペットのセリフ1行に整える。ペット名を主語にすると「ペットが教えてくれる」感じになる */
  private awayLine(name: string, body: string): string {
    // 「name「…」」で name.length + 2 文字使うので、本文はその残りに収める
    const room = Math.max(8, AWAY_LINE_CHARS - name.length - 2);
    const text = sanitizeQuoted(body, room);
    return sanitizeLine(`${name}「${text}」`, AWAY_LINE_CHARS);
  }

  /** 留守中に書かれた日記。新しい順に最大3件選び、読ませるときは古い順に戻す */
  private awayDiaries(petId: number, sinceIslandDay: number): MemoryRecord[] {
    let rows: MemoryRecord[] = [];
    try {
      // kinds を絞ると「古い日記」も引ける（新しい順200件の窓に埋もれない）
      rows = this.petRepo.recentMemories(petId, { kinds: ['diary'], limit: AWAY_DIARY_COUNT * 4 });
    } catch (e) {
      console.error('[reflection] 日記の読み出しに失敗', e);
      return [];
    }
    const picked = rows.filter((m) => m.islandDay >= sinceIslandDay && m.text.length > 0).slice(0, AWAY_DIARY_COUNT);
    picked.sort((a, b) => a.islandDay - b.islandDay || a.tick - b.tick || (a.id ?? 0) - (b.id ?? 0));
    return picked;
  }

  /** 島の重要な出来事。重要度の高い順に、同じ文面は1回だけ。日記と重複するものは落とす */
  private awayEvents(islandId: string, sinceIslandDay: number, room: number, diaryTexts: readonly string[]): string[] {
    if (room <= 0) return [];
    let rows: IslandEventRecord[] = [];
    try {
      rows = this.repo.recentIslandEvents(islandId, {
        sinceIslandDay,
        minImportance: AWAY_EVENT_MIN_IMPORTANCE,
        limit: AWAY_EVENT_FETCH,
      });
    } catch (e) {
      console.error('[reflection] 島の出来事の読み出しに失敗', e);
      return [];
    }
    const sorted = [...rows].sort(
      (a, b) => b.importance - a.importance || b.islandDay - a.islandDay || b.tick - a.tick || b.id - a.id,
    );
    const out: string[] = [];
    const seen = new Set<string>();
    for (const ev of sorted) {
      const text = sanitizeQuoted(ev.text, AWAY_LINE_CHARS);
      if (text.length === 0 || seen.has(text)) continue;
      if (diaryTexts.some((d) => d.includes(text))) continue;
      seen.add(text);
      out.push(text);
      if (out.length >= room) break;
    }
    return out;
  }
}
