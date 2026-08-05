import { describe, expect, it } from 'vitest';
import { newAceStates, recordAceEscape, recordAceKill } from '../src/content/aces';
import { applyFrontlineOutcome, chooseDynamicMission, dynamicMissionDef, newFrontlineState } from '../src/content/frontline';
import { MISSION_COUNT, missionDef } from '../src/content/missions';
import { clampLoadout, consumeLoadout, newSupplies } from '../src/app/supplies';
import { advanceCampaignSave, newSave } from '../src/app/save';
import { newStatistics, recordCampaignOutcome, recordMissionStatistics } from '../src/app/statistics';
import {
  CANON_CAMPAIGN,
  CANON_CAMPAIGN_START,
  CAMPAIGN,
  campaignMap,
  campaignNode,
  advance,
  newCampaignProgress,
  resolveCampaignOutcome,
  VICTORY,
  DEFEAT,
} from '../src/content/campaign';

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

  it('canon は Enyo 起点で、expanded の McCaffrey ルートと分離されている', () => {
    const canon = newSave('canon');
    const expanded = newSave();
    expect(canon.node).toBe(CANON_CAMPAIGN_START);
    expect(canon.campaignMode).toBe('canon');
    expect(expanded.node).toBe('m1-patrol');
    expect(expanded.campaignMode).toBe('expanded');
    expect(campaignNode(canon.node, 'canon').system).toBe('Enyo');
    expect(campaignNode(expanded.node).system).toBe('McCaffrey');
  });

  it('canon の勝敗は別の次ノード、ルート、シリーズスコアを返す', () => {
    const win = newCampaignProgress('canon');
    const winTurn = resolveCampaignOutcome(win, 'win');
    expect(winTurn.nextNode).toBe('canon-mcauliffe-escort');
    expect(winTurn.route).toBe('advance');
    expect(win.score).toBe(2);

    const loss = newCampaignProgress('canon');
    const lossTurn = resolveCampaignOutcome(loss, 'loss');
    expect(lossTurn.nextNode).toBe('canon-enyo-defense');
    expect(lossTurn.route).toBe('retreat');
    expect(loss.score).toBe(-2);
    expect(lossTurn.nextSituation).toContain('Enyo');
  });

  it('戦役マップは現在地、到達可能な勝敗分岐、未到達を区別する', () => {
    const map = campaignMap('canon', CANON_CAMPAIGN_START);
    expect(map.find((entry) => entry.id === CANON_CAMPAIGN_START)?.status).toBe('current');
    expect(map.find((entry) => entry.id === 'canon-mcauliffe-escort')?.status).toBe('reachable');
    expect(map.find((entry) => entry.id === 'canon-enyo-defense')?.status).toBe('reachable');
    expect(map.find((entry) => entry.id === 'canon-gateway-strike')?.status).toBe('unreached');
  });

  it('save 進行は勝敗と統計を同じ結果から更新する', () => {
    const save = newSave('canon');
    const transition = advanceCampaignSave(save, 'loss');
    expect(save.node).toBe('canon-enyo-defense');
    expect(save.seriesScore).toBe(-2);
    expect(save.campaignHistory).toHaveLength(1);
    expect(save.statistics.campaignLosses).toBe(1);
    expect(save.statistics.retreatCount).toBe(1);
    expect(transition.nextNode).toBe(save.node);
  });

  it('canon/expanded の全ノードは勝敗のどちらからも終端へ到達できる', () => {
    for (const [mode, graph] of [['canon', CANON_CAMPAIGN], ['expanded', CAMPAIGN]] as const) {
      for (const id of Object.keys(graph)) {
        for (const outcome of ['win', 'loss'] as const) {
          let node = id;
          for (let i = 0; i < 20 && node !== VICTORY && node !== DEFEAT; i++) node = advance(node, outcome, mode);
          expect(node === VICTORY || node === DEFEAT, `${mode}/${id}/${outcome}`).toBe(true);
        }
      }
    }
  });

  it('シリーズ勝敗統計は route と mode を保持する', () => {
    const stats = newStatistics();
    recordCampaignOutcome(stats, { mode: 'canon', node: CANON_CAMPAIGN_START, outcome: 'win', points: 2, route: 'advance' });
    expect(stats.seriesScore).toBe(2);
    expect(stats.campaignModes.canon).toBe(1);
    expect(stats.campaignNodes[CANON_CAMPAIGN_START]).toEqual({ wins: 1, losses: 0 });
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
