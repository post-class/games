import { describe, it, expect } from "vitest";
import techsJson from "../../src/data/techs.json";

/**
 * T-M1-06 `techs.json` の検証。
 * 上流資料: docs/03_文明と進化.html §9（鍛冶場8 / 学舎7 / その他11 / 文明固有8）
 */

type Cost = Record<string, number>;
type Effect = { type: string } & Record<string, unknown>;
interface Tech {
  name: string;
  at: string;
  age: string;
  cost: Cost;
  researchSec: number;
  requires: string[];
  effects: Effect[];
  civ?: string;
  note?: string;
}

const raw = techsJson as unknown as Record<string, unknown>;
const meta = raw["_meta"] as { effectTypes: Record<string, string> };
const techs = Object.fromEntries(
  Object.entries(raw).filter(([id]) => !id.startsWith("_")),
) as Record<string, Tech>;

// README の ID 規約（src/data/README.md「tech ID（34）」）
const BLACKSMITH_8 = [
  "uchiba", "kouba", "yajiri", "kouyajiri",
  "kawayoroi", "kusariyoroi", "bankinyoroi", "bayoroi",
];
const ACADEMY_7 = ["hatazao", "hayaba", "fukusho", "nijuuhata", "sokuryo", "shahon", "chouheirei"];
const OTHER_11 = [
  "ryotebono", "oonoko", "tsuruhashi", "koudou", "suki", "rinsaku",
  "nida", "taisho", "yakusou", "zousen", "chuuzou",
];
const UNIQUE_8: Record<string, string> = {
  tanren: "yamato", guntan: "roma", kayakujutsu: "tou", kyousen: "viking",
  shahou: "mali", menkou: "azteca", kangyo: "persia", ekiden: "mongol",
};
const AGES = ["reimei", "seido", "tekki", "teikoku"];
const RESOURCES = ["food", "wood", "stone", "gold"];

describe("techs.json — 件数と内訳", () => {
  it("総数 34 件（_meta を除く）", () => {
    expect(Object.keys(techs)).toHaveLength(34);
    expect(meta).toBeDefined();
  });

  it("README の 34 ID を過不足なく網羅する", () => {
    const expected = [...BLACKSMITH_8, ...ACADEMY_7, ...OTHER_11, ...Object.keys(UNIQUE_8)].sort();
    expect(Object.keys(techs).sort()).toEqual(expected);
  });

  it("内訳: 鍛冶場8 / 学舎7 / その他11 / 固有8", () => {
    const byAt = (at: string) =>
      Object.entries(techs).filter(([, t]) => t.at === at && t.civ === undefined);
    expect(byAt("blacksmith")).toHaveLength(8);
    expect(byAt("academy")).toHaveLength(7);
    const other = Object.entries(techs).filter(
      ([, t]) => t.civ === undefined && t.at !== "blacksmith" && t.at !== "academy",
    );
    expect(other).toHaveLength(11);
    expect(Object.entries(techs).filter(([, t]) => t.civ !== undefined)).toHaveLength(8);
  });

  it("固有8は8文明を1つずつ担当する", () => {
    const pairs = Object.fromEntries(
      Object.entries(techs)
        .filter(([, t]) => t.civ !== undefined)
        .map(([id, t]) => [id, t.civ]),
    );
    expect(pairs).toEqual(UNIQUE_8);
  });
});

describe("techs.json — 共通の書式", () => {
  it("全件が name / at / age / cost / researchSec / requires / effects を持つ", () => {
    for (const [id, t] of Object.entries(techs)) {
      expect(typeof t.name, id).toBe("string");
      expect(t.name.length, id).toBeGreaterThan(0);
      expect(typeof t.at, id).toBe("string");
      expect(AGES, id).toContain(t.age);
      expect(t.researchSec, id).toBeGreaterThan(0);
      expect(Array.isArray(t.requires), id).toBe(true);
      expect(Array.isArray(t.effects), id).toBe(true);
      expect(t.effects.length, id).toBeGreaterThan(0);
      for (const key of Object.keys(t.cost)) expect(RESOURCES, `${id}.cost`).toContain(key);
      for (const v of Object.values(t.cost)) expect(v, `${id}.cost`).toBeGreaterThan(0);
    }
  });

  it("at は building ID のいずれか", () => {
    const buildings = new Set([
      "town_center", "house", "farm", "lumber_camp", "mining_camp", "watch_hut", "dock",
      "barracks", "archery_range", "market", "blacksmith", "palisade", "palisade_gate", "watch_tower",
      "stable", "academy", "shrine", "siege_workshop", "stone_wall", "stone_gate", "castle", "harbor",
      "gunpowder_workshop", "cannon_tower", "monument",
    ]);
    for (const [id, t] of Object.entries(techs)) expect(buildings.has(t.at), `${id}.at=${t.at}`).toBe(true);
  });

  it("researchSec は age だけで決まる（seido 30 / tekki 45 / teikoku 60）", () => {
    const table: Record<string, number> = { seido: 30, tekki: 45, teikoku: 60 };
    for (const [id, t] of Object.entries(techs)) expect(t.researchSec, id).toBe(table[t.age]);
  });
});

describe("techs.json — 03§9 鍛冶場8 のコストと効果", () => {
  const expected: Record<string, { name: string; age: string; cost: Cost; stat: string; add: number; lines: string[] }> = {
    uchiba:      { name: "打刃",   age: "seido",   cost: { food: 100 },              stat: "atk", add: 1, lines: ["melee"] },
    kouba:       { name: "鋼刃",   age: "tekki",   cost: { food: 150, gold: 50 },    stat: "atk", add: 1, lines: ["melee"] },
    yajiri:      { name: "鏃",     age: "seido",   cost: { food: 100, wood: 50 },    stat: "atk", add: 1, lines: ["ranged"] },
    kouyajiri:   { name: "鋼鏃",   age: "tekki",   cost: { food: 150, gold: 50 },    stat: "atk", add: 1, lines: ["ranged"] },
    kawayoroi:   { name: "革鎧",   age: "seido",   cost: { food: 100 },              stat: "def", add: 1, lines: ["melee", "ranged"] },
    kusariyoroi: { name: "鎖鎧",   age: "tekki",   cost: { food: 200, gold: 100 },   stat: "def", add: 1, lines: ["melee", "ranged"] },
    bankinyoroi: { name: "板金鎧", age: "teikoku", cost: { food: 300, gold: 150 },   stat: "def", add: 2, lines: ["melee", "ranged"] },
    bayoroi:     { name: "馬鎧",   age: "tekki",   cost: { food: 150, gold: 150 },   stat: "def", add: 2, lines: ["cavalry", "beast"] },
  };

  for (const [id, e] of Object.entries(expected)) {
    it(`${id}（${e.name}）`, () => {
      const t = techs[id]!;
      expect(t.name).toBe(e.name);
      expect(t.at).toBe("blacksmith");
      expect(t.age).toBe(e.age);
      expect(t.cost).toEqual(e.cost);
      expect(t.effects).toEqual([
        { type: "unitStat", lines: e.lines, stat: e.stat, add: e.add },
      ]);
    });
  }
});

describe("techs.json — 03§9 学舎7 のコストと効果", () => {
  const cases: Array<[string, string, string, Cost, Effect]> = [
    ["hatazao",    "旗竿",   "tekki",   { wood: 200, gold: 100 }, { type: "frontSlot", add: 1 }],
    ["hayaba",     "早馬",   "tekki",   { food: 150, gold: 100 }, { type: "orderSwitchIntervalMul", mul: 0.7 }],
    ["fukusho",    "復唱",   "tekki",   { food: 200 },            { type: "orderDelayMul", mul: 0.5 }],
    ["nijuuhata",  "二重旗", "teikoku", { wood: 300, gold: 300 }, { type: "orderStackSlots", slots: 2 }],
    ["sokuryo",    "測量",   "seido",   { food: 100 },            { type: "buildingSightAdd", add: 4 }],
    ["shahon",     "写本",   "tekki",   { food: 200, gold: 100 }, { type: "researchCostMul", mul: 0.85 }],
  ];

  for (const [id, name, age, cost, effect] of cases) {
    it(`${id}（${name}）`, () => {
      const t = techs[id]!;
      expect(t.name).toBe(name);
      expect(t.at).toBe("academy");
      expect(t.age).toBe(age);
      expect(t.cost).toEqual(cost);
      expect(t.effects).toEqual([effect]);
    });
  }

  it("chouheirei（徴兵令）は全兵の生産速度 +25%（村人を含まない）", () => {
    const t = techs["chouheirei"]!;
    expect(t.at).toBe("academy");
    expect(t.age).toBe("teikoku");
    expect(t.cost).toEqual({ food: 400, gold: 200 });
    expect(t.effects).toHaveLength(1);
    const e = t.effects[0]!;
    expect(e["type"]).toBe("produceSpeedMul");
    expect(e["mul"]).toBe(1.25);
    expect(e["lines"]).not.toContain("villager");
    expect(e["lines"]).toEqual(
      expect.arrayContaining(["melee", "ranged", "cavalry", "beast", "siege", "ship", "elite"]),
    );
  });
});

describe("techs.json — 03§9 その他11 の効果", () => {
  const cases: Array<[string, string, string, Effect]> = [
    ["ryotebono",  "両手斧", "lumber_camp", { type: "gatherRateMul", resource: "wood", from: "forest", mul: 1.2 }],
    ["oonoko",     "大鋸",   "lumber_camp", { type: "gatherRateMul", resource: "wood", from: "forest", mul: 1.2 }],
    ["koudou",     "坑道",   "mining_camp", { type: "depositMul", resources: ["stone", "gold"], mul: 1.3 }],
    ["suki",       "犂",     "town_center", { type: "farmYieldMul", mul: 1.3 }],
    ["rinsaku",    "輪作",   "town_center", { type: "farmYieldMul", mul: 1.4 }],
    ["nida",       "荷駄",   "market",      { type: "cartSpeedMul", mul: 1.25 }],
    ["taisho",     "隊商",   "market",      { type: "tradeIncomeMul", mul: 1.3 }],
    ["yakusou",    "薬草",   "shrine",      { type: "healSpeedMul", mul: 1.5 }],
    ["chuuzou",    "鋳造",   "castle",      { type: "eliteCostMul", mul: 0.8 }],
  ];

  for (const [id, name, at, effect] of cases) {
    it(`${id}（${name}）`, () => {
      const t = techs[id]!;
      expect(t.name).toBe(name);
      expect(t.at).toBe(at);
      expect(t.effects).toEqual([effect]);
    });
  }

  it("tsuruhashi（鶴嘴）は石材・金の採掘速度 +15%", () => {
    const t = techs["tsuruhashi"]!;
    expect(t.at).toBe("mining_camp");
    expect(t.effects).toEqual([
      { type: "gatherRateMul", resource: "stone", from: "mine", mul: 1.15 },
      { type: "gatherRateMul", resource: "gold", from: "mine", mul: 1.15 },
    ]);
  });

  it("zousen（造船）は船の生産速度 +30%・耐久 +20%", () => {
    const t = techs["zousen"]!;
    expect(t.at).toBe("harbor");
    expect(t.effects).toEqual([
      { type: "produceSpeedMul", lines: ["ship"], mul: 1.3 },
      { type: "shipStatMul", stat: "hp", mul: 1.2 },
    ]);
  });

  it("その他11と固有8のコストは age で決まる（_meta.costRule）", () => {
    const table: Record<string, Cost> = {
      seido: { food: 100, wood: 50 },
      tekki: { food: 200, gold: 100 },
      teikoku: { food: 300, gold: 200 },
    };
    for (const id of [...OTHER_11, ...Object.keys(UNIQUE_8)]) {
      const t = techs[id]!;
      expect(t.cost, id).toEqual(table[t.age]);
    }
  });
});

describe("techs.json — 03§9 文明固有8 の効果", () => {
  it("tanren（鍛錬・ヤマト）歩兵の防御 +1", () => {
    expect(techs["tanren"]!.effects).toEqual([
      { type: "unitStat", lines: ["melee", "ranged"], stat: "def", add: 1 },
    ]);
  });
  it("guntan（軍団編成・ローマ）待ち行列 5→10", () => {
    expect(techs["guntan"]!.effects).toEqual([
      { type: "queueLengthAdd", at: ["barracks", "archery_range", "stable"], add: 5 },
    ]);
  });
  it("kayakujutsu（火薬術・唐）火器と火箭車の攻撃 +25%", () => {
    const e = techs["kayakujutsu"]!.effects[0]!;
    expect(e["type"]).toBe("unitStat");
    expect(e["stat"]).toBe("atk");
    expect(e["mul"]).toBe(1.25);
    expect(e["roles"]).toContain("gunpowder");
    expect(e["units"]).toContain("t-kasensha");
  });
  it("kyousen（狂戦・ヴァイキング）体力が減るほど近接攻撃が上がる", () => {
    const e = techs["kyousen"]!.effects[0]!;
    expect(e["type"]).toBe("lowHpAtkBonus");
    expect(e["lines"]).toEqual(["melee"]);
    expect(e["maxAtkMul"]).toBeGreaterThan(1);
  });
  it("shahou（射法・マリ）遠隔兵の射程 +1", () => {
    expect(techs["shahou"]!.effects).toEqual([
      { type: "unitStat", lines: ["ranged"], stat: "rangeTiles", add: 1 },
    ]);
  });
  it("menkou（綿甲・アステカ）歩兵の遠隔耐性 +3", () => {
    expect(techs["menkou"]!.effects).toEqual([
      { type: "rangedResistAdd", lines: ["melee", "ranged"], add: 3 },
    ]);
  });
  it("kangyo（灌漁・ペルシア）農地の産出量 +20%", () => {
    expect(techs["kangyo"]!.effects).toEqual([{ type: "farmYieldMul", mul: 1.2 }]);
  });
  it("ekiden（駅伝・モンゴル）距離の項を0にする", () => {
    expect(techs["ekiden"]!.effects).toEqual([{ type: "orderDelayDistanceZero" }]);
  });
});

describe("techs.json — requires（05§10 飛び越して研究できない）", () => {
  it("requires の参照先が全て存在し、自己参照・循環がない", () => {
    for (const [id, t] of Object.entries(techs)) {
      for (const req of t.requires) {
        expect(techs[req], `${id} requires ${req}`).toBeDefined();
        expect(req, id).not.toBe(id);
        expect(techs[req]!.requires, `${req} が ${id} を逆参照`).not.toContain(id);
      }
    }
  });

  it("同枝の前提が張られている", () => {
    const expected: Record<string, string[]> = {
      uchiba: [], kouba: ["uchiba"],
      yajiri: [], kouyajiri: ["yajiri"],
      kawayoroi: [], kusariyoroi: ["kawayoroi"], bankinyoroi: ["kusariyoroi"], bayoroi: [],
      ryotebono: [], oonoko: ["ryotebono"],
      tsuruhashi: [], koudou: ["tsuruhashi"],
      suki: [], rinsaku: ["suki"],
      nida: [], taisho: ["nida"],
      tanren: ["bankinyoroi"], menkou: ["kawayoroi"], kangyo: ["suki"],
    };
    for (const [id, req] of Object.entries(expected)) expect(techs[id]!.requires, id).toEqual(req);
  });

  it("前提の age は自分と同じか前の時代", () => {
    const order = AGES;
    for (const [id, t] of Object.entries(techs)) {
      for (const req of t.requires) {
        expect(order.indexOf(techs[req]!.age), `${id} ← ${req}`).toBeLessThanOrEqual(
          order.indexOf(t.age),
        );
      }
    }
  });
});

describe("techs.json — effects の型レジストリ", () => {
  it("全 effects.type が _meta.effectTypes に登録されている", () => {
    const registered = new Set(Object.keys(meta.effectTypes));
    for (const [id, t] of Object.entries(techs)) {
      for (const e of t.effects) expect(registered.has(e.type), `${id}: ${e.type}`).toBe(true);
    }
  });

  it("_meta.effectTypes に説明のない型がない", () => {
    for (const [type, desc] of Object.entries(meta.effectTypes)) {
      expect(typeof desc, type).toBe("string");
      expect(desc.length, type).toBeGreaterThan(0);
    }
  });

  it("タスク指定の必須効果型が全て定義されている", () => {
    const required = [
      "unitStat", "frontSlot", "orderDelayMul", "orderDelayDistanceZero",
      "orderSwitchIntervalMul", "orderStackSlots", "gatherRateMul", "depositMul",
      "farmYieldMul", "buildingSightAdd", "researchCostMul", "produceSpeedMul",
      "queueLengthAdd", "healSpeedMul", "shipStatMul", "eliteCostMul",
      "tradeIncomeMul", "cartSpeedMul", "lowHpAtkBonus", "rangedResistAdd",
    ];
    for (const type of required) expect(Object.keys(meta.effectTypes), type).toContain(type);
  });

  it("文明固有の研究でも effects は型で表現され、civ 名に依存する分岐用フィールドを持たない", () => {
    for (const [id, t] of Object.entries(techs)) {
      for (const e of t.effects) {
        expect(Object.keys(e), id).not.toContain("civ");
        expect(Object.keys(e), id).not.toContain("tech");
      }
    }
  });
});
