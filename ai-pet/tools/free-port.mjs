/**
 * 開発用: これから使うポートを掴んでいる「前回のこのサーバ」を止める。
 *
 * `node --watch` で開発していると、前のプロセスが残ったまま新しく起動して
 * EADDRINUSE で落ちることがよくある。毎回 lsof で調べて kill するのは手間なので、
 * `npm run dev` の前に自動でやる。
 *
 * **安全のための方針**: 掴んでいるのが自分たちのサーバだと確認できたときだけ止める。
 * 見覚えのないプロセスは絶対に殺さず、何が掴んでいるかを表示して終了する
 * （8787 を別の用途で使っている人のプロセスを黙って落とすほうが被害が大きい）。
 *
 * 使い方: node ../../tools/free-port.mjs [ポート]
 * ポート省略時は環境変数 PORT、それも無ければ 8787。
 */
import { execFileSync } from 'node:child_process';

const port = Number(process.argv[2] ?? process.env['PORT'] ?? 8787);

/** 「自分たちのサーバ」だと判断する目印 */
const OURS = ['packages/server/src/main.ts', 'src/main.ts'];

function sh(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return ''; // 見つからない場合も lsof は非0で終わるので、エラーと区別しない
  }
}

function listeners(p) {
  const out = sh('lsof', ['-nP', `-iTCP:${p}`, '-sTCP:LISTEN', '-t']);
  return out ? [...new Set(out.split('\n').map(Number).filter(Boolean))] : [];
}

function commandOf(pid) {
  return sh('ps', ['-o', 'command=', '-p', String(pid)]);
}

const pids = listeners(port);
if (pids.length === 0) process.exit(0);

const unknown = [];
const mine = [];
for (const pid of pids) {
  const cmd = commandOf(pid);
  if (pid === process.pid) continue;
  if (OURS.some((k) => cmd.includes(k))) mine.push({ pid, cmd });
  else unknown.push({ pid, cmd });
}

if (unknown.length > 0) {
  console.error(`\n[free-port] ポート ${port} を別のプロセスが使っています。自動では止めません:`);
  for (const u of unknown) console.error(`  PID ${u.pid}  ${u.cmd}`);
  console.error(`\n止めてよいものなら次を実行してください:  kill ${unknown.map((u) => u.pid).join(' ')}`);
  console.error(`別のポートで動かすなら:  PORT=8788 npm run dev\n`);
  process.exit(1);
}

for (const m of mine) {
  console.log(`[free-port] ポート ${port} を掴んでいた前回のサーバを止めます (PID ${m.pid})`);
  try {
    // まず SIGTERM。サーバ側の停止処理（DB保存・接続の切断通知）を通したい
    process.kill(m.pid, 'SIGTERM');
  } catch {
    // すでに居ない
  }
}

// 解放されるまで待つ（保存処理があるので即座には空かない）
const deadline = Date.now() + 6000;
while (Date.now() < deadline) {
  if (listeners(port).length === 0) process.exit(0);
  // 同期的に少し待つ（この時点ではまだイベントループに用がない）
  try {
    execFileSync('sleep', ['0.2'], { stdio: 'ignore' });
  } catch {
    break;
  }
}

// 落ちきらないので強制する
for (const m of listeners(port)) {
  console.log(`[free-port] 応答しないので強制終了します (PID ${m})`);
  try {
    process.kill(m, 'SIGKILL');
  } catch {
    // すでに居ない
  }
}
try {
  execFileSync('sleep', ['0.4'], { stdio: 'ignore' });
} catch {
  // sleep が無い環境では待たない
}

if (listeners(port).length > 0) {
  console.error(`[free-port] ポート ${port} を解放できませんでした`);
  process.exit(1);
}
