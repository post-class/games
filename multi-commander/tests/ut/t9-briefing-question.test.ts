import { describe, expect, it } from 'vitest';
import {
  briefingQuestion,
  briefingReply,
  type BriefingStance,
} from '../../src/content/briefingQuestions';
import { PERSONALITIES, PILOTS, type PersonalityId } from '../../src/content/pilots';

/**
 * ブリーフィングの質疑（`src/content/briefingQuestions.ts`）の素材テスト。
 *
 * この一幕は**数値を動かさない**約束なので、検証するのは
 * 「全性格 × 全姿勢で台詞が埋まっているか」と「文面が使い回しでないか」。
 */

const PERSONALITY_IDS = Object.keys(PERSONALITIES) as PersonalityId[];
const STANCES: BriefingStance[] = ['orders', 'lives', 'kills'];

describe('ブリーフィングの質疑', () => {
  it('全性格に質問がある（僚機は必ず一つ訊く）', () => {
    for (const id of PERSONALITY_IDS) {
      const q = briefingQuestion(id);
      expect(q.text.length).toBeGreaterThan(4);
      expect(q.answers).toHaveLength(STANCES.length);
      expect(q.answers.map((a) => a.stance).sort()).toEqual([...STANCES].sort());
      for (const a of q.answers) expect(a.label.length).toBeGreaterThan(4);
    }
  });

  it('質問文は性格ごとに違う（使い回しにしない）', () => {
    const texts = PERSONALITY_IDS.map((id) => briefingQuestion(id).text);
    expect(new Set(texts).size).toBe(texts.length);
  });

  it('全性格 × 全姿勢に返しがあり、同じ性格の中で返しが重複しない', () => {
    for (const id of PERSONALITY_IDS) {
      const replies = STANCES.map((stance) => briefingReply(id, stance));
      for (const r of replies) expect(r.length).toBeGreaterThan(4);
      expect(new Set(replies).size).toBe(replies.length);
    }
  });

  it('飛行隊の全員が質疑の素材を持つ（僚機に選ばれても空にならない）', () => {
    for (const pilot of PILOTS) {
      expect(briefingQuestion(pilot.personality).text).toBeTruthy();
      for (const stance of STANCES) {
        expect(briefingReply(pilot.personality, stance)).toBeTruthy();
      }
    }
  });

  it('答えの選択肢は全性格で同じ（隊長の方針表明なので言い方を変えない）', () => {
    const first = briefingQuestion('steady').answers.map((a) => a.label);
    for (const id of PERSONALITY_IDS) {
      expect(briefingQuestion(id).answers.map((a) => a.label)).toEqual(first);
    }
  });
});
