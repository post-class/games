/**
 * T4-⑯ 敵エースとの関係を無線で作る。
 *
 * 検証するのは次の5点。
 * 1. エースを狙っているときだけ、通信メニューにエース宛の項目が出る（キーは増えない）
 * 2. 決闘が成立すると AI の挙動が実際に変わる（他機が自機を狙わず、撃たない）
 * 3. 決闘を断られる条件が効く
 * 4. 脱出ポッドを撃った／撃たなかったが記録され、再会時の第一声が変わる
 * 5. 旧セーブ（新フィールドが無い JSON）が読める
 */
import { Quaternion, Vector3 } from 'three';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ACES,
  aceAttitude,
  aceDef,
  aceFleetMemory,
  aceState,
  ACE_LOG_LIMIT,
  DUEL_MAX_WINGMEN,
  DUEL_MIN_OATH,
  evaluateDuelRequest,
  newAceStates,
  normalizeAceStates,
  recordAceContact,
  recordAceDuel,
  recordAceKill,
  recordAceNameExchange,
  recordAcePodExecuted,
  recordAcePodSpared,
  type AceState,
} from '../../src/content/aces';
import { aceDuelDeclineLine, aceGreetingLine, playerAceHailLine } from '../../src/content/dialogue';
import { shipDef } from '../../src/content/ships';
import { configureDuel, duelStandDown, newAi, resetDuel, updateAi } from '../../src/sim/ai';
import { spawnShip, World } from '../../src/world/world';
import { CommsMenu, type CommsAction } from '../../src/ui/CommsMenu';
import { installFakeDom, type FakeDom } from './fake-dom';
import { reseed } from '../../src/core/rng';

const DT = 1 / 60;

function facing(from: Vector3, to: Vector3): Quaternion {
  const dir = to.clone().sub(from).normalize();
  return new Quaternion().setFromUnitVectors(new Vector3(0, 0, -1), dir);
}

function stateOf(id: string): AceState {
  const states = newAceStates();
  return aceState(states, id)!;
}

// ───────── 1. 通信メニュー ─────────

describe('通信メニューのエース項目', () => {
  let dom: FakeDom;
  let picked: CommsAction[];
  let menu: CommsMenu;

  beforeEach(() => {
    dom = installFakeDom();
    picked = [];
    menu = new CommsMenu(document.body as unknown as HTMLElement, (a) => picked.push(a));
    menu.setOpen(true);
  });
  afterEach(() => {
    menu.dispose();
    dom.restore();
  });

  it('エースを狙っていないときは従来どおり6項目で、6番は挑発', () => {
    const items = menu.items();
    expect(items).toHaveLength(6);
    expect(items[5].label).toContain('挑発');
    expect(menu.aceChannelAvailable).toBe(false);
  });

  it('エースを狙っているときだけ6番がエース通信に入れ替わる（キーは増えない）', () => {
    menu.setAceTarget('カクシ');
    const items = menu.items();
    // 項目数は6のまま = 既存の comms1..comms6 に収まっている
    expect(items).toHaveLength(6);
    expect(items[5].label).toContain('カクシ');
    expect(items.some((i) => i.label.includes('挑発'))).toBe(false);
    expect(menu.aceChannelAvailable).toBe(true);
  });

  it('6番を選ぶとメニューは閉じず、1..4 でエース宛の3項目と戻るが選べる', () => {
    menu.setAceTarget('ラギティカ');
    menu.pickIndex(5);
    expect(menu.open).toBe(true);
    expect(menu.currentPage).toBe('ace');
    const items = menu.items();
    expect(items).toHaveLength(4);
    expect(items.map((i) => i.label)).toEqual([
      expect.stringContaining('名を名乗る'),
      '降伏を勧める',
      '決闘を申し込む',
      '戻る',
    ]);
    // ページ遷移は onPick へ流さない
    expect(picked).toHaveLength(0);
  });

  it('エースページから3つの通信を送れる', () => {
    menu.setAceTarget('ラギティカ');
    menu.pickIndex(5);
    menu.pickIndex(2);
    expect(picked).toEqual([{ kind: 'ace', ace: 'duel' }]);
    expect(menu.open).toBe(false);
  });

  it('「戻る」で主ページへ戻り、メニューは開いたまま', () => {
    menu.setAceTarget('フェン');
    menu.pickIndex(5);
    menu.pickIndex(3);
    expect(menu.currentPage).toBe('main');
    expect(menu.open).toBe(true);
    expect(picked).toHaveLength(0);
  });

  it('エースを外すとエースページから主ページへ戻る', () => {
    menu.setAceTarget('フェン');
    menu.pickIndex(5);
    expect(menu.currentPage).toBe('ace');
    menu.setAceTarget(undefined);
    expect(menu.currentPage).toBe('main');
    expect(menu.items()[5].label).toContain('挑発');
  });

  it('メニューを開き直すと主ページから始まる', () => {
    menu.setAceTarget('フェン');
    menu.pickIndex(5);
    menu.setOpen(false);
    menu.setOpen(true);
    expect(menu.currentPage).toBe('main');
  });
});

// ───────── 2. 決闘が AI を変える ─────────

describe('決闘が AI の挙動を変える', () => {
  beforeEach(() => {
    reseed(0x51ed5eed);
    resetDuel();
  });
  afterEach(() => resetDuel());

  /** 自機1機 + 帝国のエース1機 + 帝国の僚機2機。 */
  function build() {
    const world = new World();
    const playerPos = new Vector3(0, 0, 0);
    const enemyPos = new Vector3(0, 0, -1200);
    const player = spawnShip(world, {
      def: shipDef('rapier'),
      faction: 'confed',
      pos: playerPos,
      quat: facing(playerPos, enemyPos),
      speed: 0,
    });
    world.playerId = player.id;
    const ace = spawnShip(world, {
      def: shipDef('kf06-talon'),
      faction: 'kilrathi',
      pos: enemyPos,
      quat: facing(enemyPos, playerPos),
      speed: 0,
      ai: newAi(0.8),
      ace: true,
    });
    const escorts = [0, 1].map((i) =>
      spawnShip(world, {
        def: shipDef('kf03-greyhaul'),
        faction: 'kilrathi',
        pos: new Vector3(300 + i * 200, 0, -1300),
        quat: facing(new Vector3(300 + i * 200, 0, -1300), playerPos),
        speed: 0,
        ai: newAi(0.6),
      }),
    );
    return { world, player, ace, escorts };
  }

  it('決闘なしでは、エースの僚機も自機を狙う', () => {
    const { world, player, escorts } = build();
    for (let i = 0; i < 120; i++) updateAi(world, DT, { maxAttackersOnPlayer: 4 });
    expect(escorts.some((e) => e.ai!.targetId === player.id)).toBe(true);
  });

  it('決闘が成立すると、当事者以外は自機を狙わず撃たない', () => {
    const { world, player, ace, escorts } = build();
    configureDuel({
      duellistId: ace.id,
      opponentId: player.id,
      spareHullRatio: 0.12,
      measureRange: 700,
      standDownFaction: 'kilrathi',
    });
    for (let i = 0; i < 240; i++) updateAi(world, DT, { maxAttackersOnPlayer: 4 });
    for (const e of escorts) {
      expect(e.ai!.targetId).not.toBe(player.id);
      // 目標が自機でない = 引き金も自機へは引かれない
      expect(e.input!.firePrimary && e.ai!.targetId === player.id).toBe(false);
    }
    // 当事者（エース）は自機に付き合う
    expect(ace.ai!.targetId).toBe(player.id);
  });

  it('duelStandDown は当事者と他陣営には効かない', () => {
    const { world, player, ace, escorts } = build();
    configureDuel({
      duellistId: ace.id,
      opponentId: player.id,
      standDownFaction: 'kilrathi',
    });
    expect(duelStandDown(ace, player.id)).toBe(false);
    expect(duelStandDown(escorts[0], player.id)).toBe(true);
    // 自機以外を狙うのは自由
    expect(duelStandDown(escorts[0], escorts[1].id)).toBe(false);
    void world;
  });

  it('standDownFaction を指定しなければ従来どおり（既存ミッションの決闘は変わらない）', () => {
    const { world, player, ace, escorts } = build();
    configureDuel({ duellistId: ace.id, opponentId: player.id });
    expect(duelStandDown(escorts[0], player.id)).toBe(false);
    for (let i = 0; i < 120; i++) updateAi(world, DT, { maxAttackersOnPlayer: 4 });
    expect(escorts.some((e) => e.ai!.targetId === player.id)).toBe(true);
  });

  it('AI は脱出ポッドを目標に選ばない', () => {
    const world = new World();
    const enemyPos = new Vector3(0, 0, 0);
    const podPos = new Vector3(0, 0, -600);
    const enemy = spawnShip(world, {
      def: shipDef('kf03-greyhaul'),
      faction: 'kilrathi',
      pos: enemyPos,
      quat: facing(enemyPos, podPos),
      speed: 0,
      ai: newAi(0.6),
    });
    const pod = spawnShip(world, {
      def: shipDef('rapier'),
      faction: 'confed',
      pos: podPos,
      speed: 0,
    });
    pod.ship!.ejected = true;
    for (let i = 0; i < 120; i++) updateAi(world, DT);
    expect(enemy.ai!.targetId).toBeUndefined();
    expect(enemy.input!.firePrimary).toBe(false);
  });
});

// ───────── 3. 断られる条件 ─────────

describe('決闘を断られる条件', () => {
  const ragitika = aceDef('ragitika')!;
  const base = () => ({
    def: ragitika,
    state: stateOf('ragitika'),
    oath: 60,
    wingmen: 0,
    namedThisSortie: true,
    fleet: { spared: 0, executed: 0 },
  });

  it('書式を踏めば受ける', () => {
    expect(evaluateDuelRequest(base())).toEqual({ accepted: true });
  });

  it('決闘の項目を持たない相手は受けない（急進派・近衛隊長）', () => {
    for (const id of ['dakhas', 'fen', 'seiraku']) {
      const def = aceDef(id)!;
      expect(evaluateDuelRequest({ ...base(), def, state: stateOf(id) })).toEqual({
        accepted: false,
        reason: 'no-challenge-rule',
      });
    }
  });

  it('名乗る前に申し込むと断られる', () => {
    expect(evaluateDuelRequest({ ...base(), namedThisSortie: false })).toEqual({
      accepted: false,
      reason: 'name-first',
    });
  });

  it('僚機を連れすぎていると断られる', () => {
    expect(evaluateDuelRequest({ ...base(), wingmen: DUEL_MAX_WINGMEN })).toEqual({
      accepted: true,
    });
    expect(evaluateDuelRequest({ ...base(), wingmen: DUEL_MAX_WINGMEN + 1 })).toEqual({
      accepted: false,
      reason: 'too-many-wingmen',
    });
  });

  it('誓約値が低いと断られる', () => {
    expect(evaluateDuelRequest({ ...base(), oath: DUEL_MIN_OATH })).toEqual({ accepted: true });
    expect(evaluateDuelRequest({ ...base(), oath: DUEL_MIN_OATH - 1 })).toEqual({
      accepted: false,
      reason: 'low-oath',
    });
  });

  it('座席を撃った実績があると断られる', () => {
    expect(
      evaluateDuelRequest({ ...base(), fleet: { spared: 3, executed: 1 } }),
    ).toEqual({ accepted: false, reason: 'executed-pods' });
  });

  it('断りの文面は人物の口調と理由の一句でできている', () => {
    const line = aceDuelDeclineLine(ragitika, 'name-first');
    expect(line).toContain(ragitika.voice.duelDecline);
    expect(line).toContain('まず名だ');
    // 急進派は口調が違う
    expect(aceDuelDeclineLine(aceDef('fen')!, 'no-challenge-rule')).not.toContain(
      ragitika.voice.duelDecline,
    );
  });

  it('こちらの送信文はどの種類でも1行返る', () => {
    for (const kind of ['name', 'surrender', 'duel'] as const) {
      expect(playerAceHailLine(kind).length).toBeGreaterThan(0);
    }
  });
});

// ───────── 4. ポッドの選択と再会 ─────────

describe('脱出ポッドの選択が次の再会を変える', () => {
  it('撃たなかった相手は生き残り、次の章で会える', () => {
    const states = newAceStates();
    const s = aceState(states, 'ragitika')!;
    recordAceKill(s);
    expect(s.status).toBe('killed');
    recordAcePodSpared(s, 'ch05');
    expect(s.spared).toBe(1);
    // 座席が残れば人物は回収される = 再出現できる
    expect(s.status).toBe('active');
    expect(s.log?.at(-1)).toEqual({ kind: 'spared', mission: 'ch05' });
  });

  it('撃った相手は二度と出てこない', () => {
    const s = stateOf('ragitika');
    recordAceKill(s);
    recordAcePodExecuted(s, 'ch05');
    expect(s.executed).toBe(1);
    expect(s.status).toBe('killed');
  });

  it('態度は 初対面 → 顔見知り → 借り → 恨み の順で切り替わる', () => {
    const fresh = stateOf('ragitika');
    expect(aceAttitude(fresh, { spared: 0, executed: 0 })).toBe('unmet');

    const met = stateOf('ragitika');
    met.encounters = 2;
    expect(aceAttitude(met, { spared: 0, executed: 0 })).toBe('known');

    const escaped = stateOf('ragitika');
    escaped.encounters = 2;
    escaped.escaped = 1;
    expect(aceAttitude(escaped, { spared: 0, executed: 0 })).toBe('wary');

    const spared = stateOf('ragitika');
    spared.encounters = 1;
    spared.spared = 1;
    expect(aceAttitude(spared, { spared: 1, executed: 0 })).toBe('debt');

    // 誰かの座席を撃っていれば、見逃した相手でも態度は恨みへ寄る
    expect(aceAttitude(spared, { spared: 1, executed: 1 })).toBe('grudge');
  });

  it('第一声が態度で変わり、同じエースでも別の文になる', () => {
    const def = aceDef('ragitika')!;
    const fresh = stateOf('ragitika');
    const first = aceGreetingLine(def, fresh, { spared: 0, executed: 0 });

    const spared = stateOf('ragitika');
    spared.encounters = 1;
    spared.spared = 1;
    const debt = aceGreetingLine(def, spared, { spared: 1, executed: 0 });

    const grudge = aceGreetingLine(def, spared, { spared: 1, executed: 2 });

    expect(new Set([first, debt, grudge]).size).toBe(3);
    expect(debt).toContain('撃たなかった');
    expect(grudge).toContain('忘れない');
  });

  it('やりとりが積み上がると第一声に一句足される', () => {
    const def = aceDef('caxki')!;
    const s = stateOf('caxki');
    s.encounters = 2;
    const plain = aceGreetingLine(def, s, { spared: 0, executed: 0 });
    recordAceNameExchange(s, 'ch03');
    const named = aceGreetingLine(def, s, { spared: 0, executed: 0 });
    recordAceDuel(s, true, 'ch05');
    const dueled = aceGreetingLine(def, s, { spared: 0, executed: 0 });
    expect(named).not.toBe(plain);
    expect(named).toContain('記録にある');
    expect(dueled).toContain('書式どおり');
    expect(s.namesExchanged).toBe(1);
    expect(s.duelsAccepted).toBe(1);
  });

  it('やりとりの記録は上限で打ち切られる（セーブが膨らまない）', () => {
    const s = stateOf('fen');
    for (let i = 0; i < ACE_LOG_LIMIT + 5; i++) recordAceContact(s, 'name', `m${i}`);
    expect(s.log).toHaveLength(ACE_LOG_LIMIT);
    expect(s.log?.[0].mission).toBe('m5');
  });

  it('艦隊全体の記憶は全エースの合計', () => {
    const states = newAceStates();
    recordAcePodSpared(aceState(states, 'ragitika')!);
    recordAcePodSpared(aceState(states, 'caxki')!);
    recordAcePodExecuted(aceState(states, 'fen')!);
    expect(aceFleetMemory(states)).toEqual({ spared: 2, executed: 1 });
  });

  it('全エースが口調データを持っている', () => {
    for (const ace of ACES) {
      const v = ace.voice;
      for (const line of [
        v.name,
        v.surrender,
        v.duelAccept,
        v.duelDecline,
        v.greetFirst,
        v.greetKnown,
        v.greetWary,
        v.greetDebt,
        v.greetGrudge,
      ]) {
        expect(line.length).toBeGreaterThan(0);
      }
    }
    // 口調が使い回しになっていない
    expect(new Set(ACES.map((a) => a.voice.greetFirst)).size).toBe(ACES.length);
  });
});

// ───────── 5. 旧セーブの互換 ─────────

describe('旧セーブとの互換', () => {
  it('新フィールドが無い JSON を読んでも既定値が入る', () => {
    const legacy = JSON.parse(
      JSON.stringify([
        { id: 'ragitika', encounters: 3, kills: 0, skill: 0.9, status: 'active', escaped: 2 },
        // 旧id も従来どおり新idへ移行する
        { id: 'bhurak', encounters: 1, kills: 1, skill: 0.8, status: 'killed', escaped: 0 },
      ]),
    );
    const states = normalizeAceStates(legacy);
    const r = aceState(states, 'ragitika')!;
    expect(r.encounters).toBe(3);
    expect(r.escaped).toBe(2);
    expect(r.spared).toBe(0);
    expect(r.executed).toBe(0);
    expect(r.duelsAccepted).toBe(0);
    expect(r.duelsDeclined).toBe(0);
    expect(r.namesExchanged).toBe(0);
    expect(r.log).toEqual([]);
    const caxki = aceState(states, 'caxki')!;
    expect(caxki.status).toBe('killed');
    expect(caxki.spared).toBe(0);
    // 新フィールドを含む全エース分が返る
    expect(states).toHaveLength(ACES.length);
  });

  it('壊れた log は捨てて空配列にする', () => {
    const states = normalizeAceStates([
      { id: 'fen', encounters: 1, log: [{ kind: 'unknown' }, 'x', null, { kind: 'spared', mission: 'ch05' }] },
    ]);
    expect(aceState(states, 'fen')!.log).toEqual([{ kind: 'spared', mission: 'ch05' }]);
  });

  it('書き出して読み直しても値が保たれる', () => {
    const states = newAceStates();
    const s = aceState(states, 'ragitika')!;
    recordAceNameExchange(s, 'ch05');
    recordAceDuel(s, true, 'ch05');
    recordAceKill(s);
    recordAcePodSpared(s, 'ch05');
    const round = normalizeAceStates(JSON.parse(JSON.stringify(states)));
    const back = aceState(round, 'ragitika')!;
    expect(back.namesExchanged).toBe(1);
    expect(back.duelsAccepted).toBe(1);
    expect(back.spared).toBe(1);
    expect(back.status).toBe('active');
    expect(back.log?.map((l) => l.kind)).toEqual(['name', 'duel-accepted', 'killed', 'spared']);
  });
});
