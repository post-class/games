/**
 * ペットとの会話（docs/02_ゲーム実装プラン/07_ペットAI設計.md §5.1）
 *
 * 設計の要点:
 * - LLMはストリーミング。初トークンまで2秒以内が目標
 * - **失敗しても会話が止まらない**。タイムアウト・レート超過・LLM障害はすべて定型セリフに落ちる
 * - 出力は素のテキスト。ただし末尾の `#goal:xxx` タグだけは行動の希望として拾い、表示からは消す
 * - 会話後に記憶と会話ログを残し、懐き度を少し上げる
 */
import {
  LLM,
  PET_GOALS,
  TICKS_PER_ISLAND_HOUR,
  type Actor,
  type PetGoal,
} from '@ai-pet/shared';
import type { LlmClient, LlmMessage } from '../llm/client.ts';
import type { PetRepo, PetRow } from '../db/petRepo.ts';
import type { WorldClock } from '../sim/clock.ts';
import type { IslandWorld } from '../sim/world.ts';
import { buildDialoguePrompt, moodOf, sanitizeLine, PERSONA_LIMITS } from './persona.ts';
import { memoryFromTalk, selectMemories, type MemoryRecord } from './memory.ts';

/** 応答の最大長（プロンプトでも指示しているが、実際に切る） */
const MAX_REPLY_CHARS = 80;
/** 会話で上がる懐き度と、その最短間隔 */
const AFFECTION_GAIN = 0.5;
const AFFECTION_GAIN_COOLDOWN_TICKS = 60 * 4; // 1分
/** 記憶検索の母数 */
const MEMORY_FETCH = 200;

export interface DialogueRequest {
  pet: PetRow;
  petActor: Actor;
  ownerName: string;
  ownerActor: Actor | undefined;
  playerId: string;
  playerText: string;
  tick: number;
}

export interface DialogueResult {
  /** 表示する本文（フォールバックのときも入る） */
  text: string;
  /** LLMが返した行動の希望（`#goal:` タグ） */
  goal: PetGoal | null;
  /** 定型セリフで応答したか */
  fallback: boolean;
  /** フォールバックの理由（timeout/rate/breaker/mode/...） */
  errorKind?: string;
  affection: number;
  latencyMs: number;
}

/**
 * 種ごとの定型セリフ。
 * LLMが使えないときでも「島の生きものらしさ」を保つための最後の砦。
 * 「答えになっていない」ことがむしろ自然に見える文にしてある。
 */
const FALLBACK_LINES: Record<string, readonly string[]> = {
  mofi: [
    'ふぁ……ねむいねぇ',
    'モフィ、いまねむくて……',
    'あとでね……くぅ',
    'んー、なんだっけ',
    'ひなたがきもちいいねぇ',
    'モフィ、ちょっとぼんやりしてた',
    'そこ、あったかいねぇ',
    'ねむいから、またあとで',
    'うん……うん……',
    'きょうはのんびりだねぇ',
  ],
  mizune: [
    'ふうん',
    '……いまはいいや',
    'べつに',
    'あとで聞く',
    'water の音がしてる',
    'ちょっと考えてる',
    'ふうん、そう',
    '……',
    'いまは気がのらない',
    'そっちを見てただけ',
  ],
  hakka: [
    'ちょっと待ってね',
    'いま手がふさがってて',
    'まかせて、あとでね',
    'んー、なんだったかな',
    '畑を見てくるね',
    'あとでちゃんと聞くから',
    'すこし考えさせて',
    'だいじょうぶ、心配ないよ',
    'ごめんね、集中してた',
    'そのお話、あとでね',
  ],
  momona: [
    'おなかすいた！',
    'えっ、なになに？',
    'あとでね、いま食べてる',
    'んー、忘れちゃった',
    '木の実のにおいがする！',
    'ちょっと待ってて！',
    'あたし、いそがしいの',
    'それより木の実の話しよ',
    'えへへ、なんだっけ',
    'おなかがすいて考えられない',
  ],
  hoshira: [
    '星がきれい',
    'いまは空を見ていたくて',
    '……風の音がする',
    'ことばが出てこないの',
    '雲が流れてゆく',
    'すこし夢を見ていたわ',
    'そのお話は、また夜に',
    'わたくし、ぼんやりしていて',
    '星が呼んでいるの',
    'しずかにしていたいの',
  ],
};

const GENERIC_FALLBACK: readonly string[] = ['……', 'えっと', 'んー'];

/** 決定論的に定型セリフを選ぶ（同じ状況で毎回同じにならないようtickも混ぜる） */
export function fallbackLine(species: string, seed: number): string {
  const lines = FALLBACK_LINES[species] ?? GENERIC_FALLBACK;
  const idx = Math.abs(Math.floor(seed)) % lines.length;
  return lines[idx] as string;
}

/**
 * 応答末尾の `#goal:explore` を取り出して本文から消す。
 * LLMの出力に権限を与えないため、enum に無い値は捨てる（docs §8）。
 */
export function extractGoalTag(raw: string): { text: string; goal: PetGoal | null } {
  const m = raw.match(/#goal:\s*([a-z_]+)\s*$/i);
  if (!m) return { text: raw.trim(), goal: null };
  const candidate = (m[1] ?? '').toLowerCase();
  const goal = (PET_GOALS as readonly string[]).includes(candidate) ? (candidate as PetGoal) : null;
  return { text: raw.slice(0, m.index ?? 0).trim(), goal };
}

/** 表示用に整える（改行除去・長さ制限・空なら定型に落とす） */
function tidyReply(raw: string, species: string, seed: number): { text: string; empty: boolean } {
  const cleaned = sanitizeLine(raw, MAX_REPLY_CHARS);
  if (cleaned.length === 0) return { text: fallbackLine(species, seed), empty: true };
  return { text: cleaned, empty: false };
}

export class DialogueService {
  private llm: LlmClient;
  private repo: PetRepo;
  private world: IslandWorld;
  private clock: WorldClock;
  private lastAffectionGainTick = new Map<number, number>();
  private counters = { total: 0, fallback: 0, byError: {} as Record<string, number> };

  // 注意: Node の type-stripping で動かすため parameter property は使えない
  constructor(llm: LlmClient, repo: PetRepo, world: IslandWorld, clock: WorldClock) {
    this.llm = llm;
    this.repo = repo;
    this.world = world;
    this.clock = clock;
  }

  /** プロンプトを組み立てる（テストから覗けるように分離してある） */
  buildPrompt(req: DialogueRequest): { messages: LlmMessage[]; memories: MemoryRecord[] } {
    const { pet, petActor, tick } = req;
    const all = this.repo.recentMemories(pet.id, { limit: MEMORY_FETCH });
    const nearbyActors = this.world.actorsNear(petActor.pos, 10, petActor.id).slice(0, LLM.maxNearby);
    const knownNames = [...nearbyActors.map((a) => a.name), req.ownerName];

    const memories = selectMemories(all, {
      nowTick: tick,
      query: req.playerText,
      limit: LLM.maxMemories,
      maxChars: LLM.maxMemoryChars,
      knownNames,
    });

    const clockState = this.clock.state(tick);
    const messages = buildDialoguePrompt({
      persona: pet.persona,
      affection: pet.affection,
      mood: moodOf(petActor),
      summary: pet.summary,
      clock: {
        islandDay: clockState.islandDay,
        season: clockState.season,
        timeOfDay: clockState.timeOfDay,
        weather: clockState.weather,
      },
      self: {
        hunger: Math.round(petActor.needs.hunger),
        sleep: Math.round(petActor.needs.sleep),
        social: Math.round(petActor.needs.social),
      },
      nearby: nearbyActors.map((a) => ({
        name: a.name,
        species: a.species,
        kind: a.kind,
        distance: Math.round(Math.hypot(a.pos.x - petActor.pos.x, a.pos.y - petActor.pos.y) * 10) / 10,
        doing: a.action?.kind ?? 'idle',
      })),
      memories: memories.map((m) => ({ text: m.text, islandDay: m.islandDay, kind: m.kind })),
      recentChat: this.repo.recentChat(pet.id, LLM.maxChatTurns * 2).map((c) => ({
        // speaker はDB上のID。プロンプトは名前で発話者を判定するのでここで解決する
        speaker: c.speaker === String(pet.id) ? pet.persona.name : req.ownerName,
        text: c.text,
      })),
      ownerName: req.ownerName,
      playerText: req.playerText,
    });
    return { messages, memories };
  }

  /**
   * 会話する。`onDelta` が渡されればストリーミングで流す。
   * **例外は投げない**。失敗はすべて定型セリフに落ちる。
   */
  async talk(req: DialogueRequest, onDelta?: (delta: string) => void): Promise<DialogueResult> {
    this.counters.total++;
    const { pet, petActor, tick } = req;
    const seed = tick + pet.id + req.playerText.length;
    const started = Date.now();

    const { messages, memories } = this.buildPrompt(req);

    let raw = '';
    let errorKind: string | undefined;

    const result = onDelta
      ? await this.llm.stream(
          { purpose: 'dialogue', messages, maxTokens: 160, playerId: req.playerId },
          (delta) => {
            raw += delta;
            onDelta(delta);
          },
        )
      : await this.llm.complete({ purpose: 'dialogue', messages, maxTokens: 160, playerId: req.playerId });

    if (result.ok) {
      if (!onDelta) raw = result.text;
    } else {
      errorKind = result.errorKind;
    }

    const parsed = extractGoalTag(raw);
    const tidied = tidyReply(parsed.text, pet.persona.species, seed);
    const fallback = !result.ok || tidied.empty;
    const text = fallback && !result.ok ? fallbackLine(pet.persona.species, seed) : tidied.text;

    if (fallback) {
      this.counters.fallback++;
      const key = errorKind ?? 'empty';
      this.counters.byError[key] = (this.counters.byError[key] ?? 0) + 1;
    }

    const affection = this.recordConversation({
      req,
      petText: text,
      // 失敗した会話は記憶に残さない（docs §6 のフォールバック方針）
      remember: !fallback,
      memories,
    });

    // 表示に出さないタグは捨て、goalは呼び出し側（brain）が使う
    return {
      text,
      goal: parsed.goal,
      fallback,
      ...(errorKind ? { errorKind } : {}),
      affection,
      latencyMs: Date.now() - started,
    };
  }

  /** 会話ログ・記憶・懐き度を更新して、更新後の懐き度を返す */
  private recordConversation(opts: {
    req: DialogueRequest;
    petText: string;
    remember: boolean;
    memories: readonly MemoryRecord[];
  }): number {
    const { req, petText, remember, memories } = opts;
    const { pet, tick } = req;
    const islandId = 'main';

    try {
      this.repo.insertChat({
        islandId,
        tick,
        speakerKind: 'player',
        speakerId: req.playerId,
        listenerId: String(pet.id),
        text: req.playerText,
      });
      this.repo.insertChat({
        islandId,
        tick,
        speakerKind: 'pet',
        // recentChat は speaker_id / listener_id をペットIDで検索するので、
        // ここに名前を入れると自分の発話を引けなくなる（表示名は読み出し時に解決する）
        speakerId: String(pet.id),
        listenerId: req.playerId,
        text: petText,
      });
    } catch (e) {
      console.error('[dialogue] 会話ログの保存に失敗', e);
    }

    if (remember) {
      try {
        this.repo.insertMemories([
          memoryFromTalk(pet.id, {
            tick,
            islandDay: this.clock.islandDay,
            ownerName: req.ownerName,
            playerText: req.playerText,
            petText,
          }),
        ]);
        const ids = memories.map((m) => m.id).filter((v): v is number => typeof v === 'number');
        if (ids.length > 0) this.repo.touchMemories(ids, tick);
      } catch (e) {
        console.error('[dialogue] 記憶の保存に失敗', e);
      }
    }

    // 話しかけられると少しなつく（連投で稼げないようクールダウンを置く）
    let affection = pet.affection;
    const last = this.lastAffectionGainTick.get(pet.id) ?? -Infinity;
    if (remember && tick - last >= AFFECTION_GAIN_COOLDOWN_TICKS) {
      affection = Math.max(0, Math.min(100, affection + AFFECTION_GAIN));
      this.lastAffectionGainTick.set(pet.id, tick);
      pet.affection = affection;
      req.petActor.affection = affection;
      try {
        this.repo.updatePet(pet.id, { affection });
      } catch (e) {
        console.error('[dialogue] 懐き度の保存に失敗', e);
      }
    }
    return affection;
  }

  /** レート制限などで断るときのセリフ（世界観を壊さない表現にする） */
  busyLine(species: string, seed: number): string {
    const line = fallbackLine(species, seed);
    return sanitizeLine(`${line}（すこし ねむそうだ）`, PERSONA_LIMITS.sayNow + 12);
  }

  stats(): Record<string, unknown> {
    return {
      ...this.counters,
      fallbackRatio: this.counters.total === 0 ? 0 : Math.round((this.counters.fallback / this.counters.total) * 100) / 100,
    };
  }
}

/** 会話が成立する距離（オーナーのペットは常に可） */
export const TALK_RANGE = 8;
/** 記憶に残す価値のある会話の最短長 */
export const MIN_MEANINGFUL_TEXT = 1;
/** 1島時間あたりの目安（メトリクス表示用） */
export const DIALOGUE_TICKS_PER_ISLAND_HOUR = TICKS_PER_ISLAND_HOUR;
