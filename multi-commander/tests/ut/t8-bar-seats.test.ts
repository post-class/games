import { describe, expect, it } from 'vitest';
import {
  BAR_SEAT_SLOTS,
  banterSeats,
  seatBondKey,
  seatPlan,
  seatmateOf,
} from '../../src/app/barSeats';
import { newRoster, shiftRelation, type PilotState, type RosterState } from '../../src/app/roster';
import { bondKey, PILOT_BONDS } from '../../src/content/pilotBonds';
import { REPLACEMENT_POOL, STARTING_SQUADRON, pilotDef } from '../../src/content/pilots';

/**
 * T8-① 酒場の席割り。
 *
 * 検証するのは「決定論であること」「席の総数と在籍者の総数が合うこと」
 * 「相関と関係値が同席の組み合わせを決めていること」。
 * 席の文言（label / note）そのものの良さは検証しない。
 */

function pilot(id: string, over: Partial<PilotState> = {}): PilotState {
  return {
    id,
    status: 'active',
    skill: pilotDef(id).skill,
    kills: 0,
    sorties: 0,
    benchedFor: 0,
    bond: 0,
    rank: 0,
    transfers: 0,
    ...over,
  };
}

/** 指定した id だけの名簿を作る（関係値は空） */
function rosterOf(ids: string[]): RosterState {
  return { pilots: ids.map((id) => pilot(id)), reserves: [], relations: {} };
}

/** 8名（初期5名＋補充3名）の名簿。席（4つ）より人が多い状態を作るのに使う。 */
function fullRoster(): RosterState {
  return rosterOf([...STARTING_SQUADRON, ...REPLACEMENT_POOL]);
}

/** 席にいる隊員の id を席ごとに並べたもの。席割りの比較用。 */
function layout(roster: RosterState, options: { wingmanId?: string; seed?: number } = {}): string[][] {
  return seatPlan(roster, options).seats.map((s) => s.occupants.map((p) => p.id));
}

/** 同席しているペアの組み合わせ（席の位置は問わない） */
function pairKeys(roster: RosterState, options: { wingmanId?: string; seed?: number } = {}): string[] {
  return banterSeats(seatPlan(roster, options))
    .map((s) => bondKey(s.occupants[0].id, s.occupants[1].id))
    .sort();
}

describe('T8-① 席割りの決定論', () => {
  it('同じ名簿・同じ options なら完全に同じ結果になる', () => {
    const roster = newRoster();
    shiftRelation(roster, 'tempest', 'orion', 0.4);
    const a = seatPlan(roster, { wingmanId: 'aster', seed: 3 });
    const b = seatPlan(roster, { wingmanId: 'aster', seed: 3 });
    expect(a).toEqual(b);
    // 100回呼んでも揺らがない（Math.random を使っていない）
    for (let i = 0; i < 100; i++) expect(seatPlan(roster, { wingmanId: 'aster', seed: 3 })).toEqual(a);
  });

  it('席は常に BAR_SEAT_SLOTS と同数で、id・見出しは定義そのまま', () => {
    for (const roster of [rosterOf(['sable']), newRoster(), fullRoster()]) {
      const plan = seatPlan(roster);
      expect(plan.seats).toHaveLength(BAR_SEAT_SLOTS.length);
      expect(plan.seats.map((s) => s.id)).toEqual(BAR_SEAT_SLOTS.map((s) => s.id));
      expect(plan.seats.map((s) => s.label)).toEqual(BAR_SEAT_SLOTS.map((s) => s.label));
      expect(plan.seats.map((s) => s.kind)).toEqual(BAR_SEAT_SLOTS.map((s) => s.kind));
      for (const seat of plan.seats) expect(seat.occupants.length).toBeLessThanOrEqual(2);
    }
  });

  it('同じ隊員が2つの席に現れない', () => {
    for (const roster of [newRoster(), fullRoster()]) {
      const seated = seatPlan(roster).seats.flatMap((s) => s.occupants.map((p) => p.id));
      expect(new Set(seated).size).toBe(seated.length);
    }
  });

  it('席の隊員は名簿の実体（同じオブジェクト）を指す', () => {
    const roster = newRoster();
    for (const seat of seatPlan(roster).seats) {
      for (const p of seat.occupants) expect(roster.pilots).toContain(p);
    }
  });
});

describe('T8-① 同席の組み合わせ', () => {
  it('初期5名でも、相関を持つ二人が少なくとも1組は同席する', () => {
    const plan = seatPlan(newRoster());
    const together = plan.seats.filter((s) => s.occupants.length === 2);
    expect(together.length).toBeGreaterThan(0);
    for (const seat of together) {
      expect(seat.bond).toBeDefined();
      // 同席の理由は必ず PILOT_BONDS の実体
      expect(PILOT_BONDS).toContain(seat.bond!);
      const ids = seat.occupants.map((p) => p.id).sort();
      expect([seat.bond!.a, seat.bond!.b].sort()).toEqual(ids);
      expect(seat.relation).toBe(0);
    }
  });

  it('一人席には bond も relation も付かない', () => {
    for (const seat of seatPlan(newRoster()).seats) {
      if (seat.occupants.length === 2) continue;
      expect(seat.bond).toBeUndefined();
      expect(seat.relation).toBeUndefined();
    }
  });

  it('相関の現在値が席に写る', () => {
    const roster = newRoster();
    shiftRelation(roster, 'tempest', 'orion', -0.62);
    const seat = seatPlan(roster).seats.find(
      (s) => s.bond && bondKey(s.bond.a, s.bond.b) === bondKey('tempest', 'orion'),
    );
    expect(seat).toBeDefined();
    expect(seat!.relation).toBeCloseTo(-0.62);
  });
});

describe('T8-① 席に出る／出ない', () => {
  it('戦死者・転属者は席にも立ち飲みにも出ない', () => {
    const roster = newRoster();
    roster.pilots.find((p) => p.id === 'sable')!.status = 'dead';
    roster.pilots.find((p) => p.id === 'orion')!.status = 'transferred';
    const plan = seatPlan(roster);
    const present = [...plan.seats.flatMap((s) => s.occupants), ...plan.standing].map((p) => p.id);
    expect(present).not.toContain('sable');
    expect(present).not.toContain('orion');
    expect(new Set(present)).toEqual(new Set(['tempest', 'aster', 'vesper']));
  });

  it('負傷者は席に出る（欠場中でも艦内にいる）', () => {
    const roster = newRoster();
    const wounded = roster.pilots.find((p) => p.id === 'vesper')!;
    wounded.status = 'wounded';
    wounded.benchedFor = 2;
    const plan = seatPlan(roster);
    const present = [...plan.seats.flatMap((s) => s.occupants), ...plan.standing].map((p) => p.id);
    expect(present).toContain('vesper');
  });

  it('在籍者が0名なら全席が空席になる', () => {
    const roster = newRoster();
    for (const p of roster.pilots) p.status = 'dead';
    const plan = seatPlan(roster);
    expect(plan.seats.every((s) => s.occupants.length === 0)).toBe(true);
    expect(plan.standing).toEqual([]);
  });
});

describe('T8-① 優先順位', () => {
  it('|relation| が大きいペアが先に席へ入る（仲が良い順ではない）', () => {
    const base = pairKeys(newRoster());
    expect(base).toContain(bondKey('tempest', 'orion'));
    expect(base).not.toContain(bondKey('vesper', 'orion'));

    // 険悪な二人（負の大きい値）を優先する
    const cold = newRoster();
    shiftRelation(cold, 'vesper', 'orion', -0.9);
    const coldPairs = pairKeys(cold);
    expect(coldPairs).toContain(bondKey('vesper', 'orion'));
    expect(coldPairs).not.toEqual(base);

    // 噛み合っている二人（正の大きい値）でも同じだけ優先される
    const warm = newRoster();
    shiftRelation(warm, 'vesper', 'orion', 0.9);
    expect(pairKeys(warm)).toEqual(coldPairs);
  });

  it('関係値が中立なら PILOT_BONDS の定義順で決まる（同点でも順序がぶれない）', () => {
    // 定義順の先頭に近い tempest×orion（index 2）が sable×orion（index 9）より先
    const pairs = pairKeys(newRoster());
    expect(pairs).toContain(bondKey('tempest', 'orion'));
    expect(pairs).not.toContain(bondKey('sable', 'orion'));
  });

  it('wingmanId を渡すと、その隊員を含むペアの優先度が上がる', () => {
    const roster = newRoster();
    // 既定では aster は相手がおらず一人席
    expect(pairKeys(roster)).not.toContain(bondKey('aster', 'tempest'));
    expect(seatmateOf(seatPlan(roster), 'aster')).toBeUndefined();

    const withWingman = pairKeys(roster, { wingmanId: 'aster' });
    expect(withWingman).toContain(bondKey('aster', 'tempest'));
    expect(seatmateOf(seatPlan(roster, { wingmanId: 'aster' }), 'aster')!.id).toBe('tempest');
  });

  it('wingmanId の加点は、関係値の振れ幅ほど強くない', () => {
    const roster = newRoster();
    // tempest×orion に強い振れ幅を与えれば、aster を僚機にしても割り込めない
    shiftRelation(roster, 'tempest', 'orion', 0.95);
    expect(pairKeys(roster, { wingmanId: 'aster' })).toContain(bondKey('tempest', 'orion'));
  });
});

describe('T8-① 席が足りないとき', () => {
  it('席と立ち飲みの合計が在籍者数と一致する', () => {
    const roster = fullRoster();
    const plan = seatPlan(roster);
    const seated = plan.seats.flatMap((s) => s.occupants);
    expect(seated.length + plan.standing.length).toBe(roster.pilots.length);
    // 8名 / 4席なので必ず溢れる
    expect(plan.standing.length).toBeGreaterThan(0);
    // 立ち飲みは席に着いている者と重複しない
    const seatedIds = new Set(seated.map((p) => p.id));
    for (const p of plan.standing) expect(seatedIds.has(p.id)).toBe(false);
  });

  it('席が空いているうちは立ち飲みを作らない', () => {
    // 3名なら 4席に収まる
    const plan = seatPlan(rosterOf(['sable', 'orion', 'aster']));
    expect(plan.standing).toEqual([]);
  });

  it('空席が残っていれば必ず埋める（空席と立ち飲みが同時に出ない）', () => {
    for (const ids of [
      ['sable'],
      ['sable', 'orion'],
      [...STARTING_SQUADRON],
      [...STARTING_SQUADRON, ...REPLACEMENT_POOL],
    ]) {
      const plan = seatPlan(rosterOf(ids));
      const vacant = plan.seats.filter((s) => s.occupants.length === 0).length;
      expect(vacant > 0 && plan.standing.length > 0, `${ids.length} 名で空席と立ち飲みが同時に出た`).toBe(false);
    }
  });
});

describe('T8-① seed による揺らぎ', () => {
  it('seed を変えると一人席の席が変わり、ペアの席は変わらない', () => {
    const roster = newRoster();
    const a = layout(roster, { seed: 0 });
    const b = layout(roster, { seed: 1 });
    expect(a).not.toEqual(b);

    // ペア（2名の席）の位置と組み合わせは seed に依らない
    const pairsOf = (rows: string[][]) => rows.map((ids) => (ids.length === 2 ? [...ids].sort().join(':') : ''));
    expect(pairsOf(a)).toEqual(pairsOf(b));
    // 動いたのは一人席だけ
    const soloOf = (rows: string[][]) => rows.map((ids) => (ids.length === 1 ? ids[0] : ''));
    expect(soloOf(a)).not.toEqual(soloOf(b));
    // 一人席にいる顔ぶれ自体は同じ
    expect(soloOf(a).filter(Boolean).sort()).toEqual(soloOf(b).filter(Boolean).sort());
  });

  it('seed は空席数で巡回し、負値・小数でも同じ席割りになる', () => {
    const roster = newRoster();
    const empties = seatPlan(roster).seats.filter((s) => s.occupants.length <= 1).length;
    expect(empties).toBeGreaterThan(0);
    expect(layout(roster, { seed: 0 })).toEqual(layout(roster, { seed: 2 }));
    expect(layout(roster, { seed: 1 })).toEqual(layout(roster, { seed: -1 }));
    expect(layout(roster, { seed: 1.9 })).toEqual(layout(roster, { seed: 1 }));
    expect(layout(roster, {})).toEqual(layout(roster, { seed: 0 }));
  });
});

describe('T8-① 席から会話を引く', () => {
  it('banterSeats は同席の席だけを返す', () => {
    const plan = seatPlan(fullRoster());
    const seats = banterSeats(plan);
    expect(seats.length).toBeGreaterThan(0);
    for (const seat of seats) {
      expect(seat.occupants).toHaveLength(2);
      expect(seat.bond).toBeDefined();
    }
    // 2名でない席は含まれない
    expect(seats).toEqual(plan.seats.filter((s) => s.occupants.length === 2));
  });

  it('seatBondKey は bondKey(a, b) と一致し、一人席・空席では undefined', () => {
    const plan = seatPlan(newRoster());
    for (const seat of plan.seats) {
      if (seat.occupants.length === 2) {
        expect(seatBondKey(seat)).toBe(bondKey(seat.bond!.a, seat.bond!.b));
        // 席の並び順に依らず、二人の組み合わせで決まる
        expect(seatBondKey(seat)).toBe(bondKey(seat.occupants[0].id, seat.occupants[1].id));
      } else {
        expect(seatBondKey(seat)).toBeUndefined();
      }
    }
  });

  it('seatmateOf が同席の相手を返し、一人席・在籍しない者では undefined', () => {
    const plan = seatPlan(newRoster());
    const pairSeat = banterSeats(plan)[0];
    const [x, y] = pairSeat.occupants;
    expect(seatmateOf(plan, x.id)!.id).toBe(y.id);
    expect(seatmateOf(plan, y.id)!.id).toBe(x.id);

    const solo = plan.seats.find((s) => s.occupants.length === 1);
    expect(solo).toBeDefined();
    expect(seatmateOf(plan, solo!.occupants[0].id)).toBeUndefined();
    expect(seatmateOf(plan, 'nobody')).toBeUndefined();
  });

  it('席が変わっても同じ二人なら bondKey は変わらない（会話が続く）', () => {
    const roster = newRoster();
    const keys = (seed: number) => banterSeats(seatPlan(roster, { seed })).map((s) => seatBondKey(s)!).sort();
    expect(keys(0)).toEqual(keys(1));
  });
});
