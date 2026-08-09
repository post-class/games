/**
 * T-M11-02, T-M11-07: 掟の判定と試合オプション（`02` 戦の作法 / `07§10` / `07§14`）
 *
 * ここでは `core/law.ts` の**純関数と設定アクセサ**だけを検算する。
 * 忠誠度が実際に動くことは `loyalty.test.ts`、決着は `victory.test.ts` で見る。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { EntityKind } from '@/shared/types';
import config from '@/data/config.json' with { type: 'json' };
import { TICK_RATE } from '@/sim/core/config';
import { buildingDefById, unitDefById } from '@/sim/core/defs';
import { entityIndex, spawnEntity } from '@/sim/core/entity';
import { FX_ONE, fx, fxFromInt } from '@/sim/core/fx';
import { rebuildGrid } from '@/sim/core/grid';
import {
  LAW_FLEEING_VILLAGER,
  LAW_MONOLITH_ISLE,
  LAW_SEED_STORE,
  LAW_WELL,
  addLoyalty,
  blameLastDamager,
  buildingLawViolation,
  buildingRevealsToAll,
  configureMatchRules,
  frontSlotCap,
  gameSpeedOption,
  isCityBuilding,
  isDefeatCriticalBuilding,
  isInLawOneZone,
  isMonumentBuilding,
  isTruceActive,
  lawPenalty,
  lawZoneCount,
  lawsEnabled,
  loyaltyRegenPeriodTicks,
  resetMatchRules,
  resourceDepletionOption,
  startAgeOption,
  startResourcesOption,
  truceDurationTicks,
  truceEndTick,
  truceSeasonEnabled,
  truceStartTick,
} from '@/sim/core/law';
import { resourceDepletionEnabled } from '@/sim/core/gather';
import { createWorld, type World } from '@/sim/core/world';

const MAP = 100;

function makeWorld(playerCount = 2): World {
  return createWorld({
    seed: 11,
    playerCount,
    mapWidthTiles: MAP,
    mapHeightTiles: MAP,
    entityCapacity: 256,
  });
}

afterEach(() => {
  resetMatchRules();
});

// ---------------------------------------------------------------------------
// 掟の罰（各 -25%）
// ---------------------------------------------------------------------------

describe('T-M11-02: 掟の罰は 4 種すべて -25%', () => {
  it('掟一・二・三・五の罰が config どおり（-25%）', () => {
    for (const law of [LAW_MONOLITH_ISLE, LAW_WELL, LAW_SEED_STORE, LAW_FLEEING_VILLAGER]) {
      expect(lawPenalty(law)).toBe(fx(-0.25));
    }
  });

  it('掟四（休戦の季）は罰が無く、既定の -25%（breakLaw）に落ちる', () => {
    // `loyalty.lawPenaltyKeyByLawId` に law4 を載せていないことの確認。
    expect(Object.keys(config.loyalty.lawPenaltyKeyByLawId)).not.toContain('law4');
  });

  it('井戸 = 掟二 / 種籾蔵 = 掟三（buildings.json の lawViolationOnDestroy）', () => {
    expect(buildingLawViolation(buildingDefById('well').index)).toBe(LAW_WELL);
    expect(buildingLawViolation(buildingDefById('seed_store').index)).toBe(LAW_SEED_STORE);
    // 普通の建物を壊しても掟破りにはならない。
    expect(buildingLawViolation(buildingDefById('house').index)).toBeNull();
  });

  it('記念碑だけが位置を隠せない（revealToAll）', () => {
    const mon = buildingDefById('monument').index;
    expect(buildingRevealsToAll(mon)).toBe(true);
    expect(isMonumentBuilding(mon)).toBe(true);
    expect(buildingRevealsToAll(buildingDefById('castle').index)).toBe(false);
  });

  it('町の中心は失うと敗北する建物 / 城・町の中心・大天幕が「城」扱い', () => {
    expect(isDefeatCriticalBuilding(buildingDefById('town_center').index)).toBe(true);
    expect(isDefeatCriticalBuilding(buildingDefById('castle').index)).toBe(false);
    for (const id of ['town_center', 'castle', 'great_tent']) {
      expect(isCityBuilding(buildingDefById(id).index), id).toBe(true);
    }
    expect(isCityBuilding(buildingDefById('house').index)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 掟一の領域（碑の島）
// ---------------------------------------------------------------------------

describe('T-M11-02: 掟一の領域は円で判定される', () => {
  it('領域が無いマップでは常に false', () => {
    const w = makeWorld();
    expect(lawZoneCount(w.map)).toBe(0);
    expect(isInLawOneZone(w.map, fxFromInt(50), fxFromInt(50))).toBe(false);
  });

  it('中心 (50,50) 半径 10 の島の内外を判定する', () => {
    const w = makeWorld();
    w.map.lawZones = new Int32Array([fxFromInt(50), fxFromInt(50), fxFromInt(10), 1]);
    expect(lawZoneCount(w.map)).toBe(1);
    expect(isInLawOneZone(w.map, fxFromInt(50), fxFromInt(50))).toBe(true);
    expect(isInLawOneZone(w.map, fxFromInt(59), fxFromInt(50))).toBe(true);
    expect(isInLawOneZone(w.map, fxFromInt(61), fxFromInt(50))).toBe(false);
  });

  it('掟番号が 1 でない領域は掟一として扱わない', () => {
    const w = makeWorld();
    w.map.lawZones = new Int32Array([fxFromInt(50), fxFromInt(50), fxFromInt(10), 0]);
    expect(isInLawOneZone(w.map, fxFromInt(50), fxFromInt(50))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 犯人の特定（事実で決める。近傍推定は使わない）
// ---------------------------------------------------------------------------

describe('T-M11-02: 掟破りの犯人は「最後に実際に殴った者」で決まる', () => {
  /** 被害者を 1 体置いて index を返す（p0 の所有物）。 */
  function putVictim(w: ReturnType<typeof makeWorld>): number {
    const def = unitDefById('villager');
    return entityIndex(
      spawnEntity(w.entities, {
        kind: EntityKind.Unit,
        owner: 0,
        typeId: def.index,
        x: fxFromInt(50),
        y: fxFromInt(50),
        hpMax: def.hp,
      }),
    );
  }

  it('記録があればその者が犯人', () => {
    const w = makeWorld();
    const v = putVictim(w);
    w.entities.lastDamagedBy[v] = 1;
    w.entities.lastDamagedTick[v] = w.tick;
    expect(blameLastDamager(w, v)).toBe(1);
  });

  it('**近くにいるだけの無関係なプレイヤーは罰されない**（近傍推定の誤りの再発防止）', () => {
    // これが `lastDamagedBy` を導入した理由。以前は「周囲でいちばん近い敵の攻撃者」を
    // 犯人にしていたため、通りすがりの第三者が井戸を割った罪を負っていた。
    // 3 人対戦にして「隣にいる p1」と「実際に殴った p2」を分ける。
    const w = makeWorld(3);
    const v = putVictim(w);
    const clubman = unitDefById('clubman');
    // p1 の兵をすぐ隣に置く（近傍推定ならこれが犯人にされていた）
    spawnEntity(w.entities, {
      kind: EntityKind.Unit,
      owner: 1,
      typeId: clubman.index,
      x: fxFromInt(51),
      y: fxFromInt(50),
      hpMax: clubman.hp,
    });
    rebuildGrid(w.grid, w.entities, w.tick);
    // 実際に殴ったのは p2（遠くにいる。投石や矢でもよい）
    w.entities.lastDamagedBy[v] = 2;
    w.entities.lastDamagedTick[v] = w.tick;
    expect(blameLastDamager(w, v)).toBe(2);
  });

  it('記録が無ければ誰も罰されない（自壊・スクリプトによる消滅）', () => {
    const w = makeWorld();
    const v = putVictim(w);
    // 近くに敵を置いても、殴られた記録が無いなら犯人はいない
    const clubman = unitDefById('clubman');
    spawnEntity(w.entities, {
      kind: EntityKind.Unit,
      owner: 1,
      typeId: clubman.index,
      x: fxFromInt(51),
      y: fxFromInt(50),
      hpMax: clubman.hp,
    });
    rebuildGrid(w.grid, w.entities, w.tick);
    expect(blameLastDamager(w, v)).toBe(-1);
  });

  it('参加していないプレイヤー番号は犯人にしない', () => {
    const w = makeWorld(); // 2 人対戦
    const v = putVictim(w);
    w.entities.lastDamagedBy[v] = 7; // 存在しないプレイヤー
    w.entities.lastDamagedTick[v] = w.tick;
    expect(blameLastDamager(w, v)).toBe(-1);
  });

  it('自分で壊した場合は自分が罰される（友軍被害も記録するため）', () => {
    // 自分の投石で自分の井戸を割ったら、掟を破ったのは自分。
    const w = makeWorld();
    const v = putVictim(w);
    w.entities.lastDamagedBy[v] = 0;
    w.entities.lastDamagedTick[v] = w.tick;
    expect(blameLastDamager(w, v)).toBe(0);
  });
});

describe('T-M11-01: 忠誠度は 0..1 でクランプされる', () => {
  it('上限 100% を超えない / 下限 0% を割らない', () => {
    const w = makeWorld();
    expect(w.players[0]!.loyalty).toBe(FX_ONE);
    addLoyalty(w, 0, fx(0.5));
    expect(w.players[0]!.loyalty).toBe(FX_ONE);
    addLoyalty(w, 0, fx(-2));
    expect(w.players[0]!.loyalty).toBe(0);
    addLoyalty(w, 0, fx(-1));
    expect(w.players[0]!.loyalty).toBe(0);
  });

  it('戻り値は実際に動いた量', () => {
    const w = makeWorld();
    expect(addLoyalty(w, 0, fx(-0.25))).toBe(fx(-0.25));
    // 上限に張り付いているときは 0。
    addLoyalty(w, 0, fx(1));
    expect(addLoyalty(w, 0, fx(0.25))).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// T-M11-07 試合オプション 7 種
// ---------------------------------------------------------------------------

describe('T-M11-07: 試合オプション 7 種が config の既定値で読める', () => {
  it('1. 休戦の季（既定 無効 / 15 分前後に 60 秒）', () => {
    expect(truceSeasonEnabled()).toBe(config.matchOptions.truceSeason.default);
    expect(truceSeasonEnabled()).toBe(false);
    expect(truceStartTick()).toBe(900 * TICK_RATE);
    expect(truceDurationTicks()).toBe(60 * TICK_RATE);
    expect(truceEndTick()).toBe(960 * TICK_RATE);
  });

  it('2. 開始時代（既定 黎明の世）', () => {
    expect(startAgeOption()).toBe('reimei');
  });

  it('3. 開始資源（既定 標準）', () => {
    expect(startResourcesOption()).toBe('standard');
  });

  it('4. ゲーム速度（既定 1.0 / 0.5〜1.5 でクランプ）', () => {
    expect(gameSpeedOption()).toBe(1.0);
    configureMatchRules({ gameSpeed: 5 });
    expect(gameSpeedOption()).toBe(1.5);
    configureMatchRules({ gameSpeed: 0.1 });
    expect(gameSpeedOption()).toBe(0.5);
  });

  it('5. 戦域スロット上限（既定 6 / 2〜6 でクランプ）', () => {
    expect(frontSlotCap()).toBe(6);
    configureMatchRules({ frontSlotCap: 3 });
    expect(frontSlotCap()).toBe(3);
    configureMatchRules({ frontSlotCap: 99 });
    expect(frontSlotCap()).toBe(6);
    configureMatchRules({ frontSlotCap: 0 });
    expect(frontSlotCap()).toBe(2);
  });

  it('6. 資源の枯渇（既定 有効。OFF にすると economy が無限資源で回る）', () => {
    expect(resourceDepletionOption()).toBe(true);
    // `economy` が読むのは `core/gather.ts` 側。既定値が一致していること。
    expect(resourceDepletionEnabled()).toBe(resourceDepletionOption());
    configureMatchRules({ resourceDepletion: false });
    expect(resourceDepletionOption()).toBe(false);
  });

  it('7. 掟の適用（既定 有効 / OFF にできる）', () => {
    expect(lawsEnabled()).toBe(true);
    configureMatchRules({ lawsEnabled: false });
    expect(lawsEnabled()).toBe(false);
  });

  it('休戦の季は有効にすると指定の窓だけ true になる', () => {
    const w = makeWorld();
    configureMatchRules({ truceSeason: true, truceStartSec: 10, truceDurationSec: 4 });
    w.tick = 10 * TICK_RATE - 1;
    expect(isTruceActive(w)).toBe(false);
    w.tick = 10 * TICK_RATE;
    expect(isTruceActive(w)).toBe(true);
    w.tick = 14 * TICK_RATE - 1;
    expect(isTruceActive(w)).toBe(true);
    w.tick = 14 * TICK_RATE;
    expect(isTruceActive(w)).toBe(false);
  });

  it('休戦の季が無効なら常に false', () => {
    const w = makeWorld();
    w.tick = 900 * TICK_RATE + 10;
    expect(isTruceActive(w)).toBe(false);
  });

  it('自然回復の周期は 30 秒（config.loyalty.regenPeriodSec）', () => {
    expect(loyaltyRegenPeriodTicks()).toBe(30 * TICK_RATE);
    expect(config.loyalty.regenPeriodSec).toBe(30);
  });
});

// 未使用 import を作らないための参照（型のためだけに読んでいるもの）。
void EntityKind;
