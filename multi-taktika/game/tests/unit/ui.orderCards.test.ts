/**
 * T-M12-04: 令カードパネルの判定部分（`05§8` の 8 項目 / `05§10` / `06§4` / 手順書 §16-4）
 *
 * jsdom を入れていないので **DOM を触らない純関数だけ**を検算する。
 *
 * ここで守りたい性質:
 *  1. 基本 6 枚 + **その文明の固有令 1 枚**（他文明の固有令は出さない / 押せない）
 *  2. キーボード 1〜6（+ 固有令 7）と並びが一対一（`05§8`）
 *  3. 固有令は金の縁（`civUnique` フラグが立つ。色は CSS 側）
 *  4. 「選択中」は**発効済みの令だけ**。伝達中は `pending` で、**先行反映しない**（§16-4）
 *  5. 砂時計が出る（遅延 = 令が流れている間 / 間隔 = 次の令まで）
 *  6. 二重旗で上下 2 段（下段の令が使えるようになる）
 *  7. `canSetOrder` が `sim/command.ts` の拒否条件と一致する（押せるのに効かないを防ぐ）
 */

import { describe, expect, it } from 'vitest';
import type { CivId } from '@/shared/types';
import { applyCommands } from '@/sim/command';
import { TICK_RATE, cfgNum } from '@/sim/core/config';
import { ORDER_DEFS, techIndex } from '@/sim/core/defs';
import { markModifiersDirty } from '@/sim/core/effects';
import { FX_ONE, fx, fxFromInt } from '@/sim/core/fx';
import { createWorld, getFront, MAX_FRONTS, type Front, type World } from '@/sim/core/world';
import { orderDelivery } from '@/sim/systems/orderDelivery';
import {
  CardReason,
  CARD_REASON_TEXT,
  OrderPendingTracker,
  basicOrderDefs,
  buildOrderCards,
  canSetOrder,
  civOrderDef,
  hasDoubleFlag,
  hourglassInputFor,
  hourglassState,
  setOrderCommand,
  switchIntervalTicks,
} from '@/ui/hud/orderCards';

const MAP = 200;

function makeWorld(civ: CivId = 'roma'): World {
  const w = createWorld({
    seed: 4,
    playerCount: 2,
    mapWidthTiles: MAP,
    mapHeightTiles: MAP,
    entityCapacity: 256,
    civs: [civ, 'yamato'],
  });
  w.map.starts[0] = fxFromInt(20);
  w.map.starts[1] = fxFromInt(20);
  w.map.starts[2] = fxFromInt(180);
  w.map.starts[3] = fxFromInt(180);
  for (const pl of w.players) pl.frontSlots = MAX_FRONTS;
  return w;
}

function makeFront(w: World, owner: number, slot: number, tx = 60, ty = 60): Front {
  const f = getFront(w, owner, slot)!;
  f.active = true;
  f.x = fxFromInt(tx);
  f.y = fxFromInt(ty);
  f.radius = fx(cfgNum('front.spawnRadiusTiles'));
  return f;
}

function research(w: World, p: number, techId: string): void {
  w.players[p]!.researched[techIndex(techId)] = 1;
  markModifiersDirty(w, p);
}

// ---------------------------------------------------------------------------
// `05§8`: 基本 6 + 固有 1、キーと並びが一対一
// ---------------------------------------------------------------------------

describe('`05§8`: 基本 6 枚 + 文明固有 1 枚', () => {
  it('基本 6 枚はキー 1〜6 の順（突撃/包囲/死守/略奪/建設/後退）', () => {
    const defs = basicOrderDefs();
    expect(defs.map((d) => d.key)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(defs.map((d) => d.name)).toEqual([
      '突撃',
      '包囲',
      '死守',
      '略奪',
      '建設',
      '後退',
    ]);
  });

  it('固有令はどの文明も key = 7（`Shift`+`7`）で、1 文明 1 枚', () => {
    for (const d of ORDER_DEFS.filter((x) => x.civ !== null)) {
      expect(d.key).toBe(7);
    }
    const roma = civOrderDef('roma');
    expect(roma?.name).toBe('方陣');
    expect(civOrderDef('mongol')?.name).toBe('遊撃');
  });

  it('パネルは 7 枚で、他文明の固有令は 1 枚も混ざらない', () => {
    const w = makeWorld('roma');
    makeFront(w, 0, 1);
    const cards = buildOrderCards(w, 0, 1);
    expect(cards).toHaveLength(7);
    expect(cards.map((c) => c.key)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const unique = cards.filter((c) => c.civUnique);
    expect(unique).toHaveLength(1);
    expect(unique[0]!.name).toBe('方陣'); // ローマ
    expect(cards.some((c) => c.name === '遊撃')).toBe(false); // モンゴルの固有令
  });

  it('`05§8-8`: 固有令だけ `civUnique`（名前プレートの金の縁の根拠）', () => {
    const w = makeWorld('mongol');
    makeFront(w, 0, 1);
    const cards = buildOrderCards(w, 0, 1);
    expect(cards.filter((c) => c.civUnique).map((c) => c.name)).toEqual(['遊撃']);
    expect(cards.filter((c) => !c.civUnique)).toHaveLength(6);
  });

  it('他文明の固有令は理由「文明制限」で押せない（`05§15` の 3 種のうち 1 つ）', () => {
    const w = makeWorld('roma');
    makeFront(w, 0, 1);
    const mongolOrder = ORDER_DEFS.find((d) => d.civ === 'mongol')!;
    expect(canSetOrder(w, 0, 1, mongolOrder)).toBe(CardReason.CivRestricted);
    expect(CARD_REASON_TEXT[CardReason.CivRestricted]).toContain('文明制限');
    expect(setOrderCommand(w, 0, 1, mongolOrder.id)).toBeNull();
  });

  it('カードには一行説明が付く（`05§8` の各カードの本文）', () => {
    const w = makeWorld();
    makeFront(w, 0, 1);
    const charge = buildOrderCards(w, 0, 1).find((c) => c.order === 'charge')!;
    expect(charge.note).toContain('最も近い敵');
  });
});

// ---------------------------------------------------------------------------
// 戦域が無ければ使えない（`05§7-7`）
// ---------------------------------------------------------------------------

describe('`05§7-7`: 枠が余っていても戦域が立っていなければ使えない', () => {
  it('戦域を立てていないスロットは全カードが押せない', () => {
    const w = makeWorld();
    const cards = buildOrderCards(w, 0, 1);
    expect(cards).toHaveLength(7);
    expect(cards.every((c) => !c.enabled)).toBe(true);
    expect(cards[0]!.reason).toBe(CardReason.NoFront);
  });

  it('未解禁のスロットは理由が「未解禁」になる', () => {
    const w = makeWorld();
    w.players[0]!.frontSlots = 2;
    makeFront(w, 0, 5); // 立ってはいるが枠の外
    const cards = buildOrderCards(w, 0, 5);
    expect(cards[0]!.reason).toBe(CardReason.SlotLocked);
  });

  it('戦域が立てば上段の令は押せる（最初の令は切り替え待ちなし）', () => {
    const w = makeWorld();
    makeFront(w, 0, 1);
    const cards = buildOrderCards(w, 0, 1);
    const charge = cards.find((c) => c.order === 'charge')!;
    expect(charge.enabled).toBe(true);
    expect(charge.reason).toBe(CardReason.Ok);
  });
});

// ---------------------------------------------------------------------------
// `05§8-7` / §16-4: 選択中 = 発効済みだけ。先行反映しない
// ---------------------------------------------------------------------------

describe('`05§8-7` / 手順書 §16-4: 切り替えは即時ではない', () => {
  it('setOrder を出した直後は selected にならず pending になる（点線と砂時計の側）', () => {
    const w = makeWorld();
    const f = makeFront(w, 0, 1, 120, 120); // 本陣(20,20) から遠い
    const cmd = setOrderCommand(w, 0, 1, 'charge')!;
    expect(cmd).toEqual({ t: 'setOrder', p: 0, front: 1, order: 'charge', tier: 'upper' });
    applyCommands(w, [cmd]);

    const cards = buildOrderCards(w, 0, 1);
    const charge = cards.find((c) => c.order === 'charge')!;
    // **まだ「セット済み」ではない**
    expect(charge.selected).toBe(false);
    expect(charge.pending).toBe(true);
    expect(f.order).toBeNull();
    expect(f.pendingOrder).not.toBeNull();
  });

  it('伝達中は全カードが押せない（`06§4`「連打しないでください」）', () => {
    const w = makeWorld();
    makeFront(w, 0, 1, 120, 120);
    applyCommands(w, [setOrderCommand(w, 0, 1, 'charge')!]);
    const cards = buildOrderCards(w, 0, 1);
    expect(cards.every((c) => !c.enabled)).toBe(true);
    expect(cards[0]!.reason).toBe(CardReason.Delivering);
    // 2 枚目を押しても Command は出ない（先行反映も上書きもしない）
    expect(setOrderCommand(w, 0, 1, 'hold')).toBeNull();
  });

  it('届いた瞬間に selected へ変わる（`orderDelivery` を通したあと）', () => {
    const w = makeWorld();
    const f = makeFront(w, 0, 1, 120, 120);
    applyCommands(w, [setOrderCommand(w, 0, 1, 'charge')!]);
    const deliverAt = f.pendingOrder!.deliverAtTick;
    expect(deliverAt).toBeGreaterThan(w.tick);

    // 届く 1 tick 前: まだ pending
    w.tick = deliverAt - 1;
    orderDelivery(w);
    expect(buildOrderCards(w, 0, 1).find((c) => c.order === 'charge')!.selected).toBe(false);

    // 届いた: selected
    w.tick = deliverAt;
    orderDelivery(w);
    const charge = buildOrderCards(w, 0, 1).find((c) => c.order === 'charge')!;
    expect(charge.selected).toBe(true);
    expect(charge.pending).toBe(false);
  });

  it('離反した戦域は令を渡せない（`07§10`）', () => {
    const w = makeWorld();
    const f = makeFront(w, 0, 1);
    f.defected = true;
    expect(buildOrderCards(w, 0, 1)[0]!.reason).toBe(CardReason.Defected);
  });
});

// ---------------------------------------------------------------------------
// `05§10` 砂時計
// ---------------------------------------------------------------------------

describe('`05§10`: カード切り替え時の砂時計', () => {
  it('切り替え間隔は 6 秒、研究「早馬」で 4.2 秒（= 105 tick）', () => {
    const w = makeWorld();
    expect(switchIntervalTicks(w, 0)).toBe(Math.round(6 * TICK_RATE)); // 150
    research(w, 0, 'hayaba');
    expect(switchIntervalTicks(w, 0)).toBe(105); // 4.2 秒 × 25
  });

  it('伝達中は kind = delay。残り時間が減り、進捗が 0 → 1 に進む', () => {
    const st0 = hourglassState({
      hasPending: true,
      pendingStartTick: 100,
      deliverAtTick: 200,
      hasOrder: false,
      lastSwitchTick: 0,
      switchIntervalTicks: 150,
      nowTick: 100,
    });
    expect(st0.kind).toBe('delay');
    expect(st0.progress).toBe(0);
    expect(st0.remainTicks).toBe(100);
    expect(st0.remainMs).toBe(Math.round((100 * 1000) / TICK_RATE)); // 4000ms

    const st1 = hourglassState({
      hasPending: true,
      pendingStartTick: 100,
      deliverAtTick: 200,
      hasOrder: false,
      lastSwitchTick: 0,
      switchIntervalTicks: 150,
      nowTick: 175,
    });
    expect(st1.progress).toBeCloseTo(0.75, 6);
    expect(st1.remainTicks).toBe(25);
  });

  it('伝達が終わっていて切り替え待ちなら kind = interval', () => {
    const st = hourglassState({
      hasPending: false,
      pendingStartTick: 0,
      deliverAtTick: 0,
      hasOrder: true,
      lastSwitchTick: 1000,
      switchIntervalTicks: 150,
      nowTick: 1100,
    });
    expect(st.kind).toBe('interval');
    expect(st.remainTicks).toBe(50);
  });

  it('待ちが無ければ砂時計を出さない', () => {
    const st = hourglassState({
      hasPending: false,
      pendingStartTick: 0,
      deliverAtTick: 0,
      hasOrder: true,
      lastSwitchTick: 1000,
      switchIntervalTicks: 150,
      nowTick: 1200,
    });
    expect(st.kind).toBe('none');
  });

  it('遅延 > 間隔 の優先（伝達中は「まだ届いていない」を先に出す）', () => {
    const st = hourglassState({
      hasPending: true,
      pendingStartTick: 1000,
      deliverAtTick: 1050,
      hasOrder: true,
      lastSwitchTick: 1000,
      switchIntervalTicks: 150,
      nowTick: 1010,
    });
    expect(st.kind).toBe('delay');
  });

  it('World から組んだ入力でも同じ結論になる（`hourglassInputFor`）', () => {
    const w = makeWorld();
    const f = makeFront(w, 0, 1, 120, 120);
    applyCommands(w, [setOrderCommand(w, 0, 1, 'charge')!]);
    const tracker = new OrderPendingTracker();
    tracker.observe(w, [f]);
    const inp = hourglassInputFor(w, 0, f, tracker.startOf(1));
    expect(inp.hasPending).toBe(true);
    expect(inp.pendingStartTick).toBe(w.tick);
    const st = hourglassState(inp);
    expect(st.kind).toBe('delay');
    expect(st.progress).toBe(0);
    expect(st.remainTicks).toBe(f.pendingOrder!.deliverAtTick - w.tick);
  });

  it('切り替え間隔の待ちが残っている間はカードが押せない', () => {
    const w = makeWorld();
    const f = makeFront(w, 0, 1, 25, 25); // 本陣のすぐ隣（遅延は短い）
    applyCommands(w, [setOrderCommand(w, 0, 1, 'charge')!]);
    w.tick = f.pendingOrder!.deliverAtTick;
    orderDelivery(w);
    expect(f.order).toBe('charge');
    // 直後は切り替え待ち
    expect(buildOrderCards(w, 0, 1)[0]!.reason).toBe(CardReason.SwitchCooldown);
    // 6 秒経てば押せる
    w.tick += switchIntervalTicks(w, 0);
    expect(buildOrderCards(w, 0, 1).find((c) => c.order === 'hold')!.enabled).toBe(true);
  });

  it('伝達の観測は令が入れ替わるたびに開始 tick を打ち直す', () => {
    const w = makeWorld();
    const f = makeFront(w, 0, 1, 120, 120);
    const tracker = new OrderPendingTracker();
    applyCommands(w, [setOrderCommand(w, 0, 1, 'charge')!]);
    tracker.observe(w, [f]);
    expect(tracker.startOf(1)).toBe(0);

    // 届いて、間隔が明けて、次の令を出す
    w.tick = f.pendingOrder!.deliverAtTick;
    orderDelivery(w);
    tracker.observe(w, [f]);
    expect(tracker.startOf(1)).toBeNull(); // 伝達中でなくなったら忘れる

    w.tick += switchIntervalTicks(w, 0);
    applyCommands(w, [setOrderCommand(w, 0, 1, 'hold')!]);
    tracker.observe(w, [f]);
    expect(tracker.startOf(1)).toBe(w.tick);
  });
});

// ---------------------------------------------------------------------------
// `05§10` / `07§4` 二重旗
// ---------------------------------------------------------------------------

describe('`05§10` / `07§4`: 二重旗でスロットが上下 2 段に割れる', () => {
  it('研究前は単旗、研究後は二重旗', () => {
    const w = makeWorld();
    expect(hasDoubleFlag(w, 0)).toBe(false);
    research(w, 0, 'nijuuhata');
    expect(hasDoubleFlag(w, 0)).toBe(true);
  });

  it('下段の令（包囲・略奪）は二重旗を取るまで押せない（`sim/command.ts` と一致）', () => {
    const w = makeWorld();
    makeFront(w, 0, 1);
    const siege = ORDER_DEFS.find((d) => d.id === 'siege')!;
    expect(siege.tier).toBe('lower');
    expect(canSetOrder(w, 0, 1, siege)).toBe(CardReason.NeedDoubleFlag);
    // sim も同じ判断（Command を投げても何も起きない）
    applyCommands(w, [{ t: 'setOrder', p: 0, front: 1, order: 'siege', tier: 'lower' }]);
    expect(getFront(w, 0, 1)!.pendingOrder).toBeNull();

    research(w, 0, 'nijuuhata');
    expect(canSetOrder(w, 0, 1, siege)).toBe(CardReason.Ok);
  });

  it('二重旗なら上段と下段が同時に立つ（死守 + 包囲）', () => {
    const w = makeWorld();
    research(w, 0, 'nijuuhata');
    const f = makeFront(w, 0, 1, 25, 25);

    applyCommands(w, [setOrderCommand(w, 0, 1, 'hold')!]);
    w.tick = f.pendingOrder!.deliverAtTick;
    orderDelivery(w);
    w.tick += switchIntervalTicks(w, 0);

    applyCommands(w, [setOrderCommand(w, 0, 1, 'siege')!]);
    w.tick = f.pendingOrder!.deliverAtTick;
    orderDelivery(w);

    expect(f.order).toBe('hold');
    expect(f.orderLower).toBe('siege');
    const cards = buildOrderCards(w, 0, 1);
    expect(cards.filter((c) => c.selected).map((c) => c.order).sort()).toEqual([
      'hold',
      'siege',
    ]);
  });

  it('同じ段は重ねられない（上段を上書きする。`07§4`）', () => {
    const w = makeWorld();
    research(w, 0, 'nijuuhata');
    const f = makeFront(w, 0, 1, 25, 25);
    f.order = 'hold';
    f.lastSwitchTick = -10_000;
    applyCommands(w, [setOrderCommand(w, 0, 1, 'charge')!]);
    w.tick = f.pendingOrder!.deliverAtTick;
    orderDelivery(w);
    expect(f.order).toBe('charge'); // 上書き
    expect(f.orderLower).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// `06§12`: キーボードを使わない運用（キー番号 ↔ カードの一対一）
// ---------------------------------------------------------------------------

describe('`06§12`: キー番号とカードが一対一（マウスだけでも同じ結果になる）', () => {
  it('キー番号 1〜7 でカードが一意に引ける', () => {
    const w = makeWorld('yamato');
    makeFront(w, 0, 1);
    const cards = buildOrderCards(w, 0, 1);
    for (let n = 1; n <= 7; n++) {
      expect(cards.filter((c) => c.key === n)).toHaveLength(1);
    }
    expect(cards.find((c) => c.key === 7)!.name).toBe('陣立て'); // ヤマトの固有令
  });

  it('キー番号でもクリックでも同じ Command になる', () => {
    const w = makeWorld();
    makeFront(w, 0, 1);
    const byKey = buildOrderCards(w, 0, 1).find((c) => c.key === 3)!;
    expect(byKey.order).toBe('hold');
    expect(setOrderCommand(w, 0, 1, byKey.order)).toEqual({
      t: 'setOrder',
      p: 0,
      front: 1,
      order: 'hold',
      tier: 'upper',
    });
  });

  it('優勢度など sim の状態を書き換えない（読み取り専用。手順書 §3.1）', () => {
    const w = makeWorld();
    const f = makeFront(w, 0, 1);
    f.advantage = FX_ONE / 2;
    const before = {
      order: f.order,
      lower: f.orderLower,
      pending: f.pendingOrder,
      adv: f.advantage,
      tick: w.tick,
    };
    buildOrderCards(w, 0, 1);
    setOrderCommand(w, 0, 1, 'charge'); // Command を作るだけ。適用はしない
    expect({
      order: f.order,
      lower: f.orderLower,
      pending: f.pendingOrder,
      adv: f.advantage,
      tick: w.tick,
    }).toEqual(before);
  });
});
