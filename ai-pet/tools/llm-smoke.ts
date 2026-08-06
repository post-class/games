/**
 * Azure OpenAI の疎通と capability 確認（docs/02_ゲーム実装プラン/07_ペットAI設計.md §6）
 *
 * 実行: npm run llm:smoke
 * 結果は .tmp/llm-capabilities.json に保存し、llm/client.ts が起動時に参照できる形にする。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { env, envSummary } from '../packages/server/src/env.ts';

interface ProbeResult {
  name: string;
  ok: boolean;
  status?: number;
  latencyMs: number;
  note: string;
}

const url = `${env.azureEndpoint.replace(/\/$/, '')}/openai/deployments/${env.petModel}/chat/completions?api-version=${env.azureApiVersion}`;

async function post(body: unknown, timeoutMs = 30_000): Promise<{ status: number; text: string; latencyMs: number }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const t0 = performance.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'api-key': env.azureApiKey, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const text = await res.text();
    return { status: res.status, text, latencyMs: Math.round(performance.now() - t0) };
  } finally {
    clearTimeout(timer);
  }
}

const messages = [
  { role: 'system', content: 'あなたは島に住む小さな生きものです。1文で短く答えてください。' },
  { role: 'user', content: 'おはよう' },
];

const results: ProbeResult[] = [];

function record(name: string, ok: boolean, latencyMs: number, note: string, status?: number): void {
  results.push({ name, ok, latencyMs, note, ...(status !== undefined ? { status } : {}) });
  console.log(`${ok ? '✅' : '❌'} ${name.padEnd(24)} ${String(status ?? '').padStart(3)} ${latencyMs}ms  ${note}`);
}

/** 応答の本文をそのまま取り出す（切り詰めない） */
function fullContent(text: string): string {
  try {
    const j = JSON.parse(text) as { choices?: { message?: { content?: string } }[] };
    return j.choices?.[0]?.message?.content ?? '';
  } catch {
    return text;
  }
}

/** ログ表示用（切り詰める） */
function firstContent(text: string): string {
  return fullContent(text).slice(0, 60).replace(/\n/g, ' ');
}

function errMessage(text: string): string {
  try {
    const j = JSON.parse(text) as { error?: { message?: string; code?: string } };
    return (j.error?.message ?? text).slice(0, 160).replace(/\n/g, ' ');
  } catch {
    return text.slice(0, 160).replace(/\n/g, ' ');
  }
}

console.log('--- 環境 ---');
console.table(envSummary());
console.log(`endpoint: ${url.replace(/api-version=.*/, 'api-version=…')}`);
console.log('--- プローブ ---');

if (!env.azureEndpoint || !env.azureApiKey) {
  console.error('AZURE_OPENAI_ENDPOINT / AZURE_OPENAI_API_KEY が未設定です。.env を確認してください。');
  process.exit(1);
}

// 1. 最小の呼び出し
const base = await post({ messages });
record('basic', base.status === 200, base.latencyMs, base.status === 200 ? firstContent(base.text) : errMessage(base.text), base.status);

// 2. max_completion_tokens
const mct = await post({ messages, max_completion_tokens: 64 });
record('max_completion_tokens', mct.status === 200, mct.latencyMs, mct.status === 200 ? 'ok' : errMessage(mct.text), mct.status);

// 3. max_tokens（旧パラメータ）
const mt = await post({ messages, max_tokens: 64 });
record('max_tokens', mt.status === 200, mt.latencyMs, mt.status === 200 ? 'ok' : errMessage(mt.text), mt.status);

// 4. temperature
const temp = await post({ messages, temperature: 0.9 });
record('temperature', temp.status === 200, temp.latencyMs, temp.status === 200 ? 'ok' : errMessage(temp.text), temp.status);

// 5. structured output (json_schema)
const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['goal', 'reason'],
  properties: {
    goal: { type: 'string', enum: ['follow_owner', 'explore', 'rest'] },
    reason: { type: 'string' },
  },
};
const js = await post({
  messages: [
    { role: 'system', content: 'あなたはペットです。次の行動をJSONで返してください。' },
    { role: 'user', content: 'いま朝で、オーナーが近くにいます。' },
  ],
  response_format: { type: 'json_schema', json_schema: { name: 'intent', strict: true, schema } },
});
let jsonSchemaOk = false;
if (js.status === 200) {
  const content = fullContent(js.text);
  try {
    const obj = JSON.parse(content) as { goal?: string };
    jsonSchemaOk = typeof obj.goal === 'string';
  } catch {
    jsonSchemaOk = false;
  }
  record('json_schema', jsonSchemaOk, js.latencyMs, content.slice(0, 60).replace(/\n/g, ' '), js.status);
} else {
  record('json_schema', false, js.latencyMs, errMessage(js.text), js.status);
}

// 6. json_object（json_schema非対応時のフォールバック候補）
const jo = await post({
  messages: [
    { role: 'system', content: 'JSONのみを返してください。形式: {"goal":"explore","reason":"..."}' },
    { role: 'user', content: 'いま朝です。' },
  ],
  response_format: { type: 'json_object' },
});
record('json_object', jo.status === 200, jo.latencyMs, jo.status === 200 ? firstContent(jo.text) : errMessage(jo.text), jo.status);

// 7. streaming（初トークンまでの時間を測る）
let streamOk = false;
let firstTokenMs = 0;
let streamNote = '';
{
  const t0 = performance.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 30_000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'api-key': env.azureApiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ messages, stream: true }),
      signal: ac.signal,
    });
    if (res.ok && res.body) {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let acc = '';
      let chunks = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks++;
        if (firstTokenMs === 0) firstTokenMs = Math.round(performance.now() - t0);
        acc += dec.decode(value, { stream: true });
        if (acc.includes('[DONE]')) break;
        if (chunks > 200) break;
      }
      streamOk = chunks > 1;
      streamNote = `chunks=${chunks} firstToken=${firstTokenMs}ms`;
    } else {
      streamNote = errMessage(await res.text());
    }
    record('stream', streamOk, Math.round(performance.now() - t0), streamNote, res.status);
  } catch (e) {
    record('stream', false, Math.round(performance.now() - t0), String(e));
  } finally {
    clearTimeout(timer);
  }
}

const capabilities = {
  probedAt: new Date().toISOString(),
  model: env.petModel,
  apiVersion: env.azureApiVersion,
  supportsBasic: base.status === 200,
  supportsMaxCompletionTokens: mct.status === 200,
  supportsMaxTokens: mt.status === 200,
  supportsTemperature: temp.status === 200,
  supportsJsonSchema: jsonSchemaOk,
  supportsJsonObject: jo.status === 200,
  supportsStream: streamOk,
  firstTokenMs,
  results,
};

const out = resolve(import.meta.dirname, '../.tmp/llm-capabilities.json');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(capabilities, null, 2));
console.log(`\n結果を保存しました: ${out}`);

if (!capabilities.supportsBasic) {
  console.error('\n❌ 基本の呼び出しが失敗しています。エンドポイント・キー・デプロイ名を確認してください。');
  process.exit(1);
}
console.log('\n✅ 疎通OK');
