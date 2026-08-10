/**
 * T-M12-12（土台）: 試合統計の観測（`src/ui/stats.ts`）
 *
 * 検証すること:
 *  - 採集量は「保有量の増えた分」で積まれる（減った分は無視）
 *  - 撃破・損失が `lastDamagedBy` と死亡の突き合わせで数えられる
 *  - **令ごとの成績**が、倒した場所を含む戦域の令に付く
 *  - 令の履歴が「出した tick」と「届いた tick」を分けて持つ（遅延を隠さない）
 *  - **同じ tick 列を 2 回流すと統計が完全に一致する**（リプレイでの再現性）
 *  - グラフの座標計算・積み上げバー・「線が離れた瞬間」が純関数として正しい
 *
 * DOM は一切触らない（jsdom 不要）。
 */

import { describe, expect, it } from 'vitest';
import { EntityKind, ORDER_IDS, type PlayerId } from '@/shared/types';
import { entityIndex, markDeadIndex, spawnEntity } from '@/sim/core/entity';
import { fx, fxFromInt } from '@/sim/core/fx';
import { unitDefById } from '@/sim/core/defs';
import { cleanup } from '@/sim/systems/cleanup';
import { createWorld, frontIndex, type World } from '@/sim/core/world';
import {
  MatchStats,
  SERIES_INTERVAL_TICKS,
  divergenceSampleIndex,
  orderIndexOf,
  seriesPolyline,
  stackedSegments,
  tickToClock,
} from '@/ui/stats';

const MAP = 80;

function makeWorld(playerCount = 2): World {
  return createWorld({
    seed: 7,
    playerCount,
    mapWidthTiles: MAP,
    mapHeightTiles: MAP,
    entityCapacity: 256,
  });
}

function putUnit(w: World, owner: number, tileX: number, tileY: number, id = 'clubman'): number {
  const d = unitDefById(id);
  return entityIndex(
    spawnEntity(w.entities, {
      kind: EntityKind.Unit,
      owner,
      typeId: d.index,
      x: fxFromInt(tileX),
      y: fxFromInt(tileY),
      hpMax: d.hp,
    }),
  );
}

/** 戦域を 1 つ立てる（令つき）。 */
function openFront(w: World, owner: PlayerId, slot: number, orderId: string, tileX = 10, tileY = 10): void {
  const f = w.fronts[frontIndex(owner, slot)]!;
  f.active = true;
  f.x = fxFromInt(tileX);
  f.y = fxFromInt(tileY);
  f.radius = fxFromInt(6);
  f.order = orderId as (typeof ORDER_IDS)[number];
  f.memberCount = 1;
}

describe('ui/stats: 採集量の観測', () => {
  it('保有量の増えた分だけを積み、減った分は無視する', () => {
    const w = makeWorld(1);
    const st = new MatchStats(1);
    st.sample(w); // tick 0 = 基準

    w.players[0]!.resources[0] = fx(100);
    w.tick = 1;
    st.sample(w);

    w.players[0]!.resources[0] = fx(40); // 生産で使った
    w.tick = 2;
    st.sample(w);

    w.players[0]!.resources[0] = fx(90); // また採った（+50）
    w.tick = 3;
    st.sample(w);

    const snap = st.snapshot();
    // 100 + 50 = 150（使った 60 は引かれない）
    expect(snap.players[0]!.gathered[0]).toBe(150);
  });

  it('推移の標本は tick で決まる（SERIES_INTERVAL_TICKS ごと）', () => {
    const w = makeWorld(1);
    const st = new MatchStats(1);
    for (let t = 0; t <= SERIES_INTERVAL_TICKS * 2; t++) {
      w.tick = t;
      st.sample(w);
    }
    const snap = st.snapshot();
    expect(snap.ticks).toEqual([0, SERIES_INTERVAL_TICKS, SERIES_INTERVAL_TICKS * 2]);
  });
});

describe('ui/stats: 撃破と損失', () => {
  it('lastDamagedBy と死亡の突き合わせで撃破・損失を数える', () => {
    const w = makeWorld(2);
    const victim = putUnit(w, 1, 10, 10);
    const st = new MatchStats(2);
    st.sample(w);

    // P0 が殴った → 死んだ
    w.entities.lastDamagedBy[victim] = 0;
    w.entities.lastDamagedTick[victim] = 0;
    w.tick = 1;
    st.sample(w); // 犯人を census に写す

    markDeadIndex(w.entities, victim);
    cleanup(w); // tick 末に index が消える（本番と同じ経路）
    w.tick = 2;
    st.sample(w);

    const snap = st.snapshot();
    expect(snap.players[0]!.kills).toBe(1);
    expect(snap.players[1]!.losses).toBe(1);
    expect(snap.players[1]!.kills).toBe(0);
  });

  it('友軍被害は損失だけ増え、撃破には数えない', () => {
    const w = makeWorld(2);
    w.teams[0] = 0;
    w.teams[1] = 0; // 同チーム
    const victim = putUnit(w, 1, 10, 10);
    const st = new MatchStats(2);
    st.sample(w);

    w.entities.lastDamagedBy[victim] = 0;
    w.tick = 1;
    st.sample(w);

    markDeadIndex(w.entities, victim);
    cleanup(w);
    w.tick = 2;
    st.sample(w);

    const snap = st.snapshot();
    expect(snap.players[0]!.kills).toBe(0);
    expect(snap.players[1]!.losses).toBe(1);
  });

  it('令ごとの成績が「倒した場所を含む戦域の令」に付く', () => {
    const w = makeWorld(2);
    openFront(w, 0, 1, 'charge', 10, 10);
    // 戦域に自軍の兵を 1 体置く（`cleanup` は所属ユニット 0 の戦域を閉じるため）
    const mine = putUnit(w, 0, 10, 10);
    w.entities.frontId[mine] = 1;
    const victim = putUnit(w, 1, 10, 10);
    const st = new MatchStats(2);
    st.sample(w);

    w.entities.lastDamagedBy[victim] = 0;
    w.tick = 1;
    st.sample(w);

    markDeadIndex(w.entities, victim);
    cleanup(w);
    w.tick = 2;
    st.sample(w);

    const snap = st.snapshot();
    const charge = orderIndexOf('charge');
    expect(charge).toBeGreaterThanOrEqual(0);
    expect(snap.players[0]!.perOrder[charge]!.kills).toBe(1);
    // 使っていない令には付かない
    const hold = orderIndexOf('hold');
    expect(snap.players[0]!.perOrder[hold]!.kills).toBe(0);
  });
});

describe('ui/stats: 令の履歴', () => {
  it('出した tick と届いた tick を分けて持つ（遅延を隠さない）', () => {
    const w = makeWorld(2);
    const f = w.fronts[frontIndex(0, 1)]!;
    f.active = true;
    f.radius = fxFromInt(5);
    const st = new MatchStats(2);
    st.sample(w);

    // 令を出した（配達中）
    f.pendingOrder = { id: 'charge', tier: 'upper', single: true, deliverAtTick: 30 };
    w.tick = 10;
    st.sample(w);

    // 届いた
    f.pendingOrder = null;
    f.order = 'charge';
    w.tick = 30;
    st.sample(w);

    const log = st.snapshot().players[0]!.orderLog;
    expect(log).toHaveLength(1);
    expect(log[0]!.issuedTick).toBe(10);
    expect(log[0]!.deliveredTick).toBe(30);
    expect(log[0]!.slot).toBe(1);
    expect(log[0]!.orderId).toBe('charge');
  });

  it('届かないまま試合が終わった令は deliveredTick = -1', () => {
    const w = makeWorld(2);
    const f = w.fronts[frontIndex(0, 1)]!;
    f.active = true;
    const st = new MatchStats(2);
    st.sample(w);
    f.pendingOrder = { id: 'hold', tier: 'upper', single: true, deliverAtTick: 999 };
    w.tick = 5;
    st.sample(w);
    const log = st.snapshot().players[0]!.orderLog;
    expect(log[0]!.deliveredTick).toBe(-1);
  });
});

describe('ui/stats: リプレイでの再現性', () => {
  /**
   * 同じ「World の遷移列」を 2 回流したら、統計が完全に一致すること。
   * 統計の入力が `w.tick` と World の中身だけであること（実時間・乱数を使っていないこと）の検査。
   */
  function runScenario(): string {
    const w = makeWorld(2);
    const st = new MatchStats(2);
    openFront(w, 0, 1, 'charge', 10, 10);
    const mine = putUnit(w, 0, 10, 10);
    w.entities.frontId[mine] = 1;
    st.sample(w);

    for (let t = 1; t <= 600; t++) {
      w.tick = t;
      // 決まった tick で資源が増える（採集の代わり）
      if (t % 5 === 0) w.players[0]!.resources[0] = w.players[0]!.resources[0]! + fx(3);
      if (t % 7 === 0) w.players[1]!.resources[1] = w.players[1]!.resources[1]! + fx(2);
      // 決まった tick で敵を 1 体出して、次の tick に倒す
      if (t % 100 === 0) {
        const v = putUnit(w, 1, 10, 10);
        w.entities.lastDamagedBy[v] = 0;
        st.sample(w);
        w.tick = t + 1;
        markDeadIndex(w.entities, v);
        cleanup(w);
      }
      st.sample(w);
    }
    return JSON.stringify(st.snapshot());
  }

  it('2 回流すと統計が完全に一致する', () => {
    expect(runScenario()).toBe(runScenario());
  });

  it('毎 tick 呼ばないと hasGap が立つ（統計が不完全であることを隠さない）', () => {
    const w = makeWorld(1);
    const st = new MatchStats(1);
    st.sample(w);
    w.tick = 1;
    st.sample(w);
    expect(st.hasGap()).toBe(false);
    w.tick = 5; // 3 tick 飛ばした
    st.sample(w);
    expect(st.hasGap()).toBe(true);
    expect(st.snapshot().hasGap).toBe(true);
  });

  it('同じ tick を 2 回渡しても二重計上しない', () => {
    const w = makeWorld(1);
    const st = new MatchStats(1);
    st.sample(w);
    w.tick = 1;
    w.players[0]!.resources[0] = fx(10);
    st.sample(w);
    st.sample(w); // 同じ tick
    expect(st.snapshot().players[0]!.gathered[0]).toBe(10);
    expect(st.hasGap()).toBe(false);
  });
});

describe('ui/stats: 表示のための純関数', () => {
  it('積み上げバーは合計が指定幅にぴったり一致する', () => {
    for (const values of [
      [1, 1, 1, 1],
      [100, 3, 0, 7],
      [1, 0, 0, 0],
      [7, 11, 13, 17],
    ]) {
      const segs = stackedSegments(values, 300);
      expect(segs.reduce((a, b) => a + b, 0)).toBe(300);
    }
  });

  it('採集量が 0 なら全区間 0（0 除算で NaN を出さない）', () => {
    expect(stackedSegments([0, 0, 0, 0], 300)).toEqual([0, 0, 0, 0]);
  });

  it('折れ線は y が反転する（値が大きいほど上）', () => {
    const box = { width: 100, height: 100, padX: 0, padY: 0 };
    const pts = seriesPolyline([0, 50, 100], [0, 50, 100], 100, 100, box).split(' ');
    expect(pts[0]).toBe('0,100'); // 値 0 = 下端
    expect(pts[2]).toBe('100,0'); // 最大値 = 上端
  });

  it('最大値が 0 でも NaN を出さない', () => {
    const box = { width: 100, height: 100, padX: 0, padY: 0 };
    const s = seriesPolyline([0, 0], [0, 10], 0, 10, box);
    expect(s.includes('NaN')).toBe(false);
  });

  it('「線が離れた瞬間」は差が最も大きく開いた区間の終端', () => {
    // 標本 3 で急に差が開く
    const a = [0, 10, 20, 100, 110];
    const b = [0, 10, 20, 25, 30];
    expect(divergenceSampleIndex([a, b])).toBe(3);
  });

  it('差が開かなければ -1', () => {
    expect(divergenceSampleIndex([[0, 10, 20], [0, 10, 20]])).toBe(-1);
    expect(divergenceSampleIndex([[0, 1]])).toBe(-1);
  });

  it('tick → mm:ss（25 tick/秒）', () => {
    expect(tickToClock(0)).toBe('0:00');
    expect(tickToClock(25 * 65)).toBe('1:05');
    expect(tickToClock(45000)).toBe('30:00');
  });
});
