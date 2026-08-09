/**
 * T-M16-02: ミッションが**プレイ可能**であること（進行と勝敗判定）
 *
 * 完了条件「5 ミッションが `06§13` の順序どおりで、プレイ可能」の検証。
 * ここでは「**勝利条件が満たせる状況が作れる**」ことを、令と生産の `Command` を
 * 実際に出して確かめる（World を直接いじって勝たせるのでは意味がないため）。
 *
 * 併せて
 *  - スクリプトイベント（`atTick` / `frontOpened`）が発火してヒントと増援が出る
 *  - **負けても例外にならず `defeat` になるだけ**（ゲームオーバーにしない。T-M16-03）
 *  - 同じ入力列からは同じ World になる（`Date.now()` を使っていないことの裏取り）
 * を確認する。
 */

import { describe, expect, it } from 'vitest';

import { createMissionRun, mainMissionsOfChapter, missionById } from '@/campaign';
import type { MissionRun } from '@/campaign';
import { EntityKind } from '@/shared/types';
import type { OrderId } from '@/shared/types';
import type { Command } from '@/sim';
import { MAX_FRONTS, formatHash, hashWorld, idOfIndex } from '@/sim';
import { buildingIndex } from '@/sim/core/defs';

/** 各ミッションに与える tick 予算（`06§13` の練習は数分で終わる想定）。 */
const TICK_BUDGET = 20000;

/** 村人の生産を発注する間隔（tick）。人力の巡回の代わり。 */
const PRODUCE_INTERVAL = 100;

/** まだ満たしていない `holdFrontsWithOrder` が要求する令を、要求順に並べる。 */
function neededOrders(run: MissionRun): OrderId[] {
  const out: OrderId[] = [];
  for (const o of run.objectives()) {
    if (o.condition.type !== 'holdFrontsWithOrder' || o.met) continue;
    for (let k = 0; k < o.condition.count; k++) out.push(o.condition.order);
  }
  return out;
}

/** 自軍の町の中心の EntityId（無ければ -1）。 */
function ownTownCenter(run: MissionRun): number {
  const e = run.world.entities;
  const typeId = buildingIndex('town_center');
  for (let i = 0; i < e.highWater; i++) {
    if (e.alive[i] !== 1) continue;
    if (e.kind[i] !== EntityKind.Building) continue;
    if (e.typeId[i] !== typeId || e.owner[i] !== run.self) continue;
    return idOfIndex(e, i);
  }
  return -1;
}

/**
 * 「求められている令を、立っている戦域へ順に渡す」だけの操作でミッションを進める。
 * 内政ミッション（令を要求しないミッション）では村人を出し続ける。
 */
function play(missionId: string, budget = TICK_BUDGET): MissionRun {
  const run = createMissionRun(missionById(missionId)!);
  const w = run.world;
  const tc = ownTownCenter(run);
  for (let n = 0; n < budget && run.outcome() === 'running'; n++) {
    const cmds: Command[] = [];
    const want = neededOrders(run);
    let wi = 0;
    for (let s = 0; s < MAX_FRONTS && wi < want.length; s++) {
      const f = w.fronts[run.self * MAX_FRONTS + s]!;
      if (!f.active) continue;
      const order = want[wi]!;
      wi += 1;
      if (f.order === order || f.pendingOrder !== null) continue;
      cmds.push({ t: 'setOrder', p: run.self, front: f.slot, order, tier: 'upper' });
    }
    if (want.length === 0 && tc >= 0 && w.tick % PRODUCE_INTERVAL === 0) {
      cmds.push({ t: 'produce', p: run.self, building: tc, unit: 'villager', count: 1 });
    }
    run.step(cmds);
  }
  return run;
}

describe('T-M16-02 第 1 章の 5 ミッションはプレイ可能', () => {
  for (const m of mainMissionsOfChapter(1)) {
    it(`第 ${m.index} 話「${m.title}」で勝利条件が満たせる`, () => {
      const run = play(m.id);
      expect(run.outcome(), `残り目標: ${JSON.stringify(run.objectives().filter((o) => !o.met))}`).toBe(
        'victory',
      );
      expect(run.world.tick).toBeLessThanOrEqual(TICK_BUDGET);
    });
  }

  it('服属ルートも同じ操作で勝てる（旗を戻せる）', () => {
    const run = play('ch1_m2v');
    expect(run.outcome()).toBe('victory');
  });
});

describe('T-M16-01 進行（初期配置・イベント・判定）', () => {
  it('定義に書いた初期配置がそのまま World に入る', () => {
    const m = missionById('ch1_m5')!;
    const run = createMissionRun(m);
    const e = run.world.entities;
    // 定義した追加ユニットの総数（ミッション固有の数値はテストにも書かず定義から引く）。
    let want = 0;
    for (const u of m.setup.units) want += u.count;
    let units = 0;
    for (let i = 0; i < e.highWater; i++) {
      if (e.alive[i] === 1 && e.kind[i] === EntityKind.Unit) units += 1;
    }
    // 村人（`createMatch` が置く分）が居るので「追加ぶんより多い」ことを見る。
    expect(units).toBeGreaterThan(want);
    // 定義した敵の門が建っている。
    const gateType = buildingIndex(m.setup.buildings[0]!.building);
    let gates = 0;
    for (let i = 0; i < e.highWater; i++) {
      if (e.alive[i] === 1 && e.typeId[i] === gateType && e.kind[i] === EntityKind.Building) gates += 1;
    }
    expect(gates).toBeGreaterThan(0);
  });

  it('開始時にミッションのヒントが全部出ている', () => {
    const m = missionById('ch1_m2')!;
    const run = createMissionRun(m);
    expect(run.hints().map((h) => h.text)).toEqual([...m.hints]);
    for (const h of run.hints()) expect(h.tick).toBe(0);
  });

  it('atTick のイベントがその tick に発火し、増援が出る', () => {
    const m = missionById('ch1_m2')!;
    const wave = m.events.find((ev) => ev.action.type === 'spawnEnemyWave');
    expect(wave).toBeDefined();
    expect(wave!.trigger.type).toBe('atTick');
    const at = wave!.trigger.type === 'atTick' ? wave!.trigger.tick : 0;
    const spawnUnit = wave!.action.type === 'spawnEnemyWave' ? wave!.action.units[0]!.unit : '';

    const run = createMissionRun(m);
    const count = (): number => {
      const e = run.world.entities;
      let n = 0;
      for (let i = 0; i < e.highWater; i++) {
        if (e.alive[i] === 1 && e.kind[i] === EntityKind.Unit && e.owner[i] !== run.self) n += 1;
      }
      return n;
    };
    while (run.world.tick < at) run.step();
    const before = count();
    run.step();
    expect(count()).toBeGreaterThan(before);
    expect(spawnUnit.length).toBeGreaterThan(0);
  });

  it('frontOpened のイベントは戦域が立ってから発火する', () => {
    const m = missionById('ch1_m2')!;
    const hintEvent = m.events.find((ev) => ev.trigger.type === 'frontOpened');
    expect(hintEvent).toBeDefined();
    const text = hintEvent!.action.type === 'showHint' ? hintEvent!.action.text : '';

    const run = createMissionRun(m);
    let firedAt = -1;
    let frontAt = -1;
    for (let n = 0; n < TICK_BUDGET && firedAt < 0; n++) {
      const res = run.step();
      if (frontAt < 0) {
        for (let s = 0; s < MAX_FRONTS; s++) {
          if (run.world.fronts[run.self * MAX_FRONTS + s]!.active) frontAt = run.world.tick;
        }
      }
      if (res.hints.some((h) => h.text === text)) firedAt = run.world.tick;
    }
    expect(frontAt).toBeGreaterThan(0);
    expect(firedAt).toBeGreaterThan(0);
    expect(firedAt).toBeGreaterThanOrEqual(frontAt);
  });

  it('負けてもゲームオーバーにならず outcome が defeat になるだけ（投了 = 服属）', () => {
    const run = createMissionRun(missionById('ch1_m2')!);
    run.step([{ t: 'resign', p: run.self }]);
    // 投了は敗北判定を経てその tick か次の tick で決着する。
    for (let n = 0; n < 2 && run.outcome() === 'running'; n++) run.step();
    expect(run.outcome()).toBe('defeat');
    // 決着後に step を呼んでも例外にならず、それ以上進まない。
    const tick = run.world.tick;
    const res = run.step();
    expect(res.outcome).toBe('defeat');
    expect(run.world.tick).toBe(tick);
  });

  it('同じ入力列からは同じ World になる（Date.now() を使っていない）', () => {
    const runOnce = (): string => {
      const run = createMissionRun(missionById('ch1_m3')!);
      for (let n = 0; n < 1200; n++) run.step();
      return formatHash(hashWorld(run.world));
    };
    expect(runOnce()).toBe(runOnce());
  });

  it('目標の進捗（残り tick）が出る', () => {
    const run = createMissionRun(missionById('ch1_m4')!);
    const hold = run.objectives().find((o) => o.condition.type === 'holdFrontsWithOrder');
    expect(hold).toBeDefined();
    expect(hold!.met).toBe(false);
    expect(hold!.remainingTicks).toBeGreaterThan(0);
  });
});
