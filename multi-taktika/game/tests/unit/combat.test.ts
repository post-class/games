/**
 * T-M7-01, 03〜06, 08: 攻撃サイクル・投射物・戦域集計・祈祷師（`07§6`）
 *
 * ダメージ式そのものは `damage.test.ts` が手計算値で守っているので、
 * ここでは「World の上で式が正しい引数で呼ばれ、正しい場所に結果が書かれるか」を見る。
 */

import { describe, expect, it } from 'vitest';
import { EntityKind } from '@/shared/types';
import { createWorld, getFront, type World } from '@/sim/core/world';
import { UnitState, entityIndex, spawnEntity } from '@/sim/core/entity';
import { FX_ONE, fx, fxFromInt } from '@/sim/core/fx';
import { buildingDefById, unitDefById } from '@/sim/core/defs';
import { rebuildGrid } from '@/sim/core/grid';
import { Tile, allocateTerrain, setTile } from '@/sim/core/terrain';
import { combat } from '@/sim/systems/combat';

const MAP = 64;

function makeWorld(): World {
  const w = createWorld({
    seed: 7,
    playerCount: 2,
    mapWidthTiles: MAP,
    mapHeightTiles: MAP,
    entityCapacity: 256,
  });
  allocateTerrain(w.map);
  return w;
}

/** ユニットを 1 体置く。座標はマス単位（整数）。 */
function putUnit(w: World, id: string, owner: number, tx: number, ty: number): number {
  const d = unitDefById(id);
  const eid = spawnEntity(w.entities, {
    kind: EntityKind.Unit,
    owner,
    typeId: d.index,
    x: fxFromInt(tx),
    y: fxFromInt(ty),
    hpMax: d.hp,
  });
  return entityIndex(eid);
}

/** 建物を 1 棟置く。 */
function putBuilding(w: World, id: string, owner: number, tx: number, ty: number): number {
  const d = buildingDefById(id);
  const eid = spawnEntity(w.entities, {
    kind: EntityKind.Building,
    owner,
    typeId: d.index,
    x: fxFromInt(tx),
    y: fxFromInt(ty),
    hpMax: d.hp,
  });
  return entityIndex(eid);
}

/** combat だけを 1 tick 走らせる（stepWorld の 7 番だけを切り出したもの）。 */
function tickCombat(w: World, times = 1): void {
  for (let k = 0; k < times; k++) {
    rebuildGrid(w.grid, w.entities, w.tick);
    combat(w);
    w.tick += 1;
  }
}

/** 戦域スロットを 1 つ立てる（M8 の frontLifecycle の代わり）。 */
function openFront(w: World, slot: number, owner: number): void {
  // 戦域はプレイヤーごとに 6 枠。owner は配列上の位置で決まるので代入しない。
  const f = getFront(w, owner, slot)!;
  f.active = true;
  f.radius = fxFromInt(15);
}

describe('T-M7-01 攻撃サイクル（射程・クールダウン）', () => {
  it('近接は隣接した敵に即座に当たり、双方が殴り合う', () => {
    const w = makeWorld();
    const a = putUnit(w, 'y-nagae', 0, 10, 10); // spear atk 11 / def 4
    const b = putUnit(w, 'r-eq', 1, 11, 10); // cavalry atk 9 / def 2
    const e = w.entities;
    const hpA = e.hp[a]!;
    const hpB = e.hp[b]!;

    tickCombat(w);

    // 長柄組 → 騎兵: damage.test.ts の 01 と同じ 3456
    expect(hpB - e.hp[b]!).toBe(3456);
    // 騎兵 → 長柄組: 04 と同じ 895
    expect(hpA - e.hp[a]!).toBe(895);
    // 攻撃したのでクールダウンが入る（2.0 秒 = 50 tick）
    expect(e.cooldown[a]).toBe(unitDefById('y-nagae').attackTicks);
    expect(e.cooldown[a]).toBe(50);
    expect(e.state[a]).toBe(UnitState.Attacking);
  });

  it('クールダウン中は攻撃しない（50 tick おきに 1 発）', () => {
    const w = makeWorld();
    putUnit(w, 'y-nagae', 0, 10, 10);
    const b = putUnit(w, 'r-eq', 1, 11, 10);
    const e = w.entities;
    const hpB0 = e.hp[b]!;

    tickCombat(w, 50); // tick 0 で 1 発、tick 1..49 はクールダウン
    expect(hpB0 - e.hp[b]!).toBe(3456);
    tickCombat(w); // tick 50 で 2 発目
    expect(hpB0 - e.hp[b]!).toBe(3456 * 2);
  });

  it('射程外には当たらない（近接の間合いは 1 マス）', () => {
    const w = makeWorld();
    const a = putUnit(w, 'y-nagae', 0, 10, 10);
    const b = putUnit(w, 'r-eq', 1, 13, 10);
    const e = w.entities;
    const hp = e.hp[b]!;
    tickCombat(w, 10);
    expect(e.hp[b]).toBe(hp);
    // 空振りしたユニットは 12 tick の探索待ちに入る（負荷対策）。
    // 「攻撃した後の 50 tick」ではないことを確認しておく。
    expect(e.cooldown[a]).toBeLessThan(unitDefById('y-nagae').attackTicks);
    expect(e.state[a]).not.toBe(UnitState.Attacking);
  });

  it('味方は撃たない', () => {
    const w = makeWorld();
    putUnit(w, 'y-nagae', 0, 10, 10);
    const ally = putUnit(w, 'r-eq', 0, 11, 10);
    const e = w.entities;
    const hp = e.hp[ally]!;
    tickCombat(w, 10);
    expect(e.hp[ally]).toBe(hp);
  });

  it('遠隔は投射物を飛ばす。飛翔中は無傷で、着弾 tick に当たる', () => {
    const w = makeWorld();
    putUnit(w, 'y-daikyu', 0, 10, 10); // ranged atk 6 / 射程 5
    const b = putUnit(w, 'y-ashigaru', 1, 14, 10); // spear pierceDef 1
    const e = w.entities;
    const hp0 = e.hp[b]!;

    tickCombat(w); // tick 0: 発射
    let projectiles = 0;
    for (let i = 0; i < e.highWater; i++) {
      if (e.alive[i] === 1 && e.kind[i] === EntityKind.Projectile) projectiles += 1;
    }
    expect(projectiles).toBe(1);
    expect(e.hp[b]).toBe(hp0); // まだ当たっていない

    tickCombat(w, 7); // tick 1..7
    expect(e.hp[b]).toBe(hp0);
    tickCombat(w); // tick 8: 着弾
    // base = max(1, 6 - 1) = 5 → 1280、counter ranged→spear = 1.5 → 1920
    expect(hp0 - e.hp[b]!).toBe(1920);
  });

  it('HP 0 で死亡予約される（解放は cleanup）', () => {
    const w = makeWorld();
    putUnit(w, 'p-cannon', 0, 10, 10); // atk 80、範囲 1.0
    const b = putUnit(w, 'y-ashigaru', 1, 14, 10); // hp 45
    const e = w.entities;
    tickCombat(w, 60);
    expect(e.alive[b]).toBe(0);
    expect(e.hp[b]).toBe(0);
    expect(e.pendingDeadCount).toBeGreaterThan(0);
  });

  it('乱数を 1 度も消費しない（命中確定）', () => {
    const w = makeWorld();
    putUnit(w, 'y-daikyu', 0, 10, 10);
    putUnit(w, 'y-ashigaru', 1, 14, 10);
    const before = w.rngCombat.clone().nextU32();
    tickCombat(w, 60);
    expect(w.rngCombat.clone().nextU32()).toBe(before);
  });

  it('同じ初期状態からは同じ結果になる（決定論）', () => {
    const run = () => {
      const w = makeWorld();
      putUnit(w, 'y-daikyu', 0, 10, 10);
      putUnit(w, 'y-nagae', 0, 11, 12);
      putUnit(w, 'r-eq', 1, 12, 10);
      putUnit(w, 'y-ashigaru', 1, 12, 12);
      tickCombat(w, 200);
      const hp: number[] = [];
      for (let i = 0; i < w.entities.highWater; i++) hp.push(w.entities.hp[i]!);
      return hp;
    };
    expect(run()).toEqual(run());
  });
});

describe('T-M7-01 建物の攻撃', () => {
  it('見張り塔は射程内の敵を撃つ', () => {
    const w = makeWorld();
    const tower = putBuilding(w, 'watch_tower', 0, 10, 10); // attackDamage 12 / 射程 8
    const b = putUnit(w, 'y-ashigaru', 1, 16, 10); // pierceDef 1
    const e = w.entities;
    const hp0 = e.hp[b]!;
    tickCombat(w);
    // base = max(1, 12 - 1) = 11 → 2816、building→spear は等倍
    expect(hp0 - e.hp[b]!).toBe(2816);
    expect(e.cooldown[tower]).toBe(buildingDefById('watch_tower').attackTicks);
  });

  it('射程外の敵は撃たない', () => {
    const w = makeWorld();
    putBuilding(w, 'watch_tower', 0, 10, 10);
    const b = putUnit(w, 'y-ashigaru', 1, 25, 10);
    const e = w.entities;
    const hp0 = e.hp[b]!;
    tickCombat(w, 10);
    expect(e.hp[b]).toBe(hp0);
  });

  it('城は塔より強く撃つ', () => {
    const w = makeWorld();
    putBuilding(w, 'castle', 0, 10, 10); // attackDamage 25
    const b = putUnit(w, 'y-ashigaru', 1, 16, 10);
    const e = w.entities;
    const hp0 = e.hp[b]!;
    tickCombat(w);
    // base = max(1, 25 - 1) = 24 → 6144
    expect(hp0 - e.hp[b]!).toBe(6144);
  });
});

/**
 * 範囲攻撃の検証では **攻撃力 0 の井楼（`y-seiro`）** を的にしている。
 * 近接で殴り合う的だと「投石のダメージ」と「殴り合いのダメージ」が混ざって
 * 期待値が読めなくなるため。井楼は siege / def 2 / pierceDef 5 / hp 220。
 */
describe('T-M7-04 範囲攻撃と友軍被害（投石機が味方も削る）', () => {
  it('投石機の着弾は敵と味方の両方に入り、味方は 50%', () => {
    const w = makeWorld();
    putUnit(w, 'a-catapult', 0, 10, 10); // atk 35 / 射程 8 / aoe 1.5
    const enemy = putUnit(w, 'y-seiro', 1, 18, 10);
    const ally = putUnit(w, 'y-seiro', 0, 19, 10); // 敵の隣（aoe 1.5 マス内）
    const e = w.entities;
    const hpEnemy = e.hp[enemy]!;
    const hpAlly = e.hp[ally]!;

    // aoe の弾は 6 マス/秒 → 8 マスで 33 tick かかる
    tickCombat(w, 40);

    // aoe クラスは def で受ける。base = max(1, 35 - 2) = 33 → 8448
    // counter siege→siege は等倍
    expect(hpEnemy - e.hp[enemy]!).toBe(8448);
    // 味方は 50%
    expect(hpAlly - e.hp[ally]!).toBe(4224);
    expect(hpAlly - e.hp[ally]!).toBe((hpEnemy - e.hp[enemy]!) / 2);
  });

  it('友軍被害 trait を持たない範囲攻撃（大筒）は味方を削らない', () => {
    const w = makeWorld();
    putUnit(w, 'y-ozutsu', 0, 10, 10); // aoe 1.0 だが friendly_fire trait なし
    const enemy = putUnit(w, 'y-seiro', 1, 16, 10);
    const ally = putUnit(w, 'y-seiro', 0, 17, 10);
    const e = w.entities;
    const hpAlly = e.hp[ally]!;
    tickCombat(w, 40);
    expect(e.hp[enemy]).toBeLessThan(e.hpMax[enemy]!);
    expect(e.hp[ally]).toBe(hpAlly);
  });
});

describe('T-M7-05 地形補正', () => {
  it('高所から撃つと 1.15 倍、低所からだと 0.9 倍', () => {
    const flat = () => {
      const w = makeWorld();
      putUnit(w, 'y-musha', 0, 10, 10);
      const b = putUnit(w, 't-hakuto', 1, 11, 10);
      const hp0 = w.entities.hp[b]!;
      tickCombat(w);
      return hp0 - w.entities.hp[b]!;
    };
    const high = () => {
      const w = makeWorld();
      setTile(w.map, 10, 10, Tile.Hill); // 攻撃側だけ丘の上
      putUnit(w, 'y-musha', 0, 10, 10);
      const b = putUnit(w, 't-hakuto', 1, 11, 10);
      const hp0 = w.entities.hp[b]!;
      tickCombat(w);
      return hp0 - w.entities.hp[b]!;
    };
    const low = () => {
      const w = makeWorld();
      setTile(w.map, 11, 10, Tile.Hill); // 防御側が丘の上
      putUnit(w, 'y-musha', 0, 10, 10);
      const b = putUnit(w, 't-hakuto', 1, 11, 10);
      const hp0 = w.entities.hp[b]!;
      tickCombat(w);
      return hp0 - w.entities.hp[b]!;
    };
    expect(flat()).toBe(1536);
    expect(high()).toBe(1764);
    expect(low()).toBe(1380);
  });

  it('森の中の弓は射程が 25% 縮む（4 マス先に届かなくなる）', () => {
    const shoot = (forest: boolean) => {
      const w = makeWorld();
      if (forest) setTile(w.map, 10, 10, Tile.Forest);
      putUnit(w, 'y-daikyu', 0, 10, 10); // 射程 5 → 森なら 3.75
      const b = putUnit(w, 'y-ashigaru', 1, 14, 10); // 4 マス先
      const hp0 = w.entities.hp[b]!;
      tickCombat(w, 20);
      return hp0 - w.entities.hp[b]!;
    };
    expect(shoot(false)).toBeGreaterThan(0);
    expect(shoot(true)).toBe(0);
  });
});

describe('T-M7-06 隊列（死守は密集して投石に弱くなる）', () => {
  it('令「死守」の戦域にいる兵は範囲攻撃を 1.4 倍で受ける', () => {
    const hit = (order: 'hold' | 'charge' | null) => {
      const w = makeWorld();
      openFront(w, 2, 1);
      // 戦域はプレイヤーごとに 6 枠。owner 1 の slot 2 を引く。
      if (order !== null) getFront(w, 1, 2)!.order = order;
      putUnit(w, 'a-catapult', 0, 10, 10);
      const b = putUnit(w, 'y-seiro', 1, 18, 10);
      w.entities.frontId[b] = 2;
      const hp0 = w.entities.hp[b]!;
      tickCombat(w, 40);
      return hp0 - w.entities.hp[b]!;
    };
    // 令なし・突撃（normal）は 8448、死守（dense）は 8448 * 358 / 256 = 11814
    expect(hit(null)).toBe(8448);
    expect(hit('charge')).toBe(8448);
    expect(hit('hold')).toBe(11814);
  });
});

describe('T-M7-01 戦域への集計（優勢度の材料）', () => {
  it('与ダメージ・被ダメージがリングバッファに積まれ、lastEngageTick が動く', () => {
    const w = makeWorld();
    openFront(w, 1, 0);
    openFront(w, 2, 1);
    const a = putUnit(w, 'y-nagae', 0, 10, 10);
    const b = putUnit(w, 'r-eq', 1, 11, 10);
    w.entities.frontId[a] = 1;
    w.entities.frontId[b] = 2;
    w.tick = 100;

    tickCombat(w);

    const f1 = getFront(w, 0, 1)!;
    const f2 = getFront(w, 1, 2)!;
    const pos = 100 % 250;
    expect(f1.ringPos).toBe(pos);
    expect(f1.dmgDealt[pos]).toBe(3456); // 長柄組 → 騎兵
    expect(f1.dmgTaken[pos]).toBe(895); // 騎兵 → 長柄組
    expect(f2.dmgDealt[pos]).toBe(895);
    expect(f2.dmgTaken[pos]).toBe(3456);
    expect(f1.lastEngageTick).toBe(100);
    expect(f2.lastEngageTick).toBe(100);
  });

  it('250 tick 後に同じスロットへ書くとき、古い値は消される', () => {
    const w = makeWorld();
    openFront(w, 1, 0);
    const f = w.fronts[0]!;
    const a = putUnit(w, 'y-nagae', 0, 10, 10);
    const b = putUnit(w, 'r-eq', 1, 11, 10);
    w.entities.frontId[a] = 1;
    w.entities.frontId[b] = 2;

    tickCombat(w); // tick 0 で 1 発
    expect(f.dmgDealt[0]).toBe(3456);
    w.tick = 250; // 1 周回った
    tickCombat(w);
    // 攻撃はクールダウン中で発生しないが、スロットは 0 に戻っている
    expect(f.dmgDealt[0]).toBe(0);
  });

  it('友軍被害は与ダメージに数えず、lastEngageTick も動かさない', () => {
    const w = makeWorld();
    openFront(w, 1, 0);
    const f = w.fronts[0]!;
    const cat = putUnit(w, 'a-catapult', 0, 10, 10);
    const ally = putUnit(w, 'y-seiro', 0, 19, 10);
    const enemy = putUnit(w, 'y-seiro', 1, 18, 10);
    w.entities.frontId[cat] = 1;
    w.entities.frontId[ally] = 1;
    w.entities.frontId[enemy] = 0;
    tickCombat(w, 40);

    const sum = (buf: Int32Array) => buf.reduce((a, b) => a + b, 0);
    // 敵に入れた分だけが dealt。味方に入れた分は taken にだけ乗る。
    expect(sum(f.dmgDealt)).toBe(8448);
    expect(sum(f.dmgTaken)).toBe(4224);
    expect(w.entities.hp[ally]).toBeLessThan(w.entities.hpMax[ally]!);
  });
});

describe('T-M7-08 祈祷師の治療', () => {
  it('射程内で最も傷ついた味方の HP を戻す', () => {
    const w = makeWorld();
    const priest = putUnit(w, 'priest', 0, 10, 10); // 射程 4 / 2 秒ごと
    const hurt = putUnit(w, 'y-nagae', 0, 12, 10);
    const light = putUnit(w, 'y-musha', 0, 11, 10);
    const e = w.entities;
    e.hp[hurt] = e.hpMax[hurt]! - fx(20);
    e.hp[light] = e.hpMax[light]! - fx(2);

    tickCombat(w);
    // 既定 5 HP。欠損の大きい方（hurt）が優先される
    expect(e.hp[hurt]).toBe(e.hpMax[hurt]! - fx(15));
    expect(e.hp[light]).toBe(e.hpMax[light]! - fx(2));
    expect(e.cooldown[priest]).toBe(unitDefById('priest').attackTicks);
  });

  it('HP 上限を超えて回復しない', () => {
    const w = makeWorld();
    putUnit(w, 'priest', 0, 10, 10);
    const hurt = putUnit(w, 'y-nagae', 0, 11, 10);
    const e = w.entities;
    e.hp[hurt] = e.hpMax[hurt]! - fx(1);
    tickCombat(w);
    expect(e.hp[hurt]).toBe(e.hpMax[hurt]);
  });

  it('祈祷師は敵を攻撃しない（atk 0）', () => {
    const w = makeWorld();
    putUnit(w, 'priest', 0, 10, 10);
    const enemy = putUnit(w, 'y-nagae', 1, 11, 10);
    const e = w.entities;
    const hp0 = e.hp[enemy]!;
    tickCombat(w);
    // 祈祷師自身は殴られるが、こちらからは撃たない
    expect(e.hp[enemy]).toBe(hp0);
  });

  it('敵は治療しない', () => {
    const w = makeWorld();
    putUnit(w, 'priest', 0, 10, 10);
    const enemy = putUnit(w, 'y-musha', 1, 12, 10);
    const e = w.entities;
    e.hp[enemy] = e.hpMax[enemy]! - fx(20);
    const hp0 = e.hp[enemy]!;
    tickCombat(w);
    expect(e.hp[enemy]).toBe(hp0);
  });
});

describe('退却中のユニット', () => {
  it('士気 0 で退却中（Routed）の兵は攻撃しない', () => {
    const w = makeWorld();
    const a = putUnit(w, 'y-nagae', 0, 10, 10);
    const b = putUnit(w, 'r-eq', 1, 11, 10);
    const e = w.entities;
    e.state[a] = UnitState.Routed;
    e.morale[a] = 0;
    const hp0 = e.hp[b]!;
    tickCombat(w);
    expect(e.hp[b]).toBe(hp0);
    // 相手からは殴られる
    expect(e.hp[a]).toBeLessThan(e.hpMax[a]!);
  });
});

describe('士気は HP と独立して満タンで始まる', () => {
  it('spawn 直後の morale は FX_ONE', () => {
    const w = makeWorld();
    const a = putUnit(w, 'y-nagae', 0, 10, 10);
    expect(w.entities.morale[a]).toBe(FX_ONE);
  });
});
