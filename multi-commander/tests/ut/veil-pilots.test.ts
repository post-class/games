import { describe, expect, it } from 'vitest';
import {
  PERSONALITIES,
  PILOTS,
  pilotDef,
  pilotFaceId,
  pilotPerson,
  REPLACEMENT_POOL,
  STARTING_SQUADRON,
} from '../../src/content/pilots';
import { FACE_ART_IDS } from '../../src/ui/Portrait';
import { PROTAGONISTS, skillFromGrade, veilPerson } from '../../src/content/veil/people';
import { applySortie, newRoster } from '../../src/app/roster';

describe('僚機名簿と人物名簿の対応', () => {
  it('名簿の全員が人物名簿で解決でき、名前と二つ名は人物名簿の値と一致する', () => {
    expect(PILOTS).toHaveLength(8);
    for (const pilot of PILOTS) {
      const person = veilPerson(pilot.personId);
      expect(person.faction).toBe('confed');
      expect(pilot.name).toBe(person.name);
      expect(pilot.callsign).toBe(person.epithet);
      expect(pilotPerson(pilot.id).id).toBe(person.id);
    }
  });

  it('技量は人物の戦闘級から一意に決まる（名簿以外に出所がない）', () => {
    for (const pilot of PILOTS) {
      const person = veilPerson(pilot.personId);
      expect(pilot.skill).toBe(skillFromGrade(person.grade));
    }
  });

  it('主人公候補5名は僚機名簿に含まれない', () => {
    const personIds = new Set(PILOTS.map((p) => p.personId));
    expect(PROTAGONISTS).toHaveLength(5);
    for (const hero of PROTAGONISTS) {
      expect(personIds.has(hero.id)).toBe(false);
    }
  });

  it('性格は既存6種のいずれかで、id と人物 id は重複しない', () => {
    const ids = new Set<string>();
    const personIds = new Set<string>();
    for (const pilot of PILOTS) {
      expect(PERSONALITIES[pilot.personality]).toBeDefined();
      expect(ids.has(pilot.id)).toBe(false);
      expect(personIds.has(pilot.personId)).toBe(false);
      ids.add(pilot.id);
      personIds.add(pilot.personId);
    }
  });

  it('顔画像 id は用意済みの画像セット内に収まる（404 防止）', () => {
    for (const pilot of PILOTS) {
      // TODO(T2-6): 新人物の肖像に差し替えたら、期待値も新 id に合わせて更新する。
      expect(FACE_ART_IDS.has(pilotFaceId(pilot.id))).toBe(true);
    }
  });

  it('初期飛行隊と補充候補は名簿の実在 id で、重複しない', () => {
    expect(STARTING_SQUADRON).toHaveLength(5);
    expect(REPLACEMENT_POOL).toHaveLength(3);
    const all = [...STARTING_SQUADRON, ...REPLACEMENT_POOL];
    expect(new Set(all).size).toBe(all.length);
    for (const id of all) expect(() => pilotDef(id)).not.toThrow();
  });

  it('新名簿でも戦死は永続し、欠員は補充候補から埋まる', () => {
    const roster = newRoster();
    const victim = roster.pilots[0].id;
    applySortie(roster, {
      wingmanId: victim,
      wingmanLost: true,
      wingmanKills: 1,
      wingmanHullRatio: 0,
      rescued: false,
      abandoned: false,
      missionTitle: 'テスト任務',
      chapter: 1,
    });
    const dead = roster.pilots.find((p) => p.id === victim)!;
    expect(dead.status).toBe('dead');
    expect(roster.pilots).toHaveLength(6);
    expect(roster.pilots.some((p) => p.id === REPLACEMENT_POOL[0])).toBe(true);
  });
});
