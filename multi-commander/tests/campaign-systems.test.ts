import { describe, expect, it } from 'vitest';
import { newAceStates, recordAceEscape, recordAceKill } from '../src/content/aces';
import { applyFrontlineOutcome, chooseDynamicMission, dynamicMissionDef, newFrontlineState } from '../src/content/frontline';
import { MISSION_COUNT, missionDef } from '../src/content/missions';
import { clampLoadout, consumeLoadout, newSupplies } from '../src/app/supplies';
import { newStatistics, recordMissionStatistics } from '../src/app/statistics';

describe('キャンペーンの名作化システム', () => {
  it('宿敵は離脱を記録し、撃墜後は再び生存に戻らない', () => {
    const state = newAceStates()[0];
    recordAceEscape(state);
    expect(state.escaped).toBe(1);
    recordAceKill(state);
    recordAceEscape(state);
    expect(state.status).toBe('killed');
    expect(state.escaped).toBe(1);
  });

  it('戦況作戦は最も押されている星系を選び、結果で値を動かす', () => {
    const frontline = newFrontlineState();
    const ref = chooseDynamicMission(frontline, 'm2-escort', 0);
    expect(ref.system).toBe('Vega');
    const before = frontline.systems[ref.system].control;
    applyFrontlineOutcome(frontline, ref, 'win', { kills: 5, escortLost: false });
    expect(frontline.systems[ref.system].control).toBeGreaterThan(before);
    expect(dynamicMissionDef(ref).id).toBe(ref.id);
  });

  it('有限補給は搭載上限と消費を守る', () => {
    const supplies = newSupplies();
    const load = clampLoadout(supplies, [{ missileId: 'torpedo', count: 99 }]);
    expect(load).toEqual([{ missileId: 'torpedo', count: 6 }]);
    consumeLoadout(supplies, load);
    expect(supplies.missiles.torpedo).toBe(0);
  });

  it('統計は命中率の材料と機体別履歴を蓄積する', () => {
    const stats = newStatistics();
    recordMissionStatistics(stats, {
      outcome: 'win', shipId: 'rapier', seconds: 90, shotsFired: 20, hits: 8,
      wingmanHullRatio: 0.8, wingmanRescued: true, wingmanAbandoned: false,
    });
    expect(stats.missionsWon).toBe(1);
    expect(stats.shotsFired).toBe(20);
    expect(stats.shipsFlown.rapier).toBe(1);
  });

  it('常設任務を含めて20前後の任務が登録され、多段攻撃が存在する', () => {
    expect(MISSION_COUNT).toBe(20);
    expect(missionDef('m7-quiet-patrol').spawns).toHaveLength(0);
    expect(missionDef('m6-flagship').capitalStages?.map((s) => s.tag)).toEqual(['escort', 'flagship']);
  });

  it('戦況の拠点強襲は砲塔→エンジン→魚雷の順に進む', () => {
    const ref = { id: 'dynamic-1-Vega-capital', system: 'Vega', kind: 'capital', seed: 1, returnNode: 'm2-escort' } as const;
    const stages = dynamicMissionDef(ref).capitalStages ?? [];
    expect(stages.map((stage) => stage.subsystem ?? stage.weapon)).toEqual(['turret', 'engine', 'torpedo']);
  });
});
