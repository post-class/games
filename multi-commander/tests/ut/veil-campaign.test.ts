import { describe, it, expect } from 'vitest';
import {
  VEIL_CAMPAIGN,
  VEIL_CAMPAIGN_START,
  VEIL_TOTAL_CHAPTERS,
  VICTORY,
  DEFEAT,
  campaignGraph,
  campaignStart,
  campaignMap,
  campaignNode,
  hasCampaignNode,
  totalChapters,
  newCampaignProgress,
  resolveCampaignOutcome,
  previewCampaignOutcome,
  reachableCampaignNodes,
  gateOutcomeFromChoice,
  isGateOutcome,
  type CampaignNodeId,
} from '../../src/content/campaign';
import { VEIL_CHAPTERS, veilChapter } from '../../src/content/veil/chapters';

describe('veil キャンペーンの構造', () => {
  it('10ノードで、idは veil-ch01〜veil-ch10', () => {
    const ids = Object.keys(VEIL_CAMPAIGN);
    expect(ids).toHaveLength(10);
    expect(ids).toEqual(VEIL_CHAPTERS.map((c) => c.id));
    for (const [id, node] of Object.entries(VEIL_CAMPAIGN)) {
      expect(node.missionId).toBe(id);
    }
  });

  it('veil-ch01 から onWin を辿ると10章を経て VICTORY に到達する', () => {
    const visited: CampaignNodeId[] = [];
    let current: CampaignNodeId = VEIL_CAMPAIGN_START;
    while (current !== VICTORY && visited.length < 20) {
      visited.push(current);
      current = campaignNode(current).onWin;
    }
    expect(visited).toHaveLength(10);
    expect(visited[0]).toBe('veil-ch01');
    expect(visited[9]).toBe('veil-ch10');
    expect(current).toBe(VICTORY);
  });

  it('各ノードの chapter が 1..10 で重複しない', () => {
    const chapters = Object.values(VEIL_CAMPAIGN).map((n) => n.chapter).sort((a, b) => a - b);
    expect(chapters).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('敗北でも次章へ進む（第10章以外の onLoss は DEFEAT ではない）', () => {
    for (const node of Object.values(VEIL_CAMPAIGN)) {
      if (node.chapter === 10) {
        expect(node.onLoss).toBe(DEFEAT);
        continue;
      }
      expect(node.onLoss).not.toBe(DEFEAT);
      expect(node.onLoss).toBe(node.onWin);
      expect(node.onLossRoute).toBe('hold');
    }
  });

  it('敗北を10回続けても最終的に DEFEAT へ落ちる（章は増えない）', () => {
    const progress = newCampaignProgress();
    const nodes: CampaignNodeId[] = [];
    for (let i = 0; i < 10; i += 1) {
      nodes.push(progress.currentNode);
      resolveCampaignOutcome(progress, 'loss');
    }
    expect(nodes).toEqual(VEIL_CHAPTERS.map((c) => c.id));
    expect(progress.currentNode).toBe(DEFEAT);
    expect(progress.score).toBeLessThan(0);
  });

  it('表示文は VEIL_CHAPTERS の値から生成されている（二重定義していない）', () => {
    for (const node of Object.values(VEIL_CAMPAIGN)) {
      const chapter = veilChapter(node.chapter);
      expect(node.series).toBe(chapter.operation);
      expect(node.seriesName).toBe(chapter.operation);
      expect(node.system).toBe(chapter.theaterName);
      expect(node.victoryCondition).toBe(chapter.objective);
      expect(node.defeatCondition).toContain(chapter.objective);
      expect(node.situation).toContain(chapter.tagline);
      expect(node.situation).toContain(chapter.operation);
      expect(node.winSituation).toContain(chapter.objective);
      expect(node.lossSituation).toContain(chapter.objective);
    }
  });

  it('missionType が章の性格に対応する', () => {
    const expected = ['rescue', 'recon', 'escort', 'rescue', 'intercept', 'strike', 'escort', 'defense', 'recon', 'capital'];
    expect(VEIL_CHAPTERS.map((c) => VEIL_CAMPAIGN[c.id].missionType)).toEqual(expected);
  });
});

/**
 * 戦役は THE VEIL FRONT だけなので、公開 API はモード引数を取らない。
 * 引数を復活させないための回帰でもある。
 */
describe('戦役 API は十章だけを返す', () => {
  it('totalChapters / campaignStart / campaignGraph が十章を指す', () => {
    expect(totalChapters()).toBe(10);
    expect(campaignStart()).toBe('veil-ch01');
    expect(campaignGraph()).toBe(VEIL_CAMPAIGN);
    expect(VEIL_TOTAL_CHAPTERS).toBe(10);
    expect(hasCampaignNode('veil-ch05')).toBe(true);
    // 削除した旧キャンペーンのノードは存在しない
    expect(hasCampaignNode('m1-patrol')).toBe(false);
    expect(hasCampaignNode('canon-enyo-patrol')).toBe(false);
  });

  it('共通ロジックがそのまま動く', () => {
    expect(() => campaignMap('veil-ch01', [])).not.toThrow();
    const map = campaignMap('veil-ch01', []);
    expect(map.find((item) => item.id === 'veil-ch01')?.status).toBe('current');
    expect(map.find((item) => item.id === 'veil-ch02')?.status).toBe('reachable');

    const progress = newCampaignProgress();
    const preview = previewCampaignOutcome(progress, 'win');
    expect(preview.nextNode).toBe('veil-ch02');
    expect(progress.currentNode).toBe('veil-ch01');

    expect(reachableCampaignNodes('veil-ch01')).toHaveLength(10);

    const last = newCampaignProgress();
    last.currentNode = 'veil-ch10';
    const win = resolveCampaignOutcome(last, 'win');
    expect(win.nextNode).toBe(VICTORY);
    expect(win.terminal).toBe(true);
  });
});

describe('GateOutcome', () => {
  it('第10章の選択肢idから門の管理方法へ変換できる', () => {
    expect(gateOutcomeFromChoice('seal-gate')).toBe('closed');
    expect(gateOutcomeFromChoice('limited-open')).toBe('limited-open');
    expect(gateOutcomeFromChoice('joint-custody')).toBe('joint-custody');
    expect(() => gateOutcomeFromChoice('unknown')).toThrow();
  });

  it('chapters.ts の第10章選択肢を網羅している', () => {
    const options = veilChapter(10).choice.options.map((o) => o.id);
    expect(options).toHaveLength(3);
    for (const id of options) expect(isGateOutcome(gateOutcomeFromChoice(id))).toBe(true);
  });
});
