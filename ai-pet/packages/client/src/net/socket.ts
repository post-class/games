/**
 * WebSocket接続。再接続（指数バックオフ）とRTT計測を担当する。
 * 受信メッセージはコールバックへそのまま渡す（サーバ発は信頼する）。
 */
import type { ServerMsg } from '@ai-pet/shared';

const SECRET_KEY = 'pokomofu.secret';

export type ConnState = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface SocketOptions {
  url?: string;
  displayName?: string;
  onMessage: (msg: ServerMsg) => void;
  onState?: (state: ConnState, info: { attempt: number; rttMs: number }) => void;
}

/**
 * E2Eの切り分け用トレース。
 *
 * **`__wsTrace` を作るのはテストの初期化スクリプトだけ**なので、本番では
 * optional chaining が空振りするだけでコストは無い（`main.ts` の `__netTrace` と同じ作法）。
 *
 * なぜ必要か: `tests/e2e/reconnect.e2e.ts` の強制切断が
 * **「閉じたと数えているのに状態遷移が起きない」**ことが 15〜25% の頻度で起きていて、
 * トレース（trace.zip）では「/ws が1本だけ・welcome 1回・チップは接続OK」までしか分からなかった。
 * close が届いているのか、届いていて state が動いていないのかを区別するために、
 * ソケットのライフサイクルを発生源で記録する。
 */
function wsTrace(event: string, extra?: Record<string, unknown>): void {
  const holder = window as unknown as { __wsTrace?: string[] };
  if (!holder.__wsTrace) return;
  const at = Math.round(performance.now());
  holder.__wsTrace.push(extra ? `${at}ms ${event} ${JSON.stringify(extra)}` : `${at}ms ${event}`);
}

function defaultUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}

export class GameSocket {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private closedByUser = false;
  private pingTimer: number | null = null;
  private reconnectTimer: number | null = null;
  rttMs = 0;
  state: ConnState = 'connecting';

  constructor(private readonly opts: SocketOptions) {}

  get secret(): string | null {
    return localStorage.getItem(SECRET_KEY);
  }

  connect(): void {
    this.closedByUser = false;
    this.setState('connecting');
    const url = this.opts.url ?? defaultUrl();
    const ws = new WebSocket(url);
    this.ws = ws;
    wsTrace('connect', { url, attempt: this.attempt });

    ws.onopen = () => {
      wsTrace('onopen');
      this.attempt = 0;
      this.setState('open');
      this.send({
        t: 'hello',
        v: 1,
        ...(this.secret ? { secret: this.secret } : {}),
        ...(this.opts.displayName ? { displayName: this.opts.displayName } : {}),
      });
      this.startPing();
    };

    ws.onmessage = (ev) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(String(ev.data)) as ServerMsg;
      } catch {
        return;
      }
      if (msg.t === 'pong') {
        this.rttMs = Math.round(performance.now() - msg.ts);
        this.setState(this.state);
        return;
      }
      if (msg.t === 'welcome') {
        localStorage.setItem(SECRET_KEY, msg.secret);
      }
      this.opts.onMessage(msg);
    };

    ws.onclose = () => {
      wsTrace('onclose', { closedByUser: this.closedByUser, isCurrent: this.ws === ws });
      this.stopPing();
      if (this.closedByUser) {
        this.setState('closed');
        return;
      }
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      // oncloseが続いて呼ばれるのでここでは何もしない
      wsTrace('onerror');
    };
  }

  private scheduleReconnect(): void {
    this.attempt++;
    wsTrace('scheduleReconnect', { attempt: this.attempt });
    this.setState('reconnecting');
    const delay = Math.min(8000, 500 * 2 ** (this.attempt - 1));
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = window.setTimeout(() => this.connect(), delay);
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = window.setInterval(() => {
      this.send({ t: 'ping', ts: performance.now() });
    }, 5000);
    this.send({ t: 'ping', ts: performance.now() });
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private setState(s: ConnState): void {
    // pong ごとに同じ state で呼ばれるので、変化したときだけ記録する（ログが埋まらないように）
    if (s !== this.state) wsTrace('setState', { to: s });
    this.state = s;
    this.opts.onState?.(s, { attempt: this.attempt, rttMs: this.rttMs });
  }

  send(msg: Record<string, unknown> & { t: string }): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(msg));
  }

  close(): void {
    this.closedByUser = true;
    this.stopPing();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }
}
