/**
 * T-M15-01, 03: リプレイの記録形式とデータ互換の検証（`07§12` / 手順書 §12）
 *
 * いちばん大事なのは **「データを変えた後の古いリプレイを黙って再生しない」**こと。
 * `05§14` の目的は「どこで判断を間違えたか」の振り返りなので、
 * 別の試合を見せるのは最悪の失敗になる。
 */

import { describe, expect, it } from 'vitest';
import type { Command } from '@/sim/command';
import {
  REPLAY_VERSION,
  ReplayReader,
  ReplayRecorder,
  checkReplay,
  describeReject,
  parseReplay,
  serializeReplay,
  type Replay,
} from '@/replay/format';
import { dataHash } from '@/data/hash';

const SETUP = {
  playerCount: 2,
  civs: ['yamato', 'mongol'] as const,
  mapType: 'plain' as const,
};

function make(): ReplayRecorder {
  return new ReplayRecorder(1234, SETUP, dataHash());
}

describe('T-M15-01 記録', () => {
  it('入力が無い tick は記録しない（30 分のほとんどは無入力）', () => {
    const rec = make();
    rec.record(0, {});
    rec.record(1, { 0: [] });
    rec.record(2, { 0: [{ t: 'resign', p: 0 }] });
    const r = rec.finish();
    expect(r.inputs).toHaveLength(1);
    expect(r.inputs[0]!.tick).toBe(2);
    // 記録が無くても「試合の長さ」は残る
    expect(r.endTick).toBe(2);
  });

  it('playerId 昇順に詰め直す（stepWorld に渡す並び順の規約）', () => {
    const rec = make();
    rec.record(5, {
      3: [{ t: 'resign', p: 3 }],
      1: [{ t: 'resign', p: 1 }],
    });
    const keys = Object.keys(rec.finish().inputs[0]!.byPlayer);
    expect(keys).toEqual(['1', '3']);
  });

  it('JSON 往復で同じ内容になる', () => {
    const rec = make();
    const cmd: Command = { t: 'setOrder', p: 0, front: 1, order: 'charge', tier: 'upper' };
    rec.record(10, { 0: [cmd] });
    rec.recordHash(250, 0xdeadbeef | 0);
    const before = rec.finish();
    const after = parseReplay(serializeReplay(before));
    expect(after).toEqual(before);
  });

  it('壊れた JSON では null を返す（例外にしない）', () => {
    expect(parseReplay('{')).toBeNull();
    expect(parseReplay('null')).toBeNull();
    expect(parseReplay('{"version":1}')).toBeNull(); // inputs/hashes が無い
  });
});

describe('T-M15-03 データが変わった古いリプレイは再生しない', () => {
  it('今のデータと同じ指紋なら再生できる', () => {
    const r = make().finish();
    expect(checkReplay(r, dataHash())).toEqual({ ok: true });
  });

  it('データの指紋が違えば拒否し、理由を人が読める形で返す', () => {
    const r = make().finish();
    const res = checkReplay(r, 'ffffffffffffffff');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason.kind).toBe('dataHash');
    const msg = describeReject(res.reason);
    // 「別の試合になる」ことが伝わる文であること
    expect(msg).toContain('別の試合');
  });

  it('記録形式の版が違えば拒否する', () => {
    const r = { ...make().finish(), version: REPLAY_VERSION + 1 } as Replay;
    const res = checkReplay(r, dataHash());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason.kind).toBe('version');
  });

  it('入力の tick が昇順でなければ拒否する（順序が崩れると再現できない）', () => {
    const base = make();
    base.record(10, { 0: [{ t: 'resign', p: 0 }] });
    base.record(20, { 0: [{ t: 'resign', p: 0 }] });
    const r = base.finish();
    const broken: Replay = { ...r, inputs: [r.inputs[1]!, r.inputs[0]!] };
    const res = checkReplay(broken, dataHash());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason.kind).toBe('malformed');
  });

  it('civs の数が playerCount と合わなければ拒否する', () => {
    const r = make().finish();
    const broken: Replay = { ...r, setup: { ...r.setup, playerCount: 3 } };
    const res = checkReplay(broken, dataHash())
    expect(res.ok).toBe(false);
  });
});

describe('データの指紋', () => {
  it('同じデータからは同じ指紋（16 進 16 桁）', () => {
    const a = dataHash();
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(dataHash()).toBe(a);
  });
});

describe('T-M15-02 再生の索引', () => {
  it('tick 昇順に引くと、その tick の入力だけが取れる', () => {
    const rec = make();
    const c1: Command = { t: 'setOrder', p: 0, front: 1, order: 'charge', tier: 'upper' };
    const c2: Command = { t: 'setOrder', p: 1, front: 1, order: 'hold', tier: 'upper' };
    rec.record(3, { 0: [c1] });
    rec.record(7, { 1: [c2] });
    const reader = new ReplayReader(rec.finish());
    const out: Command[] = [];

    expect(reader.take(0, out)).toHaveLength(0);
    expect(reader.take(3, out)).toEqual([c1]);
    expect(reader.take(4, out)).toHaveLength(0);
    expect(reader.take(7, out)).toEqual([c2]);
    expect(reader.take(8, out)).toHaveLength(0);
  });

  it('同じ tick に複数プレイヤーの入力があれば playerId 昇順で並ぶ', () => {
    const rec = make();
    const a: Command = { t: 'resign', p: 0 };
    const b: Command = { t: 'resign', p: 1 };
    rec.record(2, { 1: [b], 0: [a] });
    const reader = new ReplayReader(rec.finish());
    const out: Command[] = [];
    expect(reader.take(2, out)).toEqual([a, b]);
  });

  it('巻き戻せる（reset で先頭に戻る）', () => {
    const rec = make();
    const c: Command = { t: 'resign', p: 0 };
    rec.record(5, { 0: [c] });
    const reader = new ReplayReader(rec.finish());
    const out: Command[] = [];
    expect(reader.take(5, out)).toEqual([c]);
    reader.reset();
    expect(reader.take(5, out)).toEqual([c]);
  });

  it('記録したハッシュを tick で引ける（再生結果の突き合わせに使う）', () => {
    const rec = make();
    rec.recordHash(250, 42);
    const reader = new ReplayReader(rec.finish());
    expect(reader.hashAt(250)).toBe(42);
    expect(reader.hashAt(500)).toBeNull();
  });
});
