/**
 * T8-② 酒場の噂 / T8-③ 自室の私信のテスト。
 *
 * 検証の狙い:
 * - 噂と私信が「固定の飾り」ではなく、章・4状態・隊の状況の関数になっていること
 * - 同じ状況なら同じ文が出ること（酒場を開き直しても話が飛ばない）
 * - 噂の伝播が、話し手自身の話を返さないこと（自分の噂を聞かされない）
 * - 固有名詞の出所が人物名簿に限られていること（名前の捏造がない）
 */

import { describe, expect, it } from 'vitest';
import {
  BAR_RUMORS,
  BARTENDER_PERSON_ID,
  RUMOR_SOURCE_LABELS,
  bartenderLine,
  bartenderName,
  gossipLine,
  rumorsFor,
  validateBarRumors,
  type BarMemory,
  type RumorContext,
} from '../../src/content/barRumors';
import { MAIL_DEPARTMENTS, MAIL_TOTAL, mailFor, validateMail, type MailContext } from '../../src/content/mail';
import { PILOTS } from '../../src/content/pilots';
import { PILOT_BONDS, PILOT_BOND_KINDS, bondKey, type PilotBondKind } from '../../src/content/pilotBonds';
import { VEIL_PEOPLE, veilPerson } from '../../src/content/veil/people';

const ALL_CHAPTERS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

/** 条件に合う噂を全部集める（`count` を十分大きくする）。 */
function allRumorIds(ctx: RumorContext): string[] {
  return rumorsFor(ctx, 0, BAR_RUMORS.length).map((r) => r.id);
}

const MID_GAUGES = { returnees: 50, routeTrust: 50, commandTrust: 50, aceOath: 50 };

describe('T8-② 噂データの整合性', () => {
  it('id が一意で、text が空でない', () => {
    expect(validateBarRumors()).toEqual([]);
    const ids = new Set(BAR_RUMORS.map((r) => r.id));
    expect(ids.size).toBe(BAR_RUMORS.length);
    for (const r of BAR_RUMORS) {
      expect(r.text.trim().length).toBeGreaterThan(0);
      expect(RUMOR_SOURCE_LABELS[r.source]).toBeTruthy();
    }
  });

  it('噂は32件以上ある', () => {
    expect(BAR_RUMORS.length).toBeGreaterThanOrEqual(32);
  });

  it('既存 pilotDialogue.ts の9件が移植されている', () => {
    const legacy = BAR_RUMORS.filter((r) => r.id.startsWith('legacy-'));
    expect(legacy.length).toBe(9);
  });

  it('十章それぞれに紐づく噂が1件以上ある', () => {
    for (const chapter of ALL_CHAPTERS) {
      const tag = `ch${String(chapter).padStart(2, '0')}-`;
      const own = BAR_RUMORS.filter((r) => r.id.startsWith(tag));
      expect(own.length, `chapter ${chapter} の専用の噂`).toBeGreaterThanOrEqual(1);
      // 章専用の噂は、その章で実際に出ること
      const ids = allRumorIds({ chapter, gauges: MID_GAUGES });
      for (const r of own) expect(ids, `${r.id} が chapter ${chapter} で出る`).toContain(r.id);
    }
  });

  it('酒保は人物名簿の1名（新規人物ではない）', () => {
    const person = veilPerson(BARTENDER_PERSON_ID);
    expect(person.faction).toBe('confed');
    expect(bartenderName()).toBe(person.name);
    expect(VEIL_PEOPLE.some((p) => p.id === BARTENDER_PERSON_ID)).toBe(true);
  });
});

describe('T8-② rumorsFor', () => {
  it('全章で2件以上返す（4状態が不明でも成立する）', () => {
    for (const chapter of ALL_CHAPTERS) {
      expect(rumorsFor({ chapter }, 0).length, `chapter ${chapter}`).toBeGreaterThanOrEqual(2);
      expect(rumorsFor({ chapter }, 7, 2).length).toBe(2);
      expect(rumorsFor({ chapter, gauges: MID_GAUGES }, 3).length).toBeGreaterThanOrEqual(2);
    }
  });

  it('返す件数が count 通りで、重複がない', () => {
    const got = rumorsFor({ chapter: 5, gauges: MID_GAUGES }, 11, 5);
    expect(got.length).toBe(5);
    expect(new Set(got.map((r) => r.id)).size).toBe(5);
  });

  it('4状態が低い/高いで、出る噂が入れ替わる', () => {
    const low = allRumorIds({
      chapter: 6,
      gauges: { returnees: 20, routeTrust: 20, commandTrust: 20, aceOath: 20 },
    });
    const high = allRumorIds({
      chapter: 6,
      gauges: { returnees: 80, routeTrust: 80, commandTrust: 80, aceOath: 80 },
    });

    // 低いときだけ出るもの
    expect(low).toContain('low-returnees');
    expect(low).toContain('low-route-trust');
    expect(low).toContain('low-command-trust');
    expect(low).toContain('low-ace-oath');
    expect(high).not.toContain('low-returnees');
    expect(high).not.toContain('low-route-trust');
    expect(high).not.toContain('low-command-trust');
    expect(high).not.toContain('low-ace-oath');

    // 高いときだけ出るもの
    expect(high).toContain('high-returnees');
    expect(high).toContain('high-route-trust');
    expect(high).toContain('high-command-trust');
    expect(high).toContain('high-ace-oath');
    expect(low).not.toContain('high-returnees');
    expect(low).not.toContain('high-ace-oath');
  });

  it('4状態が不明なときは、状態条件を持つ噂を出さない', () => {
    const unknown = allRumorIds({ chapter: 6 });
    expect(unknown).not.toContain('low-command-trust');
    expect(unknown).not.toContain('high-command-trust');
    // 無条件の雑談は出る
    expect(unknown).toContain('idle-coffee');
  });

  it('章の範囲外の噂は出ない', () => {
    const ch1 = allRumorIds({ chapter: 1, gauges: MID_GAUGES });
    expect(ch1).toContain('ch01-manifest');
    expect(ch1).not.toContain('ch10-open-hand');
    const ch10 = allRumorIds({ chapter: 10, gauges: MID_GAUGES });
    expect(ch10).toContain('ch10-open-hand');
    expect(ch10).not.toContain('ch01-manifest');
  });

  it('戦死者・負傷者の有無で出る噂が変わる', () => {
    const none = allRumorIds({ chapter: 4, gauges: MID_GAUGES });
    const fallen = allRumorIds({ chapter: 4, gauges: MID_GAUGES, hasFallen: true });
    const wounded = allRumorIds({ chapter: 4, gauges: MID_GAUGES, hasWounded: true });

    expect(none).not.toContain('fallen-seat');
    expect(none).not.toContain('wounded-bench');
    expect(fallen).toContain('fallen-seat');
    expect(fallen).toContain('fallen-locker');
    expect(wounded).toContain('wounded-bench');
    expect(wounded).toContain('legacy-sickbay');
    expect(fallen).not.toContain('wounded-bench');
  });

  it('同じ引数なら同じ結果、seed を変えると内容が変わる（決定論）', () => {
    const ctx: RumorContext = { chapter: 5, gauges: MID_GAUGES, hasWounded: true };
    const a = rumorsFor(ctx, 3, 3).map((r) => r.id);
    const b = rumorsFor(ctx, 3, 3).map((r) => r.id);
    expect(b).toEqual(a);
    const c = rumorsFor(ctx, 4, 3).map((r) => r.id);
    expect(c).not.toEqual(a);
    // 負の seed でも落ちない
    expect(rumorsFor(ctx, -7, 3).length).toBe(3);
  });
});

describe('T8-② bartenderLine', () => {
  it('全章で空でない1行を返し、決定論である', () => {
    for (const chapter of ALL_CHAPTERS) {
      const line = bartenderLine({ chapter }, chapter);
      expect(line.trim().length).toBeGreaterThan(0);
      expect(bartenderLine({ chapter }, chapter)).toBe(line);
    }
  });

  it('状況で内容が変わる', () => {
    /** seed を振って、その状況で出得る文の集合を取る。 */
    const linesOf = (ctx: RumorContext) => {
      const out = new Set<string>();
      for (let s = 0; s < 24; s += 1) out.add(bartenderLine(ctx, s));
      return out;
    };
    const calm = linesOf({ chapter: 5, hasFallen: false, hasWounded: false });
    const grieving = linesOf({ chapter: 5, hasFallen: true });
    // 戦死者がいるときの文は、平時には出ない
    const onlyGrieving = [...grieving].filter((line) => !calm.has(line));
    expect(onlyGrieving.length).toBeGreaterThan(0);

    const lowCmd = linesOf({ chapter: 5, gauges: { ...MID_GAUGES, commandTrust: 20 } });
    const highCmd = linesOf({ chapter: 5, gauges: { ...MID_GAUGES, commandTrust: 80 } });
    expect([...lowCmd].some((line) => !highCmd.has(line))).toBe(true);
    expect([...highCmd].some((line) => !lowCmd.has(line))).toBe(true);
  });
});

describe('T8-② gossipLine（噂の伝播）', () => {
  const callsign = (id: string) => PILOTS.find((p) => p.id === id)!.callsign;

  it('自分自身の話は返さない', () => {
    for (const p of PILOTS) {
      const onlySelf: BarMemory = {
        talkedWith: [p.id],
        boughtDrink: p.id,
      };
      expect(gossipLine(p.id, onlySelf, 0), `${p.id} 自身の話`).toBeUndefined();
    }
  });

  it('掛け合いの当事者には、その掛け合いの噂を返さない', () => {
    const bond = PILOT_BONDS[0];
    const memory: BarMemory = {
      talkedWith: [],
      intervened: { bondKey: bondKey(bond.a, bond.b), side: 'a' },
    };
    expect(gossipLine(bond.a, memory, 0)).toBeUndefined();
    expect(gossipLine(bond.b, memory, 1)).toBeUndefined();
  });

  it('記録が空なら undefined', () => {
    expect(gossipLine('sable', { talkedWith: [] }, 0)).toBeUndefined();
  });

  it('相関6種類すべてで、相手の名前を含む文が出る', () => {
    const kinds = Object.keys(PILOT_BOND_KINDS) as PilotBondKind[];
    expect(kinds.length).toBe(6);
    for (const kind of kinds) {
      const bond = PILOT_BONDS.find((b) => b.kind === kind);
      expect(bond, `${kind} の相関が存在する`).toBeTruthy();
      if (!bond) continue;
      // 「話した」「奢った」の両方の立場で文が出る
      const talked = gossipLine(bond.a, { talkedWith: [bond.b] }, 0);
      const treated = gossipLine(bond.a, { talkedWith: [], boughtDrink: bond.b }, 0);
      for (const line of [talked, treated]) {
        expect(line, `${kind} の文`).toBeTruthy();
        expect(line!.trim().length).toBeGreaterThan(0);
        expect(line, `${kind} の文に相手のコールサイン`).toContain(callsign(bond.b));
        expect(line, '自分のコールサインは出さない').not.toContain(callsign(bond.a));
        expect(line).not.toContain('{name}');
      }
    }
  });

  it('味方された / されなかった / なだめられた の立場で文が変わる', () => {
    // Sable × Raven の不和へ介入した記録を、Raven の相棒 Solace が口にする
    const key = bondKey('sable', 'raven');
    const speaker = 'solace';
    const favored = gossipLine(speaker, { talkedWith: [], intervened: { bondKey: key, side: 'b' } }, 0);
    const passed = gossipLine(speaker, { talkedWith: [], intervened: { bondKey: key, side: 'a' } }, 0);
    const defused = gossipLine(speaker, { talkedWith: [], intervened: { bondKey: key, side: 'defuse' } }, 0);
    for (const line of [favored, passed, defused]) {
      expect(line).toBeTruthy();
      expect(line!.trim().length).toBeGreaterThan(0);
    }
    expect(new Set([favored, passed, defused]).size).toBeGreaterThanOrEqual(2);
  });

  it('話し手の性格で言い方が変わる（同じ相手の話でも文が違う）', () => {
    // Solace は3名と相関を持つ。相手を固定し、話し手を変えると文が変わる
    const a = gossipLine('aster', { talkedWith: ['solace'] }, 0);
    const b = gossipLine('raven', { talkedWith: ['solace'] }, 0);
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(a).not.toBe(b);
  });

  it('同じ引数なら同じ結果、seed を変えると内容が変わる（決定論）', () => {
    const memory: BarMemory = {
      talkedWith: ['solace', 'orion'],
      boughtDrink: 'tempest',
      intervened: { bondKey: bondKey('sable', 'raven'), side: 'defuse' },
    };
    const first = gossipLine('vesper', memory, 2);
    expect(gossipLine('vesper', memory, 2)).toBe(first);
    const seeds = [0, 1, 2, 3, 4, 5].map((s) => gossipLine('vesper', memory, s));
    expect(new Set(seeds).size).toBeGreaterThan(1);
  });
});

describe('T8-③ 自室の私信', () => {
  /** 差出人として許される名前（人物名簿の名前＋部署名）。 */
  const allowedSenders = new Set<string>(MAIL_DEPARTMENTS);
  for (const p of VEIL_PEOPLE) {
    allowedSenders.add(p.name);
    const i = p.name.indexOf('（');
    if (i > 0) allowedSenders.add(p.name.slice(0, i));
  }

  /** 条件を広く踏むための文脈の組み合わせ。 */
  function contexts(): MailContext[] {
    const out: MailContext[] = [];
    const activePilots = PILOTS.map((p) => p.id);
    for (const chapter of ALL_CHAPTERS) {
      for (const v of [15, 35, 50, 65, 85]) {
        for (const flags of [
          { hasFallen: false, hasWounded: false },
          { hasFallen: true, hasWounded: true, fallenPilots: activePilots, fallenNames: ['柊 奏'] },
        ]) {
          out.push({
            chapter,
            gauges: { returnees: v, routeTrust: v, commandTrust: v, aceOath: v },
            activePilots,
            ...flags,
          });
        }
      }
      out.push({ chapter });
    }
    return out;
  }

  it('データの整合性（id 一意・空欄なし）', () => {
    expect(validateMail()).toEqual([]);
  });

  it('20件以上ある', () => {
    expect(MAIL_TOTAL).toBeGreaterThanOrEqual(20);
  });

  it('全章で1件以上返す（4状態や隊の状況が不明でも成立する）', () => {
    for (const chapter of ALL_CHAPTERS) {
      expect(mailFor({ chapter }).length, `chapter ${chapter}`).toBeGreaterThanOrEqual(1);
    }
  });

  it('全ての私信が、いずれかの状況で受信できる', () => {
    const seen = new Set<string>();
    for (const ctx of contexts()) for (const m of mailFor(ctx)) seen.add(m.id);
    expect(seen.size).toBe(MAIL_TOTAL);
  });

  it('差出人が人物名簿または部署名に含まれる（名前の捏造がない）', () => {
    const checked = new Set<string>();
    for (const ctx of contexts()) {
      for (const m of mailFor(ctx)) {
        if (checked.has(m.id)) continue;
        checked.add(m.id);
        expect(allowedSenders.has(m.from), `${m.id} の差出人 ${m.from}`).toBe(true);
        expect(m.subject.trim().length).toBeGreaterThan(0);
        expect(m.body.trim().length).toBeGreaterThan(0);
      }
    }
    expect(checked.size).toBe(MAIL_TOTAL);
  });

  it('条件が効いている（戦死者・4状態・章）', () => {
    const idsOf = (ctx: MailContext) => mailFor(ctx).map((m) => m.id);
    const calm = idsOf({ chapter: 5, gauges: MID_GAUGES, activePilots: PILOTS.map((p) => p.id) });
    expect(calm).not.toContain('loss-effects');
    expect(calm).not.toContain('dept-medical');

    const grieving = idsOf({
      chapter: 5,
      gauges: MID_GAUGES,
      hasFallen: true,
      hasWounded: true,
      fallenNames: ['柊 奏'],
    });
    expect(grieving).toContain('loss-effects');
    expect(grieving).toContain('dept-medical');

    // 敵エースからの通信は誓約が高いときだけ
    expect(idsOf({ chapter: 6, gauges: { ...MID_GAUGES, aceOath: 90 } })).toContain('ace-oath');
    expect(idsOf({ chapter: 6, gauges: { ...MID_GAUGES, aceOath: 20 } })).not.toContain('ace-oath');

    // 故郷からの手紙は章で内容が変わる
    expect(idsOf({ chapter: 1 })).toContain('home-early');
    expect(idsOf({ chapter: 1 })).not.toContain('home-late');
    expect(idsOf({ chapter: 10 })).toContain('home-late');
    expect(idsOf({ chapter: 10 })).not.toContain('home-early');

    // 隊員からの私信は、その隊員が飛べるときだけ
    expect(idsOf({ chapter: 5, activePilots: ['aster'] })).toContain('pilot-aster-solace');
    expect(idsOf({ chapter: 5, activePilots: ['sable'] })).not.toContain('pilot-aster-solace');
    expect(idsOf({ chapter: 5 })).not.toContain('pilot-aster-solace');
  });

  it('{fallen} が戦死者名で置き換わる', () => {
    const mails = mailFor({ chapter: 5, hasFallen: true, fallenNames: ['柊 奏'] });
    const item = mails.find((m) => m.id === 'loss-effects');
    expect(item).toBeTruthy();
    expect(item!.body).toContain('柊 奏');
    expect(item!.body).not.toContain('{fallen}');
    // 名前が渡されなくても穴が空かない
    const fallback = mailFor({ chapter: 5, hasFallen: true }).find((m) => m.id === 'loss-effects');
    expect(fallback!.body).not.toContain('{fallen}');
  });

  it('同じ文脈なら同じ並びで返る（決定論）', () => {
    const ctx: MailContext = { chapter: 7, gauges: MID_GAUGES, activePilots: ['sable', 'orion'] };
    expect(mailFor(ctx).map((m) => m.id)).toEqual(mailFor(ctx).map((m) => m.id));
  });
});
