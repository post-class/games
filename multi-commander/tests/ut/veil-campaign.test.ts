import { describe, it, expect } from 'vitest';
import {
  VEIL_CAMPAIGN,
  VEIL_CAMPAIGN_START,
  VEIL_TOTAL_CHAPTERS,
  CAMPAIGN,
  CANON_CAMPAIGN,
  CAMPAIGN_START,
  VICTORY,
  DEFEAT,
  campaignGraph,
  campaignStart,
  campaignMap,
  campaignNode,
  hasCampaignNode,
  isCampaignMode,
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
      expect(node.dialogueKey).toBe(id);
    }
  });

  it('veil-ch01 から onWin を辿ると10章を経て VICTORY に到達する', () => {
    const visited: CampaignNodeId[] = [];
    let current: CampaignNodeId = VEIL_CAMPAIGN_START;
    while (current !== VICTORY && visited.length < 20) {
      visited.push(current);
      current = campaignNode(current, 'veil').onWin;
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
      expect(node.losingRoute).toBeUndefined();
    }
  });

  it('敗北を10回続けても最終的に DEFEAT へ落ちる（章は増えない）', () => {
    const progress = newCampaignProgress('veil');
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

describe('veil モードの API 対応', () => {
  it('isCampaignMode が veil を受ける', () => {
    expect(isCampaignMode('veil')).toBe(true);
    expect(isCampaignMode('canon')).toBe(true);
    expect(isCampaignMode('expanded')).toBe(true);
    expect(isCampaignMode('other')).toBe(false);
  });

  it('totalChapters / campaignStart / campaignGraph が veil に対応する', () => {
    expect(totalChapters('veil')).toBe(10);
    expect(campaignStart('veil')).toBe('veil-ch01');
    expect(campaignGraph('veil')).toBe(VEIL_CAMPAIGN);
    expect(VEIL_TOTAL_CHAPTERS).toBe(10);
    expect(hasCampaignNode('veil-ch05', 'veil')).toBe(true);
    expect(hasCampaignNode('m1-patrol', 'veil')).toBe(false);
  });

  it('共通ロジックが veil でもそのまま動く', () => {
    expect(() => campaignMap('veil', 'veil-ch01', [])).not.toThrow();
    const map = campaignMap('veil', 'veil-ch01', []);
    expect(map.find((item) => item.id === 'veil-ch01')?.status).toBe('current');
    expect(map.find((item) => item.id === 'veil-ch02')?.status).toBe('reachable');

    const progress = newCampaignProgress('veil');
    const preview = previewCampaignOutcome(progress, 'win');
    expect(preview.nextNode).toBe('veil-ch02');
    expect(progress.currentNode).toBe('veil-ch01');

    expect(reachableCampaignNodes('veil-ch01', 'veil')).toHaveLength(10);

    const last = newCampaignProgress('veil');
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

describe('既存モードの回帰', () => {
  it('canon / expanded の章数とノード数が変わらない', () => {
    expect(totalChapters('canon')).toBe(7);
    expect(totalChapters('expanded')).toBe(9);
    expect(totalChapters()).toBe(9);
    expect(Object.keys(CANON_CAMPAIGN)).toHaveLength(7);
    // expanded は本線9ノード + 敗北ルート2ノード = 11
    expect(Object.keys(CAMPAIGN)).toHaveLength(11);
  });

  it('既定モードは expanded のまま', () => {
    expect(campaignStart('expanded')).toBe('m1-patrol');
    expect(campaignStart()).toBe(CAMPAIGN_START);
    expect(campaignGraph()).toBe(CAMPAIGN);
    expect(newCampaignProgress().mode).toBe('expanded');
  });

  it('expanded の分岐（敗北ルート）が残っている', () => {
    expect(CAMPAIGN['m1-patrol'].onLoss).toBe('l1-retreat');
    expect(CAMPAIGN['l2-last-stand'].losingRoute).toBe(true);
    expect(CAMPAIGN['m6-flagship'].onWin).toBe(VICTORY);
    expect(CANON_CAMPAIGN['canon-gateway-intercept'].onWin).toBe(VICTORY);
    expect(CANON_CAMPAIGN['canon-enyo-defense'].onLoss).toBe(DEFEAT);
  });
});
