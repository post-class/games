/**
 * 島時間のテスト。
 * 実時間で1島日=60分かかるため、HUDの見た目確認では検証しきれない部分をここで担保する。
 */
import { describe, expect, test } from 'vitest';
import { DAYS_PER_SEASON, Rng, TICKS_PER_ISLAND_DAY, TICKS_PER_ISLAND_HOUR, WEATHERS } from '@ai-pet/shared';
import { WorldClock } from '../../packages/server/src/sim/clock.ts';

function runTicks(clock: WorldClock, ticks: number, from = 0): { dayChanges: number; weatherChanges: number } {
  let dayChanges = 0;
  let weatherChanges = 0;
  for (let t = from + 1; t <= from + ticks; t++) {
    const r = clock.advance(t);
    if (r.dayChanged) dayChanges++;
    if (r.weatherChanged) weatherChanges++;
  }
  return { dayChanges, weatherChanges };
}

describe('WorldClock', () => {
  test('時間帯が朝→昼→夕→夜の順に変わる', () => {
    const clock = new WorldClock(new Rng('clock'));
    const seen: string[] = [];
    for (let t = 0; t < TICKS_PER_ISLAND_DAY; t += TICKS_PER_ISLAND_HOUR / 2) {
      const tod = clock.state(t).timeOfDay;
      if (seen[seen.length - 1] !== tod) seen.push(tod);
    }
    expect(seen).toEqual(['morning', 'day', 'evening', 'night']);
  });

  test('境界のtickで時間帯が切り替わる', () => {
    expect(WorldClock.timeOfDayOf(0)).toBe('morning');
    expect(WorldClock.timeOfDayOf(0.2499)).toBe('morning');
    expect(WorldClock.timeOfDayOf(0.25)).toBe('day');
    expect(WorldClock.timeOfDayOf(0.5499)).toBe('day');
    expect(WorldClock.timeOfDayOf(0.55)).toBe('evening');
    expect(WorldClock.timeOfDayOf(0.7499)).toBe('evening');
    expect(WorldClock.timeOfDayOf(0.75)).toBe('night');
    expect(WorldClock.timeOfDayOf(0.999)).toBe('night');
  });

  test('1島日ぶん進めると日付が1つ進む', () => {
    const clock = new WorldClock(new Rng('day'));
    expect(clock.islandDay).toBe(1);
    const r = runTicks(clock, TICKS_PER_ISLAND_DAY);
    expect(r.dayChanges).toBe(1);
    expect(clock.islandDay).toBe(2);
  });

  test('7島日で季節が変わり、4季で1年になる', () => {
    const clock = new WorldClock(new Rng('season'));
    expect(clock.season).toBe('spring');
    runTicks(clock, TICKS_PER_ISLAND_DAY * DAYS_PER_SEASON);
    expect(clock.islandDay).toBe(1 + DAYS_PER_SEASON);
    expect(clock.season).toBe('summer');

    runTicks(clock, TICKS_PER_ISLAND_DAY * DAYS_PER_SEASON, TICKS_PER_ISLAND_DAY * DAYS_PER_SEASON);
    expect(clock.season).toBe('autumn');
  });

  test('28島日（4季）で春に戻る', () => {
    const clock = new WorldClock(new Rng('year'));
    runTicks(clock, TICKS_PER_ISLAND_DAY * DAYS_PER_SEASON * 4);
    expect(clock.islandDay).toBe(1 + DAYS_PER_SEASON * 4);
    expect(clock.season).toBe('spring');
  });

  test('天気は既知の値のみを取り、7島日でいくらか変化する', () => {
    const clock = new WorldClock(new Rng('weather'));
    const seen = new Set<string>([clock.weather]);
    for (let t = 1; t <= TICKS_PER_ISLAND_DAY * 7; t++) {
      clock.advance(t);
      seen.add(clock.weather);
      expect(WEATHERS).toContain(clock.weather);
    }
    // 1島時間ごとに10%の抽選があるので、7島日（168回の機会）で複数の天気を見るはず
    expect(seen.size).toBeGreaterThan(1);
  });

  test('同じseedなら天気の列も完全に一致する（決定論）', () => {
    const a = new WorldClock(new Rng('same'));
    const b = new WorldClock(new Rng('same'));
    const seqA: string[] = [];
    const seqB: string[] = [];
    for (let t = 1; t <= TICKS_PER_ISLAND_DAY * 3; t++) {
      a.advance(t);
      b.advance(t);
      seqA.push(a.weather);
      seqB.push(b.weather);
    }
    expect(seqA).toEqual(seqB);
  });

  test('季節ごとの倍率が取れる', () => {
    const clock = new WorldClock(new Rng('mult'));
    expect(clock.regenMultiplier).toBeCloseTo(1.3); // 春
    expect(clock.birthRateMultiplier).toBeCloseTo(1.8);
    runTicks(clock, TICKS_PER_ISLAND_DAY * DAYS_PER_SEASON * 3);
    expect(clock.season).toBe('winter');
    expect(clock.regenMultiplier).toBeCloseTo(0.5); // 冬は食料が減る
    expect(clock.birthRateMultiplier).toBeCloseTo(0.2);
  });

  test('isNight は夜だけtrue', () => {
    const clock = new WorldClock(new Rng('night'));
    expect(clock.isNight(0)).toBe(false);
    expect(clock.isNight(Math.floor(TICKS_PER_ISLAND_DAY * 0.4))).toBe(false);
    expect(clock.isNight(Math.floor(TICKS_PER_ISLAND_DAY * 0.8))).toBe(true);
  });

  test('保存・復元で状態が戻る', () => {
    const clock = new WorldClock(new Rng('save'));
    runTicks(clock, TICKS_PER_ISLAND_DAY * 9);
    const saved = clock.toJSON();

    const restored = new WorldClock(new Rng('other'));
    restored.restore(saved);
    expect(restored.islandDay).toBe(clock.islandDay);
    expect(restored.season).toBe(clock.season);
    expect(restored.weather).toBe(clock.weather);
  });
});
