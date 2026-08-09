/**
 * T-M7-02〜06: ダメージ式と係数（`07§6` / 実装手順書 §6.4）
 *
 * 完了条件は「**手計算した 10 ケースと完全一致**」。
 * したがってこのファイルの期待値は **Fx の整数リテラル** で直書きし、
 * どう計算したかをコメントに残す。`computeDamage` を呼んで期待値を作ってはいけない
 * （それでは実装のバグをそのまま承認してしまう）。
 *
 * Fx の量子化に注意（`damage.ts` の丸めの節）:
 *   1.5  → 384/256 = 1.5        （ぴったり）
 *   0.7  → 179/256 = 0.69921875 （わずかに小さい）
 *   1.15 → 294/256 = 1.1484375
 *   0.9  → 230/256 = 0.8984375
 *   1.4  → 358/256 = 1.3984375
 *   0.5  → 128/256 = 0.5        （ぴったり）
 * `fxMul` は 0 方向切り捨て。倍率は counter → terrain → formation の順に掛ける。
 */

import { describe, expect, it } from 'vitest';
import { FX_ONE, fx } from '@/sim/core/fx';
import { ROLE_IDS, orderDefById, roleToIndex, unitDefById } from '@/sim/core/defs';
import {
  Formation,
  armorForAttackClass,
  computeDamage,
  counterFactor,
  effectiveDefense,
  formationFactor,
  formationFromString,
  friendlyFireDamage,
  isCavalryRole,
  minDamage,
  rangeWithTerrain,
  speedFactor,
  terrainFactor,
} from '@/sim/core/damage';

const SPEAR = roleToIndex('spear');
const SWORD = roleToIndex('sword');
const RANGED = roleToIndex('ranged');
const CAVALRY = roleToIndex('cavalry');
const BEAST = roleToIndex('beast');
const SIEGE = roleToIndex('siege');
const GUNPOWDER = roleToIndex('gunpowder');
const VILLAGER = roleToIndex('villager');

/** 手計算用のヘルパ。ユニット定義から attacker / defender の素の数値だけを取る。 */
function attackOf(id: string) {
  const d = unitDefById(id);
  return {
    atk: d.atk,
    attackClass: d.attackClass,
    pierce: d.pierce,
    role: d.roleIdx,
    aoe: d.aoeRadius > 0,
  };
}
function defenseOf(id: string) {
  const d = unitDefById(id);
  return { def: d.def, pierceDef: d.pierceDef, role: d.roleIdx };
}

/** 手計算 10 ケースを組み立てる小さなラッパ（引数の取り違えを防ぐため）。 */
function dmg(
  attackerId: string,
  defenderId: string,
  opts: {
    attackerElevation?: number;
    defenderElevation?: number;
    defenderFormation?: number;
  } = {}
): number {
  const a = attackOf(attackerId);
  const b = defenseOf(defenderId);
  return computeDamage({
    atk: a.atk,
    def: b.def,
    pierceDef: b.pierceDef,
    attackClass: a.attackClass,
    pierce: a.pierce,
    attackerRole: a.role,
    defenderRole: b.role,
    attackerElevation: opts.attackerElevation ?? 0,
    defenderElevation: opts.defenderElevation ?? 0,
    isAoeAttack: a.aoe,
    defenderFormation: (opts.defenderFormation ?? Formation.Normal) as 0 | 1 | 2 | 3,
  });
}

describe('T-M7-02 ダメージ式（手計算 10 ケース）', () => {
  // 1) 長柄組（spear, atk 11, melee）→ ローマ騎兵（cavalry, def 2）
  //    armor = def = 2（melee なので def を使う）／貫通なし
  //    base = max(1, 11 - 2) = 9 → Fx 2304
  //    counter spear→cavalry = good 1.5 → 2304 * 384 / 256 = 3456（= 13.5）
  it('01 長柄組 → 騎兵（相性有利 1.5）は 13.5', () => {
    expect(dmg('y-nagae', 'r-eq')).toBe(3456);
    expect(3456 / FX_ONE).toBe(13.5);
  });

  // 2) 長槍隊（ペルシア。同じ role = spear, atk 11）→ 同じ騎兵
  //    名前が違っても role が同じなら結果は同じ（T-M7-03 の根拠）
  it('02 長槍隊 → 騎兵も同じ 13.5（名前ではなく役割）', () => {
    expect(dmg('p-naga', 'r-eq')).toBe(3456);
  });

  // 3) 大弓（ranged, atk 6, arrow）→ 長柄組（spear, pierceDef 3）
  //    arrow なので **pierceDef** を使う → armor = 3
  //    base = max(1, 6 - 3) = 3 → 768
  //    counter ranged→spear = good 1.5 → 768 * 384 / 256 = 1152（= 4.5）
  it('03 大弓 → 長柄組（arrow は pierceDef で受ける・有利 1.5）は 4.5', () => {
    expect(dmg('y-daikyu', 'y-nagae')).toBe(1152);
    expect(1152 / FX_ONE).toBe(4.5);
  });

  // 4) 騎兵（cavalry, atk 9, melee）→ 長柄組（spear, def 4）
  //    base = max(1, 9 - 4) = 5 → 1280
  //    counter cavalry→spear = bad 0.7 → fx(0.7) = 179
  //    1280 * 179 / 256 = 895.0 → 895（= 3.49609375。実数の 3.5 ではない）
  it('04 騎兵 → 長柄組（相性不利 0.7）は 895 Fx（3.496…）', () => {
    expect(dmg('r-eq', 'y-nagae')).toBe(895);
  });

  // 5) 鉄砲（gunpowder, atk 16, pierce）→ 重装戦象（beast, pierceDef 5）
  //    gunpowder → pierceDef = 5（Fx 1280）
  //    貫通で半分無視: 1280 * (256 - 128) / 256 = 640（= 2.5）
  //    base = max(1, 4096 - 640) = 3456（= 13.5）
  //    counter gunpowder→beast = good 1.5 → 3456 * 384 / 256 = 5184（= 20.25）
  it('05 鉄砲 → 重装戦象（貫通で防御半分無視・有利 1.5）は 20.25', () => {
    expect(dmg('y-teppo', 'p-elephant-armored')).toBe(5184);
    expect(5184 / FX_ONE).toBe(20.25);
  });

  // 6) 投石機（siege, atk 35, aoe）→ 長柄組（spear, def 4）を **密集**が受ける
  //    aoe なので def = 4 → base = max(1, 35 - 4) = 31（7936）
  //    counter siege→spear = good 1.5 → 7936 * 384 / 256 = 11904
  //    formation dense × aoe = fx(1.4) = 358 → 11904 * 358 / 256 = 16647.0 → 16647
  it('06 投石機 → 密集の長柄組（範囲 × 密集 1.4）は 16647 Fx（65.02…）', () => {
    expect(dmg('a-catapult', 'y-nagae', { defenderFormation: Formation.Dense })).toBe(16647);
  });

  // 7) 同じ投石機 → **通常隊列**の長柄組。formation は掛からない
  it('07 投石機 → 通常隊列の長柄組は 11904 Fx（46.5）', () => {
    expect(dmg('a-catapult', 'y-nagae')).toBe(11904);
    expect(11904 / FX_ONE).toBe(46.5);
  });

  // 8) 武者（sword, atk 9, melee）→ 白刀（sword, def 3）。相性は等倍。
  //    高所（elev 1）から低所（elev 0）へ: fx(1.15) = 294
  //    base = max(1, 9 - 3) = 6（1536） → 1536 * 256 / 256 = 1536 → * 294 / 256 = 1764
  it('08 高所 → 低所は ×1.15（1764 Fx = 6.890625）', () => {
    expect(dmg('y-musha', 't-hakuto', { attackerElevation: 1, defenderElevation: 0 })).toBe(1764);
  });

  // 9) 逆向き（低所 → 高所）: fx(0.9) = 230 → 1536 * 230 / 256 = 1380
  it('09 低所 → 高所は ×0.9（1380 Fx = 5.390625）', () => {
    expect(dmg('y-musha', 't-hakuto', { attackerElevation: 0, defenderElevation: 1 })).toBe(1380);
  });

  // 10) 村人（villager, atk 3, melee）→ 近衛戦象（beast, def 8）
  //     3 - 8 は負なので最低保証 1 が効く。counter villager→beast は等倍。
  //     base = 256 → 256（= 1.0）。**硬い相手にも必ず通る**（`07§6`）
  it('10 村人 → 近衛戦象は最低保証の 1.0（256 Fx）', () => {
    expect(dmg('villager', 'p-guard-elephant')).toBe(256);
  });

  // 11) 弩砲（siege, atk 30, siege クラス, 貫通）→ 重装戦象（pierceDef 5）
  //     siege クラスは pierceDef を使う → 1280 → 貫通で 640
  //     base = 7680 - 640 = 7040（= 27.5）。counter siege→beast は等倍
  it('11 弩砲 → 重装戦象（貫通・等倍）は 7040 Fx（27.5）', () => {
    expect(dmg('r-ballista', 'p-elephant-armored')).toBe(7040);
  });

  // 12) 弓手（ranged, atk 5, arrow）→ 重装騎兵（cavalry, pierceDef 2）
  //     base = max(1, 5 - 2) = 3（768） → counter ranged→cavalry = bad 0.7（179）
  //     768 * 179 / 256 = 537.0 → 537（= 2.09765625）
  it('12 弓手 → 重装騎兵（相性不利）は 537 Fx（2.097…）', () => {
    expect(dmg('t-yumite', 'p-cataphract')).toBe(537);
  });
});

describe('T-M7-03 相性は role で決まる（名前ではない）', () => {
  it('ヤマト長柄組とペルシア長槍隊は騎兵に対して同じ倍率', () => {
    const yamato = unitDefById('y-nagae');
    const persia = unitDefById('p-naga');
    expect(yamato.role).toBe('spear');
    expect(persia.role).toBe('spear');
    expect(yamato.name).not.toBe(persia.name);
    expect(counterFactor(yamato.roleIdx, CAVALRY)).toBe(counterFactor(persia.roleIdx, CAVALRY));
    expect(counterFactor(yamato.roleIdx, CAVALRY)).toBe(fx(1.5));
    // ダメージも一致する（atk / def が同じ組み合わせなので）
    expect(dmg('y-nagae', 'r-eq')).toBe(dmg('p-naga', 'r-eq'));
  });

  it('相性表は 03§7 のとおり', () => {
    expect(counterFactor(SPEAR, CAVALRY)).toBe(fx(1.5));
    expect(counterFactor(SPEAR, BEAST)).toBe(fx(1.5));
    expect(counterFactor(SPEAR, RANGED)).toBe(fx(0.7));
    expect(counterFactor(SWORD, SPEAR)).toBe(fx(1.5));
    expect(counterFactor(RANGED, SWORD)).toBe(fx(1.5));
    expect(counterFactor(CAVALRY, RANGED)).toBe(fx(1.5));
    expect(counterFactor(CAVALRY, SPEAR)).toBe(fx(0.7));
    expect(counterFactor(SIEGE, CAVALRY)).toBe(fx(0.7));
    expect(counterFactor(GUNPOWDER, BEAST)).toBe(fx(1.5));
    // 記載のない組み合わせは等倍
    expect(counterFactor(VILLAGER, SWORD)).toBe(FX_ONE);
  });

  it('role の一覧は 12 種（03§7）', () => {
    expect(ROLE_IDS.length).toBe(12);
  });
});

describe('T-M7-04 貫通・範囲・友軍被害', () => {
  it('貫通は防御の半分を無視する', () => {
    expect(effectiveDefense(fx(6), false)).toBe(fx(6));
    expect(effectiveDefense(fx(6), true)).toBe(fx(3));
    // 奇数でも 0 方向切り捨て（5 → 2.5）
    expect(effectiveDefense(fx(5), true)).toBe(fx(2.5));
    expect(effectiveDefense(0, true)).toBe(0);
  });

  it('装甲は attackClass で選ぶ（melee/aoe = def、arrow/gunpowder/siege = pierceDef）', () => {
    const def = fx(4);
    const pdef = fx(1);
    expect(armorForAttackClass('melee', def, pdef)).toBe(def);
    expect(armorForAttackClass('aoe', def, pdef)).toBe(def);
    expect(armorForAttackClass('arrow', def, pdef)).toBe(pdef);
    expect(armorForAttackClass('gunpowder', def, pdef)).toBe(pdef);
    expect(armorForAttackClass('siege', def, pdef)).toBe(pdef);
  });

  it('友軍被害は 50%', () => {
    expect(friendlyFireDamage(fx(10))).toBe(fx(5));
    expect(friendlyFireDamage(11904)).toBe(5952);
  });

  it('最低保証は 1（config combat.minDamage）', () => {
    expect(minDamage()).toBe(FX_ONE);
  });
});

describe('T-M7-05 地形補正（それぞれ独立に検証できる）', () => {
  it('高所 → 低所 1.15 / 低所 → 高所 0.9 / 同 1.0', () => {
    expect(terrainFactor(2, 1)).toBe(fx(1.15));
    expect(terrainFactor(1, 2)).toBe(fx(0.9));
    expect(terrainFactor(1, 1)).toBe(FX_ONE);
    // 段差の大きさは見ない（1 段でも 3 段でも同じ）
    expect(terrainFactor(3, 0)).toBe(fx(1.15));
  });

  it('森の中の遠隔は射程 −25%（ダメージには掛からない）', () => {
    const range = fx(8); // 8 マス
    expect(rangeWithTerrain(range, true, true)).toBe(fx(6)); // 8 * 0.75
    expect(rangeWithTerrain(range, false, true)).toBe(range);
    // 近接には効かない
    expect(rangeWithTerrain(range, true, false)).toBe(range);
    // ダメージ側の係数は地形（高低）だけで、射程は一切混ざらない
    expect(terrainFactor(0, 0)).toBe(FX_ONE);
  });

  it('水際の騎兵は速度 −30%（ダメージには掛からない）', () => {
    expect(isCavalryRole('cavalry')).toBe(true);
    expect(isCavalryRole('camel')).toBe(true);
    expect(isCavalryRole('spear')).toBe(false);
    expect(speedFactor(true, true, Formation.Normal)).toBe(fx(0.7));
    expect(speedFactor(true, false, Formation.Normal)).toBe(FX_ONE);
    expect(speedFactor(false, true, Formation.Normal)).toBe(FX_ONE);
  });
});

describe('T-M7-06 隊列', () => {
  it('orders.json の formation 文字列を読める', () => {
    expect(formationFromString('dense')).toBe(Formation.Dense);
    expect(formationFromString('loose')).toBe(Formation.Loose);
    expect(formationFromString('escort')).toBe(Formation.Escort);
    expect(formationFromString('normal')).toBe(Formation.Normal);
    expect(formationFromString('なにか未知の値')).toBe(Formation.Normal);
  });

  it('密集が範囲攻撃を受けたときだけ 1.4', () => {
    expect(formationFactor(true, Formation.Dense)).toBe(fx(1.4));
    expect(formationFactor(false, Formation.Dense)).toBe(FX_ONE);
    expect(formationFactor(true, Formation.Normal)).toBe(FX_ONE);
    expect(formationFactor(true, Formation.Loose)).toBe(FX_ONE);
  });

  it('散開は速度 −15%。水際の騎兵と重なると乗算になる', () => {
    expect(speedFactor(false, false, Formation.Loose)).toBe(fx(0.85));
    // 0.7 * 0.85: fx(0.7)=179, fx(0.85)=218 → 256 * 179/256 = 179 → 179 * 218 / 256 = 152
    expect(speedFactor(true, true, Formation.Loose)).toBe(152);
  });

  it('死守（dense）は投石で 1.4 倍、遊撃（loose）は等倍', () => {
    // 令「死守」は orders.json で formation = dense、「遊撃」は loose
    expect(formationFromString(orderDefById('hold').formation)).toBe(Formation.Dense);
    expect(formationFromString(orderDefById('yugeki').formation)).toBe(Formation.Loose);
    const denseHit = dmg('a-catapult', 'y-nagae', { defenderFormation: Formation.Dense });
    const looseHit = dmg('a-catapult', 'y-nagae', { defenderFormation: Formation.Loose });
    expect(denseHit).toBeGreaterThan(looseHit);
    expect(denseHit).toBe(16647);
    expect(looseHit).toBe(11904);
  });
});
