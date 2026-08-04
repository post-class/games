import { chatFallback, localReaction, type CareKind } from '../../shared/reactions.js';
import type { PetReply } from '../../shared/types.js';
import type { Db } from '../db.js';
import { chat, LlmUnavailableError } from '../llm/azure.js';
import { parsePetReply } from '../llm/parse.js';
import {
  buildCareMessages,
  buildChatMessages,
  buildThinkMessages,
  PET_REPLY_SCHEMA,
  type CareEvent,
  type PromptContext,
} from '../llm/prompt.js';
import { checkSpeech, retryHint } from '../llm/speechGuard.js';
import { ageHoursOf, stageFor } from './growth.js';
import {
  addChatTurn,
  applyMemoryWrites,
  listFacts,
  recallEpisodes,
  recentChat,
} from './memory.js';
import { applyNeedsDelta } from './needs.js';
import { saveNeeds, saveState, type PetRecord } from './store.js';

/**
 * ペットの「頭」。記憶の呼び出し → プロンプト生成 → LLM → 検証 → 記憶の書き戻し。
 * 崩壊検出に引っかかったら1回だけ言い直させる。
 */

export interface ThinkOptions {
  /** 記憶検索のクエリ（飼い主の発話など）。 */
  query?: string;
  now?: number;
}

function buildContext(db: Db, pet: PetRecord, query: string, now: number): PromptContext {
  const ageHours = ageHoursOf(pet.bornAt, now);
  const today = new Date(now).toISOString().slice(0, 10);
  const promiseRow = db
    .prepare('SELECT text FROM promises WHERE user_id = ? AND for_date = ? AND done = 0 LIMIT 1')
    .get(pet.userId, today) as { text: string } | undefined;
  const encounterRow = db
    .prepare('SELECT souvenir FROM encounters WHERE pet_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(pet.id) as { souvenir: string } | undefined;

  return {
    pet,
    stage: stageFor(ageHours, pet.careScore),
    ageHours,
    facts: listFacts(db, pet.id),
    episodes: recallEpisodes(db, pet.id, query, 6, now),
    chat: recentChat(db, pet.id, 12),
    promise: promiseRow?.text ?? null,
    recentEncounter: encounterRow?.souvenir ?? null,
  };
}

export interface BrainResult {
  reply: PetReply;
  llmError?: string;
  issues: string[];
  /** 崩壊検出でリトライしたか（テスト・ログ用）。 */
  retried: boolean;
}

/**
 * LLM を1〜2回呼び、検証済みの返答を得る。
 * 呼び出し側で needs/state/記憶の保存まで行うので、この関数自体は DB を書かない
 * （記憶の recall による last_used_at 更新を除く）。
 */
async function askLlm(
  messages: ReturnType<typeof buildChatMessages>,
  pet: PetRecord,
): Promise<BrainResult> {
  const first = await chat({
    messages,
    jsonSchema: PET_REPLY_SCHEMA as unknown as { name: string; schema: Record<string, unknown> },
    maxTokens: 600,
  });
  const parsed = parsePetReply(first, { fallbackAction: pet.action, fallbackEmotion: pet.emotion });

  const guard = checkSpeech(parsed.reply.say);
  if (guard.ok && parsed.reply.say) {
    return { reply: parsed.reply, issues: parsed.issues, retried: false };
  }

  // 崩壊検出 or 空発話 → 1回だけ言い直させる。
  const hint = guard.ok ? 'say が空だった。必ず一言だけ話すこと。' : retryHint(guard.violation ?? '');
  const second = await chat({
    messages: [...messages, { role: 'assistant', content: first }, { role: 'user', content: hint }],
    jsonSchema: PET_REPLY_SCHEMA as unknown as { name: string; schema: Record<string, unknown> },
    maxTokens: 600,
  });
  const retryParsed = parsePetReply(second, {
    fallbackAction: pet.action,
    fallbackEmotion: pet.emotion,
  });
  const retryGuard = checkSpeech(retryParsed.reply.say);

  // それでもダメなら定型に落とす（ユーザには崩壊を見せない）。
  if (!retryGuard.ok || !retryParsed.reply.say) {
    return {
      reply: { ...retryParsed.reply, say: chatFallback(pet.species) },
      issues: [...parsed.issues, ...retryParsed.issues, 'guard-failed-twice'],
      retried: true,
    };
  }
  return {
    reply: retryParsed.reply,
    issues: [...parsed.issues, ...retryParsed.issues],
    retried: true,
  };
}

/** 共通の後処理: ニーズ・状態・記憶を保存する。 */
function commit(db: Db, pet: PetRecord, reply: PetReply, now: number): void {
  const needs = applyNeedsDelta(pet.needs, reply.needsDelta);
  pet.needs = needs;
  saveNeeds(db, pet.id, needs, now);
  saveState(db, pet.id, { action: reply.action, emotion: reply.emotion });
  pet.action = reply.action;
  pet.emotion = reply.emotion;
  if (reply.memoryWrites.length) {
    applyMemoryWrites(db, pet.id, reply.memoryWrites, now);
  }
}

export async function talkToPet(
  db: Db,
  pet: PetRecord,
  ownerText: string,
  options: ThinkOptions = {},
): Promise<BrainResult> {
  const now = options.now ?? Date.now();
  addChatTurn(db, pet.id, 'owner', ownerText, null, now);
  const context = buildContext(db, pet, ownerText, now);
  const messages = buildChatMessages(context, ownerText, now);

  try {
    const result = await askLlm(messages, pet);
    commit(db, pet, result.reply, now);
    addChatTurn(db, pet.id, 'pet', result.reply.say, result.reply.emotion, now + 1);
    return result;
  } catch (error) {
    const say = chatFallback(pet.species);
    addChatTurn(db, pet.id, 'pet', say, pet.emotion, now + 1);
    return {
      reply: {
        say,
        emotion: pet.emotion,
        action: pet.action,
        needsDelta: {},
        memoryWrites: [],
        giftRequest: null,
      },
      llmError: describeError(error),
      issues: ['llm-failed'],
      retried: false,
    };
  }
}

export async function reactToCare(
  db: Db,
  pet: PetRecord,
  event: CareEvent,
  options: ThinkOptions = {},
): Promise<BrainResult> {
  const now = options.now ?? Date.now();
  const query = `${event.kind} ${event.itemName ?? ''}`;
  const context = buildContext(db, pet, query, now);
  const messages = buildCareMessages(context, event, now);

  try {
    const result = await askLlm(messages, pet);
    commit(db, pet, result.reply, now);
    addChatTurn(db, pet.id, 'pet', result.reply.say, result.reply.emotion, now);
    return result;
  } catch (error) {
    // ここは定型リアクションで十分成立する（クライアントも同じものを即出ししている）。
    const local = localReaction(pet.species, event.kind as CareKind, pet.needs.mood);
    saveState(db, pet.id, { action: local.action, emotion: local.emotion });
    pet.action = local.action;
    pet.emotion = local.emotion;
    return {
      reply: {
        say: local.say,
        emotion: local.emotion,
        action: local.action,
        needsDelta: {},
        memoryWrites: [],
        giftRequest: null,
      },
      llmError: describeError(error),
      issues: ['llm-failed'],
      retried: false,
    };
  }
}

export async function petThinks(
  db: Db,
  pet: PetRecord,
  options: ThinkOptions = {},
): Promise<BrainResult> {
  const now = options.now ?? Date.now();
  const context = buildContext(db, pet, options.query ?? '', now);
  const messages = buildThinkMessages(context, now);

  try {
    const result = await askLlm(messages, pet);
    commit(db, pet, result.reply, now);
    db.prepare('UPDATE pets SET last_think_at = ? WHERE id = ?').run(now, pet.id);
    pet.lastThinkAt = now;
    // 独り言は会話履歴に残す（文脈が続くように）。
    addChatTurn(db, pet.id, 'pet', result.reply.say, result.reply.emotion, now);
    return result;
  } catch (error) {
    db.prepare('UPDATE pets SET last_think_at = ? WHERE id = ?').run(now, pet.id);
    pet.lastThinkAt = now;
    return {
      reply: {
        say: '',
        emotion: pet.emotion,
        action: pet.action,
        needsDelta: {},
        memoryWrites: [],
        giftRequest: null,
      },
      llmError: describeError(error),
      issues: ['llm-failed'],
      retried: false,
    };
  }
}

export function describeError(error: unknown): string {
  if (error instanceof LlmUnavailableError) return 'LLM未設定';
  if (error instanceof Error) return error.message.slice(0, 200);
  return String(error).slice(0, 200);
}
