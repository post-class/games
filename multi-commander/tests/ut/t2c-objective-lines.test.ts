import { describe, expect, it } from 'vitest';
import {
  buildObjectiveLines,
  formatTimeLeft,
  objectiveMark,
  OBJECTIVE_LINE_LIMIT,
  type ObjectiveView,
} from '../../src/hud/objectiveLines';
import { warningText } from '../../src/hud/warning';
import { hitEdgeOf, hitFaceOf, HIT_EDGE_LABEL } from '../../src/hud/hitDirection';
import { clampLabel, estimateLabelHalfWidth } from '../../src/hud/project';
import { hudObjectiveViews } from '../../src/app/game';

/**
 * T2-⑧ / T2-⑨ の組み立て部分。
 *
 * DOM を使わずに検証できるところ（3行への絞り込み・警告の2行化・被弾方向の判定・
 * 画面端のラベル押し戻し）をここで固定する。
 */

const view = (text: string, over: Partial<ObjectiveView> = {}): ObjectiveView => ({
  text,
  state: 'active',
  ...over,
});

/** 実機で見た構成（必須4件・加点3件・タイマー4本） */
function sevenObjectives(): ObjectiveView[] {
  return [
    view('輸送船を帰投航路に乗せる'),
    view('〈アストラ・メイ〉を守る'),
    view('隔壁を保つ — 残り 240s', { timeLeftSec: 240 }),
    view('自機で帰投する'),
    view('＋帰還者3 … 救助艇を回収する — 残り 90s', { required: false, timeLeftSec: 90 }),
    view('＋整備点2 … 敵補給艇を止める — 残り 30s', { required: false, timeLeftSec: 30 }),
    view('＋情報1 … 通信塔を偵察する — 残り 300s', { required: false, timeLeftSec: 300 }),
  ];
}

describe('T2-⑧ 目標の常時表示は3行まで', () => {
  it('7項目・タイマー4本でも3行を超えない', () => {
    const lines = buildObjectiveLines(sevenObjectives(), view('前哨を撃破した', { state: 'done' }));
    expect(lines.length).toBe(OBJECTIVE_LINE_LIMIT);
    expect(lines.map((l) => l.role)).toEqual(['focus', 'timer', 'recent']);
  });

  it('1行目は「いま追うべき必須目標」で、時間を待つだけの目標は選ばない', () => {
    const lines = buildObjectiveLines(sevenObjectives());
    expect(lines[0].role).toBe('focus');
    expect(lines[0].text).toBe('輸送船を帰投航路に乗せる');
    expect(lines[0].required).toBe(true);
  });

  it('2行目は一番差し迫った制限時間だけを出し、残りは件数で示す', () => {
    const lines = buildObjectiveLines(sevenObjectives());
    const timer = lines.find((l) => l.role === 'timer')!;
    expect(timer.timeLeftSec).toBe(30);
    // タイマー4本のうち1本を出し、他3件と示す
    expect(timer.others).toBe(3);
  });

  it('3行目は達成した直近1件（渡されなければ行を作らない）', () => {
    const withRecent = buildObjectiveLines(sevenObjectives(), view('救助艇を回収した', { state: 'done' }));
    expect(withRecent[2]).toMatchObject({ role: 'recent', state: 'done', text: '救助艇を回収した' });
    const withoutRecent = buildObjectiveLines(sevenObjectives());
    expect(withoutRecent.some((l) => l.role === 'recent')).toBe(false);
  });

  it('必須が残っていなければ加点目標を追う（必須ゼロで空にしない）', () => {
    const lines = buildObjectiveLines([
      view('輸送船を帰投航路に乗せる', { state: 'done' }),
      view('＋帰還者3 … 救助艇を回収する', { required: false }),
    ]);
    expect(lines[0].text).toContain('救助艇');
    expect(lines[0].required).toBe(false);
  });

  it('記号は達成 ✓ / 失敗 ✖ / 進行中 ▸ を維持する', () => {
    expect(objectiveMark('done')).toBe('✓');
    expect(objectiveMark('failed')).toBe('✖');
    expect(objectiveMark('active')).toBe('▸');
  });

  it('残り時間は 60 秒以上で m:ss にする', () => {
    expect(formatTimeLeft(42.2)).toBe('43s');
    expect(formatTimeLeft(90)).toBe('1:30');
    expect(formatTimeLeft(-5)).toBe('0s');
  });
});

describe('T2-⑧ 必須/加点と残り秒は MissionRunner が構造で渡す', () => {
  /*
   * 以前は `hudObjectiveViews` が表示文から逆算していた
   * （加点表記の区切り記号で必須/加点を判定し、`残り 42s` を正規表現で抜く）。
   * 表示文を1文字変えると判定が黙って壊るので、`MissionRunner.objectiveViews()` が
   * `required` / `timeLeftSec` を返す形に変え、ここは素通しにした。
   * このテストは「表示文から逆算していない」ことを固定する。
   */
  it('渡された required / timeLeftSec をそのまま通す', () => {
    const out = hudObjectiveViews([
      { text: '輸送船を帰投航路に乗せる', state: 'active', required: true },
      { text: '＋帰還者3 … 救助艇を回収する — 残り 90s', state: 'active', required: false, timeLeftSec: 90 },
    ]);
    expect(out[0].required).toBe(true);
    expect(out[0].timeLeftSec).toBeUndefined();
    expect(out[1].required).toBe(false);
    expect(out[1].timeLeftSec).toBe(90);
  });

  it('表示文から逆算しない（加点表記が付いていても required の指定に従う）', () => {
    // 表示は加点表記だが required: true と渡された、というありえない組み合わせ。
    // 逆算していれば false になる。素通しなら true のまま。
    const out = hudObjectiveViews([
      { text: '＋帰還者3 … 救助艇を回収する — 残り 90s', state: 'active', required: true },
    ]);
    expect(out[0].required).toBe(true);
    // 文中に「残り 90s」があっても、指定が無ければ残り秒は持たない
    expect(out[0].timeLeftSec).toBeUndefined();
  });

  it('加点表記そのものは組み立て直さず、渡された文字列をそのまま保つ', () => {
    const out = hudObjectiveViews([{ text: '＋帰還者3 … 救助艇を回収する', state: 'active' }]);
    expect(out[0].text).toBe('＋帰還者3 … 救助艇を回収する');
  });
});

describe('T2-⑧ 警告は「何が起きたか」＋「どうするか」の2行', () => {
  it('安全窓が閉じたら、何をすべきかが2行目に付く', () => {
    const w = warningText('安全窓が閉じた');
    expect(w.what).toBe('安全窓が閉じた');
    expect(w.how).toBe('発砲すると共鳴パルスが止まる');
  });

  it('岩の衝突警報にも指示が付く', () => {
    expect(warningText('衝突警報 — 進路上に岩').how).toBe('進路を変えるか減速する');
  });

  it('言い換え表を通した文も2行に割れる', () => {
    const w = warningText('ロックしていない');
    expect(w.what).toBe('発射不可');
    expect(w.how).toBe('ロック未完了');
  });

  it('対応表にも区切りにも当てはまらない文は1行のまま', () => {
    const w = warningText('ナビポイント到達');
    expect(w.what).toBe('ナビポイント到達');
    expect(w.how).toBe('');
  });
});

describe('T2-⑨ 被弾方向の判定', () => {
  it('左右上下を機体ローカル座標から決める', () => {
    expect(hitEdgeOf({ x: -100, y: 5, z: 0 })).toBe('left');
    expect(hitEdgeOf({ x: 100, y: -5, z: 0 })).toBe('right');
    expect(hitEdgeOf({ x: 3, y: 90, z: 0 })).toBe('top');
    expect(hitEdgeOf({ x: -3, y: -90, z: 0 })).toBe('bottom');
  });

  it('真後ろからの被弾は下端、真正面は上端にする', () => {
    expect(hitEdgeOf({ x: 0, y: 0, z: 40 })).toBe('bottom');
    expect(hitEdgeOf({ x: 0, y: 0, z: -40 })).toBe('top');
  });

  it('装甲図の面は前後と左右で分ける', () => {
    expect(hitFaceOf({ x: 0, y: 0, z: -30 })).toBe('front');
    expect(hitFaceOf({ x: 0, y: 0, z: 30 })).toBe('rear');
    expect(hitFaceOf({ x: -30, y: 0, z: 4 })).toBe('left');
    expect(hitFaceOf({ x: 30, y: 0, z: -4 })).toBe('right');
  });

  it('方向には日本語の呼び名がある（文字で残すため）', () => {
    expect(HIT_EDGE_LABEL.left).toBe('左');
    expect(HIT_EDGE_LABEL.bottom).toBe('下');
  });
});

describe('T2-⑧ 画面端のラベルが切れない', () => {
  it('x=0 のラベルを画面内へ押し戻す', () => {
    const text = '◇ 発艦点 2.6k';
    const half = estimateLabelHalfWidth(text);
    const c = clampLabel({ x: 0, y: 360 }, 1280, 720, half, 9);
    expect(c.x).toBeGreaterThanOrEqual(half);
    expect(c.x - half).toBeGreaterThanOrEqual(0);
  });

  it('右端・上端・下端も内側へ寄せる', () => {
    const half = estimateLabelHalfWidth('◇ 発艦点 2.6k');
    expect(clampLabel({ x: 1280, y: 360 }, 1280, 720, half, 9).x).toBeLessThanOrEqual(1280 - half);
    expect(clampLabel({ x: 640, y: 0 }, 1280, 720, half, 9).y).toBeGreaterThanOrEqual(9);
    expect(clampLabel({ x: 640, y: 720 }, 1280, 720, half, 9).y).toBeLessThanOrEqual(720 - 9);
  });

  it('開口部の枠を渡すと、その内側に収める', () => {
    const rect = { left: 220, right: 1060, top: 90, bottom: 560 };
    const c = clampLabel({ x: 230, y: 95 }, 1280, 720, 60, 9, rect);
    expect(c.x).toBeGreaterThanOrEqual(rect.left + 60);
    expect(c.y).toBeGreaterThanOrEqual(rect.top + 9);
  });

  it('画面内のラベルは動かさない', () => {
    const c = clampLabel({ x: 640, y: 360 }, 1280, 720, 60, 9);
    expect(c).toEqual({ x: 640, y: 360 });
  });
});
