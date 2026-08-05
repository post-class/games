import { describe, expect, it } from 'vitest';
import { ageHoursOf, stageFor, stageProgress } from '../server/pet/growth.js';
import { awayActivities, awayPlaces } from '../server/pet/away.js';
import { clampPersonality, type Personality } from '../shared/personality.js';
import { SPOTS, ZONES } from '../shared/world.js';
import type { PetRecord } from '../server/pet/store.js';

describe('stageFor', () => {
  it('生まれたばかりはたまご', () => {
    expect(stageFor(0, 0)).toBe('egg');
  });

  it('世話が足りていないと時間だけでは孵らない', () => {
    expect(stageFor(100, 0)).toBe('egg');
  });

  it('時間が足りていないと世話だけでは孵らない', () => {
    expect(stageFor(0, 100)).toBe('egg');
  });

  it('両方満たすとこどもになる', () => {
    expect(stageFor(1, 5)).toBe('child');
  });

  it('おとなには時間も世話も要る', () => {
    expect(stageFor(30, 20)).toBe('child');
    expect(stageFor(10, 50)).toBe('child');
    expect(stageFor(30, 50)).toBe('adult');
  });
});

describe('stageProgress', () => {
  it('進捗は 0〜1 に収まる', () => {
    expect(stageProgress(0, 0)).toBeGreaterThanOrEqual(0);
    expect(stageProgress(0, 0)).toBeLessThanOrEqual(1);
  });

  it('おとなになったら 1', () => {
    expect(stageProgress(100, 100)).toBe(1);
  });

  it('遅れているほうの条件で決まる', () => {
    // こども段階。おとなの条件は 24時間 / 世話40。
    // 世話は半分（0.5）まで進んでいるが時間が 1/24 しか経っていないので、遅い方が出る。
    expect(stageProgress(1, 20)).toBeCloseTo(1 / 24, 5);
    // 逆に時間が十分で世話が足りない場合は世話の進捗が出る。
    expect(stageProgress(24, 20)).toBeCloseTo(20 / 40, 5);
  });
});

describe('ageHoursOf', () => {
  it('経過時間を時間単位で返す', () => {
    expect(ageHoursOf(0, 7_200_000)).toBe(2);
  });

  it('未来の生年月日でも負にならない', () => {
    expect(ageHoursOf(1000, 0)).toBe(0);
  });
});

describe('awayActivities', () => {
  const pet = (needs: Partial<PetRecord['needs']>, personality: Partial<Personality>): PetRecord => ({
    id: 1,
    userId: 1,
    name: 'テスト',
    species: 'mocha',
    personality: clampPersonality({ ...blank(), ...personality } as Personality),
    needs: { hunger: 70, fun: 70, clean: 70, energy: 70, mood: 70, ...needs },
    careScore: 10,
    action: 'idle',
    emotion: 'curious',
    bornAt: 0,
    needsAt: 0,
    lastThinkAt: 0,
    lastEncounterAt: 0,
  });

  it('短時間の留守では何も起きない', () => {
    expect(awayActivities(pet({}, {}), 0.2)).toEqual([]);
  });

  it('眠そうなら寝ていたことにする', () => {
    expect(awayActivities(pet({ energy: 20 }, {}), 2)).toContain('nap');
  });

  it('拗ねているなら隅にいたことにする', () => {
    expect(awayActivities(pet({ mood: 10 }, {}), 2)).toContain('sulk_corner');
  });

  it('いたずら好きは物を隠す、そうでなければ窓の外を見る', () => {
    expect(awayActivities(pet({ fun: 10 }, { mischief: 90 }), 2)).toContain('hide_item');
    expect(awayActivities(pet({ fun: 10 }, { mischief: 10 }), 2)).toContain('peek_window');
  });

  it('多くても3件までにする（レポートが冗長にならない）', () => {
    const busy = pet({ hunger: 10, fun: 10, clean: 80, energy: 10, mood: 10 }, { clever: 90 });
    expect(awayActivities(busy, 12).length).toBeLessThanOrEqual(3);
  });

  describe('awayPlaces', () => {
    it('短い留守では場所の話をしない', () => {
      expect(awayPlaces(pet({}, {}), 0.4)).toEqual([]);
    });

    it('留守が長いほど多く語るが、3件までにする', () => {
      expect(awayPlaces(pet({}, {}), 2).length).toBe(2);
      expect(awayPlaces(pet({}, {}), 12).length).toBe(3);
    });

    it('ゾーンの名前つきで、定義済みの文だけを使う', () => {
      const known = SPOTS.flatMap((spot) => spot.finds ?? []);
      for (const line of awayPlaces(pet({ hunger: 10 }, { gluttony: 90 }), 8)) {
        expect(known.some((text) => line.endsWith(text))).toBe(true);
        expect(ZONES.some((zone) => line.startsWith(zone.name))).toBe(true);
      }
    });

    it('同じ状態・同じ留守時間なら同じ結果（決定論的）', () => {
      const target = pet({ fun: 10 }, { mischief: 80 });
      expect(awayPlaces(target, 5)).toEqual(awayPlaces(target, 5));
    });
  });
});

function blank(): Record<string, number> {
  return {
    energy: 50,
    clingy: 50,
    willful: 50,
    clever: 50,
    social: 50,
    gluttony: 50,
    timid: 50,
    mischief: 50,
  };
}
