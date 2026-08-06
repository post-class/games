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

    ws.onopen = () => {
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
      this.stopPing();
      if (this.closedByUser) {
        this.setState('closed');
        return;
      }
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      // oncloseが続いて呼ばれるのでここでは何もしない
    };
  }

  private scheduleReconnect(): void {
    this.attempt++;
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
