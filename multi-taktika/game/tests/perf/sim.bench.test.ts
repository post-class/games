/**
 * tests/perf/sim.bench.test.ts — シムの負荷計測（T-M18-03）
 *
 * 完了条件（親からの指定）: **8 人 × 1,200 体で 1 tick 4ms 以内**
 * 手順書の元の完了条件: 「45,000 tick を実時間の 1/20 以下で空回しできる」
 *  → 45,000 tick / (1800 秒 / 20) = 90 秒 = **2.0 ms/tick**。両方を測って出す。
 *
 * ■ 測定条件（毎回同じ盤面を作る。乱数を使わない）
 *  - `createMatch` の 8 人戦（マップは人数から決まる 400×400）
 *  - そこへ **戦闘ユニットを敷き詰めて合計 1,200 体**にする。
 *    配置は固定の格子（`spawnEntity` を index 昇順で呼ぶだけ）で、乱数を使わない。
 *  - 8 人の陣を **互いに噛み合う位置**に置く。ユニットが遠くに散っていると
 *    `combat` と `queryCircle` がほとんど空振りして「速い」という嘘の数字が出る。
 *  - `AiPlayer` は動かさない（測るのは `stepWorld` そのもの）。
 *
 * ■ 計測は `performance.now`
 *  sim の中では禁止（手順書 §0.3）だが、**テストから外側で測るのは可**。
 *  World の状態には一切入らないので決定論に影響しない。
 *
 * ■ `vitest.config.ts` の `fileParallelism: false` に依存している
 *  並列だと CPU を奪い合って同じコードが 100 倍遅く見える。**設定を変えない。**
 *
 * ■ 内訳（4ms を超えたときにどこを直すかを出すため）
 *  `stepWorld` は 14 システムを固定順で呼ぶだけなので、テスト側で
 *  **同じ順序で 1 つずつ呼んで**時間を測れば内訳が出る（sim を書き換えなくてよい）。
 *  内訳の測定は合計値の測定とは別のループで行う（計測コード自身の分を混ぜないため）。
 */

import { describe, expect, it } from 'vitest';
import { CIV_IDS, EntityKind, type PlayerId } from '@/shared/types';
import { MATCH_LENGTH_TICKS, TICK_RATE } from '@/sim/core/config';
import { UNIT_DEFS, type UnitDef } from '@/sim/core/defs';
import { spawnEntity } from '@/sim/core/entity';
import { fx, fxFromInt } from '@/sim/core/fx';
import { rebuildGrid } from '@/sim/core/grid';
import { refreshPopulation } from '@/sim/core/population';
import type { World } from '@/sim/core/world';
import { stepWorld } from '@/sim/index';
import { createMatch } from '@/sim/setup';
import { applyCommands } from '@/sim/command';
import { orderDelivery } from '@/sim/systems/orderDelivery';
import { frontLifecycle } from '@/sim/systems/frontLifecycle';
import { frontEnrollment } from '@/sim/systems/frontEnrollment';
import { unitDecision } from '@/sim/systems/unitDecision';
import { movement } from '@/sim/systems/movement';
import { combat } from '@/sim/systems/combat';
import { morale } from '@/sim/systems/morale';
import { economy } from '@/sim/systems/economy';
import { construction } from '@/sim/systems/construction';
import { production } from '@/sim/systems/production';
import { loyalty } from '@/sim/systems/loyalty';
import { victory } from '@/sim/systems/victory';
import { cleanup } from '@/sim/systems/cleanup';

// ---------------------------------------------------------------- 測定条件

/** 完了条件の人数。 */
const PLAYERS = 8;

/** 完了条件の総エンティティ数（村人・建物を含めた盤上の全数）。 */
const TARGET_ENTITIES = 1200;

/** 1 tick の予算（ms）。 */
const BUDGET_MS = 4;

/** 予熱に捨てる tick 数（JIT が温まる前の値を混ぜない）。 */
const WARMUP_TICKS = 300;

/** 本計測の tick 数。 */
const MEASURE_TICKS = 1000;

/** 内訳計測の tick 数（14 システム × 計測なので短くする）。 */
const BREAKDOWN_TICKS = 300;

/** ユニットを並べる格子の 1 辺の間隔（マス）。詰めすぎると重なり回避だけが重くなる。 */
const GRID_STEP_TILES = 2;

// ---------------------------------------------------------------- 盤面づくり

/**
 * 8 人 × 合計 `TARGET_ENTITIES` 体の World を作る。
 *
 * 各プレイヤーの陣を、マップ中央を囲む輪の上に置いて**互いの射程に届く**ようにする。
 * 位置は tile 座標の固定式（乱数なし）。`spawnEntity` は index 昇順に呼ぶ。
 */
function makeCrowdedWorld(): { world: World; units: number } {
  const { world } = createMatch({
    seed: 20260810,
    playerCount: PLAYERS,
    civs: CIV_IDS.slice(0, PLAYERS),
    // 容量に余裕を持たせる（1,200 体 + 資源ノード + 建物 + 投射物）。
    entityCapacity: 8192,
  });

  // 既に盤上にいる分（村人・町の中心・資源ノード）を数えて、残りを兵で埋める。
  const already = world.entities.count;
  const toSpawn = TARGET_ENTITIES - already;
  const perPlayer = toSpawn > 0 ? Math.floor(toSpawn / PLAYERS) : 0;

  const cx = Math.floor(world.map.widthTiles / 2);
  const cy = Math.floor(world.map.heightTiles / 2);
  // 中央を囲む輪の半径。8 人の陣が互いに届く距離に置く。
  const ring = Math.floor(world.map.widthTiles / 8);

  let spawned = 0;
  for (let p = 0; p < PLAYERS; p++) {
    // 黎明の世の共通兵（`03§4`）。文明ごとの兵は青銅以降なので、
    // 8 人ぶん同じ共通兵を並べる（測るのは体数の負荷であって文明差ではない）。
    const def = REIMEI_MELEE;

    // 陣の中心（8 方向。sin/cos を使わない固定表で角を作る）。
    const dir = OCTANT[p]!;
    const bx = cx + Math.round(ring * dir[0]!);
    const by = cy + Math.round(ring * dir[1]!);

    const side = Math.ceil(Math.sqrt(perPlayer));
    for (let k = 0; k < perPlayer; k++) {
      const ox = (k % side) * GRID_STEP_TILES - (side * GRID_STEP_TILES) / 2;
      const oy = Math.floor(k / side) * GRID_STEP_TILES - (side * GRID_STEP_TILES) / 2;
      const x = bx + ox;
      const y = by + oy;
      if (x < 1 || y < 1 || x >= world.map.widthTiles - 1 || y >= world.map.heightTiles - 1) {
        continue;
      }
      spawnEntity(world.entities, {
        kind: EntityKind.Unit,
        owner: p as PlayerId,
        typeId: def.index,
        x: fxFromInt(x) + fx(0.5),
        y: fxFromInt(y) + fx(0.5),
        hpMax: def.hp,
      });
      spawned += 1;
    }
  }
  // 人口を数え直す（生産・上限の判定が現実の値になるように）。
  refreshPopulation(world);
  return { world, units: spawned };
}

/**
 * 黎明の世の共通近接兵（`03§4`）。**ID を書かずにデータから引く**
 * （`units.json` の並びが変わっても壊れないように、時代 0・近接・全文明共通で選ぶ）。
 */
const REIMEI_MELEE: UnitDef = (() => {
  for (let i = 0; i < UNIT_DEFS.length; i++) {
    const u = UNIT_DEFS[i]!;
    if (u.age !== 0 || u.civ !== null) continue;
    if (u.atk <= 0) continue; // 村人・支援は除く
    return u;
  }
  throw new Error('perf: 黎明の世の共通近接兵が units.json に無い');
})();

/** 8 方向の単位ベクトル（固定表。三角関数も乱数も使わない）。 */
const OCTANT: readonly (readonly [number, number])[] = [
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
  [0, -1],
  [1, -1],
];

/** `stepWorld` と同じ順序（`sim/index.ts` §4.6）。名前は内訳表の見出しになる。 */
const SYSTEMS: readonly (readonly [string, (w: World) => void])[] = [
  ['01 applyCommands', (w) => applyCommands(w, [])],
  ['02 orderDelivery', orderDelivery],
  ['03 frontLifecycle', frontLifecycle],
  ['04 frontEnrollment', frontEnrollment],
  ['05 unitDecision', unitDecision],
  ['06 movement', movement],
  ['07 combat', combat],
  ['08 morale', morale],
  ['09 economy', economy],
  ['10 construction', construction],
  ['11 production', production],
  ['12 loyalty', loyalty],
  ['13 victory', victory],
  ['14 cleanup', cleanup],
];

// ---------------------------------------------------------------- テスト

describe('シムの負荷（T-M18-03）', () => {
  it(`8 人 × ${TARGET_ENTITIES} 体で 1 tick ${BUDGET_MS}ms 以内`, () => {
    const { world, units } = makeCrowdedWorld();
    expect(world.playerCount).toBe(PLAYERS);
    // 盤上に狙った数のエンティティが載っていること（数字を誤魔化さないための確認）。
    expect(world.entities.count).toBeGreaterThanOrEqual(TARGET_ENTITIES - PLAYERS);

    // ---- 予熱 ----
    for (let t = 0; t < WARMUP_TICKS; t++) stepWorld(world, []);

    // ---- 合計（本物の `stepWorld` で測る）----
    const t0 = performance.now();
    for (let t = 0; t < MEASURE_TICKS; t++) stepWorld(world, []);
    const totalMs = performance.now() - t0;
    const msPerTick = totalMs / MEASURE_TICKS;

    // ---- 内訳（同じ順序で 1 つずつ呼ぶ）----
    const acc = new Float64Array(SYSTEMS.length);
    let gridMs = 0;
    for (let t = 0; t < BREAKDOWN_TICKS; t++) {
      const g0 = performance.now();
      rebuildGrid(world.grid, world.entities, world.tick);
      gridMs += performance.now() - g0;
      for (let s = 0; s < SYSTEMS.length; s++) {
        const s0 = performance.now();
        SYSTEMS[s]![1](world);
        acc[s] = acc[s]! + (performance.now() - s0);
      }
      world.tick += 1;
    }

    const lines: string[] = [];
    lines.push(
      `[T-M18-03] ${PLAYERS} 人 / エンティティ ${world.entities.count} 体（うち追加した兵 ${units} 体）/ ` +
        `${MEASURE_TICKS} tick 計測（予熱 ${WARMUP_TICKS}）`
    );
    lines.push(
      `  合計: ${totalMs.toFixed(0)}ms → ${msPerTick.toFixed(3)} ms/tick（予算 ${BUDGET_MS}ms）`
    );
    lines.push(
      `  参考: 45,000 tick 空回し ≈ ${((msPerTick * MATCH_LENGTH_TICKS) / 1000).toFixed(1)} 秒 ` +
        `（実時間 ${MATCH_LENGTH_TICKS / TICK_RATE} 秒の 1/${(
          MATCH_LENGTH_TICKS / TICK_RATE / ((msPerTick * MATCH_LENGTH_TICKS) / 1000)
        ).toFixed(1)}。手順書の完了条件は 1/20 以下）`
    );
    lines.push(`  --- 内訳（${BREAKDOWN_TICKS} tick の平均、ms/tick）---`);
    let sum = gridMs / BREAKDOWN_TICKS;
    lines.push(`  00 rebuildGrid   ${(gridMs / BREAKDOWN_TICKS).toFixed(4)}`);
    for (let s = 0; s < SYSTEMS.length; s++) {
      const per = acc[s]! / BREAKDOWN_TICKS;
      sum += per;
      lines.push(`  ${SYSTEMS[s]![0]!.padEnd(18)} ${per.toFixed(4)}`);
    }
    lines.push(`  内訳の合計       ${sum.toFixed(4)} ms/tick`);
    console.log(lines.join('\n'));

    expect(
      msPerTick,
      `1 tick ${msPerTick.toFixed(3)}ms が予算 ${BUDGET_MS}ms を超えた。` +
        '上のログの内訳を見て、重いシステムを docs/BALANCE.md に記録すること'
    ).toBeLessThan(BUDGET_MS);
  }, 600000);

  it('手順書の完了条件: 45,000 tick を実時間の 1/20 以下で空回しできる', () => {
    // こちらは 2 人戦（`07§14` の標準的な試合）で測る。
    const { world } = createMatch({
      seed: 20260810,
      playerCount: 2,
      civs: [CIV_IDS[0]!, CIV_IDS[7]!],
    });
    for (let t = 0; t < WARMUP_TICKS; t++) stepWorld(world, []);
    const t0 = performance.now();
    for (let t = 0; t < MEASURE_TICKS; t++) stepWorld(world, []);
    const msPerTick = (performance.now() - t0) / MEASURE_TICKS;
    const fullSec = (msPerTick * MATCH_LENGTH_TICKS) / 1000;
    const realSec = MATCH_LENGTH_TICKS / TICK_RATE;
    console.log(
      `[T-M18-03] 2 人戦: ${msPerTick.toFixed(4)} ms/tick → 45,000 tick ${fullSec.toFixed(1)} 秒 ` +
        `= 実時間の 1/${(realSec / fullSec).toFixed(0)}`
    );
    expect(fullSec * 20).toBeLessThan(realSec);
  }, 600000);
});
