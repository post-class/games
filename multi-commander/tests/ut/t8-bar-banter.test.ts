import { describe, expect, it } from 'vitest';
import {
  banterEffect,
  banterTopic,
  buildBanter,
  chooseBanterReply,
  newBanter,
  type BanterFacts,
  type BanterInput,
} from '../../src/app/barBanter';
import { BANTER_CHOICES, BANTER_VARIANTS, type BanterTopic } from '../../src/content/barBanter';
import {
  bondBetween,
  bondKey,
  PILOT_BONDS,
  validatePilotBonds,
  type PilotBond,
} from '../../src/content/pilotBonds';

/**
 * T8-② 酒場の掛け合いに割り込む。
 *
 * 検証するのは「10ペアぶんの台詞が揃っていること」「決定論であること」
 * 「肩入れとなだめるで効果の向きが非対称であること」。台詞の良さは検証しない。
 */

const ALL_TOPICS: BanterTopic[] = ['aftermath', 'mourning', 'rescue', 'neglect', 'idle'];

/** その話題になる facts を作る（`banterTopic` の判定条件に合わせる） */
function factsFor(bond: PilotBond, topic: BanterTopic): BanterFacts {
  switch (topic) {
    case 'rescue':
      return { wingmanId: bond.a, rescued: true };
    case 'neglect':
      return { wingmanId: bond.b, abandoned: true };
    case 'mourning':
      return { fallenName: 'Ash' };
    case 'aftermath':
      return { wingmanId: bond.a };
    default:
      return {};
  }
}

function input(bond: PilotBond, over: Partial<BanterInput> = {}): BanterInput {
  return { bond, relation: 0, sorties: 0, ...over };
}

describe('T8-② 隊員相関のデータ', () => {
  it('validatePilotBonds() がエラーを返さない', () => {
    expect(validatePilotBonds()).toEqual([]);
  });

  it('10ペアぶんの掛け合いが用意されている', () => {
    expect(PILOT_BONDS).toHaveLength(10);
    for (const bond of PILOT_BONDS) {
      expect(bondBetween(bond.a, bond.b)).toBe(bond);
    }
  });
});

describe('T8-② 掛け合いの台詞', () => {
  it('全ペア × 全話題 × 全バリアントで、台詞が空にならず undefined を含まない', () => {
    for (const bond of PILOT_BONDS) {
      for (const topic of ALL_TOPICS) {
        for (let seed = 0; seed < BANTER_VARIANTS; seed++) {
          const v = buildBanter(input(bond, { sorties: seed, facts: factsFor(bond, topic) }));
          expect(v.topic).toBe(topic);
          // idle は前振り無しなので3行、それ以外は前振り込みで4行
          expect(v.turns.length).toBe(topic === 'idle' ? 3 : 4);
          for (const turn of v.turns) {
            expect(turn.text.length).toBeGreaterThan(0);
            expect(turn.text).not.toContain('undefined');
            expect(turn.text).not.toContain('{name}');
            expect(turn.pilotId).toBeDefined();
          }
          // 掛け合いの本体は a → b → a
          const body = v.turns.slice(v.turns.length - 3);
          expect(body.map((t) => t.speaker)).toEqual(['a', 'b', 'a']);
          expect(body[0].pilotId).toBe(bond.a);
          expect(body[1].pilotId).toBe(bond.b);

          // 3択はペア固有の言葉で、空にならない
          expect(v.replies.map((r) => r.id)).toEqual([...BANTER_CHOICES]);
          for (const reply of v.replies) expect(reply.label.length).toBeGreaterThan(0);
          expect(new Set(v.replies.map((r) => r.label)).size).toBe(3);
        }
      }
    }
  });

  it('追悼の前振りには戦死者名が差し込まれる', () => {
    // 名前を差し込む相関の種類が1つ以上あることを確かめる（全種類に用意してある）
    const withName = PILOT_BONDS.filter((bond) =>
      [0, 1].some((seed) =>
        buildBanter(input(bond, { sorties: seed, facts: { fallenName: 'Ash' } })).turns[0].text.includes('Ash'),
      ),
    );
    expect(withName.length).toBe(PILOT_BONDS.length);
    // 名前が無ければ代替語に落ちて、undefined を出さない
    const v = buildBanter(input(PILOT_BONDS[0], { facts: { fallenName: '' }, sorties: 0 }));
    for (const turn of v.turns) expect(turn.text).not.toContain('undefined');
  });

  it('ペア固有の掛け合いなので、10ペアの1行目が全部違う', () => {
    for (let seed = 0; seed < BANTER_VARIANTS; seed++) {
      const firsts = PILOT_BONDS.map(
        (bond) => buildBanter(input(bond, { sorties: seed })).turns[0].text, // idle なので掛け合いの1行目
      );
      expect(new Set(firsts).size).toBe(PILOT_BONDS.length);
    }
    // 3択のラベルもペアごとに違う
    const labels = PILOT_BONDS.map((bond) => buildBanter(input(bond)).replies[0].label);
    expect(new Set(labels).size).toBe(PILOT_BONDS.length);
  });

  it('seed で掛け合いのバリアントが変わる', () => {
    for (const bond of PILOT_BONDS) {
      const lines = [0, 1].map((seed) => buildBanter(input(bond, { sorties: seed })).turns[0].text);
      expect(new Set(lines).size).toBe(BANTER_VARIANTS);
    }
  });

  it('同じ入力なら必ず同じ会話になる（決定論）', () => {
    for (const bond of PILOT_BONDS) {
      const facts = factsFor(bond, 'aftermath');
      const a = buildBanter(input(bond, { facts, sorties: 3, relation: 0.2 }));
      const b = buildBanter(input(bond, { facts, sorties: 3, relation: 0.2 }));
      expect(a).toEqual(b);
    }
    // 介入後も同じ
    const bond = PILOT_BONDS[0];
    const state = chooseBanterReply(input(bond), 'defuse').state;
    expect(buildBanter(input(bond, { state }))).toEqual(buildBanter(input(bond, { state })));
  });

  it('話題は「救援 → 放置 → 追悼 → 直前の出撃 → 普段」の順で決まる', () => {
    const bond = PILOT_BONDS[0];
    expect(banterTopic(bond, { wingmanId: bond.a, rescued: true, fallenName: 'Ash' })).toBe('rescue');
    expect(banterTopic(bond, { wingmanId: bond.b, abandoned: true, fallenName: 'Ash' })).toBe('neglect');
    expect(banterTopic(bond, { fallenName: 'Ash' })).toBe('mourning');
    expect(banterTopic(bond, { wingmanId: bond.a })).toBe('aftermath');
    expect(banterTopic(bond, {})).toBe('idle');
    // 二人と無関係な隊員が飛んだだけなら普段のまま（救援の話題にしない）
    expect(banterTopic(bond, { wingmanId: 'nobody', rescued: true })).toBe('idle');
  });
});

describe('T8-② 割り込みの効果', () => {
  it('肩入れは味方した側が正・もう片方が負、二人の仲は下がる', () => {
    for (const bond of PILOT_BONDS) {
      const a = banterEffect(bond, 'side-a');
      expect(a.bondDelta[0].pilotId).toBe(bond.a);
      expect(a.bondDelta[0].delta).toBeGreaterThan(0);
      expect(a.bondDelta[1].pilotId).toBe(bond.b);
      expect(a.bondDelta[1].delta).toBeLessThan(0);
      expect(a.relationDelta).toBeLessThan(0);

      // side-b は a/b が入れ替わるだけ
      const b = banterEffect(bond, 'side-b');
      expect(b.bondDelta[0].pilotId).toBe(bond.b);
      expect(b.bondDelta[0].delta).toBe(a.bondDelta[0].delta);
      expect(b.bondDelta[1].pilotId).toBe(bond.a);
      expect(b.bondDelta[1].delta).toBe(a.bondDelta[1].delta);
      expect(b.relationDelta).toBe(a.relationDelta);
    }
  });

  it('なだめると両方の bond が正で、二人の仲も上がる', () => {
    for (const bond of PILOT_BONDS) {
      const d = banterEffect(bond, 'defuse');
      expect(d.bondDelta.map((x) => x.pilotId)).toEqual([bond.a, bond.b]);
      for (const x of d.bondDelta) expect(x.delta).toBeGreaterThan(0);
      expect(d.relationDelta).toBeGreaterThan(0);
      // 「好かれる」と「隊が回る」の非対称: 自分への伸びは肩入れより小さい
      expect(d.bondDelta[0].delta).toBeLessThan(banterEffect(bond, 'side-a').bondDelta[0].delta);
    }
  });

  it('不和のペアは、相棒のペアより仲裁が効く', () => {
    const friction = PILOT_BONDS.find((b) => b.kind === 'friction')!;
    const pair = PILOT_BONDS.find((b) => b.kind === 'pair')!;
    expect(banterEffect(friction, 'defuse').relationDelta).toBeGreaterThan(
      banterEffect(pair, 'defuse').relationDelta,
    );
    // 好敵手は肩入れの方が響く
    const rival = PILOT_BONDS.find((b) => b.kind === 'rival')!;
    expect(banterEffect(rival, 'side-a').bondDelta[0].delta).toBeGreaterThan(
      banterEffect(pair, 'side-a').bondDelta[0].delta,
    );
  });

  it('小数は3桁で丸める', () => {
    for (const bond of PILOT_BONDS) {
      for (const choice of BANTER_CHOICES) {
        const e = banterEffect(bond, choice);
        for (const d of e.bondDelta) expect(d.delta).toBe(Math.round(d.delta * 1000) / 1000);
        expect(e.relationDelta).toBe(Math.round(e.relationDelta * 1000) / 1000);
      }
    }
  });
});

describe('T8-② 割り込みの進行', () => {
  it('割り込みは1回で終わり、選んだ言葉と二人の反応が残る', () => {
    const bond = PILOT_BONDS[0];
    const before = buildBanter(input(bond));
    const label = before.replies.find((r) => r.id === 'side-a')!.label;
    const result = chooseBanterReply(input(bond), 'side-a');
    expect(result.finished).toBe(true);
    expect(result.state.chosen).toBe('side-a');

    const after = buildBanter(input(bond, { state: result.state }));
    expect(after.replies).toEqual([]);
    expect(after.turns.map((t) => t.speaker)).toEqual(['a', 'b', 'a', 'player', 'a', 'b']);
    expect(after.turns[3]).toEqual({ speaker: 'player', text: label });
    for (const turn of after.turns.slice(4)) expect(turn.text.length).toBeGreaterThan(0);
  });

  it('介入結果の要約が「コールサイン ±値 / 二人の仲 ±値」の形で出る', () => {
    const bond = PILOT_BONDS[0]; // sable × raven（不和）
    const state = chooseBanterReply(input(bond), 'side-a').state;
    const v = buildBanter(input(bond, { state }));
    expect(v.outcome).toBe('Sable +0.14 / Raven -0.07 / 二人の仲 -0.06');
    // 介入前は出さない
    expect(buildBanter(input(bond)).outcome).toBeUndefined();
  });

  it('二人の仲の段階と、直前の出撃で効いた理由が付く', () => {
    const bond = PILOT_BONDS[0];
    expect(buildBanter(input(bond, { relation: -0.8 })).level.label).toBe('決裂');
    expect(buildBanter(input(bond, { relation: 0.8 })).level.label).toBe('背中を預ける');
    expect(buildBanter(input(bond, { relation: 0 })).level.max).toBe(4);
    expect(
      buildBanter(input(bond, { facts: { wingmanId: bond.a, rescued: true } })).reason,
    ).toContain('応えた');
    expect(
      buildBanter(input(bond, { facts: { wingmanId: bond.a, abandoned: true } })).reason,
    ).toContain('応えなかった');
    expect(buildBanter(input(bond)).reason).toContain('二人とも出ていない');
  });

  it('無効な reply id は効果 0 で、状態も進まない', () => {
    const bond = PILOT_BONDS[0];
    const r = chooseBanterReply(input(bond), 'nope');
    expect(r.effect).toEqual({ bondDelta: [], relationDelta: 0 });
    expect(r.state.chosen).toBeUndefined();
    expect(r.finished).toBe(false);
  });

  it('すでに介入済みなら効果 0（同じ卓で二度は割り込めない）', () => {
    const bond = PILOT_BONDS[0];
    const first = chooseBanterReply(input(bond), 'defuse');
    const second = chooseBanterReply(input(bond, { state: first.state }), 'side-a');
    expect(second.effect).toEqual({ bondDelta: [], relationDelta: 0 });
    expect(second.state.chosen).toBe('defuse');
    expect(second.finished).toBe(true);
  });

  it('別のペアの状態を渡されても引き継がない', () => {
    const bond = PILOT_BONDS[0];
    const other = PILOT_BONDS[1];
    const done = chooseBanterReply(input(other), 'defuse').state;
    const fresh = chooseBanterReply(input(bond, { state: done }), 'side-a');
    expect(fresh.state.bondKey).toBe(bondKey(bond.a, bond.b));
    expect(fresh.effect.relationDelta).toBeLessThan(0);
    // 表示側も、他ペアの状態では介入前として扱う
    expect(buildBanter(input(bond, { state: done })).replies).toHaveLength(3);
  });

  it('newBanter は選択を持たない状態を返す', () => {
    const bond = PILOT_BONDS[0];
    expect(newBanter(bond)).toEqual({ bondKey: bondKey(bond.a, bond.b) });
  });
});
