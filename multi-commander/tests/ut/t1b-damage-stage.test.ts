import { describe, expect, it } from 'vitest';
import {
  damageStage,
  damageStageAdvice,
  damageStageLabel,
  HULL_DANGER_RATIO,
  stageWorsened,
  type DamageRatios,
} from '../../src/hud/damageStage';
import { DeathHold, PLAYER_DEATH_HOLD } from '../../src/app/game';

/**
 * T1-② 「撃墜と戦死を、事件として見せる」の判定部分。
 *
 * 段階の境目と、撃墜からの「間」で入力が止まることを固定する。
 * 表示・音・無線はこの判定を読むだけなので、ここが崩れると全部が崩れる。
 */

function ratios(over: Partial<DamageRatios> = {}): DamageRatios {
  return {
    shieldFront: 1,
    shieldRear: 1,
    armor: { front: 1, rear: 1, left: 1, right: 1 },
    hull: 1,
    ...over,
  };
}

describe('被弾段階の判定', () => {
  it('無傷はシールド健全', () => {
    expect(damageStage(ratios())).toBe('shield-ok');
  });

  it('前後のシールドが両方 15% を切ったときだけシールド喪失', () => {
    expect(damageStage(ratios({ shieldFront: 0.1, shieldRear: 0.9 }))).toBe('shield-ok');
    expect(damageStage(ratios({ shieldFront: 0.1, shieldRear: 0.1 }))).toBe('shield-down');
  });

  it('装甲が1面でも削れていれば装甲被弾', () => {
    const h = ratios({ shieldFront: 0.1, shieldRear: 0.1 });
    h.armor.left = 0.85;
    expect(damageStage(h)).toBe('armor-hit');
  });

  it('ハルが減れば、装甲やシールドの残量に関わらずハル被弾', () => {
    expect(damageStage(ratios({ hull: 0.9 }))).toBe('hull-hit');
  });

  it('ハル 30% がハル危険域の境目 (境界値も危険域に入れる)', () => {
    expect(HULL_DANGER_RATIO).toBe(0.3);
    expect(damageStage(ratios({ hull: 0.31 }))).toBe('hull-hit');
    expect(damageStage(ratios({ hull: 0.3 }))).toBe('hull-critical');
    expect(damageStage(ratios({ hull: 0.05 }))).toBe('hull-critical');
    expect(damageStage(ratios({ hull: 0 }))).toBe('hull-critical');
  });

  it('段階が進んだときだけ悪化と判定する (同じ段階と回復では警告しない)', () => {
    expect(stageWorsened('shield-ok', 'shield-down')).toBe(true);
    expect(stageWorsened('armor-hit', 'hull-critical')).toBe(true);
    expect(stageWorsened('hull-hit', 'hull-hit')).toBe(false);
    expect(stageWorsened('hull-critical', 'shield-down')).toBe(false);
  });

  it('ハル危険域の文言に脱出操作を含む (どこにも出ていなかった案内を出す)', () => {
    expect(damageStageLabel('hull-critical')).toBe('ハル危険域');
    expect(damageStageAdvice('hull-critical')).toContain('Alt+E');
  });

  it('段階ごとに「何が起きたか」と「どうするか」の両方を持つ', () => {
    for (const stage of ['shield-down', 'armor-hit', 'hull-hit', 'hull-critical'] as const) {
      expect(damageStageLabel(stage).length).toBeGreaterThan(0);
      expect(damageStageAdvice(stage).length).toBeGreaterThan(0);
    }
  });
});

describe('自機撃墜からの間', () => {
  it('3〜5秒の間を取る', () => {
    expect(PLAYER_DEATH_HOLD).toBeGreaterThanOrEqual(3);
    expect(PLAYER_DEATH_HOLD).toBeLessThanOrEqual(5);
  });

  it('撃墜前は入力を止めない', () => {
    const hold = new DeathHold();
    expect(hold.locked).toBe(false);
    expect(hold.down).toBe(false);
  });

  it('撃墜すると入力が無効になり、間が明けてから解除される', () => {
    const hold = new DeathHold();
    expect(hold.begin(4)).toBe(true);
    expect(hold.locked).toBe(true);

    for (let t = 0; t < 3.9; t += 1 / 60) hold.tick(1 / 60);
    expect(hold.locked).toBe(true);

    hold.tick(0.2);
    expect(hold.locked).toBe(false);
    expect(hold.remaining).toBe(0);
    // 間が明けても「撃墜された」ことは残る (終了処理が撃墜として扱えるように)
    expect(hold.down).toBe(true);
  });

  it('撃墜演出は二重に始まらない (残り時間が伸びない)', () => {
    const hold = new DeathHold();
    hold.begin(4);
    hold.tick(1);
    expect(hold.begin(4)).toBe(false);
    expect(hold.remaining).toBeCloseTo(3, 5);
  });

  it('リセットで次の出撃へ持ち越さない', () => {
    const hold = new DeathHold();
    hold.begin();
    hold.reset();
    expect(hold.locked).toBe(false);
    expect(hold.down).toBe(false);
  });
});
