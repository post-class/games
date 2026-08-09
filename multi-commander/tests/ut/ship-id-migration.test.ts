import { describe, expect, it } from 'vitest';
import { SHIPS, SHIP_ID_ALIASES, shipDef } from '../../src/content/ships';
import { MISSIONS } from '../../src/content/missions';
import { EXTRA_MISSIONS } from '../../src/content/extraMissions';
import { ACES, RADICAL_SQUADRON } from '../../src/content/aces';
import { chooseDynamicMission, dynamicMissionDef, newFrontlineState, FRONTLINE_SYSTEM_IDS } from '../../src/content/frontline';
import type { MissionDef } from '../../src/mission/types';

/**
 * T5-12: 旧機体id（krant / gratha / dralthi / salthi / dorkir / jalthi / ralatha）の
 * 参照を新idへ追随させたことを保証する。
 *
 * ミッション定義側は「エイリアス経由でなく `SHIPS` に直接存在する新id」であることを検査し、
 * 旧セーブ互換のための `shipDef()` のエイリアス解決は別途維持されていることを検査する。
 */

const OLD_IDS = ['krant', 'gratha', 'dralthi', 'salthi', 'dorkir', 'jalthi', 'ralatha'] as const;

/** ミッション定義が参照する機体idをすべて集める。 */
function shipIdsOf(m: MissionDef): string[] {
  const ids: string[] = [m.playerShipId];
  if (m.wingman?.shipId) ids.push(m.wingman.shipId);
  for (const s of m.spawns ?? []) {
    ids.push(s.shipId);
    if (s.ace?.shipId) ids.push(s.ace.shipId);
  }
  return ids.filter((id): id is string => typeof id === 'string' && id.length > 0);
}

/** 動的作戦は生成関数なので、全システム × 全種別を実際に組み立てて走査する。 */
function dynamicMissions(): MissionDef[] {
  const out: MissionDef[] = [];
  const state = newFrontlineState();
  // 戦況の分岐（logistics 低 / pressure 高 / 通常）をすべて通し、全 kind を生成させる。
  const variants: Array<(id: string) => void> = [
    (id) => {
      state.systems[id as keyof typeof state.systems].logistics = 10;
      state.systems[id as keyof typeof state.systems].pressure = 40;
    },
    (id) => {
      state.systems[id as keyof typeof state.systems].logistics = 80;
      state.systems[id as keyof typeof state.systems].pressure = 90;
    },
    (id) => {
      state.systems[id as keyof typeof state.systems].logistics = 80;
      state.systems[id as keyof typeof state.systems].pressure = 40;
    },
  ];
  for (const apply of variants) {
    for (const sys of FRONTLINE_SYSTEM_IDS) apply(sys);
    for (let serial = 0; serial < FRONTLINE_SYSTEM_IDS.length * 6; serial++) {
      out.push(dynamicMissionDef(chooseDynamicMission(state, 'hangar', serial)));
    }
  }
  return out;
}

describe('ミッション定義の機体idは新idを直接参照する', () => {
  const cases: Array<[string, MissionDef[]]> = [
    ['MISSIONS（既存11ミッション）', Object.values(MISSIONS)],
    ['EXTRA_MISSIONS', EXTRA_MISSIONS],
    ['dynamicMissionDef（動的作戦）', dynamicMissions()],
  ];

  for (const [label, list] of cases) {
    it(`${label} の全 shipId が SHIPS に存在する`, () => {
      expect(list.length).toBeGreaterThan(0);
      const unknown: string[] = [];
      for (const m of list) {
        for (const id of shipIdsOf(m)) if (!SHIPS[id]) unknown.push(`${m.id}: ${id}`);
      }
      expect(unknown).toEqual([]);
    });

    it(`${label} は旧idを参照しない（エイリアス経由でない）`, () => {
      const stale: string[] = [];
      for (const m of list) {
        for (const id of shipIdsOf(m)) {
          if ((OLD_IDS as readonly string[]).includes(id)) stale.push(`${m.id}: ${id}`);
        }
      }
      expect(stale).toEqual([]);
    });
  }

  it('ACES / RADICAL_SQUADRON の機体idも新idを直接参照する', () => {
    const ids = [...ACES.map((a) => a.shipId), ...RADICAL_SQUADRON.shipIds];
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect(SHIPS[id], `unknown ship: ${id}`).toBeTruthy();
      expect((OLD_IDS as readonly string[]).includes(id), `stale ship id: ${id}`).toBe(false);
    }
  });
});

describe('旧機体idの後方互換（旧セーブの shipsFlown / lastSortie 用）', () => {
  it('旧id7件がすべて SHIP_ID_ALIASES に残っている', () => {
    expect(Object.keys(SHIP_ID_ALIASES).sort()).toEqual([...OLD_IDS].sort());
  });

  it.each(OLD_IDS)('%s は shipDef() で解決でき、新idと同じオブジェクトを指す', (oldId) => {
    const newId = SHIP_ID_ALIASES[oldId];
    expect(SHIPS[newId]).toBeTruthy();
    expect(shipDef(oldId)).toBe(shipDef(newId));
    expect(shipDef(oldId)).toBe(SHIPS[newId]);
  });
});
