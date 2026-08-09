import { describe, expect, it } from 'vitest';

import rawUnits from '../../src/data/units.json';

/**
 * T-M1-05 `units.json` の検証。
 * 上流資料: docs/03_文明と進化.html §4 §5 §6 §7 §8
 * 規約: src/data/README.md（ID 一覧）/ 実装手順書 §5.2 §14.2
 */

type Cost = Partial<Record<'food' | 'wood' | 'stone' | 'gold', number>>;

interface Unit {
  name: string;
  civ: string | null;
  age: string;
  role: string;
  line: string | null;
  tier: number;
  producedAt: string;
  cost: Cost;
  buildSec: number;
  pop: number;
  hp: number;
  atk: number;
  def: number;
  pierceDef: number;
  rangeTiles: number;
  attackSec: number;
  speedTilesPerSec: number;
  sightTiles: number;
  attackClass: string;
  pierce: boolean;
  aoeRadiusTiles: number;
  sprite: string;
  upgradeTo?: string;
  traits?: string[];
  note?: string;
}

const { _meta: meta, ...unitsRecord } = rawUnits as unknown as {
  _meta: unknown;
  [id: string]: unknown;
};
const units = unitsRecord as Record<string, Unit>;
const ids = Object.keys(units);
const entries = Object.entries(units);

// ---------------------------------------------------------------- ID 一覧（README より転記）

const COMMON_IDS = ['villager', 'clubman', 'hunter', 'scout'];

const SUPPORT_IDS = [
  'herald',
  'trade_cart',
  'priest',
  'fishing_boat',
  'transport_ship',
  'warship',
  'fire_ship',
];

const TREE_IDS = [
  // ヤマト
  'y-ashigaru', 'y-musha', 'y-nagae',
  'y-yumiashigaru', 'y-daikyu', 'y-teppo',
  'y-horo', 'y-kiba',
  'y-seiro', 'y-ozutsu',
  // ローマ
  'r-hastati', 'r-principes', 'r-triarii',
  'r-slinger', 'r-scorpio', 'r-handgun',
  'r-eq-light', 'r-eq', 'r-eq-heavy',
  'r-ram', 'r-ballista', 'r-onager',
  // 唐
  't-hosotsu', 't-hakuto', 't-nagayari',
  't-yumite', 't-dote', 't-kaju',
  't-keiki', 't-tekki',
  't-shoshido', 't-kasensha',
  // ヴァイキング
  'v-raider', 'v-shield', 'v-axe',
  'v-javelin', 'v-bow',
  'v-fire', 'v-ram',
  'v-longship', 'v-greatship',
  // マリ
  'm-yarite', 'm-menko', 'm-naga',
  'm-yumi', 'm-daikyu', 'm-hinawa',
  'm-camel', 'm-camel-heavy',
  'm-ram', 'm-catapult',
  // アステカ
  'a-club', 'a-obsidian', 'a-feather',
  'a-blowgun', 'a-atlatl',
  'a-catapult', 'a-bigcatapult',
  // ペルシア
  'p-immortal', 'p-shield', 'p-naga',
  'p-bow', 'p-daikyu', 'p-gun',
  'p-cav', 'p-cataphract',
  'p-elephant', 'p-elephant-armored',
  'p-tower', 'p-cannon',
  // モンゴル
  'g-dismount',
  'g-light', 'g-archer', 'g-heavy',
  'g-catapult',
];

const ELITE_IDS = [
  'y-bushi',
  'r-legion',
  't-renkyu',
  'v-berserk',
  'm-guard-archer',
  'a-jaguar',
  'p-guard-elephant',
  'g-guard-horsearcher',
];

const ALL_IDS = [...COMMON_IDS, ...SUPPORT_IDS, ...TREE_IDS, ...ELITE_IDS];

const CIV_IDS = ['yamato', 'roma', 'tou', 'viking', 'mali', 'azteca', 'persia', 'mongol'];
const AGE_IDS = ['reimei', 'seido', 'tekki', 'teikoku'];
const RESOURCE_IDS = ['food', 'wood', 'stone', 'gold'];
const ROLE_IDS = [
  'spear', 'sword', 'ranged', 'cavalry', 'camel', 'beast',
  'siege', 'gunpowder', 'ship', 'villager', 'support', 'building',
];
const LINE_IDS = ['melee', 'ranged', 'cavalry', 'beast', 'siege', 'ship', 'elite'];
const BUILDING_IDS = [
  'town_center', 'barracks', 'archery_range', 'stable', 'siege_workshop',
  'shrine', 'castle', 'dock', 'harbor', 'market', 'gunpowder_workshop', 'great_tent',
];
const ATTACK_CLASS_IDS = ['melee', 'arrow', 'gunpowder', 'siege', 'aoe'];

const byCiv = (civ: string): [string, Unit][] => entries.filter(([, u]) => u.civ === civ);

// ---------------------------------------------------------------- 件数と ID

describe('units.json — 件数と ID', () => {
  it('_meta を除いてちょうど 94 件（03 / §14.2）', () => {
    expect(ids).toHaveLength(94);
  });

  it('内訳が 共通 4 / 支援 7 / ツリー 75 / エリート 8', () => {
    expect(COMMON_IDS).toHaveLength(4);
    expect(SUPPORT_IDS).toHaveLength(7);
    expect(TREE_IDS).toHaveLength(75);
    expect(ELITE_IDS).toHaveLength(8);
    expect(ALL_IDS).toHaveLength(94);
  });

  it('README の 94 個の ID がすべて存在する', () => {
    const missing = ALL_IDS.filter((id) => !(id in units));
    expect(missing).toEqual([]);
  });

  it('README にない余分な ID がない', () => {
    const extra = ids.filter((id) => !ALL_IDS.includes(id));
    expect(extra).toEqual([]);
  });

  it('_meta にステータス決定規則が書かれている（§0.5）', () => {
    expect(meta).toBeTruthy();
    const m = meta as Record<string, unknown>;
    for (const key of ['statRule', 'costRule', 'tierRule', 'civSharpness', 'holes', 'fromSource']) {
      expect(m[key], key).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------- 共通スキーマ

describe('units.json — 共通スキーマ', () => {
  it.each(entries)('%s のフィールドが規約どおり', (id, u) => {
    expect(typeof u.name).toBe('string');
    expect(u.name.length).toBeGreaterThan(0);
    expect(u.civ === null || CIV_IDS.includes(u.civ)).toBe(true);
    expect(AGE_IDS).toContain(u.age);
    expect(ROLE_IDS).toContain(u.role);
    expect(u.line === null || LINE_IDS.includes(u.line)).toBe(true);
    expect(u.tier).toBeGreaterThanOrEqual(0);
    expect(u.tier).toBeLessThanOrEqual(3);
    expect(BUILDING_IDS).toContain(u.producedAt);
    expect(ATTACK_CLASS_IDS).toContain(u.attackClass);
    expect(u.sprite).toBe(`units/${id}.webp`);
    for (const [res, amount] of Object.entries(u.cost)) {
      expect(RESOURCE_IDS, `${id} cost key`).toContain(res);
      expect(amount, `${id} cost ${res}`).toBeGreaterThan(0);
    }
    expect(Object.keys(u.cost).length).toBeGreaterThan(0);
    for (const numeric of [
      'buildSec', 'pop', 'hp', 'atk', 'def', 'pierceDef',
      'rangeTiles', 'attackSec', 'speedTilesPerSec', 'sightTiles', 'aoeRadiusTiles',
    ] as const) {
      expect(typeof u[numeric], `${id}.${numeric}`).toBe('number');
      expect(u[numeric], `${id}.${numeric}`).toBeGreaterThanOrEqual(0);
    }
    expect(u.hp).toBeGreaterThan(0);
    expect(typeof u.pierce).toBe('boolean');
  });

  it('共通・支援ユニットは civ が null で tier 0', () => {
    for (const id of [...COMMON_IDS, ...SUPPORT_IDS]) {
      expect(units[id]!.civ, id).toBeNull();
      expect(units[id]!.tier, id).toBe(0);
    }
  });

  it('文明ユニットは civ が設定され、ID 接頭辞と一致する', () => {
    const prefix: Record<string, string> = {
      yamato: 'y-', roma: 'r-', tou: 't-', viking: 'v-',
      mali: 'm-', azteca: 'a-', persia: 'p-', mongol: 'g-',
    };
    for (const id of [...TREE_IDS, ...ELITE_IDS]) {
      const u = units[id]!;
      expect(u.civ, id).not.toBeNull();
      expect(id.startsWith(prefix[u.civ!]!), `${id} / ${u.civ}`).toBe(true);
    }
  });

  it('tier は age と 1 対 1（seido=1 / tekki=2 / teikoku=3）', () => {
    const expected: Record<string, number> = { seido: 1, tekki: 2, teikoku: 3 };
    for (const id of [...TREE_IDS, ...ELITE_IDS]) {
      const u = units[id]!;
      expect(u.tier, `${id} (${u.age})`).toBe(expected[u.age]);
    }
  });

  it('upgradeTo の参照先が全部存在し、自分自身でなく、同じ line・同じ civ', () => {
    for (const [id, u] of entries) {
      if (!u.upgradeTo) continue;
      expect(units, `${id} -> ${u.upgradeTo}`).toHaveProperty(u.upgradeTo);
      expect(u.upgradeTo).not.toBe(id);
      const next = units[u.upgradeTo]!;
      expect(next.line, `${id} -> ${u.upgradeTo} line`).toBe(u.line);
      expect(next.civ, `${id} -> ${u.upgradeTo} civ`).toBe(u.civ);
      expect(next.tier, `${id} -> ${u.upgradeTo} tier`).toBeGreaterThan(u.tier);
    }
  });

  it('traits はあれば非空の文字列配列', () => {
    for (const [id, u] of entries) {
      if (u.traits === undefined) continue;
      expect(Array.isArray(u.traits), id).toBe(true);
      expect(u.traits.length, id).toBeGreaterThan(0);
      for (const t of u.traits) {
        expect(typeof t, id).toBe('string');
        expect(t).toMatch(/^[a-z_]+$/);
      }
    }
  });
});

// ---------------------------------------------------------------- 資料に書かれたコスト（03§4）

describe('コスト転記 — 共通ユニット 4 種（03§4）', () => {
  const expected: Record<string, Cost> = {
    villager: { food: 50 },
    clubman: { food: 50 },
    hunter: { food: 40, wood: 20 },
    scout: { food: 30 },
  };
  it.each(Object.entries(expected))('%s のコストが資料どおり', (id, cost) => {
    expect(units[id]!.cost).toEqual(cost);
  });
});

describe('コスト転記 — 支援ユニット 7 種（03§4）', () => {
  const expected: Record<string, Cost> = {
    herald: { food: 30 },
    trade_cart: { wood: 100 },
    priest: { gold: 100 },
    fishing_boat: { wood: 75 },
    transport_ship: { wood: 125 },
    warship: { wood: 90, gold: 30 },
    fire_ship: { wood: 75 },
  };
  it.each(Object.entries(expected))('%s のコストが資料どおり', (id, cost) => {
    expect(units[id]!.cost).toEqual(cost);
  });

  it('支援ユニットの世が資料どおり', () => {
    const ages: Record<string, string> = {
      herald: 'seido',
      trade_cart: 'seido',
      priest: 'tekki',
      fishing_boat: 'reimei',
      transport_ship: 'tekki',
      warship: 'tekki',
      fire_ship: 'tekki',
    };
    for (const [id, age] of Object.entries(ages)) expect(units[id]!.age, id).toBe(age);
  });
});

// ---------------------------------------------------------------- 資料に書かれたコスト（03§6 攻城 12 形式 / 16 件）

const SIEGE_UNIT_IDS = [
  'y-seiro', 'y-ozutsu',
  'r-ram', 'r-ballista', 'r-onager',
  't-shoshido', 't-kasensha',
  'v-fire', 'v-ram',
  'm-ram', 'm-catapult',
  'a-catapult', 'a-bigcatapult',
  'p-tower', 'p-cannon',
  'g-catapult',
];

describe('コスト転記 — 攻城兵器（03§6 の 12 形式 = 16 エントリ）', () => {
  const expected: Record<string, Cost> = {
    // 破城槌（ローマ・ヴァイキング・マリ）木 160 / 金 75
    'r-ram': { wood: 160, gold: 75 },
    'v-ram': { wood: 160, gold: 75 },
    'm-ram': { wood: 160, gold: 75 },
    // 井楼（ヤマト）木 200
    'y-seiro': { wood: 200 },
    // 攻城塔（ペルシア）木 220 / 金 100
    'p-tower': { wood: 220, gold: 100 },
    // 投石機（アステカ・マリ）木 200 / 石 150
    'a-catapult': { wood: 200, stone: 150 },
    'm-catapult': { wood: 200, stone: 150 },
    // 大投石機（アステカ）木 250 / 石 250
    'a-bigcatapult': { wood: 250, stone: 250 },
    // バリスタ／床子弩（ローマ・唐）木 180 / 金 100
    'r-ballista': { wood: 180, gold: 100 },
    't-shoshido': { wood: 180, gold: 100 },
    // オナゲル（ローマ）木 200 / 石 200
    'r-onager': { wood: 200, stone: 200 },
    // 火箭車（唐）木 200 / 金 200
    't-kasensha': { wood: 200, gold: 200 },
    // 大筒（ヤマト）木 200 / 金 180
    'y-ozutsu': { wood: 200, gold: 180 },
    // 大砲（ペルシア）木 220 / 金 220
    'p-cannon': { wood: 220, gold: 220 },
    // 焼き討ち隊（ヴァイキング）食 80 / 木 40
    'v-fire': { food: 80, wood: 40 },
    // 簡易投石機（モンゴル）木 180 / 石 100
    'g-catapult': { wood: 180, stone: 100 },
  };

  it('攻城の ID 集合が line=siege のユニットと一致する（16 件）', () => {
    const actual = entries.filter(([, u]) => u.line === 'siege').map(([id]) => id).sort();
    expect(actual).toEqual([...SIEGE_UNIT_IDS].sort());
  });

  it.each(Object.entries(expected))('%s のコストが資料どおり', (id, cost) => {
    expect(units[id]!.cost).toEqual(cost);
  });

  it('攻城兵器の pop は 3。ただし焼き討ち隊は「兵器ではなく歩兵」なので 1（03§6）', () => {
    for (const id of SIEGE_UNIT_IDS) {
      const expectedPop = id === 'v-fire' ? 1 : 3;
      expect(units[id]!.pop, id).toBe(expectedPop);
    }
  });

  it('簡易投石機の威力は投石機の 60%（03§6）', () => {
    expect(units['g-catapult']!.atk).toBe(Math.round(units['a-catapult']!.atk * 0.6));
  });

  it('攻城兵器は siege_workshop で生産（焼き討ち隊は歩兵なので兵舎）', () => {
    for (const id of SIEGE_UNIT_IDS) {
      expect(units[id]!.producedAt, id).toBe(id === 'v-fire' ? 'barracks' : 'siege_workshop');
    }
  });
});

// ---------------------------------------------------------------- 資料に書かれたコスト（03§8 エリート 8）

describe('コスト転記 — 城のエリート 8 種（03§8）', () => {
  const expected: Record<string, Cost> = {
    'y-bushi': { food: 60, gold: 30 },
    'r-legion': { food: 65, gold: 25 },
    't-renkyu': { wood: 40, gold: 40 },
    'v-berserk': { food: 65, gold: 25 },
    'm-guard-archer': { wood: 40, gold: 35 },
    'a-jaguar': { food: 60, gold: 30 },
    'p-guard-elephant': { food: 200, gold: 75 },
    'g-guard-horsearcher': { wood: 50, gold: 65 },
  };

  it.each(Object.entries(expected))('%s のコストが資料どおり', (id, cost) => {
    expect(units[id]!.cost).toEqual(cost);
  });

  it('全エリートが金を要する（03§8）', () => {
    for (const id of ELITE_IDS) expect(units[id]!.cost.gold, id).toBeGreaterThan(0);
  });

  it('line=elite は 8 件で、城（モンゴルのみ大天幕）で生産', () => {
    const elites = entries.filter(([, u]) => u.line === 'elite').map(([id]) => id).sort();
    expect(elites).toEqual([...ELITE_IDS].sort());
    for (const id of ELITE_IDS) {
      expect(units[id]!.producedAt, id).toBe(
        units[id]!.civ === 'mongol' ? 'great_tent' : 'castle',
      );
    }
  });

  it('資料の特性が trait で表現されている（コードに兵名の分岐を書かせない）', () => {
    const expectedTraits: Record<string, string> = {
      'y-bushi': 'anti_elite',
      'r-legion': 'formation_defense',
      't-renkyu': 'multi_shot',
      'v-berserk': 'self_heal',
      'm-guard-archer': 'armor_pierce',
      'a-jaguar': 'anti_infantry',
      'p-guard-elephant': 'knockback',
      'g-guard-horsearcher': 'move_and_shoot',
    };
    for (const [id, trait] of Object.entries(expectedTraits)) {
      expect(units[id]!.traits ?? [], id).toContain(trait);
    }
  });
});

// ---------------------------------------------------------------- 獣兵（03§5 ペルシア固有）

describe('獣兵（beast）— ペルシアのみ（03§5）', () => {
  const beasts = entries.filter(([, u]) => u.role === 'beast');

  it('獣兵はペルシアの 3 件（戦象・装甲戦象・親衛象）だけ', () => {
    expect(beasts.map(([id]) => id).sort()).toEqual(
      ['p-elephant', 'p-elephant-armored', 'p-guard-elephant'].sort(),
    );
    for (const [, u] of beasts) expect(u.civ).toBe('persia');
  });

  it('戦象の pop は 2', () => {
    for (const [id, u] of beasts) expect(u.pop, id).toBe(2);
  });

  it('line=beast はツリーの 2 段のみ（親衛象は elite 系統）', () => {
    const line = entries.filter(([, u]) => u.line === 'beast').map(([id]) => id).sort();
    expect(line).toEqual(['p-elephant', 'p-elephant-armored']);
    expect(units['p-elephant']!.upgradeTo).toBe('p-elephant-armored');
  });
});

// ---------------------------------------------------------------- 文明ごとの「穴」（03§5）

describe('文明ごとの「穴」— 03§5 の「―」がエントリなしになっている', () => {
  const footRanged = ([, u]: [string, Unit]) => u.line === 'ranged';
  const cavalryLike = ([, u]: [string, Unit]) => u.role === 'cavalry' || u.role === 'camel';

  it('ヤマト: 騎兵・攻城は鉄器から（青銅の騎兵/攻城がない）', () => {
    const y = byCiv('yamato');
    expect(y.filter(([, u]) => u.line === 'cavalry' && u.age === 'seido')).toEqual([]);
    expect(y.filter(([, u]) => u.line === 'siege' && u.age === 'seido')).toEqual([]);
    expect(y.filter(([, u]) => u.line === 'cavalry').map(([id]) => id).sort())
      .toEqual(['y-horo', 'y-kiba']);
  });

  it('ローマ: 近接・遠隔・騎兵が 3 段揃う唯一の文明。騎兵は青銅から', () => {
    const r = byCiv('roma');
    for (const line of ['melee', 'ranged', 'cavalry']) {
      const tiers = r.filter(([, u]) => u.line === line).map(([, u]) => u.tier).sort();
      expect(tiers, line).toEqual([1, 2, 3]);
    }
    // ローマ以外に 3 系統 3 段揃う文明はない
    for (const civ of CIV_IDS.filter((c) => c !== 'roma')) {
      const ok = ['melee', 'ranged', 'cavalry'].every(
        (line) => byCiv(civ).filter(([, u]) => u.line === line).length === 3,
      );
      expect(ok, civ).toBe(false);
    }
  });

  it('唐: 騎兵は鉄器からの 2 段のみ', () => {
    const cav = byCiv('tou').filter(([, u]) => u.line === 'cavalry');
    expect(cav.map(([id]) => id).sort()).toEqual(['t-keiki', 't-tekki']);
    expect(cav.every(([, u]) => u.age !== 'seido')).toBe(true);
  });

  it('ヴァイキング: 騎兵を一切持たない / 帝国の遠隔（火器）もない / 固有船 2 種', () => {
    const v = byCiv('viking');
    expect(v.filter(cavalryLike)).toEqual([]);
    expect(v.filter(([, u]) => u.line === 'cavalry')).toEqual([]);
    expect(v.filter(([, u]) => u.role === 'gunpowder')).toEqual([]);
    expect(v.filter(([, u]) => u.attackClass === 'gunpowder')).toEqual([]);
    expect(v.filter(footRanged).map(([, u]) => u.tier).sort()).toEqual([1, 2]);
    expect(v.filter(([, u]) => u.line === 'ship').map(([id]) => id).sort())
      .toEqual(['v-greatship', 'v-longship']);
  });

  it('マリ: 攻城の最上位なし（投石機が最終・破城槌は継続生産）', () => {
    const siege = byCiv('mali').filter(([, u]) => u.line === 'siege');
    expect(siege.map(([id]) => id).sort()).toEqual(['m-catapult', 'm-ram']);
    // オナゲル/大投石機のような最上位を持たない
    expect(siege.some(([, u]) => u.traits?.includes('assemble_required'))).toBe(false);
    // 「継続して作れる」ので破城槌に upgradeTo はない
    expect(units['m-ram']!.upgradeTo).toBeUndefined();
    // 駱駝は騎兵ではなく camel role
    const mounted = byCiv('mali').filter(([, u]) => u.line === 'cavalry');
    expect(mounted.map(([id]) => id).sort()).toEqual(['m-camel', 'm-camel-heavy']);
    for (const [id, u] of mounted) expect(u.role, id).toBe('camel');
  });

  it('アステカ: 騎兵なし・火器なし・遠隔は 2 段まで', () => {
    const a = byCiv('azteca');
    expect(a.filter(cavalryLike)).toEqual([]);
    expect(a.filter(([, u]) => u.line === 'cavalry')).toEqual([]);
    expect(a.filter(([, u]) => u.role === 'gunpowder')).toEqual([]);
    expect(a.filter(([, u]) => u.attackClass === 'gunpowder')).toEqual([]);
    expect(a.filter(footRanged).map(([, u]) => u.tier).sort()).toEqual([1, 2]);
    expect(a.filter(footRanged).some(([, u]) => u.age === 'teikoku')).toBe(false);
  });

  it('ペルシア: 獣兵系統を持つ唯一の文明。全系統が揃う', () => {
    const p = byCiv('persia');
    expect(p.filter(([, u]) => u.line === 'beast').length).toBe(2);
    for (const line of ['melee', 'ranged', 'cavalry', 'siege']) {
      expect(p.filter(([, u]) => u.line === line).length, line).toBeGreaterThan(0);
    }
  });

  it('モンゴル: 徒歩の遠隔なし / 近接は下馬兵 1 段（鉄器）のみ / 攻城は帝国の 1 件のみ / 騎兵は青銅から', () => {
    const g = byCiv('mongol');
    // 徒歩の遠隔（line=ranged）が存在しない
    expect(g.filter(footRanged)).toEqual([]);
    expect(g.filter(([, u]) => u.role === 'gunpowder')).toEqual([]);
    // 近接は 1 段のみ・鉄器・upgradeTo なし
    const melee = g.filter(([, u]) => u.line === 'melee');
    expect(melee.map(([id]) => id)).toEqual(['g-dismount']);
    expect(units['g-dismount']!.age).toBe('tekki');
    expect(units['g-dismount']!.upgradeTo).toBeUndefined();
    // 攻城は簡易投石機のみ・帝国
    const siege = g.filter(([, u]) => u.line === 'siege');
    expect(siege.map(([id]) => id)).toEqual(['g-catapult']);
    expect(units['g-catapult']!.age).toBe('teikoku');
    // 騎兵は青銅から 3 段
    const cav = g.filter(([, u]) => u.line === 'cavalry');
    expect(cav.map(([id]) => id).sort()).toEqual(['g-archer', 'g-heavy', 'g-light']);
    expect(units['g-light']!.age).toBe('seido');
  });

  it('騎兵が青銅から出るのはローマとモンゴルだけ（03§5）', () => {
    const early = entries
      .filter(([, u]) => u.line === 'cavalry' && u.age === 'seido')
      .map(([, u]) => u.civ);
    expect([...new Set(early)].sort()).toEqual(['mongol', 'roma']);
  });

  it('火器（帝国の遠隔 3 段）を持つのは 5 文明（ヴァイキング・アステカ・モンゴルは持たない）', () => {
    const gun = entries.filter(([, u]) => u.role === 'gunpowder').map(([, u]) => u.civ).sort();
    expect(gun).toEqual(['mali', 'persia', 'roma', 'tou', 'yamato']);
  });
});

// ---------------------------------------------------------------- 「尖り」（03§5 の穴と尖り表）

describe('文明の「尖り」が数値に出ている（03§5）', () => {
  const meleeAtk = (civ: string, tier: number) =>
    byCiv(civ).find(([, u]) => u.line === 'melee' && u.tier === tier)![1].atk;

  it('ヴァイキング: 近接の攻撃が全文明最高', () => {
    for (const tier of [1, 2, 3]) {
      const others = CIV_IDS.filter((c) => c !== 'viking')
        .map((c) => byCiv(c).find(([, u]) => u.line === 'melee' && u.tier === tier)?.[1].atk)
        .filter((x): x is number => x !== undefined);
      for (const o of others) expect(meleeAtk('viking', tier)).toBeGreaterThanOrEqual(o);
    }
  });

  it('唐: 近接が最弱で、遠隔と攻城が強い', () => {
    for (const tier of [1, 2, 3]) {
      const others = CIV_IDS.filter((c) => c !== 'tou')
        .map((c) => byCiv(c).find(([, u]) => u.line === 'melee' && u.tier === tier)?.[1].atk)
        .filter((x): x is number => x !== undefined);
      for (const o of others) expect(meleeAtk('tou', tier)).toBeLessThanOrEqual(o);
    }
    expect(units['t-yumite']!.atk).toBeGreaterThan(units['p-bow']!.atk);
    expect(units['t-shoshido']!.atk).toBeGreaterThan(units['r-ballista']!.atk);
  });

  it('アステカ: 歩兵の生産が最速', () => {
    const az = byCiv('azteca').filter(([, u]) => u.line === 'melee').map(([, u]) => u.buildSec);
    const worst = Math.max(...az);
    for (const civ of CIV_IDS.filter((c) => c !== 'azteca')) {
      for (const [id, u] of byCiv(civ).filter(([, x]) => x.line === 'melee' && x.tier === 1)) {
        expect(u.buildSec, id).toBeGreaterThan(Math.min(...az));
      }
    }
    expect(worst).toBeLessThan(24);
  });

  it('ペルシア: 全兵が遅い / モンゴル: 全兵が速い', () => {
    const spd = (civ: string, id: string) => byCiv(civ).find(([i]) => i === id)![1]
      .speedTilesPerSec;
    expect(spd('persia', 'p-immortal')).toBeLessThan(spd('roma', 'r-hastati'));
    expect(spd('persia', 'p-cataphract')).toBeLessThan(spd('roma', 'r-eq-heavy'));
    expect(spd('mongol', 'g-light')).toBeGreaterThan(spd('roma', 'r-eq-light'));
    expect(spd('mongol', 'g-dismount')).toBeGreaterThan(spd('roma', 'r-principes'));
  });

  it('マリ: 遠隔の射程が最長', () => {
    for (const tier of [1, 2]) {
      const mali = byCiv('mali').find(([, u]) => u.line === 'ranged' && u.tier === tier)![1];
      for (const civ of CIV_IDS.filter((c) => c !== 'mali')) {
        const other = byCiv(civ).find(([, u]) => u.line === 'ranged' && u.tier === tier)?.[1];
        if (!other) continue;
        expect(mali.rangeTiles, civ).toBeGreaterThanOrEqual(other.rangeTiles);
      }
    }
  });

  it('ヤマト: 近接の防御が最高', () => {
    for (const tier of [1, 2, 3]) {
      const y = byCiv('yamato').find(([, u]) => u.line === 'melee' && u.tier === tier)![1];
      for (const civ of CIV_IDS.filter((c) => c !== 'yamato')) {
        const other = byCiv(civ).find(([, u]) => u.line === 'melee' && u.tier === tier)?.[1];
        if (!other) continue;
        expect(y.def, civ).toBeGreaterThanOrEqual(other.def);
      }
    }
  });
});

// ---------------------------------------------------------------- 生産元と役割の整合

describe('生産元と役割の整合', () => {
  it('line ごとの producedAt が一貫している（共通・支援は町の中心などなので除く）', () => {
    const expected: Record<string, string[]> = {
      melee: ['barracks'],
      ranged: ['archery_range', 'gunpowder_workshop'],
      cavalry: ['stable'],
      beast: ['stable'],
      siege: ['siege_workshop', 'barracks'],
      ship: ['dock', 'harbor'],
      elite: ['castle', 'great_tent'],
    };
    for (const [id, u] of entries) {
      if (u.line === null || u.tier === 0) continue;
      expect(expected[u.line], `${id} (${u.line})`).toContain(u.producedAt);
    }
  });

  it('火器は gunpowder_workshop で生産し帝国の世', () => {
    for (const [id, u] of entries.filter(([, x]) => x.role === 'gunpowder')) {
      expect(u.producedAt, id).toBe('gunpowder_workshop');
      expect(u.age, id).toBe('teikoku');
      expect(u.attackClass, id).toBe('gunpowder');
    }
  });

  it('遠隔・騎射・攻城の射撃兵は rangeTiles > 0、近接は 0', () => {
    for (const [id, u] of entries) {
      if (u.attackClass === 'arrow' || u.attackClass === 'gunpowder') {
        expect(u.rangeTiles, id).toBeGreaterThan(0);
      }
      if (u.attackClass === 'melee' && u.role !== 'support' && u.role !== 'villager') {
        expect(u.rangeTiles, id).toBe(0);
      }
    }
  });

  it('aoe を持つのは attackClass=aoe か明示された兵器のみ', () => {
    for (const [id, u] of entries) {
      if (u.attackClass === 'aoe') expect(u.aoeRadiusTiles, id).toBeGreaterThan(0);
    }
  });

  it('祈祷師は戦闘力ゼロで治療 trait を持つ（03§4 / 03§7）', () => {
    expect(units['priest']!.atk).toBe(0);
    expect(units['priest']!.traits).toContain('heal');
    expect(units['herald']!.atk).toBe(0);
  });
});
