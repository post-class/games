import { describe, it, expect } from "vitest";
import ordersJson from "../../src/data/orders.json";

/**
 * T-M1-07 `orders.json` の検証。
 * 上流資料: docs/07_ゲームシステム.html §4（段の分類表）/ §5（重みの入れ替え方）
 */

type Weights = Record<string, number>;
interface Order {
  name: string;
  key: number;
  tier: "upper" | "lower";
  weights?: Weights;
  targetPriority?: string[];
  formation?: string;
  civ?: string;
  note?: string;
  [k: string]: unknown;
}

const raw = ordersJson as unknown as Record<string, unknown>;
const orders = Object.fromEntries(
  Object.entries(raw).filter(([id]) => !id.startsWith("_")),
) as Record<string, Order>;

const BASE_6 = ["charge", "siege", "hold", "raid", "build", "retreat"];
const UNIQUE_8: Record<string, string> = {
  jindate: "yamato", hojin: "roma", kakei: "tou", jouriku: "viking",
  koeki: "mali", hounou: "azteca", assai: "persia", yugeki: "mongol",
};
const WEIGHT_KEYS = ["advance", "hold", "guard", "build", "evade"];
const FORMATIONS = ["normal", "dense", "loose", "escort"];

describe("orders.json — 件数と ID", () => {
  it("総数 14 件（基本6 + 固有8）", () => {
    expect(Object.keys(orders)).toHaveLength(14);
  });

  it("README の 14 ID を過不足なく網羅する", () => {
    expect(Object.keys(orders).sort()).toEqual([...BASE_6, ...Object.keys(UNIQUE_8)].sort());
  });

  it("固有令の civ が 8 文明を 1 つずつ網羅する", () => {
    const pairs = Object.fromEntries(
      Object.entries(orders).filter(([, o]) => o.civ !== undefined).map(([id, o]) => [id, o.civ]),
    );
    expect(pairs).toEqual(UNIQUE_8);
    expect(new Set(Object.values(pairs)).size).toBe(8);
  });

  it("基本6は civ を持たない", () => {
    for (const id of BASE_6) expect(orders[id]!.civ, id).toBeUndefined();
  });
});

describe("orders.json — key（06 の操作規約）", () => {
  it("基本6の key は 1〜6 が重複なく割り当てられている", () => {
    const keys = BASE_6.map((id) => orders[id]!.key).sort((a, b) => a - b);
    expect(keys).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("基本6の key は資料の並び（突撃1・包囲2・死守3・略奪4・建設5・後退6）", () => {
    expect(orders["charge"]!.key).toBe(1);
    expect(orders["siege"]!.key).toBe(2);
    expect(orders["hold"]!.key).toBe(3);
    expect(orders["raid"]!.key).toBe(4);
    expect(orders["build"]!.key).toBe(5);
    expect(orders["retreat"]!.key).toBe(6);
  });

  it("固有令8は全て key: 7（Shift+7）", () => {
    for (const id of Object.keys(UNIQUE_8)) expect(orders[id]!.key, id).toBe(7);
  });
});

describe("orders.json — tier（07§4 の分類表）", () => {
  it("全件が tier を持ち upper | lower のいずれか", () => {
    for (const [id, o] of Object.entries(orders)) {
      expect(["upper", "lower"], id).toContain(o.tier);
    }
  });

  it("基本6は 上段4（突撃/死守/後退/建設）・下段2（包囲/略奪）で固定", () => {
    const upper = BASE_6.filter((id) => orders[id]!.tier === "upper");
    const lower = BASE_6.filter((id) => orders[id]!.tier === "lower");
    expect(upper.sort()).toEqual(["build", "charge", "hold", "retreat"]);
    expect(lower.sort()).toEqual(["raid", "siege"]);
    expect(upper).toHaveLength(4);
    expect(lower).toHaveLength(2);
  });

  it("資料に明記のある固有令: 方陣=上段 / 交易=下段（07§4）", () => {
    expect(orders["hojin"]!.tier).toBe("upper");
    expect(orders["koeki"]!.tier).toBe("lower");
  });

  it("段の指定が資料にない固有令6件は判断根拠を note に持つ（T-M9-08）", () => {
    for (const id of ["jindate", "kakei", "jouriku", "hounou", "assai", "yugeki"]) {
      expect(orders[id]!.note, id).toContain("【段の判断】");
    }
  });

  it("二重旗の組み合わせが成立する（上段1+下段1）", () => {
    // 07§4 の例: 死守+包囲 / 後退+略奪 / 建設+包囲
    const pairs: Array<[string, string]> = [
      ["hold", "siege"], ["retreat", "raid"], ["build", "siege"],
    ];
    for (const [a, b] of pairs) {
      expect(orders[a]!.tier).toBe("upper");
      expect(orders[b]!.tier).toBe("lower");
    }
    // 同段は重ねられない
    expect(orders["charge"]!.tier).toBe(orders["hold"]!.tier);
  });
});

describe("orders.json — weights / targetPriority / formation の書式", () => {
  it("weights は 5 キー揃っており値域 -1.0..1.0", () => {
    for (const [id, o] of Object.entries(orders)) {
      expect(Object.keys(o.weights ?? {}).sort(), id).toEqual([...WEIGHT_KEYS].sort());
      for (const [k, v] of Object.entries(o.weights!)) {
        expect(v, `${id}.${k}`).toBeGreaterThanOrEqual(-1);
        expect(v, `${id}.${k}`).toBeLessThanOrEqual(1);
      }
    }
  });

  it("formation は既定の 4 種のいずれか", () => {
    for (const [id, o] of Object.entries(orders)) expect(FORMATIONS, id).toContain(o.formation);
  });

  it("targetPriority は非空の配列で既知のキーのみ", () => {
    const known = new Set([
      "nearest", "in_range", "unit", "villager", "resource_building",
      "house", "building", "wall_gate", "ship", "siege_unit",
    ]);
    for (const [id, o] of Object.entries(orders)) {
      expect(Array.isArray(o.targetPriority), id).toBe(true);
      expect(o.targetPriority!.length, id).toBeGreaterThan(0);
      for (const t of o.targetPriority!) expect(known.has(t), `${id}: ${t}`).toBe(true);
    }
  });

  it("井戸・種籾蔵は自動ターゲットに含めない（03 の掟）", () => {
    for (const [id, o] of Object.entries(orders)) {
      expect(o.targetPriority, id).not.toContain("well");
      expect(o.targetPriority, id).not.toContain("seed_store");
    }
  });
});

describe("orders.json — 07§5「重みの入れ替え方」の反映", () => {
  it("突撃: 前進最大／持ち場0／対象は最も近い敵", () => {
    const o = orders["charge"]!;
    expect(o.weights!["advance"]).toBe(1.0);
    expect(o.weights!["hold"]).toBe(0.0);
    expect(o.targetPriority).toEqual(["nearest"]);
    expect(o.formation).toBe("normal");
  });

  it("包囲: 攻城兵器が先頭・歩兵の護衛が最大・兵器が下がると歩兵も下がる", () => {
    const o = orders["siege"]!;
    expect(o.weights!["guard"]).toBe(1.0);
    expect(o.weights!["advance"]).toBe(0.5);
    expect(o["siegeLead"]).toBe(true);
    expect(o["followSiege"]).toBe(true);
    expect(o.formation).toBe("escort");
    expect(o.targetPriority).toEqual(["wall_gate", "building", "unit"]);
  });

  it("死守: 持ち場最大／前進0／隊列は密集", () => {
    const o = orders["hold"]!;
    expect(o.weights!["hold"]).toBe(1.0);
    expect(o.weights!["advance"]).toBe(0.0);
    expect(o.formation).toBe("dense");
  });

  it("略奪: 村人→資源施設→家 / 戦闘ユニットを避ける", () => {
    const o = orders["raid"]!;
    expect(o.targetPriority).toEqual(["villager", "resource_building", "house"]);
    expect(o["avoidCombatUnits"]).toBe(true);
  });

  it("建設: 村人の build 最大・兵は村人の護衛", () => {
    const o = orders["build"]!;
    expect(o.weights!["build"]).toBe(1.0);
    expect(o.weights!["guard"]).toBeGreaterThan(0.5);
  });

  it("後退: 前進は負の値・被弾回避が最大・散開", () => {
    const o = orders["retreat"]!;
    expect(o.weights!["advance"]).toBeLessThan(0);
    expect(o.weights!["evade"]).toBe(1.0);
    expect(o.formation).toBe("loose");
  });
});

describe("orders.json — 固有令8の効果フィールド（01/03 の一行説明）", () => {
  it("陣立て（ヤマト）防御隊形で被害を軽減", () => {
    const o = orders["jindate"]!;
    expect(o.formation).toBe("dense");
    expect(o["damageTakenMul"] as number).toBeLessThan(1);
  });
  it("方陣（ローマ）損耗しても隊列が崩れない", () => {
    const o = orders["hojin"]!;
    expect(o["formationKeep"]).toBe(true);
    expect(o["moraleBreakImmune"]).toBe(true);
  });
  it("火計（唐）建物へのダメージが増える", () => {
    const o = orders["kakei"]!;
    expect(o["buildingDamageMul"] as number).toBeGreaterThan(1);
    expect(o.targetPriority![0]).toBe("building");
  });
  it("上陸（ヴァイキング）水辺の戦域に強襲をかける", () => {
    const o = orders["jouriku"]!;
    expect(o["waterAssault"]).toBe(true);
    expect(o["requiresWaterFront"]).toBe(true);
    expect(o.weights!["advance"]).toBe(1.0);
  });
  it("交易（マリ）戦域を維持すると金が入る", () => {
    const income = orders["koeki"]!["holdIncome"] as Record<string, number>;
    expect(income["gold"]).toBeGreaterThan(0);
    expect(orders["koeki"]!.weights!["hold"]).toBeGreaterThan(0.5);
  });
  it("奉納（アステカ）撃破数が資源に変わる", () => {
    const r = orders["hounou"]!["killIncomeRatio"] as number;
    expect(r).toBeGreaterThan(0);
    expect(r).toBeLessThanOrEqual(1);
  });
  it("圧壊（ペルシア）正面の敵陣を押し崩す", () => {
    const o = orders["assai"]!;
    expect(o["pushThrough"]).toBe(true);
    expect(o.weights!["advance"]).toBe(1.0);
    expect(o.formation).toBe("dense");
  });
  it("遊撃（モンゴル）戦域を跨いで移動し続ける", () => {
    const o = orders["yugeki"]!;
    expect(o["crossFront"]).toBe(true);
    expect(o.formation).toBe("loose");
  });
});
