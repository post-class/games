/**
 * LLMのモック応答（docs/02_ゲーム実装プラン/07_ペットAI設計.md §9）
 *
 * 目的:
 * - `--llm=mock` でコストをかけずに全機能を通す（E2E・日常開発）
 * - テストでタイムアウトやストリーミングUIを検証する
 *
 * 原則:
 * - **ネットワークを使わない**
 * - **`Math.random()` 禁止**。リクエスト内容のハッシュから決定論的に選ぶ
 *   （同じ入力なら常に同じ応答。E2Eのスナップショット比較が安定する）
 *
 * 制約:
 * - parameter property 禁止 / enum・namespace 禁止（Node の type-stripping で動かすため）
 */
import type { LlmMessage } from './client.ts';

/** モックの遅延設定。テストでタイムアウトを起こすために外から差し込む */
export interface MockOptions {
  /** 非ストリーミングの応答までの遅延 */
  delayMs?: number;
  /** ストリーミングの初トークンまでの遅延 */
  firstTokenDelayMs?: number;
  /** ストリーミングの1チャンクごとの遅延 */
  chunkDelayMs?: number;
  /** ストリーミングの1チャンクの文字数 */
  chunkChars?: number;
}

/** ペットの返事らしい日本語。ハッシュで選ぶので分布は入力依存 */
export const MOCK_REPLIES: readonly string[] = [
  'うん、モフィはここにいるよぉ。',
  'そのはなし、ちょっとおもしろいね。',
  'おなかすいたなぁ……なにかたべる？',
  'きのう見た虹、まだおぼえてるよ。',
  'ねむい……でも、もうすこしおきてる。',
  'いっしょに海のほうまで歩こうよ。',
  'それ、ぼくの好きなやつだ。',
  'こわくないよ。となりにいるから。',
  'きょうはいい天気だね、ひなたぼっこしたい。',
  'ありがとう。うれしいきもち、たまってく。',
];

/** FNV-1a（32bit）。決定論的な選択のためだけに使う */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i) & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** signal で中断できる sleep。0以下なら即 resolve（タイマを作らない） */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!(ms > 0)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function abortError(signal?: AbortSignal): Error {
  const reason: unknown = signal?.reason;
  if (reason instanceof Error) return reason;
  const err = new Error('aborted');
  err.name = 'AbortError';
  return err;
}

/**
 * スキーマを満たす最小限のJSONを作る。
 * enum があれば**先頭の値**、string は用途が分かる短文、number は minimum（なければ0）。
 * strict な json_schema を想定し、required だけでなく properties を全部埋める。
 */
export function mockJsonForSchema(schema: Record<string, unknown>, seed: number): unknown {
  const type = typeof schema['type'] === 'string' ? (schema['type'] as string) : undefined;
  const enumValues = Array.isArray(schema['enum']) ? (schema['enum'] as unknown[]) : undefined;
  if (enumValues && enumValues.length > 0) return enumValues[0];

  switch (type) {
    case 'object': {
      const props = isRecord(schema['properties']) ? schema['properties'] : {};
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(props)) {
        const child = props[key];
        out[key] = isRecord(child) ? mockJsonForSchema(child, seed + hashString(key)) : null;
      }
      return out;
    }
    case 'array': {
      const items = schema['items'];
      const minItems = typeof schema['minItems'] === 'number' ? schema['minItems'] : 0;
      const n = Math.max(minItems, 1);
      if (!isRecord(items)) return [];
      const out: unknown[] = [];
      for (let i = 0; i < n; i++) out.push(mockJsonForSchema(items, seed + i));
      return out;
    }
    case 'number':
    case 'integer': {
      const min = typeof schema['minimum'] === 'number' ? schema['minimum'] : 0;
      return type === 'integer' ? Math.round(min) : min;
    }
    case 'boolean':
      return true;
    case 'null':
      return null;
    default: {
      // string（type未指定もここ）。ハッシュで短文を選ぶ
      const idx = seed % MOCK_REPLIES.length;
      return MOCK_REPLIES[idx] ?? 'うん。';
    }
  }
}

/**
 * ペット同士の会話プロンプトから話者名を拾う。
 *
 * `speaker` が実際のペット名と一致しないと `petTalk.ts` が全行を捨てるので、
 * モックのままでは会話が起きない（安全側の設計が効いてしまう）。
 * E2Eと手元の確認でモックでも会話を見られるように、プロンプトから名前を読む。
 */
function petTalkSpeakers(messages: LlmMessage[]): string[] {
  const text = messages.map((m) => m.content).join('\n');
  const names: string[] = [];
  for (const m of text.matchAll(/^\[([12])匹目\]\s*(.+)$/gm)) {
    const name = (m[2] ?? '').trim();
    if (name.length > 0) names.push(name);
  }
  return names;
}

/** ペット同士の会話をモックで作る（話者名はプロンプトから拾う） */
function mockPetTalk(messages: LlmMessage[], seed: number): unknown | null {
  const names = petTalkSpeakers(messages);
  if (names.length < 2) return null;
  const [a, b] = names as [string, string];
  const lines = [
    { speaker: a, text: MOCK_REPLIES[seed % MOCK_REPLIES.length] ?? 'うん。' },
    { speaker: b, text: MOCK_REPLIES[(seed + 3) % MOCK_REPLIES.length] ?? 'そうだね。' },
    { speaker: a, text: MOCK_REPLIES[(seed + 7) % MOCK_REPLIES.length] ?? 'ふうん。' },
  ];
  return { lines, gossip: `${b}は${MOCK_REPLIES[(seed + 5) % MOCK_REPLIES.length] ?? 'げんきだった'}` };
}

/** スキーマがペット同士の会話用か（lines[].speaker を持つ） */
function isPetTalkSchema(schema: Record<string, unknown>): boolean {
  const props = isRecord(schema['properties']) ? schema['properties'] : {};
  const lines = props['lines'];
  if (!isRecord(lines)) return false;
  const items = isRecord(lines['items']) ? lines['items'] : {};
  const itemProps = isRecord(items['properties']) ? items['properties'] : {};
  return 'speaker' in itemProps && 'text' in itemProps;
}

/** モック応答の全文を作る。schema があればJSON文字列を返す */
export function mockText(messages: LlmMessage[], schema?: Record<string, unknown>): string {
  const seed = hashString(messages.map((m) => `${m.role}:${m.content}`).join('\n'));
  if (schema && isPetTalkSchema(schema)) {
    const talk = mockPetTalk(messages, seed);
    if (talk) return JSON.stringify(talk);
  }
  if (schema) return JSON.stringify(mockJsonForSchema(schema, seed));
  const idx = seed % MOCK_REPLIES.length;
  return MOCK_REPLIES[idx] ?? 'うん。';
}

/** 非ストリーミングのモック。遅延は signal で中断できる */
export async function mockComplete(
  messages: LlmMessage[],
  schema: Record<string, unknown> | undefined,
  opts: MockOptions,
  signal?: AbortSignal,
): Promise<string> {
  await sleep(opts.delayMs ?? 0, signal);
  return mockText(messages, schema);
}

/**
 * ストリーミングのモック。数文字ずつ onDelta を呼ぶ（会話UIの検証用）。
 * 初トークンまでの遅延を別に持てるので「初トークンタイムアウト」もテストできる。
 */
export async function mockStream(
  messages: LlmMessage[],
  schema: Record<string, unknown> | undefined,
  opts: MockOptions,
  onDelta: (delta: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const full = mockText(messages, schema);
  const size = Math.max(1, opts.chunkChars ?? 3);
  await sleep(opts.firstTokenDelayMs ?? opts.delayMs ?? 0, signal);
  for (let i = 0; i < full.length; i += size) {
    if (i > 0) await sleep(opts.chunkDelayMs ?? 0, signal);
    onDelta(full.slice(i, i + size));
  }
  return full;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
