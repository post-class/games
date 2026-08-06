/**
 * サーバ再起動をまたいだ復帰の統合テスト（docs 09章 M2 の完了条件）。
 *
 * ブラウザは不要（検証したいのはサーバの永続化とプロトコル）なので、
 * Playwrightではなく実サーバを子プロセスで起動し、WSクライアントで確かめる。
 * E2E（tests/e2e/reconnect.e2e.ts）側の同シナリオはこちらに寄せてskipにしている。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import WebSocket from 'ws';
import type { ServerMsg } from '@ai-pet/shared';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PORT = 8791; // 開発用(8787)・E2E用(8788)と衝突しないポート
const DB_PATH = '.tmp/restart-test-island.db';
const SEED = 'restart-test-seed';

let server: ChildProcess | null = null;

function removeDb(): void {
  const abs = resolve(ROOT, DB_PATH);
  mkdirSync(dirname(abs), { recursive: true });
  for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(abs + suffix, { force: true });
}

async function startServer(): Promise<void> {
  const child = spawn(process.execPath, ['packages/server/src/main.ts', '--llm=mock'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DB_PATH, ISLAND_SEED: SEED, LLM_MODE: 'mock' },
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
      const res = await fetch(`http://localhost:${PORT}/healthz`);
      if (res.ok) return;
    } catch {
      // まだ起動していない
    }
    if (Date.now() > deadline) throw new Error(`サーバの起動がタイムアウト:\n${logs.join('')}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** SIGINT を送って graceful shutdown を待つ（ここで保存が走る） */
async function stopServer(): Promise<void> {
  const child = server;
  server = null;
  if (!child || child.exitCode !== null) return;
  const exited = new Promise<void>((r) => child.once('exit', () => r()));
  child.kill('SIGINT');
  const timeout = new Promise<void>((r) => setTimeout(r, 8000));
  await Promise.race([exited, timeout]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

interface Session {
  entityId: number;
  pos: { x: number; y: number };
  seed: string;
  islandDay: number;
  tick: number;
}

/**
 * 接続して welcome を受け、必要なら移動してから切断する。
 * moveTo を渡した場合は移動が落ち着くまで delta を追い、最終位置を返す。
 */
async function session(secret: string, moveTo?: { x: number; y: number }, waitMs = 3500): Promise<Session> {
  const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
  const result: Partial<Session> = {};
  let entityId = 0;

  await new Promise<void>((resolveOpen, reject) => {
    ws.once('open', () => resolveOpen());
    ws.once('error', reject);
  });
  ws.send(JSON.stringify({ t: 'hello', v: 1, secret, displayName: 'ためしびと' }));

  await new Promise<void>((done) => {
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data)) as ServerMsg;
      if (msg.t === 'welcome') {
        entityId = msg.entityId;
        result.entityId = msg.entityId;
        result.pos = { x: msg.you.x, y: msg.you.y };
        result.seed = msg.seed;
        result.islandDay = msg.clock.islandDay;
        result.tick = msg.clock.tick;
        if (moveTo) ws.send(JSON.stringify({ t: 'move', to: moveTo }));
        else done();
      }
      if (msg.t === 'delta' && result.pos) {
        for (const u of msg.upd ?? []) {
          if (u.i !== entityId) continue;
          if (u.x !== undefined) result.pos.x = u.x;
          if (u.y !== undefined) result.pos.y = u.y;
        }
      }
    });
    if (moveTo) setTimeout(done, waitMs);
  });

  ws.close();
  await new Promise((r) => setTimeout(r, 200));
  return result as Session;
}

describe('サーバ再起動をまたいだ復帰', () => {
  beforeAll(async () => {
    removeDb();
    await startServer();
  }, 30_000);

  afterAll(async () => {
    await stopServer();
    removeDb();
  });

  test('DBファイルが作られる', () => {
    expect(existsSync(resolve(ROOT, DB_PATH))).toBe(true);
  });

  test('移動 → 再起動 → 同じsecretで元の位置に戻る', async () => {
    const first = await session('secret-restart-A', { x: 55, y: 59 });
    // 広場（64.5, 64.5）から実際に離れていること
    expect(Math.hypot(first.pos.x - 64.5, first.pos.y - 64.5)).toBeGreaterThan(3);

    await stopServer();
    await startServer();

    const second = await session('secret-restart-A');
    expect(second.pos.x).toBeCloseTo(first.pos.x, 1);
    expect(second.pos.y).toBeCloseTo(first.pos.y, 1);
    // 島も同じ（seedが引き継がれている）
    expect(second.seed).toBe(first.seed);
    // アクターIDは再発行される（同じプレイヤーだが新しいアクター）
    expect(second.entityId).not.toBe(first.entityId);
  }, 60_000);

  test('島の時間は巻き戻らない', async () => {
    const before = await session('secret-restart-B');
    await stopServer();
    await startServer();
    const after = await session('secret-restart-B');
    expect(after.tick).toBeGreaterThanOrEqual(before.tick);
    expect(after.islandDay).toBeGreaterThanOrEqual(before.islandDay);
  }, 60_000);

  test('知らないsecretは新規プレイヤーとして広場から始まる', async () => {
    const s = await session('secret-unknown-XYZ');
    expect(s.pos.x).toBeCloseTo(64.5, 1);
    expect(s.pos.y).toBeCloseTo(64.5, 1);
  }, 30_000);
});
