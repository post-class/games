import { describe, expect, it } from 'vitest';
import { newAceStates, recordAceEscape, recordAceKill } from '../../src/content/aces';
import { dynamicMissionDef } from '../../src/content/frontline';
import { MISSION_COUNT, missionDef } from '../../src/content/missions';
import { clampLoadout, consumeLoadout, newSupplies } from '../../src/app/supplies';
import { advanceCampaignSave, newCampaignSave } from '../../src/app/save';
import { newStatistics, recordCampaignOutcome, recordMissionStatistics } from '../../src/app/statistics';
import {
  campaignGraph,
  campaignMap,
  campaignNode,
  campaignStart,
  advance,
  newCampaignProgress,
  resolveCampaignOutcome,
  totalChapters,
  VICTORY,
  DEFEAT,
} from '../../src/content/campaign';

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

  /**
   * 戦役は THE VEIL FRONT の十章だけ（canon / expanded は削除済み）。
   * 「モードを選べる」ことではなく「十章が一本の順路になっている」ことを守る。
   */
  it('新しい戦役は必ず第1章から始まる', () => {
    const save = newCampaignSave();
    expect(save.node).toBe(campaignStart());
    expect(save.node).toBe('veil-ch01');
    expect(campaignNode(save.node).chapter).toBe(1);
    expect(totalChapters()).toBe(10);
  });

  it('勝敗のどちらでも次章へ進む（敗北ルートを持たない）', () => {
    const win = newCampaignProgress();
    const winTurn = resolveCampaignOutcome(win, 'win');
    expect(winTurn.nextNode).toBe('veil-ch02');
    expect(winTurn.route).toBe('advance');

    const loss = newCampaignProgress();
    const lossTurn = resolveCampaignOutcome(loss, 'loss');
    // 敗北でも次章。達成しなかった条件は戦況文に記録として残る
    expect(lossTurn.nextNode).toBe('veil-ch02');
    expect(lossTurn.route).toBe('hold');
    expect(lossTurn.situation).toContain('未達');
  });

  it('戦役マップは現在地、到達可能な次章、未到達を区別する', () => {
    const map = campaignMap('veil-ch01');
    expect(map.find((entry) => entry.id === 'veil-ch01')?.status).toBe('current');
    expect(map.find((entry) => entry.id === 'veil-ch02')?.status).toBe('reachable');
    expect(map.find((entry) => entry.id === 'veil-ch05')?.status).toBe('unreached');
  });

  it('save 進行は勝敗と統計を同じ結果から更新する', () => {
    const save = newCampaignSave();
    const transition = advanceCampaignSave(save, 'loss');
    expect(save.node).toBe('veil-ch02');
    expect(save.campaignHistory).toHaveLength(1);
    expect(save.statistics.campaignLosses).toBe(1);
    expect(transition.nextNode).toBe(save.node);
  });

  it('全ノードは勝敗のどちらからも終端へ到達できる', () => {
    const graph = campaignGraph();
    for (const id of Object.keys(graph)) {
      for (const outcome of ['win', 'loss'] as const) {
        let node = id;
        for (let i = 0; i < 20 && node !== VICTORY && node !== DEFEAT; i++) node = advance(node, outcome);
        expect(node === VICTORY || node === DEFEAT, `${id}/${outcome}`).toBe(true);
      }
    }
  });

  it('シリーズ勝敗統計は route とノードを保持する', () => {
    const stats = newStatistics();
    recordCampaignOutcome(stats, { node: 'veil-ch01', outcome: 'win', points: 2, route: 'advance' });
    expect(stats.seriesScore).toBe(2);
    expect(stats.campaignNodes['veil-ch01']).toEqual({ wins: 1, losses: 0 });
  });

  it('外周作戦と十章キャンペーンが登録されている', () => {
    // 外周作戦9本 + veil の十章 = 19本（旧11ミッションは削除した）
    expect(MISSION_COUNT).toBe(19);
    expect(missionDef('m7-quiet-patrol').spawns).toHaveLength(0);
    expect(missionDef('veil-ch01').navs.length).toBeGreaterThan(0);
  });

  it('戦況の拠点強襲は砲塔→エンジン→魚雷の順に進む', () => {
    const ref = { id: 'dynamic-1-vega-gate-capital', system: 'vega-gate', kind: 'capital', seed: 1, returnNode: 'veil-ch01' } as const;
    const stages = dynamicMissionDef(ref).capitalStages ?? [];
    expect(stages.map((stage) => stage.subsystem ?? stage.weapon)).toEqual(['turret', 'engine', 'torpedo']);
  });
});
