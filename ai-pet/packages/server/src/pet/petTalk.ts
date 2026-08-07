/**
 * ペット同士の会話と噂（docs/02_ゲーム実装プラン/07_ペットAI設計.md §5.2）
 *
 * 宣伝資料の「いちばん面白いのは、あなたが席を外している間です」の中身。
 * 3日ぶりに開いたときに「今日ミズネがこんなこと言ってたよ」が返ってくるのは、ここで
 * 島に残ったペット同士が勝手に出会って話し、その要点（gossip）が双方の記憶に入るからである。
 *
 * 設計の要点:
 *  1. **tick を止めない**。`update()` は「会話が始まる条件」を軽い順に見るだけで、
 *     LLM呼び出しは非同期に投げる（`brain.ts` と同じ形）。同時に走る会話は島全体で1本まで。
 *  2. **1回のLLM呼び出しで2〜4発話を一括生成**（§5.2）。往復させるとコストが倍になる。
 *     生成した発話は `onLine` で「順番に吹き出しへ流す」ための遅延つきで渡す。
 *  3. **他プレイヤー経由の間接注入をここで止める**（§8）。相手のペットの発話も記憶も
 *     「島の誰かの発言」でしかないので、
 *       - 発話テキストは `sanitizeQuoted(text, 40)`
 *       - 話者は2匹の名前と**厳密一致**したものだけ採用（一致しない行は捨てる）
 *       - gossip も40字に切って `pet_memory(kind='gossip')` に「相手が話していた」形で保存
 *     という3段で落とす。LLMの出力にサーバの状態を書き換える権限は一切与えない。
 *  4. **例外を投げない／黙って諦める**。タイムアウト・予算切れ・LLM障害・JSON崩れは
 *     すべて「会話が起きなかった」（`null`）に落ちる。ペット同士の会話は誰も待っていないので、
 *     定型セリフでお茶を濁すより無言でスキップした方が世界が壊れない。
 *
 * 制約: parameter property 禁止 / enum・namespace 禁止 / 相対importは拡張子込み / Math.random 禁止
 */
import { LLM, type Actor, type EntityId, type Terrain } from '@ai-pet/shared';
import type { LlmClient } from '../llm/client.ts';
import type { PetRepo, PetRow } from '../db/petRepo.ts';
import type { IslandWorld } from '../sim/world.ts';
import type { WorldClock } from '../sim/clock.ts';
import { PetTalkSchema, parsePetTalk } from './schema.ts';
import {
  buildPetTalkPrompt,
  moodOf,
  sanitizeQuoted,
  PERSONA_LIMITS,
  type PetTalkSpeaker,
} from './persona.ts';
import { memoryFromGossip, selectMemories, type MemoryRecord } from './memory.ts';

// ---------- 定数 ----------

/** 会話が始まる距離（docs §5.2「両者が3タイル以内」） */
const TALK_RADIUS = 3;
/** この行動をしている側だけが会話を始められる（docs §5.2「双方 talk_to/socialize 中」を片側条件に緩めたもの） */
const TALK_ACTIONS: readonly string[] = ['talk', 'socialize'];
/** 同時に走る会話は島全体で1本（不在ペットが増えても予算が線形に膨らまないための蓋） */
const MAX_CONCURRENT_TALKS = 1;
/** 出力トークンの上限。4発話×40字＋gossipで十分（docs §7 の「出力200tok」に余裕を持たせた値） */
const PET_TALK_MAX_TOKENS = 400;
/** 発話1件の上限。PetTalkSchema の maxLength と揃えている */
const LINE_CHARS = 40;
/** 採用する発話の最大件数（PetTalkSchema の maxItems と同じ） */
const MAX_LINES = 4;
/** 吹き出しを順番に出すための間隔。読み終わる前に次が出ないくらい */
const LINE_DELAY_MS = 2500;
/** 相手に話すネタとして渡す記憶の件数（buildPetTalkPrompt が3件で切る） */
const TALK_MEMORIES = 3;
/** 記憶検索の母数（petRepo の既定と同じ） */
const MEMORY_FETCH = 200;
/**
 * ペット1匹の近傍走査を何tickに1回にするか（time slicing）。
 * `socialize` 中のペットはクールダウン中でも毎tick条件を満たしてしまうので、
 * 走査そのものを間引いておかないと 8匹×全アクター の距離計算が毎tick走る。
 * `petId` でオフセットをずらして、同じtickに全員が走査しないようにする。
 */
const SCAN_STRIDE = 4;
/** ペアのクールダウン表がこれを超えたら古い行を捨てる（放置された島でメモリが増え続けないように） */
const PAIR_TABLE_LIMIT = 64;
/** 実時間1時間ぶんのtick数（TICK_HZ=4） */
const TICKS_PER_HOUR = 3600 * 4;
/**
 * 1匹あたり1時間の会話回数の上限（docs §7「ペット間会話 3/時」「不在ペットは20分間隔」）。
 *
 * クールダウンは**ペアごと**なので、これだけでは足りない。8匹が広場に固まると
 * 28ペア×3回/時 = 84回/時まで伸びて、docs §7 の見積り（12回/時）を大きく超える。
 * ペット間会話は誰も待っていない機能なので、予算はここで先に頭を打たせる
 * （会話が起きないだけで、プレイヤーの体験は壊れない）。
 */
const MAX_TALKS_PER_HOUR = { online: 12, offline: 3 } as const;
/** 記憶検索のクエリ。「さっき何を見たか」を引き出す固定の語彙（会話と違って人の発話がない） */
const MEMORY_QUERY_BASE = 'さっき 見た きいた 島 だれ なに';

/** 地形の日本語表記（プロンプトの[場所]用） */
const TERRAIN_JA: Record<Terrain, string> = {
  grass: '草はら',
  dirt: '土のうえ',
  sand: '砂浜',
  water: '水べ',
  forest: '森のなか',
  plaza: '広場',
};

// ---------- 外部との継ぎ目 ----------

export interface PetTalkDeps {
  /** 島にいるペット一覧（DBのpetIdとアクターIDの対応）。不在オーナーのペットも含む */
  activePets: () => { playerId: string; petId: number; entityId: EntityId }[];
  /** オーナーが接続中か。クールダウンの長さ（5分 / 20分）が変わる */
  isOwnerOnline: (playerId: string) => boolean;
  /** オーナー名。記憶のキーワード抽出で固有名として使う */
  ownerNameOf: (playerId: string) => string | undefined;
}

export interface PetTalkResult {
  petIds: [number, number];
  entityIds: [EntityId, EntityId];
  /** 生成された発話（順番に吹き出しへ流す） */
  lines: { speakerPetId: number; entityId: EntityId; text: string }[];
  /** 双方の記憶に残る「噂」1文 */
  gossip: string;
  fallback: boolean;
  errorKind?: string;
}

/** 会話に参加する1匹ぶんの解決済み情報 */
interface Participant {
  petId: number;
  playerId: string;
  entityId: EntityId;
  actor: Actor;
  pet: PetRow;
  /** プロンプトに載る表示名（サニタイズ済み）。話者の照合はこの文字列で行う */
  shownName: string;
  /** プロンプトへ渡した記憶（touch して「使われた」印をつけるため） */
  used: MemoryRecord[];
}

/** 決定論の小さなハッシュ（FNV-1a）。Math.random は使わない */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** ペアのキー。順序に依存しないよう小さいID順に並べる */
function pairKey(a: number, b: number): string {
  return a <= b ? `${a}:${b}` : `${b}:${a}`;
}

function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** LLMのテキストをJSONへ。壊れていれば null（例外は投げない） */
function parsePetTalkText(text: string): ReturnType<typeof parsePetTalk> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  return parsePetTalk(json);
}

export class PetTalkService {
  private llm: LlmClient;
  private repo: PetRepo;
  private world: IslandWorld;
  private clock: WorldClock;
  private deps: PetTalkDeps;

  /** ペアごとの最後の会話tick（開始時に記録する。await中の二重起動も防ぐ） */
  private lastTalkTick = new Map<string, number>();
  /** ペットごとの会話開始tickの履歴（直近1時間ぶんだけ持つ。時間あたりの上限判定用） */
  private history = new Map<number, number[]>();
  /** いま会話中のペットID（1匹が2本の会話に出ないようにする） */
  private busy = new Set<number>();
  private inFlight = 0;

  private lineHooks: ((entityId: EntityId, text: string, delayMs: number) => void)[] = [];
  private gossipHooks: ((petId: number, gossip: string) => void)[] = [];

  private counters = {
    /** LLMを呼んだ回数 */
    attempts: 0,
    /** 会話が成立した回数 */
    talks: 0,
    /** 生成された発話の総数 */
    lines: 0,
    /** 話者が2匹のどちらとも一致せず捨てた行 */
    droppedLines: 0,
    /** LLM失敗・JSON崩れ・全行が不正で無言スキップした回数 */
    skipped: 0,
    /** クールダウンで見送った回数 */
    cooldownBlocked: 0,
    /** 1時間の上限に達して見送った回数 */
    hourlyBlocked: 0,
    /** 島全体の同時実行上限で見送った回数 */
    busyBlocked: 0,
    /** 会話中にペットが島から消えて適用できなかった回数 */
    dropped: 0,
  };
  private byError: Record<string, number> = {};
  /** 直近の会話（デバッグ表示用） */
  private recent: { petIds: [number, number]; gossip: string; lines: number }[] = [];

  // 注意: Node の type-stripping で動かすため parameter property は使えない
  constructor(llm: LlmClient, repo: PetRepo, world: IslandWorld, clock: WorldClock, deps: PetTalkDeps) {
    this.llm = llm;
    this.repo = repo;
    this.world = world;
    this.clock = clock;
    this.deps = deps;
  }

  onLine(fn: (entityId: EntityId, text: string, delayMs: number) => void): void {
    this.lineHooks.push(fn);
  }

  onGossip(fn: (petId: number, gossip: string) => void): void {
    this.gossipHooks.push(fn);
  }

  /**
   * 毎tick呼ぶ。**ここでは await しない**。
   *
   * 判定は軽い順（docs §5.2）:
   *   0. 島全体で会話が走っていないか（Mapを見るだけ）
   *   1. 自分が会話中でない / 起きている / `talk` か `socialize` 中である
   *   2. 近傍走査の当番tickか（time slicing）
   *   3. `world.actorsNear` で3タイル以内のペットを探す（全ペア走査はしない）
   *   4. ペアのクールダウン（オーナー接続中5分 / 不在20分。長い側を採用）
   * ここまで通ったペアだけ `talk()` を非同期に走らせる。
   */
  update(tick: number): void {
    if (this.inFlight >= MAX_CONCURRENT_TALKS) return;

    const sessions = this.deps.activePets();
    if (sessions.length < 2) return;
    // petId → セッション。近傍で見つけたアクターがDB上のペットかを引くために使う
    const byEntity = new Map<EntityId, { playerId: string; petId: number; entityId: EntityId }>();
    for (const s of sessions) byEntity.set(s.entityId, s);

    for (const s of sessions) {
      if (this.inFlight >= MAX_CONCURRENT_TALKS) return;
      if (this.busy.has(s.petId)) continue;
      const actor = this.world.actor(s.entityId);
      if (!actor || actor.kind !== 'pet') continue;
      // 1. 起きていて、話しかける気がある側だけが会話を始める。
      //    「少なくとも一方が talk/socialize」は全ペットを走査することで満たされる
      if (!this.wantsTalk(actor)) continue;
      // 2. 近傍走査は当番tickだけ（全アクターを見るので毎tickは走らせない）
      if ((tick + s.petId) % SCAN_STRIDE !== 0) continue;

      for (const other of this.world.actorsNear(actor.pos, TALK_RADIUS, actor.id)) {
        if (other.kind !== 'pet') continue;
        const os = byEntity.get(other.id);
        if (!os || os.petId === s.petId) continue;
        if (this.busy.has(os.petId)) continue;
        if (other.anim === 'sleep') continue;
        if (!this.cooldownReady(s, os, tick)) {
          this.counters.cooldownBlocked++;
          continue;
        }
        // 会話を走らせる。条件はもう一度 talk() の中でも見る（直接呼ばれる経路があるため）
        void this.talk(s.petId, os.petId, tick).catch((e: unknown) => {
          // talk は例外を投げない作りだが、想定外でtickループを壊さないための保険
          console.error('[petTalk] 会話中に想定外の例外', e);
        });
        return;
      }
    }
  }

  /**
   * 1ペアぶんの会話。条件を満たさない・生成に失敗した場合は `null`（**例外は投げない**）。
   * `update()` からも、テストからも同じ道を通る（条件判定を二重に持たないため）。
   */
  async talk(aPetId: number, bPetId: number, tick: number): Promise<PetTalkResult | null> {
    if (aPetId === bPetId) return null;
    if (this.inFlight >= MAX_CONCURRENT_TALKS) {
      this.counters.busyBlocked++;
      return null;
    }
    if (this.busy.has(aPetId) || this.busy.has(bPetId)) {
      this.counters.busyBlocked++;
      return null;
    }

    const sessions = this.deps.activePets();
    const sa = sessions.find((s) => s.petId === aPetId);
    const sb = sessions.find((s) => s.petId === bPetId);
    if (!sa || !sb) return null;

    const aa = this.world.actor(sa.entityId);
    const ba = this.world.actor(sb.entityId);
    if (!aa || !ba || aa.kind !== 'pet' || ba.kind !== 'pet') return null;

    // 条件（軽い順）: 距離 → 起きている → どちらかが talk/socialize → クールダウン
    if (dist(aa.pos, ba.pos) > TALK_RADIUS) return null;
    if (aa.anim === 'sleep' || ba.anim === 'sleep') return null;
    if (!this.wantsTalk(aa) && !this.wantsTalk(ba)) return null;
    if (!this.cooldownReady(sa, sb, tick)) {
      this.counters.cooldownBlocked++;
      return null;
    }

    const petA = this.repo.findPetById(aPetId);
    const petB = this.repo.findPetById(bPetId);
    if (!petA || !petB) return null;

    // ここから先はLLMを待つ。**待っているあいだに再入されないよう先に印をつける**
    // （クールダウンも開始時に更新する。失敗しても連続で叩かないため）
    this.markStarted(aPetId, bPetId, tick);
    this.counters.attempts++;
    try {
      const a = this.participant(sa, aa, petA, petB, tick);
      const b = this.participant(sb, ba, petB, petA, tick);
      const messages = buildPetTalkPrompt({
        a: this.speakerOf(a),
        b: this.speakerOf(b),
        clock: this.clockLine(tick),
        place: this.placeOf(aa, ba),
        lines: this.lineCount(a, b, tick),
      });

      const res = await this.llm.complete({
        purpose: 'gossip',
        messages,
        maxTokens: PET_TALK_MAX_TOKENS,
        schema: PetTalkSchema,
        playerId: sa.playerId,
      });

      if (!res.ok) return this.skip(res.errorKind ?? 'llm');
      const parsed = parsePetTalkText(res.text);
      if (!parsed) return this.skip('parse');

      const built = this.buildResult(a, b, parsed);
      if (!built) return this.skip('speaker_unknown');

      this.persist(a, b, built, tick);
      this.emit(built);
      return built;
    } finally {
      this.busy.delete(aPetId);
      this.busy.delete(bPetId);
      this.inFlight = Math.max(0, this.inFlight - 1);
    }
  }

  stats(): Record<string, unknown> {
    return {
      ...this.counters,
      inFlight: this.inFlight,
      pairs: this.lastTalkTick.size,
      byError: { ...this.byError },
      recent: this.recent.map((r) => ({ petIds: r.petIds, lines: r.lines, gossip: r.gossip })),
    };
  }

  // ---------- 条件判定 ----------

  /** 起きていて、話しかける気がある（`talk` か `socialize` 中）か */
  private wantsTalk(actor: Actor): boolean {
    if (actor.anim === 'sleep') return false;
    const kind = actor.action?.kind;
    return kind !== undefined && TALK_ACTIONS.includes(kind);
  }

  /**
   * ペアのクールダウン（docs §5.2）。
   * オーナー接続中なら5分、不在なら20分。**片方が不在なら長い側（20分）を採用する**
   * ＝ 留守中のコスト暴走を、相手が接続中であることで抜けられないようにする。
   */
  private cooldownReady(
    a: { playerId: string; petId: number },
    b: { playerId: string; petId: number },
    tick: number,
  ): boolean {
    const need = Math.max(this.cooldownOf(a.playerId), this.cooldownOf(b.playerId));
    const last = this.lastTalkTick.get(pairKey(a.petId, b.petId));
    if (last !== undefined && tick - last < need) return false;
    // ペアのクールダウンを抜けても、1匹あたりの時間あたり上限は超えられない（docs §7 の予算保証）
    if (this.hourlyExceeded(a, tick) || this.hourlyExceeded(b, tick)) {
      this.counters.hourlyBlocked++;
      return false;
    }
    return true;
  }

  /** 直近1時間の会話回数が上限に達しているか。ついでに古い履歴を捨てる */
  private hourlyExceeded(s: { playerId: string; petId: number }, tick: number): boolean {
    const list = this.history.get(s.petId);
    if (!list) return false;
    while (list.length > 0 && tick - (list[0] as number) > TICKS_PER_HOUR) list.shift();
    const cap = this.deps.isOwnerOnline(s.playerId) ? MAX_TALKS_PER_HOUR.online : MAX_TALKS_PER_HOUR.offline;
    return list.length >= cap;
  }

  private cooldownOf(playerId: string): number {
    return this.deps.isOwnerOnline(playerId)
      ? LLM.petTalkCooldownTicksOnline
      : LLM.petTalkCooldownTicksOffline;
  }

  /** 会話の開始を記録する（クールダウン・同時実行の両方をここで押さえる） */
  private markStarted(aPetId: number, bPetId: number, tick: number): void {
    this.lastTalkTick.set(pairKey(aPetId, bPetId), tick);
    for (const petId of [aPetId, bPetId]) {
      const list = this.history.get(petId) ?? [];
      list.push(tick);
      this.history.set(petId, list);
    }
    this.busy.add(aPetId);
    this.busy.add(bPetId);
    this.inFlight++;
    this.prunePairs(tick);
  }

  /** 古いペアの記録を捨てる。クールダウンの最大値を超えて経っていれば忘れてよい */
  private prunePairs(tick: number): void {
    if (this.lastTalkTick.size <= PAIR_TABLE_LIMIT) return;
    const keep = LLM.petTalkCooldownTicksOffline;
    for (const [key, t] of this.lastTalkTick) {
      if (tick - t > keep) this.lastTalkTick.delete(key);
    }
  }

  // ---------- プロンプトの材料 ----------

  private participant(
    session: { playerId: string; petId: number; entityId: EntityId },
    actor: Actor,
    pet: PetRow,
    other: PetRow,
    tick: number,
  ): Participant {
    const ownerName = this.deps.ownerNameOf(session.playerId) ?? '';
    const otherName = other.persona.name;
    const used = selectMemories(this.repo.recentMemories(pet.id, { limit: MEMORY_FETCH }), {
      nowTick: tick,
      query: `${MEMORY_QUERY_BASE} ${otherName}`,
      limit: TALK_MEMORIES,
      maxChars: LLM.maxMemoryChars,
      knownNames: [otherName, ownerName, pet.persona.name],
    });
    return {
      petId: session.petId,
      playerId: session.playerId,
      entityId: session.entityId,
      actor,
      pet,
      shownName: sanitizeQuoted(pet.persona.name, PERSONA_LIMITS.nearbyName),
      used,
    };
  }

  private speakerOf(p: Participant): PetTalkSpeaker {
    return {
      persona: p.pet.persona,
      mood: moodOf(p.actor),
      memories: p.used.map((m) => ({ text: m.text, islandDay: m.islandDay, kind: m.kind })),
    };
  }

  private clockLine(tick: number): { islandDay: number; season: string; timeOfDay: string; weather: string } {
    const s = this.clock.state(tick);
    return { islandDay: s.islandDay, season: s.season, timeOfDay: s.timeOfDay, weather: s.weather };
  }

  /** 出会った場所。2匹の中間地点の地形を日本語にする */
  private placeOf(a: Actor, b: Actor): string {
    const x = Math.floor((a.pos.x + b.pos.x) / 2);
    const y = Math.floor((a.pos.y + b.pos.y) / 2);
    const terrain = this.world.terrainAt(x, y);
    return TERRAIN_JA[terrain] ?? 'どこか';
  }

  /**
   * 生成する発話数を2〜4で振る。
   * `temperature` が使えないので、**入力を動かすこと**が多様性の作り方になる（docs §5.3）。
   * ペア・島日・時間帯から決まるので決定論。
   */
  private lineCount(a: Participant, b: Participant, tick: number): number {
    const s = this.clock.state(tick);
    return 2 + (fnv1a(`${pairKey(a.petId, b.petId)}/${s.islandDay}/${s.timeOfDay}`) % 3);
  }

  // ---------- 出力の検証 ----------

  /**
   * LLMの出力を採用できる形に落とす（**安全性の中心**）。
   *
   * 1. 話者は2匹の名前と厳密一致したものだけ採用。一致しない行は捨てる
   *    （「第三者が言ったこと」を勝手にペットの発話にしないため）
   * 2. 発話テキストは `sanitizeQuoted(text, 40)`。改行・役割マーカー・ゼロ幅はここで消える
   * 3. gossip も40字に切る。空なら相手の発話から作る（記憶が空になるのを避ける）
   * 4. 採用できる発話が1件も無ければ会話は成立しなかったことにする（null）
   */
  private buildResult(a: Participant, b: Participant, parsed: { lines: { speaker: string; text: string }[]; gossip: string }): PetTalkResult | null {
    // 名前 → 参加者。同名のペットが出会うことがあるので、その場合は交互に割り当てる
    const sameName = a.shownName === b.shownName;
    const byName = new Map<string, Participant>();
    const remember = (p: Participant): void => {
      if (p.shownName.length > 0 && !byName.has(p.shownName)) byName.set(p.shownName, p);
      const raw = p.pet.persona.name.trim();
      if (raw.length > 0 && !byName.has(raw)) byName.set(raw, p);
    };
    remember(a);
    remember(b);

    const lines: PetTalkResult['lines'] = [];
    let dropped = 0;
    for (const raw of parsed.lines) {
      if (lines.length >= MAX_LINES) break;
      const key = sanitizeQuoted(raw.speaker, PERSONA_LIMITS.nearbyName);
      const speaker = sameName
        ? lines.length % 2 === 0
          ? a
          : b
        : (byName.get(key) ?? byName.get(raw.speaker.trim()));
      if (!speaker) {
        dropped++;
        continue;
      }
      const text = sanitizeQuoted(raw.text, LINE_CHARS);
      if (text.length === 0) {
        dropped++;
        continue;
      }
      lines.push({ speakerPetId: speaker.petId, entityId: speaker.entityId, text });
    }
    this.counters.droppedLines += dropped;
    if (lines.length === 0) return null;

    // gossip が空でも噂は残す。LLMが省いたときは相手の発話を要点として使う
    let gossip = sanitizeQuoted(parsed.gossip, PERSONA_LIMITS.gossip);
    let errorKind: string | undefined = dropped > 0 ? 'lines_dropped' : undefined;
    if (gossip.length === 0) {
      const fromOther = lines.find((l) => l.speakerPetId !== a.petId) ?? lines[0];
      gossip = fromOther ? fromOther.text : '';
      errorKind = 'gossip_missing';
    }

    return {
      petIds: [a.petId, b.petId],
      entityIds: [a.entityId, b.entityId],
      lines,
      gossip,
      // 「出力の一部を補った/落とした」ことを呼び出し側に伝える印。
      // 完全な失敗（LLM障害・JSON崩れ）は null で返すので、ここに来るのは部分的な救済だけ
      fallback: errorKind !== undefined,
      ...(errorKind ? { errorKind } : {}),
    };
  }

  // ---------- 保存と通知 ----------

  /** 噂を双方の記憶へ、発話を `chat_log` へ残す。DBが失敗しても会話は成立させる */
  private persist(a: Participant, b: Participant, result: PetTalkResult, tick: number): void {
    const islandId = 'main';
    const byPetId = new Map<number, Participant>([
      [a.petId, a],
      [b.petId, b],
    ]);

    try {
      for (const line of result.lines) {
        const other = line.speakerPetId === a.petId ? b : a;
        this.repo.insertChat({
          islandId,
          tick,
          speakerKind: 'pet',
          // recentChat はペットIDで検索するので、名前ではなくIDを入れる（M4で踏んだ罠）
          speakerId: String(line.speakerPetId),
          listenerId: String(other.petId),
          text: line.text,
        });
      }
    } catch (e) {
      console.error('[petTalk] 会話ログの保存に失敗', e);
    }

    // 噂は**双方**の記憶に「相手がこう言っていた」形で入れる（docs §5.2）
    const islandDay = this.clock.islandDay;
    const rows: MemoryRecord[] = [];
    for (const [petId, self] of byPetId) {
      const other = petId === a.petId ? b : a;
      const ownerName = this.deps.ownerNameOf(self.playerId) ?? '';
      const mem = memoryFromGossip(petId, {
        tick,
        islandDay,
        fromName: other.pet.persona.name,
        text: result.gossip,
        knownNames: [self.pet.persona.name, other.pet.persona.name, ownerName],
      });
      if (mem) rows.push(mem);
    }
    try {
      this.repo.insertMemories(rows);
      const ids = [...a.used, ...b.used].map((m) => m.id).filter((v): v is number => typeof v === 'number');
      if (ids.length > 0) this.repo.touchMemories(ids, tick);
    } catch (e) {
      console.error('[petTalk] 噂の保存に失敗', e);
    }

    this.counters.talks++;
    this.counters.lines += result.lines.length;
    this.recent.push({ petIds: result.petIds, gossip: result.gossip, lines: result.lines.length });
    if (this.recent.length > 8) this.recent.shift();
  }

  /** 吹き出しと噂の通知。フックの例外でシミュレーションを止めない */
  private emit(result: PetTalkResult): void {
    result.lines.forEach((line, i) => {
      // 待っているあいだにペットが島から消えていることがある
      if (!this.world.actor(line.entityId)) {
        this.counters.dropped++;
        return;
      }
      for (const fn of this.lineHooks) {
        try {
          fn(line.entityId, line.text, i * LINE_DELAY_MS);
        } catch (e) {
          console.error('[petTalk] 発話フックで例外', e);
        }
      }
    });
    for (const petId of result.petIds) {
      for (const fn of this.gossipHooks) {
        try {
          fn(petId, result.gossip);
        } catch (e) {
          console.error('[petTalk] 噂フックで例外', e);
        }
      }
    }
  }

  /** 無言でスキップする（docs §6 のフォールバック方針）。理由だけ数えて null を返す */
  private skip(errorKind: string): null {
    this.counters.skipped++;
    this.byError[errorKind] = (this.byError[errorKind] ?? 0) + 1;
    return null;
  }
}

/** テストとデバッグから参照する調整値 */
export const PET_TALK_TUNING = {
  TALK_RADIUS,
  TALK_ACTIONS,
  MAX_CONCURRENT_TALKS,
  PET_TALK_MAX_TOKENS,
  LINE_CHARS,
  MAX_LINES,
  LINE_DELAY_MS,
  TALK_MEMORIES,
  SCAN_STRIDE,
  MAX_TALKS_PER_HOUR,
  TICKS_PER_HOUR,
} as const;
