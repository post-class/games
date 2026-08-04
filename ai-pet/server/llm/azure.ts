import { env, hasLlm } from '../env.js';

/**
 * Azure OpenAI の chat completions を fetch で直接叩く（SDK を入れない）。
 * この関数はテストから差し替えられるよう、モジュール変数で保持している。
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  /** 構造化出力のための JSON Schema（対応していなければ JSON モードに落ちる）。 */
  jsonSchema?: { name: string; schema: Record<string, unknown> };
  maxTokens?: number;
  temperature?: number;
}

export type ChatFn = (request: ChatRequest) => Promise<string>;

export class LlmUnavailableError extends Error {}

async function postChat(request: ChatRequest, useSchema: boolean): Promise<string> {
  const base = env.azure.endpoint.replace(/\/+$/, '');
  const url = `${base}/openai/deployments/${encodeURIComponent(env.azure.deployment)}/chat/completions?api-version=${encodeURIComponent(env.azure.apiVersion)}`;

  const body: Record<string, unknown> = {
    messages: request.messages,
    max_completion_tokens: request.maxTokens ?? 700,
  };
  if (typeof request.temperature === 'number') {
    body.temperature = request.temperature;
  }
  if (request.jsonSchema) {
    body.response_format = useSchema
      ? {
          type: 'json_schema',
          json_schema: {
            name: request.jsonSchema.name,
            strict: true,
            schema: request.jsonSchema.schema,
          },
        }
      : { type: 'json_object' };
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': env.azure.apiKey },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    const error = new Error(`Azure OpenAI ${response.status}: ${detail.slice(0, 400)}`);
    // 400 系はリクエスト内容の問題なので、呼び出し側でフォールバック判定できるよう型を残す。
    (error as Error & { status?: number }).status = response.status;
    throw error;
  }

  const json = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = json.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('Azure OpenAI: 応答が空でした');
  }
  return content;
}

/**
 * json_schema 未対応デプロイでも動くよう、400 が返ったら JSON モードで1回だけ再試行する。
 */
export const realChat: ChatFn = async (request) => {
  if (!hasLlm()) {
    throw new LlmUnavailableError('Azure OpenAI の接続情報が設定されていません');
  }
  try {
    return await postChat(request, true);
  } catch (error) {
    const status = (error as Error & { status?: number }).status;
    if (request.jsonSchema && status === 400) {
      return await postChat(request, false);
    }
    throw error;
  }
};

let current: ChatFn = realChat;

export function chat(request: ChatRequest): Promise<string> {
  return current(request);
}

/** テストやオフライン開発でフェイクに差し替える。 */
export function setChatFn(fn: ChatFn): void {
  current = fn;
}

export function resetChatFn(): void {
  current = realChat;
}
