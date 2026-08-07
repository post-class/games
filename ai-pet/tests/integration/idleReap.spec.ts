/**
 * 無音になった接続を切る動作の統合テスト。
 *
 * 検証したいのは「FINが来ないまま消えた接続を、サーバが自力で片づけるか」。
 * 実際に起きるのは回線断・端末スリープなので、
 * ソケットを閉じずに黙らせる（＝pingを送らない）という形で再現する。
 *
 * 本番の30秒を待つとテストが遅すぎるので、`CLIENT_IDLE_TIMEOUT_MS` を短くして起動する。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import WebSocket from 'ws';
import type { ServerMsg } from '@ai-pet/shared';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PORT = 8792; // 開発用(8787)・E2E用(8788)・再起動テスト(8791)と衝突しないポート
const DB_PATH = '.tmp/idle-reap-island.db';
/** サーバ側の無音タイムアウト（ms）。sweepは10秒ごとなので、切られるまで最大12秒 */
const IDLE_MS = 2000;

let server: ChildProcess | null = null;

function removeDb(): void {
  const abs = resolve(ROOT, DB_PATH);
  mkdirSync(dirname(abs), { recursive: true });
  for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(abs + suffix, { force: true });
}

async function health(): Promise<{ clients: number; tick: number }> {
  const res = await fetch(`http://localhost:${PORT}/healthz`);
  return (await res.json()) as { clients: number; tick: number };
}

beforeAll(async () => {
  removeDb();
  const child = spawn(process.execPath, ['packages/server/src/main.ts', '--llm=mock'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_PATH,
      ISLAND_SEED: 'idle-reap-seed',
      LLM_MODE: 'mock',
      CLIENT_IDLE_TIMEOUT_MS: String(IDLE_MS),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server = child;
  const logs: string[] = [];
  child.stdout?.on('data', (d) => logs.push(String(d)));
  child.stderr?.on('data', (d) => logs.push(String(d)));

  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`サーバが起動前に終了しました:\n${logs.join('')}`);
    try {
      if ((await fetch(`http://localhost:${PORT}/healthz`)).ok) break;
    } catch {
      // まだ起動していない
    }
    if (Date.now() > deadline) throw new Error(`サーバの起動がタイムアウト:\n${logs.join('')}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}, 30_000);

afterAll(async () => {
  const child = server;
  server = null;
  if (child && child.exitCode === null) {
    const exited = new Promise<void>((r) => child.once('exit', () => r()));
    child.kill('SIGINT');
    await Promise.race([exited, new Promise((r) => setTimeout(r, 8000))]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  const abs = resolve(ROOT, DB_PATH);
  if (existsSync(abs)) removeDb();
});

describe('無音になった接続の片づけ', () => {
  test('pingが止まった接続は切られ、アバターも島から消える', async () => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
    await new Promise<void>((res, rej) => {
      ws.once('open', () => res());
      ws.once('error', rej);
    });

    let entityId = 0;
    const welcomed = new Promise<void>((done) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(String(data)) as ServerMsg;
        if (msg.t === 'welcome') {
          entityId = msg.entityId;
          done();
        }
      });
    });
    ws.send(JSON.stringify({ t: 'hello', v: 1, displayName: 'きえるひと' }));
    await welcomed;

    expect(entityId).toBeGreaterThan(0);
    expect((await health()).clients).toBe(1);

    // ここから何も送らない（回線が落ちたのと同じ状態）。
    // sweepは10秒ごとなので、最大でも 10秒 + 余裕 で切られるはず
    const deadline = Date.now() + 20_000;
    let clients = 1;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      clients = (await health()).clients;
      if (clients === 0) break;
    }
    expect(clients).toBe(0);

    // 別の接続から見て、消えたアバターが島に残っていないことを確かめる
    const probe = new WebSocket(`ws://localhost:${PORT}/ws`);
    await new Promise<void>((res, rej) => {
      probe.once('open', () => res());
      probe.once('error', rej);
    });
    const players = await new Promise<number[]>((done) => {
      probe.on('message', (data) => {
        const msg = JSON.parse(String(data)) as ServerMsg;
        // k=2 がプレイヤー（actorToWire の並び順に依存しない形で数える）
        if (msg.t === 'snapshot') done(msg.actors.filter((a) => a.k === 2).map((a) => a.i));
      });
      probe.send(JSON.stringify({ t: 'hello', v: 1, displayName: 'みるひと' }));
    });
    probe.close();

    expect(players).not.toContain(entityId);
    // 残っているのは自分だけ
    expect(players).toHaveLength(1);

    ws.terminate();
  }, 40_000);
});
