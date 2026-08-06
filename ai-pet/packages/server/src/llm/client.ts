/**
 * Azure OpenAI クライアント（docs/02_ゲーム実装プラン/07_ペットAI設計.md §6-§8）
 *
 * ここが落ちてもゲームは続く、というのが最優先の設計方針。
 * よって**例外を投げない**。すべて `LlmResult` で返し、呼び出し側はフォールバックへ落ちるだけでよい。
 *
 * 実測で判明した制約（`.tmp/llm-capabilities.json` / gpt-5.6-luna / 2025-04-01-preview）:
 * - `temperature` は 400（既定値1のみ）→ **絶対に送らない**。発話の多様性はプロンプトで作る
 * - `max_tokens` は 400 → `max_completion_tokens` を使う
 * - `json_schema`(strict) / `json_object` / `stream` は利用可。初トークン 0.7〜0.9秒
 *
 * 守っていること:
 * - 429/5xx のみ指数バックオフで最大2回再試行（`Retry-After` を尊重）。4xxは再試行しない
 * - 直近 `LLM.breaker.window` 回の失敗率が閾値超なら `openMs` の間は呼ばない（サーキットブレーカ）
 * - APIキーはログにもエラーメッセージにも出さない（`redact()` を必ず通す）
 * - `Math.random()` 禁止。バックオフのジッタは呼び出し回数から決定論的に作る
 *
 * 制約:
 * - parameter property 禁止 / enum・namespace 禁止（Node の type-stripping で動かすため）
 */
import { LLM } from '@ai-pet/shared';
import type { Budget } from './budget.ts';
import { mockComplete, mockStream, type MockOptions } from './mock.ts';

export type LlmPurpose = 'dialogue' | 'decide' | 'diary' | 'gossip';

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmRequest {
  purpose: LlmPurpose;
  messages: LlmMessage[];
  maxTokens: number;
  /** JSON Schema。渡すと構造化出力を要求する */
  schema?: Record<string, unknown>;
  /** ストリーミング（会話用） */
  stream?: boolean;
  /** 呼び出し元のプレイヤー（予算管理と使用量記録に使う） */
  playerId?: string;
  signal?: AbortSignal;
}

export interface LlmUsage {
  purpose: LlmPurpose;
  playerId?: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  ok: boolean;
  /** 失敗の理由（timeout/rate/http/parse/breaker/mode/abort） */
  errorKind?: string;
  /**
   * トークン数がレスポンスの `usage` ではなく文字数からの**概算**であることを示す。
   * ストリーミングは usage が返らないので基本 true になる。
   * （集計時に実測と概算を混ぜて誤解しないための印）
   */
  estimated?: boolean;
}

export type LlmResult =
  | { ok: true; text: string; usage: LlmUsage }
  | { ok: false; errorKind: string; message: string; usage: LlmUsage };

export interface LlmClientOptions {
  mode: 'real' | 'mock' | 'fail';
  endpoint: string;
  apiKey: string;
  apiVersion: string;
  model: string;
  /** 使用量の記録先（DBへの書き込みは呼び出し側の責務） */
  onUsage?: (usage: LlmUsage) => void;
  /** 予算管理。省略時は無制限 */
  budget?: Budget;
  /** モックの遅延設定（テスト用）。mode:'mock' のときだけ効く */
  mock?: MockOptions;
  /** テストから時刻を注入する（ブレーカが時間で閉じることの検証用） */
  now?: () => number;
  /** fetch の差し替え（テスト用。省略時はグローバルの fetch を都度参照する） */
  fetchImpl?: typeof fetch;
}

/** purpose → LLM.timeoutMs のキー。gossip（ペット間会話）は petTalk を使う */
const TIMEOUT_KEY: Record<LlmPurpose, 'dialogue' | 'decide' | 'diary' | 'petTalk'> = {
  dialogue: 'dialogue',
  decide: 'decide',
  diary: 'diary',
  gossip: 'petTalk',
};

/** 429/5xx の再試行間隔（ms）。Retry-After があればそちらを優先する */
const BACKOFF_MS: readonly number[] = [500, 1000, 2000];
/** 再試行の最大回数（初回を含めない） */
const MAX_RETRIES = 2;
/** Retry-After を尊重しつつ、これ以上は待たない */
const MAX_RETRY_AFTER_MS = 5000;

export class LlmClient {
  private mode: 'real' | 'mock' | 'fail';
  private endpoint: string;
  private apiKey: string;
  private apiVersion: string;
  private model: string;
  private onUsage: ((usage: LlmUsage) => void) | undefined;
  private budget: Budget | undefined;
  private mockOpts: MockOptions;
  private now: () => number;
  private fetchImpl: typeof fetch | undefined;

  /** 直近の成否（true=成功）。長さは LLM.breaker.window で打ち切る */
  private outcomes: boolean[] = [];
  /** ブレーカが閉じる時刻（0なら閉じている） */
  private openUntil = 0;
  private inFlight = 0;
  /** 決定論的なジッタのための呼び出し連番 */
  private seq = 0;

  private counters = {
    calls: 0,
    ok: 0,
    fail: 0,
    retries: 0,
    breakerOpens: 0,
    promptTokens: 0,
    completionTokens: 0,
    estimatedCalls: 0,
  };
  private byPurpose = new Map<LlmPurpose, number>();
  private byErrorKind = new Map<string, number>();

  // 注意: Node の type-stripping で動かすため parameter property は使えない
  constructor(opts: LlmClientOptions) {
    this.mode = opts.mode;
    this.endpoint = opts.endpoint;
    this.apiKey = opts.apiKey;
    this.apiVersion = opts.apiVersion;
    this.model = opts.model;
    this.onUsage = opts.onUsage;
    this.budget = opts.budget;
    this.mockOpts = opts.mock ?? {};
    this.now = opts.now ?? (() => Date.now());
    this.fetchImpl = opts.fetchImpl;
  }

  /** 1回の呼び出し。失敗しても例外を投げず結果で返す */
  async complete(req: LlmRequest): Promise<LlmResult> {
    return this.run(req, null);
  }

  /** ストリーミング。onDelta で差分を受け取る。戻り値は全文 */
  async stream(req: LlmRequest, onDelta: (delta: string) => void): Promise<LlmResult> {
    return this.run({ ...req, stream: true }, onDelta);
  }

  /** サーキットブレーカの状態（メトリクス用） */
  health(): { open: boolean; recentFailRatio: number; inFlight: number; queued: number } {
    const load = this.budget?.load();
    return {
      open: this.isBreakerOpen(),
      recentFailRatio: this.failRatio(),
      inFlight: load?.inFlight ?? this.inFlight,
      queued: load?.queued ?? 0,
    };
  }

  stats(): Record<string, unknown> {
    return {
      mode: this.mode,
      model: this.model,
      ...this.counters,
      byPurpose: Object.fromEntries(this.byPurpose),
      byErrorKind: Object.fromEntries(this.byErrorKind),
      breaker: {
        open: this.isBreakerOpen(),
        recentFailRatio: this.failRatio(),
        samples: this.outcomes.length,
        opensUntil: this.openUntil,
      },
      budget: this.budget?.stats(),
    };
  }

  /** 実際に叩くURL（テストとデバッグ表示用。キーは含まれない） */
  requestUrl(): string {
    const base = this.endpoint.endsWith('/') ? this.endpoint : `${this.endpoint}/`;
    return `${base}openai/deployments/${this.model}/chat/completions?api-version=${this.apiVersion}`;
  }

  // ---------- 本体 ----------

  private async run(
    req: LlmRequest,
    onDelta: ((delta: string) => void) | null,
  ): Promise<LlmResult> {
    const startedAt = this.now();
    this.counters.calls++;
    this.byPurpose.set(req.purpose, (this.byPurpose.get(req.purpose) ?? 0) + 1);

    if (this.mode === 'fail') {
      return this.reject(req, startedAt, 'mode', 'mode:fail のため常に失敗する');
    }

    // ブレーカは予算より先に見る（開いているなら枠を消費しない）
    if (this.mode === 'real' && this.isBreakerOpen()) {
      return this.reject(req, startedAt, 'breaker', 'サーキットブレーカが開いている');
    }

    // 予算はコストが実際に出る real のみ。mock は無料なので数えない（E2Eで詰まらせない）
    let release: () => void = () => {};
    if (this.mode === 'real' && this.budget) {
      const grant = await this.budget.tryAcquire(req.purpose, req.playerId);
      if (!grant.ok) {
        return this.reject(req, startedAt, 'rate', `予算の上限に達した（${grant.reason}）`);
      }
      release = grant.release;
    }

    this.inFlight++;
    try {
      if (this.mode === 'mock') return await this.runMock(req, onDelta, startedAt);
      return await this.runReal(req, onDelta, startedAt);
    } finally {
      this.inFlight = Math.max(0, this.inFlight - 1);
      release(); // release の呼び忘れで同時実行枠が枯れないよう必ずここで返す
    }
  }

  // ---------- mock ----------

  private async runMock(
    req: LlmRequest,
    onDelta: ((delta: string) => void) | null,
    startedAt: number,
  ): Promise<LlmResult> {
    const t = this.timeouts(req.purpose);
    const gate = this.openGate(req.signal, t.total);
    try {
      const text = onDelta
        ? await mockStream(req.messages, req.schema, this.mockOpts, onDelta, gate.signal)
        : await mockComplete(req.messages, req.schema, this.mockOpts, gate.signal);
      return this.accept(req, startedAt, text, undefined, undefined);
    } catch (e) {
      const kind = gate.timedOut ? 'timeout' : req.signal?.aborted ? 'abort' : 'http';
      return this.reject(req, startedAt, kind, describe(e));
    } finally {
      gate.dispose();
    }
  }

  // ---------- real ----------

  private async runReal(
    req: LlmRequest,
    onDelta: ((delta: string) => void) | null,
    startedAt: number,
  ): Promise<LlmResult> {
    const t = this.timeouts(req.purpose);
    const url = this.requestUrl();
    const body = this.buildBody(req, onDelta !== null);
    const payload = JSON.stringify(body);

    // 全試行の合計にこのタイムアウトを効かせる（ユーザ体験としての待ち時間の上限）
    const gate = this.openGate(req.signal, t.total);
    try {
      for (let attempt = 0; ; attempt++) {
        let res: Response;
        try {
          res = await this.doFetch(url, payload, gate.signal);
        } catch (e) {
          if (gate.timedOut) return this.failReal(req, startedAt, 'timeout', describe(e), payload);
          if (req.signal?.aborted) {
            // 呼び出し側の中断はLLMの障害ではないのでブレーカに数えない
            return this.reject(req, startedAt, 'abort', describe(e));
          }
          return this.failReal(req, startedAt, 'http', describe(e), payload);
        }

        if (res.status === 429 || res.status >= 500) {
          if (attempt < MAX_RETRIES) {
            this.counters.retries++;
            const waited = await this.backoff(res, attempt, gate.signal);
            if (!waited) {
              return this.failReal(req, startedAt, 'timeout', '再試行の待機中に打ち切られた', payload);
            }
            continue;
          }
          const detail = await readErrorBody(res);
          const kind = res.status === 429 ? 'rate' : 'http';
          return this.failReal(req, startedAt, kind, `HTTP ${res.status} ${detail}`, payload);
        }

        if (!res.ok) {
          // 4xx（400含む）は再試行しない。パラメータ不正を延々叩かないため
          const detail = await readErrorBody(res);
          return this.failReal(req, startedAt, 'http', `HTTP ${res.status} ${detail}`, payload);
        }

        return onDelta
          ? await this.readStream(req, res, onDelta, startedAt, gate, payload)
          : await this.readJson(req, res, startedAt, gate, payload);
      }
    } finally {
      gate.dispose();
    }
  }

  /** ボディ。**temperature と max_tokens は絶対に入れない**（実測で400になる） */
  private buildBody(req: LlmRequest, streaming: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      messages: req.messages,
      max_completion_tokens: req.maxTokens,
      stream: streaming,
    };
    if (req.schema) {
      body['response_format'] = {
        type: 'json_schema',
        json_schema: { name: 'intent', strict: true, schema: req.schema },
      };
    }
    return body;
  }

  private doFetch(url: string, payload: string, signal: AbortSignal): Promise<Response> {
    const f = this.fetchImpl ?? globalThis.fetch;
    return f(url, {
      method: 'POST',
      headers: { 'api-key': this.apiKey, 'content-type': 'application/json' },
      body: payload,
      signal,
    });
  }

  private async readJson(
    req: LlmRequest,
    res: Response,
    startedAt: number,
    gate: Gate,
    payload: string,
  ): Promise<LlmResult> {
    let json: unknown;
    try {
      json = await res.json();
    } catch (e) {
      if (gate.timedOut) return this.failReal(req, startedAt, 'timeout', describe(e), payload);
      return this.failReal(req, startedAt, 'parse', describe(e), payload);
    }
    const text = pickContent(json);
    if (text === null) {
      return this.failReal(req, startedAt, 'parse', '応答に choices[0].message.content がない', payload);
    }
    const usage = pickUsage(json);
    this.recordOutcome(true);
    return this.accept(req, startedAt, text, usage, payload);
  }

  /**
   * SSEの読み取り。**行が途中で分割されて届く前提**でバッファリングする。
   * 初トークンまでは別のタイムアウト（LLM.timeoutMs.firstToken）を掛ける。
   */
  private async readStream(
    req: LlmRequest,
    res: Response,
    onDelta: (delta: string) => void,
    startedAt: number,
    gate: Gate,
    payload: string,
  ): Promise<LlmResult> {
    const body = res.body;
    if (!body) {
      return this.failReal(req, startedAt, 'parse', 'ストリーミング応答に body がない', payload);
    }
    const t = this.timeouts(req.purpose);
    gate.armFirstToken(t.firstToken);

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let full = '';
    let got = false;
    let usage: TokenCounts | undefined;

    try {
      for (;;) {
        // fetch の abort がボディへ伝わらない実装もあるので、読み取り自体を中断と競争させる
        const chunk = await raceAbort(reader.read(), gate.signal);
        if (chunk.done) break;
        buf += decoder.decode(chunk.value as Uint8Array, { stream: true });
        // 完結した行だけを処理し、末尾の未完了行はバッファに残す
        let nl = buf.indexOf('\n');
        while (nl >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, '');
          buf = buf.slice(nl + 1);
          nl = buf.indexOf('\n');
          const ev = parseSseLine(line);
          if (ev === 'done') {
            buf = '';
            return this.finishStream(req, startedAt, full, usage, got, payload);
          }
          if (ev === null) continue;
          if (ev.usage) usage = ev.usage;
          if (ev.delta) {
            if (!got) {
              got = true;
              gate.clearFirstToken();
            }
            full += ev.delta;
            onDelta(ev.delta);
          }
        }
      }
      // [DONE] が来ないまま切れた場合も、取れた分は成功として扱う
      const tail = parseSseLine(buf.replace(/\r$/, ''));
      if (tail !== null && tail !== 'done') {
        if (tail.usage) usage = tail.usage;
        if (tail.delta) {
          got = true;
          full += tail.delta;
          onDelta(tail.delta);
        }
      }
      return this.finishStream(req, startedAt, full, usage, got, payload);
    } catch (e) {
      if (gate.timedOut) {
        const why = gate.timedOut === 'firstToken' ? '初トークンが来ない' : '応答が遅い';
        return this.failReal(req, startedAt, 'timeout', `${why}: ${describe(e)}`, payload);
      }
      if (req.signal?.aborted) return this.reject(req, startedAt, 'abort', describe(e));
      return this.failReal(req, startedAt, 'http', describe(e), payload);
    } finally {
      gate.clearFirstToken();
      void reader.cancel().catch(() => {});
    }
  }

  private finishStream(
    req: LlmRequest,
    startedAt: number,
    full: string,
    usage: TokenCounts | undefined,
    got: boolean,
    payload: string,
  ): LlmResult {
    if (!got && full === '') {
      return this.failReal(req, startedAt, 'parse', 'ストリーミングで1文字も受け取れなかった', payload);
    }
    this.recordOutcome(true);
    return this.accept(req, startedAt, full, usage, payload);
  }

  /** 再試行の待機。Retry-After を尊重する。打ち切られたら false */
  private async backoff(res: Response, attempt: number, signal: AbortSignal): Promise<boolean> {
    const header = res.headers.get('retry-after');
    const fromHeader = parseRetryAfter(header, this.now());
    const base = BACKOFF_MS[attempt] ?? BACKOFF_MS[BACKOFF_MS.length - 1] ?? 2000;
    // Math.random() は使わない。呼び出し連番からジッタを作る（0〜99ms）
    const jitter = (this.seq++ * 137) % 100;
    const ms = fromHeader !== null ? Math.min(fromHeader, MAX_RETRY_AFTER_MS) : base + jitter;
    try {
      await delay(ms, signal);
      return true;
    } catch {
      return false;
    }
  }

  // ---------- 結果の組み立て ----------

  private accept(
    req: LlmRequest,
    startedAt: number,
    text: string,
    usage: TokenCounts | undefined,
    payload: string | undefined,
  ): LlmResult {
    const counts = usage ?? {
      promptTokens: estimateTokens(payload ?? req.messages.map((m) => m.content).join('\n')),
      completionTokens: estimateTokens(text),
    };
    const estimated = usage === undefined;
    const u: LlmUsage = {
      purpose: req.purpose,
      playerId: req.playerId,
      promptTokens: counts.promptTokens,
      completionTokens: counts.completionTokens,
      latencyMs: Math.max(0, this.now() - startedAt),
      ok: true,
      estimated,
    };
    this.counters.ok++;
    this.counters.promptTokens += u.promptTokens;
    this.counters.completionTokens += u.completionTokens;
    if (estimated) this.counters.estimatedCalls++;
    this.emit(u);
    return { ok: true, text, usage: u };
  }

  /** 実リクエストを送ったあとの失敗。ブレーカに数える */
  private failReal(
    req: LlmRequest,
    startedAt: number,
    kind: string,
    message: string,
    payload: string,
  ): LlmResult {
    this.recordOutcome(false);
    return this.reject(req, startedAt, kind, message, estimateTokens(payload));
  }

  /** 呼び出す前に決まった失敗（mode/breaker/rate）。ブレーカには数えない */
  private reject(
    req: LlmRequest,
    startedAt: number,
    kind: string,
    message: string,
    promptTokens = 0,
  ): LlmResult {
    const u: LlmUsage = {
      purpose: req.purpose,
      playerId: req.playerId,
      promptTokens,
      completionTokens: 0,
      latencyMs: Math.max(0, this.now() - startedAt),
      ok: false,
      errorKind: kind,
      estimated: promptTokens > 0,
    };
    this.counters.fail++;
    this.counters.promptTokens += promptTokens;
    this.byErrorKind.set(kind, (this.byErrorKind.get(kind) ?? 0) + 1);
    this.emit(u);
    return { ok: false, errorKind: kind, message: this.redact(message), usage: u };
  }

  private emit(u: LlmUsage): void {
    if (!this.onUsage) return;
    try {
      this.onUsage(u);
    } catch {
      // 記録の失敗でゲームを止めない
    }
  }

  /** APIキーが外に出ないようにする（エラーメッセージ・ログの両方でこれを通す） */
  private redact(s: string): string {
    let out = s;
    if (this.apiKey.length >= 8) out = out.split(this.apiKey).join('***');
    return out;
  }

  // ---------- サーキットブレーカ ----------

  private isBreakerOpen(): boolean {
    if (this.openUntil === 0) return false;
    if (this.now() < this.openUntil) return true;
    // 時間が来たら閉じる。次のウィンドウを新しく測り直す（half-open相当）
    this.openUntil = 0;
    this.outcomes = [];
    return false;
  }

  private recordOutcome(ok: boolean): void {
    this.outcomes.push(ok);
    if (this.outcomes.length > LLM.breaker.window) {
      this.outcomes = this.outcomes.slice(-LLM.breaker.window);
    }
    if (this.outcomes.length < LLM.breaker.window) return;
    if (this.failRatio() > LLM.breaker.failRatio) {
      this.openUntil = this.now() + LLM.breaker.openMs;
      this.counters.breakerOpens++;
      this.outcomes = [];
      console.warn(
        `[llm] サーキットブレーカを開いた（${LLM.breaker.openMs / 1000}秒間はフォールバックのみで運用）`,
      );
    }
  }

  private failRatio(): number {
    if (this.outcomes.length === 0) return 0;
    let fails = 0;
    for (const ok of this.outcomes) if (!ok) fails++;
    return fails / this.outcomes.length;
  }

  private timeouts(purpose: LlmPurpose): { total: number; firstToken: number } {
    const key = TIMEOUT_KEY[purpose];
    return { total: LLM.timeoutMs[key], firstToken: LLM.timeoutMs.firstToken };
  }

  /** 合計タイムアウトと初トークンタイムアウトをまとめた中断ゲート */
  private openGate(external: AbortSignal | undefined, totalMs: number): Gate {
    const ac = new AbortController();
    const gate: Gate = {
      signal: ac.signal,
      timedOut: null,
      armFirstToken: (ms: number) => {
        gate.firstTokenTimer = setTimeout(() => {
          if (gate.timedOut === null) gate.timedOut = 'firstToken';
          ac.abort(new Error('first token timeout'));
        }, ms);
      },
      clearFirstToken: () => {
        if (gate.firstTokenTimer !== undefined) {
          clearTimeout(gate.firstTokenTimer);
          gate.firstTokenTimer = undefined;
        }
      },
      dispose: () => {
        clearTimeout(totalTimer);
        gate.clearFirstToken();
        external?.removeEventListener('abort', onExternal);
      },
    };
    const totalTimer = setTimeout(() => {
      if (gate.timedOut === null) gate.timedOut = 'total';
      ac.abort(new Error('timeout'));
    }, totalMs);
    const onExternal = (): void => ac.abort(new Error('aborted by caller'));
    if (external) {
      if (external.aborted) onExternal();
      else external.addEventListener('abort', onExternal, { once: true });
    }
    return gate;
  }
}

interface Gate {
  signal: AbortSignal;
  timedOut: 'total' | 'firstToken' | null;
  firstTokenTimer?: ReturnType<typeof setTimeout>;
  armFirstToken: (ms: number) => void;
  clearFirstToken: () => void;
  dispose: () => void;
}

interface TokenCounts {
  promptTokens: number;
  completionTokens: number;
}

/** SSEの1行を解釈する。`data: ` 以外は無視、`[DONE]` は終端 */
function parseSseLine(line: string): { delta: string; usage?: TokenCounts } | 'done' | null {
  const trimmed = line.trim();
  if (trimmed === '' || !trimmed.startsWith('data:')) return null;
  const payload = trimmed.slice('data:'.length).trim();
  if (payload === '') return null;
  if (payload === '[DONE]') return 'done';
  let json: unknown;
  try {
    json = JSON.parse(payload);
  } catch {
    return null; // 壊れた1行で会話全体を落とさない
  }
  const delta = pickDelta(json) ?? '';
  const usage = pickUsage(json);
  return usage ? { delta, usage } : { delta };
}

function pickDelta(json: unknown): string | null {
  if (!isRecord(json)) return null;
  const choices = json['choices'];
  if (!Array.isArray(choices)) return null;
  const first = choices[0];
  if (!isRecord(first)) return null;
  const delta = first['delta'];
  if (isRecord(delta) && typeof delta['content'] === 'string') return delta['content'];
  const message = first['message'];
  if (isRecord(message) && typeof message['content'] === 'string') return message['content'];
  return null;
}

function pickContent(json: unknown): string | null {
  if (!isRecord(json)) return null;
  const choices = json['choices'];
  if (!Array.isArray(choices)) return null;
  const first = choices[0];
  if (!isRecord(first)) return null;
  const message = first['message'];
  if (!isRecord(message)) return null;
  const content = message['content'];
  return typeof content === 'string' ? content : null;
}

function pickUsage(json: unknown): TokenCounts | undefined {
  if (!isRecord(json)) return undefined;
  const usage = json['usage'];
  if (!isRecord(usage)) return undefined;
  const p = usage['prompt_tokens'];
  const c = usage['completion_tokens'];
  if (typeof p !== 'number' || typeof c !== 'number') return undefined;
  return { promptTokens: p, completionTokens: c };
}

/**
 * `usage` が無いとき（ストリーミング・モック）の概算。
 * ASCIIは約4文字/token、日本語などマルチバイトは約1.5文字/token として数える。
 * 課金の見積りには使えるが、正確な値ではないので `estimated: true` を立てる。
 */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let wide = 0;
  for (const ch of text) {
    if (ch.codePointAt(0)! < 128) ascii++;
    else wide++;
  }
  return Math.ceil(ascii / 4 + wide / 1.5);
}

/** Retry-After（秒数 or HTTP-date）をミリ秒に。読めなければ null */
export function parseRetryAfter(header: string | null, now: number): number | null {
  if (header === null) return null;
  const trimmed = header.trim();
  if (trimmed === '') return null;
  const secs = Number(trimmed);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - now);
}

/** 中断シグナルと競争させる。中断が来たら待たずに抜ける */
function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('aborted'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (!(ms > 0)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function readErrorBody(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.slice(0, 300);
  } catch {
    return '(body読み取り失敗)';
  }
}

function describe(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
