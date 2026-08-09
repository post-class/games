/**
 * T-M14-03 / 04 / 05: 待ち合わせ・圧縮・AI 代行の規則（`07§12` / 手順書 §11）
 *
 * ここは **WebSocket も DOM も使わない**。`Lockstep` は送信口が関数 1 つなので、
 * 配列に溜めるだけの偽リンクと「偽の中継サーバ」で規則そのものを検算できる。
 * 本物の `server/relay.ts` を通した検証は `tests/determinism/lockstep.test.ts`。
 *
 * 見るべきこと:
 *  1. 入力は **現在 tick + inputDelayFrames 以降**の tick 宛にしか出ない（過去へ戻らない）
 *  2. **全員揃うまで進まない**。誰かが遅いと**全員が同じだけ待つ**
 *  3. 8 人 30 分の通信量が **1MB 以内**（実測）
 *  4. 代行の開始は **tick 番号だけ**で決まり、2 端末が**同じフレーム**で始める
 *  5. `stepWorld` に渡す並びは **playerId 昇順 → 発行順**
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import configJson from '@/data/config.json' with { type: 'json' };
import type { PlayerId } from '@/shared/types';
import type { Command } from '@/sim/command';
import type { World } from '@/sim/core/world';
import { HASH_CHECK_INTERVAL_TICKS, createMatch, hashWorld } from '@/sim';
import {
  InputSender,
  Lockstep,
  SEAT_HOLD_TICKS,
  SUBSTITUTE_AFTER_TICKS,
  SeatWatch,
  TURN_TICKS,
  decodeS2C,
  encodeC2S,
  mergeTurnCommands,
  presentPlayers,
  utf8Bytes,
} from '@/net';

/** 30 分（`config.matchLengthSec` × `tickRate`）。 */
const MATCH_TICKS = 45_000;

/** T-M14-04 の完了条件（`config.json` の `net.trafficBudgetBytes`）。 */
const TRAFFIC_BUDGET_BYTES = (configJson as { net: { trafficBudgetBytes: number } }).net
  .trafficBudgetBytes;

// ---------------------------------------------------------------- 偽の中継サーバ

/**
 * `server/relay.ts` の待ち合わせ規則だけを写した偽サーバ。
 *
 * 写しているのは 3 点だけ:
 *   - **全員分が揃った tick だけ配る**
 *   - **先の tick を先に配らない**
 *   - 同じ tick の 2 通目は捨てる
 * （本物との一致は `tests/determinism/lockstep.test.ts` が確かめる）
 */
class FakeRelay {
  private readonly seats = new Map<PlayerId, Lockstep>();
  private live: PlayerId[] = [];
  private readonly inputs = new Map<number, Map<PlayerId, Command[]>>();
  /** 配った通数とバイト数（受信側の通信量の実測に使う）。 */
  broadcastBytes = 0;
  broadcastMessages = 0;
  /**
   * 「回線が詰まった席」（`07§12` の遅い回線）。
   * **捨てるのではなく溜める。** WebSocket は遅れても順番に届くので、
   * 捨ててしまうと現実に起きない状況（永久に埋まらない tick）を作ってしまう。
   */
  private readonly stalled = new Map<PlayerId, string[]>();
  /** 「切断された席」（届いた入力は捨てる。サーバは待たない）。 */
  private readonly gone = new Set<PlayerId>();

  join(p: PlayerId, ls: Lockstep): void {
    this.seats.set(p, ls);
    this.live = [...this.seats.keys()].sort((a, b) => a - b);
  }

  /** 回線を詰まらせる（送信は溜まる。届くのは `resume` のとき）。 */
  stall(p: PlayerId): void {
    if (!this.stalled.has(p)) this.stalled.set(p, []);
  }

  /** 詰まっていた入力を順番に流す。 */
  resume(p: PlayerId): void {
    const queued = this.stalled.get(p) ?? [];
    this.stalled.delete(p);
    for (const text of queued) this.receive(p, text);
  }

  /** 席を落とす（サーバから見た切断）。以降その席の入力は待たない。 */
  drop(p: PlayerId): void {
    this.live = this.live.filter((x) => x !== p);
    this.gone.add(p);
    this.stalled.delete(p);
    this.flush();
  }

  /** 席を戻す。 */
  rejoin(p: PlayerId): void {
    this.gone.delete(p);
    if (!this.live.includes(p)) this.live = [...this.live, p].sort((a, b) => a - b);
  }

  /** クライアントからの生文字列。 */
  receive(from: PlayerId, text: string): void {
    const queue = this.stalled.get(from);
    if (queue !== undefined) {
      queue.push(text); // 遅れて届く
      return;
    }
    if (this.gone.has(from)) return; // 切断中の席の入力は捨てる
    const raw = JSON.parse(text) as { t: string; tick?: number; cmds?: Command[] };
    if (raw.t !== 'input' || raw.tick === undefined) return; // hash は突き合わせない
    let per = this.inputs.get(raw.tick);
    if (per === undefined) {
      per = new Map();
      this.inputs.set(raw.tick, per);
    }
    if (!per.has(from)) per.set(from, raw.cmds ?? []);
    this.flush();
  }

  private flush(): void {
    for (const tick of [...this.inputs.keys()].sort((a, b) => a - b)) {
      const per = this.inputs.get(tick)!;
      if (!this.live.every((p) => per.has(p))) break; // 揃うまで配らない
      const byPlayer: Record<number, Command[]> = {};
      for (const p of [...per.keys()].sort((a, b) => a - b)) byPlayer[p] = per.get(p)!;
      const text = JSON.stringify({ t: 'input', tick, byPlayer });
      this.broadcastBytes += utf8Bytes(text);
      this.broadcastMessages += 1;
      this.inputs.delete(tick);
      for (const [p, ls] of this.seats) {
        if (this.gone.has(p)) continue; // 切断中の席には届かない
        ls.receiveText(text);
      }
    }
  }
}

/** 偽サーバに繋いだ 1 端末ぶん。 */
function makeClient(
  relay: FakeRelay,
  me: PlayerId,
  playerIds: readonly PlayerId[],
  seed = 4321,
  createAi?: (p: PlayerId) => { think(w: World): Command[] },
): { world: World; ls: Lockstep } {
  const { world } = createMatch({
    seed,
    playerCount: playerIds.length,
    civs: playerIds.map(() => 'yamato'),
    mapType: 'plain',
  });
  const ls = new Lockstep({
    localPlayerId: me,
    playerIds,
    send: (text) => relay.receive(me, text),
    ...(createAi === undefined ? {} : { createAi }),
  });
  relay.join(me, ls);
  return { world, ls };
}

/**
 * 全員が席に着いてから最初の turn を出す。
 *
 * **`prime` を席の揃う前に呼んではいけない。** 中継サーバは「その時点の在席者」で
 * 揃ったと判断してしまうので、後から来た席が置いていかれる（本番では `start` が
 * 全員に配られてから `prime` するのでこの順序になる）。
 */
function primeAll(clients: { ls: Lockstep }[]): void {
  for (const c of clients) c.ls.prime();
}

/** 進められる限り進める（両端末を交互に叩く）。 */
function runTo(clients: { world: World; ls: Lockstep }[], until: number): void {
  for (let guard = 0; guard < until * 4 + 1000; guard++) {
    let moved = false;
    for (const c of clients) {
      if (c.world.tick >= until) continue;
      if (c.ls.step(c.world) === 'stepped') moved = true;
    }
    if (clients.every((c) => c.world.tick >= until)) return;
    if (!moved) return; // 全員が待ちに入った（＝これ以上進めない）
  }
}

// ---------------------------------------------------------------- 送信の規則

describe('T-M14-03: 入力は「現在 tick + 3」宛に送る', () => {
  it('turn の境界でだけ送り、宛先は必ず現在 tick + inputDelayFrames 以降', () => {
    const sent: { tick: number }[] = [];
    const sender = new InputSender({
      send: (text) => sent.push(JSON.parse(text) as { tick: number }),
      inputDelayFrames: 3,
      turnTicks: TURN_TICKS,
    });
    sender.prime(0);
    for (let t = 0; t < 60; t++) sender.onBeforeTick(t);

    // 最初の turn（tick 0）は誰も持っていないので prime が埋める
    expect(sent[0]!.tick).toBe(0);
    // 以降は turn の境界だけ。宛先は turn 幅ごとに 1 つ進む
    const ticks = sent.map((m) => m.tick);
    expect(ticks).toEqual(ticks.slice().sort((a, b) => a - b));
    for (const tick of ticks) expect(tick % TURN_TICKS).toBe(0);
    // 「現在 tick + 3」以降であること（turn 境界に丸めた結果）
    for (let t = 0; t < 60; t += TURN_TICKS) {
      expect(sender.targetTickFor(t)).toBeGreaterThanOrEqual(t + 3);
    }
    // 60 tick ぶんで turn の数だけ送る（1 tick ごとに送っていない = 圧縮が効いている）
    expect(sent.length).toBe(60 / TURN_TICKS + 1);
  });

  it('過去や現在の tick 宛には送らない（アンドゥが存在しない理由）', () => {
    const sent: number[] = [];
    const sender = new InputSender({
      send: (text) => sent.push((JSON.parse(text) as { tick: number }).tick),
      turnTicks: TURN_TICKS,
    });
    sender.prime(0);
    sender.onBeforeTick(0);
    const before = sent.length;
    // 同じ tick を 2 回叩いても増えない
    sender.onBeforeTick(0);
    expect(sent.length).toBe(before);
    expect(sender.lastTargetTick).toBe(TURN_TICKS);
  });

  it('入力は発行順のまま 1 通に載る（並べ替えない）', () => {
    const bodies: Command[][] = [];
    const sender = new InputSender({
      send: (text) => {
        const m = JSON.parse(text) as { cmds?: Command[] };
        bodies.push(m.cmds ?? []);
      },
      turnTicks: TURN_TICKS,
    });
    sender.prime(0);
    sender.push({ t: 'resign', p: 0 });
    sender.push({ t: 'setOrder', p: 0, front: 1, order: 'charge', tier: 'upper' });
    sender.onBeforeTick(0);
    expect(bodies[1]).toEqual([
      { t: 'resign', p: 0 },
      { t: 'setOrder', p: 0, front: 1, order: 'charge', tier: 'upper' },
    ]);
  });
});

// ---------------------------------------------------------------- 圧縮

describe('T-M14-04: 8 人 30 分の通信量', () => {
  it('1 端末の送信量が 1MB 以内（実測）', () => {
    // 30 分ぶんの送信を実際に組み立ててバイト数を数える。
    // 入力は「1 人あたり 30 分で 900 回」＝ 2 秒に 1 回の操作を想定（`07§4` の
    // 令の切り替え間隔 6 秒より速い。実際の対戦より多めに見積もっている）。
    let bytes = 0;
    let messages = 0;
    const sender = new InputSender({
      send: (text) => {
        bytes += utf8Bytes(text);
        messages += 1;
      },
      turnTicks: TURN_TICKS,
    });
    sender.prime(0);
    const actionEvery = Math.floor(MATCH_TICKS / 900);
    for (let t = 0; t < MATCH_TICKS; t++) {
      if (t % actionEvery === 0) sender.push({ t: 'setOrder', p: 3, front: 2, order: 'charge', tier: 'upper' });
      sender.onBeforeTick(t);
    }
    // ハッシュも送る（250 tick ごと）
    for (let t = 0; t <= MATCH_TICKS; t += HASH_CHECK_INTERVAL_TICKS) {
      bytes += utf8Bytes(encodeC2S({ t: 'hash', tick: t, hash: 0xdeadbeef }));
      messages += 1;
    }

    // 1 tick ごとに送った場合との比較（圧縮していなければ 1MB を超える）
    let naive = 0;
    for (let t = 0; t < MATCH_TICKS; t++) naive += utf8Bytes(JSON.stringify({ t: 'input', tick: t, cmds: [] }));

    expect(messages).toBeLessThan(MATCH_TICKS / 2);
    expect(naive).toBeGreaterThan(TRAFFIC_BUDGET_BYTES);
    expect(bytes).toBeLessThanOrEqual(TRAFFIC_BUDGET_BYTES);
  });

  it('無入力の 30 分なら送受を合わせても 1MB 以内（8 人）', () => {
    // 受信側（サーバが配る `input`）は 8 人ぶんが 1 通に入るので、そこも数える。
    const players = [0, 1, 2, 3, 4, 5, 6, 7];
    let up = 0;
    const sender = new InputSender({ send: (text) => (up += utf8Bytes(text)), turnTicks: TURN_TICKS });
    sender.prime(0);
    for (let t = 0; t < MATCH_TICKS; t++) sender.onBeforeTick(t);
    for (let t = 0; t <= MATCH_TICKS; t += HASH_CHECK_INTERVAL_TICKS) {
      up += utf8Bytes(encodeC2S({ t: 'hash', tick: t, hash: 0 }));
    }

    let down = 0;
    for (let t = 0; t < MATCH_TICKS; t += TURN_TICKS) {
      const byPlayer: Record<number, Command[]> = {};
      for (const p of players) byPlayer[p] = [];
      down += utf8Bytes(JSON.stringify({ t: 'input', tick: t, byPlayer }));
    }

    expect(up + down).toBeLessThanOrEqual(TRAFFIC_BUDGET_BYTES);
  });

  it('空入力の turn でも 1 通は必ず送る（「送らない」と「未着」を混同しない）', () => {
    const sent: number[] = [];
    const sender = new InputSender({
      send: (text) => sent.push((JSON.parse(text) as { tick: number }).tick),
      turnTicks: TURN_TICKS,
    });
    sender.prime(0);
    for (let t = 0; t < TURN_TICKS * 10; t++) sender.onBeforeTick(t);
    // 一度も入力していないが、turn の数だけ送っている（黙ると部屋が永久に止まる）
    expect(sender.pendingCount).toBe(0);
    expect(sent.length).toBe(11);
    expect(sender.emptyMessages).toBe(11);
  });
});

// ---------------------------------------------------------------- 待ち合わせ

describe('T-M14-03: 誰かが遅いと全員が同じだけ待つ', () => {
  it('片方の入力が止まると両端末が同じ tick で止まり、同じだけ待つ', () => {
    const relay = new FakeRelay();
    const a = makeClient(relay, 0, [0, 1]);
    const b = makeClient(relay, 1, [0, 1]);
    primeAll([a, b]);

    runTo([a, b], 60);
    expect(a.world.tick).toBe(60);
    expect(b.world.tick).toBe(60);

    // B の回線が詰まった（送信が溜まる）。**席は落ちていない**ので待ち続ける
    relay.stall(1);
    const waitedA0 = a.ls.stats.waitedTicks;
    const waitedB0 = b.ls.stats.waitedTicks;
    runTo([a, b], 200);

    // 進めなかった tick が両端末で同じ（「自分だけ有利／不利」が起きない）
    expect(a.world.tick).toBe(b.world.tick);
    expect(a.world.tick).toBeLessThan(200);
    expect(a.ls.stats.waitedTicks).toBeGreaterThan(waitedA0);
    expect(b.ls.stats.waitedTicks).toBeGreaterThan(waitedB0);
    expect(hashWorld(a.world)).toBe(hashWorld(b.world));

    // 回線が戻れば同じ tick から再開する（溜まっていた入力が順に届く）
    relay.resume(1);
    runTo([a, b], 200);
    expect(a.world.tick).toBe(200);
    expect(b.world.tick).toBe(200);
    expect(hashWorld(a.world)).toBe(hashWorld(b.world));
  });

  it('待っている間は world.tick が動かない（描画側は alpha を進めないだけでよい）', () => {
    const relay = new FakeRelay();
    const a = makeClient(relay, 0, [0, 1]);
    const b = makeClient(relay, 1, [0, 1]);
    primeAll([a, b]);
    relay.stall(1);
    // turn の中（tick 0〜5）は最初の確定入力で進める
    while (a.world.tick < TURN_TICKS) expect(a.ls.step(a.world)).toBe('stepped');
    // 次の turn 境界で待ちに入る
    const t = a.world.tick;
    expect(a.ls.step(a.world)).toBe('waiting');
    expect(a.ls.step(a.world)).toBe('waiting');
    expect(a.world.tick).toBe(t);
    void b;
  });
});

// ---------------------------------------------------------------- 並び順

describe('T-M14-03: stepWorld に渡す並びは playerId 昇順 → 発行順', () => {
  it('確定入力を playerId 昇順に、同じ人の中は発行順に並べる', () => {
    const byPlayer: Record<number, Command[]> = {
      2: [{ t: 'resign', p: 2 }],
      0: [
        { t: 'setOrder', p: 0, front: 1, order: 'charge', tier: 'upper' },
        { t: 'setOrder', p: 0, front: 2, order: 'hold', tier: 'upper' },
      ],
      1: [{ t: 'resign', p: 1 }],
    };
    const got = mergeTurnCommands([0, 1, 2], byPlayer, () => null);
    expect(got).toEqual([
      { t: 'setOrder', p: 0, front: 1, order: 'charge', tier: 'upper' },
      { t: 'setOrder', p: 0, front: 2, order: 'hold', tier: 'upper' },
      { t: 'resign', p: 1 },
      { t: 'resign', p: 2 },
    ]);
  });

  it('代行中の席は確定入力を見ず、AI の Command が同じ位置に入る', () => {
    const byPlayer: Record<number, Command[]> = { 0: [{ t: 'resign', p: 0 }] };
    const got = mergeTurnCommands([0, 1], byPlayer, (p) =>
      p === 1 ? [{ t: 'setOrder', p: 1, front: 1, order: 'hold', tier: 'upper' }] : null,
    );
    expect(got.map((c) => c.p)).toEqual([0, 1]);
  });

  it('presentPlayers は playerId 昇順（Object.keys の順に依存しない）', () => {
    expect(presentPlayers({ 3: [], 0: [], 11: [], 2: [] })).toEqual([0, 2, 3, 11]);
  });
});

// ---------------------------------------------------------------- AI 代行

describe('T-M14-05: 代行の開始は tick 番号だけで決まる', () => {
  it('入力が 3 秒（75 tick）届かなかった tick から代行を始める', () => {
    expect(SUBSTITUTE_AFTER_TICKS).toBe(75);
    expect(SEAT_HOLD_TICKS).toBe(3000);

    const watch = new SeatWatch([0, 1]);
    // tick 0 から 30 まで両者の入力が届いている
    for (let t = 0; t <= 30; t += TURN_TICKS) watch.noteTurn(t, [0, 1]);
    // 以降、P1 の入力が確定入力に載らなくなる
    for (let t = 36; t <= 200; t += TURN_TICKS) {
      watch.noteTurn(t, [0]);
      watch.advance(t);
    }
    expect(watch.substituteStartTick(0)).toBe(-1);
    // 最後に見たのは tick 30。30 + 75 = 105 以降の最初の turn 境界
    expect(watch.substituteStartTick(1)).toBe(108);
    expect(watch.isSubstituting(1)).toBe(true);
  });

  it('2 つの端末が同じ確定入力を見れば、代行の開始フレームは完全に一致する', () => {
    const a = new SeatWatch([0, 1, 2]);
    const b = new SeatWatch([0, 1, 2]);
    // `Lockstep` と同じ順序（turn 境界で noteTurn、毎 tick advance）で回す。
    // **材料は確定入力の中身だけ**なので、2 つの見張りは同じ結論に至る。
    for (let t = 0; t <= 600; t++) {
      if (t % TURN_TICKS === 0) {
        const present: PlayerId[] = t <= 120 ? [0, 1, 2] : [0, 1];
        a.noteTurn(t, present);
        b.noteTurn(t, present);
      }
      a.advance(t);
      b.advance(t);
    }
    expect(a.substituteStartTick(2)).toBe(b.substituteStartTick(2));
    // 最後に見たのは tick 120。3 秒（75 tick）後の 195 から代行が始まる
    expect(a.substituteStartTick(2)).toBe(120 + SUBSTITUTE_AFTER_TICKS);
  });

  it('戻ってくれば代行をやめ、戻らなければ席の期限（120 秒）を過ぎても続ける', () => {
    const watch = new SeatWatch([0, 1]);
    for (let t = 0; t <= 300; t += TURN_TICKS) {
      watch.noteTurn(t, [0]);
      watch.advance(t);
    }
    expect(watch.isSubstituting(1)).toBe(true);
    // 期限内は「席を保持している」
    expect(watch.isSeatExpired(1, 300)).toBe(false);
    // 期限を過ぎても AI は続ける（`07§12`「戻らなければ AI がそのまま続けます」）
    expect(watch.isSeatExpired(1, SEAT_HOLD_TICKS + 1)).toBe(true);
    expect(watch.isSubstituting(1)).toBe(true);
    // 戻ってきたら引き継ぐ
    watch.noteTurn(306, [0, 1]);
    expect(watch.isSubstituting(1)).toBe(false);
    expect(watch.substituteStartTick(1)).toBe(-1);
  });

  it('代行の判定に時計を使っていない（ソースに Date.now / performance.now が無い）', () => {
    const src = readFileSync(new URL('../../src/net/lockstep.ts', import.meta.url), 'utf8');
    // コメント中の「Date.now()」は説明なので、コードとしての呼び出しが無いことを見る
    const code = src
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//'))
      .join('\n');
    expect(code).not.toMatch(/Date\.now\(/);
    expect(code).not.toMatch(/performance\.now\(/);
    expect(code).not.toMatch(/Math\.random\(/);
  });
});

describe('T-M14-05: 2 端末が同じフレームで代行を始め、ハッシュが一致する', () => {
  it('3 席のうち 1 席が切断しても、残る 2 端末の代行開始 tick とハッシュが一致する', () => {
    const relay = new FakeRelay();
    /** 代行 AI の代わりに「決まった tick に必ず 1 手出す」偽 AI（判断間隔に左右されない）。 */
    const fakeAi = (p: PlayerId) => ({
      think: (w: World): Command[] =>
        w.tick % 50 === 0 ? [{ t: 'setOrder', p, front: 1, order: 'hold', tier: 'upper' }] : [],
    });
    const ids: PlayerId[] = [0, 1, 2];
    const a = makeClient(relay, 0, ids, 777, fakeAi);
    const b = makeClient(relay, 1, ids, 777, fakeAi);
    const c = makeClient(relay, 2, ids, 777, fakeAi);
    primeAll([a, b, c]);

    runTo([a, b, c], 120);
    expect(a.world.tick).toBe(120);

    // P2 が切断（サーバが席を落とす → 以降 P2 の入力は待たない）
    relay.drop(2);
    runTo([a, b], 600);

    expect(a.world.tick).toBe(600);
    expect(b.world.tick).toBe(600);
    // **同じフレームで代行を開始している**
    expect(a.ls.substituteStartTick(2)).toBe(b.ls.substituteStartTick(2));
    expect(a.ls.substituteStartTick(2)).toBeGreaterThan(120);
    expect(a.ls.substituting()).toEqual([2]);
    // **ハッシュが一致**
    expect(hashWorld(a.world)).toBe(hashWorld(b.world));

    // 戻ってくれば代行をやめる（席の引き継ぎ）。
    //
    // **復帰した席は「まだ配られていない tick」から空入力を入れなければならない。**
    // 既に配られた tick に後から入れると、中継サーバの待ち行列がそこで止まる
    // （`flushReadyTicks` は tick 昇順に見て、揃っていない最初の tick で止まるため）。
    // A/B は「tick N を実行する直前に N+turn 宛」を出すので、まだ配られていない
    // 最初の tick は N+turn。ここから埋める。
    // 申し送り: 復帰した席が「現在 tick」を知る手段はサーバに無い（`server/relay.ts` は
    // 触らない約束なので、ここは呼び出し側が tick を渡す形にしてある）。
    relay.rejoin(2);
    c.ls.inputSender.prefillEmpty(a.world.tick + TURN_TICKS, 200);
    runTo([a, b], 900);
    expect(a.world.tick).toBe(900);
    expect(a.ls.substituting()).toEqual([]);
    expect(b.ls.substituting()).toEqual([]);
    expect(hashWorld(a.world)).toBe(hashWorld(b.world));
  });
});

// ---------------------------------------------------------------- ハッシュ / デシンク

describe('T-M14-06: 250 tick ごとにハッシュを送り、desync で即停止する', () => {
  it('250 tick ごとに hash を送る', () => {
    const relay = new FakeRelay();
    const hashes: { tick: number; hash: number }[] = [];
    const a = makeClient(relay, 0, [0]);
    // 送信を覗くために、同じ端末の送信内容を偽サーバの手前で拾う
    const ls = new Lockstep({
      localPlayerId: 0,
      playerIds: [0],
      send: (text) => {
        const msg = decodeS2C(text);
        const raw = JSON.parse(text) as { t: string; tick: number; hash?: number };
        if (raw.t === 'hash') hashes.push({ tick: raw.tick, hash: raw.hash ?? 0 });
        void msg;
        // 自分だけの部屋なので、そのまま確定入力として返す
        if (raw.t === 'input') {
          ls.receive({ t: 'input', tick: raw.tick, byPlayer: { 0: [] } });
        }
      },
    });
    ls.prime();
    for (let i = 0; i < 600; i++) ls.step(a.world);
    expect(a.world.tick).toBe(600);
    expect(hashes.map((h) => h.tick)).toEqual([0, 250, 500]);
    for (const h of hashes) expect(h.hash).not.toBe(0);
  });

  it('desync を受けたら即座に止まる（それ以上 tick を進めない）', () => {
    const relay = new FakeRelay();
    const a = makeClient(relay, 0, [0, 1]);
    const b = makeClient(relay, 1, [0, 1]);
    primeAll([a, b]);
    runTo([a, b], 60);
    const at = a.world.tick;

    a.ls.receive({ t: 'desync', tick: 250, hashes: { 0: 111, 1: 222 } });
    expect(a.ls.step(a.world)).toBe('halted');
    expect(a.world.tick).toBe(at);
    expect(a.ls.desync).toEqual({ tick: 250, hashes: { 0: 111, 1: 222 } });
    // 相手（通知が届いていない側）はまだ動く = 停止はあくまで通知を受けた端末の判断
    expect(b.ls.desync).toBeNull();
  });

  it('left（切断通知）は判断に使わず表示だけに使う', () => {
    const relay = new FakeRelay();
    const a = makeClient(relay, 0, [0, 1]);
    const b = makeClient(relay, 1, [0, 1]);
    primeAll([a, b]);
    runTo([a, b], 12);
    a.ls.receive({ t: 'left', playerId: 1, atTick: -1, holdMs: 120_000 });
    // 代行は始まらない（実時間で飛んでくる通知なので端末ごとにフレームが違う）
    expect(a.ls.substituting()).toEqual([]);
    expect(a.ls.lastLeftNotice).toEqual({ playerId: 1, holdMs: 120_000 });
  });
});
