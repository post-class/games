import { describe, expect, it } from 'vitest';
import { MISSIONS } from '../../src/content/missions';
import { VEIL_MISSION_LIST } from '../../src/content/veil/missions';
import { dynamicMissionDef, FRONTLINE_SYSTEM_IDS } from '../../src/content/frontline';
import { RECOVERY_HOLD_SECONDS, RECOVERY_REL_SPEED } from '../../src/sim/recovery';
import type { MissionDef, ObjectiveDef } from '../../src/mission/types';

/**
 * T4-⑮ の副作用を止めるためのテスト。
 *
 * 収容は「半径に入れば自動」から「近づいて減速し数秒保つ」へ変わった。
 * そのとき **目標文を書き換え忘れた定義が1つ残る**（`frontline.ts` の捜索救難が
 * 「生存者を回収」のままだった）という事故が実際に起きた。
 *
 * `AI_CODING.md`「表示だけ変えて実挙動が変わらない状態を作らない」の逆パターン
 * ＝実挙動を変えて表示を取り残す事故なので、**全ミッションを機械的に見る**。
 */

/** 動的作戦を含めた、ゲーム中に出るすべてのミッション定義。 */
function allMissionDefs(): MissionDef[] {
  const defs: MissionDef[] = [...Object.values(MISSIONS), ...VEIL_MISSION_LIST];
  // 動的作戦は生成物なので、全戦域 × 全種目ぶんを作って見る
  const kinds = ['patrol', 'escort', 'strike', 'rescue', 'quiet', 'capital'] as const;
  for (const system of FRONTLINE_SYSTEM_IDS) {
    for (const kind of kinds) {
      const def = dynamicMissionDef({
        id: `dyn-${system}-${kind}`,
        system,
        kind,
        seed: 1,
        returnNode: 'veil-ch01',
      });
      if (def) defs.push(def);
    }
  }
  return defs;
}

function rescueObjectives(def: MissionDef): ObjectiveDef[] {
  return def.objectives.filter((o) => o.spec.kind === 'rescue');
}

describe('T4-⑮ 収容の目標文が操作を書いている', () => {
  const defs = allMissionDefs();

  it('rescue 目標を持つミッションが複数あること（テスト自体が空振りしていない）', () => {
    const withRescue = defs.filter((d) => rescueObjectives(d).length > 0);
    expect(withRescue.length).toBeGreaterThan(3);
  });

  /*
   * 動詞は章の文脈に合わせて変えてよい
   * （ch05「決闘の相手を生きたまま持ち帰る」/ ch08「帝国側の救難信号に応じる」）。
   * 揃えるのは**操作が書かれていること**だけ ——「減速」と「保持秒数」。
   * 「生存者を回収」のように操作が書かれていない文が入ったら落ちる。
   */
  it('すべての rescue 目標文が操作（減速と保持秒数）を書いている', () => {
    const bad: string[] = [];
    for (const def of defs) {
      for (const o of rescueObjectives(def)) {
        const text = o.text;
        const holdSec = o.spec.kind === 'rescue' ? (o.spec.holdSeconds ?? RECOVERY_HOLD_SECONDS) : 0;
        const hasHold = text.includes(`${holdSec}秒`) || text.includes(`${holdSec}s`);
        const hasSlowDown = text.includes('減速');
        if (!hasHold || !hasSlowDown) bad.push(`${def.id} / ${o.id}: ${text}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('目標文に書いた距離が spec.radius と一致する', () => {
    const bad: string[] = [];
    for (const def of defs) {
      for (const o of rescueObjectives(def)) {
        if (o.spec.kind !== 'rescue') continue;
        const radius = o.spec.radius;
        if (radius === undefined) continue;
        // 「300m 以内」のような表記を拾う
        const m = /(\d+)\s*m/.exec(o.text);
        if (!m) {
          bad.push(`${def.id} / ${o.id}: 距離が書かれていない — ${o.text}`);
          continue;
        }
        if (Number(m[1]) !== radius) {
          bad.push(`${def.id} / ${o.id}: 文 ${m[1]}m ≠ spec ${radius}m`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('保持秒数を独自指定した目標は、その値を文に書いている', () => {
    const bad: string[] = [];
    for (const def of defs) {
      for (const o of rescueObjectives(def)) {
        if (o.spec.kind !== 'rescue' || o.spec.holdSeconds === undefined) continue;
        if (!o.text.includes(`${o.spec.holdSeconds}秒`)) {
          bad.push(`${def.id} / ${o.id}: 独自の holdSeconds ${o.spec.holdSeconds} が文に無い`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('相対速度の条件は全ミッション共通なので、文に個別の数値を書いていない', () => {
    // 速度条件だけは目標文に書かず HUD が出す（章ごとに変えていないため）。
    // ここに数値が現れ始めたら、条件を変えたときに取り残される。
    const bad: string[] = [];
    for (const def of defs) {
      for (const o of rescueObjectives(def)) {
        if (o.text.includes(`${RECOVERY_REL_SPEED}m/s`)) bad.push(`${def.id} / ${o.id}`);
      }
    }
    expect(bad).toEqual([]);
  });
});

/**
 * 加点表記（`reward`）を付けてよい範囲。
 *
 * 4状態（帰還者・航路信頼・軍令信用・敵エースの誓約）は **veil 限定**で、
 * `App.applySortieToNarrative()` は `campaignMode === 'veil'` のときしか呼ばれない。
 * したがって canon / expanded / 動的作戦の任意目標に `＋航路信頼` などと書くと、
 * **実際には動かない状態を表示する**ことになる（`(任意)` のままが正しい）。
 *
 * 「全章に reward を付けた」作業を canon 側へ広げてしまう事故を止めるためのテスト。
 */
describe('加点表記は veil 限定である', () => {
  const NARRATIVE_WORDS = ['帰還者', '航路信頼', '軍令信用', '敵エースの誓約'];

  it('veil の任意目標にはすべて reward が付いている', () => {
    const bad: string[] = [];
    for (const def of VEIL_MISSION_LIST) {
      for (const o of def.objectives) {
        if (o.required) continue;
        if (!o.reward) bad.push(`${def.id} / ${o.id}: ${o.text}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('veil の reward は4状態のいずれかの名前を含む', () => {
    const bad: string[] = [];
    for (const def of VEIL_MISSION_LIST) {
      for (const o of def.objectives) {
        if (!o.reward) continue;
        if (!NARRATIVE_WORDS.some((w) => o.reward!.includes(w))) {
          bad.push(`${def.id} / ${o.id}: ${o.reward}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('canon / expanded / 動的作戦には reward を付けない（動かない状態を表示しないため）', () => {
    const veilIds = new Set(VEIL_MISSION_LIST.map((d) => d.id));
    const bad: string[] = [];
    for (const def of allMissionDefs()) {
      if (veilIds.has(def.id)) continue;
      for (const o of def.objectives) {
        if (o.reward) bad.push(`${def.id} / ${o.id}: ${o.reward}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
