import { describe, expect, test } from 'vitest';
import { Rng, hashSeed } from '@ai-pet/shared';

describe('Rng', () => {
  test('同じseedなら同じ列を返す（決定論）', () => {
    const a = new Rng('pokomofu-1');
    const b = new Rng('pokomofu-1');
    const seqA = Array.from({ length: 50 }, () => a.next());
    const seqB = Array.from({ length: 50 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });

  test('違うseedなら違う列を返す', () => {
    const a = new Rng('seed-a');
    const b = new Rng('seed-b');
    expect(a.next()).not.toBe(b.next());
  });

  test('next() は 0以上1未満', () => {
    const r = new Rng(1);
    for (let i = 0; i < 10_000; i++) {
      const v = r.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  test('分布が極端に偏らない', () => {
    const r = new Rng('dist');
    const buckets = new Array(10).fill(0) as number[];
    const n = 100_000;
    for (let i = 0; i < n; i++) buckets[Math.floor(r.next() * 10)]!++;
    for (const b of buckets) {
      expect(b).toBeGreaterThan(n / 10 * 0.9);
      expect(b).toBeLessThan(n / 10 * 1.1);
    }
  });

  test('int(min,max) は境界を含む', () => {
    const r = new Rng('int');
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) seen.add(r.int(3, 6));
    expect([...seen].sort()).toEqual([3, 4, 5, 6]);
  });

  test('weighted は重み0を選ばない', () => {
    const r = new Rng('w');
    for (let i = 0; i < 1000; i++) {
      const idx = r.weighted([0, 5, 0, 5]);
      expect([1, 3]).toContain(idx);
    }
  });

  test('状態の保存・復元で以降の列が一致する', () => {
    const r = new Rng('state');
    for (let i = 0; i < 10; i++) r.next();
    const st = r.getState();
    const after = Array.from({ length: 20 }, () => r.next());

    const r2 = new Rng('other');
    r2.setState(st);
    expect(Array.from({ length: 20 }, () => r2.next())).toEqual(after);
  });

  test('shuffle は要素を落とさない', () => {
    const r = new Rng('sh');
    const arr = Array.from({ length: 100 }, (_, i) => i);
    const shuffled = r.shuffle([...arr]);
    expect([...shuffled].sort((a, b) => a - b)).toEqual(arr);
    expect(shuffled).not.toEqual(arr);
  });

  test('hashSeed は安定している', () => {
    expect(hashSeed('pokomofu-1')).toBe(hashSeed('pokomofu-1'));
    expect(hashSeed('a')).not.toBe(hashSeed('b'));
  });
});
