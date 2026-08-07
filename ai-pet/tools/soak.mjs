/**
 * 連続稼働の負荷試験（M8完了条件「1週間無停止でDB破損・メモリリークなし」の代替検証）。
 *
 * 1週間そのまま回すのは現実的でないので、
 * 「クライアントが出入りしながら動き続ける状態」を短時間で濃くして、
 * RSSの伸びとDBの健全性を測る。
 *
 * 使い方: node tools/soak.mjs <分>（省略時25分）
 */
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, statSync } from 'node:fs';
import WebSocket from 'ws';

const MINUTES = Number(process.argv[2] ?? 25);
const PORT = 8793;
const DB = '.tmp/soak-island.db';
const CLIENTS = 4;

mkdirSync('.tmp', { recursive: true });
for (const s of ['', '-wal', '-shm']) rmSync(DB + s, { force: true });

const server = spawn(process.execPath, ['packages/server/src/main.ts', '--llm=mock'], {
  env: { ...process.env, PORT: String(PORT), DB_PATH: DB, ISLAND_SEED: 'soak-seed', LLM_MODE: 'mock' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const serverLog = [];
server.stdout.on('data', (d) => serverLog.push(String(d)));
server.stderr.on('data', (d) => serverLog.push(String(d)));

async function waitHealth() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://localhost:${PORT}/healthz`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('起動しない:\n' + serverLog.join(''));
}
await waitHealth();

/** 1人ぶんの挙動: 入って歩き回り、ときどき話しかけ、ときどき切断して入り直す */
function player(index) {
  let ws = null;
  let secret = null;
  let alive = true;
  let step = 0;

  const connect = () => {
    if (!alive) return;
    ws = new WebSocket(`ws://localhost:${PORT}/ws`);
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', v: 1, secret, displayName: `soak${index}` })));
    ws.on('message', (d) => {
      try {
        const m = JSON.parse(d.toString());
        if (m.t === 'welcome') {
          secret = m.secret ?? secret;
          if (!m.pet && m.petCatalog?.length) {
            ws.send(JSON.stringify({ t: 'createPet', species: m.petCatalog[0].species, name: `そ${index}`, persona: {} }));
          }
        }
      } catch {}
    });
    ws.on('error', () => {});
    ws.on('close', () => {
      if (alive) setTimeout(connect, 800);
    });
  };
  connect();

  const timer = setInterval(() => {
    step++;
    if (!ws || ws.readyState !== 1) return;
    // 歩く
    const dx = Math.sin(step * 0.7 + index) > 0 ? 1 : -1;
    const dy = Math.cos(step * 0.5 + index) > 0 ? 1 : -1;
    ws.send(JSON.stringify({ t: 'moveAxis', dx, dy }));
    ws.send(JSON.stringify({ t: 'ping', ts: Date.now() }));
    // ときどき話しかける
    if (step % 23 === 0) ws.send(JSON.stringify({ t: 'say', text: 'げんき？' }));
    // ときどき何か置く
    if (step % 61 === 0) ws.send(JSON.stringify({ t: 'place', type: 'bench', pos: { x: 60 + index, y: 60 } }));
    // ときどき落ちる（再接続の経路とアクター片づけを回す）
    if (step % 97 === 0) ws.close();
  }, 500);

  return () => {
    alive = false;
    clearInterval(timer);
    ws?.close();
  };
}

const stops = Array.from({ length: CLIENTS }, (_, i) => player(i));

const samples = [];
const t0 = Date.now();
const endAt = t0 + MINUTES * 60_000;

while (Date.now() < endAt) {
  await new Promise((r) => setTimeout(r, 30_000));
  let rssMB = 0;
  try {
    const out = await new Promise((res) => {
      const ps = spawn('ps', ['-o', 'rss=', '-p', String(server.pid)]);
      let s = '';
      ps.stdout.on('data', (d) => (s += String(d)));
      ps.on('close', () => res(s.trim()));
    });
    rssMB = Math.round(Number(out) / 1024);
  } catch {}
  let health = null;
  try {
    health = await (await fetch(`http://localhost:${PORT}/healthz`)).json();
  } catch {}
  let dbMB = 0;
  try {
    dbMB = Math.round((statSync(DB).size / 1024 / 1024) * 100) / 100;
  } catch {}
  const minutes = Math.round((Date.now() - t0) / 6000) / 10;
  samples.push({ minutes, rssMB, tick: health?.tick ?? -1, clients: health?.clients ?? -1, dbMB });
  console.log(JSON.stringify(samples.at(-1)));
}

for (const stop of stops) stop();
await new Promise((r) => setTimeout(r, 1500));

// 正常終了させてから整合性を見る
const exited = new Promise((r) => server.once('exit', () => r()));
server.kill('SIGINT');
await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))]);
if (server.exitCode === null) server.kill('SIGKILL');

const integrity = await new Promise((res) => {
  const p = spawn('sqlite3', [DB, 'PRAGMA integrity_check;']);
  let s = '';
  p.stdout.on('data', (d) => (s += String(d)));
  p.on('close', () => res(s.trim()));
  p.on('error', () => res('(sqlite3 コマンドなし)'));
});

const first = samples[0];
const last = samples.at(-1);
console.log(
  JSON.stringify(
    {
      結果: {
        分: MINUTES,
        サンプル数: samples.length,
        RSS開始MB: first?.rssMB,
        RSS終了MB: last?.rssMB,
        RSS増加MB: last && first ? last.rssMB - first.rssMB : null,
        tick進行: last && first ? last.tick - first.tick : null,
        DB容量MB: last?.dbMB,
        integrity_check: integrity,
        エラー行: serverLog.join('').split('\n').filter((l) => /Error|error|失敗/.test(l)).slice(0, 10),
      },
      samples,
    },
    null,
    2,
  ),
);
