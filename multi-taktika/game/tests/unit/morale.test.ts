/**
 * T-M7-07 / T-M7-08: 士気（`07§6` 士気 / 実装手順書 §6.5）
 *
 * 完了条件:
 *  - T-M7-07「孤立した兵が退却し、後で戻る」
 *  - T-M7-08「周囲の士気が保たれる」（祈祷師）
 *  - 手順書 §6.5 末尾「後退の令で畳めば戦力を全損しない」
 *    → 令システム（M9）はまだ無いので、**士気の低い兵から順に下がる**ことで検証する。
 *
 * ---------------------------------------------------------------------------
 * 評価の間引きについて（テストを読むときの前提）
 * ---------------------------------------------------------------------------
 * morale は負荷対策で **12 tick（約 0.5 秒）ごと**にしか各ユニットを評価しない。
 * 位相は `entityIndex % 12` なので、**index 0 のユニットは tick 0 に評価される**。
 * したがって「index 0 のユニットを置いて 12 tick 回す」と評価はちょうど 1 回で、
 * 増減量は `moraleDelta(rate, 0, 12)` に一致する。
 * 個々の要因のテストはこの形に揃えてある（期待値の算術は `moraleDelta` 自体の
 * テストで別に守っている）。
 */

import { describe, expect, it } from 'vitest';
import { EntityKind, INVALID_ENTITY } from '@/shared/types';
import { createWorld, getFront, type World } from '@/sim/core/world';
import { UnitState, entityIndex, idOfIndex, markDeadIndex, spawnEntity } from '@/sim/core/entity';
import { FX_ONE, fx, fxFromInt } from '@/sim/core/fx';
import { TICK_RATE } from '@/sim/core/config';
import { buildingDefById, unitDefById } from '@/sim/core/defs';
import { rebuildGrid } from '@/sim/core/grid';
import { allocateTerrain } from '@/sim/core/terrain';
import { moraleDelta, morale } from '@/sim/systems/morale';

const MAP = 64;

/** 評価 1 回分の tick 数（`morale.ts` の EVAL_INTERVAL_TICKS と同じ）。 */
const EVAL = 12;

function makeWorld(): World {
  const w = createWorld({
    seed: 3,
    playerCount: 2,
    mapWidthTiles: MAP,
    mapHeightTiles: MAP,
    entityCapacity: 256,
  });
  allocateTerrain(w.map);
  return w;
}

function putUnit(w: World, id: string, owner: number, tx: number, ty: number): number {
  const d = unitDefById(id);
  return entityIndex(
    spawnEntity(w.entities, {
      kind: EntityKind.Unit,
      owner,
      typeId: d.index,
      x: fxFromInt(tx),
      y: fxFromInt(ty),
      hpMax: d.hp,
    })
  );
}

function putBuilding(w: World, id: string, owner: number, tx: number, ty: number): number {
  const d = buildingDefById(id);
  return entityIndex(
    spawnEntity(w.entities, {
      kind: EntityKind.Building,
      owner,
      typeId: d.index,
      x: fxFromInt(tx),
      y: fxFromInt(ty),
      hpMax: d.hp,
    })
  );
}

/** morale だけを 1 tick 走らせる（stepWorld の 8 番だけを切り出したもの）。 */
function tickMorale(w: World, times = 1): void {
  for (let k = 0; k < times; k++) {
    rebuildGrid(w.grid, w.entities, w.tick);
    morale(w);
    w.tick += 1;
  }
}

/**
 * **危険な状況を作る**（士気の減少要因を効かせる前提）。
 *
 * `07§6` の士気は「兵は体力 0 で死ぬ前に、士気 0 で退きます」という戦闘の仕組みなので、
 * 減少要因（孤立・戦域の劣勢・味方の死・令の未着）は**危険なときだけ**効く。
 * これを分けていなかったため「敵のいない平地を 1 体で歩く兵が孤立で退却し、
 * 指示を失って戻ってこない」という壊れ方をしていた（村人が固まり資源が凍る原因）。
 *
 * テストで孤立の減少を見るには、**視界内に敵の戦闘ユニットを 1 体置く**。
 * 「孤立している（味方がいない）」と「敵がいる」は同時に成り立つ。
 */
function putThreat(w: World, tx: number, ty: number, owner = 1): number {
  return putUnit(w, 'clubman', owner, tx, ty);
}

function openFront(w: World, slot: number, owner: number): void {
  // 戦域はプレイヤーごとに 6 枠。owner は配列上の位置で決まるので代入しない。
  const f = getFront(w, owner, slot)!;
  f.active = true;
  f.radius = fxFromInt(15);
}

/** 「1 回の評価（12 tick 分）でこれだけ動くはず」という期待値。 */
function oneEval(ratePerSec: number): number {
  return moraleDelta(ratePerSec, 0, EVAL);
}

// ---------------------------------------------------------------------------

describe('毎秒レート → tick 増分の変換', () => {
  it('25 tick 分をまとめて取るとちょうど 1 秒分になる', () => {
    for (const rate of [fx(0.03), fx(0.06), fx(0.1), fx(0.12)]) {
      expect(moraleDelta(rate, 0, TICK_RATE)).toBe(rate);
    }
  });

  it('12 tick 刻みで積んでも誤差が溜まらない（300 tick = 12 秒分）', () => {
    for (const rate of [fx(0.03), fx(0.06), fx(0.1), -fx(0.06)]) {
      let sum = 0;
      for (let t = 0; t < 300; t += EVAL) sum += moraleDelta(rate, t, EVAL);
      expect(sum).toBe(rate * 12);
    }
  });

  it('1 回分でも Fx の分解能に埋もれない（0 になり続けない）', () => {
    // cfgPerTickFx（fx(0.03/25) = 0）では士気が一切動かない。これを避けるための仕組み。
    expect(oneEval(-fx(0.03))).toBeLessThan(0);
    expect(oneEval(fx(0.03))).toBeGreaterThan(0);
  });
});

describe('T-M7-07 孤立した兵が退却し、後で戻る', () => {
  it('孤立で士気が減り、0 で Routed になり、10 秒後に戻る', () => {
    const w = makeWorld();
    const a = putUnit(w, 'y-nagae', 0, 30, 30); // 周囲に味方なし
    const e = w.entities;
    openFront(w, 1, 0);
    e.frontId[a] = 1;
    expect(e.morale[a]).toBe(FX_ONE);

    // 0.06/秒 で減るので 1.0 → 0 まで約 17 秒（427 tick）
    let routedAt = -1;
    for (let t = 0; t < 600; t++) {
      tickMorale(w);
      if (routedAt < 0 && e.state[a] === UnitState.Routed) routedAt = w.tick - 1;
    }
    expect(routedAt).toBeGreaterThan(400);
    expect(routedAt).toBeLessThan(450);
    expect(e.hp[a]).toBe(e.hpMax[a]); // **HP 0 の前に士気 0 で退いている**

    // 退却中は frontId を保持する（`07§6`）
    expect(e.frontId[a]).toBe(1);

    // retreatSec = 10 秒 = 250 tick で戻る
    const stateTick = e.stateTick[a]!;
    tickMorale(w, 250 + EVAL);
    // 退却明けは **Idle ではなく Moving**。`07§6` の「また戻ってくる」を実装した結果で、
    // Idle にすると村人が運搬の途中で固まって二度と働かなくなる（実際にそうなっていた）。
    expect(e.state[a]).toBe(UnitState.Moving);
    expect(w.tick - 1 - stateTick).toBeGreaterThanOrEqual(250);
    expect(e.morale[a]).toBeGreaterThan(0);
    expect(e.frontId[a]).toBe(1);
  });

  it('退却先は最寄りの自軍建物（homeId と destX/destY に入る）', () => {
    const w = makeWorld();
    const a = putUnit(w, 'y-nagae', 0, 30, 30);
    const far = putBuilding(w, 'town_center', 0, 50, 50);
    // 「自軍建物の内側」の回復が混ざらないよう、判定半径（5 マス）の外に置く
    const near = putBuilding(w, 'watch_tower', 0, 37, 30);
    const e = w.entities;
    // **危険な状況を作る**（士気が下がるのは危険なときだけ。`07§6` は戦闘の仕組み）
    putThreat(w, 32, 30);
    e.morale[a] = 1; // すぐ 0 になるように

    tickMorale(w, EVAL);
    expect(e.state[a]).toBe(UnitState.Routed);
    expect(e.homeId[a]).toBe(idOfIndex(e, near));
    expect(e.homeId[a]).not.toBe(idOfIndex(e, far));
    expect(e.destX[a]).toBe(fxFromInt(37));
    expect(e.destY[a]).toBe(fxFromInt(30));
    expect(e.target[a]).toBe(INVALID_ENTITY);
  });

  it('味方が半径 5 マス内にいれば孤立しない（士気は満タンのまま）', () => {
    const w = makeWorld();
    const a = putUnit(w, 'y-nagae', 0, 30, 30);
    putUnit(w, 'y-nagae', 0, 33, 30); // 3 マス隣
    const e = w.entities;
    tickMorale(w, 500);
    expect(e.morale[a]).toBe(FX_ONE);
    expect(e.state[a]).not.toBe(UnitState.Routed);
  });

  it('村人は士気で退却しない（塔へ退避するのは economy の担当）', () => {
    const w = makeWorld();
    const v = putUnit(w, 'villager', 0, 30, 30);
    const e = w.entities;
    e.morale[v] = 1;
    tickMorale(w, 100);
    expect(e.state[v]).not.toBe(UnitState.Routed);
    expect(e.morale[v]).toBe(1);
  });
});

describe('§6.5 減少要因', () => {
  it('戦域が警告状態（advantage < -0.30）だと減る', () => {
    const w = makeWorld();
    openFront(w, 1, 0);
    w.fronts[0]!.advantage = -fx(0.5);
    const a = putUnit(w, 'y-nagae', 0, 30, 30);
    putUnit(w, 'y-nagae', 0, 31, 30); // 孤立させない
    const e = w.entities;
    e.frontId[a] = 1;
    const before = e.morale[a]!;
    tickMorale(w, EVAL);
    expect(e.morale[a]! - before).toBe(oneEval(-fx(0.04)));
  });

  it('令が届いていない（pendingOrder あり かつ 劣勢）だと減る', () => {
    const w = makeWorld();
    openFront(w, 1, 0);
    const f = w.fronts[0]!;
    f.advantage = -fx(0.1); // 警告しきい値には届かないが劣勢
    f.pendingOrder = { id: 'charge', tier: 'upper', single: true, deliverAtTick: 999 };
    const a = putUnit(w, 'y-nagae', 0, 30, 30);
    putUnit(w, 'y-nagae', 0, 31, 30);
    const e = w.entities;
    e.frontId[a] = 1;
    const before = e.morale[a]!;
    tickMorale(w, EVAL);
    expect(e.morale[a]! - before).toBe(oneEval(-fx(0.03)));
  });

  it('直近で近くの味方が 3 体倒れると減る（死亡ショック・その tick 経路）', () => {
    const w = makeWorld();
    const a = putUnit(w, 'y-nagae', 0, 30, 30);
    const survivor = putUnit(w, 'y-nagae', 0, 31, 30); // 孤立させないための生存者
    const e = w.entities;
    const dead: number[] = [];
    for (let k = 0; k < 3; k++) dead.push(putUnit(w, 'y-nagae', 0, 32 + k, 31));
    // combat が同じ tick で殺した状態を作る（cleanup 前なので座標が残っている）
    for (const d of dead) markDeadIndex(e, d);
    expect(e.alive[survivor]).toBe(1);
    putThreat(w, 33, 30); // 危険な状況（味方が倒れる＝敵がいる状況）

    const before = e.morale[a]!;
    tickMorale(w, EVAL);
    expect(e.morale[a]! - before).toBe(oneEval(-fx(0.1)));
  });

  it('味方が倒れていなければ死亡ショックは起きない', () => {
    const w = makeWorld();
    const a = putUnit(w, 'y-nagae', 0, 30, 30);
    putUnit(w, 'y-nagae', 0, 31, 30);
    for (let k = 0; k < 3; k++) putUnit(w, 'y-nagae', 0, 32 + k, 31);
    const e = w.entities;
    const before = e.morale[a]!;
    tickMorale(w, EVAL);
    expect(e.morale[a]).toBe(before);
  });

  it('遠くで味方が倒れても士気は下がらない（半径 6 マス）', () => {
    const w = makeWorld();
    const a = putUnit(w, 'y-nagae', 0, 30, 30);
    putUnit(w, 'y-nagae', 0, 31, 30);
    const e = w.entities;
    const dead: number[] = [];
    for (let k = 0; k < 3; k++) dead.push(putUnit(w, 'y-nagae', 0, 50 + k, 50));
    for (const d of dead) markDeadIndex(e, d);
    const before = e.morale[a]!;
    tickMorale(w, EVAL);
    expect(e.morale[a]).toBe(before);
  });

  it('戦域の直近被ダメージが味方 3 体分を超えると減る（死亡ショック・時間窓経路）', () => {
    const w = makeWorld();
    openFront(w, 1, 0);
    const f = w.fronts[0]!;
    const a = putUnit(w, 'y-nagae', 0, 30, 30);
    putUnit(w, 'y-nagae', 0, 31, 30);
    const e = w.entities;
    e.frontId[a] = 1;
    // 直近 3 秒（75 tick）の窓に、hpMax × 3 を超える被ダメージを置く
    f.dmgTaken[0] = e.hpMax[a]! * 3 + 1;
    const before = e.morale[a]!;
    tickMorale(w, EVAL);
    expect(e.morale[a]! - before).toBe(oneEval(-fx(0.1)));
  });

  it('被ダメージが味方 3 体分に届かなければ下がらない', () => {
    const w = makeWorld();
    openFront(w, 1, 0);
    const f = w.fronts[0]!;
    const a = putUnit(w, 'y-nagae', 0, 30, 30);
    putUnit(w, 'y-nagae', 0, 31, 30);
    const e = w.entities;
    e.frontId[a] = 1;
    f.dmgTaken[0] = e.hpMax[a]! * 3 - 1;
    const before = e.morale[a]!;
    tickMorale(w, EVAL);
    expect(e.morale[a]).toBe(before);
  });
});

describe('§6.5 増加要因', () => {
  it('密集隊列（死守）だと回復する', () => {
    const w = makeWorld();
    openFront(w, 1, 0);
    w.fronts[0]!.order = 'hold'; // orders.json: formation = dense
    const a = putUnit(w, 'y-nagae', 0, 30, 30);
    putUnit(w, 'y-nagae', 0, 31, 30);
    const e = w.entities;
    e.frontId[a] = 1;
    e.morale[a] = FX_ONE / 2;
    const before = e.morale[a]!;
    tickMorale(w, EVAL);
    expect(e.morale[a]! - before).toBe(oneEval(fx(0.05)));
  });

  it('戦域が優勢だと回復する', () => {
    const w = makeWorld();
    openFront(w, 1, 0);
    w.fronts[0]!.advantage = fx(0.4);
    const a = putUnit(w, 'y-nagae', 0, 30, 30);
    putUnit(w, 'y-nagae', 0, 31, 30);
    const e = w.entities;
    e.frontId[a] = 1;
    e.morale[a] = FX_ONE / 2;
    const before = e.morale[a]!;
    tickMorale(w, EVAL);
    expect(e.morale[a]! - before).toBe(oneEval(fx(0.04)));
  });

  it('自軍建物の内側だと回復する', () => {
    const w = makeWorld();
    const a = putUnit(w, 'y-nagae', 0, 32, 30);
    putUnit(w, 'y-nagae', 0, 33, 30);
    putBuilding(w, 'town_center', 0, 30, 30);
    const e = w.entities;
    putThreat(w, 34, 30); // 危険な状況（増加要因は危険なときの内訳）
    e.morale[a] = FX_ONE / 2;
    const before = e.morale[a]!;
    tickMorale(w, EVAL);
    expect(e.morale[a]! - before).toBe(oneEval(fx(0.03)));
  });

  it('敵の建物では回復しない', () => {
    const w = makeWorld();
    const a = putUnit(w, 'y-nagae', 0, 32, 30);
    putUnit(w, 'y-nagae', 0, 33, 30);
    putBuilding(w, 'town_center', 1, 30, 30);
    const e = w.entities;
    putThreat(w, 34, 30); // 危険な状況（回復要因の有無を測るため）
    e.morale[a] = FX_ONE / 2;
    const before = e.morale[a]!;
    tickMorale(w, EVAL);
    expect(e.morale[a]).toBe(before);
  });

  it('士気は FX_ONE を超えない', () => {
    const w = makeWorld();
    openFront(w, 1, 0);
    w.fronts[0]!.advantage = fx(0.9);
    const a = putUnit(w, 'y-nagae', 0, 30, 30);
    putUnit(w, 'y-nagae', 0, 31, 30);
    w.entities.frontId[a] = 1;
    tickMorale(w, 500);
    expect(w.entities.morale[a]).toBe(FX_ONE);
  });
});

describe('T-M7-08 祈祷師は周囲の士気を保つ', () => {
  it('半径 8 マスに祈祷師がいれば、孤立していても士気が下がらない', () => {
    const w = makeWorld();
    const a = putUnit(w, 'y-nagae', 0, 30, 30);
    // 6 マス離す: 孤立の半径 5 の外、祈祷師の半径 8 の内
    putUnit(w, 'priest', 0, 36, 30);
    const e = w.entities;
    putThreat(w, 32, 30); // 危険な状況（孤立の減少を効かせる前提）
    e.morale[a] = FX_ONE / 2;
    const before = e.morale[a]!;
    tickMorale(w, EVAL);
    // 孤立 -0.06 + 祈祷師 +0.08 = +0.02
    expect(e.morale[a]! - before).toBe(oneEval(fx(0.08) - fx(0.06)));
    expect(e.morale[a]!).toBeGreaterThan(before);
  });

  it('祈祷師が遠いと孤立で下がる', () => {
    const w = makeWorld();
    const a = putUnit(w, 'y-nagae', 0, 30, 30);
    putUnit(w, 'priest', 0, 45, 30); // 15 マス離れている
    const e = w.entities;
    putThreat(w, 32, 30); // 危険な状況
    e.morale[a] = FX_ONE / 2;
    const before = e.morale[a]!;
    tickMorale(w, EVAL);
    expect(e.morale[a]! - before).toBe(oneEval(-fx(0.06)));
  });

  it('敵の祈祷師では士気は保たれない', () => {
    const w = makeWorld();
    const a = putUnit(w, 'y-nagae', 0, 30, 30);
    putUnit(w, 'priest', 1, 36, 30);
    const e = w.entities;
    putThreat(w, 32, 30); // 危険な状況
    e.morale[a] = FX_ONE / 2;
    const before = e.morale[a]!;
    tickMorale(w, EVAL);
    expect(e.morale[a]! - before).toBe(oneEval(-fx(0.06)));
  });
});

describe('「捨てる」が成立する（§6.5 末尾 / T-M8-07 の前倒し）', () => {
  it('士気の低い兵から順に下がる', () => {
    const w = makeWorld();
    const e = w.entities;
    // 5 体を離して置き（全員孤立）、士気だけを違える。
    const units: number[] = [];
    const initial = [5, 10, 15, 20, 25];
    for (let k = 0; k < initial.length; k++) {
      const i = putUnit(w, 'y-nagae', 0, 10 + k * 10, 30);
      e.morale[i] = initial[k]!;
      units.push(i);
      // それぞれの近くに敵を置いて**危険な状況**にする
      // （`07§6` の士気は戦闘の仕組みなので、平時は下がらない）。
      putThreat(w, 10 + k * 10 + 3, 30);
    }

    const routOrder: number[] = [];
    for (let t = 0; t < 200; t++) {
      tickMorale(w);
      for (const i of units) {
        if (e.state[i] === UnitState.Routed && !routOrder.includes(i)) routOrder.push(i);
      }
    }
    // 全員退却し、その順序は「士気の昇順」= units の並びと一致する
    expect(routOrder).toEqual(units);
  });

  it('退却した兵は生き残る（全損しない）', () => {
    const w = makeWorld();
    const e = w.entities;
    const units: number[] = [];
    for (let k = 0; k < 5; k++) {
      const i = putUnit(w, 'y-nagae', 0, 10 + k * 10, 30);
      e.morale[i] = 5 + k * 5;
      units.push(i);
    }
    tickMorale(w, 200);
    for (const i of units) {
      expect(e.alive[i]).toBe(1);
      expect(e.hp[i]).toBe(e.hpMax[i]);
    }
  });
});

describe('決定論', () => {
  it('同じ初期状態からは同じ士気の並びになる', () => {
    const run = () => {
      const w = makeWorld();
      openFront(w, 1, 0);
      w.fronts[0]!.advantage = -fx(0.4);
      const e = w.entities;
      for (let k = 0; k < 8; k++) {
        const i = putUnit(w, 'y-nagae', 0, 20 + k * 3, 30 + (k % 2));
        e.frontId[i] = 1;
      }
      putUnit(w, 'priest', 0, 26, 30);
      tickMorale(w, 300);
      const out: number[] = [];
      for (let i = 0; i < e.highWater; i++) out.push(e.morale[i]!, e.state[i]!);
      return out;
    };
    expect(run()).toEqual(run());
  });

  it('乱数を消費しない', () => {
    const w = makeWorld();
    putUnit(w, 'y-nagae', 0, 30, 30);
    const before = w.rngCombat.clone().nextU32();
    tickMorale(w, 500);
    expect(w.rngCombat.clone().nextU32()).toBe(before);
  });
});
