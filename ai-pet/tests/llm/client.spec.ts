/**
 * llm/client.ts のテスト（docs 07章 §6）
 *
 * **実APIは絶対に叩かない**。`vi.stubGlobal('fetch', ...)` で偽の応答を返す。
 * 実測で判明した制約（temperature不可 / max_tokens不可）の回帰テストがここの主役。
 */
import { LLM } from '@ai-pet/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Budget } from '../../packages/server/src/llm/budget.ts';
import {
  LlmClient,
  estimateTokens,
  parseRetryAfter,
  type LlmClientOptions,
  type LlmRequest,
  type LlmUsage,
} from '../../packages/server/src/llm/client.ts';

const API_KEY = 'SUPER-SECRET-KEY-abcdef123456';

function client(over: Partial<LlmClientOptions> = {}): LlmClient {
  return new LlmClient({
    mode: 'real',
    endpoint: 'https://example.openai.azure.com', // 末尾スラッシュなし
    apiKey: API_KEY,
    apiVersion: '2025-04-01-preview',
    model: 'gpt-5.6-luna',
    ...over,
  });
}

function req(over: Partial<LlmRequest> = {}): LlmRequest {
  return {
    purpose: 'decide',
    messages: [
      { role: 'system', content: 'あなたはモフィです' },
      { role: 'user', content: 'こんにちは' },
    ],
    maxTokens: 120,
    ...over,
  };
}

function jsonRes(content: string, usage?: { prompt_tokens: number; completion_tokens: number }) {
  const body: Record<string, unknown> = { choices: [{ message: { content } }] };
  if (usage) body['usage'] = usage;
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function sseRes(chunks: string[]) {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (const s of chunks) c.enqueue(enc.encode(s));
      c.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function deltaEvent(text: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
}

/** 中断されたら reject する「返ってこない fetch」 */
function hangingFetch(): typeof fetch {
  return vi.fn((_url: unknown, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => {
        const e = new Error('The operation was aborted');
        e.name = 'AbortError';
        reject(e);
      });
    });
  }) as unknown as typeof fetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('LlmClient: 正常系', () => {
  it('テキストを返し、usage は実測値を使う', async () => {
    const fetchMock = vi.fn(async () => jsonRes('やあ！', { prompt_tokens: 42, completion_tokens: 7 }));
    vi.stubGlobal('fetch', fetchMock);
    const seen: LlmUsage[] = [];
    const c = client({ onUsage: (u) => seen.push(u) });

    const r = await c.complete(req({ playerId: 'p1' }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toBe('やあ！');
    expect(r.usage.promptTokens).toBe(42);
    expect(r.usage.completionTokens).toBe(7);
    expect(r.usage.estimated).toBe(false);
    expect(r.usage.playerId).toBe('p1');
    expect(r.usage.ok).toBe(true);
    expect(seen).toHaveLength(1);
  });

  it('URLは endpoint の末尾スラッシュを補い、api-key ヘッダを付ける', async () => {
    const fetchMock = vi.fn(async () => jsonRes('ok'));
    vi.stubGlobal('fetch', fetchMock);
    await client().complete(req());

    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe(
      'https://example.openai.azure.com/openai/deployments/gpt-5.6-luna/chat/completions?api-version=2025-04-01-preview',
    );
    const headers = call[1].headers as Record<string, string>;
    expect(headers['api-key']).toBe(API_KEY);
    expect(headers['content-type']).toBe('application/json');
  });

  it('末尾スラッシュ付きの endpoint でもURLが二重にならない', async () => {
    const fetchMock = vi.fn(async () => jsonRes('ok'));
    vi.stubGlobal('fetch', fetchMock);
    await client({ endpoint: 'https://example.openai.azure.com/' }).complete(req());
    const url = (fetchMock.mock.calls[0] as unknown as [string])[0];
    expect(url).not.toContain('//openai');
  });

  it('【回帰】ボディに temperature と max_tokens を含めない（実測で400になる）', async () => {
    const fetchMock = vi.fn(async () => jsonRes('ok'));
    vi.stubGlobal('fetch', fetchMock);
    await client().complete(req({ maxTokens: 99 }));

    const raw = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string;
    const body = JSON.parse(raw) as Record<string, unknown>;
    expect('temperature' in body).toBe(false);
    expect('max_tokens' in body).toBe(false);
    expect(body['max_completion_tokens']).toBe(99);
    expect(body['stream']).toBe(false);
    expect(raw).not.toMatch(/temperature/);
    expect(raw).not.toMatch(/"max_tokens"/);
  });

  it('schema を渡すと response_format: json_schema(strict) を送る', async () => {
    const fetchMock = vi.fn(async () => jsonRes('{"goal":"follow_owner"}'));
    vi.stubGlobal('fetch', fetchMock);
    const schema = {
      type: 'object',
      properties: { goal: { type: 'string', enum: ['follow_owner', 'explore'] } },
      required: ['goal'],
      additionalProperties: false,
    };
    await client().complete(req({ schema }));

    const raw = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string;
    const body = JSON.parse(raw) as Record<string, unknown>;
    expect(body['response_format']).toEqual({
      type: 'json_schema',
      json_schema: { name: 'intent', strict: true, schema },
    });
  });

  it('usage が無ければ概算し、estimated を立てる', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes('みじかい返事')));
    const r = await client().complete(req());
    expect(r.ok).toBe(true);
    expect(r.usage.estimated).toBe(true);
    expect(r.usage.completionTokens).toBeGreaterThan(0);
    expect(r.usage.promptTokens).toBeGreaterThan(0);
  });
});

describe('LlmClient: ストリーミング', () => {
  it('onDelta で差分を受け取り、全文を返す', async () => {
    const fetchMock = vi.fn(async () =>
      sseRes([deltaEvent('こん'), deltaEvent('にち'), deltaEvent('は'), 'data: [DONE]\n\n']),
    );
    vi.stubGlobal('fetch', fetchMock);
    const deltas: string[] = [];
    const r = await client().stream(req({ purpose: 'dialogue' }), (d) => deltas.push(d));

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toBe('こんにちは');
    expect(deltas).toEqual(['こん', 'にち', 'は']);
    const raw = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string;
    expect(JSON.parse(raw)['stream']).toBe(true);
  });

  it('SSEが行の途中で分割されても正しく組み立てる', async () => {
    const full = deltaEvent('ぽこ') + deltaEvent('もふ') + 'data: [DONE]\n\n';
    // 1〜7文字ずつのぶつ切りにする（改行やJSONの途中で切れる）
    const pieces: string[] = [];
    let i = 0;
    let n = 1;
    while (i < full.length) {
      pieces.push(full.slice(i, i + n));
      i += n;
      n = (n % 7) + 1;
    }
    vi.stubGlobal('fetch', vi.fn(async () => sseRes(pieces)));

    const deltas: string[] = [];
    const r = await client().stream(req({ purpose: 'dialogue' }), (d) => deltas.push(d));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toBe('ぽこもふ');
    expect(deltas.join('')).toBe('ぽこもふ');
  });

  it('[DONE] が来ないまま終わっても取れた分は成功にする', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseRes([deltaEvent('とぎれた')])));
    const r = await client().stream(req({ purpose: 'dialogue' }), () => {});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toBe('とぎれた');
  });

  it('壊れたSSE行は無視して会話を続ける', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseRes(['data: {壊れたJSON\n\n', ': コメント行\n', deltaEvent('だいじょうぶ'), 'data: [DONE]\n\n']),
      ),
    );
    const r = await client().stream(req({ purpose: 'dialogue' }), () => {});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toBe('だいじょうぶ');
  });

  it('初トークンが遅いと firstToken タイムアウトで失敗する', async () => {
    vi.useFakeTimers();
    // 開くだけで何も流さないストリーム
    const stream = new ReadableStream<Uint8Array>({ start() {} });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(stream, { status: 200 })),
    );
    const c = client();
    const p = c.stream(req({ purpose: 'dialogue' }), () => {});
    await vi.advanceTimersByTimeAsync(LLM.timeoutMs.firstToken + 50);
    const r = await p;
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errorKind).toBe('timeout');
      expect(r.message).toContain('初トークン');
    }
  });
});

describe('LlmClient: 再試行', () => {
  it('429 は再試行し、Retry-After を尊重する', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(
      new Response('{"error":"too many"}', { status: 429, headers: { 'retry-after': '2' } }),
    );
    fetchMock.mockResolvedValueOnce(jsonRes('まてた'));
    vi.stubGlobal('fetch', fetchMock);

    const p = client().complete(req());
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(1); // Retry-After=2秒 なのでまだ再送しない
    await vi.advanceTimersByTimeAsync(1100);
    const r = await p;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(r.ok).toBe(true);
  });

  it('5xx は最大2回まで再試行し、最後は http で諦める', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response('boom', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);

    const p = client().complete(req({ purpose: 'diary' }));
    await vi.advanceTimersByTimeAsync(5000);
    const r = await p;
    expect(fetchMock).toHaveBeenCalledTimes(3); // 初回 + 2回
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorKind).toBe('http');
  });

  it('400 は再試行しない（パラメータ不正を叩き続けない）', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ error: { message: "Unsupported parameter: 'max_tokens'" } }),
          { status: 400 },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const r = await client().complete(req());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errorKind).toBe('http');
      expect(r.message).toContain('400');
    }
  });

  it('タイムアウトで errorKind:timeout', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', hangingFetch());
    const p = client().complete(req({ purpose: 'decide' }));
    await vi.advanceTimersByTimeAsync(LLM.timeoutMs.decide + 100);
    const r = await p;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorKind).toBe('timeout');
  });

  it('呼び出し側の AbortSignal は abort として返す', async () => {
    vi.stubGlobal('fetch', hangingFetch());
    const ac = new AbortController();
    const p = client().complete(req({ signal: ac.signal }));
    ac.abort();
    const r = await p;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorKind).toBe('abort');
  });

  it('choices が無い応答は parse で失敗する', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"nope":1}', { status: 200 })),
    );
    const r = await client().complete(req());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorKind).toBe('parse');
  });
});

describe('LlmClient: サーキットブレーカ', () => {
  it('失敗が続くと開き、openMs 経過で閉じる', async () => {
    let t = 1_000_000;
    const fetchMock = vi.fn(async () => new Response('bad', { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const c = client({ now: () => t });

    for (let i = 0; i < LLM.breaker.window; i++) {
      const r = await c.complete(req());
      expect(r.ok).toBe(false);
    }
    expect(c.health().open).toBe(true);
    const calls = fetchMock.mock.calls.length;

    // 開いている間は呼ばずに即 breaker
    const blocked = await c.complete(req());
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.errorKind).toBe('breaker');
    expect(fetchMock.mock.calls.length).toBe(calls);

    // 時間が経つと閉じて、また呼びに行く
    t += LLM.breaker.openMs + 1;
    expect(c.health().open).toBe(false);
    const after = await c.complete(req());
    expect(fetchMock.mock.calls.length).toBe(calls + 1);
    if (!after.ok) expect(after.errorKind).toBe('http');
  });

  it('成功が混じって失敗率が閾値以下なら開かない', async () => {
    const fetchMock = vi.fn();
    for (let i = 0; i < LLM.breaker.window; i++) {
      if (i % 2 === 0) fetchMock.mockResolvedValueOnce(new Response('bad', { status: 400 }));
      else fetchMock.mockResolvedValueOnce(jsonRes('ok'));
    }
    vi.stubGlobal('fetch', fetchMock);
    const c = client();
    for (let i = 0; i < LLM.breaker.window; i++) await c.complete(req());
    expect(c.health().recentFailRatio).toBeCloseTo(0.5, 5);
    expect(c.health().open).toBe(false); // 「超えたら」なのでちょうど0.5では開かない
  });
});

describe('LlmClient: mode', () => {
  it("mode:'fail' は必ず失敗し、ネットワークを使わない", async () => {
    const fetchMock = vi.fn(() => {
      throw new Error('呼んではいけない');
    });
    vi.stubGlobal('fetch', fetchMock);
    const c = client({ mode: 'fail' });
    const r = await c.complete(req());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorKind).toBe('mode');
    const s = await c.stream(req(), () => {});
    expect(s.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("mode:'mock' はネットワークを使わず決定論的に答える", async () => {
    const fetchMock = vi.fn(() => {
      throw new Error('呼んではいけない');
    });
    vi.stubGlobal('fetch', fetchMock);
    const c = client({ mode: 'mock' });

    const a = await c.complete(req());
    const b = await c.complete(req());
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.text).toBe(b.text);
      expect(a.text.length).toBeGreaterThan(0);
    }
    // 入力が変われば応答も変わりうる（同じ入力→同じ応答が保証されていればよい）
    const other = await c.complete(
      req({ messages: [{ role: 'user', content: 'ぜんぜんちがう話' }] }),
    );
    expect(other.ok).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(a.usage.estimated).toBe(true);
  });

  it("mode:'mock' + schema はスキーマを満たすJSONを返す", async () => {
    const c = client({ mode: 'mock' });
    const schema = {
      type: 'object',
      properties: {
        goal: { type: 'string', enum: ['follow_owner', 'explore'] },
        reason: { type: 'string' },
        priority: { type: 'integer', minimum: 1 },
      },
      required: ['goal', 'reason', 'priority'],
      additionalProperties: false,
    };
    const r = await c.complete(req({ schema }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      const parsed = JSON.parse(r.text) as Record<string, unknown>;
      expect(parsed['goal']).toBe('follow_owner');
      expect(typeof parsed['reason']).toBe('string');
      expect(parsed['priority']).toBe(1);
    }
  });

  it("mode:'mock' のストリーミングは数文字ずつ届く", async () => {
    const c = client({ mode: 'mock', mock: { chunkChars: 2 } });
    const deltas: string[] = [];
    const r = await c.stream(req({ purpose: 'dialogue' }), (d) => deltas.push(d));
    expect(r.ok).toBe(true);
    expect(deltas.length).toBeGreaterThan(1);
    if (r.ok) expect(deltas.join('')).toBe(r.text);
  });

  it("mode:'mock' の遅延でタイムアウトを検証できる", async () => {
    vi.useFakeTimers();
    const c = client({ mode: 'mock', mock: { delayMs: LLM.timeoutMs.decide + 1000 } });
    const p = c.complete(req({ purpose: 'decide' }));
    await vi.advanceTimersByTimeAsync(LLM.timeoutMs.decide + 100);
    const r = await p;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorKind).toBe('timeout');
  });
});

describe('LlmClient: 秘密情報', () => {
  it('APIキーがエラーメッセージに出ない', async () => {
    // 応答本文とfetchの例外の両方にキーが混じるひどいケースを作る
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(
      new Response(`{"error":"bad api-key ${API_KEY}"}`, { status: 400 }),
    );
    fetchMock.mockRejectedValueOnce(new Error(`connect failed key=${API_KEY}`));
    vi.stubGlobal('fetch', fetchMock);
    const c = client();

    const a = await c.complete(req());
    const b = await c.complete(req());
    for (const r of [a, b]) {
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.message).not.toContain(API_KEY);
        expect(r.message).toContain('***');
      }
    }
  });

  it('stats / health にキーが出ない', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes('ok')));
    const c = client();
    await c.complete(req());
    const dumped = JSON.stringify([c.stats(), c.health()]);
    expect(dumped).not.toContain(API_KEY);
  });

  it('ログにキーが出ない', async () => {
    const lines: string[] = [];
    for (const level of ['log', 'warn', 'error'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        lines.push(args.map((a) => String(a)).join(' '));
      });
    }
    let t = 0;
    const c = client({ now: () => (t += 1) });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(`nope ${API_KEY}`, { status: 400 })),
    );
    for (let i = 0; i < LLM.breaker.window + 1; i++) await c.complete(req());
    expect(lines.join('\n')).not.toContain(API_KEY);
  });
});

describe('LlmClient: 予算との連携', () => {
  it('予算切れは errorKind:rate になり、ネットワークを使わない', async () => {
    const fetchMock = vi.fn(async () => jsonRes('ok'));
    vi.stubGlobal('fetch', fetchMock);
    const budget = new Budget({ perPlayerPerHour: 1 });
    const c = client({ budget });

    expect((await c.complete(req({ playerId: 'p1' }))).ok).toBe(true);
    const over = await c.complete(req({ playerId: 'p1' }));
    expect(over.ok).toBe(false);
    if (!over.ok) {
      expect(over.errorKind).toBe('rate');
      expect(over.message).toContain('player_rate');
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('成功後に同時実行枠が返る（release 漏れがない）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes('ok')));
    const budget = new Budget({ maxConcurrent: 1, queueWaitMs: 50 });
    const c = client({ budget });
    for (let i = 0; i < 3; i++) expect((await c.complete(req())).ok).toBe(true);
    expect(c.health().inFlight).toBe(0);
    expect(c.health().queued).toBe(0);
  });

  it('失敗しても同時実行枠が返る', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('bad', { status: 400 })),
    );
    const budget = new Budget({ maxConcurrent: 1, queueWaitMs: 50 });
    const c = client({ budget });
    for (let i = 0; i < 3; i++) expect((await c.complete(req())).ok).toBe(false);
    expect(c.health().inFlight).toBe(0);
  });

  it('onUsage は成功も失敗も記録する', async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(jsonRes('ok', { prompt_tokens: 5, completion_tokens: 2 }));
    fetchMock.mockResolvedValueOnce(new Response('bad', { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);
    const seen: LlmUsage[] = [];
    const c = client({ onUsage: (u) => seen.push(u) });
    await c.complete(req({ playerId: 'p1', purpose: 'dialogue' }));
    await c.complete(req({ purpose: 'diary' }));

    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ purpose: 'dialogue', playerId: 'p1', ok: true });
    expect(seen[1]).toMatchObject({ purpose: 'diary', ok: false, errorKind: 'http' });
    expect(seen[1]?.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('onUsage が例外を投げてもゲームを止めない', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes('ok')));
    const c = client({
      onUsage: () => {
        throw new Error('DB書き込み失敗');
      },
    });
    const r = await c.complete(req());
    expect(r.ok).toBe(true);
  });
});

describe('ヘルパ', () => {
  it('parseRetryAfter は秒数とHTTP-dateを読む', () => {
    expect(parseRetryAfter('2', 0)).toBe(2000);
    expect(parseRetryAfter(null, 0)).toBe(null);
    expect(parseRetryAfter('', 0)).toBe(null);
    expect(parseRetryAfter('とんでもない値', 0)).toBe(null);
    const now = Date.parse('2026-08-07T00:00:00Z');
    expect(parseRetryAfter('Fri, 07 Aug 2026 00:00:03 GMT', now)).toBe(3000);
    expect(parseRetryAfter('Fri, 07 Aug 2026 00:00:00 GMT', now + 5000)).toBe(0);
  });

  it('estimateTokens は日本語と英語で違う密度を使う', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('こんにちは')).toBeGreaterThanOrEqual(3);
  });
});
