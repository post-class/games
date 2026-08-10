import { describe, expect, it } from 'vitest';
import {
  barracksHtml,
  bondBoardHtml,
  mailHtml,
  recRoomHtml,
  type BarSeatView,
  type HubContext,
} from '../../src/ui/HubPanels';
import { banterSeats, seatPlan } from '../../src/app/barSeats';
import { newRoster, shiftRelation, type RosterState } from '../../src/app/roster';
import { PILOTS } from '../../src/content/pilots';
import { PILOT_BOND_KINDS, bondBetween, type PilotBondKind } from '../../src/content/pilotBonds';

/**
 * T8-① 酒場を「部屋」として描く／自室に相関と私信を出す。
 *
 * `t3a-hub-panels-pager.test.ts` と同じやり方で、`recRoomHtml` /
 * `barracksHtml` が返す HTML 文字列を検証する。CSS の見た目ではなく
 * 「情報が出ているか」「渡さないときに従来表示へ落ちるか」を見る。
 */

function hubCtx(over: Partial<HubContext> = {}): HubContext {
  return {
    roster: newRoster(),
    totalKills: 12,
    sorties: 4,
    cleared: ['veil-ch01'],
    medals: [],
    chapter: 3,
    totalChapters: 10,
    ...over,
  };
}

/** 席割りを `BarSeatView[]` として取り出す（`barSeats.ts` の実体をそのまま渡す） */
function seatsOf(roster: RosterState, options: { wingmanId?: string; seed?: number } = {}): BarSeatView[] {
  return seatPlan(roster, options).seats as unknown as BarSeatView[];
}

/** 席1つ分の HTML を、出た順に切り出す */
function seatChunks(html: string): string[] {
  const marks = [...html.matchAll(/<div class="mc-bar-seat(?: active| vacant)?"/g)];
  return marks.map((m, i) => {
    const start = m.index ?? 0;
    const end = i + 1 < marks.length ? (marks[i + 1].index ?? html.length) : html.length;
    return html.slice(start, end);
  });
}

function callsignOf(id: string): string {
  return PILOTS.find((p) => p.id === id)!.callsign;
}

const XSS = '<script>alert("x")</script>';

describe('T8-① 酒場 — 席レイアウト', () => {
  it('barSeats を渡すと部屋として描く', () => {
    const ctx = hubCtx();
    const html = recRoomHtml({ ...ctx, barSeats: seatsOf(ctx.roster) });
    expect(html).toContain('mc-bar-room');
    expect(html).toContain('mc-bar-seat');
    // 4席ぶんが出る
    expect(seatChunks(html)).toHaveLength(seatsOf(ctx.roster).length);
    // 席の見出し（label / note）が出る
    for (const seat of seatsOf(ctx.roster)) expect(html).toContain(seat.label);
    // 席にいる隊員はコールサインで出る
    for (const seat of seatsOf(ctx.roster)) {
      for (const p of seat.occupants) expect(html).toContain(callsignOf(p.id));
    }
    // 席で描くときの案内文が出る
    expect(html).toContain('同じ席にいる二人は、互いに何かがある。');
  });

  it('barSeats を渡さないときは従来のページャ表示へ落ちる（後方互換）', () => {
    const html = recRoomHtml(hubCtx());
    expect(html).not.toContain('mc-bar-room');
    expect(html).not.toContain('mc-bar-seat');
    expect(html).toContain('data-mc-pager="bar-talks"');
    expect(html).toContain('mc-bar-row');
    expect(html).not.toContain('同じ席にいる二人は');
  });

  it('空席には vacant クラスが付き、「誰もいない。」と出る', () => {
    const roster = newRoster();
    // 1名だけ在籍させれば残り3席が空く
    for (const p of roster.pilots) if (p.id !== 'sable') p.status = 'transferred';
    const seats = seatsOf(roster);
    const html = recRoomHtml({ ...hubCtx({ roster }), barSeats: seats });
    const vacant = [...html.matchAll(/mc-bar-seat vacant/g)];
    expect(vacant).toHaveLength(seats.filter((s) => s.occupants.length === 0).length);
    expect(vacant.length).toBe(3);
    expect(html).toContain('誰もいない。');
  });

  it('会話していない席に active は付かない', () => {
    const ctx = hubCtx();
    const html = recRoomHtml({ ...ctx, barSeats: seatsOf(ctx.roster) });
    expect(html).not.toContain('mc-bar-seat active');
  });

  it('一人席で往復会話を開くと、その席が全幅へ出て active が付き、本文が入る', () => {
    const ctx = hubCtx();
    const seats = seatsOf(ctx.roster);
    const solo = seats.find((s) => s.occupants.length === 1)!;
    const target = solo.occupants[0];
    const html = recRoomHtml({
      ...ctx,
      barSeats: seats,
      barPilotId: target.id,
      barTalk: {
        pilotId: target.id,
        turns: [{ speaker: 'pilot', text: '一人で飲んでいます。' }],
        replies: [{ id: 'a', label: '隣に座る' }],
        relation: { label: '信頼', step: 3, max: 4 },
      },
    });
    expect(html).toContain('mc-bar-seat active');
    // active が付いたのはその席だけ
    const chunks = seatChunks(html);
    const active = chunks.filter((c) => c.startsWith('<div class="mc-bar-seat active"'));
    expect(active).toHaveLength(1);
    expect(active[0]).toContain('一人で飲んでいます。');
    expect(active[0]).toContain(callsignOf(target.id));
    expect(active[0]).toContain('mc-bar-talk');
    // 会話は1箇所にだけ描く（同じ台詞が二重に出ない）
    expect([...html.matchAll(/一人で飲んでいます。/g)]).toHaveLength(1);
    // 会話を開いても、他の席にいる隊員が艦内から消えたようには見せない
    for (const p of seats.flatMap((s) => s.occupants)) expect(html).toContain(callsignOf(p.id));
  });

  it('同席の席には data-kind と相関の種類・見出しが出る', () => {
    const ctx = hubCtx();
    const seats = seatsOf(ctx.roster);
    const pairs = banterSeats(seatPlan(ctx.roster));
    expect(pairs.length).toBeGreaterThan(0);
    const html = recRoomHtml({ ...ctx, barSeats: seats });
    for (const seat of pairs) {
      const bond = seat.bond!;
      // 席そのものと相関ブロックの両方に data-kind が付く
      expect(html).toContain(`data-kind="${bond.kind}"`);
      expect(html).toContain(PILOT_BOND_KINDS[bond.kind as PilotBondKind].label);
      expect(html).toContain(bond.title);
    }
    expect(html).toContain('mc-bar-bond');
    expect([...html.matchAll(/class="mc-bar-bond"/g)]).toHaveLength(pairs.length);
  });

  it('二人の間にあった出来事（history）は、割り込める掛け合いを開いた席にだけ出る', () => {
    const ctx = hubCtx();
    const seats = seatsOf(ctx.roster);
    const pairs = banterSeats(seatPlan(ctx.roster));
    // 一望しているだけの部屋では history は出さない（席が文字で埋まらないように）
    const room = recRoomHtml({ ...ctx, barSeats: seats });
    for (const seat of pairs) expect(room).not.toContain(seat.bond!.history);

    const open = pairs[0];
    const bond = open.bond!;
    const banterCtxFor = (replies: Array<{ id: string; label: string }>) => ({
      ...ctx,
      barSeats: seats,
      barBanter: {
        bond: { a: bond.a, b: bond.b, kind: bond.kind, title: bond.title },
        turns: [{ speaker: 'a' as const, pilotId: bond.a, text: '座れ。' }],
        replies,
        level: { label: '平行線', step: 2, max: 4 },
      },
    });

    // 割り込む前は判断材料として history を出す
    const before = recRoomHtml(banterCtxFor([{ id: 'defuse', label: 'なだめる' }]));
    expect(before).toContain(bond.history);
    // その席以外の相関の history は出ない
    for (const seat of pairs) {
      if (seat === open) continue;
      expect(before).not.toContain(seat.bond!.history);
    }
    // 割り込んだ後は結果へ場所を譲る
    expect(recRoomHtml(banterCtxFor([]))).not.toContain(bond.history);
  });

  it('一人席には相関ブロックが出ない', () => {
    const roster = newRoster();
    for (const p of roster.pilots) if (p.id !== 'sable') p.status = 'transferred';
    const html = recRoomHtml({ ...hubCtx({ roster }), barSeats: seatsOf(roster) });
    expect(html).not.toContain('mc-bar-bond');
    expect(html).not.toContain('data-kind=');
  });
});

describe('T8-① 酒場 — 掛け合い', () => {
  /** 同席している席と、その二人の掛け合いを組み立てる */
  function banterCtx(over: { outcome?: string; replies?: Array<{ id: string; label: string }> } = {}) {
    const ctx = hubCtx();
    const seats = seatsOf(ctx.roster);
    const seat = banterSeats(seatPlan(ctx.roster))[0];
    const bond = seat.bond!;
    return {
      seat,
      bond,
      ctx: {
        ...ctx,
        barSeats: seats,
        barBanter: {
          bond: { a: bond.a, b: bond.b, kind: bond.kind, title: bond.title },
          turns: [
            { speaker: 'a' as const, pilotId: bond.a, text: '先に言っておく。' },
            { speaker: 'b' as const, pilotId: bond.b, text: '聞いていない。' },
            { speaker: 'player' as const, text: '二人とも落ち着け。' },
          ],
          replies: over.replies ?? [{ id: 'side-a', label: '片方に味方する' }],
          level: { label: '平行線', step: 2, max: 4 },
          reason: '直前の出撃: 二人とも生還した',
          outcome: over.outcome,
        },
        canBuyDrink: true,
      } satisfies HubContext,
    };
  }

  it('掛け合いの本文が席の中に出て、話者がコールサインで表示される', () => {
    const { bond, ctx } = banterCtx();
    const html = recRoomHtml(ctx);
    expect(html).toContain('先に言っておく。');
    expect(html).toContain('聞いていない。');
    expect(html).toContain('二人とも落ち着け。');
    // 話者は「相手」ではなくコールサイン。自分の発言だけ「自分」。
    expect(html).toContain(`<span class="mc-bar-turn-who">${callsignOf(bond.a)}</span>`);
    expect(html).toContain(`<span class="mc-bar-turn-who">${callsignOf(bond.b)}</span>`);
    expect(html).toContain('<span class="mc-bar-turn-who">自分</span>');
    expect(html).not.toContain('<span class="mc-bar-turn-who">相手</span>');
    expect(html).not.toContain('もう一人');
    // 話者ごとにクラスが分かれる
    expect(html).toContain('mc-bar-turn a');
    expect(html).toContain('mc-bar-turn b');
    expect(html).toContain('mc-bar-turn player');
    // 掛け合いが開いている席は active
    expect(html).toContain('mc-bar-seat active');
    // 二人の仲と、直前の出撃の理由
    expect(html).toContain('二人の仲 平行線');
    expect(html).toContain('直前の出撃: 二人とも生還した');
    expect(html).toContain('下の「→」から割り込む（1 択）。');
  });

  it('outcome があれば mc-bar-outcome が出る', () => {
    const withOutcome = recRoomHtml(banterCtx({ outcome: 'Sable +0.14 / Raven −0.07 / 二人の仲 −0.06' }).ctx);
    expect(withOutcome).toContain('mc-bar-outcome');
    expect(withOutcome).toContain('Sable +0.14 / Raven −0.07 / 二人の仲 −0.06');

    const without = recRoomHtml(banterCtx().ctx);
    expect(without).not.toContain('mc-bar-outcome');
  });

  it('介入が終わっていれば「もう口を挟む場面ではない。」と出す', () => {
    const html = recRoomHtml(banterCtx({ replies: [] }).ctx);
    expect(html).toContain('もう口を挟む場面ではない。');
    expect(html).not.toContain('から割り込む');
  });

  it('掛け合いは、そのペアが座っている席にだけ出る', () => {
    const { ctx } = banterCtx();
    const chunks = seatChunks(recRoomHtml(ctx));
    expect(chunks.filter((c) => c.includes('先に言っておく。'))).toHaveLength(1);
  });
});

describe('T8-① 酒場 — 噂・私語・立ち飲み・追悼', () => {
  it('rumors を渡すと出所ラベル付きで出る', () => {
    const ctx = hubCtx();
    const html = recRoomHtml({
      ...ctx,
      barSeats: seatsOf(ctx.roster),
      rumors: [
        { source: '整備科', text: '第三格納庫の照明がまだ直っていない。' },
        { source: '通信科', text: '中継塔からの定時連絡が二回抜けた。' },
      ],
    });
    expect(html).toContain('mc-rumor-src');
    expect(html).toContain('整備科');
    expect(html).toContain('第三格納庫の照明がまだ直っていない。');
    expect(html).toContain('通信科');
    expect(html).toContain('中継塔からの定時連絡が二回抜けた。');
    expect([...html.matchAll(/mc-rumor-src/g)]).toHaveLength(2);
  });

  it('rumors を渡さないときは従来の噂表示へ落ちる', () => {
    const ctx = hubCtx();
    for (const rumors of [undefined, []]) {
      const html = recRoomHtml({ ...ctx, barSeats: seatsOf(ctx.roster), rumors });
      expect(html).toContain('<h3>噂</h3>');
      expect(html).not.toContain('mc-rumor-src');
    }
  });

  it('gossip は、話しかけた席の該当する隊員の欄にだけ出る', () => {
    const ctx = hubCtx();
    const seats = seatsOf(ctx.roster);
    const solo = seats.find((s) => s.occupants.length === 1)!;
    const target = solo.occupants[0];
    const other = seats.flatMap((s) => s.occupants).find((p) => p.id !== target.id)!;
    const gossip = [
      { pilotId: target.id, text: 'あんたが奢った話は、もう全員が知っている。' },
      { pilotId: other.id, text: '近づいていない席の私語。' },
      { pilotId: 'nobody', text: '出てはいけない行。' },
    ];

    const html = recRoomHtml({
      ...ctx,
      barSeats: seats,
      barPilotId: target.id,
      barTalk: {
        pilotId: target.id,
        turns: [{ speaker: 'pilot', text: 'まあ、聞いていますよ。' }],
        replies: [],
        relation: { label: '顔見知り', step: 2, max: 4 },
      },
      gossip,
    });
    expect(html).toContain('mc-bar-gossip');
    expect(html).toContain('あんたが奢った話は、もう全員が知っている。');
    // 名簿にいない id の私語は出ない
    expect(html).not.toContain('出てはいけない行。');
    // 私語が出たのは話しかけた相手ぶんだけ
    expect([...html.matchAll(/mc-bar-gossip/g)]).toHaveLength(1);
    const chunk = seatChunks(html).find((c) => c.includes('mc-bar-gossip'))!;
    expect(chunk).toContain(callsignOf(target.id));
    expect(html).not.toContain('近づいていない席の私語。');

    // 誰にも話しかけていない状態では私語を出さない（部屋を一望する邪魔をしない）
    expect(recRoomHtml({ ...ctx, barSeats: seats, gossip })).not.toContain('mc-bar-gossip');
  });

  // 立ち飲みは独立ブロックではなく1行（`mc-bar-standing`）で出す。
  // 席が埋まっている＝立ち飲みが出るときに限ってパネルのはみ出しが増えるのを避けるため。
  it('barStanding に人がいると「立ったまま」の1行が出る', () => {
    const ctx = hubCtx();
    const seats = seatsOf(ctx.roster);
    const standing = ctx.roster.pilots.slice(0, 2);
    const html = recRoomHtml({ ...ctx, barSeats: seats, barStanding: standing });
    expect(html).toContain('mc-bar-standing');
    expect(html).toContain('立ったまま:');
    for (const p of standing) expect(html).toContain(callsignOf(p.id));
    expect(html).toContain('席が足りない。');

    // 立ち飲みが0名なら1行そのものを出さない
    for (const s of [undefined, []]) {
      expect(recRoomHtml({ ...ctx, barSeats: seats, barStanding: s })).not.toContain('mc-bar-standing');
    }
  });

  it('toasted の true / false / undefined で追悼欄の文が変わる', () => {
    const roster = newRoster();
    const dead = roster.pilots.find((p) => p.id === 'vesper')!;
    dead.status = 'dead';
    dead.diedIn = '灰冠回廊の封鎖突破';
    dead.diedChapter = 5;
    const base = { ...hubCtx({ roster }), barSeats: seatsOf(roster) };

    const on = recRoomHtml({ ...base, toasted: true });
    expect(on).toContain('空いた席 — 1 名');
    expect(on).toContain('灰冠回廊の封鎖突破');
    expect(on).toContain('第5章');
    expect(on).toContain('卓の端にグラスを置いた。');
    expect(on).not.toContain('席はそのままにしてある。');

    const off = recRoomHtml({ ...base, toasted: false });
    expect(off).toContain('席はそのままにしてある。');
    expect(off).not.toContain('卓の端にグラスを置いた。');

    const unknown = recRoomHtml(base);
    expect(unknown).toContain('空いた席 — 1 名');
    expect(unknown).not.toContain('卓の端にグラスを置いた。');
    expect(unknown).not.toContain('席はそのままにしてある。');
  });

  it('戦死者がいなければ追悼欄そのものが出ない', () => {
    const ctx = hubCtx();
    const html = recRoomHtml({ ...ctx, barSeats: seatsOf(ctx.roster), toasted: false });
    expect(html).not.toContain('空いた席');
  });
});

describe('T8-① 自室 — 相関と私信', () => {
  it('名簿行に「隊内」の相関が出る', () => {
    const roster = newRoster();
    shiftRelation(roster, 'tempest', 'orion', 0.8);
    const html = barracksHtml(hubCtx({ roster }));
    expect(html).toContain('隊内 ');
    // tempest の行に好敵手 Orion と、その仲の段階が出る
    expect(html).toContain('好敵手: Orion — 背中を預ける');
    // 名簿に来ていない相手は（未着任）
    expect(html).toContain('（未着任）');
    // 種類のラベルは pilotBonds.ts の定義から取る
    expect(html).toContain(`${PILOT_BOND_KINDS.loss.label}: `);
  });

  it('相関の相手が戦死していると「戦死」と出て、仲の段階は出さない', () => {
    const roster = newRoster();
    shiftRelation(roster, 'tempest', 'orion', 0.8);
    roster.pilots.find((p) => p.id === 'orion')!.status = 'dead';
    const html = barracksHtml(hubCtx({ roster }));
    expect(html).toContain('好敵手: <span class="ng">Orion（戦死）</span>');
    expect(html).not.toContain('好敵手: Orion — ');
    // 相関一覧の側も「もう動かない」と言う
    expect(bondBoardHtml(hubCtx({ roster }))).toContain('片方が戦死。この関係はもう動かない。');
  });

  it('bondBoardHtml の「隊内の相関」節が出る（在籍している組だけ）', () => {
    const roster = newRoster();
    const html = bondBoardHtml(hubCtx({ roster }));
    // 初期5名で両者が名簿にいる組み合わせだけが並ぶ
    const known = [
      ['tempest', 'orion'],
      ['vesper', 'sable'],
      ['vesper', 'orion'],
      ['aster', 'tempest'],
      ['sable', 'orion'],
    ];
    expect(html).toContain(`隊内の相関 — ${known.length} 組`);
    for (const [a, b] of known) {
      const bond = bondBetween(a, b)!;
      expect(html).toContain(bond.title);
    }
    // 名簿にいない相手（raven / solace / nova）の組は出さない
    expect(html).not.toContain(bondBetween('raven', 'solace')!.title);
  });

  it('mail を渡すと私信が並び、渡さないと「受信箱は空だ。」になる', () => {
    const ctx = hubCtx();
    const html = mailHtml({
      ...ctx,
      mail: [
        { from: '補給科', subject: '追加ミサイルの割当について', body: '次の帰艦で2発ぶん回します。' },
        { from: '医務室', subject: '定期健診の予約', body: '第三区画の窓口まで。' },
      ],
    });
    expect(html).toContain('私信 — 2 通');
    expect(html).toContain('追加ミサイルの割当について');
    expect(html).toContain('差出人: 補給科');
    expect(html).toContain('次の帰艦で2発ぶん回します。');
    expect(html).toContain('mc-mail');
    expect(html).toContain('data-mc-pager="quarters-mail"');

    // 私信は自室の本文へは積まない（独立画面）
    expect(barracksHtml({ ...ctx, mail: [{ from: 'x', subject: 'y', body: 'z' }] })).not.toContain('mc-mail');
    for (const mail of [undefined, []]) {
      const empty = mailHtml({ ...ctx, mail });
      expect(empty).toContain('受信箱は空だ。');
      expect(empty).not.toContain('mc-mail');
    }
  });
});

describe('T8-① 差し込まれた文字列を HTML として実行させない', () => {
  it('噂・私語・席・相関・酒保に <script> が来ても escapeHtml される', () => {
    const ctx = hubCtx();
    const seats = seatsOf(ctx.roster);
    const pair = seats.find((s) => s.occupants.length === 2)!;
    const dirty: BarSeatView[] = seats.map((s) =>
      s === pair
        ? { ...s, label: `窓際${XSS}`, note: XSS, bond: { ...s.bond!, title: XSS, history: XSS, kind: `"${XSS}` } }
        : s,
    );
    const html = recRoomHtml({
      ...ctx,
      barSeats: dirty,
      bartender: { name: XSS, line: XSS },
      rumors: [{ source: XSS, text: XSS }],
      gossip: [{ pilotId: pair.occupants[0].id, text: XSS }],
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    // data-kind の属性値も閉じられない（引用符が抜けない）
    expect(html).not.toContain('data-kind=""');
    expect(html).toContain('&quot;&lt;script&gt;');
  });

  it('私信に <script> が来ても escapeHtml される', () => {
    const html = mailHtml({ ...hubCtx(), mail: [{ from: XSS, subject: XSS, body: XSS }] });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
