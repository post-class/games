import { describe, it, expect } from 'vitest';
import buildingsJson from '../../src/data/buildings.json';
import techsJson from '../../src/data/techs.json';

/**
 * T-M1-04 `buildings.json` の検証。
 * 上流資料: docs/03_文明と進化.html §3 / docs/07_ゲームシステム.html §9
 * ID 規約: src/data/README.md
 */

type Cost = Partial<Record<'food' | 'wood' | 'stone' | 'gold', number>>;

interface Building {
  name: string;
  age: string;
  kind: string;
  civ?: string;
  replaces?: string;
  cost?: Cost;
  buildSec?: number;
  hp?: number;
  sizeTiles?: [number, number];
  sightTiles?: number;
  popProvide?: number;
  isDropOff?: boolean;
  isOrderSource?: boolean;
  produces?: string[];
  producesLines?: string[];
  researches?: string[];
  canAdvanceAge?: boolean;
  lossCausesDefeat?: boolean;
  attachments?: string[];
  frontSlotBonus?: number;
  garrisonCapacity?: number;
  buildable?: boolean;
  autoTargetable?: boolean;
  revealToAll?: boolean;
  movable?: boolean;
  isWall?: boolean;
  isGate?: boolean;
  isLinear?: boolean;
  note?: string;
}

const raw = buildingsJson as unknown as Record<string, unknown>;
const buildings: Record<string, Building> = Object.fromEntries(
  Object.entries(raw).filter(([id]) => id !== '_meta'),
) as Record<string, Building>;

// README.md の building ID をそのまま転記（綴りを変えないこと）
const COMMON_IDS = [
  // 黎明
  'town_center',
  'house',
  'farm',
  'lumber_camp',
  'mining_camp',
  'watch_hut',
  'dock',
  // 青銅
  'barracks',
  'archery_range',
  'market',
  'blacksmith',
  'palisade',
  'palisade_gate',
  'watch_tower',
  // 鉄器
  'stable',
  'academy',
  'shrine',
  'siege_workshop',
  'stone_wall',
  'stone_gate',
  'castle',
  'harbor',
  // 帝国
  'gunpowder_workshop',
  'cannon_tower',
  'monument',
] as const;

const ATTACHMENT_IDS = ['well', 'seed_store'] as const;

const CIV_IDS = [
  'yagura',
  'road',
  'kanrin',
  'boathouse',
  'salt_store',
  'temple_platform',
  'qanat',
  'great_tent',
] as const;

// README.md の unit ID 全 94 件
const UNIT_IDS = [
  'villager',
  'clubman',
  'hunter',
  'scout',
  'herald',
  'trade_cart',
  'priest',
  'fishing_boat',
  'transport_ship',
  'warship',
  'fire_ship',
  'y-ashigaru',
  'y-musha',
  'y-nagae',
  'y-yumiashigaru',
  'y-daikyu',
  'y-teppo',
  'y-horo',
  'y-kiba',
  'y-seiro',
  'y-ozutsu',
  'r-hastati',
  'r-principes',
  'r-triarii',
  'r-slinger',
  'r-scorpio',
  'r-handgun',
  'r-eq-light',
  'r-eq',
  'r-eq-heavy',
  'r-ram',
  'r-ballista',
  'r-onager',
  't-hosotsu',
  't-hakuto',
  't-nagayari',
  't-yumite',
  't-dote',
  't-kaju',
  't-keiki',
  't-tekki',
  't-shoshido',
  't-kasensha',
  'v-raider',
  'v-shield',
  'v-axe',
  'v-javelin',
  'v-bow',
  'v-fire',
  'v-ram',
  'v-longship',
  'v-greatship',
  'm-yarite',
  'm-menko',
  'm-naga',
  'm-yumi',
  'm-daikyu',
  'm-hinawa',
  'm-camel',
  'm-camel-heavy',
  'm-ram',
  'm-catapult',
  'a-club',
  'a-obsidian',
  'a-feather',
  'a-blowgun',
  'a-atlatl',
  'a-catapult',
  'a-bigcatapult',
  'p-immortal',
  'p-shield',
  'p-naga',
  'p-bow',
  'p-daikyu',
  'p-gun',
  'p-cav',
  'p-cataphract',
  'p-elephant',
  'p-elephant-armored',
  'p-tower',
  'p-cannon',
  'g-dismount',
  'g-light',
  'g-archer',
  'g-heavy',
  'g-catapult',
  'y-bushi',
  'r-legion',
  't-renkyu',
  'v-berserk',
  'm-guard-archer',
  'a-jaguar',
  'p-guard-elephant',
  'g-guard-horsearcher',
] as const;

// README.md の tech ID 全 34 件
const TECH_IDS = [
  'uchiba',
  'kouba',
  'yajiri',
  'kouyajiri',
  'kawayoroi',
  'kusariyoroi',
  'bankinyoroi',
  'bayoroi',
  'hatazao',
  'hayaba',
  'fukusho',
  'nijuuhata',
  'sokuryo',
  'shahon',
  'chouheirei',
  'ryotebono',
  'oonoko',
  'tsuruhashi',
  'koudou',
  'suki',
  'rinsaku',
  'nida',
  'taisho',
  'yakusou',
  'zousen',
  'chuuzou',
  'tanren',
  'guntan',
  'kayakujutsu',
  'kyousen',
  'shahou',
  'menkou',
  'kangyo',
  'ekiden',
] as const;

const AGES = ['reimei', 'seido', 'tekki', 'teikoku'];
const CIV_LIST = ['yamato', 'roma', 'tou', 'viking', 'mali', 'azteca', 'persia', 'mongol'];
const KINDS = ['normal', 'attachment', 'wall', 'gate', 'monument'];
const LINES = ['melee', 'ranged', 'cavalry', 'beast', 'siege', 'ship', 'elite'];

const entries = Object.entries(buildings);

describe('buildings.json — 件数', () => {
  it('_meta を除いて 35 件', () => {
    expect(entries.length).toBe(35);
  });

  it('付属物（kind=attachment）が 2 件', () => {
    const attachments = entries.filter(([, b]) => b.kind === 'attachment');
    expect(attachments.map(([id]) => id).sort()).toEqual([...ATTACHMENT_IDS].sort());
    expect(attachments.length).toBe(2);
  });

  it('文明固有（civ を持つ）が 8 件で、civ は 8 文明のいずれか', () => {
    const civOnly = entries.filter(([, b]) => b.civ !== undefined);
    expect(civOnly.length).toBe(8);
    expect(civOnly.map(([id]) => id).sort()).toEqual([...CIV_IDS].sort());
    for (const [id, b] of civOnly) {
      expect(CIV_LIST, `${id} の civ`).toContain(b.civ);
    }
    // 固有建物は 8 文明で重複しない（1 文明 1 件）
    expect(new Set(civOnly.map(([, b]) => b.civ)).size).toBe(8);
  });

  it('共通（civ なし・kind!=attachment）が 25 件', () => {
    const common = entries.filter(([, b]) => b.civ === undefined && b.kind !== 'attachment');
    expect(common.length).toBe(25);
    expect(common.map(([id]) => id).sort()).toEqual([...COMMON_IDS].sort());
  });

  it('25 + 2 + 8 = 35 で内訳が排他', () => {
    expect(COMMON_IDS.length).toBe(25);
    expect(ATTACHMENT_IDS.length).toBe(2);
    expect(CIV_IDS.length).toBe(8);
    expect(new Set([...COMMON_IDS, ...ATTACHMENT_IDS, ...CIV_IDS]).size).toBe(35);
  });
});

describe('buildings.json — ID の網羅と過不足', () => {
  const expected = [...COMMON_IDS, ...ATTACHMENT_IDS, ...CIV_IDS];

  it('README の 35 ID がすべて存在する', () => {
    for (const id of expected) {
      expect(buildings[id], `${id} が存在しない`).toBeDefined();
    }
  });

  it('余分な ID がない', () => {
    const expectedSet: readonly string[] = expected;
    const extra = Object.keys(buildings).filter((id) => !expectedSet.includes(id));
    expect(extra).toEqual([]);
  });

  it('_meta が存在し、数値決定規則が書かれている', () => {
    const meta = raw['_meta'] as Record<string, unknown> | undefined;
    expect(meta).toBeDefined();
    const rules = meta?.['numberRules'] as Record<string, unknown> | undefined;
    expect(rules).toBeDefined();
    for (const key of ['buildSec', 'hp', 'sizeTiles', 'sightTiles', 'attack']) {
      expect(rules?.[key], `_meta.numberRules.${key}`).toBeTruthy();
    }
  });
});

describe('buildings.json — 共通 25 種のコスト（03§3 の表と完全一致）', () => {
  const EXPECTED_COST: Record<string, Cost> = {
    town_center: { wood: 350, stone: 150 },
    house: { wood: 30 },
    farm: { wood: 60 },
    lumber_camp: { wood: 100 },
    mining_camp: { wood: 100 },
    watch_hut: { wood: 25 },
    dock: { wood: 100 },
    barracks: { wood: 175 },
    archery_range: { wood: 175 },
    market: { wood: 175 },
    blacksmith: { wood: 150 },
    palisade: { wood: 2 },
    palisade_gate: { wood: 30 },
    watch_tower: { wood: 25, stone: 125 },
    stable: { wood: 175 },
    academy: { wood: 200 },
    shrine: { wood: 175 },
    siege_workshop: { wood: 200 },
    stone_wall: { stone: 25 },
    stone_gate: { stone: 200 },
    castle: { stone: 650 },
    harbor: { wood: 150 },
    gunpowder_workshop: { wood: 200, gold: 200 },
    cannon_tower: { stone: 200, gold: 100 },
    monument: { wood: 1000, stone: 1000, gold: 1000 },
  };

  it('期待値の件数が 25', () => {
    expect(Object.keys(EXPECTED_COST).length).toBe(25);
  });

  for (const [id, cost] of Object.entries(EXPECTED_COST)) {
    it(`${id} のコスト`, () => {
      expect(buildings[id]?.cost).toEqual(cost);
    });
  }
});

describe('buildings.json — 令の発信点と戦域スロット（07§9）', () => {
  it('城は frontSlotBonus:1 かつ isOrderSource:true', () => {
    expect(buildings['castle']?.frontSlotBonus).toBe(1);
    expect(buildings['castle']?.isOrderSource).toBe(true);
  });

  it('大天幕は frontSlotBonus:1 かつ isOrderSource:true かつ movable:true', () => {
    expect(buildings['great_tent']?.frontSlotBonus).toBe(1);
    expect(buildings['great_tent']?.isOrderSource).toBe(true);
    expect(buildings['great_tent']?.movable).toBe(true);
  });

  it('大天幕の耐久は城の 60%', () => {
    const castleHp = buildings['castle']?.hp ?? 0;
    expect(buildings['great_tent']?.hp).toBe(Math.round(castleHp * 0.6));
  });

  it('町の中心は isOrderSource:true / canAdvanceAge:true / lossCausesDefeat:true', () => {
    expect(buildings['town_center']?.isOrderSource).toBe(true);
    expect(buildings['town_center']?.canAdvanceAge).toBe(true);
    expect(buildings['town_center']?.lossCausesDefeat).toBe(true);
  });

  it('令の発信点は町の中心・城・大天幕だけ', () => {
    const sources = entries.filter(([, b]) => b.isOrderSource === true).map(([id]) => id);
    expect(sources.sort()).toEqual(['castle', 'great_tent', 'town_center']);
  });
});

describe('buildings.json — 付属物（03§3・07§10）', () => {
  for (const id of ATTACHMENT_IDS) {
    it(`${id} は buildable:false かつ autoTargetable:false`, () => {
      expect(buildings[id]?.buildable).toBe(false);
      expect(buildings[id]?.autoTargetable).toBe(false);
    });

    it(`${id} は kind:attachment で掟違反 ID と破壊時効果を持つ`, () => {
      const b = buildings[id] as unknown as Record<string, unknown>;
      expect(b['kind']).toBe('attachment');
      expect(b['lawViolationOnDestroy']).toBeTruthy();
      expect(Array.isArray(b['onDestroyEffects'])).toBe(true);
      expect((b['onDestroyEffects'] as unknown[]).length).toBeGreaterThan(0);
      // 付属物にコストは無い（プレイヤーが建てない）
      expect(b['cost']).toBeUndefined();
    });

    it(`${id} の attachedTo が既存の建物 ID を指す`, () => {
      const parents = (buildings[id] as unknown as Record<string, unknown>)[
        'attachedTo'
      ] as string[];
      expect(parents.length).toBeGreaterThan(0);
      for (const p of parents) {
        expect(buildings[p], `${id}.attachedTo -> ${p}`).toBeDefined();
      }
    });
  }

  it('井戸の掟は law2 / 種籾蔵の掟は law3', () => {
    const well = buildings['well'] as unknown as Record<string, unknown>;
    const seed = buildings['seed_store'] as unknown as Record<string, unknown>;
    expect(well['lawViolationOnDestroy']).toBe('law2');
    expect(seed['lawViolationOnDestroy']).toBe('law3');
  });

  it('井戸破壊で採集速度 −20%（mul 0.8）', () => {
    const eff = (buildings['well'] as unknown as Record<string, unknown>)[
      'onDestroyEffects'
    ] as Array<Record<string, unknown>>;
    const aura = eff.find((e) => e['type'] === 'gatherRateAura');
    expect(aura?.['mul']).toBe(0.8);
    expect(eff.some((e) => e['type'] === 'forbidRebuildHere')).toBe(true);
  });

  it('種籾蔵破壊で農地の再建が禁止される', () => {
    const eff = (buildings['seed_store'] as unknown as Record<string, unknown>)[
      'onDestroyEffects'
    ] as Array<Record<string, unknown>>;
    const forbid = eff.find((e) => e['type'] === 'forbidRebuildNearby');
    expect(forbid?.['building']).toBe('farm');
  });

  it('attachments に書かれた付属物 ID が存在する（町の中心・家=井戸 / 農地=種籾蔵）', () => {
    for (const [id, b] of entries) {
      for (const a of b.attachments ?? []) {
        expect(buildings[a], `${id}.attachments -> ${a}`).toBeDefined();
        expect(buildings[a]?.kind, `${a} は attachment であるべき`).toBe('attachment');
      }
    }
    expect(buildings['town_center']?.attachments).toEqual(['well']);
    expect(buildings['house']?.attachments).toEqual(['well']);
    expect(buildings['farm']?.attachments).toEqual(['seed_store']);
  });
});

describe('buildings.json — 参照の整合', () => {
  it('produces の unit ID がすべて README の 94 件に含まれる', () => {
    for (const [id, b] of entries) {
      for (const u of b.produces ?? []) {
        expect(UNIT_IDS as readonly string[], `${id}.produces -> ${u}`).toContain(u);
      }
    }
  });

  it('unlockUnits の unit ID も 94 件に含まれる', () => {
    for (const [id, b] of entries) {
      const effects = (b as unknown as Record<string, unknown>)['effects'] as
        | Array<Record<string, unknown>>
        | undefined;
      for (const e of effects ?? []) {
        if (e['type'] === 'unlockUnits') {
          for (const u of e['units'] as string[]) {
            expect(UNIT_IDS as readonly string[], `${id}.effects.unlockUnits -> ${u}`).toContain(u);
          }
        }
      }
    }
  });

  it('producesLines の line ID が正しい', () => {
    for (const [id, b] of entries) {
      for (const l of b.producesLines ?? []) {
        expect(LINES, `${id}.producesLines -> ${l}`).toContain(l);
      }
    }
  });

  it('researches の tech ID がすべて README の 34 件に含まれる', () => {
    for (const [id, b] of entries) {
      for (const t of b.researches ?? []) {
        expect(TECH_IDS as readonly string[], `${id}.researches -> ${t}`).toContain(t);
      }
    }
  });

  it('鍛冶場 8 件 / 学舎 7 件の研究が載っている', () => {
    expect(buildings['blacksmith']?.researches?.length).toBe(8);
    expect(buildings['academy']?.researches?.length).toBe(7);
  });

  it('replaces の参照先が存在し、共通建物である', () => {
    const replacers = entries.filter(([, b]) => b.replaces !== undefined);
    expect(replacers.length).toBe(4); // 櫓・翰林院・船小屋・大天幕
    for (const [id, b] of replacers) {
      const target = b.replaces as string;
      expect(buildings[target], `${id}.replaces -> ${target}`).toBeDefined();
      expect(COMMON_IDS as readonly string[], `${target} は共通建物`).toContain(target);
    }
    expect(buildings['yagura']?.replaces).toBe('watch_tower');
    expect(buildings['kanrin']?.replaces).toBe('academy');
    expect(buildings['boathouse']?.replaces).toBe('harbor');
    expect(buildings['great_tent']?.replaces).toBe('castle');
  });
});

describe('buildings.json — 碑の写し（06.9 / 03§3）', () => {
  it('kind:monument で revealToAll:true', () => {
    const monuments = entries.filter(([, b]) => b.kind === 'monument');
    expect(monuments.length).toBe(1);
    for (const [id, b] of monuments) {
      expect((b as unknown as Record<string, unknown>)['revealToAll'], `${id}`).toBe(true);
    }
  });

  it('6 分（360 秒）守り切る', () => {
    expect((buildings['monument'] as unknown as Record<string, unknown>)['victoryHoldSec']).toBe(
      360,
    );
  });
});

describe('buildings.json — 共通フィールドの健全性', () => {
  it('全件 name / age / kind が正しい', () => {
    for (const [id, b] of entries) {
      expect(b.name, `${id}.name`).toBeTruthy();
      expect(AGES, `${id}.age`).toContain(b.age);
      expect(KINDS, `${id}.kind`).toContain(b.kind);
    }
  });

  it('全件 hp / sizeTiles / sightTiles / buildSec が妥当（付属物は buildSec 不要）', () => {
    for (const [id, b] of entries) {
      expect(b.hp, `${id}.hp`).toBeGreaterThan(0);
      expect(b.sizeTiles?.length, `${id}.sizeTiles`).toBe(2);
      expect(b.sizeTiles?.[0]).toBeGreaterThan(0);
      expect(b.sizeTiles?.[1]).toBeGreaterThan(0);
      expect(b.sightTiles, `${id}.sightTiles`).toBeGreaterThanOrEqual(0);
      if (b.kind !== 'attachment') {
        expect(b.buildSec, `${id}.buildSec`).toBeGreaterThanOrEqual(3);
        expect(b.buildSec, `${id}.buildSec`).toBeLessThanOrEqual(180);
      }
    }
  });

  it('プレイヤーが建てる 33 件はコストを持つ', () => {
    for (const [id, b] of entries) {
      if (b.buildable === false) continue;
      const total = Object.values(b.cost ?? {}).reduce((a, c) => a + c, 0);
      expect(total, `${id}.cost`).toBeGreaterThan(0);
    }
    expect(entries.filter(([, b]) => b.buildable !== false).length).toBe(33);
  });

  it('buildSec は 総コスト÷5.5 を 5 秒単位で丸めた値（最小 3・最大 180、壁は最小 3）', () => {
    for (const [id, b] of entries) {
      if (b.buildable === false) continue;
      const total = Object.values(b.cost ?? {}).reduce((a, c) => a + c, 0);
      const raw5 = total / 5.5;
      const expected = Math.min(180, Math.max(3, Math.round(raw5 / 5) * 5 || 3));
      expect(b.buildSec, `${id}.buildSec (総コスト ${total})`).toBe(expected);
    }
  });

  it('人口を供給するのは町の中心 +10 と家 +5 だけ（07§8）', () => {
    const providers = entries.filter(([, b]) => (b.popProvide ?? 0) > 0);
    expect(providers.map(([id]) => id).sort()).toEqual(['house', 'town_center']);
    expect(buildings['town_center']?.popProvide).toBe(10);
    expect(buildings['house']?.popProvide).toBe(5);
  });

  it('壁・門・線状建物のフラグが整合する', () => {
    expect(buildings['palisade']?.isWall).toBe(true);
    expect(buildings['stone_wall']?.isWall).toBe(true);
    expect(buildings['palisade_gate']?.isGate).toBe(true);
    expect(buildings['stone_gate']?.isGate).toBe(true);
    expect(buildings['palisade']?.isLinear).toBe(true);
    expect(buildings['stone_wall']?.isLinear).toBe(true);
    expect(buildings['road']?.isLinear).toBe(true);
    for (const [id, b] of entries) {
      if (b.kind === 'wall' || b.kind === 'gate') expect(b.isWall, `${id}.isWall`).toBe(true);
      if (b.isGate === true) expect(b.kind, `${id}.kind`).toBe('gate');
    }
  });

  it('塔・砲塔・城は攻撃値 3 点セットを持つ', () => {
    for (const id of ['watch_tower', 'cannon_tower', 'castle', 'yagura', 'great_tent']) {
      const b = buildings[id] as unknown as Record<string, unknown>;
      expect(b['attackDamage'], `${id}.attackDamage`).toBeGreaterThan(0);
      expect(b['attackRangeTiles'], `${id}.attackRangeTiles`).toBeGreaterThan(0);
      expect(b['attackSec'], `${id}.attackSec`).toBeGreaterThan(0);
      expect(b['garrisonCapacity'], `${id}.garrisonCapacity`).toBeGreaterThan(0);
    }
    // 櫓は見張り塔より射程が長く、兵も 5 名まで収容できる（03§3）
    const tower = buildings['watch_tower'] as unknown as Record<string, unknown>;
    const yagura = buildings['yagura'] as unknown as Record<string, unknown>;
    expect(yagura['attackRangeTiles'] as number).toBeGreaterThan(
      tower['attackRangeTiles'] as number,
    );
    expect(yagura['garrisonCapacity']).toBe(5);
    expect(yagura['garrisonAllows']).toEqual(['villager', 'military']);
  });

  it('資源搬入点は町の中心・伐採所・採掘場・桟橋・港・船小屋', () => {
    const dropOffs = entries.filter(([, b]) => b.isDropOff === true).map(([id]) => id);
    expect(dropOffs.sort()).toEqual(
      ['boathouse', 'dock', 'harbor', 'lumber_camp', 'mining_camp', 'town_center'].sort(),
    );
  });

  it('敗北条件になるのは町の中心のみ（06.9）', () => {
    const fatal = entries.filter(([, b]) => b.lossCausesDefeat === true).map(([id]) => id);
    expect(fatal).toEqual(['town_center']);
  });
});

describe('buildings.json — 文明固有 8 種の効果（03§3）', () => {
  const effectsOf = (id: string): Array<Record<string, unknown>> =>
    ((buildings[id] as unknown as Record<string, unknown>)['effects'] as Array<
      Record<string, unknown>
    >) ?? [];

  it('街道: 移動速度 +30%', () => {
    const e = effectsOf('road').find((x) => x['type'] === 'moveSpeedOnTile');
    expect(e?.['mul']).toBe(1.3);
  });

  it('翰林院: 研究が 20% 速く 20% 安い', () => {
    const e = effectsOf('kanrin');
    expect(e.find((x) => x['type'] === 'researchTimeMul')?.['mul']).toBe(0.8);
    expect(e.find((x) => x['type'] === 'researchCostMul')?.['mul']).toBe(0.8);
    // 学舎の研究をそのまま引き継ぐ
    expect(buildings['kanrin']?.researches).toEqual(buildings['academy']?.researches);
  });

  it('船小屋: 船が安く長船を作れる', () => {
    const e = effectsOf('boathouse');
    const cost = e.find((x) => x['type'] === 'unitCostMul');
    expect(cost?.['line']).toBe('ship');
    expect(cost?.['mul'] as number).toBeLessThan(1);
    expect(e.find((x) => x['type'] === 'unlockUnits')?.['units']).toEqual([
      'v-longship',
      'v-greatship',
    ]);
  });

  it('塩蔵: 交易収入 +25%・市場を 3 つまで', () => {
    const e = effectsOf('salt_store');
    expect(e.find((x) => x['type'] === 'tradeIncomeMul')?.['mul']).toBe(1.25);
    const limit = e.find((x) => x['type'] === 'buildingLimitOverride');
    expect(limit?.['building']).toBe('market');
    expect(limit?.['max']).toBe(3);
  });

  it('神殿基壇: 石材で建て、周囲の兵の生産速度 +20%', () => {
    expect(buildings['temple_platform']?.cost).toEqual({ stone: 200 });
    const e = effectsOf('temple_platform').find((x) => x['type'] === 'trainRateAura');
    expect(e?.['mul']).toBe(1.2);
    expect(e?.['scope']).toBe('military');
  });

  it('地下水路: 周囲の村人の採集速度 +15%', () => {
    const e = effectsOf('qanat').find((x) => x['type'] === 'gatherRateAura');
    expect(e?.['mul']).toBe(1.15);
  });

  it('効果の type は effectTypes 登録簿にある（コードに建物名の分岐を書かせない）', () => {
    // 登録簿は techs.json:_meta.effectTypes に一本化してある（二重管理を避けるため）。
    // buildings.json / civs.json / techs.json の effects はすべてそこに登録する。
    // 未登録の type は適用エンジン（T-M6-04）が黙って無視するので、
    // src/data/load.ts の横断検証でも起動時に例外にしている。
    const declared = Object.keys(
      (techsJson as unknown as Record<string, Record<string, Record<string, unknown>>>)['_meta']?.[
        'effectTypes'
      ] ?? {},
    );
    expect(declared.length).toBeGreaterThan(10); // 登録簿が空だと検査が空振りする
    for (const [id, b] of entries) {
      const rec = b as unknown as Record<string, unknown>;
      const all = [
        ...(((rec['effects'] as Array<Record<string, unknown>>) ?? [])),
        ...(((rec['onDestroyEffects'] as Array<Record<string, unknown>>) ?? [])),
      ];
      for (const e of all) {
        expect(declared, `${id} の effect type`).toContain(e['type']);
      }
    }
  });
});
