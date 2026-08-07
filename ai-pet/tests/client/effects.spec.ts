/**
 * 時間帯の色被せと星空・月（F-1）。
 *
 * `TimeTint` / `NightSky` の本体は Pixi と DOM が必要なので、
 * ここでは「夜の濃さ」と「星の並べ方・月の満ち欠け」の計算だけを検証する。
 */
import { describe, expect, it } from 'vitest';
import {
  MOON_CYCLE_DAYS,
  TOD_TINT,
  moonPhase,
  nightSkyStrength,
  starPositions,
} from '../../packages/client/src/render/effects.ts';

describe('TOD_TINT（夜の濃さ）', () => {
  it('夜は紺のまま alpha 0.45 以上（調査結果 §3-1 の「20%しか暗くならない」を解消する）', () => {
    const night = TOD_TINT['night'];
    expect(night).toBeDefined();
    expect(night?.color).toBe(0x24356e);
    expect(night?.alpha).toBeGreaterThanOrEqual(0.45);
  });

  it('夕は夜より薄く、朝より濃い', () => {
    const evening = TOD_TINT['evening']?.alpha ?? 0;
    const night = TOD_TINT['night']?.alpha ?? 0;
    const morning = TOD_TINT['morning']?.alpha ?? 0;
    expect(evening).toBeLessThan(night);
    expect(evening).toBeGreaterThan(morning);
  });

  it('昼は色被せなし（回帰させない）', () => {
    expect(TOD_TINT['day']).toEqual({ color: 0xffffff, alpha: 0 });
  });
});

describe('nightSkyStrength', () => {
  it('夜が最大・昼は0（昼は1枚も描かない）', () => {
    expect(nightSkyStrength('night')).toBe(1);
    expect(nightSkyStrength('day')).toBe(0);
  });

  it('夕は少しだけ星が出る', () => {
    expect(nightSkyStrength('evening')).toBeGreaterThan(0);
    expect(nightSkyStrength('evening')).toBeLessThan(1);
  });

  it('未知の時間帯は0（落ちない）', () => {
    expect(nightSkyStrength('midnight-snack')).toBe(0);
  });
});

describe('starPositions', () => {
  it('決定論的（同じ引数なら毎回同じ配置＝毎フレーム Math.random を呼ばない）', () => {
    expect(starPositions(40, 960, 540)).toEqual(starPositions(40, 960, 540));
  });

  it('指定した数だけ作り、画面内に収まる', () => {
    const stars = starPositions(64, 800, 600);
    expect(stars.length).toBe(64);
    for (const s of stars) {
      expect(s.x).toBeGreaterThanOrEqual(0);
      expect(s.x).toBeLessThanOrEqual(800);
      expect(s.y).toBeGreaterThanOrEqual(0);
      expect(s.y).toBeLessThanOrEqual(600);
      expect(s.r).toBeGreaterThan(0);
      expect(s.alpha).toBeGreaterThan(0);
      expect(s.alpha).toBeLessThanOrEqual(1);
    }
  });

  it('上側に寄っている（真上見下ろしでも「空が覗く」ように見せる）', () => {
    const stars = starPositions(200, 800, 600);
    const avgY = stars.reduce((a, s) => a + s.y, 0) / stars.length;
    expect(avgY).toBeLessThan(300);
  });

  it('明滅グループが2つに分かれる', () => {
    const groups = new Set(starPositions(20, 100, 100).map((s) => s.group));
    expect([...groups].sort()).toEqual([0, 1]);
  });

  it('0個でも落ちない', () => {
    expect(starPositions(0, 100, 100)).toEqual([]);
  });
});

describe('moonPhase', () => {
  it('周期の半分で満月・境目で新月', () => {
    expect(moonPhase(0).illum).toBeCloseTo(0);
    expect(moonPhase(MOON_CYCLE_DAYS / 2).illum).toBeCloseTo(1);
    expect(moonPhase(MOON_CYCLE_DAYS).illum).toBeCloseTo(0);
  });

  it('満ちていく側と欠けていく側で光る向きが変わる', () => {
    expect(moonPhase(1).waxing).toBe(true);
    expect(moonPhase(MOON_CYCLE_DAYS - 1).waxing).toBe(false);
  });

  it('illum は常に 0..1', () => {
    for (let d = -20; d <= 40; d++) {
      const p = moonPhase(d);
      expect(p.illum).toBeGreaterThanOrEqual(0);
      expect(p.illum).toBeLessThanOrEqual(1);
    }
  });

  it('島日が負でも落ちない（時計が巻き戻ったとき）', () => {
    expect(moonPhase(-3).illum).toBeCloseTo(moonPhase(MOON_CYCLE_DAYS - 3).illum);
  });
});
