/**
 * T-M14-05, 06, 07: **本物の `server/relay.ts` 越し**にロックステップを走らせる
 *
 * ここは M14 の総合試験。同一プロセスの中に World を 2 つ（3 つ）作り、
 * 「クライアント A」「クライアント B」として並走させ、**実際の中継サーバ経由で
 * 入力だけを交換する**（`07§12`「送っているのは入力だけ」）。
 *
 * 見るべきこと:
 *  1. T-M14-07: 30 分（45,000 tick）走らせて **250 tick ごとのハッシュが全点一致**
 *  2. T-M14-05: 片方を切断 → 120 秒後に復帰させても一致し、
 *     **代行の開始フレームが両端末で同一**
 *  3. T-M14-06: 意図的にデシンクさせると **即座に検出して停止**
 *
 * ■ 速さのために World を小さくしていない
 * `createMatch` の既定（2 人 / 平野 / 200×200）そのままで 45,000 tick を回す。
 * 実測で 1 端末ぶん 1.5 秒程度なので、条件を緩める理由がない。
 *
 * ■ 申し送り（復帰した端末の追いつき）
 * 切断した端末は「不在のあいだの他人の入力」を持っていないので、**自分の World を
 * 追いつかせることはできない**（中継サーバは配り終えた入力を捨てるため）。
 * だから席の復帰は「席が戻ったことを残りの端末が同じ tick で認識する」ところまでが
 * この層の担当で、復帰した本人の状態復元は M15（リプレイ = 入力の記録）の仕事。
 * ここでは復帰する席を**入力だけ出す席**として扱っている。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { WebSocketServer } from 'ws';

import { startRelay } from '../../server/relay';
import type { PlayerId } from '@/shared/types';
import type { World } from '@/sim/core/world';
import { HASH_CHECK_INTERVAL_TICKS, createMatch, hashWorld } from '@/sim';
import { getPlayer } from '@/sim/core/world';
import type { NetplaySession } from '@/net';
import { SUBSTITUTE_AFTER_TICKS, SEAT_HOLD_TICKS, TURN_TICKS, decodeS2C, encodeC2S, joinMatch } from '@/net';

/** 30 分（`config.matchLengthSec` 1800 秒 × 25 tick/秒）。 */
const MATCH_TICKS = 45_000;

/** テスト全体の締め切り（この時間を超えたら止まっていると判断する）。 */
const DEADLINE_MS = 240_000;

let server: WebSocketServer | null = null;
let port = 0;
const sockets: WebSocket[] = [];
const sessions: NetplaySession[] = [];

function boot(): void {
  server = startRelay(0);
  const addr = server.address();
  port = typeof addr === 'object' && addr !== null ? addr.port : 0;
}

afterEach(async () => {
  for (const s of sessions.splice(0)) s.stop();
  for (const s of sockets.splice(0)) s.terminate();
  const srv = server;
  server = null;
  if (srv === null) return;
  for (const c of srv.clients) c.terminate();
  await new Promise<void>((resolve) => srv.close(() => resolve()));
});

/** `ws` の WebSocket を `net/client.ts` の口に合わせる。 */
function connect(url: string): WebSocket {
  const ws = new WebSocket(url);
  sockets.push(ws);
  return ws;
}

/** 1 端末（World + 通信）。 */
interface Terminal {
  readonly name: string;
  world: World;
  session: NetplaySession;
  playerId: PlayerId;
  /** 250 tick ごとのハッシュ（tick 昇順）。 */
  readonly hashes: { tick: number; hash: number }[];
}

/**
 * 部屋に入って `start` を待ち、World を作った端末を返す。
 *
 * `joinMatch`（`src/net/session.ts`）をそのまま使う ―― **本番と同じ経路**で
 * 検証したいので、テスト専用の近道は作らない。
 */
async function openTerminal(room: string, name: string, playerCount: number): Promise<Terminal> {
  let resolveReady: (() => void) | null = null;
  const ready = new Promise<void>((r) => (resolveReady = r));
  const term = {
    name,
    hashes: [] as { tick: number; hash: number }[],
  } as Terminal;

  const session = joinMatch({
    room,
    name,
    url: `ws://127.0.0.1:${port}`,
    connect: (url) => connect(url) as unknown as ReturnType<typeof connect> & {
      send(data: string): void;
      close(): void;
      addEventListener(type: string, listener: (ev: unknown) => void): void;
    },
    onReady: (info) => {
      const { world } = createMatch({
        seed: info.seed,
        playerCount,
        // 全端末が同じ対戦カードを組む（オンラインでは対戦設定で合わせる）
        civs: ['yamato', 'mongol', 'roma', 'persia'].slice(0, playerCount) as never,
        mapType: 'plain',
      });
      term.world = world;
      term.playerId = info.playerId;
      resolveReady?.();
    },
  });
  term.session = session;
  sessions.push(session);
  await ready;
  return term;
}

/** 部屋の全員が揃うまで待つ（`start` は全員が `ready` を押してから配られる）。 */
async function openRoom(room: string, names: readonly string[]): Promise<Terminal[]> {
  const pending = names.map((n) => openTerminal(room, n, names.length));
  return Promise.all(pending);
}

/** I/O を 1 巡させる。 */
function tickIo(): Promise<void> {
  return new Promise<void>((r) => setImmediate(r));
}

/**
 * 全端末を `until` tick まで進める。
 *
 * 進めなくなったら I/O を 1 巡させて待つ（= 「入力が揃うまで待つ」の実体）。
 * `onTick` は 1 tick 進むたびに呼ばれる（入力の注入と観測に使う）。
 */
async function runTo(
  terms: readonly Terminal[],
  until: number,
  onTick?: (t: Terminal) => void,
): Promise<void> {
  const deadline = Date.now() + DEADLINE_MS;
  for (;;) {
    let moved = false;
    for (const t of terms) {
      while (t.world.tick < until) {
        const r = t.session.step(t.world);
        if (r !== 'stepped') break;
        moved = true;
        if (t.world.tick % HASH_CHECK_INTERVAL_TICKS === 0) {
          t.hashes.push({ tick: t.world.tick, hash: hashWorld(t.world) });
        }
        onTick?.(t);
      }
    }
    if (terms.every((t) => t.world.tick >= until)) return;
    if (t0Halted(terms)) return;
    if (!moved) await tickIo();
    if (Date.now() > deadline) {
      throw new Error(
        `進まなくなった: ${terms.map((t) => `${t.name}@${t.world.tick}`).join(' / ')}`,
      );
    }
  }
}

function t0Halted(terms: readonly Terminal[]): boolean {
  return terms.some((t) => t.session.desync !== null);
}

/**
 * 「入力だけ出す席」。
 *
 * 復帰した席の代わり（World を持たない）。
 *
 * **中継サーバに既に配り終えた tick を後から出してはいけない。**
 * `flushReadyTicks` は tick 昇順に見て「揃っていない最初の tick」で止まるので、
 * 配り終えた tick に 1 人だけの入力が入ると、そこで待ち行列が永久に止まる。
 * だから「まだ誰も出していない最初の tick」から入れる ―― そのために
 * `ready`（= `welcome` が返ってきた合図）を待ってから他の端末を動かす。
 */
class SeatOnly {
  private readonly ws: WebSocket;
  private next = -1;
  /** `welcome` が届いたら解決する（席が戻ったことの確認）。 */
  readonly ready: Promise<number>;

  constructor(room: string, name: string) {
    this.ws = connect(`ws://127.0.0.1:${port}`);
    this.ready = new Promise<number>((resolve) => {
      this.ws.addEventListener('message', (ev) => {
        const msg = decodeS2C(String((ev as { data?: unknown }).data ?? ''));
        if (msg !== null && msg.t === 'welcome') resolve(msg.playerId);
      });
    });
    this.ws.addEventListener('open', () => {
      // 同じ名前で戻れば席を引き継ぐ（`server/relay.ts` の 120 秒保持）
      this.ws.send(encodeC2S({ t: 'join', room, name }));
    });
  }

  /** 入力を出し始める tick（まだ誰も出していない最初の turn 境界）。 */
  startAt(tick: number): void {
    this.next = Math.ceil(tick / TURN_TICKS) * TURN_TICKS;
  }

  /** `upto` tick までの空入力を出す。 */
  ensureUpTo(upto: number): void {
    while (this.next >= 0 && this.next <= upto) {
      this.ws.send(encodeC2S({ t: 'input', tick: this.next, cmds: [] }));
      this.next += TURN_TICKS;
    }
  }
}

// ---------------------------------------------------------------------------

describe('T-M14-07: 2 端末 30 分対戦でデシンクなし', () => {
  it(
    '45,000 tick を本物の中継サーバ越しに走らせ、250 tick ごとのハッシュが全点一致する',
    async () => {
      boot();
      const [a, b] = await openRoom('m30', ['A', 'B']);
      expect(a).toBeDefined();
      expect(b).toBeDefined();
      const terms = [a!, b!];
      // 自分の席が別々に割り当たっている（`welcome` の playerId）
      expect([a!.playerId, b!.playerId].sort()).toEqual([0, 1]);

      // 入力を混ぜる（無入力だけだと「入力が届いていること」を確かめられない）。
      // **自分の席の令だけを出す**。tick を基準にするので端末ごとにぶれない。
      const inject = (t: Terminal): void => {
        if (t.world.tick % 600 !== 0) return;
        const front = ((t.world.tick / 600) % 6) + 1;
        t.session.emit({ t: 'setOrder', p: t.playerId, front, order: 'charge', tier: 'upper' });
      };

      await runTo(terms, MATCH_TICKS, inject);

      expect(a!.world.tick).toBe(MATCH_TICKS);
      expect(b!.world.tick).toBe(MATCH_TICKS);
      // サーバがデシンクを 1 度も通知していない
      expect(a!.session.desync).toBeNull();
      expect(b!.session.desync).toBeNull();

      // 250 tick ごとのハッシュが全点一致（tick 250〜45,000 の 180 点）
      expect(a!.hashes.length).toBe(MATCH_TICKS / HASH_CHECK_INTERVAL_TICKS);
      expect(a!.hashes.map((h) => h.tick)).toEqual(b!.hashes.map((h) => h.tick));
      expect(a!.hashes.map((h) => h.hash)).toEqual(b!.hashes.map((h) => h.hash));
      // 試合が「動いている」こと（全点同じ値なら World が止まっている）
      expect(new Set(a!.hashes.map((h) => h.hash)).size).toBeGreaterThan(100);
    },
    DEADLINE_MS + 60_000,
  );
});

describe('T-M14-05: 切断 → 120 秒後に復帰しても一致する', () => {
  it(
    '2 端末が同じフレームで AI 代行を始め、復帰後もハッシュが完全一致する',
    async () => {
      boot();
      const [a, b, c] = await openRoom('mdrop', ['A', 'B', 'C']);
      const terms = [a!, b!];
      const dropped = c!;
      const droppedId = dropped.playerId;

      // まず 3 人で 3,000 tick（2 分）走らせる
      await runTo([a!, b!, dropped], 3_000);
      expect(dropped.world.tick).toBe(3_000);

      // C が切断（サーバは席を 120 秒保持し、`left` を配る）
      dropped.session.stop();

      // 残る 2 端末で走らせる。代行は「入力が 3 秒届かなかった tick」から始まる。
      // 6,100 tick まで = 切断から 3,100 tick（124 秒）＝ 席の保持期限 120 秒を越える
      await runTo(terms, 6_100);
      const startA = a!.session.substituteStartTick(droppedId);
      const startB = b!.session.substituteStartTick(droppedId);
      expect(startA).toBeGreaterThan(3_000);
      // **同じフレームで代行を開始している**（時計ではなく tick で決めているため）
      expect(startA).toBe(startB);
      expect(startA - 3_000).toBeLessThanOrEqual(SUBSTITUTE_AFTER_TICKS + TURN_TICKS * 2);
      expect(a!.session.substituting()).toEqual([droppedId]);
      expect(b!.session.substituting()).toEqual([droppedId]);
      // 席の保持期限（120 秒 = 3,000 tick）を越えている。それでも AI は続ける
      expect(a!.world.tick - 3_000).toBeGreaterThan(SEAT_HOLD_TICKS);
      expect(hashWorld(a!.world)).toBe(hashWorld(b!.world));

      // ---- 席が戻る ----
      //
      // **`welcome` を待ってから A/B を動かす。** 待たずに動かすと、A/B が先に出した
      // tick が「在席 2 人」で配られてしまい、そこへ戻った席が後から同じ tick を出して
      // 中継サーバの待ち行列を止める（配り終えた tick に 1 人だけの入力が残るため）。
      const seat = new SeatOnly('mdrop', 'C');
      const seatId = await seat.ready;
      // 同じ名前なので同じ席（playerId）を引き継ぐ
      expect(seatId).toBe(droppedId);
      seat.startAt(a!.world.tick + TURN_TICKS);
      seat.ensureUpTo(a!.world.tick + 300);
      await runTo(terms, 8_000, (t) => {
        if (t === a!) seat.ensureUpTo(t.world.tick + 300);
      });

      // 戻ったら代行をやめる（`07§12`「戻れば操作を引き継げます」）
      expect(a!.session.substituting()).toEqual([]);
      expect(b!.session.substituting()).toEqual([]);
      expect(a!.session.substituteStartTick(droppedId)).toBe(-1);
      expect(b!.session.substituteStartTick(droppedId)).toBe(-1);

      // 切断・代行・復帰をまたいで 250 tick ごとのハッシュが全点一致
      expect(a!.hashes.length).toBe(8_000 / HASH_CHECK_INTERVAL_TICKS);
      expect(a!.hashes.map((h) => h.hash)).toEqual(b!.hashes.map((h) => h.hash));
      expect(a!.session.desync).toBeNull();
      expect(b!.session.desync).toBeNull();
    },
    DEADLINE_MS + 60_000,
  );
});

describe('T-M14-06: 意図的にデシンクさせると即座に検出・停止する', () => {
  it(
    '片方の World を 1 だけ書き換えると、次の 250 tick で検出して止まる',
    async () => {
      boot();
      const [a, b] = await openRoom('mdesync', ['A', 'B']);
      const terms = [a!, b!];

      await runTo(terms, 300);
      expect(a!.session.desync).toBeNull();

      // **A の World だけを 1 Fx ずらす**（シムの不具合を再現する。テストだけの反則）
      const victim = getPlayer(a!.world, 0);
      expect(victim).toBeDefined();
      victim!.resources[0] = (victim!.resources[0] ?? 0) + 1;

      // 次のハッシュ突合（tick 500）で食い違いが出る
      await runTo(terms, 1_000);

      const info = a!.session.desync;
      expect(info).not.toBeNull();
      expect(info!.tick).toBe(500);
      // どちらが正しいかは入っていない（値が 2 つ並ぶだけ）
      const hashes = Object.values(info!.hashes);
      expect(hashes).toHaveLength(2);
      expect(hashes[0]).not.toBe(hashes[1]);
      // 相手側にも同じ通知が届き、両方が止まる。
      //
      // **通知が届くのを待つ。** A が先に検出すると A の tick は止まるので、
      // `runTo`（tick が進むのを待つ関数）では待てない ―― 通信だけを回す。
      // 「1,000 tick 回したら必ず届いている」と決め打つと、盤面の重さが変わった
      // だけで落ちる（実測で落ちた）。
      for (let k = 0; k < 200 && b!.session.desync === null; k++) {
        b!.session.step(b!.world);
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(b!.session.desync).not.toBeNull();
      expect(b!.session.desync!.tick).toBe(500);

      // **即座に停止**（それ以上 tick を進めない）
      const at = a!.world.tick;
      expect(a!.session.step(a!.world)).toBe('halted');
      expect(a!.world.tick).toBe(at);
      expect(at).toBeLessThan(500 + HASH_CHECK_INTERVAL_TICKS);
    },
    DEADLINE_MS,
  );
});
