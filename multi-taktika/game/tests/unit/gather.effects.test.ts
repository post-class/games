/**
 * 採集倍率が**実際に結線されているか**の検算。
 *
 * ■ なぜこのテストが必要になったか
 * `core/gather.ts` には長いあいだ `researchGatherMulFx` / `civGatherMulFx` という
 * **1.0 を返すだけのスタブ**が置かれ、「M6 で中身を差し替える」と書かれていた。
 * M6 で適用エンジン（`core/effects.ts`）を作ったとき、**差し替えを忘れた**。
 * 既定値を返すスタブは忘れても何も壊れないので、1900 本のテストが全部緑のまま
 * 「ヤマトの農地 +15%」「地下水路の +15%」「採集の研究」が**すべて死んでいた**。
 *
 * 気付いたきっかけは文明バランスの実測で、ヤマト・唐・ヴァイキング・マリ・モンゴルの
 * 30 分後の数値（人口 32.4 / 建物 19.0 / 資源計 1598.6）が**小数点まで一致**したこと。
 *
 * ■ だから何を検算するか
 * 「倍率の計算が正しいか」ではなく **「効果が採集速度に届くか」**。
 * 値そのものは `civs.json` を触れば変わるので、
 * **効果を持つ文明と持たない文明を比べて差が出ること**を見る。
 */

import { describe, expect, it } from 'vitest';
import { createMatch } from '@/sim';
import { GATHER_FROM_IDS } from '@/sim/core/effects';
import {
  RESOURCE_NODE_DEFS,
  effectiveGatherRatePerSecFx,
  gatherMulFx,
  resourceNodeIndex,
} from '@/sim/core/gather';
import { FX_ONE } from '@/sim/core/fx';
import type { CivId } from '@/shared/types';

/** 文明 1 つで試合を作り、席 0 の倍率を引く。 */
function mulOf(civ: CivId, nodeId: string): number {
  const { world } = createMatch({ seed: 1, playerCount: 2, civs: [civ, 'mongol'] });
  return gatherMulFx(world, 0, resourceNodeIndex(nodeId));
}

describe('採集倍率の結線（文明・研究・建物 → 採集速度）', () => {
  it('ヤマトの「農地の食料 +15%」が農地の倍率に届く', () => {
    // `civs.json` の値を直接読まない（値が変わってもテストが意味を保つように）。
    // 「効果を持たない文明より速い」ことだけを見る。
    expect(mulOf('yamato', 'farm')).toBeGreaterThan(mulOf('mongol', 'farm'));
  });

  it('ヤマトの農地ボーナスは**農地だけ**に効く（森には効かない）', () => {
    expect(mulOf('yamato', 'forest')).toBe(mulOf('mongol', 'forest'));
  });

  it('効果を持たない文明の倍率はちょうど 1.0（余計な倍率が混ざっていない）', () => {
    expect(mulOf('mongol', 'forest')).toBe(FX_ONE);
    expect(mulOf('mongol', 'farm')).toBe(FX_ONE);
  });

  it('倍率が採集速度に反映される（`effectiveGatherRatePerSecFx` を通しても差が残る）', () => {
    const node = resourceNodeIndex('farm');
    const fast = effectiveGatherRatePerSecFx(node, 0, mulOf('yamato', 'farm'));
    const base = effectiveGatherRatePerSecFx(node, 0, mulOf('mongol', 'farm'));
    expect(fast).toBeGreaterThan(base);
  });

  it('すべての資源ノードが採集元（GatherFrom）に対応づいている', () => {
    // 対応表に漏れがあると `gatherMulFx` が落ちる。ノードが増えたらここで気付く。
    for (const def of RESOURCE_NODE_DEFS) {
      expect(() => mulOf('mongol', def.id), `ノード ${def.id} の採集元が未対応`).not.toThrow();
    }
  });

  it('資源ノードの数だけ採集元が使われている（`herd` / `mine` の読み替えの検算）', () => {
    // `resources.json` は羊を `sheep`・石切場を `stone_quarry` と書くが、
    // 効果側は `herd` / `mine` と書く。読み替えを間違えると
    // 「効果が別のノードに効く」ので、名前が一致しないことを明示的に残す。
    const nodeIds = RESOURCE_NODE_DEFS.map((d) => d.id);
    expect(nodeIds).toContain('sheep');
    expect(GATHER_FROM_IDS as readonly string[]).not.toContain('sheep');
    expect(GATHER_FROM_IDS as readonly string[]).toContain('herd');
  });

  it('スタブ（常に 1.0 を返す関数）が復活していない', () => {
    // 同じ失敗を二度しないための番人。実装が定数を返すようになったら、
    // 「効果を持つ文明と持たない文明が同じ」になるのでここが落ちる。
    const yamato = mulOf('yamato', 'farm');
    expect(yamato, '農地の倍率が 1.0 のまま ―― 効果が結線されていない').not.toBe(FX_ONE);
  });
});
