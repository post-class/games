import { describe, expect, it } from 'vitest';
import {
  CONTROL_PLAYER_DOWN,
  CONTROL_WINGMAN_LOST,
  controlPlayerDownLine,
  controlWingmanLostLine,
} from '../../src/content/dialogue';
import { PERSONALITIES, type PersonalityId } from '../../src/content/pilots';
import {
  mournLine,
  wingmanArmorLine,
  wingmanCriticalLine,
  wingmanShieldDownLine,
} from '../../src/content/pilotDialogue';

/**
 * T1-② の台詞。
 *
 * 僚機の被弾を段階（シールド喪失 → 装甲被弾 → ハル危険域）で喋らせ、
 * 戦死には必ず名前を出して反応させる。台詞が空だと「事件」にならないので、
 * 全性格について文が存在することを固定する。
 */

const IDS = Object.keys(PERSONALITIES) as PersonalityId[];

describe('僚機の被弾段階の台詞', () => {
  it('全性格でシールド喪失・装甲被弾・ハル危険域の台詞がある', () => {
    for (const id of IDS) {
      expect(wingmanShieldDownLine(id).length).toBeGreaterThan(0);
      expect(wingmanArmorLine(id).length).toBeGreaterThan(0);
      expect(wingmanCriticalLine(id).length).toBeGreaterThan(0);
    }
  });

  it('段階ごとに別の文になっている（同じ「被弾した」で済ませない）', () => {
    // 乱択なので、100 回引いた集合が段階間で重ならないことを見る
    const draw = (fn: (id: PersonalityId) => string) =>
      new Set(Array.from({ length: 100 }, () => fn('steady')));
    const shield = draw(wingmanShieldDownLine);
    const armor = draw(wingmanArmorLine);
    const critical = draw(wingmanCriticalLine);
    for (const line of armor) expect(shield.has(line)).toBe(false);
    for (const line of critical) expect(shield.has(line)).toBe(false);
    for (const line of critical) expect(armor.has(line)).toBe(false);
  });

  it('全性格に追悼の台詞がある（他の僚機が反応できる）', () => {
    for (const id of IDS) expect(mournLine(id).length).toBeGreaterThan(0);
  });
});

describe('戦死・撃墜への管制の反応', () => {
  it('僚機の戦死では必ず名前を読む', () => {
    for (let i = 0; i < 50; i++) {
      const line = controlWingmanLostLine('Sable');
      expect(line).toContain('Sable');
      expect(line).not.toContain('{name}');
    }
  });

  it('管制の台詞はすべて名前の差し込み口を持つ', () => {
    for (const line of CONTROL_WINGMAN_LOST) expect(line).toContain('{name}');
  });

  it('自機撃墜にも呼びかけがある', () => {
    expect(CONTROL_PLAYER_DOWN.length).toBeGreaterThan(0);
    expect(controlPlayerDownLine().length).toBeGreaterThan(0);
  });
});
