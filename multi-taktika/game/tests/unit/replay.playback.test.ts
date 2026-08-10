/**
 * T-M15-04, 05: 再生の制御とタイムラインの素材（`src/replay/playback.ts`）
 *
 * ここで見るのは **DOM を触らない部分だけ**（jsdom が無い環境でも動く）。
 *   - 倍速が `tickBudget` だけで実装されていること（tick の長さは変えない）
 *   - 頭出し（巻き戻し / 早送り）の計画と、実際に同じ tick へ着くこと
 *   - タイムラインの区間・カードの配置計算（レーン = 立っていた時間、届いた印の位置）
 *   - **観戦者が何人増えても試合に影響しない**（T-M15-05 の完了条件）
 */

import { describe, expect, it } from 'vitest';
import type { OrderId, PlayerId, Tier } from '@/shared/types';
import type { Command } from '@/sim/command';
import { TICK_RATE, stepWorld } from '@/sim/index';
import { createMatch } from '@/sim/setup';
import { hashWorld } from '@/sim/hash';
import { MAX_FRONTS, type World } from '@/sim/core/world';
import { EntityKind } from '@/shared/types';
import { idOfIndex } from '@/sim/core/entity';
import { dataHash } from '@/data/hash';
import { ReplayRecorder, type Replay } from '@/replay/format';
import {
  BASE_TICK_BUDGET,
  MAX_SPEED,
  MIN_SPEED,
  Playback,
  SPEED_STEPS,
  TICK_MS,
  TimelineRecorder,
  TimelineScan,
  advanceTicks,
  busiestLane,
  clampSpeed,
  jumpTargetTick,
  laneCardCounts,
  laneFocusNote,
  liveSource,
  markLayout,
  quantizeSpeed,
  replaySource,
  seekPlan,
  shiftTargetTick,
  spanLayout,
  stepSpeed,
  tickBudget,
  tickToX,
  viewerAfterTab,
  xToTick,
  type OrderMark,
  type TimelineBox,
} from '@/replay/playback';
import { GOLDEN_SCENARIOS, collectIds } from '../golden/scenarios';

const SETUP = { playerCount: 2, civs: ['yamato', 'mongol'] as const, mapType: 'plain' as const };
const SEED = 20260810;

// ---------------------------------------------------------------------------
// 倍速（tickBudget だけで実装されていること）
// ---------------------------------------------------------------------------

describe('倍速（`05§14-2`。0.5〜8 倍を tickBudget で実装する）', () => {
  it('段は 0.5 から 8 までで、外側は端に寄せる', () => {
    expect(SPEED_STEPS[0]).toBe(MIN_SPEED);
    expect(SPEED_STEPS[SPEED_STEPS.length - 1]).toBe(MAX_SPEED);
    expect(clampSpeed(0.1)).toBe(0.5);
    expect(clampSpeed(99)).toBe(8);
    expect(quantizeSpeed(0.4)).toBe(0.5);
    expect(quantizeSpeed(2.4)).toBe(2);
    expect(quantizeSpeed(100)).toBe(8);
  });

  it('`+` `-` は段を 1 つずつ動き、端で止まる', () => {
    expect(stepSpeed(1, 1)).toBe(2);
    expect(stepSpeed(1, -1)).toBe(0.5);
    expect(stepSpeed(0.5, -1)).toBe(0.5);
    expect(stepSpeed(8, 1)).toBe(8);
  });

  it('倍速は 1 フレームの tick 予算だけを増やす（tick の長さは 40ms のまま）', () => {
    expect(TICK_MS).toBeCloseTo(1000 / TICK_RATE, 10);
    expect(tickBudget(1)).toBe(BASE_TICK_BUDGET);
    expect(tickBudget(8)).toBe(BASE_TICK_BUDGET * 8);
    // 0.5 倍でも 1 tick は許す（0 だと 1 フレームも進まない）
    expect(tickBudget(0.5, 1)).toBe(1);
  });

  it('8 倍は等速の 8 倍の tick を進める（同じ実時間で）', () => {
    const slow = advanceTicks(0, 1000, 1, tickBudget(1, 1000));
    const fast = advanceTicks(0, 1000, 8, tickBudget(8, 1000));
    expect(slow.ticks).toBe(25); // 1 秒 = 25 tick
    expect(fast.ticks).toBe(200);
  });

  it('0.5 倍は 1 tick 分の時間を 2 倍待つ', () => {
    const a = advanceTicks(0, TICK_MS, 0.5, 10);
    expect(a.ticks).toBe(0);
    const b = advanceTicks(a.acc, TICK_MS, 0.5, 10);
    expect(b.ticks).toBe(1);
  });

  it('予算を超えた分は貯めない（重いフレームの後で早送りにならない）', () => {
    const a = advanceTicks(0, 10000, 1, 5);
    expect(a.ticks).toBe(5);
    expect(a.acc).toBeLessThanOrEqual(TICK_MS);
  });
});

// ---------------------------------------------------------------------------
// 頭出し
// ---------------------------------------------------------------------------

describe('頭出し（`05§14-4` のカードのクリック / `06§10` の ←→）', () => {
  it('前に戻るときだけ World を作り直す計画になる', () => {
    expect(seekPlan(100, 300, 1000)).toEqual({ restart: false, steps: 200, target: 300 });
    expect(seekPlan(300, 100, 1000)).toEqual({ restart: true, steps: 100, target: 100 });
    // 端は丸める（記録より先へは行かない）
    expect(seekPlan(0, 9999, 500).target).toBe(500);
    expect(seekPlan(10, -5, 500)).toEqual({ restart: true, steps: 0, target: 0 });
  });

  it('前後の「令を出した瞬間」を選ぶ。端では -1（勝手に飛ばさない）', () => {
    const marks = [mark(1, 100), mark(2, 250), mark(1, 400)];
    expect(jumpTargetTick(marks, 0, 1)).toBe(100);
    expect(jumpTargetTick(marks, 100, 1)).toBe(250);
    expect(jumpTargetTick(marks, 250, -1)).toBe(100);
    expect(jumpTargetTick(marks, 400, 1)).toBe(-1);
    expect(jumpTargetTick(marks, 0, -1)).toBe(-1);
  });

  it('`Shift`+`←` `→` は 10 秒（250 tick）ずつで、端で止まる', () => {
    expect(shiftTargetTick(1000, 1, 5000)).toBe(1000 + 10 * TICK_RATE);
    expect(shiftTargetTick(100, -1, 5000)).toBe(0);
    expect(shiftTargetTick(4900, 1, 5000)).toBe(5000);
  });

  it('`Tab` は視点を順に回す（観戦）', () => {
    expect(viewerAfterTab(0, 3)).toBe(1);
    expect(viewerAfterTab(2, 3)).toBe(0);
    expect(viewerAfterTab(0, 1)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// タイムラインの配置計算（レーン）
// ---------------------------------------------------------------------------

const BOX: TimelineBox = { width: 1000, padLeft: 0, padRight: 0 };

describe('タイムラインの配置（`05§14-3`〜`05§14-6`）', () => {
  it('tick と x が往復する。画面幅を広げるとレーンも伸びる', () => {
    expect(tickToX(0, 1000, BOX)).toBe(0);
    expect(tickToX(500, 1000, BOX)).toBe(500);
    expect(tickToX(1000, 1000, BOX)).toBe(1000);
    expect(xToTick(500, 1000, BOX)).toBe(500);
    // 幅が 2 倍になれば同じ tick の x も 2 倍（固定幅にしていない証明）
    expect(tickToX(500, 1000, { ...BOX, width: 2000 })).toBe(1000);
  });

  it('レーン名の幅（padLeft）を差し引いた領域に収まる', () => {
    const box: TimelineBox = { width: 1000, padLeft: 92, padRight: 8 };
    expect(tickToX(0, 1000, box)).toBe(92);
    expect(tickToX(1000, 1000, box)).toBe(992);
    expect(xToTick(92, 1000, box)).toBe(0);
    expect(xToTick(5000, 1000, box)).toBe(1000); // 枠の外は端に丸める
  });

  it('レーンの区間の幅 = 戦域が立っていた時間', () => {
    const r = spanLayout({ slot: 1, startTick: 250, endTick: 750 }, 1000, BOX);
    expect(r.x).toBe(250);
    expect(r.w).toBe(500);
  });

  it('1 tick しか立たなかった戦域も見える幅を持つ', () => {
    const r = spanLayout({ slot: 3, startTick: 10, endTick: 11 }, 100000, BOX);
    expect(r.w).toBeGreaterThanOrEqual(2);
  });

  it('届いた印はカードの少し右に来る（= 出した時刻とのずれ）', () => {
    const m = mark(2, 1000, 1050); // 50 tick = 2 秒の遅延
    const lay = markLayout(m, 10000, { width: 1000, padLeft: 0, padRight: 0 });
    expect(lay.x).toBe(100);
    expect(lay.deliveredX).toBeGreaterThan(lay.x);
    expect(lay.delayTicks).toBe(50);
    expect(lay.delaySec).toBeCloseTo(2, 6);
  });

  it('届く前に記録が終わった令は印を出さない', () => {
    const lay = markLayout(mark(1, 900, -1), 1000, BOX);
    expect(lay.deliveredX).toBe(-1);
    expect(lay.delaySec).toBe(-1);
  });
});

describe('`05§14` の注記（1 本のレーンだけ切り替わっている = 他を放置していた）', () => {
  it('1 本に令が集中していると、そう読める文になる', () => {
    const marks = [mark(2, 10), mark(2, 100), mark(2, 200), mark(2, 300), mark(5, 400)];
    const b = busiestLane(marks);
    expect(b.slot).toBe(2);
    expect(b.count).toBe(4);
    expect(b.total).toBe(5);
    const note = laneFocusNote(marks);
    expect(note).toContain('戦域 2');
    expect(note).toContain('放置');
  });

  it('散っているときは「偏りは小さい」と言う', () => {
    const marks = [mark(1, 10), mark(2, 20), mark(3, 30), mark(4, 40)];
    expect(laneFocusNote(marks)).toContain('偏りは小さい');
  });

  it('令が 1 枚も無いときも文になる（空文字で黙らない）', () => {
    expect(laneFocusNote([]).length).toBeGreaterThan(0);
  });

  it('レーンごとの枚数を数える（添字 0 = 戦域 1）', () => {
    expect(laneCardCounts([mark(1, 1), mark(1, 2), mark(6, 3)])).toEqual([2, 0, 0, 0, 0, 1]);
  });

  it('同数なら小さい番号を採る（乱数を使わない）', () => {
    expect(busiestLane([mark(4, 1), mark(2, 2)]).slot).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// TimelineRecorder（戦域の区間と令の 2 つの時刻）
// ---------------------------------------------------------------------------

/** `TimelineRecorder` が読む部分だけを持つ最小の World（sim を回さずに検算する）。 */
function stubWorld(playerCount = 1): {
  w: World;
  set(slot: number, v: Partial<{ active: boolean; order: OrderId | null; pending: { id: OrderId; tier: Tier; single: boolean; deliverAtTick: number } | null }>): void;
} {
  const fronts = [];
  for (let p = 0; p < playerCount; p++) {
    for (let slot = 1; slot <= MAX_FRONTS; slot++) {
      fronts.push({ slot, owner: p, active: false, order: null, orderLower: null, pendingOrder: null });
    }
  }
  const w = { tick: 0, fronts } as unknown as World;
  return {
    w,
    set(slot, v) {
      const f = w.fronts[slot - 1]!;
      if (v.active !== undefined) f.active = v.active;
      if (v.order !== undefined) f.order = v.order;
      if (v.pending !== undefined) f.pendingOrder = v.pending;
    },
  };
}

describe('TimelineRecorder（レーンの区間と、令の「出した / 届いた」）', () => {
  it('active の間だけレーンが伸びる', () => {
    const s = stubWorld();
    const rec = new TimelineRecorder(1);
    for (let t = 0; t <= 100; t++) {
      s.w.tick = t;
      s.set(1, { active: t >= 20 && t < 60 });
      rec.observe(s.w);
    }
    const tl = rec.snapshot(100);
    expect(tl.players[0]!.spans).toEqual([{ slot: 1, startTick: 20, endTick: 60 }]);
  });

  it('まだ立っている戦域は「観測した最後の tick」で閉じる', () => {
    const s = stubWorld();
    const rec = new TimelineRecorder(1);
    for (let t = 0; t <= 50; t++) {
      s.w.tick = t;
      s.set(2, { active: t >= 10 });
      rec.observe(s.w);
    }
    const spans = rec.snapshot(200).players[0]!.spans;
    expect(spans).toEqual([{ slot: 2, startTick: 10, endTick: 50 }]);
  });

  it('令を出した tick と届いた tick を別々に持つ（遅延を隠さない）', () => {
    const s = stubWorld();
    const rec = new TimelineRecorder(1);
    for (let t = 0; t <= 100; t++) {
      s.w.tick = t;
      s.set(1, { active: true });
      if (t === 10) s.set(1, { pending: { id: 'charge', tier: 'upper', single: true, deliverAtTick: 60 } });
      if (t === 60) s.set(1, { pending: null, order: 'charge' });
      rec.observe(s.w);
    }
    const marks = rec.snapshot(100).players[0]!.marks;
    expect(marks).toHaveLength(1);
    expect(marks[0]!.issuedTick).toBe(10);
    expect(marks[0]!.deliveredTick).toBe(60);
    // 50 tick = 2 秒のずれが画面に出る
    expect((marks[0]!.deliveredTick - marks[0]!.issuedTick) / TICK_RATE).toBe(2);
  });

  it('同じ戦域に令を出し直すと 2 枚のカードになる（切り替えの回数が読める）', () => {
    const s = stubWorld();
    const rec = new TimelineRecorder(1);
    for (let t = 0; t <= 200; t++) {
      s.w.tick = t;
      s.set(1, { active: true });
      if (t === 10) s.set(1, { pending: { id: 'charge', tier: 'upper', single: true, deliverAtTick: 40 } });
      if (t === 40) s.set(1, { pending: null, order: 'charge' });
      if (t === 100) s.set(1, { pending: { id: 'hold', tier: 'upper', single: true, deliverAtTick: 130 } });
      if (t === 130) s.set(1, { pending: null, order: 'hold' });
      rec.observe(s.w);
    }
    const marks = rec.snapshot(200).players[0]!.marks;
    expect(marks.map((m) => m.orderId)).toEqual(['charge', 'hold']);
    expect(marks.map((m) => m.deliveredTick)).toEqual([40, 130]);
  });

  it('**同じ令を出し直しても** 2 枚目が届いたと分かる（`order` の値は変わらない）', () => {
    const s = stubWorld();
    const rec = new TimelineRecorder(1);
    for (let t = 0; t <= 200; t++) {
      s.w.tick = t;
      s.set(1, { active: true });
      if (t === 10) s.set(1, { pending: { id: 'charge', tier: 'upper', single: true, deliverAtTick: 40 } });
      if (t === 40) s.set(1, { pending: null, order: 'charge' });
      // 6 秒後に同じ令をもう 1 回（`07§4` の切り替え間隔）
      if (t === 190) s.set(1, { pending: { id: 'charge', tier: 'upper', single: true, deliverAtTick: 195 } });
      if (t === 195) s.set(1, { pending: null, order: 'charge' });
      rec.observe(s.w);
    }
    const marks = rec.snapshot(200).players[0]!.marks;
    expect(marks).toHaveLength(2);
    expect(marks[1]!.issuedTick).toBe(190);
    expect(marks[1]!.deliveredTick).toBe(195);
  });

  it('届く前に戦域が閉じた令は「届いていない」（薄い印を出さない）', () => {
    const s = stubWorld();
    const rec = new TimelineRecorder(1);
    for (let t = 0; t <= 100; t++) {
      s.w.tick = t;
      s.set(1, { active: t < 50 });
      if (t === 10) s.set(1, { pending: { id: 'charge', tier: 'upper', single: true, deliverAtTick: 80 } });
      if (t === 50) s.set(1, { pending: null }); // 戦域が閉じて配達中の令が捨てられた
      rec.observe(s.w);
    }
    const marks = rec.snapshot(100).players[0]!.marks;
    expect(marks).toHaveLength(1);
    expect(marks[0]!.deliveredTick).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// Playback（実際に sim を回す）
// ---------------------------------------------------------------------------

/** 小さなリプレイを 1 本作る（入力は村人の移動だけ。戦域は立たない）。 */
function makeShortReplay(ticks: number): Replay {
  const { world } = createMatch({ seed: SEED, ...SETUP });
  const rec = new ReplayRecorder(SEED, SETUP, dataHash());
  const units: number[] = [];
  for (let i = 0; i < world.entities.highWater; i++) {
    if (world.entities.alive[i] !== 1) continue;
    if (world.entities.kind[i] !== EntityKind.Unit) continue;
    if (world.entities.owner[i] !== 0) continue;
    units.push(idOfIndex(world.entities, i));
  }
  for (let t = 0; t < ticks; t++) {
    const cmds: Command[] =
      t === 5
        ? [
            {
              t: 'moveUnits',
              p: 0 as PlayerId,
              units: units.slice(0, 2),
              x: world.map.starts[0]! + 2560,
              y: world.map.starts[1]!,
              queued: false,
            },
          ]
        : [];
    rec.record(world.tick, cmds.length > 0 ? { 0: cmds } : {});
    stepWorld(world, cmds);
  }
  return rec.finish();
}

describe('Playback（入力を受けて stepWorld を回すだけ）', () => {
  const replay = makeShortReplay(120);

  it('記録の終わりで止まる（先へは進まない）', () => {
    const pb = new Playback({
      createWorld: () => createMatch({ seed: replay.seed, ...SETUP }).world,
      source: replaySource(replay),
      endTick: replay.endTick,
    });
    pb.play();
    pb.setSpeed(8);
    for (let i = 0; i < 200; i++) pb.frame(100);
    expect(pb.tick).toBe(replay.endTick);
    expect(pb.playing).toBe(false);
  });

  it('頭出し（早送り）で狙った tick に着く', () => {
    const pb = newPlayback(replay);
    pb.seek(80);
    while (pb.seeking) pb.frame(16);
    expect(pb.tick).toBe(80);
  });

  it('巻き戻しは World を作り直して同じ状態に戻る（入力の記録だけで再現できる性質）', () => {
    const pb = newPlayback(replay);
    pb.seek(60);
    while (pb.seeking) pb.frame(16);
    const at60 = hashWorld(pb.w);

    pb.seek(100);
    while (pb.seeking) pb.frame(16);
    expect(pb.tick).toBe(100);

    pb.seek(60); // 巻き戻し
    while (pb.seeking) pb.frame(16);
    expect(pb.tick).toBe(60);
    expect(hashWorld(pb.w)).toBe(at60);
  });

  it('倍速を変えても同じ tick の状態は同じ（倍速は tick 予算だけの話）', () => {
    const a = newPlayback(replay);
    a.setSpeed(0.5);
    a.play();
    while (a.tick < 100) a.frame(50);
    const b = newPlayback(replay);
    b.setSpeed(8);
    b.play();
    while (b.tick < 100) b.frame(50);
    expect(a.tick).toBe(100);
    expect(b.tick).toBe(100);
    expect(hashWorld(a.w)).toBe(hashWorld(b.w));
  });

  it('TimelineScan は記録を最後まで走査して進捗を返す', () => {
    const scan = new TimelineScan({
      createWorld: () => createMatch({ seed: replay.seed, ...SETUP }).world,
      createSource: () => replaySource(replay),
      endTick: replay.endTick,
      playerCount: SETUP.playerCount,
    });
    expect(scan.progress).toBe(0);
    let guard = 0;
    while (!scan.done && guard++ < 100) scan.advance(20);
    expect(scan.done).toBe(true);
    expect(scan.progress).toBe(1);
    const tl = scan.snapshot();
    expect(tl.endTick).toBe(replay.endTick);
    expect(tl.players).toHaveLength(SETUP.playerCount);
  });
});

describe('実際の試合を観測したタイムライン（代表試合 2 = 戦域が立って令を配る）', () => {
  // ゴールデンの代表試合をそのまま使う（`tests/golden/scenarios.ts`）。
  const sc = GOLDEN_SCENARIOS[1]!;
  const w = createMatch({
    seed: sc.seed,
    playerCount: sc.setup.playerCount,
    civs: sc.setup.civs,
    mapType: sc.setup.mapType,
  }).world;
  sc.prepare?.(w);
  const ids = collectIds(w);
  const rec = new TimelineRecorder(sc.setup.playerCount);
  rec.observe(w);
  for (let t = 0; t < sc.ticks; t++) {
    stepWorld(w, sc.input(w.tick, ids));
    rec.observe(w);
  }
  const tl = rec.snapshot(sc.ticks);

  it('戦域が複数立ち、レーンの区間として観測できる', () => {
    const spans = tl.players[0]!.spans;
    expect(spans.length).toBeGreaterThanOrEqual(2);
    for (const s of spans) expect(s.endTick).toBeGreaterThan(s.startTick);
  });

  it('令が届くまでのずれが `07§4` の範囲（0.5〜8 秒）に入る', () => {
    const marks = tl.players[0]!.marks.filter((m) => m.deliveredTick >= 0);
    expect(marks.length).toBeGreaterThan(0);
    for (const m of marks) {
      const sec = (m.deliveredTick - m.issuedTick) / TICK_RATE;
      expect(sec).toBeGreaterThanOrEqual(0.5);
      expect(sec).toBeLessThanOrEqual(8 + 1 / TICK_RATE); // 観測は 1 tick 後になる
    }
  });

  it('レーンの偏りが注記の文になる（`05§14` の最後）', () => {
    expect(laneFocusNote(tl.players[0]!.marks).length).toBeGreaterThan(0);
  });
});

function newPlayback(replay: Replay): Playback {
  return new Playback({
    createWorld: () => createMatch({ seed: replay.seed, ...SETUP }).world,
    source: replaySource(replay),
    endTick: replay.endTick,
  });
}

// ---------------------------------------------------------------------------
// T-M15-05 観戦: 観戦者が何人増えても試合に影響しない
// ---------------------------------------------------------------------------

describe('T-M15-05: 観戦（`07§12`「観戦者は入力を送らないので、何人増えても試合に影響しない」）', () => {
  it('入力源に「送る」口が無い（構造的に影響できない）', () => {
    const live = liveSource();
    const keys = [...Object.keys(live), 'take', 'reset', 'readyTick', 'push', 'frameCount'];
    for (const k of keys) {
      expect(/^(send|emit|submit|command|setOrder)/.test(k)).toBe(false);
    }
    // 受け取る（push）と読む（take/readyTick）だけ
    expect(typeof live.push).toBe('function');
    expect(typeof live.take).toBe('function');
    expect((live as unknown as Record<string, unknown>)['emit']).toBeUndefined();
  });

  it('観戦者が 0 人でも 8 人でも、試合（ホスト）のハッシュ列が変わらない', () => {
    const TICKS = 60;
    /** ホストだけを回す。 */
    const hostAlone = (): number[] => {
      const { world } = createMatch({ seed: SEED, ...SETUP });
      const out: number[] = [];
      for (let t = 0; t < TICKS; t++) {
        stepWorld(world, hostCommands(world));
        out.push(hashWorld(world));
      }
      return out;
    };
    /** ホスト + 観戦者 n 人。観戦者は入力を受け取って自分の World を回すだけ。 */
    const withSpectators = (n: number): { host: number[]; specs: number[][] } => {
      const { world } = createMatch({ seed: SEED, ...SETUP });
      const sources = Array.from({ length: n }, () => liveSource());
      const specs = Array.from(
        { length: n },
        () => createMatch({ seed: SEED, ...SETUP }).world,
      );
      const host: number[] = [];
      const buf: Command[] = [];
      for (let t = 0; t < TICKS; t++) {
        const cmds = hostCommands(world);
        // 中継が観戦者へ配る（観戦者から返ってくるものは無い）
        for (const s of sources) s.push(world.tick, cmds);
        stepWorld(world, cmds);
        host.push(hashWorld(world));
        for (let i = 0; i < n; i++) {
          const w = specs[i]!;
          stepWorld(w, sources[i]!.take(w.tick, buf));
        }
      }
      return { host, specs: specs.map((w) => [hashWorld(w)]) };
    };

    const alone = hostAlone();
    const withEight = withSpectators(8);
    expect(withEight.host).toEqual(alone);
    // 観戦者の World もホストと同じ状態になっている（同じ入力 → 同じ試合）
    for (const s of withEight.specs) expect(s[0]).toBe(alone[alone.length - 1]);
  });

  it('観戦は「届いた tick まで」しか進まない（先を勝手に作らない）', () => {
    const live = liveSource();
    const pb = new Playback({
      createWorld: () => createMatch({ seed: SEED, ...SETUP }).world,
      source: live,
      endTick: Number.MAX_SAFE_INTEGER,
    });
    pb.play();
    pb.setSpeed(8);
    for (let t = 0; t < 10; t++) live.push(t, []);
    for (let i = 0; i < 20; i++) pb.frame(100);
    // 届いているのは tick 9 まで → 10 tick 進んだところで止まる
    expect(pb.tick).toBe(10);
    expect(live.frameCount).toBe(10);
  });
});

/** ホストが打つ入力（決定論。時刻も乱数も使わない）。 */
function hostCommands(w: World): Command[] {
  if (w.tick !== 3) return [];
  const units: number[] = [];
  for (let i = 0; i < w.entities.highWater; i++) {
    if (w.entities.alive[i] !== 1) continue;
    if (w.entities.kind[i] !== EntityKind.Unit) continue;
    if (w.entities.owner[i] !== 0) continue;
    units.push(idOfIndex(w.entities, i));
  }
  return [
    {
      t: 'moveUnits',
      p: 0 as PlayerId,
      units: units.slice(0, 2),
      x: w.map.starts[0]! + 2560,
      y: w.map.starts[1]!,
      queued: false,
    },
  ];
}

/** テスト用のカード 1 枚。 */
function mark(slot: number, issuedTick: number, deliveredTick = issuedTick + 50): OrderMark {
  return {
    slot,
    order: 0,
    orderId: 'charge',
    tier: 'upper',
    issuedTick,
    deliveredTick,
  };
}
