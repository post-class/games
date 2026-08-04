import { isEmotion, isPetAction, type Emotion, type PetAction } from '../../shared/actions.js';
import { NEED_KEYS, type Needs, type PetReply } from '../../shared/types.js';
import type { MemoryWrite } from '../../shared/types.js';
import { isFactKey, MAX_EPISODE_LEN, MAX_FACT_VALUE_LEN } from '../pet/memory.js';

/**
 * LLM 応答の検証。ここが「画面が壊れない」保証の要。
 * 未知の action、壊れた JSON、暴れた数値はすべてここで安全側に落とす。
 */

/** ```json ... ``` で囲まれていたり前後に文章が付いていても拾えるようにする。 */
export function extractJson(raw: string): unknown {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    // 最初の { から最後の } までを試す。
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

export const MAX_SAY_LEN = 140;

function parseNeedsDelta(value: unknown): Partial<Needs> {
  if (!value || typeof value !== 'object') return {};
  const source = value as Record<string, unknown>;
  const out: Partial<Needs> = {};
  for (const key of NEED_KEYS) {
    const raw = source[key];
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      out[key] = Math.max(-25, Math.min(25, Math.round(raw)));
    }
  }
  return out;
}

function parseMemoryWrites(value: unknown): MemoryWrite[] {
  if (!Array.isArray(value)) return [];
  const out: MemoryWrite[] = [];
  for (const entry of value.slice(0, 4)) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const kind = record.kind;
    if (kind === 'fact') {
      const key = record.key;
      const factValue = record.value;
      if (!isFactKey(key)) continue;
      if (typeof factValue !== 'string' || !factValue.trim()) continue;
      out.push({ kind: 'fact', key, value: factValue.trim().slice(0, MAX_FACT_VALUE_LEN) });
    } else if (kind === 'episode') {
      const summary = record.summary;
      if (typeof summary !== 'string' || !summary.trim()) continue;
      const importanceRaw = record.importance;
      const importance =
        typeof importanceRaw === 'number' && Number.isFinite(importanceRaw)
          ? Math.max(1, Math.min(5, Math.round(importanceRaw)))
          : 3;
      const emotion = isEmotion(record.emotion) ? (record.emotion as Emotion) : undefined;
      const write: MemoryWrite = {
        kind: 'episode',
        summary: summary.trim().slice(0, MAX_EPISODE_LEN),
        importance,
      };
      if (emotion) write.emotion = emotion;
      out.push(write);
    }
  }
  return out;
}

export interface ParseOptions {
  fallbackAction?: PetAction;
  fallbackEmotion?: Emotion;
}

export interface ParseOutcome {
  reply: PetReply;
  /** 検証で落とした項目（ログ・テスト用）。 */
  issues: string[];
}

export function parsePetReply(raw: string, options: ParseOptions = {}): ParseOutcome {
  const issues: string[] = [];
  const parsed = extractJson(raw);

  if (!parsed || typeof parsed !== 'object') {
    issues.push('json-unparsable');
    return {
      reply: {
        say: '',
        emotion: options.fallbackEmotion ?? 'curious',
        action: options.fallbackAction ?? 'idle',
        needsDelta: {},
        memoryWrites: [],
        giftRequest: null,
      },
      issues,
    };
  }

  const record = parsed as Record<string, unknown>;

  let say = typeof record.say === 'string' ? record.say.trim() : '';
  if (!say) issues.push('say-missing');
  if (say.length > MAX_SAY_LEN) {
    say = say.slice(0, MAX_SAY_LEN);
    issues.push('say-truncated');
  }

  let emotion: Emotion;
  if (isEmotion(record.emotion)) {
    emotion = record.emotion;
  } else {
    emotion = options.fallbackEmotion ?? 'curious';
    issues.push('emotion-invalid');
  }

  let action: PetAction;
  if (isPetAction(record.action)) {
    action = record.action;
  } else {
    action = options.fallbackAction ?? 'idle';
    issues.push('action-invalid');
  }

  const giftRequestRaw = record.gift_request ?? record.giftRequest;
  const giftRequest =
    typeof giftRequestRaw === 'string' && giftRequestRaw.trim()
      ? giftRequestRaw.trim().slice(0, 40)
      : null;

  return {
    reply: {
      say,
      emotion,
      action,
      needsDelta: parseNeedsDelta(record.needs_delta ?? record.needsDelta),
      memoryWrites: parseMemoryWrites(record.memory_writes ?? record.memoryWrites),
      giftRequest,
    },
    issues,
  };
}

/** ペット同士の交流ログのパーサ。 */
export interface EncounterParsed {
  lines: Array<{ speaker: 'self' | 'other'; text: string }>;
  souvenirSelf: string;
  souvenirOther: string;
  affinityDelta: number;
  episodeSelf: string;
  episodeOther: string;
}

export function parseEncounter(raw: string): EncounterParsed | null {
  const parsed = extractJson(raw);
  if (!parsed || typeof parsed !== 'object') return null;
  const record = parsed as Record<string, unknown>;

  const rawLines = Array.isArray(record.lines) ? record.lines : [];
  const lines: Array<{ speaker: 'self' | 'other'; text: string }> = [];
  for (const entry of rawLines.slice(0, 12)) {
    if (!entry || typeof entry !== 'object') continue;
    const item = entry as Record<string, unknown>;
    const speaker = item.speaker === 'other' ? 'other' : item.speaker === 'self' ? 'self' : null;
    const text = typeof item.text === 'string' ? item.text.trim().slice(0, 120) : '';
    if (!speaker || !text) continue;
    lines.push({ speaker, text });
  }
  if (!lines.length) return null;

  const str = (value: unknown, max: number): string =>
    typeof value === 'string' ? value.trim().slice(0, max) : '';

  const affinityRaw = record.affinity_delta ?? record.affinityDelta;
  const affinityDelta =
    typeof affinityRaw === 'number' && Number.isFinite(affinityRaw)
      ? Math.max(-10, Math.min(10, Math.round(affinityRaw)))
      : 0;

  return {
    lines,
    souvenirSelf: str(record.souvenir_self ?? record.souvenirSelf, MAX_SAY_LEN),
    souvenirOther: str(record.souvenir_other ?? record.souvenirOther, MAX_SAY_LEN),
    affinityDelta,
    episodeSelf: str(record.episode_self ?? record.episodeSelf, MAX_EPISODE_LEN),
    episodeOther: str(record.episode_other ?? record.episodeOther, MAX_EPISODE_LEN),
  };
}
