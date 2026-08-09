/**
 * server/relay.ts — ロックステップの入力中継（T-M14-01, 02）
 *
 * `07§12`:
 *  - ゲームロジックは決定論なので、**入力だけを交換すれば全端末で同じ試合になる**
 *  - **このサーバはゲームロジックを一切持たない。** 部屋を作り、入力を配るだけ
 *  - ユニットの座標は送らないので、通信量は人数に関係なくごく小さい
 *
 * ■ なぜサーバに判定を持たせないのか
 * 判定を持たせると「サーバの計算」と「各端末の計算」の 2 つの真実ができ、
 * ずれたときにどちらが正しいか決められなくなる。決定論を採った意味が消える。
 * サーバは**郵便配達**に徹する。
 *
 * ■ 起動
 *   npm run server            # ポート 8787（環境変数 PORT で変更）
 *
 * ■ 部屋
 *   URL の `#room=xxxx` を共有するだけで参加できる（アカウント登録なし。`01`）。
 *   部屋 ID はクライアントが決める（サーバは文字列として扱うだけ）。
 */

import { WebSocketServer, type WebSocket } from 'ws';

/** 既定のポート。 */
const DEFAULT_PORT = 8787;

/** 1 部屋の最大人数（`01`「最大 8 人」）。 */
const MAX_PLAYERS = 8;

/**
 * 入力遅延（フレーム）。`07§12`「入力遅延 3 フレーム（120ms）先の tick 宛に入力を送る」。
 * サーバはこの値を配るだけで、待ち合わせの判断はクライアントが行う。
 */
const INPUT_DELAY_FRAMES = 3;

/** 席を保持する時間（`07§12`「席は 120 秒保持され、その間は AI が代行」）。 */
const SEAT_HOLD_MS = 120_000;

// ---------------------------------------------------------------- プロトコル

/** クライアント → サーバ。 */
type C2S =
  | { t: 'join'; room: string; name: string }
  | { t: 'ready' }
  | { t: 'input'; tick: number; cmds: unknown[] }
  | { t: 'hash'; tick: number; hash: number };

/** サーバ → クライアント。 */
type S2C =
  | {
      t: 'welcome';
      playerId: number;
      seed: number;
      inputDelayFrames: number;
      players: { playerId: number; name: string; ready: boolean }[];
    }
  | { t: 'roster'; players: { playerId: number; name: string; ready: boolean }[] }
  | { t: 'start'; startTick: number }
  | { t: 'input'; tick: number; byPlayer: Record<number, unknown[]> }
  | { t: 'desync'; tick: number; hashes: Record<number, number> }
  | { t: 'left'; playerId: number; atTick: number; holdMs: number }
  | { t: 'error'; message: string };

// ---------------------------------------------------------------- 部屋

interface Seat {
  playerId: number;
  name: string;
  ws: WebSocket | null;
  ready: boolean;
  /** 切断した時刻（ms）。null = 接続中。 */
  goneAt: number | null;
}

interface Room {
  id: string;
  /** マップ生成と乱数のシード。**部屋を作った瞬間に決めて全員に配る**（決定論の前提）。 */
  seed: number;
  seats: Seat[];
  started: boolean;
  /**
   * tick ごとの入力。`inputs.get(tick)` は playerId → cmds。
   * **全員分が揃った tick だけを配る**（ロックステップ）。
   */
  inputs: Map<number, Map<number, unknown[]>>;
  /** 突き合わせ用のハッシュ。`hashes.get(tick)` は playerId → hash。 */
  hashes: Map<number, Map<number, number>>;
  /** デシンクを既に通知した tick（二重に流さない）。 */
  desyncReported: Set<number>;
}

const rooms = new Map<string, Room>();

/**
 * シードの決め方。
 *
 * **サーバ側で 1 回だけ決めて全員に配る。** クライアントが決めると、
 * 部屋の主が悪意を持って有利なマップを引き直せてしまう。
 * `Math.random` を使うのはサーバだけ（sim には入らないので決定論に影響しない）。
 */
function makeSeed(): number {
  return (Math.floor(Math.random() * 0xffffffff) >>> 0) | 0;
}

function getRoom(id: string): Room {
  const found = rooms.get(id);
  if (found !== undefined) return found;
  const room: Room = {
    id,
    seed: makeSeed(),
    seats: [],
    started: false,
    inputs: new Map(),
    hashes: new Map(),
    desyncReported: new Set(),
  };
  rooms.set(id, room);
  return room;
}

function roster(room: Room): { playerId: number; name: string; ready: boolean }[] {
  // playerId 昇順（クライアントの表示順と Command の並び順に合わせる）
  return room.seats
    .slice()
    .sort((a, b) => a.playerId - b.playerId)
    .map((s) => ({ playerId: s.playerId, name: s.name, ready: s.ready }));
}

function send(ws: WebSocket | null, msg: S2C): void {
  if (ws === null || ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(msg));
}

function broadcast(room: Room, msg: S2C): void {
  for (const s of room.seats) send(s.ws, msg);
}

/** 空いている playerId のうち最小のものを返す（-1 = 満席）。 */
function nextPlayerId(room: Room): number {
  for (let p = 0; p < MAX_PLAYERS; p++) {
    if (!room.seats.some((s) => s.playerId === p)) return p;
  }
  return -1;
}

/**
 * その tick の入力が全員分揃っていれば配る。
 *
 * **揃っていなければ何も配らない。** これがロックステップの本体で、
 * 「誰かの回線が遅いと全員が同じだけ待つ」（`07§12`）を実現している。
 * 切断中の席は「AI が代行する」ので入力を待たない（代行の判断はクライアント側。
 * 全端末が同じフレームで同じ判断をするので決定論は崩れない）。
 */
function flushReadyTicks(room: Room): void {
  const live = room.seats.filter((s) => s.goneAt === null);
  if (live.length === 0) return;
  // tick 昇順に配る（順序が入れ替わると再現性が壊れる）
  const ticks = [...room.inputs.keys()].sort((a, b) => a - b);
  for (const tick of ticks) {
    const perPlayer = room.inputs.get(tick)!;
    const allIn = live.every((s) => perPlayer.has(s.playerId));
    if (!allIn) break; // ここで止める（後の tick を先に配ってはいけない）
    const byPlayer: Record<number, unknown[]> = {};
    // playerId 昇順で詰める（`stepWorld` に渡す並び順の規約。手順書 §4.1）
    for (const pid of [...perPlayer.keys()].sort((a, b) => a - b)) {
      byPlayer[pid] = perPlayer.get(pid)!;
    }
    broadcast(room, { t: 'input', tick, byPlayer });
    room.inputs.delete(tick);
  }
}

/** ハッシュが揃った tick を突き合わせて、食い違っていれば全員に知らせる。 */
function checkHashes(room: Room, tick: number): void {
  const perPlayer = room.hashes.get(tick);
  if (perPlayer === undefined) return;
  const live = room.seats.filter((s) => s.goneAt === null);
  if (!live.every((s) => perPlayer.has(s.playerId))) return;

  const values = [...perPlayer.values()];
  const first = values[0];
  const same = values.every((v) => v === first);
  room.hashes.delete(tick);
  if (same) return;
  if (room.desyncReported.has(tick)) return;
  room.desyncReported.add(tick);

  const hashes: Record<number, number> = {};
  for (const [pid, h] of [...perPlayer.entries()].sort((a, b) => a[0] - b[0])) hashes[pid] = h;
  // **デシンクはサーバが判定して知らせるだけ**。どちらが正しいかは決めない
  // （サーバはゲームロジックを持たないので判定できない）。
  broadcast(room, { t: 'desync', tick, hashes });
}

/** 期限切れの席を掃除する（120 秒戻らなければ AI が引き継ぐ）。 */
function reapSeats(room: Room, nowMs: number): void {
  const before = room.seats.length;
  room.seats = room.seats.filter((s) => s.goneAt === null || nowMs - s.goneAt < SEAT_HOLD_MS);
  if (room.seats.length !== before) broadcast(room, { t: 'roster', players: roster(room) });
  if (room.seats.length === 0) rooms.delete(room.id);
}

// ---------------------------------------------------------------- サーバ

export function startRelay(port: number = DEFAULT_PORT): WebSocketServer {
  const wss = new WebSocketServer({ port });

  wss.on('connection', (ws: WebSocket) => {
    let room: Room | null = null;
    let seat: Seat | null = null;

    ws.on('message', (raw: Buffer | string) => {
      let msg: C2S;
      try {
        msg = JSON.parse(String(raw)) as C2S;
      } catch {
        // 壊れたメッセージで部屋を落とさない（`07§12` の思想と同じ）
        send(ws, { t: 'error', message: 'JSON として読めません' });
        return;
      }

      switch (msg.t) {
        case 'join': {
          if (room !== null) return; // 二重 join は無視
          const r = getRoom(String(msg.room));
          // 同じ名前で戻ってきた席があれば引き継ぐ（`07§12` の 120 秒保持）
          const returning = r.seats.find((s) => s.goneAt !== null && s.name === msg.name);
          if (returning !== undefined) {
            returning.ws = ws;
            returning.goneAt = null;
            room = r;
            seat = returning;
          } else {
            const pid = nextPlayerId(r);
            if (pid < 0) {
              send(ws, { t: 'error', message: '満席です（最大 8 人）' });
              return;
            }
            const s: Seat = { playerId: pid, name: String(msg.name), ws, ready: false, goneAt: null };
            r.seats.push(s);
            room = r;
            seat = s;
          }
          send(ws, {
            t: 'welcome',
            playerId: seat.playerId,
            seed: r.seed,
            inputDelayFrames: INPUT_DELAY_FRAMES,
            players: roster(r),
          });
          broadcast(r, { t: 'roster', players: roster(r) });
          if (r.started) send(ws, { t: 'start', startTick: 0 });
          return;
        }

        case 'ready': {
          if (room === null || seat === null) return;
          seat.ready = true;
          broadcast(room, { t: 'roster', players: roster(room) });
          // 全員が押したら開始（`05§3`-7）
          if (!room.started && room.seats.length > 0 && room.seats.every((s) => s.ready)) {
            room.started = true;
            broadcast(room, { t: 'start', startTick: 0 });
          }
          return;
        }

        case 'input': {
          if (room === null || seat === null) return;
          if (!Number.isInteger(msg.tick) || msg.tick < 0) return;
          let perPlayer = room.inputs.get(msg.tick);
          if (perPlayer === undefined) {
            perPlayer = new Map();
            room.inputs.set(msg.tick, perPlayer);
          }
          // 同じ tick を 2 回送ってきたら**最初のものを残す**
          // （後から書き換えられると、既に配った入力と食い違う）
          if (!perPlayer.has(seat.playerId)) {
            perPlayer.set(seat.playerId, Array.isArray(msg.cmds) ? msg.cmds : []);
          }
          flushReadyTicks(room);
          return;
        }

        case 'hash': {
          if (room === null || seat === null) return;
          if (!Number.isInteger(msg.tick)) return;
          let perPlayer = room.hashes.get(msg.tick);
          if (perPlayer === undefined) {
            perPlayer = new Map();
            room.hashes.set(msg.tick, perPlayer);
          }
          perPlayer.set(seat.playerId, msg.hash | 0);
          checkHashes(room, msg.tick);
          return;
        }

        default:
          return;
      }
    });

    ws.on('close', () => {
      if (room === null || seat === null) return;
      seat.ws = null;
      seat.goneAt = Date.now();
      // 席は 120 秒保持。その間はクライアント側の AI が代行する（`07§12`）
      broadcast(room, {
        t: 'left',
        playerId: seat.playerId,
        atTick: -1,
        holdMs: SEAT_HOLD_MS,
      });
      broadcast(room, { t: 'roster', players: roster(room) });
      // 切断で待ち合わせが止まらないよう、揃っている tick を配り直す
      flushReadyTicks(room);
    });
  });

  // 期限切れの席の掃除（10 秒ごと）
  const timer = setInterval(() => {
    const now = Date.now();
    for (const room of [...rooms.values()]) reapSeats(room, now);
  }, 10_000);
  wss.on('close', () => clearInterval(timer));

  return wss;
}

// `node server/relay.ts` で直接起動されたときだけ待ち受ける
// （テストから import したときにポートを掴まないため）。
if (process.argv[1] !== undefined && process.argv[1].endsWith('relay.ts')) {
  const port = Number.parseInt(process.env['PORT'] ?? '', 10);
  const server = startRelay(Number.isFinite(port) ? port : DEFAULT_PORT);
  const addr = server.address();
  const shown = typeof addr === 'object' && addr !== null ? addr.port : DEFAULT_PORT;
  console.log(`[relay] ws://localhost:${shown} で待ち受け中（ゲームロジックは持ちません）`);
}
