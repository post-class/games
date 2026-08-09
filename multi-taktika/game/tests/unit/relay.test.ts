/**
 * T-M14-01, 02: 入力中継サーバの検証（`07§12`）
 *
 * 見るべきこと:
 *  1. **サーバはゲームロジックを持たない**（入力を配るだけ）
 *  2. **全員分が揃うまで配らない**（ロックステップ。「誰かの回線が遅いと全員が待つ」）
 *  3. シードはサーバが決めて全員に配る（部屋の主がマップを引き直せない）
 *  4. ハッシュが食い違えばデシンクとして知らせる（**どちらが正しいかは決めない**）
 *  5. 切断しても部屋が止まらない（席は 120 秒保持）
 */

import { describe, expect, it, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import type { WebSocketServer } from 'ws';
import { startRelay } from '../../server/relay';

let server: WebSocketServer | null = null;
let port = 0;

/** 空きポートで起動する（0 を渡すと OS が空きを選ぶ）。 */
function boot(): void {
  server = startRelay(0);
  const addr = server.address();
  port = typeof addr === 'object' && addr !== null ? addr.port : 0;
}

afterEach(async () => {
  const s = server;
  server = null;
  if (s === null) return;
  // **繋がっているクライアントを先に切る。**
  // 接続が残っていると `close(cb)` のコールバックが呼ばれず、フックがタイムアウトする。
  for (const c of s.clients) c.terminate();
  await new Promise<void>((resolve) => s.close(() => resolve()));
});

/** 受信メッセージを溜めるクライアント。 */
class Client {
  readonly got: Record<string, unknown>[] = [];
  private readonly ws: WebSocket;

  constructor(p: number) {
    this.ws = new WebSocket(`ws://127.0.0.1:${p}`);
    this.ws.on('message', (raw) => {
      this.got.push(JSON.parse(String(raw)) as Record<string, unknown>);
    });
  }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('error', reject);
    });
  }

  send(msg: unknown): void {
    this.ws.send(JSON.stringify(msg));
  }

  close(): void {
    this.ws.close();
  }

  /** 指定の種別が届くまで待つ（届かなければタイムアウトで落ちる）。 */
  async wait(t: string, timeoutMs = 2000): Promise<Record<string, unknown>> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const hit = this.got.find((m) => m['t'] === t);
      if (hit !== undefined) return hit;
      if (Date.now() > until) throw new Error(`"${t}" が届かなかった: ${JSON.stringify(this.got)}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  /** 指定の種別が「届かないこと」を確かめる（待ってから見る）。 */
  async never(t: string, waitMs = 250): Promise<void> {
    await new Promise((r) => setTimeout(r, waitMs));
    expect(
      this.got.filter((m) => m['t'] === t),
      `"${t}" が届いてしまった`,
    ).toHaveLength(0);
  }
}

describe('T-M14-01: サーバはゲームロジックを持たない', () => {
  it('入力をそのまま配るだけ（内容を解釈しない）', async () => {
    boot();
    const a = new Client(port);
    const b = new Client(port);
    await a.open();
    await b.open();
    a.send({ t: 'join', room: 'r1', name: 'A' });
    b.send({ t: 'join', room: 'r1', name: 'B' });
    await a.wait('welcome');
    await b.wait('welcome');

    // **サーバが知らない形の Command でも中継できる**
    // （＝ ゲームロジックを持っていない証拠）
    const weird = [{ t: 'まだ存在しないコマンド', 何か: 42 }];
    a.send({ t: 'input', tick: 0, cmds: weird });
    b.send({ t: 'input', tick: 0, cmds: [] });

    const got = await a.wait('input');
    expect(got['tick']).toBe(0);
    const byPlayer = got['byPlayer'] as Record<string, unknown[]>;
    expect(byPlayer['0']).toEqual(weird);
    expect(byPlayer['1']).toEqual([]);
  });

  it('シードはサーバが決めて全員に同じ値を配る', async () => {
    boot();
    const a = new Client(port);
    const b = new Client(port);
    await a.open();
    await b.open();
    a.send({ t: 'join', room: 'r2', name: 'A' });
    b.send({ t: 'join', room: 'r2', name: 'B' });
    const wa = await a.wait('welcome');
    const wb = await b.wait('welcome');
    expect(typeof wa['seed']).toBe('number');
    expect(wb['seed']).toBe(wa['seed']);
    // playerId は 0 から順に割り当てる
    expect(wa['playerId']).toBe(0);
    expect(wb['playerId']).toBe(1);
    // 入力遅延も配る（クライアントが待ち合わせに使う）
    expect(wa['inputDelayFrames']).toBe(3);
  });
});

describe('T-M14-03: 全員分が揃うまで配らない（ロックステップ）', () => {
  it('片方の入力だけでは配られない', async () => {
    boot();
    const a = new Client(port);
    const b = new Client(port);
    await a.open();
    await b.open();
    a.send({ t: 'join', room: 'r3', name: 'A' });
    b.send({ t: 'join', room: 'r3', name: 'B' });
    await a.wait('welcome');
    await b.wait('welcome');

    a.send({ t: 'input', tick: 5, cmds: [] });
    // 「誰かの回線が遅いと全員が同じだけ待つ」（07§12）
    await a.never('input');

    b.send({ t: 'input', tick: 5, cmds: [] });
    const got = await a.wait('input');
    expect(got['tick']).toBe(5);
  });

  it('先の tick を先に配らない（順序が入れ替わると再現性が壊れる）', async () => {
    boot();
    const a = new Client(port);
    const b = new Client(port);
    await a.open();
    await b.open();
    a.send({ t: 'join', room: 'r4', name: 'A' });
    b.send({ t: 'join', room: 'r4', name: 'B' });
    await a.wait('welcome');
    await b.wait('welcome');

    // tick 2 は両方揃うが、tick 1 は片方だけ
    a.send({ t: 'input', tick: 1, cmds: [] });
    a.send({ t: 'input', tick: 2, cmds: [] });
    b.send({ t: 'input', tick: 2, cmds: [] });
    await a.never('input');

    b.send({ t: 'input', tick: 1, cmds: [] });
    // 揃った時点で tick 昇順に 2 件配られる
    const until = Date.now() + 2000;
    for (;;) {
      const inputs = a.got.filter((m) => m['t'] === 'input');
      if (inputs.length >= 2) {
        expect(inputs.map((m) => m['tick'])).toEqual([1, 2]);
        break;
      }
      if (Date.now() > until) throw new Error(`2 件そろわなかった: ${JSON.stringify(a.got)}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  });

  it('同じ tick を 2 回送っても最初のものが残る（後から書き換えられない）', async () => {
    boot();
    const a = new Client(port);
    await a.open();
    a.send({ t: 'join', room: 'r5', name: 'A' });
    await a.wait('welcome');
    a.send({ t: 'input', tick: 0, cmds: [{ t: 'resign', p: 0 }] });
    a.send({ t: 'input', tick: 0, cmds: [] }); // 上書きを試みる
    const got = await a.wait('input');
    const byPlayer = got['byPlayer'] as Record<string, unknown[]>;
    expect(byPlayer['0']).toEqual([{ t: 'resign', p: 0 }]);
  });
});

describe('T-M14-06: デシンクの検出', () => {
  it('ハッシュが食い違えば知らせる（どちらが正しいかは決めない）', async () => {
    boot();
    const a = new Client(port);
    const b = new Client(port);
    await a.open();
    await b.open();
    a.send({ t: 'join', room: 'r6', name: 'A' });
    b.send({ t: 'join', room: 'r6', name: 'B' });
    await a.wait('welcome');
    await b.wait('welcome');

    a.send({ t: 'hash', tick: 250, hash: 111 });
    b.send({ t: 'hash', tick: 250, hash: 222 });
    const got = await a.wait('desync');
    expect(got['tick']).toBe(250);
    const hashes = got['hashes'] as Record<string, number>;
    expect(hashes['0']).toBe(111);
    expect(hashes['1']).toBe(222);
    // **「正しい側」を示すフィールドが無いこと**（サーバは判定できない）
    expect(Object.keys(got).sort()).toEqual(['hashes', 't', 'tick']);
  });

  it('ハッシュが一致していれば何も言わない', async () => {
    boot();
    const a = new Client(port);
    const b = new Client(port);
    await a.open();
    await b.open();
    a.send({ t: 'join', room: 'r7', name: 'A' });
    b.send({ t: 'join', room: 'r7', name: 'B' });
    await a.wait('welcome');
    await b.wait('welcome');
    a.send({ t: 'hash', tick: 250, hash: 42 });
    b.send({ t: 'hash', tick: 250, hash: 42 });
    await a.never('desync');
  });
});

describe('T-M14-05: 切断しても部屋が止まらない', () => {
  it('切断を知らせ、残った人の入力は配られ続ける', async () => {
    boot();
    const a = new Client(port);
    const b = new Client(port);
    await a.open();
    await b.open();
    a.send({ t: 'join', room: 'r8', name: 'A' });
    b.send({ t: 'join', room: 'r8', name: 'B' });
    await a.wait('welcome');
    await b.wait('welcome');

    b.close();
    const left = await a.wait('left');
    expect(left['playerId']).toBe(1);
    // 席は 120 秒保持（その間はクライアント側の AI が代行する）
    expect(left['holdMs']).toBe(120_000);

    // 残った人だけで進める（切断中の席の入力は待たない）
    a.send({ t: 'input', tick: 10, cmds: [] });
    const got = await a.wait('input');
    expect(got['tick']).toBe(10);
  });

  it('満席（8 人）を超える参加は断る', async () => {
    boot();
    const clients: Client[] = [];
    for (let i = 0; i < 8; i++) {
      const c = new Client(port);
      await c.open();
      c.send({ t: 'join', room: 'full', name: `P${i}` });
      await c.wait('welcome');
      clients.push(c);
    }
    const extra = new Client(port);
    await extra.open();
    extra.send({ t: 'join', room: 'full', name: 'P8' });
    const err = await extra.wait('error');
    expect(String(err['message'])).toContain('満席');
    for (const c of clients) c.close();
    extra.close();
  });
});
