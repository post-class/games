/**
 * T-M9-05: ユニット判断エンジン（`07§5` / 実装手順書 §6.3）
 *
 * 完了条件:
 *  - **400 体で `unitDecision` が 1 tick 4ms 以内**
 *  - **乱数を使っていない**（同じ状態を 2 回評価すると同じ結果になる / rng が減らない）
 *  - 0.5 秒（12 tick）ごとに 1 回だけ評価される（`entityIndex % 12` の分散）
 *  - `manual = 1` は丸ごとスキップ（T-M9-09 の土台）
 *  - 戦域が閉じても `lastOrder` の令を使い続ける
 *  - 離反した戦域（`defected`）は令を無視して既定行動
 *
 * M8 が未完成なので戦域は手で立てる（`makeFront`）。
 */

import { describe, expect, it } from 'vitest';
import { EntityKind, INVALID_ENTITY } from '@/shared/types';
import { cfgNum } from '@/sim/core/config';
import { orderDefById, unitDefById } from '@/sim/core/defs';
import { entityIndex, spawnEntity, UnitState } from '@/sim/core/entity';
import { FX_ONE, fx, fxFromInt } from '@/sim/core/fx';
import { rebuildGrid } from '@/sim/core/grid';
import { allocateTerrain } from '@/sim/core/terrain';
import {
  DEFAULT_WEIGHTS,
  closenessFx,
  combineOrders,
  counterBonus,
  crowdPenalty,
  nearSegment,
  normDistFx,
  resolveOrderForUnit,
  riskFromCount,
  targetPriorityBonus,
  Tag,
} from '@/sim/core/order';
import { createWorld, getFront, type Front, type World } from '@/sim/core/world';
import { DECISION_PERIOD_TICKS, unitDecision } from '@/sim/systems/unitDecision';

const MAP = 200;

function makeWorld(playerCount = 2, capacity = 1024): World {
  const w = createWorld({
    seed: 5,
    playerCount,
    mapWidthTiles: MAP,
    mapHeightTiles: MAP,
    entityCapacity: capacity,
  });
  allocateTerrain(w.map);
  for (let p = 0; p < playerCount; p++) {
    w.map.starts[p * 2] = fxFromInt(p === 0 ? 10 : MAP - 10);
    w.map.starts[p * 2 + 1] = fxFromInt(p === 0 ? 10 : MAP - 10);
    w.players[p]!.frontSlots = 6;
  }
  return w;
}

function makeFront(w: World, owner: number, slot: number, tileX: number, tileY: number): Front {
  const f = getFront(w, owner, slot)!;
  f.active = true;
  f.x = fxFromInt(tileX);
  f.y = fxFromInt(tileY);
  f.radius = fx(cfgNum('front.growMaxRadiusTiles'));
  return f;
}

function putUnit(w: World, id: string, owner: number, tileX: number, tileY: number): number {
  const d = unitDefById(id);
  return entityIndex(
    spawnEntity(w.entities, {
      kind: EntityKind.Unit,
      owner,
      typeId: d.index,
      x: fxFromInt(tileX),
      y: fxFromInt(tileY),
      hpMax: d.hp,
    })
  );
}

/** その index が評価される tick まで進めて 1 回だけ評価する。 */
function stepDecisionFor(w: World, i: number): void {
  rebuildGrid(w.grid, w.entities, w.tick);
  w.tick = i % DECISION_PERIOD_TICKS;
  unitDecision(w);
}

// ---------------------------------------------------------------------------
// スコアの部品（純関数）
// ---------------------------------------------------------------------------

describe('スコアの部品', () => {
  it('closeness / normDist は 0..1 に正規化される', () => {
    const r = fxFromInt(30);
    expect(closenessFx(0, r)).toBe(FX_ONE);
    expect(closenessFx(r, r)).toBe(0);
    expect(closenessFx(fxFromInt(15), r)).toBe(FX_ONE / 2);
    expect(normDistFx(0, r)).toBe(0);
    expect(normDistFx(fxFromInt(15), r)).toBe(FX_ONE / 2);
    expect(normDistFx(fxFromInt(60), r)).toBe(FX_ONE);
  });

  it('targetPriorityBonus は先頭ほど大きい（略奪は村人 1.0 / 家 0.333）', () => {
    const raid = orderDefById('raid').targetPriority;
    expect(raid).toEqual(['villager', 'resource_building', 'house']);
    expect(targetPriorityBonus(raid, Tag.Unit | Tag.Villager)).toBe(FX_ONE);
    expect(targetPriorityBonus(raid, Tag.Building | Tag.ResourceBuilding)).toBe(
      Math.trunc((FX_ONE * 2) / 3)
    );
    expect(targetPriorityBonus(raid, Tag.Building | Tag.House)).toBe(Math.trunc(FX_ONE / 3));
    // 兵はどれにも当たらない = 加点なし
    expect(targetPriorityBonus(raid, Tag.Unit)).toBe(0);
  });

  it('`nearest` はどの候補にも一致する（突撃）', () => {
    const charge = orderDefById('charge').targetPriority;
    expect(charge).toEqual(['nearest']);
    expect(targetPriorityBonus(charge, Tag.Unit)).toBe(FX_ONE);
    expect(targetPriorityBonus(charge, Tag.Building)).toBe(FX_ONE);
  });

  it('`in_range` は射程内の敵だけに加点する（死守）', () => {
    const hold = orderDefById('hold').targetPriority;
    expect(hold).toEqual(['in_range']);
    expect(targetPriorityBonus(hold, Tag.Unit | Tag.InRange)).toBe(FX_ONE);
    expect(targetPriorityBonus(hold, Tag.Unit)).toBe(0);
  });

  it('counterBonus は相性表そのまま（有利 +0.5 / 不利 -0.3 / 等倍 0）', () => {
    const spear = unitDefById('y-ashigaru'); // 槍
    const cav = unitDefById('y-kiba'); // 騎兵
    // 槍 → 騎兵 は有利（`03§7`）
    expect(counterBonus(spear.roleIdx, cav.roleIdx)).toBe(fx(1.5) - FX_ONE);
    // 騎兵 → 槍 は不利
    expect(counterBonus(cav.roleIdx, spear.roleIdx)).toBe(fx(0.7) - FX_ONE);
    expect(counterBonus(spear.roleIdx, spear.roleIdx)).toBe(0);
  });

  it('crowdPenalty は 1 体あたり 0.2（手順書 §6.3）', () => {
    expect(crowdPenalty(0)).toBe(0);
    expect(crowdPenalty(1)).toBe(fx(0.2));
    expect(crowdPenalty(3)).toBe(fx(0.2) * 3);
  });

  it('riskFromCount は 4 体で 1.0 に飽和する', () => {
    expect(riskFromCount(0)).toBe(0);
    expect(riskFromCount(2)).toBe(FX_ONE / 2);
    expect(riskFromCount(4)).toBe(FX_ONE);
    expect(riskFromCount(9)).toBe(FX_ONE);
  });

  it('nearSegment は線分の外側・横にずれた点を除く（投石の射線）', () => {
    const a = { x: fxFromInt(0), y: fxFromInt(0) };
    const b = { x: fxFromInt(10), y: fxFromInt(0) };
    const w = fxFromInt(1);
    expect(nearSegment(fxFromInt(5), 0, a.x, a.y, b.x, b.y, w)).toBe(true);
    expect(nearSegment(fxFromInt(5), fxFromInt(3), a.x, a.y, b.x, b.y, w)).toBe(false);
    expect(nearSegment(fxFromInt(15), 0, a.x, a.y, b.x, b.y, w)).toBe(false); // 線分の外
  });
});

// ---------------------------------------------------------------------------
// 令の合成（上段 + 下段）
// ---------------------------------------------------------------------------

describe('令の合成（`07§4` の段の役割分担）', () => {
  it('令が無ければ既定重み（advance 0.3 / hold 0.5 = 近くの敵に応戦）', () => {
    const r = combineOrders(null, null);
    expect(r.weights.advance).toBe(fx(0.3));
    expect(r.weights.hold).toBe(fx(0.5));
    expect(r.weights).toEqual({ ...DEFAULT_WEIGHTS });
  });

  it('上段が移動、下段が対象優先を担当する（死守 + 包囲）', () => {
    const r = combineOrders(orderDefById('hold'), orderDefById('siege'));
    expect(r.weights.hold).toBe(FX_ONE); // 死守の持ち場（上段）
    expect(r.weights.advance).toBe(0); // 前進は上段のまま 0
    expect(r.weights.guard).toBe(FX_ONE); // 護衛は両段の大きい方（包囲）
    expect(r.targetPriority).toEqual(['wall_gate', 'building', 'unit']); // 下段
    expect(r.siegeLead).toBe(true);
  });

  it('下段だけでも成立する（包囲単独）', () => {
    const r = combineOrders(null, orderDefById('siege'));
    expect(r.weights.advance).toBe(fx(0.5));
    expect(r.weights.guard).toBe(FX_ONE);
  });

  it('戦域外は lastOrder を使い、それも無ければ既定重み（`07§3`）', () => {
    const w = makeWorld();
    const i = putUnit(w, 'y-ashigaru', 0, 50, 50);
    expect(resolveOrderForUnit(w, i, null).weights).toEqual({ ...DEFAULT_WEIGHTS });
    w.entities.lastOrder[i] = orderDefById('hold').index + 1;
    const r = resolveOrderForUnit(w, i, null);
    expect(r.weights.hold).toBe(FX_ONE);
    expect(r.fromFront).toBe(false);
  });

  it('離反した戦域は令を無視して既定行動のみ（`07§10`）', () => {
    const w = makeWorld();
    const f = makeFront(w, 0, 1, 50, 50);
    f.order = 'charge';
    f.defected = true;
    const i = putUnit(w, 'y-ashigaru', 0, 50, 50);
    w.entities.frontId[i] = 1;
    w.entities.lastOrder[i] = orderDefById('charge').index + 1;
    const r = resolveOrderForUnit(w, i, f);
    expect(r.upper).toBeNull();
    expect(r.weights).toEqual({ ...DEFAULT_WEIGHTS });
  });
});

// ---------------------------------------------------------------------------
// 判断エンジンの動き
// ---------------------------------------------------------------------------

describe('T-M9-05: 判断エンジン', () => {
  it('12 tick ごとに 1 回だけ評価される（`entityIndex % 12` の分散）', () => {
    const w = makeWorld();
    const i = putUnit(w, 'y-ashigaru', 0, 50, 50); // index 0 → tick % 12 === 0 で評価
    putUnit(w, 'r-hastati', 1, 55, 50);
    rebuildGrid(w.grid, w.entities, w.tick);

    // index 0 は tick 0 に評価される
    w.tick = 1;
    unitDecision(w);
    expect(w.entities.target[i]).toBe(INVALID_ENTITY);
    w.tick = 0;
    unitDecision(w);
    expect(w.entities.target[i]).not.toBe(INVALID_ENTITY);
  });

  it('既定行動: 近くの敵に応戦する（目標が入り、そちらへ向く）', () => {
    const w = makeWorld();
    const i = putUnit(w, 'y-ashigaru', 0, 50, 50);
    const enemy = putUnit(w, 'r-hastati', 1, 56, 50);
    stepDecisionFor(w, i);
    expect(w.entities.target[i]).toBe(w.entities.generation[enemy]! * 0x10000 + enemy);
    expect(w.entities.destX[i]).toBe(fxFromInt(56));
  });

  it('遠すぎる敵は追わない（既定重みの探索半径の外）', () => {
    const w = makeWorld();
    const i = putUnit(w, 'y-ashigaru', 0, 50, 50);
    putUnit(w, 'r-hastati', 1, 120, 50); // 70 マス先
    stepDecisionFor(w, i);
    expect(w.entities.target[i]).toBe(INVALID_ENTITY);
    // 持ち場（= 今いる場所）にとどまる
    expect(w.entities.destX[i]).toBe(fxFromInt(50));
    expect(w.entities.destY[i]).toBe(fxFromInt(50));
  });

  it('**`manual = 1` は丸ごとスキップする**（T-M9-09）', () => {
    const w = makeWorld();
    const i = putUnit(w, 'y-ashigaru', 0, 50, 50);
    putUnit(w, 'r-hastati', 1, 56, 50);
    w.entities.manual[i] = 1;
    w.entities.destX[i] = fxFromInt(99);
    w.entities.destY[i] = fxFromInt(99);
    stepDecisionFor(w, i);
    expect(w.entities.target[i]).toBe(INVALID_ENTITY);
    expect(w.entities.destX[i]).toBe(fxFromInt(99)); // 指示が上書きされていない
  });

  it('収容中・退却中は判断しない（他システムの担当）', () => {
    const w = makeWorld();
    const i = putUnit(w, 'y-ashigaru', 0, 50, 50);
    putUnit(w, 'r-hastati', 1, 56, 50);
    w.entities.state[i] = UnitState.Routed;
    stepDecisionFor(w, i);
    expect(w.entities.target[i]).toBe(INVALID_ENTITY);
  });

  it('戦域の令を受けると lastOrder に控えが残り、閉じた後も同じ挙動を続ける', () => {
    const w = makeWorld();
    const f = makeFront(w, 0, 1, 50, 50);
    f.order = 'hold';
    const i = putUnit(w, 'y-ashigaru', 0, 50, 50);
    w.entities.frontId[i] = 1;
    stepDecisionFor(w, i);
    expect(w.entities.lastOrder[i]).toBe(orderDefById('hold').index + 1);

    // 戦域が閉じる（M8 の消滅処理と同じ状態）
    f.active = false;
    w.entities.frontId[i] = 0;
    const r = resolveOrderForUnit(w, i, null);
    expect(r.weights.hold).toBe(FX_ONE);
  });

  it('村人は採集中に割り込まれない（建設の令のときだけ動く）', () => {
    const w = makeWorld();
    const v = putUnit(w, 'villager', 0, 50, 50);
    putUnit(w, 'r-hastati', 1, 55, 50);
    w.entities.state[v] = UnitState.Gathering;
    w.entities.destX[v] = fxFromInt(60);
    stepDecisionFor(w, v);
    expect(w.entities.destX[v]).toBe(fxFromInt(60)); // 採集の往復が壊れない
  });

  it('**乱数を使っていない**: rng の消費が 0 で、2 回評価しても同じ結果', () => {
    const w = makeWorld();
    for (let k = 0; k < 20; k++) {
      putUnit(w, 'y-ashigaru', 0, 40 + k, 50);
      putUnit(w, 'r-hastati', 1, 60 + k, 52);
    }
    rebuildGrid(w.grid, w.entities, w.tick);
    const before = [w.rngCombat.state, w.rngAi.state, w.rngMap.state];

    const snap = (): string =>
      Array.from({ length: w.entities.highWater }, (_, i) =>
        [w.entities.target[i], w.entities.destX[i], w.entities.destY[i]].join(',')
      ).join('|');

    for (let t = 0; t < DECISION_PERIOD_TICKS; t++) {
      w.tick = t;
      unitDecision(w);
    }
    const a = snap();
    for (let t = 0; t < DECISION_PERIOD_TICKS; t++) {
      w.tick = t;
      unitDecision(w);
    }
    expect(snap()).toBe(a);
    expect([w.rngCombat.state, w.rngAi.state, w.rngMap.state]).toEqual(before);
  });

  it('集中しすぎ防止: 同じ敵に群がるほど不利になる（-0.2/体）', () => {
    const w = makeWorld();
    const attackers: number[] = [];
    for (let k = 0; k < 12; k++) {
      attackers.push(putUnit(w, 'y-ashigaru', 0, 48 + (k % 3), 48 + Math.trunc(k / 3)));
    }
    const e1 = putUnit(w, 'r-hastati', 1, 52, 50);
    const e2 = putUnit(w, 'r-hastati', 1, 53, 51);
    rebuildGrid(w.grid, w.entities, w.tick);
    // 12 tick = 1 周期。数え上げは周期をまたいで積む（1 周期で全員が 1 回判断する）。
    for (let t = 0; t < DECISION_PERIOD_TICKS; t++) {
      w.tick = t;
      unitDecision(w);
    }

    const idOf = (i: number): number => w.entities.generation[i]! * 0x10000 + i;
    let onE1 = 0;
    let onE2 = 0;
    for (const i of attackers) {
      if (w.entities.target[i] === idOf(e1)) onE1++;
      if (w.entities.target[i] === idOf(e2)) onE2++;
    }
    // 1 体に全員が集まらず、2 体目にも割り振られる
    expect(onE1).toBeGreaterThan(0);
    expect(onE2).toBeGreaterThan(0);
    expect(attackers.length).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// 負荷（完了条件）
// ---------------------------------------------------------------------------

describe('T-M9-05: 負荷（400 体で 1 tick 4ms 以内）', () => {
  it('400 体が交戦している状態で unitDecision が 1 tick 4ms 以内', () => {
    const w = makeWorld(2, 2048);
    const f0 = makeFront(w, 0, 1, 100, 100);
    const f1 = makeFront(w, 1, 1, 100, 100);
    f0.order = 'charge';
    f1.order = 'hold';
    // 200 体 × 2 陣営を 40×40 マスにひしめかせる（実戦の最悪ケース）。
    for (let k = 0; k < 200; k++) {
      const a = putUnit(w, k % 3 === 0 ? 'y-kiba' : 'y-ashigaru', 0, 85 + (k % 20), 85 + Math.trunc(k / 20));
      w.entities.frontId[a] = 1;
      const b = putUnit(w, k % 4 === 0 ? 'r-scorpio' : 'r-hastati', 1, 100 + (k % 20), 100 + Math.trunc(k / 20));
      w.entities.frontId[b] = 1;
    }
    expect(w.entities.count).toBe(400);
    rebuildGrid(w.grid, w.entities, 0);

    // 12 tick = 全員が 1 回ずつ評価される 1 周期。ウォームアップ後に計測する。
    for (let t = 0; t < DECISION_PERIOD_TICKS * 4; t++) {
      w.tick = t;
      unitDecision(w);
    }
    const rounds = 20;
    const t0 = performance.now();
    for (let t = 0; t < DECISION_PERIOD_TICKS * rounds; t++) {
      w.tick = t;
      unitDecision(w);
    }
    const perTick = (performance.now() - t0) / (DECISION_PERIOD_TICKS * rounds);
    console.log(`[T-M9-05] 400 体の unitDecision: ${perTick.toFixed(3)} ms/tick`);
    expect(perTick).toBeLessThan(4);
  });
});
