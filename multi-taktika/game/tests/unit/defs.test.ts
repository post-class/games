import { describe, it, expect } from 'vitest';
import {
  BUILDING_DEFS,
  CIV_DEFS,
  ORDER_DEFS,
  ROLE_IDS,
  TECH_DEFS,
  UNIT_DEFS,
  buildingDefById,
  canCivBuild,
  canCivResearch,
  civUnitsAtAge,
  counterMul,
  orderDefById,
  roleToIndex,
  techIndex,
  unitDefById,
  unitIndex,
} from '../../src/sim/core/defs.js';
import {
  MATCH_LENGTH_TICKS,
  TICK_RATE,
  cfgAges,
  cfgFx,
  cfgNum,
  cfgTicks,
} from '../../src/sim/core/config.js';
import { FX_ONE, fx } from '../../src/sim/core/fx.js';
import { ORDER_IDS } from '../../src/shared/types.js';
import { TECH_CAPACITY } from '../../src/sim/core/world.js';

describe('sim/core/config.ts — config.json への型付きアクセサ', () => {
  it('基本定数が手順書 §4.1 のとおり', () => {
    expect(TICK_RATE).toBe(25);
    expect(MATCH_LENGTH_TICKS).toBe(45000); // 30 分
  });

  it('秒 → tick の変換が丸め方まで固定されている', () => {
    // 令の切り替え間隔 6 秒 = 150 tick
    expect(cfgTicks('order.switchIntervalSec')).toBe(150);
    // 戦域の消滅 15 秒 = 375 tick（手順書 §6.1 の検算値）
    expect(cfgTicks('front.closeIdleSec')).toBe(375);
  });

  it('倍率は Fx に変換される', () => {
    expect(cfgFx('combat.counterGood')).toBe(fx(1.5));
    expect(cfgFx('combat.counterBad')).toBe(fx(0.7));
  });

  it('存在しないパスは即例外（綴り間違いを undefined にしない）', () => {
    expect(() => cfgNum('front.spawnRadius')).toThrow(/存在しません/); // 正しくは spawnRadiusTiles
    expect(() => cfgNum('nope.nothing')).toThrow(/存在しません/);
    expect(() => cfgNum('front')).toThrow(/有限の数値/);
  });

  it('ages は 4 時代で、コストとスロットが 03§2 のとおり', () => {
    const ages = cfgAges();
    expect(ages.map((a) => a.id)).toEqual(['reimei', 'seido', 'tekki', 'teikoku']);
    expect(ages.map((a) => a.slots)).toEqual([1, 2, 3, 4]);
    expect(ages[1]?.cost).toEqual({ food: 500 });
    expect(ages[2]?.cost).toEqual({ food: 800, gold: 200 });
    expect(ages[3]?.cost).toEqual({ food: 1000, gold: 800 });
    // 解読時間 130 / 160 / 190 秒
    expect(ages[1]?.researchTicks).toBe(130 * 25);
    expect(ages[2]?.researchTicks).toBe(160 * 25);
    expect(ages[3]?.researchTicks).toBe(190 * 25);
  });
});

describe('sim/core/defs.ts — 定義層', () => {
  it('件数が手順書 §14.2 のとおり', () => {
    expect(UNIT_DEFS.length).toBe(94);
    expect(BUILDING_DEFS.length).toBe(35);
    expect(TECH_DEFS.length).toBe(34);
    expect(ORDER_DEFS.length).toBe(14);
    expect(CIV_DEFS.length).toBe(8);
  });

  it('研究の index が PlayerState.researched の容量に収まる', () => {
    expect(TECH_DEFS.length).toBeLessThanOrEqual(TECH_CAPACITY);
  });

  it('typeId は記述順で、往復が一致する', () => {
    UNIT_DEFS.forEach((u, i) => {
      expect(u.index).toBe(i);
      expect(unitIndex(u.id)).toBe(i);
    });
    BUILDING_DEFS.forEach((b, i) => expect(b.index).toBe(i));
  });

  it('未知の ID は黙って通さず例外にする', () => {
    expect(() => unitIndex('y-samurai')).toThrow(/未知の unit/);
    expect(() => techIndex('nope')).toThrow(/未知の tech/);
    expect(() => roleToIndex('dragon')).toThrow(/未知の role/);
  });

  it('単位変換: 秒→tick / マス→Fx / マス毎秒→Fx毎tick', () => {
    const v = unitDefById('villager');
    expect(v.cost[0]).toBe(fx(50)); // 食料 50（03§4）
    expect(v.pop).toBe(1);
    // 攻撃間隔 2.0 秒 = 50 tick
    expect(v.attackTicks).toBe(50);
    // 速度 0.9 マス/秒 → Fx/tick
    expect(v.speed).toBe(fx(0.9 / 25));
    // 視界 6 マス
    expect(v.sight).toBe(6 * FX_ONE);
  });

  it('攻城兵器は pop 3、戦象は pop 2（03§1 の明記値）', () => {
    expect(unitDefById('r-onager').pop).toBe(3);
    expect(unitDefById('p-elephant').pop).toBe(2);
  });

  it('相性は役割で決まり、兵の名前に依らない（手順書 §6.4）', () => {
    const good = cfgFx('combat.counterGood');
    const bad = cfgFx('combat.counterBad');
    const spear = roleToIndex('spear');
    const cav = roleToIndex('cavalry');
    const ranged = roleToIndex('ranged');

    // 槍 → 騎兵 が有利、騎兵 → 遠隔 が有利、遠隔 → 槍 が有利（03§7 の輪）
    expect(counterMul(spear, cav)).toBe(good);
    expect(counterMul(cav, ranged)).toBe(good);
    expect(counterMul(ranged, spear)).toBe(good);
    // 逆向きは不利
    expect(counterMul(cav, spear)).toBe(bad);

    // ヤマトの長柄組とペルシアの長槍隊は「同じ役割なら同じ倍率」
    const yamato = unitDefById('y-nagae');
    const persia = unitDefById('p-naga');
    expect(yamato.role).toBe(persia.role);
    expect(counterMul(yamato.roleIdx, cav)).toBe(counterMul(persia.roleIdx, cav));
  });

  it('全ユニットの role が相性行列に行を持つ', () => {
    for (const u of UNIT_DEFS) {
      expect(ROLE_IDS, `${u.id}`).toContain(u.role);
    }
  });

  it('文明の置換と禁止が解決される（03§3 / 03§5）', () => {
    // モンゴルは城を建てられず、大天幕が代わり
    expect(canCivBuild('mongol', 'castle')).toBe(false);
    expect(canCivBuild('mongol', 'great_tent')).toBe(true);
    // ヤマトは見張り塔の代わりに櫓
    expect(canCivBuild('yamato', 'watch_tower')).toBe(false);
    expect(canCivBuild('yamato', 'yagura')).toBe(true);
    // 他文明の固有建物は建てられない
    expect(canCivBuild('roma', 'yagura')).toBe(false);
    // ヴァイキングは厩・石壁・城門・火薬工房が建てられない
    for (const b of ['stable', 'stone_wall', 'stone_gate', 'gunpowder_workshop']) {
      expect(canCivBuild('viking', b), b).toBe(false);
    }
    // 付属物は建てられない
    expect(canCivBuild('yamato', 'well')).toBe(false);
  });

  it('文明の研究制限が解決される（03§9）', () => {
    expect(canCivResearch('tou', 'kouba')).toBe(false); // 唐は鋼刃なし
    expect(canCivResearch('azteca', 'kusariyoroi')).toBe(false); // アステカは鉄鎧なし
    expect(canCivResearch('azteca', 'menkou')).toBe(true); // 代わりに綿甲
    expect(canCivResearch('yamato', 'menkou')).toBe(false); // 他文明の固有研究は不可
  });

  it('時代ごとの生産可能ユニットが unitTree どおり', () => {
    // 黎明は共通ユニットのみ（ツリーは空）
    expect(civUnitsAtAge('yamato', 0)).toEqual([]);
    // ヴァイキングとアステカは全時代で騎兵が出ない
    for (const age of [1, 2, 3]) {
      for (const civ of ['viking', 'azteca'] as const) {
        const ids = civUnitsAtAge(civ, age);
        for (const id of ids) {
          expect(unitDefById(id).role, `${civ}/${id}`).not.toBe('cavalry');
        }
      }
    }
    // モンゴルは青銅から騎兵が出る
    const mongolBronze = civUnitsAtAge('mongol', 1);
    expect(mongolBronze.some((id) => unitDefById(id).role === 'cavalry')).toBe(true);
  });

  it('令は 14 件で、tier と重みが Fx になっている', () => {
    const charge = orderDefById('charge');
    expect(charge.tier).toBe('upper');
    expect(charge.weights['advance']).toBe(FX_ONE);
    expect(orderDefById('siege').tier).toBe('lower');
    expect(orderDefById('raid').tier).toBe('lower');
    // 上段 4 + 下段 2 が基本令の固定分類（07§4）
    const base = ORDER_DEFS.filter((o) => o.civ === null);
    expect(base.filter((o) => o.tier === 'upper').length).toBe(4);
    expect(base.filter((o) => o.tier === 'lower').length).toBe(2);
  });

  it('城と大天幕は令の発信点で戦域スロット +1（07§4 / 07§9）', () => {
    for (const id of ['castle', 'great_tent', 'town_center']) {
      expect(buildingDefById(id).isOrderSource, id).toBe(true);
    }
    expect(buildingDefById('castle').frontSlotBonus).toBe(1);
    expect(buildingDefById('great_tent').frontSlotBonus).toBe(1);
    expect(buildingDefById('town_center').frontSlotBonus).toBe(0);
  });
});

describe('令の添字基準は 1 系統だけ（デシンクの温床を防ぐ）', () => {
  it('shared/types.ORDER_IDS と orders.json（ORDER_DEFS）の並びが完全一致する', () => {
    // `Entities.lastOrder` は「令 index + 1」を入れる列で、
    // 書き込む側（front.ts / frontLifecycle.ts）は `shared/types.orderIndex` を、
    // 読む側（combat.formationOfEntity など）は `defs.ORDER_DEFS` の添字を使っている。
    // 両者は現状一致しているが、**片方だけが変わると静かに壊れる**。
    // orders.json にキーを足す・並べ替えるとここが落ちるので、
    // そのとき shared/types.ORDER_IDS も直すこと。
    expect(ORDER_DEFS.map((o) => o.id)).toEqual([...ORDER_IDS]);
  });

  it('orderIndex（shared）と ORDER_DEFS の index が同じ値を返す', () => {
    for (const o of ORDER_DEFS) {
      expect(ORDER_IDS.indexOf(o.id), o.id).toBe(o.index);
    }
  });
});
