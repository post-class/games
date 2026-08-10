import { describe, expect, it } from 'vitest';
import {
  BAR_TALK_ROUNDS,
  barReplyBond,
  barTalkTopic,
  buildBarTalk,
  chooseBarReply,
  newBarTalk,
  type BarTalkFacts,
  type BarTalkState,
} from '../../src/app/barTalk';
import {
  applySortie,
  newRoster,
  normalizeRoster,
  pilotState,
  relationStage,
  shiftBond,
  type PilotState,
} from '../../src/app/roster';
import type { PersonalityId } from '../../src/content/pilots';

/**
 * T3-⑪ 酒場の会話を2往復にする。
 *
 * 検証するのは「往復があること」「返事で bond が動き、関係の段階が変わること」
 * 「直前の出撃結果で会話の中身が変わること」。台詞そのものの良さは検証しない。
 */

function pilot(over: Partial<PilotState> = {}): PilotState {
  return {
    id: 'sable',
    status: 'active',
    skill: 0.6,
    kills: 0,
    sorties: 3,
    benchedFor: 0,
    bond: 0,
    rank: 0,
    transfers: 0,
    ...over,
  };
}

const personality: PersonalityId = 'steady';

function view(p: PilotState, facts: BarTalkFacts = {}, state?: BarTalkState) {
  return buildBarTalk({ pilot: p, personality, facts, state });
}

/** 返事を順に選んで、最後の状態と bond の合計変化を返す */
function play(p: PilotState, facts: BarTalkFacts, ids: string[]) {
  let state = newBarTalk(p.id);
  let applied = 0;
  for (const id of ids) {
    const result = chooseBarReply({ pilot: p, personality, facts, state }, id);
    state = result.state;
    applied += shiftBond(p, result.bondDelta);
  }
  return { state, applied, view: view(p, facts, state) };
}

describe('T3-⑪ 酒場の往復会話', () => {
  it('会話は最初に近況1行で始まり、返事の選択肢が2つ出る', () => {
    const v = view(pilot());
    expect(v.pilotId).toBe('sable');
    expect(v.turns).toHaveLength(1);
    expect(v.turns[0].speaker).toBe('pilot');
    expect(v.turns[0].text.length).toBeGreaterThan(0);
    expect(v.replies).toHaveLength(2);
    // 返事の文は空にしない（描画側がそのままボタンの文字にする）
    for (const reply of v.replies) expect(reply.label.length).toBeGreaterThan(0);
    expect(new Set(v.replies.map((r) => r.id)).size).toBe(2);
  });

  it('返事を選ぶと2往復ぶん進み、2往復目まで選択肢が2つ出て、最後は空になる', () => {
    const p = pilot();
    const facts: BarTalkFacts = { flewWithPlayer: true };
    const first = play(p, facts, ['r1-warm']);
    // 近況 → こちらの返事 → 相手の反応
    expect(first.view.turns.map((t) => t.speaker)).toEqual(['pilot', 'player', 'pilot']);
    expect(first.view.replies).toHaveLength(2);

    const second = play(pilot(), facts, ['r1-warm', 'r2-warm']);
    expect(second.view.turns.map((t) => t.speaker)).toEqual(['pilot', 'player', 'pilot', 'player', 'pilot']);
    // 空配列なら会話終了（受け渡しの規約）
    expect(second.view.replies).toEqual([]);
    expect(BAR_TALK_ROUNDS).toBe(2);
  });

  it('選んだ返事の文が、そのままプレイヤーの発言として会話に残る', () => {
    const p = pilot();
    const before = view(p, { flewWithPlayer: true });
    const warm = before.replies.find((r) => r.id === 'r1-warm')!;
    const after = play(p, { flewWithPlayer: true }, [warm.id]);
    expect(after.view.turns[1]).toEqual({ speaker: 'player', text: warm.label });
  });

  it('返事の選択で bond が動き、関係の段階（label）が変わる', () => {
    // 顔見知り (bond 0.2) → 労う返事2回で 信頼 へ
    const warm = pilot({ bond: 0.2 });
    expect(view(warm).relation.label).toBe('顔見知り');
    const warmResult = play(warm, { flewWithPlayer: true }, ['r1-warm', 'r2-warm']);
    expect(warmResult.applied).toBeGreaterThan(0);
    expect(warm.bond).toBeGreaterThan(0.2);
    expect(warmResult.view.relation.label).toBe('信頼');
    expect(warmResult.view.relation.step).toBe(3);
    expect(warmResult.view.relation.max).toBe(4);

    // 突き放す返事では下がる（話しかければ必ず上がる、にはしない）
    const cold = pilot({ bond: 0.14 });
    const coldResult = play(cold, { flewWithPlayer: true }, ['r1-blunt', 'r2-blunt']);
    expect(coldResult.applied).toBeLessThan(0);
    expect(cold.bond).toBeLessThan(0.14);
    expect(coldResult.view.relation.label).toBe('顔見知り');
  });

  it('見捨てた直後は、謝るかどうかで bond の動きが大きい', () => {
    const apologise = barReplyBond('silent', 1, 'warm');
    const excuse = barReplyBond('silent', 1, 'blunt');
    expect(apologise).toBeGreaterThan(barReplyBond('flown', 1, 'warm'));
    expect(excuse).toBeLessThan(barReplyBond('flown', 1, 'blunt'));
    // 2往復目は1往復目より小さい（最初の返事が主役）
    expect(barReplyBond('silent', 2, 'warm')).toBeLessThan(apologise);
  });

  it('関係の段階は5段階で、bond の昇順に並ぶ', () => {
    const steps = [-0.5, -0.1, 0.2, 0.4, 0.8].map((bond) => relationStage({ bond, sorties: 3 }));
    expect(steps.map((s) => s.label)).toEqual(['不信', '顔見知り', '顔見知り', '信頼', '盟友']);
    expect(steps.map((s) => s.step)).toEqual([0, 2, 2, 3, 4]);
    // 一度も一緒に飛んでいない相手は「初対面」
    expect(relationStage({ bond: 0, sorties: 0 }).label).toBe('初対面');
  });

  it('直前の出撃で助けたか見捨てたかで、会話の中身が変わる', () => {
    const helped = view(pilot(), { flewWithPlayer: true, rescued: true });
    const left = view(pilot(), { flewWithPlayer: true, abandoned: true });
    const plain = view(pilot(), { flewWithPlayer: true });

    expect(helped.turns[0].text).not.toBe(left.turns[0].text);
    expect(helped.turns[0].text).not.toBe(plain.turns[0].text);
    // 「助けた／見捨てた／特筆なし」の3系統は、どの性格・どの揺らぎでも混ざらない
    const openings = (facts: BarTalkFacts) =>
      new Set(
        (['reckless', 'steady', 'precise', 'veteran', 'grim', 'green'] as PersonalityId[]).flatMap((id) =>
          [0, 1, 2].map((n) => buildBarTalk({ pilot: pilot({ sorties: n }), personality: id, facts }).turns[0].text),
        ),
      );
    const thanksLines = openings({ flewWithPlayer: true, rescued: true });
    const silentLines = openings({ flewWithPlayer: true, abandoned: true });
    const plainLines = openings({ flewWithPlayer: true });
    for (const line of thanksLines) {
      expect(silentLines.has(line)).toBe(false);
      expect(plainLines.has(line)).toBe(false);
    }
    // 返事の2択も話題に噛み合って変わる
    expect(helped.replies.map((r) => r.label)).not.toEqual(left.replies.map((r) => r.label));

    expect(barTalkTopic(pilot(), { flewWithPlayer: true, rescued: true })).toBe('thanks');
    expect(barTalkTopic(pilot(), { flewWithPlayer: true, abandoned: true })).toBe('silent');
    expect(barTalkTopic(pilot(), { flewWithPlayer: true })).toBe('flown');
    expect(barTalkTopic(pilot(), {})).toBe('idle');
  });

  it('一緒に飛んでいない相手には、助けた／見捨てたの話題が出ない', () => {
    // 僚機ではなかった人に「助けてくれてありがとう」と言わせない
    expect(barTalkTopic(pilot(), { rescued: true })).not.toBe('thanks');
    expect(barTalkTopic(pilot(), { abandoned: true })).not.toBe('silent');
  });

  it('関係の段階に、直前の出撃で何が効いたかの1行が付く', () => {
    expect(view(pilot(), { flewWithPlayer: true, rescued: true }).relation.reason).toContain('応えた');
    expect(view(pilot(), { flewWithPlayer: true, abandoned: true }).relation.reason).toContain('応えなかった');
    expect(view(pilot(), {}).relation.reason).toContain('一緒に飛んでいない');
  });

  it('同じ入力なら同じ会話になる（開き直すたびに文が変わらない）', () => {
    const facts: BarTalkFacts = { flewWithPlayer: true, rescued: true };
    const a = view(pilot(), facts);
    const b = view(pilot(), facts);
    expect(a).toEqual(b);
  });

  it('順番が違う返事・不正な id は無視され、bond も動かない', () => {
    const p = pilot({ bond: 0.2 });
    const facts: BarTalkFacts = { flewWithPlayer: true };
    const skip = chooseBarReply({ pilot: p, personality, facts, state: newBarTalk(p.id) }, 'r2-warm');
    expect(skip.bondDelta).toBe(0);
    expect(skip.state.chosen).toEqual([]);
    const bogus = chooseBarReply({ pilot: p, personality, facts, state: newBarTalk(p.id) }, 'nope');
    expect(bogus.bondDelta).toBe(0);

    // 3回目の返事は受け付けない（会話は2往復で終わる）
    const done = play(p, facts, ['r1-warm', 'r2-warm']);
    const extra = chooseBarReply({ pilot: p, personality, facts, state: done.state }, 'r1-warm');
    expect(extra.bondDelta).toBe(0);
    expect(extra.finished).toBe(true);
  });

  it('bond は ±1 で止まる', () => {
    const p = pilot({ bond: 0.98 });
    const result = play(p, { flewWithPlayer: true }, ['r1-warm', 'r2-warm']);
    expect(p.bond).toBe(1);
    expect(result.view.relation.label).toBe('盟友');
  });
});

describe('T3-⑪ 会話した相手を次の出撃へ持ち越す', () => {
  it('会話済みの旗は出撃1回で降りる（酒場の効果を溜め込めない）', () => {
    const roster = newRoster();
    const first = roster.pilots[0];
    const second = roster.pilots[1];
    first.talkedSinceSortie = true;
    second.talkedSinceSortie = true;
    applySortie(roster, {
      wingmanId: first.id,
      wingmanLost: false,
      wingmanKills: 1,
      wingmanHullRatio: 0.9,
      rescued: false,
      abandoned: false,
      missionTitle: 'test',
      chapter: 1,
    });
    expect(pilotState(roster, first.id)!.talkedSinceSortie).toBe(false);
    expect(pilotState(roster, second.id)!.talkedSinceSortie).toBe(false);
  });

  it('保存データから会話済みの旗と bond を復元できる', () => {
    const roster = newRoster();
    roster.pilots[0].talkedSinceSortie = true;
    roster.pilots[0].bond = 0.42;
    const restored = normalizeRoster(JSON.parse(JSON.stringify(roster)));
    expect(restored.pilots[0].talkedSinceSortie).toBe(true);
    expect(restored.pilots[0].bond).toBeCloseTo(0.42);
    // 旗を持たない旧セーブは false になる（undefined を残さない）
    const legacy = normalizeRoster({ pilots: [{ id: roster.pilots[0].id }] });
    expect(legacy.pilots[0].talkedSinceSortie).toBe(false);
  });

  it('bond は出撃でも動くので、会話と出撃の両方が同じ段階表示に効く', () => {
    const roster = newRoster();
    const id = roster.pilots[0].id;
    const before = relationStage(pilotState(roster, id)!);
    applySortie(roster, {
      wingmanId: id,
      wingmanLost: false,
      wingmanKills: 0,
      wingmanHullRatio: 1,
      rescued: true,
      abandoned: false,
      missionTitle: 'test',
      chapter: 1,
    });
    const after = relationStage(pilotState(roster, id)!);
    expect(after.step).toBeGreaterThan(before.step);
  });
});
