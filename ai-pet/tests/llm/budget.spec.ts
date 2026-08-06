/**
 * llm/budget.ts のテスト（docs 07章 §7）
 *
 * 時刻は注入する（1時間の経過を実時間で待てないため）。
 * 同時実行の待ちだけは実タイマなので、queueWaitMs を十分小さくして検証する。
 */
import { describe, expect, it } from 'vitest';
import { Budget } from '../../packages/server/src/llm/budget.ts';

/** 注入用の可変クロック */
function clock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => void (t += ms) };
}

const HOUR = 60 * 60 * 1000;

describe('Budget: レート制限', () => {
  it('プレイヤー別の上限を超えると player_rate', async () => {
    const c = clock();
    const b = new Budget({ perPlayerPerHour: 3 }, c.now);
    for (let i = 0; i < 3; i++) {
      const g = await b.tryAcquire('dialogue', 'p1');
      expect(g.ok).toBe(true);
      if (g.ok) g.release();
    }
    const over = await b.tryAcquire('dialogue', 'p1');
    expect(over).toEqual({ ok: false, reason: 'player_rate' });

    // 別プレイヤーは影響を受けない
    const other = await b.tryAcquire('dialogue', 'p2');
    expect(other.ok).toBe(true);
  });

  it('島全体の上限を超えると island_rate', async () => {
    const c = clock();
    const b = new Budget({ perPlayerPerHour: 100, perIslandPerHour: 2 }, c.now);
    expect((await b.tryAcquire('decide', 'p1')).ok).toBe(true);
    expect((await b.tryAcquire('decide', 'p2')).ok).toBe(true);
    expect(await b.tryAcquire('decide', 'p3')).toEqual({ ok: false, reason: 'island_rate' });
    // playerId なし（自律行動など）でも島の上限に掛かる
    expect(await b.tryAcquire('diary')).toEqual({ ok: false, reason: 'island_rate' });
  });

  it('playerId を渡さない呼び出しはプレイヤー枠を消費しない', async () => {
    const c = clock();
    const b = new Budget({ perPlayerPerHour: 1 }, c.now);
    expect((await b.tryAcquire('diary')).ok).toBe(true);
    expect((await b.tryAcquire('diary')).ok).toBe(true);
    expect(b.remaining().player).toBe(1);
  });

  it('1時間経過すると回数が戻る（スライディングウィンドウ）', async () => {
    const c = clock();
    const b = new Budget({ perPlayerPerHour: 2 }, c.now);
    expect((await b.tryAcquire('dialogue', 'p1')).ok).toBe(true);
    c.advance(30 * 60 * 1000);
    expect((await b.tryAcquire('dialogue', 'p1')).ok).toBe(true);
    expect(await b.tryAcquire('dialogue', 'p1')).toEqual({ ok: false, reason: 'player_rate' });

    // 最初の1回だけがウィンドウから外れる → 1枠だけ空く
    c.advance(30 * 60 * 1000 + 1);
    expect((await b.tryAcquire('dialogue', 'p1')).ok).toBe(true);
    expect(await b.tryAcquire('dialogue', 'p1')).toEqual({ ok: false, reason: 'player_rate' });

    c.advance(HOUR + 1);
    expect(b.remaining('p1')).toEqual({ player: 2, island: 300 });
  });

  it('remaining が使用量を反映する', async () => {
    const c = clock();
    const b = new Budget({ perPlayerPerHour: 5, perIslandPerHour: 10 }, c.now);
    expect(b.remaining('p1')).toEqual({ player: 5, island: 10 });
    const g = await b.tryAcquire('dialogue', 'p1');
    if (g.ok) g.release();
    await b.tryAcquire('decide', 'p2').then((r) => r.ok && r.release());
    expect(b.remaining('p1')).toEqual({ player: 4, island: 8 });
    expect(b.remaining('p2')).toEqual({ player: 4, island: 8 });
    expect(b.remaining('p3')).toEqual({ player: 5, island: 8 });
  });

  it('キューで捨てられた分は回数として数えない', async () => {
    const c = clock();
    const b = new Budget({ maxConcurrent: 1, queueWaitMs: 10, perPlayerPerHour: 5 }, c.now);
    const first = await b.tryAcquire('dialogue', 'p1');
    expect(first.ok).toBe(true);
    expect(await b.tryAcquire('dialogue', 'p1')).toEqual({ ok: false, reason: 'queue_timeout' });
    // 成立したのは1回だけ
    expect(b.remaining('p1').player).toBe(4);
    if (first.ok) first.release();
  });
});

describe('Budget: 同時実行', () => {
  it('maxConcurrent を超えた分は待たされ、release で通る', async () => {
    const b = new Budget({ maxConcurrent: 2, queueWaitMs: 1000 });
    const a = await b.tryAcquire('dialogue', 'p1');
    const bb = await b.tryAcquire('dialogue', 'p1');
    expect(a.ok && bb.ok).toBe(true);
    expect(b.load()).toEqual({ inFlight: 2, queued: 0 });

    let third = false;
    const pending = b.tryAcquire('dialogue', 'p1').then((r) => {
      third = r.ok;
      return r;
    });
    await Promise.resolve();
    expect(third).toBe(false);
    expect(b.load().queued).toBe(1);

    if (a.ok) a.release();
    const r = await pending;
    expect(r.ok).toBe(true);
    expect(b.load().inFlight).toBe(2); // 枠は引き継がれる
    if (r.ok) r.release();
    if (bb.ok) bb.release();
    expect(b.load()).toEqual({ inFlight: 0, queued: 0 });
  });

  it('queueWaitMs を超えたら queue_timeout', async () => {
    const b = new Budget({ maxConcurrent: 1, queueWaitMs: 30 });
    const held = await b.tryAcquire('dialogue', 'p1');
    expect(held.ok).toBe(true);

    const started = Date.now();
    const r = await b.tryAcquire('dialogue', 'p1');
    expect(r).toEqual({ ok: false, reason: 'queue_timeout' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(20);
    expect(b.load().queued).toBe(0); // 待ち行列から外れている

    if (held.ok) held.release();
    expect(b.load().inFlight).toBe(0);
  });

  it('release は冪等（二重解放で枠が増えない）', async () => {
    const b = new Budget({ maxConcurrent: 1, queueWaitMs: 20 });
    const g = await b.tryAcquire('dialogue', 'p1');
    expect(g.ok).toBe(true);
    if (g.ok) {
      g.release();
      g.release();
      g.release();
    }
    expect(b.load().inFlight).toBe(0);
  });

  it('stats が上限・実績・却下理由を返す', async () => {
    const c = clock();
    const b = new Budget({ perPlayerPerHour: 1, maxConcurrent: 4 }, c.now);
    const g = await b.tryAcquire('dialogue', 'p1');
    if (g.ok) g.release();
    await b.tryAcquire('dialogue', 'p1');

    const s = b.stats();
    expect(s['granted']).toBe(1);
    expect(s['rejected']).toEqual({ player_rate: 1, island_rate: 0, queue_timeout: 0 });
    expect(s['byPurpose']).toEqual({ dialogue: 1 });
    expect(s['islandUsedLastHour']).toBe(1);
    expect((s['limits'] as { maxConcurrent: number }).maxConcurrent).toBe(4);
  });
});
