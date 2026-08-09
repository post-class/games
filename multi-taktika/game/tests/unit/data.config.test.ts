import { describe, it, expect } from 'vitest';
import config from '@/data/config.json';
import resources from '@/data/resources.json';
import maps from '@/data/maps.json';
import ai from '@/data/ai.json';

/**
 * T-M1-01 / T-M1-03 / T-M1-09 のマスターデータ検証。
 * 上流資料: docs/03_文明と進化.html §1 §2 §7 / docs/07_ゲームシステム.html §3 §4 §11 §13 §14
 * 手順書: 00_initila_constructions/specs/30_実装手順書.md §5.1 §14.2
 */

interface AgeDef {
  id: string;
  name: string;
  slots: number;
  cost?: Record<string, number>;
  researchSec?: number;
  requireBuildingsOfPrevAge?: number;
}
/** JSON の推論型（reimei に cost が無い）を吸収するための型付け */
const ages = config.ages as readonly AgeDef[];

/** 令の遅延（手順書 §6.2 の計算順をそのまま実装した検算用ヘルパ） */
function orderDelaySec(opts: {
  distTiles: number;
  denrei?: boolean;
  fukusho?: boolean;
  lowLoyalty?: boolean;
  ekiden?: boolean;
}): number {
  const o = config.order;
  const dist = opts.ekiden ? 0 : opts.distTiles;
  let sec = o.baseDelaySec + dist * o.perTileSec;
  if (opts.denrei) sec += o.denreiFlatSec;
  if (opts.fukusho) sec *= o.fukushoMul;
  if (opts.lowLoyalty) sec += o.lowLoyaltyPenaltySec;
  return Math.min(o.delayMaxSec, Math.max(o.delayMinSec, sec));
}

describe('config.json — 全体定数', () => {
  it('tick モデルと試合長（手順書 §4.1 / 07§2）', () => {
    expect(config.tickRate).toBe(25);
    expect(config.matchLengthSec).toBe(1800);
    expect(config.matchLengthSec * config.tickRate).toBe(45_000);
  });

  it('戦域のパラメータが 07§3 と一致', () => {
    const f = config.front;
    expect(f.spawnRadiusTiles).toBe(15);
    expect(f.spawnMinUnits).toBe(3);
    expect(f.spawnEngageSec).toBe(2);
    expect(f.growMaxRadiusTiles).toBe(30);
    expect(f.mergeDistTiles).toBe(20);
    expect(f.splitDistTiles).toBe(35);
    expect(f.closeIdleSec).toBe(15);
    expect(f.warnThreshold).toBeCloseTo(-0.3, 6);
    expect(f.advantageWindowSec).toBe(10);
    expect(f.maxSlots).toBe(6);
    // 成長式: radius = clamp(15 + floor(n/4), 15, 30)
    const radiusOf = (n: number): number =>
      Math.min(
        f.growMaxRadiusTiles,
        Math.max(f.growBaseRadiusTiles, f.growBaseRadiusTiles + Math.floor(n / f.growUnitsPerRadiusTile)),
      );
    expect(radiusOf(0)).toBe(15);
    expect(radiusOf(40)).toBe(25);
    expect(radiusOf(200)).toBe(30);
  });

  it('戦闘計算の係数が 07§6 と一致', () => {
    const c = config.combat;
    expect(c.minDamage).toBe(1);
    expect(c.counterGood).toBe(1.5);
    expect(c.counterBad).toBe(0.7);
    expect(c.counterNeutral).toBe(1);
    expect(c.pierceIgnoreDefRatio).toBe(0.5);
    expect(c.highGround).toBe(1.15);
    expect(c.lowGround).toBe(0.9);
    expect(c.denseAoeTaken).toBe(1.4);
    expect(c.friendlyFire).toBe(0.5);
    expect(c.forestRangedRange).toBeCloseTo(-0.25, 6);
    expect(c.shallowCavSpeed).toBeCloseTo(-0.3, 6);
    expect(c.looseSpeed).toBeCloseTo(-0.15, 6);
  });

  it('経済のパラメータが 07§8 と一致（運搬損失 40 マスで上限 50%）', () => {
    const e = config.economy;
    expect(e.carryCapacity).toBe(10);
    expect(e.farmYield).toBe(400);
    expect(e.farmRebuildCostRatio).toBe(0.5);
    expect(e.marketPriceUpPer100).toBeCloseTo(0.03, 6);
    expect(e.marketDecayPer30s).toBeCloseTo(0.01, 6);
    expect(e.tradeGoldPerTile).toBe(0.5);
    expect(e.tributeFeeRatio).toBeCloseTo(0.1, 6);

    const haulLoss = (tiles: number): number =>
      Math.min(e.haulLossMax, Math.floor(tiles / e.haulLossTilesPerStep) * e.haulLossPer4Tiles);
    expect(haulLoss(0)).toBeCloseTo(0, 6);
    expect(haulLoss(4)).toBeCloseTo(0.05, 6);
    expect(haulLoss(40)).toBeCloseTo(0.5, 6); // 上限
    expect(haulLoss(200)).toBeCloseTo(0.5, 6);

    // 交易金（片道 100 マス）= 50
    expect(100 * e.tradeGoldPerTile).toBe(50);
  });

  it('建設速度テーブルが 07§9 と一致し 4 人以上も整数テーブルで定義されている', () => {
    const t = config.construction.villagerSpeedMulTable as Record<string, number>;
    expect(t['1']).toBe(1.0);
    expect(t['2']).toBeCloseTo(1.7, 6);
    expect(t['3']).toBeCloseTo(2.3, 6);
    for (let n = 1; n <= config.construction.villagerSpeedMulMaxVillagers; n++) {
      expect(typeof t[String(n)]).toBe('number');
    }
    // 単調増加
    for (let n = 2; n <= config.construction.villagerSpeedMulMaxVillagers; n++) {
      expect(t[String(n)]!).toBeGreaterThan(t[String(n - 1)]!);
    }
    expect(config.construction.repairCostRatioMax).toBe(0.25);
    expect(config.construction.wallRebuildTimeMul).toBe(1.5);
  });

  it('人口が 03§1 と一致', () => {
    expect(config.population.defaultCap).toBe(200);
    expect(config.population.housePop).toBe(5);
    expect(config.population.townCenterPop).toBe(10);
    expect(config.population.siegePop).toBe(3);
    expect(config.population.elephantPop).toBe(2);
  });

  it('忠誠度が 07§10 と一致', () => {
    const l = config.loyalty;
    expect(l.start).toBe(1.0);
    expect(l.regenPer30s).toBeCloseTo(0.01, 6);
    expect(l.breakLaw).toBeCloseTo(-0.25, 6);
    expect(l.loseTownCenter).toBeCloseTo(-0.05, 6);
    expect(l.abandonFronts).toBeCloseTo(-0.1, 6);
    expect(l.abandonCountThreshold).toBe(3);
    expect(l.abandonIdleSec).toBe(60);
    expect(l.truceKept).toBeCloseTo(0.15, 6);
    expect(l.thresholdDelayPenalty).toBe(0.8);
    expect(l.thresholdDelayPenaltySec).toBe(2.0);
    expect(l.thresholdDefect).toBe(0.5);
    expect(l.thresholdDefeat).toBe(0);
    // 掟 4 つはすべて -25%
    for (const v of Object.values(l.lawPenalties)) expect(v).toBeCloseTo(-0.25, 6);
  });

  it('スロット上限は 帝国 4 + 城 n + 旗竿 1 で合計 6 打ち止め（03§2）', () => {
    const s = config.slotBonus;
    expect(s.perCastle).toBe(1);
    expect(s.techHatazao).toBe(1);
    expect(s.hardMax).toBe(6);
    const slots = (ageSlots: number, castles: number, hatazao: boolean): number =>
      Math.min(s.hardMax, ageSlots + castles * s.perCastle + (hatazao ? s.techHatazao : 0));
    expect(slots(4, 0, false)).toBe(4);
    expect(slots(4, 1, true)).toBe(6);
    expect(slots(4, 5, true)).toBe(6); // 打ち止め
    expect(slots(1, 0, false)).toBe(1);
  });

  it('勝敗が 03§10 / 07 と一致（碑の写し 6 分 = 360 秒）', () => {
    expect(config.victory.monumentHoldSec).toBe(360);
    expect(config.victory.monumentHoldSec * config.tickRate).toBe(9_000);
    expect(config.victory.monumentCost).toEqual({ wood: 1000, stone: 1000, gold: 1000 });
    expect(config.victory.monumentRequiresAge).toBe('teikoku');
    expect(config.victory.zeroFrontsIsNotDefeat).toBe(true);
  });

  it('視界更新間隔は 5 tick（手順書 §7.2）', () => {
    expect(config.vision.updateIntervalTicks).toBe(5);
    expect(config.vision.states).toEqual(['unexplored', 'known', 'visible']);
  });
});

describe('config.json — 時代進化（03§2）', () => {
  it('4 時代がこの順で並ぶ', () => {
    expect(ages.map((a) => a.id)).toEqual(['reimei', 'seido', 'tekki', 'teikoku']);
    expect(ages.map((a) => a.slots)).toEqual([1, 2, 3, 4]);
  });

  it('進化コストが 食500 / 食800+金200 / 食1000+金800 と一致', () => {
    const byId = new Map(ages.map((a) => [a.id, a]));
    expect(byId.get('reimei')!.cost).toBeUndefined();
    expect(byId.get('seido')!.cost).toEqual({ food: 500 });
    expect(byId.get('tekki')!.cost).toEqual({ food: 800, gold: 200 });
    expect(byId.get('teikoku')!.cost).toEqual({ food: 1000, gold: 800 });
  });

  it('解読秒数と前時代の建物条件', () => {
    const byId = new Map(ages.map((a) => [a.id, a]));
    expect(byId.get('seido')!.researchSec).toBe(130);
    expect(byId.get('tekki')!.researchSec).toBe(160);
    expect(byId.get('teikoku')!.researchSec).toBe(190);
    for (const id of ['seido', 'tekki', 'teikoku']) {
      expect(byId.get(id)!.requireBuildingsOfPrevAge).toBe(2);
    }
  });
});

describe('config.json — 令の遅延（07§4 / 手順書 §14.2 の検算値）', () => {
  it('基礎パラメータ', () => {
    const o = config.order;
    expect(o.baseDelaySec).toBe(1.5);
    expect(o.perTileSec).toBeCloseTo(0.02, 6);
    expect(o.delayMinSec).toBe(0.5);
    expect(o.delayMaxSec).toBe(8.0);
    expect(o.switchIntervalSec).toBe(6.0);
    expect(o.hayabaMul).toBe(0.7);
    expect(o.fukushoMul).toBe(0.5);
    expect(o.denreiFlatSec).toBe(-1.0);
    expect(o.lowLoyaltyPenaltySec).toBe(2.0);
  });

  it('dist=200 / 伝令あり / 復唱あり → 2.25 秒', () => {
    // (1.5 + 200*0.02 - 1.0) * 0.5 = 2.25
    expect(orderDelaySec({ distTiles: 200, denrei: true, fukusho: true })).toBeCloseTo(2.25, 6);
  });

  it('距離ごとの遅延 1.9 / 3.5 / 5.5 / 8.0 秒', () => {
    expect(orderDelaySec({ distTiles: 20 })).toBeCloseTo(1.9, 6);
    expect(orderDelaySec({ distTiles: 100 })).toBeCloseTo(3.5, 6);
    expect(orderDelaySec({ distTiles: 200 })).toBeCloseTo(5.5, 6);
    expect(orderDelaySec({ distTiles: 325 })).toBeCloseTo(8.0, 6);
    expect(orderDelaySec({ distTiles: 1000 })).toBeCloseTo(8.0, 6); // 上限
  });

  it('checkExample / checkTable が上の実装と一致する（データ自己整合）', () => {
    const ex = config.order.checkExample;
    expect(
      orderDelaySec({ distTiles: ex.distTiles, denrei: ex.denrei, fukusho: ex.fukusho }),
    ).toBeCloseTo(ex.expectedSec, 6);
    for (const row of config.order.checkTable) {
      expect(orderDelaySec({ distTiles: row.distTiles })).toBeCloseTo(row.expectedSec, 6);
    }
  });

  it('モンゴル「駅伝」は距離の項を 0 にする（1.5 秒 / 復唱併用で 0.75 秒）', () => {
    expect(config.order.ekidenDistMul).toBe(0);
    expect(orderDelaySec({ distTiles: 300, ekiden: true })).toBeCloseTo(1.5, 6);
    expect(orderDelaySec({ distTiles: 300, ekiden: true, fukusho: true })).toBeCloseTo(0.75, 6);
  });

  it('忠誠度 < 80% で +2.0 秒（加算・丸め前）', () => {
    // (1.5 + 2.0) * 0.5 + 2.0 = 3.75
    expect(
      orderDelaySec({ distTiles: 100, fukusho: true, lowLoyalty: true }),
    ).toBeCloseTo(3.75, 6);
  });

  it('切り替え間隔は 6.0 秒、早馬で 4.2 秒（06§4 / 手順書 §14.2）', () => {
    expect(config.order.switchIntervalSec * config.order.hayabaMul).toBeCloseTo(4.2, 6);
  });
});

describe('config.json — 相性行列（03§7）', () => {
  /** README の role ID 一覧 */
  const ROLES = [
    'spear',
    'sword',
    'ranged',
    'cavalry',
    'camel',
    'beast',
    'siege',
    'gunpowder',
    'ship',
    'villager',
    'support',
    'building',
  ] as const;

  const matrix = config.counterMatrix as Record<string, Record<string, string>>;

  it('行が README の role 一覧をすべて網羅し、余分な行がない', () => {
    expect(Object.keys(matrix).sort()).toEqual([...ROLES].sort());
  });

  it('値は good / bad のみ、列も role ID のみ（note を混ぜない）', () => {
    for (const [attacker, row] of Object.entries(matrix)) {
      for (const [defender, v] of Object.entries(row)) {
        expect(ROLES, `${attacker} -> ${defender}`).toContain(defender);
        expect(['good', 'bad'], `${attacker} -> ${defender}`).toContain(v);
      }
    }
  });

  it('03§7 の表の全行（8 行）が原文どおり', () => {
    // 攻撃側 role: [強い相手], [弱い相手]
    const doc: Record<string, { good: string[]; bad: string[] }> = {
      spear: { good: ['cavalry', 'beast'], bad: ['ranged', 'siege'] },
      sword: { good: ['spear', 'building'], bad: ['ranged'] },
      ranged: { good: ['spear', 'sword'], bad: ['cavalry', 'siege'] },
      cavalry: { good: ['ranged', 'siege', 'villager'], bad: ['spear', 'camel'] },
      beast: { good: ['spear', 'sword'], bad: ['gunpowder', 'siege'] },
      siege: { good: ['building', 'spear', 'sword'], bad: ['cavalry'] },
      gunpowder: { good: ['sword', 'beast'], bad: ['cavalry'] },
      support: { good: [], bad: [...ROLES] },
    };
    for (const [attacker, exp] of Object.entries(doc)) {
      const row = matrix[attacker];
      expect(row, `行 ${attacker} が存在すること`).toBeDefined();
      const good = Object.entries(row!)
        .filter(([, v]) => v === 'good')
        .map(([k]) => k)
        .sort();
      const bad = Object.entries(row!)
        .filter(([, v]) => v === 'bad')
        .map(([k]) => k)
        .sort();
      expect(good, `${attacker} の有利な相手`).toEqual([...exp.good].sort());
      expect(bad, `${attacker} の不利な相手`).toEqual([...exp.bad].sort());
    }
  });

  it('全行に説明（counterMatrixRowNotes）がある', () => {
    const notes = config.counterMatrixRowNotes as Record<string, string>;
    for (const r of ROLES) expect(typeof notes[r], r).toBe('string');
  });

  it('相性倍率を引くと 1.5 / 0.7 / 1.0 になる', () => {
    const mul = (a: string, d: string): number => {
      const v = matrix[a]?.[d];
      if (v === 'good') return config.combat.counterGood;
      if (v === 'bad') return config.combat.counterBad;
      return config.combat.counterNeutral;
    };
    expect(mul('spear', 'cavalry')).toBe(1.5);
    expect(mul('cavalry', 'spear')).toBe(0.7);
    expect(mul('camel', 'cavalry')).toBe(1.5);
    expect(mul('ship', 'ship')).toBe(1.0);
  });
});

describe('config.json — 試合オプション（07§14）', () => {
  it('7 種そろっている', () => {
    expect(Object.keys(config.matchOptions).sort()).toEqual(
      [
        'truceSeason',
        'startAge',
        'startResources',
        'gameSpeed',
        'frontSlotCap',
        'resourceDepletion',
        'lawsEnabled',
      ].sort(),
    );
  });

  it('休戦の季は既定無効・15 分前後に 60 秒・守り切ると忠誠度 +15%', () => {
    const t = config.matchOptions.truceSeason;
    expect(t.default).toBe(false);
    expect(t.startSec).toBe(900);
    expect(t.durationSec).toBe(60);
    expect(t.blocksNewFronts).toBe(true);
    expect(t.loyaltyBonusOnKept).toBeCloseTo(0.15, 6);
    expect(t.loyaltyBonusOnKept).toBeCloseTo(config.loyalty.truceKept, 6);
  });

  it('既定値が 07§14 の表と一致', () => {
    expect(config.matchOptions.startAge.default).toBe('reimei');
    expect(config.matchOptions.startAge.allowed).toEqual(ages.map((a) => a.id));
    expect(config.matchOptions.startResources.default).toBe('standard');
    expect(config.matchOptions.gameSpeed.default).toBe(1.0);
    expect(config.matchOptions.gameSpeed.min).toBe(0.5);
    expect(config.matchOptions.gameSpeed.max).toBe(1.5);
    expect(config.matchOptions.frontSlotCap.default).toBe(6);
    expect(config.matchOptions.frontSlotCap.min).toBe(2);
    expect(config.matchOptions.frontSlotCap.max).toBe(6);
    expect(config.matchOptions.resourceDepletion.default).toBe(true);
    expect(config.matchOptions.lawsEnabled.default).toBe(true);
  });

  it('開始資源プリセットは 4 資源すべてを持つ', () => {
    for (const preset of Object.values(config.matchOptions.startResources.presets)) {
      expect(Object.keys(preset).sort()).toEqual(['food', 'gold', 'stone', 'wood']);
    }
  });
});

describe('resources.json — 4 資源（03§1）', () => {
  const RESOURCE_IDS = ['food', 'wood', 'stone', 'gold'] as const;

  it('4 種そろっていて余分がない', () => {
    expect(Object.keys(resources).sort()).toEqual([...RESOURCE_IDS].sort());
  });

  it('各資源に 採り方 / 使い道 / 切れると止まるもの / 基礎採集速度 / 埋蔵量がある', () => {
    const r = resources as Record<string, Record<string, unknown>>;
    for (const id of RESOURCE_IDS) {
      const e = r[id]!;
      expect(typeof e['name'], id).toBe('string');
      expect(Array.isArray(e['gatherFrom']), id).toBe(true);
      expect((e['gatherFrom'] as unknown[]).length, id).toBeGreaterThan(0);
      expect(Array.isArray(e['usedFor']), id).toBe(true);
      expect(typeof e['note'], id).toBe('string');
      expect(typeof e['baseGatherRatePerSec'], id).toBe('number');
      expect(typeof e['defaultDeposit'], id).toBe('number');
      expect(e['depletable'], id).toBe(true);
    }
  });

  it('農地 1 面の食料は 400（07§8）で config と一致', () => {
    expect(resources.food.depositsByNode.farm).toBe(400);
    expect(resources.food.depositsByNode.farm).toBe(config.economy.farmYield);
    expect(resources.food.rebuildCostResource).toBe('wood');
    expect(resources.food.rebuildCostRatio).toBe(config.economy.farmRebuildCostRatio);
  });

  it('金の交易・貢納の数値が config と一致（二重管理の検出）', () => {
    expect(resources.gold.tradeGoldPerTile).toBe(config.economy.tradeGoldPerTile);
    expect(resources.gold.tributeFeeRatio).toBe(config.economy.tributeFeeRatio);
  });
});

describe('maps.json — マップ型 8 種（07§13）', () => {
  const MAP_IDS = [
    'inland_sea',
    'plain',
    'river',
    'archipelago',
    'defile',
    'steppe',
    'jungle',
    'monolith_isle',
  ] as const;

  it('README の 8 種と完全一致', () => {
    expect(Object.keys(maps).sort()).toEqual([...MAP_IDS].sort());
    expect(Object.keys(maps)).toHaveLength(8);
  });

  it('各型に表示名・水域比率・森密度・丘・川・隘路・note がある', () => {
    const m = maps as Record<string, Record<string, unknown>>;
    for (const id of MAP_IDS) {
      const e = m[id]!;
      expect(typeof e['name'], id).toBe('string');
      expect(typeof e['waterRatio'], id).toBe('number');
      expect(e['waterRatio'] as number, id).toBeGreaterThanOrEqual(0);
      expect(e['waterRatio'] as number, id).toBeLessThanOrEqual(1);
      expect(typeof e['forestDensityRatio'], id).toBe('number');
      expect(typeof e['hillAmountRatio'], id).toBe('number');
      expect(typeof e['riverCount'], id).toBe('number');
      expect(typeof e['hasDefile'], id).toBe('boolean');
      expect(typeof e['note'], id).toBe('string');
    }
  });

  it('サイズ規則: 2 人 200 / 8 人 400 / 人数で線形補間（07§13）', () => {
    const m = maps as Record<string, { sizeByPlayers: Record<string, number> }>;
    for (const id of MAP_IDS) {
      const t = m[id]!.sizeByPlayers;
      expect(Object.keys(t).sort(), id).toEqual(['2', '3', '4', '5', '6', '7', '8']);
      expect(t['2'], id).toBe(200);
      expect(t['8'], id).toBe(400);
      for (let p = 2; p <= 8; p++) {
        expect(t[String(p)], `${id} ${p}人`).toBe(Math.round(200 + ((p - 2) * (400 - 200)) / 6));
      }
    }
  });

  it('列島は水域が過半・草原と隘路は水域なし・河川は川がある', () => {
    expect(maps.archipelago.waterRatio).toBeGreaterThan(0.5);
    expect(maps.steppe.waterRatio).toBe(0);
    expect(maps.defile.waterRatio).toBe(0);
    expect(maps.defile.hasDefile).toBe(true);
    expect(maps.river.riverCount).toBeGreaterThan(0);
  });

  it('碑の島は島内交戦が掟一違反になるフラグを持つ', () => {
    expect(maps.monolith_isle.islandCombatBreaksLawOne).toBe(true);
    expect(maps.monolith_isle.islandZone.shape).toBe('circle');
    expect(config.loyalty.lawPenalties.monolithIsleEngage).toBeCloseTo(-0.25, 6);
  });

  it('戦域の想定本数はスロット上限を超えない', () => {
    const m = maps as Record<string, { expectedFrontsMin: number; expectedFrontsMax: number }>;
    for (const id of MAP_IDS) {
      expect(m[id]!.expectedFrontsMax, id).toBeLessThanOrEqual(config.slotBonus.hardMax);
      expect(m[id]!.expectedFrontsMin, id).toBeLessThanOrEqual(m[id]!.expectedFrontsMax);
    }
  });
});

describe('ai.json — 5 段階（07§11）', () => {
  const LEVEL_IDS = ['shirouto', 'minarai', 'shokou', 'shougun', 'soudaishou'] as const;

  it('5 段階そろっている', () => {
    expect(Object.keys(ai).sort()).toEqual([...LEVEL_IDS].sort());
    expect(Object.keys(ai)).toHaveLength(5);
  });

  it('表示名と判断間隔が 07§11 の表と一致（8/6/4/2/1 秒）', () => {
    const a = ai as Record<string, { level: number; name: string; decisionIntervalSec: number }>;
    const expected: Array<[string, number, string, number]> = [
      ['shirouto', 1, '素人', 8],
      ['minarai', 2, '見習い', 6],
      ['shokou', 3, '諸侯', 4],
      ['shougun', 4, '将軍', 2],
      ['soudaishou', 5, '総大将', 1],
    ];
    for (const [id, level, name, sec] of expected) {
      expect(a[id]!.level, id).toBe(level);
      expect(a[id]!.name, id).toBe(name);
      expect(a[id]!.decisionIntervalSec, id).toBe(sec);
    }
  });

  it('使える令の数・戦域数が段階順に増える', () => {
    const a = ai as Record<string, { usableOrderCount: number; maxFronts: number; usableOrders: string[] }>;
    for (let i = 1; i < LEVEL_IDS.length; i++) {
      const prev = a[LEVEL_IDS[i - 1]!]!;
      const cur = a[LEVEL_IDS[i]!]!;
      expect(cur.usableOrderCount, LEVEL_IDS[i]).toBeGreaterThanOrEqual(prev.usableOrderCount);
      expect(cur.maxFronts, LEVEL_IDS[i]).toBeGreaterThanOrEqual(prev.maxFronts);
    }
    expect(a['shirouto']!.maxFronts).toBe(0); // 内政のみ
    expect(a['minarai']!.usableOrders).toEqual(['charge', 'hold']); // 突撃と死守だけ
    expect(a['shokou']!.usableOrderCount).toBe(4);
    expect(a['shougun']!.maxFronts).toBe(config.slotBonus.hardMax); // 上限まで
    expect(a['soudaishou']!.usableOrderCount).toBe(14); // 基本 6 + 固有 8
    for (const id of LEVEL_IDS) {
      expect(a[id]!.usableOrders.length, id).toBe(a[id]!.usableOrderCount);
    }
  });

  it('二重旗・固有令・攻城・囮の可否が 07§11 と一致', () => {
    const a = ai as Record<
      string,
      { allowDoubleFlag: boolean; allowUniqueOrders: boolean; allowSiege: boolean; allowDecoy: boolean }
    >;
    // 囮は 将軍 から
    expect(a['shokou']!.allowDecoy).toBe(false);
    expect(a['shougun']!.allowDecoy).toBe(true);
    expect(a['soudaishou']!.allowDecoy).toBe(true);
    // 固有令・二重旗・攻城は 総大将 のみ
    for (const id of ['shirouto', 'minarai', 'shokou', 'shougun'] as const) {
      expect(a[id]!.allowDoubleFlag, id).toBe(false);
      expect(a[id]!.allowUniqueOrders, id).toBe(false);
      expect(a[id]!.allowSiege, id).toBe(false);
    }
    expect(a['soudaishou']!.allowDoubleFlag).toBe(true);
    expect(a['soudaishou']!.allowUniqueOrders).toBe(true);
    expect(a['soudaishou']!.allowSiege).toBe(true);
  });

  it('ズル（視界透視・資源増量）のフラグが存在しない。全段階でプレイヤーと同条件', () => {
    const forbidden = /(cheat|vision|reveal|fog|resourceBonus|resourceMul|gatherMul|freeResource|omniscien|xray|seeAll|bonusResource|handicap)/i;
    const a = ai as Record<string, Record<string, unknown>>;
    for (const id of LEVEL_IDS) {
      for (const key of Object.keys(a[id]!)) {
        expect(forbidden.test(key), `${id}.${key} はズルのフラグに見える`).toBe(false);
      }
      expect(a[id]!['respectsOrderDelay'], id).toBe(true);
      expect(a[id]!['respectsSwitchInterval'], id).toBe(true);
    }
  });
});
