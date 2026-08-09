import { describe, expect, it } from 'vitest';
import {
  ACES,
  RADICAL_SQUADRON,
  aceDef,
  aceIdForPilot,
  aceState,
  acesByStance,
  newAceStates,
  normalizeAceStates,
  recordAceEscape,
  recordAceKill,
} from '../../src/content/aces';
import { skillFromGrade, veilPerson } from '../../src/content/veil/people';

describe('エース定義と人物名簿の対応', () => {
  it('全エースが人物名簿で解決でき、表示名・技量が名簿から導出されている', () => {
    expect(ACES.length).toBe(5);
    for (const ace of ACES) {
      const person = veilPerson(ace.personId);
      expect(person.faction).toBe('kilrashi');
      expect(ace.pilot).toBe(person.name);
      expect(ace.callsign).toBe(person.epithet);
      expect(ace.skill).toBe(skillFromGrade(person.grade));
      expect(ace.faction).toBe('kilrathi');
    }
  });

  it('idは一意で、aceDef / aceIdForPilot で相互に引ける', () => {
    expect(new Set(ACES.map((a) => a.id)).size).toBe(ACES.length);
    for (const ace of ACES) {
      expect(aceDef(ace.id)).toBe(ace);
      expect(aceIdForPilot(ace.pilot)).toBe(ace.id);
    }
    expect(aceIdForPilot(undefined)).toBeUndefined();
    expect(aceIdForPilot('存在しない人')).toBeUndefined();
  });

  it('旧ミッション定義のパイロット名からも新エースidへ逆引きできる', () => {
    expect(aceIdForPilot('Khajja nar Ragitika')).toBe('ragitika');
    expect(aceIdForPilot('Bhurak nar Caxki')).toBe('caxki');
    expect(aceIdForPilot('Dakhath «Deathstroke»')).toBe('dakhas');
  });

  it('stance は oath / radical のいずれかで、ラギティカは誓約を守る側', () => {
    for (const ace of ACES) {
      expect(['oath', 'radical']).toContain(ace.stance);
    }
    const ragitika = aceDef('ragitika');
    expect(ragitika?.personId).toBe('kilrashi-03');
    expect(ragitika?.stance).toBe('oath');
    expect(ragitika?.oathRules?.challenges).toBe(true);
    expect(ragitika?.oathRules?.exchangeNames).toBe(true);
    expect(ragitika?.oathRules?.remembersNames).toBe(true);

    expect(acesByStance('oath').map((a) => a.id)).toContain('seiraku');
    expect(acesByStance('radical').length).toBeGreaterThan(0);
    expect(acesByStance('oath').length + acesByStance('radical').length).toBe(ACES.length);
  });

  it('急進派の分艦隊は個人ではなく勢力として定義され、第5/8/10章に登場する', () => {
    expect(RADICAL_SQUADRON.stance).toBe('radical');
    expect(RADICAL_SQUADRON.faction).toBe('kilrathi');
    expect(RADICAL_SQUADRON.appearances.map((a) => a.chapter)).toEqual([5, 8, 10]);
    // 分艦隊の中核は radical のエースのみ
    for (const id of RADICAL_SQUADRON.aceIds) {
      expect(aceDef(id)?.stance).toBe('radical');
    }
    // 個人としての持ち越し対象には含めない
    expect(newAceStates().some((s) => s.id === RADICAL_SQUADRON.id)).toBe(false);
  });
});

describe('normalizeAceStates の後方互換', () => {
  it('新規状態は全エース分そろい、技量は定義値', () => {
    const states = newAceStates();
    expect(states.map((s) => s.id)).toEqual(ACES.map((a) => a.id));
    for (const s of states) {
      expect(s.skill).toBe(aceDef(s.id)!.skill);
      expect(s.status).toBe('active');
    }
  });

  it('旧セーブの旧id（bhurak / khajja / dakhath）から新エースへ移行する', () => {
    const legacy = [
      { id: 'bhurak', encounters: 2, kills: 0, skill: 0.86, status: 'active', escaped: 1, lastMission: 'm4-defend' },
      { id: 'khajja', encounters: 3, kills: 1, skill: 0.93, status: 'killed', escaped: 2, lastVictim: 'Angel' },
      { id: 'dakhath', encounters: 1, kills: 0, skill: 0.88, status: 'active', escaped: 0 },
    ];
    const states = normalizeAceStates(legacy);
    expect(states.map((s) => s.id)).toEqual(ACES.map((a) => a.id));

    const caxki = states.find((s) => s.id === 'caxki')!;
    expect(caxki.encounters).toBe(2);
    expect(caxki.escaped).toBe(1);
    expect(caxki.lastMission).toBe('m4-defend');

    const ragitika = states.find((s) => s.id === 'ragitika')!;
    expect(ragitika.status).toBe('killed');
    expect(ragitika.kills).toBe(1);
    expect(ragitika.escaped).toBe(2);
    expect(ragitika.lastVictim).toBe('Angel');

    expect(states.find((s) => s.id === 'dakhas')!.encounters).toBe(1);
    // 新規追加分は既定値のまま
    expect(states.find((s) => s.id === 'fen')!.encounters).toBe(0);
  });

  it('未知idは無視し、他の項目は復元する', () => {
    const states = normalizeAceStates([
      { id: 'thrakhath-the-unknown', encounters: 99, kills: 9 },
      { id: 'ragitika', encounters: 4 },
    ]);
    expect(states.map((s) => s.id)).toEqual(ACES.map((a) => a.id));
    expect(states.find((s) => s.id === 'ragitika')!.encounters).toBe(4);
    expect(states.every((s) => s.kills === 0)).toBe(true);
  });

  it('不正な型（null / 文字列 / 数値 / 混在配列）から既定値で復帰する', () => {
    for (const raw of [null, undefined, 'aceStates', 42, {}, true]) {
      expect(normalizeAceStates(raw)).toEqual(newAceStates());
    }
    expect(normalizeAceStates([null, 'x', 7, { id: 5 }, { noId: true }])).toEqual(newAceStates());
    const broken = normalizeAceStates([{ id: 'ragitika', encounters: 'many', kills: -3, skill: '高い', status: 'ghost' }]);
    const ragitika = broken.find((s) => s.id === 'ragitika')!;
    expect(ragitika.encounters).toBe(0);
    expect(ragitika.kills).toBe(0);
    expect(ragitika.skill).toBe(aceDef('ragitika')!.skill);
    expect(ragitika.status).toBe('active');
  });

  it('撃墜・離脱の持ち越しが旧セーブ経由でも機能する', () => {
    const states = normalizeAceStates([{ id: 'khajja', encounters: 1, escaped: 1, skill: 0.9 }]);
    const ragitika = aceState(states, 'ラギティカ')!;
    expect(ragitika.id).toBe('ragitika');
    recordAceEscape(ragitika);
    expect(ragitika.escaped).toBe(2);
    expect(ragitika.skill).toBeCloseTo(0.915, 5);
    recordAceKill(ragitika);
    expect(ragitika.status).toBe('killed');
    recordAceEscape(ragitika);
    expect(ragitika.escaped).toBe(2);
  });

  it('aceState は 新id / 旧id / 表示名 / 旧パイロット名 のどれでも引ける', () => {
    const states = newAceStates();
    expect(aceState(states, 'caxki')?.id).toBe('caxki');
    expect(aceState(states, 'bhurak')?.id).toBe('caxki');
    expect(aceState(states, 'カクシ')?.id).toBe('caxki');
    expect(aceState(states, 'Bhurak nar Caxki')?.id).toBe('caxki');
    expect(aceState(states, '知らない敵')).toBeUndefined();
  });
});
