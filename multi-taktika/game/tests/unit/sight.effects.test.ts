/**
 * 実効視界（`sim/core/sight.ts`）の検算。
 *
 * ■ なぜこのテストが必要か
 * 視界を読む場所が 2 つある ―― 画面の霧（`render/vision.ts`）と
 * AI に見せる範囲（`ai/view.ts`）。両方が `buildingDef(...).sight` を**直に読んでいた**ため、
 * 研究「測量」（建物の視界 +4）がどちらにも効いていなかった。
 *
 * さらに厄介なのは、**片方だけ直すと壊れ方が変わる**こと:
 *  - AI 側だけ広い → 画面に見えない敵に AI が反応する（`07§11` の「ズルなし」違反）
 *  - 画面側だけ広い → 見えているのに AI が動かない
 * だから「同じ関数を使っていること」を保証したい。
 */

import { describe, expect, it } from 'vitest';
import { createMatch } from '@/sim';
import { EntityKind } from '@/shared/types';
import { buildingDef, techIndex } from '@/sim/core/defs';
import { entitySightFx } from '@/sim/core/sight';
import { markModifiersDirty } from '@/sim/core/effects';
import { isAliveIndex } from '@/sim/core/entity';
import { FX_ONE } from '@/sim/core/fx';
import type { World } from '@/sim/core/world';

/** 席 0 の建物のうち最初のもの（町の中心）の index。 */
function firstBuildingIndex(w: World): number {
  const e = w.entities;
  for (let i = 0; i < e.highWater; i++) {
    if (!isAliveIndex(e, i)) continue;
    if (e.owner[i] !== 0 || e.kind[i] !== EntityKind.Building) continue;
    return i;
  }
  throw new Error('席 0 の建物が見つからない');
}

function newWorld(): World {
  return createMatch({ seed: 7, playerCount: 2, civs: ['yamato', 'mongol'] }).world;
}

describe('実効視界（研究「測量」の結線）', () => {
  it('研究前は `buildings.json` の値そのまま', () => {
    const w = newWorld();
    const i = firstBuildingIndex(w);
    expect(entitySightFx(w, i)).toBe(buildingDef(w.entities.typeId[i]!).sight);
  });

  it('「測量」を研究すると建物の視界が広がる', () => {
    const w = newWorld();
    const i = firstBuildingIndex(w);
    const before = entitySightFx(w, i);
    w.players[0]!.researched[techIndex('sokuryo')] = 1;
    markModifiersDirty(w, 0); // 研究フラグを直接立てたので集計をやり直させる
    const after = entitySightFx(w, i);
    expect(after, '測量を研究しても視界が広がらない ―― 効果が結線されていない').toBeGreaterThan(
      before
    );
  });

  it('研究しても**相手**の視界は広がらない（効果は持ち主だけ）', () => {
    const w = newWorld();
    const e = w.entities;
    let enemy = -1;
    for (let i = 0; i < e.highWater; i++) {
      if (isAliveIndex(e, i) && e.owner[i] === 1 && e.kind[i] === EntityKind.Building) {
        enemy = i;
        break;
      }
    }
    expect(enemy).toBeGreaterThanOrEqual(0);
    const before = entitySightFx(w, enemy);
    w.players[0]!.researched[techIndex('sokuryo')] = 1;
    markModifiersDirty(w, 0);
    expect(entitySightFx(w, enemy)).toBe(before);
  });

  it('視界を持たない建物（壁など）には加算しない', () => {
    // `sight` が 0 の建物に +4 すると、壁の周りだけ霧が開くという妙な絵になる。
    const w = newWorld();
    w.players[0]!.researched[techIndex('sokuryo')] = 1;
    markModifiersDirty(w, 0);
    const e = w.entities;
    for (let i = 0; i < e.highWater; i++) {
      if (!isAliveIndex(e, i)) continue;
      if (e.owner[i] !== 0 || e.kind[i] !== EntityKind.Building) continue;
      if (buildingDef(e.typeId[i]!).sight > 0) continue;
      expect(entitySightFx(w, i)).toBe(0);
    }
  });

  it('ユニットの視界は `units.json` の値（ユニットを変える効果はまだ無い）', () => {
    const w = newWorld();
    const e = w.entities;
    for (let i = 0; i < e.highWater; i++) {
      if (!isAliveIndex(e, i) || e.owner[i] !== 0 || e.kind[i] !== EntityKind.Unit) continue;
      expect(entitySightFx(w, i)).toBeGreaterThan(0);
      break;
    }
  });

  it('資源ノードは視界を持たない（自軍所有の農地の食料ノードでも 0）', () => {
    // ここを「ユニットでなければ建物」と決めつけていた実装が過去に落ちている。
    const w = newWorld();
    const e = w.entities;
    let checked = 0;
    for (let i = 0; i < e.highWater; i++) {
      if (!isAliveIndex(e, i) || e.kind[i] !== EntityKind.Resource) continue;
      expect(entitySightFx(w, i)).toBe(0);
      checked++;
    }
    expect(checked, 'マップに資源ノードが 1 つも無い').toBeGreaterThan(0);
  });

  it('視界は Fx（マス単位の固定小数）で返る', () => {
    const w = newWorld();
    const i = firstBuildingIndex(w);
    const s = entitySightFx(w, i);
    expect(s % 1).toBe(0); // 整数（Fx は整数で持つ）
    expect(s / FX_ONE).toBeGreaterThan(1); // 1 マスより広い
  });
});
