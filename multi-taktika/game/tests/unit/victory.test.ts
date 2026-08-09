/**
 * T-M11-05, T-M11-06: 勝利条件 3 種と敗北判定（`03§10`, 実装手順書 §6.9）
 *
 * 完了条件:
 *  - T-M11-05 制圧 / 碑の写し 6 分 / 服属。**碑の写しの建設開始で全員に位置が公開される**
 *  - T-M11-06 敗北は「町の中心の全喪失」または「忠誠度 0」。**戦域 0 本は敗北でない**
 */

import { describe, expect, it } from 'vitest';
import { EntityKind } from '@/shared/types';
import { AGE_IDS } from '@/shared/types';
import { applyCommands } from '@/sim/command';
import { TICK_RATE, cfgNum } from '@/sim/core/config';
import { buildingDefById } from '@/sim/core/defs';
import { PROGRESS_DONE, markModifiersDirty } from '@/sim/core/effects';
import { entityIndex, markDeadIndex, spawnEntity } from '@/sim/core/entity';
import { fx, fxFromInt } from '@/sim/core/fx';
import { createWorld, getFront, type World } from '@/sim/core/world';
import { cleanup } from '@/sim/systems/cleanup';
import { monumentRemainingTicks, revealedMonuments, victory } from '@/sim/systems/victory';

const MAP = 120;

function makeWorld(playerCount = 2, teams?: readonly number[]): World {
  const w = createWorld({
    seed: 11,
    playerCount,
    mapWidthTiles: MAP,
    mapHeightTiles: MAP,
    entityCapacity: 512,
    ...(teams === undefined ? {} : { teams }),
  });
  for (let p = 0; p < playerCount; p++) {
    w.map.starts[p * 2] = fxFromInt(10 + p * 20);
    w.map.starts[p * 2 + 1] = fxFromInt(10);
  }
  return w;
}

function putBuilding(
  w: World,
  id: string,
  owner: number,
  tileX: number,
  tileY: number,
  complete = true
): number {
  const d = buildingDefById(id);
  const i = entityIndex(
    spawnEntity(w.entities, {
      kind: EntityKind.Building,
      owner,
      typeId: d.index,
      x: fxFromInt(tileX),
      y: fxFromInt(tileY),
      hpMax: d.hp,
    })
  );
  if (complete) w.entities.buildProgress[i] = PROGRESS_DONE;
  markModifiersDirty(w, owner);
  return i;
}

/** 全員に町の中心を 1 つ持たせる（試合開始直後の状態）。 */
function giveTownCenters(w: World): number[] {
  const out: number[] = [];
  for (let p = 0; p < w.playerCount; p++) out.push(putBuilding(w, 'town_center', p, 10 + p * 20, 10));
  return out;
}

// ---------------------------------------------------------------------------
// T-M11-06 敗北判定
// ---------------------------------------------------------------------------

describe('T-M11-06: 敗北判定', () => {
  it('**戦域 0 本は敗北ではない**（序盤の内政だけの時間で負けない）', () => {
    const w = makeWorld();
    giveTownCenters(w);
    for (w.tick = 0; w.tick < 500; w.tick++) victory(w);
    expect(w.gameOver).toBe(false);
    expect(w.players[0]!.defeated).toBe(false);
    expect(w.players[1]!.defeated).toBe(false);
    // 戦域は 1 本も立っていない。
    let active = 0;
    for (const f of w.fronts) if (f.active) active += 1;
    expect(active).toBe(0);
  });

  it('町の中心を全て失うと敗北（制圧）', () => {
    const w = makeWorld();
    const tcs = giveTownCenters(w);
    w.tick = 10;
    victory(w);
    expect(w.players[1]!.defeated).toBe(false);

    markDeadIndex(w.entities, tcs[1]!);
    cleanup(w);
    w.tick = 11;
    victory(w);
    expect(w.players[1]!.defeated).toBe(true);
    expect(w.gameOver).toBe(true);
    expect(w.winner).toBe(0);
  });

  it('町の中心を 1 度も持たなかったプレイヤーは敗北にならない（テスト用 World の保護）', () => {
    const w = makeWorld();
    for (w.tick = 0; w.tick < 10; w.tick++) victory(w);
    expect(w.gameOver).toBe(false);
    expect(w.players[0]!.defeated).toBe(false);
  });

  it('忠誠度 0 で敗北（すべての旗が離反した状態）', () => {
    const w = makeWorld();
    giveTownCenters(w);
    w.players[1]!.loyalty = 0;
    w.tick = 10;
    victory(w);
    expect(w.players[1]!.defeated).toBe(true);
    expect(w.winner).toBe(0);
  });

  it('忠誠度が 1 でも残っていれば敗北しない', () => {
    const w = makeWorld();
    giveTownCenters(w);
    w.players[1]!.loyalty = 1;
    w.tick = 10;
    victory(w);
    expect(w.players[1]!.defeated).toBe(false);
    expect(w.gameOver).toBe(false);
  });

  it('戦域を全部失っても（0 本になっても）敗北しない', () => {
    const w = makeWorld();
    giveTownCenters(w);
    const f = getFront(w, 0, 1)!;
    f.active = true;
    f.x = fxFromInt(50);
    f.y = fxFromInt(50);
    f.radius = fx(cfgNum('front.spawnRadiusTiles'));
    w.tick = 10;
    victory(w);
    f.active = false;
    w.tick = 11;
    victory(w);
    expect(w.players[0]!.defeated).toBe(false);
    expect(w.gameOver).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T-M11-05 服属（投了）
// ---------------------------------------------------------------------------

describe('T-M11-05: 服属（投了）', () => {
  it('resign コマンドで敗北し、相手が勝つ', () => {
    const w = makeWorld();
    giveTownCenters(w);
    applyCommands(w, [{ t: 'resign', p: 1 }]);
    expect(w.players[1]!.resigned).toBe(true);
    w.tick = 10;
    victory(w);
    expect(w.players[1]!.defeated).toBe(true);
    expect(w.gameOver).toBe(true);
    expect(w.winner).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// T-M11-05 碑の写し
// ---------------------------------------------------------------------------

describe('T-M11-05: 碑の写し（6 分守り切る）', () => {
  const HOLD = 360 * TICK_RATE;

  it('**建設開始時点で全プレイヤーに位置が公開される**（未完成でも公開）', () => {
    const w = makeWorld();
    giveTownCenters(w);
    const mon = putBuilding(w, 'monument', 0, 60, 60, false);
    w.tick = 10;
    victory(w);
    const revealed = revealedMonuments(w);
    expect(revealed).toHaveLength(1);
    expect(revealed[0]!.owner).toBe(0);
    expect(revealed[0]!.x).toBe(fxFromInt(60));
    expect(revealed[0]!.y).toBe(fxFromInt(60));
    expect(revealed[0]!.complete).toBe(false);
    expect(revealed[0]!.remainingTicks).toBe(HOLD);
    // 建設中は勝利の時計が動いていない。
    expect(monumentRemainingTicks(w, 0)).toBe(-1);
    expect(mon).toBeGreaterThanOrEqual(0);
  });

  it('帝国の世で完成させて 6 分（9,000 tick）守り切ると勝利', () => {
    const w = makeWorld();
    giveTownCenters(w);
    w.players[0]!.age = AGE_IDS.indexOf('teikoku');
    putBuilding(w, 'monument', 0, 60, 60);
    expect(HOLD).toBe(9000);

    w.tick = 100;
    victory(w);
    expect(w.gameOver).toBe(false);
    expect(monumentRemainingTicks(w, 0)).toBe(HOLD);

    w.tick = 100 + HOLD - 1;
    victory(w);
    expect(w.gameOver).toBe(false);
    expect(monumentRemainingTicks(w, 0)).toBe(1);

    w.tick = 100 + HOLD;
    victory(w);
    expect(w.gameOver).toBe(true);
    expect(w.winner).toBe(0);
  });

  it('帝国の世でなければ守っても勝てない', () => {
    const w = makeWorld();
    giveTownCenters(w);
    w.players[0]!.age = AGE_IDS.indexOf('tekki');
    putBuilding(w, 'monument', 0, 60, 60);
    w.tick = 100;
    victory(w);
    w.tick = 100 + HOLD * 2;
    victory(w);
    expect(w.gameOver).toBe(false);
  });

  it('途中で壊されると時計が捨てられる（建て直しは 0 から）', () => {
    const w = makeWorld();
    giveTownCenters(w);
    w.players[0]!.age = AGE_IDS.indexOf('teikoku');
    const mon = putBuilding(w, 'monument', 0, 60, 60);
    w.tick = 100;
    victory(w);
    expect(monumentRemainingTicks(w, 0)).toBe(HOLD);

    w.tick = 100 + HOLD - 10;
    victory(w);
    markDeadIndex(w.entities, mon);
    cleanup(w);
    w.tick = 100 + HOLD - 9;
    victory(w);
    expect(monumentRemainingTicks(w, 0)).toBe(-1);

    // 建て直しても最初から 6 分。
    putBuilding(w, 'monument', 0, 60, 60);
    w.tick = 100 + HOLD;
    victory(w);
    expect(w.gameOver).toBe(false);
    expect(monumentRemainingTicks(w, 0)).toBe(HOLD);
  });
});

// ---------------------------------------------------------------------------
// T-M11-06 チーム戦
// ---------------------------------------------------------------------------

describe('T-M11-06: チーム戦はチーム単位で決着する', () => {
  it('味方が残っている間は決着しない', () => {
    const w = makeWorld(4, [0, 0, 1, 1]);
    const tcs = giveTownCenters(w);
    w.tick = 10;
    victory(w);

    // 相手チームの 1 人だけ倒す。
    markDeadIndex(w.entities, tcs[2]!);
    cleanup(w);
    w.tick = 11;
    victory(w);
    expect(w.players[2]!.defeated).toBe(true);
    expect(w.gameOver).toBe(false);

    // 相手チームが全滅したら決着。勝者はチーム代表（playerId 最小）。
    markDeadIndex(w.entities, tcs[3]!);
    cleanup(w);
    w.tick = 12;
    victory(w);
    expect(w.gameOver).toBe(true);
    expect(w.winner).toBe(0);
    expect(w.players[1]!.defeated).toBe(false);
  });

  it('全員が倒れたら引き分け（winner = -1）', () => {
    const w = makeWorld(2);
    giveTownCenters(w);
    w.tick = 10;
    victory(w);
    applyCommands(w, [
      { t: 'resign', p: 0 },
      { t: 'resign', p: 1 },
    ]);
    w.tick = 11;
    victory(w);
    expect(w.gameOver).toBe(true);
    expect(w.winner).toBe(-1);
  });

  it('決着後は再判定しない（勝者が上書きされない）', () => {
    const w = makeWorld();
    giveTownCenters(w);
    applyCommands(w, [{ t: 'resign', p: 1 }]);
    w.tick = 10;
    victory(w);
    expect(w.winner).toBe(0);
    w.players[0]!.loyalty = 0;
    w.tick = 11;
    victory(w);
    expect(w.winner).toBe(0);
  });
});
