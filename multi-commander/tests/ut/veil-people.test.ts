import { describe, expect, it } from 'vitest';
import {
  PROTAGONISTS,
  VEIL_PEOPLE,
  gradeFromLevel,
  peopleOfFaction,
  skillFromGrade,
  veilPerson,
  type CombatGrade,
  type VeilPersonFactionId,
} from '../../src/content/veil/people';

/** 十章作戦記録が主要人物に指定している12名（P0-1 の回帰テスト対象）。 */
const STORY_KEY_PEOPLE = [
  '朝倉 澪',
  '神谷 隼人',
  'Amina Okafor',
  'Marcus Johnson',
  'Ploy Srisuk',
  'William Hart',
  'Sophie Laurent',
  'Kim Seoyeon',
  'Claire Bennett',
  '小林 直子',
  'Nia Williams',
  'Omar Rahman',
];

const NONHUMAN_FACTIONS: VeilPersonFactionId[] = ['kilrashi', 'serecion', 'ordo', 'neurowm'];

describe('veil people roster', () => {
  it('総数76名、人類36名、非人類は各勢力10名', () => {
    expect(VEIL_PEOPLE).toHaveLength(76);
    expect(peopleOfFaction('confed')).toHaveLength(36);
    for (const faction of NONHUMAN_FACTIONS) {
      expect(peopleOfFaction(faction)).toHaveLength(10);
    }
  });

  it('idが重複せず、<faction>-<2桁> 形式である', () => {
    const ids = VEIL_PEOPLE.map((person) => person.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const person of VEIL_PEOPLE) {
      expect(person.id).toMatch(/^(confed|kilrashi|serecion|ordo|neurowm)-\d{2}$/);
      expect(person.id.startsWith(`${person.faction}-`)).toBe(true);
    }
  });

  it('勢力ごとに 01 から連番で採番されている', () => {
    for (const faction of ['confed', ...NONHUMAN_FACTIONS] as VeilPersonFactionId[]) {
      const list = peopleOfFaction(faction);
      list.forEach((person, index) => {
        expect(person.id).toBe(`${faction}-${String(index + 1).padStart(2, '0')}`);
      });
    }
  });

  it('主人公候補はちょうど5名で、全員 confed-01〜05', () => {
    expect(PROTAGONISTS).toHaveLength(5);
    expect(PROTAGONISTS.map((person) => person.id)).toEqual([
      'confed-01',
      'confed-02',
      'confed-03',
      'confed-04',
      'confed-05',
    ]);
    expect(VEIL_PEOPLE.filter((person) => person.protagonist === true)).toHaveLength(5);
  });

  it('各勢力に最高権力者がちょうど1名いる', () => {
    for (const faction of ['confed', ...NONHUMAN_FACTIONS] as VeilPersonFactionId[]) {
      const leaders = peopleOfFaction(faction).filter((person) => person.isLeader === true);
      expect(leaders, `${faction} leaders`).toHaveLength(1);
    }
    // 非人類は名鑑どおり各勢力の01番が最高権力者。
    for (const faction of NONHUMAN_FACTIONS) {
      expect(veilPerson(`${faction}-01`).isLeader).toBe(true);
    }
  });

  it('物語の主要12名が名簿に存在する（P0-1 回帰）', () => {
    for (const name of STORY_KEY_PEOPLE) {
      const found = VEIL_PEOPLE.filter((person) => person.name.includes(name));
      expect(found, `missing story person: ${name}`).toHaveLength(1);
      expect(found[0].faction).toBe('confed');
    }
  });

  it('grade が level から式どおり導出されている', () => {
    const order: CombatGrade[] = ['C', 'B', 'A', 'S', 'SS'];
    for (const person of VEIL_PEOPLE) {
      expect(person.level).toBeGreaterThanOrEqual(1);
      expect(person.level).toBeLessThanOrEqual(10);
      const expected = order[Math.min(4, Math.floor((person.level - 1) / 2))];
      expect(person.grade, `${person.id} ${person.name}`).toBe(expected);
      expect(gradeFromLevel(person.level)).toBe(expected);
    }
  });

  it('veilPerson は未知idで例外を投げる', () => {
    expect(veilPerson('confed-01').name).toContain('朝倉 澪');
    expect(() => veilPerson('confed-99')).toThrow(/unknown veil person/);
  });

  it('非人類のみ appearance を持ち、人類は持たない', () => {
    for (const person of VEIL_PEOPLE) {
      if (person.faction === 'confed') expect(person.appearance).toBeUndefined();
      else expect(person.appearance, person.id).toBeTruthy();
    }
  });

  it('skillFromGrade は 0..1 の単調増加で、既存 pilots.ts の値域に収まる', () => {
    const order: CombatGrade[] = ['C', 'B', 'A', 'S', 'SS'];
    const values = order.map((grade) => skillFromGrade(grade));
    expect(values).toEqual([0.45, 0.58, 0.7, 0.82, 0.92]);
    for (let i = 1; i < values.length; i += 1) {
      expect(values[i]).toBeGreaterThan(values[i - 1]);
    }
    for (const value of values) {
      expect(value).toBeGreaterThan(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it('portrait パスが id と対応している', () => {
    for (const person of VEIL_PEOPLE) {
      expect(person.portrait).toBe(`characters/${person.id}.png`);
    }
  });
});
