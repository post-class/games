/**
 * net/client.ts — 中継サーバへ繋ぐ WebSocket クライアント（T-M14-02〜06）
 *
 * ■ 役割は「線」だけ
 * 待ち合わせの判断は `lockstep.ts` に全部ある。ここは
 *   繋ぐ → `join` → `welcome` を受ける → `ready` → `start` を受ける → 以降は文字列を素通し
 * だけを行う。**ここに tick の判断を書いてはいけない**（テストできなくなる）。
 *
 * ■ WebSocket を直接 new しない
 * `connect` を差し替えられるようにしてある。ブラウザでは既定の実装（`globalThis.WebSocket`）、
 * テストでは Node の WebSocket を差して**本物の `server/relay.ts` 越し**に検証する
 * （`tests/determinism/lockstep.test.ts`）。
 *
 * ■ 部屋の共有（`01` / `07§12`「アカウント登録なし」）
 * URL の `#room=xxxx`（`?room=xxxx` も可）を共有するだけで同じ試合に入る。
 * 共有 URL を作るのは `ui/screens/MatchSetup.ts` の役目で、ここは**読む側**。
 */

import { cfgInt } from '@/sim/core/config';

import type { C2S, RosterEntry, S2C } from './protocol';
import { decodeS2C, encodeC2S, utf8Bytes } from './protocol';

/** 中継サーバの既定ポート（`server/relay.ts` の既定と同じ値を `config.json` から引く）。 */
export const RELAY_PORT = cfgInt('net.relayPort');

/** WebSocket の最小の形（ブラウザ / Node / `ws` のどれでも満たす）。 */
export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: string, listener: (ev: unknown) => void): void;
}

/** 接続の作り方（テストで差し替える）。 */
export type ConnectFn = (url: string) => WebSocketLike;

/**
 * 共有 URL から部屋 ID を取り出す。
 *
 * `#room=xxxx` を正とし、`?room=xxxx`（`MatchSetup.ts` の共有 URL の形）も受ける。
 * どちらも無ければ `null`（= オンライン対戦ではない）。
 */
export function roomFromLocation(loc: { readonly hash?: string; readonly search?: string }): string | null {
  const fromHash = pickParam(stripLeading(loc.hash ?? '', '#'), 'room');
  if (fromHash !== null) return fromHash;
  return pickParam(stripLeading(loc.search ?? '', '?'), 'room');
}

function stripLeading(text: string, ch: string): string {
  return text.startsWith(ch) ? text.slice(1) : text;
}

function pickParam(query: string, key: string): string | null {
  if (query === '') return null;
  const v = new URLSearchParams(query).get(key);
  return v === null || v === '' ? null : v;
}

/**
 * 既定の中継サーバ URL。
 *
 * ページと同じホストの `net.relayPort` に繋ぐ（`https` なら `wss`）。
 * 別ホストに置く運用は URL を直接渡してもらう（`?relay=` は将来の課題）。
 */
export function defaultRelayUrl(loc: { readonly protocol: string; readonly hostname: string }): string {
  const scheme = loc.protocol === 'https:' ? 'wss' : 'ws';
  const host = loc.hostname === '' ? 'localhost' : loc.hostname;
  return `${scheme}://${host}:${RELAY_PORT}`;
}

/** `welcome` の中身（試合を作るのに必要な情報）。 */
export interface WelcomeInfo {
  readonly playerId: number;
  readonly seed: number;
  readonly inputDelayFrames: number;
  readonly players: readonly RosterEntry[];
}

export interface RelayClientOptions {
  readonly url: string;
  readonly room: string;
  readonly name: string;
  /** `welcome` を受けたら自動で `ready` を送るか（既定 true）。 */
  readonly autoReady?: boolean;
  readonly connect?: ConnectFn;
  readonly onWelcome?: (info: WelcomeInfo) => void;
  readonly onRoster?: (players: readonly RosterEntry[]) => void;
  readonly onStart?: (startTick: number) => void;
  /** `welcome` / `roster` / `start` 以外を含む**全メッセージ**（生文字列つき）。 */
  readonly onMessage?: (msg: S2C, text: string) => void;
  readonly onError?: (message: string) => void;
  readonly onClose?: () => void;
}

/**
 * 中継サーバとの 1 本の接続。
 *
 * この層では `Math.random` / `Date.now` を使ってよいが、
 * **`Command` に混ぜてはいけない**（決定論が壊れる）。実際ここでは 1 つも使っていない。
 */
export class RelayClient {
  private readonly socket: WebSocketLike;
  private readonly opts: RelayClientOptions;
  private welcomeInfo: WelcomeInfo | null = null;
  private startedTick = -1;
  private open = false;
  private closed = false;
  /** 接続前に送ろうとしたメッセージ（open で流す）。 */
  private readonly queued: string[] = [];

  /** 送受のバイト数（通信量の実測。T-M14-04）。 */
  readonly stats = { sentBytes: 0, sentMessages: 0, recvBytes: 0, recvMessages: 0 };

  constructor(opts: RelayClientOptions) {
    this.opts = opts;
    const connect = opts.connect ?? defaultConnect;
    this.socket = connect(opts.url);
    this.socket.addEventListener('open', () => {
      this.open = true;
      this.sendMessage({ t: 'join', room: opts.room, name: opts.name });
      for (const text of this.queued.splice(0)) this.sendText(text);
    });
    this.socket.addEventListener('message', (ev) => this.onRaw(ev));
    this.socket.addEventListener('close', () => {
      this.closed = true;
      this.opts.onClose?.();
    });
    this.socket.addEventListener('error', () => {
      this.opts.onError?.('接続に失敗しました');
    });
  }

  /** `welcome` の内容（未着なら null）。 */
  get welcome(): WelcomeInfo | null {
    return this.welcomeInfo;
  }

  /** 試合が始まったか。 */
  get started(): boolean {
    return this.startedTick >= 0;
  }

  /** 開始 tick（`start` 未着なら -1）。 */
  get startTick(): number {
    return this.startedTick;
  }

  /** 接続が閉じたか。 */
  get isClosed(): boolean {
    return this.closed;
  }

  /** 生文字列を送る（`Lockstep` の送信口にそのまま渡せる）。 */
  sendText(text: string): void {
    if (this.closed) return;
    if (!this.open) {
      this.queued.push(text);
      return;
    }
    this.stats.sentBytes += utf8Bytes(text);
    this.stats.sentMessages += 1;
    this.socket.send(text);
  }

  /** `C2S` を送る。 */
  sendMessage(msg: C2S): void {
    this.sendText(encodeC2S(msg));
  }

  /** 準備完了を送る（全員が押すとサーバが `start` を配る）。 */
  ready(): void {
    this.sendMessage({ t: 'ready' });
  }

  close(): void {
    this.closed = true;
    this.socket.close();
  }

  private onRaw(ev: unknown): void {
    const text = textOf(ev);
    if (text === null) return;
    this.stats.recvBytes += utf8Bytes(text);
    this.stats.recvMessages += 1;
    const msg = decodeS2C(text);
    if (msg === null) return;
    switch (msg.t) {
      case 'welcome':
        this.welcomeInfo = {
          playerId: msg.playerId,
          seed: msg.seed,
          inputDelayFrames: msg.inputDelayFrames,
          players: msg.players,
        };
        this.opts.onWelcome?.(this.welcomeInfo);
        if (this.opts.autoReady !== false) this.ready();
        break;
      case 'roster':
        this.opts.onRoster?.(msg.players);
        break;
      case 'start':
        // 2 回目の `start`（復帰時にサーバが送る）で開始 tick を上書きしない
        if (this.startedTick < 0) {
          this.startedTick = msg.startTick;
          this.opts.onStart?.(msg.startTick);
        }
        break;
      case 'error':
        this.opts.onError?.(msg.message);
        break;
      default:
        break;
    }
    this.opts.onMessage?.(msg, text);
  }
}

/** 既定の接続（ブラウザ / Node 24 の `globalThis.WebSocket`）。 */
function defaultConnect(url: string): WebSocketLike {
  const Ctor = (globalThis as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket;
  if (Ctor === undefined) throw new Error('net/client: WebSocket が見つかりません');
  return new Ctor(url);
}

/** メッセージイベントから文字列を取り出す（Node の Buffer も受ける）。 */
function textOf(ev: unknown): string | null {
  if (typeof ev === 'string') return ev;
  if (typeof ev !== 'object' || ev === null) return null;
  const data = (ev as { data?: unknown }).data;
  if (typeof data === 'string') return data;
  if (data === undefined || data === null) return null;
  return String(data);
}
