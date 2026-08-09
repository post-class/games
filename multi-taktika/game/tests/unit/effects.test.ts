/**
 * T-M6-04: 研究の `effects` 適用エンジン（`src/sim/core/effects.ts`）
 *
 * 検証:
 *  - `techs.json:_meta.effectTypes` の **32 型すべて**を適用エンジンが解釈できる（漏れがあれば落ちる）
 *  - **34 件の研究すべて**が「研究前 / 研究後」で問い合わせ結果を変える
 *  - 文明ボーナス（`econBonus`）と建物由来の効果が同じ経路で効く
 *  - 効果の型ごとの代表値（旗竿 / 復唱 / 早馬 / 二重旗 / 駅伝 / 綿甲 / 狂戦 / 軍団編成 …）
 *  - キャッシュが World の純粋な派生物である（再計算のタイミングで結果が変わらない）
 */

import { describe, expect, it } from 'vitest';
import type { CivId } from '@/shared/types';
import { EntityKind } from '@/shared/types';
import { FX_ONE, fx, fxFromInt, fxToNumber } from '@/sim/core/fx';
import { createWorld, type World } from '@/sim/core/world';
import {
  TECH_DEFS,
  buildingDefById,
  civDefById,
  techDefById,
  techIndex,
  unitDefById,
} from '@/sim/core/defs';
import { spawnEntity } from '@/sim/core/entity';
import {
  PROGRESS_DONE,
  SUPPORTED_EFFECT_TYPES,
  applyUnitStat,
  auraGatherMul,
  auraTrainMul,
  buildCostMul,
  buildSpeedMul,
  buildingLimit,
  buildingSightAdd,
  cartSpeedMul,
  computePlayerModifiers,
  depositMul,
  destroyedSites,
  effectTypesInData,
  eliteCostMul,
  farmYieldMul,
  frontSlotBonus,
  gatherRateMul,
  getPlayerModifiers,
  hashModifiers,
  healSpeedMul,
  isRebuildBlocked,
  isUnitUnlocked,
  isWallHole,
  lowHpAtkBonus,
  markModifiersDirty,
  orderDelayDistanceZero,
  orderDelayMul,
  orderStackSlots,
  orderSwitchIntervalMul,
  produceSpeedMul,
  queueLength,
  rangedResistAdd,
  registerDestroyedSite,
  registeredEffectTypes,
  researchCostMul,
  researchTimeMul,
  shipStatMul,
  startResourceAdd,
  tileMoveSpeedMul,
  tradeIncomeMul,
  unitCostMul,
  unitStatAdd,
  unitStatMul,
} from '@/sim/core/effects';

function makeWorld(civ: CivId = 'yamato', age = 3): World {
  const w = createWorld({
    seed: 1,
    playerCount: 2,
    mapWidthTiles: 64,
    mapHeightTiles: 64,
    civs: [civ, 'roma'],
  });
  w.players[0]!.age = age;
  return w;
}

/** 完成済みの建物を置く（effects の完成判定は `buildProgress = PROGRESS_DONE`）。 */
function placeBuilding(w: World, p: number, id: string, tileX = 10, tileY = 10): number {
  const def = buildingDefById(id);
  const eid = spawnEntity(w.entities, {
    kind: EntityKind.Building,
    owner: p,
    typeId: def.index,
    x: fxFromInt(tileX),
    y: fxFromInt(tileY),
    hpMax: def.hp,
  });
  const idx = eid & 0xffff;
  w.entities.buildProgress[idx] = PROGRESS_DONE;
  markModifiersDirty(w, p);
  return idx;
}

function research(w: World, p: number, techId: string): void {
  w.players[p]!.researched[techIndex(techId)] = 1;
  markModifiersDirty(w, p);
}

describe('効果型の登録簿と実装の網羅性', () => {
  it('登録簿の 32 型すべてを適用エンジンが解釈できる', () => {
    const registered = registeredEffectTypes();
    expect(registered.length).toBe(32);
    for (const t of registered) {
      expect(SUPPORTED_EFFECT_TYPES, `未実装の効果型: ${t}`).toContain(t);
    }
  });

  it('適用エンジン側に登録簿に無い型が無い', () => {
    const registered = registeredEffectTypes();
    for (const t of SUPPORTED_EFFECT_TYPES) {
      expect(registered, `登録簿に無い効果型: ${t}`).toContain(t);
    }
  });

  it('JSON に実際に書かれている型はすべて登録簿にある', () => {
    for (const t of effectTypesInData()) {
      expect(SUPPORTED_EFFECT_TYPES).toContain(t);
    }
  });
});

describe('34 件の研究すべてが効果として作用する', () => {
  it('研究前と研究後で修飾子の指紋が変わる', () => {
    expect(TECH_DEFS.length).toBe(34);
    for (const tech of TECH_DEFS) {
      // 固有研究はその文明で、共通研究はヤマトで確認する。
      const civ = (tech.civ ?? 'yamato') as CivId;
      const w = makeWorld(civ);
      const before = hashModifiers(computePlayerModifiers(w, 0));
      w.players[0]!.researched[tech.index] = 1;
      const after = hashModifiers(computePlayerModifiers(w, 0));
      expect(before, `研究「${tech.name}」(${tech.id}) が何も変えていない`).not.toBe(after);
    }
  });

  it('前提研究に積み上がる（打刃 → 鋼刃で近接攻撃 +2）', () => {
    const w = makeWorld();
    const sword = unitDefById('y-musha');
    const base = unitStatAdd(getPlayerModifiers(w, 0), sword, 'atk');
    expect(base).toBe(0);
    research(w, 0, 'uchiba');
    expect(unitStatAdd(getPlayerModifiers(w, 0), sword, 'atk')).toBe(fx(1));
    research(w, 0, 'kouba');
    expect(unitStatAdd(getPlayerModifiers(w, 0), sword, 'atk')).toBe(fx(2));
  });
});

describe('効果型ごとの代表値', () => {
  it('unitStat: 対象は lines / roles / units の和集合', () => {
    const w = makeWorld('tou');
    research(w, 0, 'kayakujutsu'); // roles:[gunpowder] + units:[t-kasensha]
    const m = getPlayerModifiers(w, 0);
    // 火箭車は role=siege だが units で個別指定されている
    expect(fxToNumber(unitStatMul(m, unitDefById('t-kasensha'), 'atk'))).toBeCloseTo(1.25, 2);
    // 火器（role=gunpowder）
    expect(fxToNumber(unitStatMul(m, unitDefById('t-kaju'), 'atk'))).toBeCloseTo(1.25, 2);
    // 無関係な兵は 1.0
    expect(unitStatMul(m, unitDefById('t-hosotsu'), 'atk')).toBe(FX_ONE);
  });

  it('unitStat: add → mul の順で適用する', () => {
    const w = makeWorld();
    research(w, 0, 'uchiba');
    const def = unitDefById('y-musha');
    const m = getPlayerModifiers(w, 0);
    expect(applyUnitStat(m, def, 'atk', def.atk)).toBe(def.atk + fx(1));
  });

  it('frontSlot: 旗竿で +1', () => {
    const w = makeWorld();
    expect(frontSlotBonus(getPlayerModifiers(w, 0))).toBe(0);
    research(w, 0, 'hatazao');
    expect(frontSlotBonus(getPlayerModifiers(w, 0))).toBe(1);
  });

  it('orderDelayMul: 復唱で 0.5 倍', () => {
    const w = makeWorld();
    research(w, 0, 'fukusho');
    expect(fxToNumber(orderDelayMul(getPlayerModifiers(w, 0)))).toBeCloseTo(0.5, 3);
  });

  it('orderSwitchIntervalMul: 早馬で 0.7 倍（6.0 秒 → 4.2 秒）', () => {
    const w = makeWorld();
    research(w, 0, 'hayaba');
    const mul = fxToNumber(orderSwitchIntervalMul(getPlayerModifiers(w, 0)));
    expect(mul).toBeCloseTo(0.7, 2);
    expect(6.0 * mul).toBeCloseTo(4.2, 1);
  });

  it('orderStackSlots: 二重旗で 2 枚', () => {
    const w = makeWorld();
    expect(orderStackSlots(getPlayerModifiers(w, 0))).toBe(1);
    research(w, 0, 'nijuuhata');
    expect(orderStackSlots(getPlayerModifiers(w, 0))).toBe(2);
  });

  it('orderDelayDistanceZero: モンゴル駅伝', () => {
    const w = makeWorld('mongol');
    expect(orderDelayDistanceZero(getPlayerModifiers(w, 0))).toBe(false);
    research(w, 0, 'ekiden');
    expect(orderDelayDistanceZero(getPlayerModifiers(w, 0))).toBe(true);
  });

  it('gatherRateMul: 資源と採集元で絞られる（両手斧 + 大鋸 = 1.44）', () => {
    const w = makeWorld('roma'); // 文明ボーナスに採集倍率を持たない文明で試す
    research(w, 0, 'ryotebono');
    research(w, 0, 'oonoko');
    const m = getPlayerModifiers(w, 0);
    expect(fxToNumber(gatherRateMul(m, 'wood', 'forest'))).toBeCloseTo(1.44, 2);
    // 資源が違う / 採集元が違うものには掛からない
    expect(gatherRateMul(m, 'food', 'farm')).toBe(FX_ONE);
    expect(gatherRateMul(m, 'wood', 'fish')).toBe(FX_ONE);
  });

  it('gatherRateMul: 文明ボーナスと研究が積算される（ヴァイキングの伐採）', () => {
    const w = makeWorld('viking');
    expect(fxToNumber(gatherRateMul(getPlayerModifiers(w, 0), 'wood', 'forest'))).toBeCloseTo(
      1.15,
      2
    );
    research(w, 0, 'ryotebono');
    expect(fxToNumber(gatherRateMul(getPlayerModifiers(w, 0), 'wood', 'forest'))).toBeCloseTo(
      1.38,
      2
    );
  });

  it('depositMul: 坑道で石材・金の埋蔵量 1.3 倍', () => {
    const w = makeWorld();
    research(w, 0, 'koudou');
    const m = getPlayerModifiers(w, 0);
    expect(fxToNumber(depositMul(m, 'stone'))).toBeCloseTo(1.3, 2);
    expect(fxToNumber(depositMul(m, 'gold'))).toBeCloseTo(1.3, 2);
    expect(depositMul(m, 'food')).toBe(FX_ONE);
  });

  it('farmYieldMul: 犂 + 輪作で乗算に積む', () => {
    const w = makeWorld();
    research(w, 0, 'suki');
    research(w, 0, 'rinsaku');
    expect(fxToNumber(farmYieldMul(getPlayerModifiers(w, 0)))).toBeCloseTo(1.3 * 1.4, 1);
  });

  it('buildingSightAdd: 測量で +4 マス', () => {
    const w = makeWorld();
    research(w, 0, 'sokuryo');
    expect(buildingSightAdd(getPlayerModifiers(w, 0))).toBe(fxFromInt(4));
  });

  it('researchCostMul: 写本で 0.85 倍', () => {
    const w = makeWorld();
    research(w, 0, 'shahon');
    expect(fxToNumber(researchCostMul(getPlayerModifiers(w, 0)))).toBeCloseTo(0.85, 2);
  });

  it('researchTimeMul / researchCostMul: 翰林院はその建物での研究だけに効く', () => {
    const w = makeWorld('tou');
    placeBuilding(w, 0, 'kanrin');
    const m = getPlayerModifiers(w, 0);
    expect(fxToNumber(researchTimeMul(m, 'kanrin'))).toBeCloseTo(0.8, 2);
    // 別の建物での研究時間には効かない
    expect(researchTimeMul(m, 'blacksmith')).toBe(FX_ONE);
    // 翰林院での研究コストも 0.8。
    expect(fxToNumber(researchCostMul(m, 'kanrin'))).toBeCloseTo(0.8, 2);
    // 唐に文明レベルの researchCostMul は無い（翰林院と二重に掛かって 0.64 倍に
    // なっていたため、数値が明記されている建物側だけを残した）。
    // 判断の記録は docs/ISSUES.md の [矛盾] 唐の研究コスト割引。
    expect(researchCostMul(m, 'blacksmith')).toBe(FX_ONE);
  });

  it('produceSpeedMul: 徴兵令は兵だけ +25%（村人は含まない）', () => {
    const w = makeWorld();
    research(w, 0, 'chouheirei');
    const m = getPlayerModifiers(w, 0);
    expect(fxToNumber(produceSpeedMul(m, unitDefById('y-musha'), 'barracks'))).toBeCloseTo(1.25, 2);
    expect(produceSpeedMul(m, unitDefById('villager'), 'town_center')).toBe(FX_ONE);
  });

  it('produceSpeedMul: 文明ボーナスは系統で絞られる（アステカの近接 1.2）', () => {
    const w = makeWorld('azteca');
    const m = getPlayerModifiers(w, 0);
    expect(fxToNumber(produceSpeedMul(m, unitDefById('a-obsidian'), 'barracks'))).toBeCloseTo(
      1.2,
      2
    );
    expect(produceSpeedMul(m, unitDefById('a-atlatl'), 'archery_range')).toBe(FX_ONE);
  });

  it('queueLengthAdd: 既定 5、軍団編成で兵舎・射場・厩が 10', () => {
    const w = makeWorld('roma');
    expect(queueLength(getPlayerModifiers(w, 0), 'barracks')).toBe(5);
    research(w, 0, 'guntan');
    const m = getPlayerModifiers(w, 0);
    expect(queueLength(m, 'barracks')).toBe(10);
    expect(queueLength(m, 'archery_range')).toBe(10);
    expect(queueLength(m, 'stable')).toBe(10);
    // 対象外の建物は 5 のまま
    expect(queueLength(m, 'town_center')).toBe(5);
  });

  it('healSpeedMul: 薬草で 1.5 倍', () => {
    const w = makeWorld();
    research(w, 0, 'yakusou');
    expect(fxToNumber(healSpeedMul(getPlayerModifiers(w, 0)))).toBeCloseTo(1.5, 2);
  });

  it('shipStatMul: 造船で船の耐久 +20%・生産速度 +30%', () => {
    const w = makeWorld('viking');
    research(w, 0, 'zousen');
    const m = getPlayerModifiers(w, 0);
    expect(fxToNumber(shipStatMul(m, 'hp'))).toBeCloseTo(1.2, 2);
    const ship = unitDefById('v-longship');
    expect(fxToNumber(unitStatMul(m, ship, 'hp'))).toBeCloseTo(1.2, 2);
    expect(fxToNumber(produceSpeedMul(m, ship, 'boathouse'))).toBeCloseTo(1.3, 2);
    // 船以外には掛からない
    expect(unitStatMul(m, unitDefById('v-axe'), 'hp')).toBe(FX_ONE);
  });

  it('eliteCostMul: 鋳造でエリートのコスト 0.8 倍', () => {
    const w = makeWorld();
    research(w, 0, 'chuuzou');
    const m = getPlayerModifiers(w, 0);
    expect(fxToNumber(eliteCostMul(m))).toBeCloseTo(0.8, 2);
    expect(fxToNumber(unitCostMul(m, unitDefById('y-bushi')))).toBeCloseTo(0.8, 2);
    // エリート以外には掛からない
    expect(unitCostMul(m, unitDefById('y-musha'))).toBe(FX_ONE);
  });

  it('tradeIncomeMul / cartSpeedMul: 隊商と荷駄', () => {
    const w = makeWorld();
    research(w, 0, 'taisho');
    research(w, 0, 'nida');
    const m = getPlayerModifiers(w, 0);
    expect(fxToNumber(tradeIncomeMul(m))).toBeCloseTo(1.3, 2);
    expect(fxToNumber(cartSpeedMul(m))).toBeCloseTo(1.25, 2);
  });

  it('lowHpAtkBonus: 狂戦は満タン 1.0 → 瀕死 1.5 で線形', () => {
    const w = makeWorld('viking');
    research(w, 0, 'kyousen');
    const m = getPlayerModifiers(w, 0);
    const melee = unitDefById('v-axe');
    expect(lowHpAtkBonus(m, melee, 0)).toBe(FX_ONE);
    expect(fxToNumber(lowHpAtkBonus(m, melee, FX_ONE / 2))).toBeCloseTo(1.25, 2);
    expect(fxToNumber(lowHpAtkBonus(m, melee, FX_ONE))).toBeCloseTo(1.5, 2);
    // 遠隔兵は対象外
    expect(lowHpAtkBonus(m, unitDefById('v-bow'), FX_ONE)).toBe(FX_ONE);
  });

  it('rangedResistAdd: 綿甲で歩兵の遠隔耐性 +3', () => {
    const w = makeWorld('azteca');
    research(w, 0, 'kawayoroi');
    research(w, 0, 'menkou');
    const m = getPlayerModifiers(w, 0);
    expect(rangedResistAdd(m, unitDefById('a-obsidian'))).toBe(fx(3));
    expect(rangedResistAdd(m, unitDefById('a-catapult'))).toBe(0);
  });

  it('buildCostMul: ローマの街道は 0.5 倍（他の建物は 1.0）', () => {
    const w = makeWorld('roma');
    const m = getPlayerModifiers(w, 0);
    expect(fxToNumber(buildCostMul(m, 'road'))).toBeCloseTo(0.5, 2);
    expect(buildCostMul(m, 'house')).toBe(FX_ONE);
  });

  it('buildSpeedMul: アステカの建設 1.3 倍', () => {
    expect(fxToNumber(buildSpeedMul(getPlayerModifiers(makeWorld('azteca'), 0)))).toBeCloseTo(
      1.3,
      2
    );
    expect(buildSpeedMul(getPlayerModifiers(makeWorld('yamato'), 0))).toBe(FX_ONE);
  });

  it('unitCostMul: ヴァイキングの船は 0.85 倍、船小屋でさらに 0.8 倍', () => {
    const w = makeWorld('viking');
    const ship = unitDefById('v-longship');
    expect(fxToNumber(unitCostMul(getPlayerModifiers(w, 0), ship))).toBeCloseTo(0.85, 2);
    placeBuilding(w, 0, 'boathouse');
    expect(fxToNumber(unitCostMul(getPlayerModifiers(w, 0), ship))).toBeCloseTo(0.85 * 0.8, 2);
  });

  it('startResourceAdd: ペルシアの開始資源', () => {
    const m = getPlayerModifiers(makeWorld('persia'), 0);
    expect(startResourceAdd(m, 'food')).toBe(fx(200));
    expect(startResourceAdd(m, 'wood')).toBe(fx(200));
    expect(startResourceAdd(m, 'stone')).toBe(fx(100));
    expect(startResourceAdd(m, 'gold')).toBe(fx(100));
  });

  it('unlockUnits: 船小屋が長船・大長船を解禁する', () => {
    const w = makeWorld('viking');
    const longship = unitDefById('v-longship');
    expect(isUnitUnlocked(getPlayerModifiers(w, 0), longship)).toBe(false);
    placeBuilding(w, 0, 'boathouse');
    expect(isUnitUnlocked(getPlayerModifiers(w, 0), longship)).toBe(true);
  });

  it('buildingLimitOverride: 塩蔵で市場が 3 棟まで', () => {
    const w = makeWorld('mali');
    const market = buildingDefById('market');
    expect(buildingLimit(getPlayerModifiers(w, 0), market)).toBe(1);
    placeBuilding(w, 0, 'salt_store');
    expect(buildingLimit(getPlayerModifiers(w, 0), market)).toBe(3);
    // 塩蔵は交易収入 +25% も持つ
    expect(fxToNumber(tradeIncomeMul(getPlayerModifiers(w, 0)))).toBeCloseTo(1.25, 2);
  });
});

describe('座標依存の効果（オーラ）', () => {
  it('gatherRateAura: 地下水路は半径 8 マス内だけ +15%', () => {
    const w = makeWorld('persia');
    placeBuilding(w, 0, 'qanat', 20, 20);
    expect(fxToNumber(auraGatherMul(w, 0, fxFromInt(22), fxFromInt(20)))).toBeCloseTo(1.15, 2);
    expect(auraGatherMul(w, 0, fxFromInt(40), fxFromInt(20))).toBe(FX_ONE);
    // 他プレイヤーには効かない
    expect(auraGatherMul(w, 1, fxFromInt(22), fxFromInt(20))).toBe(FX_ONE);
  });

  it('trainRateAura: 神殿基壇は兵の生産だけ +20%', () => {
    const w = makeWorld('azteca');
    placeBuilding(w, 0, 'temple_platform', 30, 30);
    expect(fxToNumber(auraTrainMul(w, 0, fxFromInt(35), fxFromInt(30), true))).toBeCloseTo(1.2, 2);
    expect(auraTrainMul(w, 0, fxFromInt(35), fxFromInt(30), false)).toBe(FX_ONE);
    expect(auraTrainMul(w, 0, fxFromInt(60), fxFromInt(30), true)).toBe(FX_ONE);
  });

  it('moveSpeedOnTile: 街道の上だけ +30%（味方にも効く）', () => {
    const w = createWorld({
      seed: 1,
      playerCount: 2,
      mapWidthTiles: 64,
      mapHeightTiles: 64,
      civs: ['roma', 'yamato'],
      teams: [0, 0],
    });
    placeBuilding(w, 0, 'road', 5, 5);
    expect(fxToNumber(tileMoveSpeedMul(w, 0, fxFromInt(5), fxFromInt(5)))).toBeCloseTo(1.3, 2);
    expect(fxToNumber(tileMoveSpeedMul(w, 1, fxFromInt(5), fxFromInt(5)))).toBeCloseTo(1.3, 2);
    expect(tileMoveSpeedMul(w, 0, fxFromInt(6), fxFromInt(5))).toBe(FX_ONE);
  });
});

describe('破壊跡地（forbidRebuildHere / forbidRebuildNearby）', () => {
  it('井戸の跡地は同じ場所に永久に建てられず、周囲の採集が -20%', () => {
    const w = makeWorld();
    const wellIdx = placeBuilding(w, 0, 'well', 12, 12);
    registerDestroyedSite(
      w,
      w.entities.typeId[wellIdx]!,
      w.entities.x[wellIdx]!,
      w.entities.y[wellIdx]!,
      0
    );
    expect(destroyedSites(w).length).toBe(1);
    expect(isRebuildBlocked(w, 'house', fxFromInt(12), fxFromInt(12))).toBe(true);
    expect(isRebuildBlocked(w, 'house', fxFromInt(30), fxFromInt(30))).toBe(false);
    expect(fxToNumber(auraGatherMul(w, 0, fxFromInt(14), fxFromInt(12)))).toBeCloseTo(0.8, 2);
  });

  it('種籾蔵の跡地は周囲 10 マスの農地だけ再建できない', () => {
    const w = makeWorld();
    const idx = placeBuilding(w, 0, 'seed_store', 20, 20);
    registerDestroyedSite(w, w.entities.typeId[idx]!, w.entities.x[idx]!, w.entities.y[idx]!, 0);
    expect(isRebuildBlocked(w, 'farm', fxFromInt(25), fxFromInt(20))).toBe(true);
    // 農地以外は建てられる（同じマスは一般跡地タイマーに掛かるので離す）
    expect(isRebuildBlocked(w, 'house', fxFromInt(25), fxFromInt(20))).toBe(false);
    expect(isRebuildBlocked(w, 'farm', fxFromInt(40), fxFromInt(20))).toBe(false);
  });

  it('壊れた壁の穴は試合中ずっと残る', () => {
    const w = makeWorld();
    const idx = placeBuilding(w, 0, 'palisade', 8, 9);
    registerDestroyedSite(w, w.entities.typeId[idx]!, w.entities.x[idx]!, w.entities.y[idx]!, 0);
    expect(isWallHole(w, fxFromInt(8), fxFromInt(9))).toBe(true);
    // 穴は建て直せる（時間が伸びるだけ。construction.test.ts で検証）
    expect(isRebuildBlocked(w, 'palisade', fxFromInt(8), fxFromInt(9))).toBe(false);
  });
});

describe('キャッシュは World の純粋な派生物', () => {
  it('何度計算しても同じ結果になる', () => {
    const w = makeWorld('mali');
    placeBuilding(w, 0, 'salt_store');
    research(w, 0, 'shahou');
    const a = hashModifiers(computePlayerModifiers(w, 0));
    const b = hashModifiers(computePlayerModifiers(w, 0));
    expect(a).toBe(b);
    expect(hashModifiers(getPlayerModifiers(w, 0))).toBe(a);
  });

  it('同種の建物を 2 つ建てても効果は二重に掛からない', () => {
    const w = makeWorld('tou');
    placeBuilding(w, 0, 'kanrin', 10, 10);
    const one = researchTimeMul(getPlayerModifiers(w, 0), 'kanrin');
    placeBuilding(w, 0, 'kanrin', 20, 20);
    expect(researchTimeMul(getPlayerModifiers(w, 0), 'kanrin')).toBe(one);
  });

  it('文明ごとに独立している', () => {
    const w = createWorld({
      seed: 7,
      playerCount: 2,
      mapWidthTiles: 64,
      mapHeightTiles: 64,
      civs: ['viking', 'yamato'],
    });
    expect(fxToNumber(gatherRateMul(getPlayerModifiers(w, 0), 'wood', 'forest'))).toBeCloseTo(
      1.15,
      2
    );
    expect(gatherRateMul(getPlayerModifiers(w, 1), 'wood', 'forest')).toBe(FX_ONE);
    expect(fxToNumber(gatherRateMul(getPlayerModifiers(w, 1), 'food', 'farm'))).toBeCloseTo(
      1.15,
      2
    );
  });

  it('8 文明すべての econBonus が例外なく適用できる', () => {
    for (const civ of ['yamato', 'roma', 'tou', 'viking', 'mali', 'azteca', 'persia', 'mongol']) {
      const w = makeWorld(civ as CivId);
      const m = getPlayerModifiers(w, 0);
      expect(m.playerId).toBe(0);
      // 唐だけは econBonus が空。「技術研究が安い」は固有建物 翰林院（学舎の置き換え）が
      // 担っており、文明レベルにも置くと 0.64 倍に二重計上されるため外した。
      // 判断の記録は docs/ISSUES.md の [矛盾] 唐の研究コスト割引。
      const expectedBonusCount = civ === 'tou' ? 0 : 1;
      expect(civDefById(civ).econBonus.length, civ).toBeGreaterThanOrEqual(expectedBonusCount);
      if (civ === 'tou') expect(civDefById(civ).econBonus.length).toBe(0);
    }
  });

  it('研究の効果は techDef の定義と対応している（旗竿の例）', () => {
    expect(techDefById('hatazao').effects[0]!['type']).toBe('frontSlot');
  });
});
