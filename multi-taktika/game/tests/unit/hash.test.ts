/**
 * T-M2-07: 状態ハッシュ（実装手順書 §4.5）
 *
 * 検証: **1 ビットの状態差でハッシュが変わる**こと。
 * これが崩れると、対戦中のデシンクを見逃してそのまま試合が進行してしまう。
 */

import { describe, expect, it } from 'vitest';
import { EntityKind } from '@/shared/types';
import { flushDead, markDead, spawnEntity } from '@/sim/core/entity';
import { FX_ONE, fxFromInt } from '@/sim/core/fx';
import { createWorld, type World } from '@/sim/core/world';
import { formatHash, hashWorld } from '@/sim/hash';

function makeWorld(seed = 1234): World {
  const w = createWorld({
    seed,
    playerCount: 4,
    mapWidthTiles: 200,
    mapHeightTiles: 200,
    entityCapacity: 256,
  });
  for (let i = 0; i < 20; i++) {
    spawnEntity(w.entities, {
      kind: i % 3 === 0 ? EntityKind.Building : EntityKind.Unit,
      owner: i % 4,
      typeId: i + 1,
      x: fxFromInt(10 + i),
      y: fxFromInt(20 + i * 2),
      hpMax: fxFromInt(40 + i),
    });
  }
  for (let p = 0; p < 4; p++) {
    w.players[p]!.resources[0] = fxFromInt(200);
    w.players[p]!.resources[1] = fxFromInt(200);
    w.players[p]!.loyalty = FX_ONE;
  }
  const f = w.fronts[0]!;
  f.active = true;
  f.x = fxFromInt(50);
  f.y = fxFromInt(60);
  f.radius = fxFromInt(15);
  return w;
}

/** 状態を 1 箇所だけ変えたときにハッシュが変わることを確認する。 */
function expectHashChanges(name: string, mutate: (w: World) => void): void {
  const a = makeWorld();
  const b = makeWorld();
  expect(hashWorld(a), `前提: 同一状態は同一ハッシュ (${name})`).toBe(hashWorld(b));
  const before = hashWorld(b);
  mutate(b);
  expect(hashWorld(b), `1 ビット差でハッシュが変わる: ${name}`).not.toBe(before);
}

describe('hashWorld の基本性質', () => {
  it('同一状態 → 同一ハッシュ（何度呼んでも同じ）', () => {
    const w = makeWorld();
    const h = hashWorld(w);
    expect(hashWorld(w)).toBe(h);
    expect(hashWorld(makeWorld())).toBe(h);
  });

  it('uint32 を返す', () => {
    const h = hashWorld(makeWorld());
    expect(Number.isInteger(h)).toBe(true);
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThanOrEqual(0xffffffff);
    expect(formatHash(h)).toMatch(/^[0-9a-f]{8}$/);
  });

  it('シードが違えば（rng 状態が違うので）ハッシュが違う', () => {
    expect(hashWorld(makeWorld(1))).not.toBe(hashWorld(makeWorld(2)));
  });
});

describe('T-M2-07: 1 ビットの状態差でハッシュが変わる', () => {
  it('tick', () => {
    expectHashChanges('tick', (w) => {
      w.tick += 1;
    });
  });

  it('エンティティ座標 x を 1/256 マスだけ動かす', () => {
    expectHashChanges('x += 1', (w) => {
      w.entities.x[7] = w.entities.x[7]! + 1;
    });
  });

  it('エンティティ座標 y を 1 だけ動かす', () => {
    expectHashChanges('y += 1', (w) => {
      w.entities.y[3] = w.entities.y[3]! + 1;
    });
  });

  it('HP を 1 だけ減らす', () => {
    expectHashChanges('hp -= 1', (w) => {
      w.entities.hp[11] = w.entities.hp[11]! - 1;
    });
  });

  it('士気を 1 だけ減らす', () => {
    expectHashChanges('morale -= 1', (w) => {
      w.entities.morale[5] = w.entities.morale[5]! - 1;
    });
  });

  it('frontId を変える', () => {
    expectHashChanges('frontId', (w) => {
      w.entities.frontId[2] = 3;
    });
  });

  it('manual フラグを立てる', () => {
    expectHashChanges('manual', (w) => {
      w.entities.manual[4] = 1;
    });
  });

  it('資源を 1/256 だけ増やす', () => {
    expectHashChanges('resources[2] += 1', (w) => {
      w.players[1]!.resources[2] = w.players[1]!.resources[2]! + 1;
    });
  });

  it('忠誠度を 1 だけ減らす', () => {
    expectHashChanges('loyalty -= 1', (w) => {
      w.players[3]!.loyalty -= 1;
    });
  });

  it('時代 / 人口 / 研究済み / スロット数 / 投了 / 敗北', () => {
    expectHashChanges('age', (w) => {
      w.players[0]!.age = 1;
    });
    expectHashChanges('pop', (w) => {
      w.players[0]!.pop = 1;
    });
    expectHashChanges('popCap', (w) => {
      w.players[0]!.popCap = 1;
    });
    expectHashChanges('researched', (w) => {
      w.players[2]!.researched[9] = 1;
    });
    expectHashChanges('frontSlots', (w) => {
      w.players[2]!.frontSlots = 2;
    });
    expectHashChanges('resigned', (w) => {
      w.players[1]!.resigned = true;
    });
    expectHashChanges('defeated', (w) => {
      w.players[1]!.defeated = true;
    });
  });

  it('戦域の中心・半径・優勢度・離反・有効フラグ', () => {
    expectHashChanges('front.x', (w) => {
      w.fronts[0]!.x += 1;
    });
    expectHashChanges('front.y', (w) => {
      w.fronts[0]!.y += 1;
    });
    expectHashChanges('front.radius', (w) => {
      w.fronts[0]!.radius += 1;
    });
    expectHashChanges('front.advantage', (w) => {
      w.fronts[0]!.advantage += 1;
    });
    expectHashChanges('front.defected', (w) => {
      w.fronts[0]!.defected = true;
    });
    expectHashChanges('front.active', (w) => {
      w.fronts[1]!.active = true;
    });
  });

  it('乱数ストリームの状態（1 回消費するだけで変わる）', () => {
    expectHashChanges('rngCombat', (w) => {
      w.rngCombat.nextU32();
    });
    expectHashChanges('rngAi', (w) => {
      w.rngAi.nextU32();
    });
    expectHashChanges('rngMap', (w) => {
      w.rngMap.nextU32();
    });
  });

  it('決着フラグ', () => {
    expectHashChanges('gameOver', (w) => {
      w.gameOver = true;
    });
    expectHashChanges('winner', (w) => {
      w.winner = 0;
    });
  });

  it('エンティティの死亡 / 世代の進行', () => {
    expectHashChanges('markDead', (w) => {
      markDead(w.entities, (0 << 16) | 6);
    });
    expectHashChanges('generation', (w) => {
      markDead(w.entities, (0 << 16) | 6);
      flushDead(w.entities);
      spawnEntity(w.entities, {
        kind: EntityKind.Unit,
        owner: 0,
        typeId: 7,
        x: fxFromInt(16),
        y: fxFromInt(32),
        hpMax: fxFromInt(46),
      });
    });
  });

  it('別プレイヤー間で同じ値を入れ替えても区別される（順序が効いている）', () => {
    const a = makeWorld();
    const b = makeWorld();
    a.players[0]!.resources[0] = fxFromInt(300);
    a.players[1]!.resources[0] = fxFromInt(100);
    b.players[0]!.resources[0] = fxFromInt(100);
    b.players[1]!.resources[0] = fxFromInt(300);
    expect(hashWorld(a)).not.toBe(hashWorld(b));
  });
});
