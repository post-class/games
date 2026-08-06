import { describe, expect, test, vi } from 'vitest';
import { Rng, TICKS_PER_ISLAND_DAY } from '@ai-pet/shared';
import { WorldClock } from '../../packages/server/src/sim/clock.ts';
import {
  DEFAULT_IMPORTANCE,
  EventBus,
  textBefriend,
  textBorn,
  textDied,
  textQuarrel,
  textWeather,
} from '../../packages/server/src/sim/events.ts';

function newBus(): { bus: EventBus; clock: WorldClock } {
  const clock = new WorldClock(new Rng('events'));
  return { bus: new EventBus(clock), clock };
}

describe('EventBus', () => {
  test('emitしたイベントはflushで購読者に渡る', () => {
    const { bus } = newBus();
    const received: unknown[] = [];
    bus.onFlush((events) => received.push(...events));

    bus.emit(10, { kind: 'harvest', text: 'ぽこもふが木の実を収穫した', actorId: 1 });
    expect(bus.pending()).toBe(1);
    const flushed = bus.flush();

    expect(flushed).toHaveLength(1);
    expect(received).toHaveLength(1);
    expect(bus.pending()).toBe(0);
  });

  test('flushは空のときは購読者を呼ばない', () => {
    const { bus } = newBus();
    const fn = vi.fn();
    bus.onFlush(fn);
    expect(bus.flush()).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });

  test('重要度は種別の既定値が入る', () => {
    const { bus } = newBus();
    bus.emit(1, { kind: 'born', text: 'a' });
    bus.emit(1, { kind: 'weather', text: 'b' });
    const [born, weather] = bus.flush();
    expect(born?.importance).toBe(DEFAULT_IMPORTANCE.born);
    expect(weather?.importance).toBe(DEFAULT_IMPORTANCE.weather);
  });

  test('重要度は明示指定で上書きできる', () => {
    const { bus } = newBus();
    bus.emit(1, { kind: 'harvest', text: 'a', importance: 9 });
    expect(bus.flush()[0]?.importance).toBe(9);
  });

  test('島日が記録される', () => {
    const { bus, clock } = newBus();
    for (let t = 1; t <= TICKS_PER_ISLAND_DAY; t++) clock.advance(t);
    bus.emit(TICKS_PER_ISLAND_DAY, { kind: 'born', text: 'a' });
    expect(bus.flush()[0]?.islandDay).toBe(2);
  });

  test('重要なイベントだけが recentImportant に残る', () => {
    const { bus } = newBus();
    bus.emit(1, { kind: 'harvest', text: '収穫' }); // importance 3
    bus.emit(1, { kind: 'born', text: '誕生' }); // importance 8
    bus.emit(1, { kind: 'quarrel', text: 'ケンカ' }); // importance 6
    bus.flush();

    const recent = bus.recentImportant(10);
    expect(recent.map((e) => e.text)).toEqual(['ケンカ', '誕生']); // 新しい順
  });

  test('recentImportant は件数上限を守る', () => {
    const { bus } = newBus();
    for (let i = 0; i < 30; i++) bus.emit(i, { kind: 'born', text: `誕生${i}` });
    bus.flush();
    expect(bus.recentImportant(5)).toHaveLength(5);
  });

  test('購読者が例外を投げてもシミュレーションを止めない', () => {
    const { bus } = newBus();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    bus.onFlush(() => {
      throw new Error('購読者の不具合');
    });
    const ok = vi.fn();
    bus.onFlush(ok);

    bus.emit(1, { kind: 'born', text: 'a' });
    expect(() => bus.flush()).not.toThrow();
    expect(ok).toHaveBeenCalled();
    spy.mockRestore();
  });

  test('statsで種別ごとの件数が取れる', () => {
    const { bus } = newBus();
    bus.emit(1, { kind: 'born', text: 'a' });
    bus.emit(1, { kind: 'born', text: 'b' });
    bus.emit(1, { kind: 'died', text: 'c' });
    bus.flush();
    expect(bus.stats()).toEqual({ total: 3, byKind: { born: 2, died: 1 } });
  });

  test('位置はコピーされる（元のアクターが動いても記録は変わらない）', () => {
    const { bus } = newBus();
    const pos = { x: 1, y: 2 };
    bus.emit(1, { kind: 'born', text: 'a', pos });
    pos.x = 99;
    expect(bus.flush()[0]?.pos).toEqual({ x: 1, y: 2 });
  });
});

describe('文面テンプレート', () => {
  test('ペットのプロンプトに載る日本語1文になっている', () => {
    expect(textBorn('こもふ', 'ぽこもふ')).toBe('ぽこもふに子どものこもふが生まれた');
    expect(textBorn('こもふ')).toBe('こもふが生まれた');
    expect(textDied('ぽこもふ', false)).toContain('年をとって');
    expect(textDied('ぽこもふ', true)).toContain('弱って');
    expect(textQuarrel('あん', 'きな', '木の実')).toBe('あんときなが木の実を取り合ってケンカした');
    expect(textBefriend('あん', 'きな')).toBe('あんときなが仲良くなった');
    expect(textWeather('rain', '春')).toContain('雨');
  });

  test('未知の天気でも文が壊れない', () => {
    expect(textWeather('unknown', '夏')).toContain('夏');
  });
});
