/** 島の時間・季節・天気（docs/02_ゲーム実装プラン/04_サーバ設計.md §2） */
import {
  DAYS_PER_SEASON,
  Rng,
  SEASONS,
  SEASON_TABLE,
  TICKS_PER_ISLAND_DAY,
  TICKS_PER_ISLAND_HOUR,
  TIME_OF_DAY_BOUNDS,
  WEATHERS,
  type ClockState,
  type Season,
  type TimeOfDay,
  type Weather,
} from '@ai-pet/shared';

export class WorldClock {
  islandDay = 1;
  season: Season = 'spring';
  weather: Weather = 'clear';
  private lastWeatherRollTick = 0;
  private readonly rng: Rng;

  // 注意: Node の type-stripping で動かすため parameter property は使えない
  constructor(rng: Rng) {
    this.rng = rng;
  }

  static timeOfDayOf(progress: number): TimeOfDay {
    if (progress < TIME_OF_DAY_BOUNDS.day) return 'morning';
    if (progress < TIME_OF_DAY_BOUNDS.evening) return 'day';
    if (progress < TIME_OF_DAY_BOUNDS.night) return 'evening';
    return 'night';
  }

  state(tick: number): ClockState {
    const progress = (tick % TICKS_PER_ISLAND_DAY) / TICKS_PER_ISLAND_DAY;
    return {
      tick,
      islandDay: this.islandDay,
      dayProgress: progress,
      timeOfDay: WorldClock.timeOfDayOf(progress),
      season: this.season,
      weather: this.weather,
    };
  }

  /** 日付が変わったtickならtrueを返す（呼び出し側が日次処理を行う） */
  advance(tick: number): { dayChanged: boolean; weatherChanged: boolean } {
    let dayChanged = false;
    let weatherChanged = false;

    if (tick > 0 && tick % TICKS_PER_ISLAND_DAY === 0) {
      this.islandDay++;
      this.season = SEASONS[Math.floor((this.islandDay - 1) / DAYS_PER_SEASON) % SEASONS.length] as Season;
      weatherChanged = this.rollWeather(tick);
      dayChanged = true;
    } else if (tick - this.lastWeatherRollTick >= TICKS_PER_ISLAND_HOUR) {
      // 1島時間ごとに10%の確率で天気が変わる
      this.lastWeatherRollTick = tick;
      if (this.rng.chance(0.1)) weatherChanged = this.rollWeather(tick);
    }

    return { dayChanged, weatherChanged };
  }

  private rollWeather(tick: number): boolean {
    this.lastWeatherRollTick = tick;
    const before = this.weather;
    const weights = SEASON_TABLE[this.season].weather;
    this.weather = WEATHERS[this.rng.weighted(weights)] as Weather;
    return this.weather !== before;
  }

  /** 現在の季節の資源回復倍率 */
  get regenMultiplier(): number {
    return SEASON_TABLE[this.season].regen;
  }

  get birthRateMultiplier(): number {
    return SEASON_TABLE[this.season].birthRate;
  }

  /** 夜（動物が寝る時間帯）かどうか */
  isNight(tick: number): boolean {
    return WorldClock.timeOfDayOf((tick % TICKS_PER_ISLAND_DAY) / TICKS_PER_ISLAND_DAY) === 'night';
  }

  toJSON(): { islandDay: number; season: Season; weather: Weather; lastWeatherRollTick: number } {
    return {
      islandDay: this.islandDay,
      season: this.season,
      weather: this.weather,
      lastWeatherRollTick: this.lastWeatherRollTick,
    };
  }

  restore(s: { islandDay: number; season: Season; weather: Weather; lastWeatherRollTick?: number }): void {
    this.islandDay = s.islandDay;
    this.season = s.season;
    this.weather = s.weather;
    this.lastWeatherRollTick = s.lastWeatherRollTick ?? 0;
  }
}
