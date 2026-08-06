/**
 * ペットのLLM入出力の型とJSONスキーマ（docs/02_ゲーム実装プラン/07_ペットAI設計.md §4.3 / §5.2）
 *
 * 方針:
 * - 構造化出力（response_format: json_schema, strict）に渡す形をここに集約する。
 *   スキーマを分散させると「サーバの後処理」と食い違うので、パーサも隣に置く。
 * - LLMの出力にサーバの状態を書き換える権限は与えない。goal は enum、相手は「名前の厳密一致」で解決する。
 *
 * 制約: parameter property 禁止 / enum・namespace 禁止 / 相対importは拡張子込み
 */
import { PET_GOALS, type PetGoal } from '@ai-pet/shared';

/**
 * LLM基盤（`llm/client.ts`）と共有する型。
 * `pet/` 側は「プロンプトを組み立てる」だけで LLM を呼ばないが、
 * 組み立てた結果の型は基盤と同一のものを使う（二重定義でズレるのを防ぐ）。
 */
export type { LlmMessage, LlmPurpose } from '../llm/client.ts';

// ---------- 行動決定（Deliberative層） ----------

/** docs §4.3。additionalProperties:false と required 全指定が strict モードの条件 */
export const IntentSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['goal', 'targetName', 'reason', 'sayNow'],
  properties: {
    goal: {
      type: 'string',
      enum: ['follow_owner', 'explore', 'visit_friend', 'gather', 'help_critter', 'rest', 'watch_stars', 'talk_to'],
      description: 'つぎにやりたいこと',
    },
    targetName: {
      type: ['string', 'null'],
      description: '相手がいる場合のみ。「まわり」の一覧にある名前と完全に同じ文字列',
    },
    reason: { type: 'string', maxLength: 60, description: 'そうしたい理由を1文で' },
    sayNow: { type: ['string', 'null'], maxLength: 40, description: '今ひとこと言うなら。言わないなら null' },
  },
} as const;

export interface IntentOutput {
  goal: PetGoal;
  targetName: string | null;
  reason: string;
  sayNow: string | null;
}

/** goal が enum の内側か。docs §4.3 の後処理1 */
export function isPetGoal(v: unknown): v is PetGoal {
  return typeof v === 'string' && (PET_GOALS as readonly string[]).includes(v);
}

/**
 * LLMのJSONを IntentOutput に落とす。壊れていたら null を返す（呼び出し側でフォールバック）。
 * goal が enum 外のときも null にして、`rest` への差し替えは呼び出し側の責務にする
 * （なぜフォールバックしたかをログに出したいので、ここで黙って直さない）。
 */
export function parseIntent(json: unknown): IntentOutput | null {
  if (typeof json !== 'object' || json === null) return null;
  const o = json as Record<string, unknown>;
  if (!isPetGoal(o.goal)) return null;
  if (typeof o.reason !== 'string') return null;
  return {
    goal: o.goal,
    targetName: typeof o.targetName === 'string' && o.targetName.length > 0 ? o.targetName : null,
    reason: o.reason,
    sayNow: typeof o.sayNow === 'string' && o.sayNow.length > 0 ? o.sayNow : null,
  };
}

// ---------- 日記（Reflection層） ----------

/** docs §3.4 */
export const DiarySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['diary', 'summaryUpdate', 'moodDelta'],
  properties: {
    diary: { type: 'string', maxLength: 120, description: 'きょうの日記。1〜3文' },
    summaryUpdate: { type: 'string', maxLength: 400, description: '長期記憶。400字以内' },
    moodDelta: { type: 'integer', minimum: -3, maximum: 3, description: 'きょうで気分がどう動いたか' },
  },
} as const;

export interface DiaryOutput {
  diary: string;
  summaryUpdate: string;
  moodDelta: number;
}

export function parseDiary(json: unknown): DiaryOutput | null {
  if (typeof json !== 'object' || json === null) return null;
  const o = json as Record<string, unknown>;
  if (typeof o.diary !== 'string' || o.diary.length === 0) return null;
  const delta = typeof o.moodDelta === 'number' && Number.isFinite(o.moodDelta) ? Math.round(o.moodDelta) : 0;
  return {
    diary: o.diary,
    summaryUpdate: typeof o.summaryUpdate === 'string' ? o.summaryUpdate : '',
    moodDelta: Math.max(-3, Math.min(3, delta)),
  };
}

// ---------- ペット同士の会話（Dialogue層 §5.2） ----------

/** 2〜4発話を一括生成する。往復させるとコストが倍になるため */
export const PetTalkSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['lines', 'gossip'],
  properties: {
    lines: {
      type: 'array',
      minItems: 2,
      maxItems: 4,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['speaker', 'text'],
        properties: {
          speaker: { type: 'string', description: '話す側の名前。2匹のどちらかと完全に同じ文字列' },
          text: { type: 'string', maxLength: 40 },
        },
      },
    },
    gossip: { type: 'string', maxLength: 40, description: '相手について覚えておくこと1文' },
  },
} as const;

export interface PetTalkOutput {
  lines: { speaker: string; text: string }[];
  gossip: string;
}

export function parsePetTalk(json: unknown): PetTalkOutput | null {
  if (typeof json !== 'object' || json === null) return null;
  const o = json as Record<string, unknown>;
  if (!Array.isArray(o.lines)) return null;
  const lines: { speaker: string; text: string }[] = [];
  for (const raw of o.lines) {
    if (typeof raw !== 'object' || raw === null) continue;
    const l = raw as Record<string, unknown>;
    if (typeof l.speaker !== 'string' || typeof l.text !== 'string') continue;
    if (l.speaker.length === 0 || l.text.length === 0) continue;
    lines.push({ speaker: l.speaker, text: l.text });
  }
  if (lines.length === 0) return null;
  return { lines, gossip: typeof o.gossip === 'string' ? o.gossip : '' };
}
