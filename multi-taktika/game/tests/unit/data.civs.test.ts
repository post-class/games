import { describe, it, expect } from "vitest";
import civsJson from "../../src/data/civs.json";
import techsJson from "../../src/data/techs.json";
import ordersJson from "../../src/data/orders.json";
import buildingsJson from "../../src/data/buildings.json";

/**
 * T-M1-08 `civs.json` の検証。
 * 上流資料: docs/03_文明と進化.html §3 / §5（兵種ツリー・穴と尖り）/ §8 / §9、docs/02_世界観.html
 *
 * units.json / buildings.json は別タスク（T-M1-04 / T-M1-05）の担当なので、
 * 参照先の存在確認は src/data/README.md に列挙された ID 一覧を写した定数で行う。
 */

type TreeSlot = string | null | string[];
interface Civ {
  name: string;
  homeland: string;
  note: string;
  econBonus: Array<{ type: string } & Record<string, unknown>>;
  uniqueOrder: string;
  uniqueTech: string;
  eliteUnit: string;
  replaceBuildings: Record<string, string>;
  uniqueBuildings: string[];
  forbidBuildings: string[];
  forbidTechs: string[];
  unitTree: Record<string, TreeSlot[]>;
  strengths: string;
  weaknesses: string;
  winCondition: string;
}

const raw = civsJson as unknown as Record<string, unknown>;
const civs = Object.fromEntries(
  Object.entries(raw).filter(([id]) => !id.startsWith("_")),
) as Record<string, Civ>;
const buildings = buildingsJson as unknown as Record<string, { replaces?: string }>;

const techs = techsJson as unknown as Record<string, unknown>;
const orders = ordersJson as unknown as Record<string, unknown>;
const effectTypes = Object.keys(
  (techs["_meta"] as { effectTypes: Record<string, string> }).effectTypes,
);

const CIV_IDS = ["yamato", "roma", "tou", "viking", "mali", "azteca", "persia", "mongol"];

// src/data/README.md「unit ID（全 94 件・固定）」より
const UNIT_IDS = new Set([
  "villager", "clubman", "hunter", "scout",
  "herald", "trade_cart", "priest", "fishing_boat", "transport_ship", "warship", "fire_ship",
  "y-ashigaru", "y-musha", "y-nagae", "y-yumiashigaru", "y-daikyu", "y-teppo", "y-horo", "y-kiba", "y-seiro", "y-ozutsu",
  "r-hastati", "r-principes", "r-triarii", "r-slinger", "r-scorpio", "r-handgun", "r-eq-light", "r-eq", "r-eq-heavy", "r-ram", "r-ballista", "r-onager",
  "t-hosotsu", "t-hakuto", "t-nagayari", "t-yumite", "t-dote", "t-kaju", "t-keiki", "t-tekki", "t-shoshido", "t-kasensha",
  "v-raider", "v-shield", "v-axe", "v-javelin", "v-bow", "v-fire", "v-ram", "v-longship", "v-greatship",
  "m-yarite", "m-menko", "m-naga", "m-yumi", "m-daikyu", "m-hinawa", "m-camel", "m-camel-heavy", "m-ram", "m-catapult",
  "a-club", "a-obsidian", "a-feather", "a-blowgun", "a-atlatl", "a-catapult", "a-bigcatapult",
  "p-immortal", "p-shield", "p-naga", "p-bow", "p-daikyu", "p-gun", "p-cav", "p-cataphract", "p-elephant", "p-elephant-armored", "p-tower", "p-cannon",
  "g-dismount", "g-light", "g-archer", "g-heavy", "g-catapult",
  "y-bushi", "r-legion", "t-renkyu", "v-berserk", "m-guard-archer", "a-jaguar", "p-guard-elephant", "g-guard-horsearcher",
]);

// src/data/README.md「building ID」より
const COMMON_BUILDINGS = new Set([
  "town_center", "house", "farm", "lumber_camp", "mining_camp", "watch_hut", "dock",
  "barracks", "archery_range", "market", "blacksmith", "palisade", "palisade_gate", "watch_tower",
  "stable", "academy", "shrine", "siege_workshop", "stone_wall", "stone_gate", "castle", "harbor",
  "gunpowder_workshop", "cannon_tower", "monument",
]);
const CIV_BUILDINGS = new Set([
  "yagura", "road", "kanrin", "boathouse", "salt_store", "temple_platform", "qanat", "great_tent",
]);

const LINES = ["melee", "ranged", "cavalry", "beast", "siege", "ship", "elite"];

const flatten = (slots: TreeSlot[]): string[] =>
  slots.flatMap((s) => (s === null ? [] : Array.isArray(s) ? s : [s]));

describe("civs.json — 件数と ID", () => {
  it("8 文明", () => {
    expect(Object.keys(civs)).toHaveLength(8);
  });
  it("README の civ ID を過不足なく網羅（この順）", () => {
    expect(Object.keys(civs)).toEqual(CIV_IDS);
  });
  it("全件が説明・穴と尖り・勝ち筋を持つ（03§5 と 1 対 1 で照合できる）", () => {
    for (const [id, c] of Object.entries(civs)) {
      for (const k of ["name", "homeland", "note", "strengths", "weaknesses", "winCondition"] as const) {
        expect(typeof c[k], `${id}.${k}`).toBe("string");
        expect(c[k].length, `${id}.${k}`).toBeGreaterThan(0);
      }
    }
  });
});

describe("civs.json — uniqueOrder / uniqueTech / eliteUnit の参照", () => {
  it("uniqueOrder が orders.json に存在し、その令の civ が一致する", () => {
    for (const [id, c] of Object.entries(civs)) {
      const o = orders[c.uniqueOrder] as { civ?: string } | undefined;
      expect(o, `${id}.uniqueOrder=${c.uniqueOrder}`).toBeDefined();
      expect(o!.civ, id).toBe(id);
    }
    expect(new Set(Object.values(civs).map((c) => c.uniqueOrder)).size).toBe(8);
  });

  it("uniqueTech が techs.json に存在し、その研究の civ が一致する", () => {
    for (const [id, c] of Object.entries(civs)) {
      const t = techs[c.uniqueTech] as { civ?: string } | undefined;
      expect(t, `${id}.uniqueTech=${c.uniqueTech}`).toBeDefined();
      expect(t!.civ, id).toBe(id);
    }
    expect(new Set(Object.values(civs).map((c) => c.uniqueTech)).size).toBe(8);
  });

  it("eliteUnit が README の unit ID に存在する（8 種で重複なし）", () => {
    const expected: Record<string, string> = {
      yamato: "y-bushi", roma: "r-legion", tou: "t-renkyu", viking: "v-berserk",
      mali: "m-guard-archer", azteca: "a-jaguar", persia: "p-guard-elephant",
      mongol: "g-guard-horsearcher",
    };
    for (const [id, c] of Object.entries(civs)) {
      expect(UNIT_IDS.has(c.eliteUnit), `${id}.eliteUnit=${c.eliteUnit}`).toBe(true);
      expect(c.eliteUnit, id).toBe(expected[id]);
    }
  });
});

describe("civs.json — unitTree（03§5 のツリー表）", () => {
  it("全系統が [青銅, 鉄器, 帝国] の 3 要素", () => {
    for (const [id, c] of Object.entries(civs)) {
      for (const [line, slots] of Object.entries(c.unitTree)) {
        expect(LINES, `${id}.${line}`).toContain(line);
        expect(Array.isArray(slots), `${id}.${line}`).toBe(true);
        expect(slots, `${id}.${line}`).toHaveLength(3);
      }
    }
  });

  it("要素は null / unit ID / unit ID の配列 のいずれか", () => {
    for (const [id, c] of Object.entries(civs)) {
      for (const [line, slots] of Object.entries(c.unitTree)) {
        for (const u of flatten(slots)) {
          expect(UNIT_IDS.has(u), `${id}.${line}: ${u}`).toBe(true);
        }
      }
    }
  });

  it("ユニット ID の接頭辞が文明と一致する", () => {
    const prefix: Record<string, string> = {
      yamato: "y-", roma: "r-", tou: "t-", viking: "v-",
      mali: "m-", azteca: "a-", persia: "p-", mongol: "g-",
    };
    for (const [id, c] of Object.entries(civs)) {
      for (const slots of Object.values(c.unitTree)) {
        for (const u of flatten(slots)) expect(u.startsWith(prefix[id]!), `${id}: ${u}`).toBe(true);
      }
    }
  });

  it("同じユニットが 2 か所に現れない（全文明を通じて一意）", () => {
    const seen = new Set<string>();
    for (const c of Object.values(civs)) {
      for (const slots of Object.values(c.unitTree)) {
        for (const u of flatten(slots)) {
          expect(seen.has(u), `重複: ${u}`).toBe(false);
          seen.add(u);
        }
      }
    }
    // ツリー 75 件（README「文明別ツリー（75）」）
    expect(seen.size).toBe(75);
  });

  it("ヴァイキングとアステカの cavalry は全要素 null（騎兵を持たない）", () => {
    for (const id of ["viking", "azteca"]) {
      expect(civs[id]!.unitTree["cavalry"], id).toEqual([null, null, null]);
    }
  });

  it("ヴァイキングとアステカは帝国の遠隔を持たない（火器・硝石なし）", () => {
    expect(civs["viking"]!.unitTree["ranged"]![2]).toBeNull();
    expect(civs["azteca"]!.unitTree["ranged"]![2]).toBeNull();
  });

  it("モンゴルは徒歩の遠隔が全要素 null、近接は [null, g-dismount, null]", () => {
    const t = civs["mongol"]!.unitTree;
    expect(t["ranged"]).toEqual([null, null, null]);
    expect(t["melee"]).toEqual([null, "g-dismount", null]);
    expect(t["siege"]).toEqual([null, null, "g-catapult"]);
  });

  it("ローマは近接・遠隔・騎兵の 3 系統が 3 段揃う唯一の文明", () => {
    for (const line of ["melee", "ranged", "cavalry"]) {
      expect(civs["roma"]!.unitTree[line], line).not.toContain(null);
    }
    const others = CIV_IDS.filter((id) => id !== "roma");
    for (const id of others) {
      const t = civs[id]!.unitTree;
      const full = ["melee", "ranged", "cavalry"].every(
        (line) => (t[line] ?? []).every((s) => s !== null),
      );
      expect(full, id).toBe(false);
    }
  });

  it("騎兵が青銅から出るのはローマとモンゴルのみ（03§2）", () => {
    const early = CIV_IDS.filter((id) => civs[id]!.unitTree["cavalry"]?.[0] !== null);
    expect(early.sort()).toEqual(["mongol", "roma"]);
  });

  it("beast 系統を持つのはペルシアのみ、ship 系統を持つのはヴァイキングのみ", () => {
    expect(CIV_IDS.filter((id) => "beast" in civs[id]!.unitTree)).toEqual(["persia"]);
    expect(CIV_IDS.filter((id) => "ship" in civs[id]!.unitTree)).toEqual(["viking"]);
  });

  it("マリは攻城の最上位が投石機まで（オナゲル級を持たない）", () => {
    expect(civs["mali"]!.unitTree["siege"]).toEqual([null, "m-ram", "m-catapult"]);
  });
});

describe("civs.json — forbidBuildings / forbidTechs / replaceBuildings", () => {
  it("forbidBuildings が共通建物 ID を指す", () => {
    for (const [id, c] of Object.entries(civs)) {
      for (const b of c.forbidBuildings) expect(COMMON_BUILDINGS.has(b), `${id}: ${b}`).toBe(true);
    }
  });

  it("forbidBuildings が 03§3 の表どおり", () => {
    const expected: Record<string, string[]> = {
      yamato: [], roma: [], tou: [],
      viking: ["stable", "stone_wall", "stone_gate", "gunpowder_workshop"],
      mali: [],
      azteca: ["stable", "gunpowder_workshop"],
      persia: [],
      mongol: ["castle", "stone_wall", "stone_gate", "gunpowder_workshop"],
    };
    for (const [id, list] of Object.entries(expected)) {
      expect(civs[id]!.forbidBuildings, id).toEqual(list);
    }
  });

  it("forbidTechs が techs.json に存在する ID を指す", () => {
    for (const [id, c] of Object.entries(civs)) {
      for (const t of c.forbidTechs) expect(techs[t], `${id}: ${t}`).toBeDefined();
    }
  });

  it("forbidTechs が 03§9 の表どおり", () => {
    const expected: Record<string, string[]> = {
      yamato: [], roma: [],
      tou: ["kouba"],
      viking: ["bankinyoroi", "bayoroi"],
      mali: ["chuuzou"],
      azteca: ["kusariyoroi", "bankinyoroi", "bayoroi"],
      persia: [],
      mongol: ["bankinyoroi"],
    };
    for (const [id, list] of Object.entries(expected)) {
      expect(civs[id]!.forbidTechs, id).toEqual(list);
    }
  });

  it("固有研究を禁止していない（自分の固有研究は必ず研究できる）", () => {
    for (const [id, c] of Object.entries(civs)) {
      expect(c.forbidTechs, id).not.toContain(c.uniqueTech);
    }
  });

  it("禁止した研究を前提に持つ研究も実質研究できない（前提の整合）", () => {
    for (const [id, c] of Object.entries(civs)) {
      for (const t of c.forbidTechs) {
        // 禁止研究を requires に持つ研究は、その文明では到達不能。
        // 到達不能な研究が forbidTechs に載っていないのは許容だが、固有研究が
        // 禁止研究に依存していてはならない。
        const own = techs[c.uniqueTech] as { requires: string[] };
        expect(own.requires, `${id}.uniqueTech ← ${t}`).not.toContain(t);
      }
    }
  });

  it("replaceBuildings は 共通建物 → 固有建物 の対応", () => {
    for (const [id, c] of Object.entries(civs)) {
      for (const [from, to] of Object.entries(c.replaceBuildings)) {
        expect(COMMON_BUILDINGS.has(from), `${id}: ${from}`).toBe(true);
        expect(CIV_BUILDINGS.has(to), `${id}: ${to}`).toBe(true);
      }
    }
  });

  it("replaceBuildings が 03§3 の表どおり", () => {
    const expected: Record<string, Record<string, string>> = {
      yamato: { watch_tower: "yagura" },
      roma: {},
      tou: { academy: "kanrin" },
      viking: { harbor: "boathouse" },
      mali: {},
      azteca: {},
      persia: {},
      mongol: { castle: "great_tent" },
    };
    for (const [id, map] of Object.entries(expected)) {
      expect(civs[id]!.replaceBuildings, id).toEqual(map);
    }
  });

  it("固有建物 8 種が replaceBuildings / uniqueBuildings で 1 度ずつ使われる", () => {
    const used: string[] = [];
    for (const c of Object.values(civs)) {
      used.push(...Object.values(c.replaceBuildings), ...c.uniqueBuildings);
    }
    expect(used.sort()).toEqual([...CIV_BUILDINGS].sort());
  });

  it("uniqueBuildings が固有建物 ID を指す", () => {
    for (const [id, c] of Object.entries(civs)) {
      for (const b of c.uniqueBuildings) expect(CIV_BUILDINGS.has(b), `${id}: ${b}`).toBe(true);
    }
  });

  it("厩を建てられない文明は騎兵ツリーが空、火薬工房を建てられない文明は帝国遠隔が空", () => {
    for (const [id, c] of Object.entries(civs)) {
      if (c.forbidBuildings.includes("stable")) {
        expect(c.unitTree["cavalry"], id).toEqual([null, null, null]);
      }
      if (c.forbidBuildings.includes("gunpowder_workshop")) {
        expect(c.unitTree["ranged"]?.[2] ?? null, id).toBeNull();
      }
    }
  });
});

describe("civs.json — econBonus（02/03「ゲーム上の現れ」）", () => {
  it("全文明が内政ボーナスを持つ（唐だけは固有建物がその役割を担う）", () => {
    for (const [id, c] of Object.entries(civs)) {
      expect(Array.isArray(c.econBonus), id).toBe(true);
      if (id === "tou") {
        // 唐の「技術研究が安い」は固有建物 翰林院（学舎の置き換え・研究が 20% 速く 20% 安い）
        // そのものが担う。文明レベルにも researchCostMul 0.8 を置くと同じ効果が二重に掛かり、
        // 学舎の研究が 0.64 倍になってしまう。03§3 に明記された数値のある建物側を採用した。
        // 判断の記録は docs/ISSUES.md の [矛盾] 唐の研究コスト割引。
        expect(c.econBonus.length, id).toBe(0);
        expect(buildings["kanrin"]?.replaces).toBe("academy");
        continue;
      }
      expect(c.econBonus.length, id).toBeGreaterThan(0);
    }
  });

  it("econBonus の type は techs.json の _meta.effectTypes に登録済み（効果を型で表現）", () => {
    for (const [id, c] of Object.entries(civs)) {
      for (const b of c.econBonus) expect(effectTypes, `${id}: ${b.type}`).toContain(b.type);
    }
  });

  it("econBonus に文明名の分岐用フィールドがない", () => {
    for (const [id, c] of Object.entries(civs)) {
      for (const b of c.econBonus) {
        expect(Object.keys(b), id).not.toContain("civ");
      }
    }
  });

  it("資料どおりの内政ボーナス", () => {
    expect(civs["yamato"]!.econBonus).toEqual([
      { type: "gatherRateMul", resource: "food", from: "farm", mul: 1.15 },
    ]);
    expect(civs["roma"]!.econBonus).toEqual([
      { type: "buildCostMul", building: "road", mul: 0.5 },
    ]);
    // 唐の econBonus は空。理由は上の「全文明が内政ボーナスを持つ」のコメントと
    // docs/ISSUES.md の [矛盾] 唐の研究コスト割引 を参照。
    expect(civs["tou"]!.econBonus).toEqual([]);
    expect(civs["mali"]!.econBonus).toEqual([
      { type: "gatherRateMul", resource: "gold", from: "mine", mul: 1.2 },
    ]);
    expect(civs["mongol"]!.econBonus).toEqual([
      { type: "produceSpeedMul", lines: ["cavalry"], mul: 1.2 },
    ]);
    // ヴァイキング: 船と伐採が強化
    expect(civs["viking"]!.econBonus.map((b) => b.type).sort()).toEqual([
      "gatherRateMul", "unitCostMul",
    ]);
    // アステカ: 村人の建設が速い＋歩兵の生産が最速
    expect(civs["azteca"]!.econBonus.map((b) => b.type).sort()).toEqual([
      "buildSpeedMul", "produceSpeedMul",
    ]);
    // ペルシア: 開始資源が最多
    expect(civs["persia"]!.econBonus[0]!.type).toBe("startResourceAdd");
  });
});
