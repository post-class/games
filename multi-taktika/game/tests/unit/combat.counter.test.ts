import { describe, expect, it } from 'vitest';
import { createWorld } from '@/sim/core/world';
import { stepWorld } from '@/sim';
import { EntityKind } from '@/shared/types';
import { spawnEntity, isAliveIndex } from '@/sim/core/entity';
import { unitDefById } from '@/sim/core/defs';
import { FX_ONE, fxFromInt } from '@/sim/core/fx';

/** 同数でぶつけて、どちらが何体残るかを見る。 */
function duel(idA: string, idB: string, n: number): { a: number; b: number; text: string } {
  const w = createWorld({
    seed: 5,
    playerCount: 2,
    mapWidthTiles: 64,
    mapHeightTiles: 64,
    entityCapacity: 256,
  });
  const a = unitDefById(idA);
  const b = unitDefById(idB);
  for (let k = 0; k < n; k++) {
    spawnEntity(w.entities, {
      kind: EntityKind.Unit,
      owner: 0,
      typeId: a.index,
      x: fxFromInt(28 + (k % 4)),
      y: fxFromInt(30 + Math.floor(k / 4)),
      hpMax: a.hp,
      morale: FX_ONE,
    });
    spawnEntity(w.entities, {
      kind: EntityKind.Unit,
      owner: 1,
      typeId: b.index,
      x: fxFromInt(34 + (k % 4)),
      y: fxFromInt(30 + Math.floor(k / 4)),
      hpMax: b.hp,
      morale: FX_ONE,
    });
  }
  for (let t = 0; t < 4000; t++) stepWorld(w, []);
  const left = [0, 0];
  for (let i = 0; i < w.entities.highWater; i++) {
    if (!isAliveIndex(w.entities, i)) continue;
    if (w.entities.kind[i] !== EntityKind.Unit) continue;
    left[w.entities.owner[i]!]! += 1;
  }
  return {
    a: left[0]!,
    b: left[1]!,
    text: `${idA} ${left[0]} 体 vs ${idB} ${left[1]} 体`,
  };
}

/**
 * 相性（`config.counterMatrix`）が**実際の戦闘で効いている**ことの検証。
 *
 * ■ なぜ必要か
 * 相性表は「槍 → 騎兵は good、騎兵 → 槍は bad」と定義されているが、
 * **定義されていることと効いていることは別**。文明バランスの測定で
 * 「青銅の世で騎兵を持つローマが強い」と出たとき、原因が
 * 「相性が効いていない」なのか「内政の差」なのかを切り分ける必要があった。
 * 同数でぶつけて実際に生き残る数を見れば、それが分かる。
 *
 * ■ 結果（切り分けに使った実測）
 * 槍は騎兵に 7 対 0 で勝ち、弓は騎兵に 0 対 8 で負ける ―― 相性は効いている。
 * したがってローマの優位は戦闘ではなく**内政（時間切れ判定での差）**による。
 */
describe('相性が実際の戦闘で効く（`config.counterMatrix`）', () => {
  it('槍は騎兵に勝つ（`spear → cavalry` = good）', () => {
    const r = duel('y-ashigaru', 'r-eq-light', 8);
    expect(r.a, `槍が騎兵に負けている（${r.text}）`).toBeGreaterThan(r.b);
    expect(r.b, '騎兵が生き残っている').toBe(0);
  }, 120000);

  it('槍はモンゴル騎兵にも勝つ（速い騎兵でも相性は変わらない）', () => {
    const r = duel('y-ashigaru', 'g-light', 8);
    expect(r.a, `槍がモンゴル騎兵に負けている（${r.text}）`).toBeGreaterThan(r.b);
  });

  it('弓は騎兵に負ける（`cavalry → ranged` = good）', () => {
    const r = duel('y-yumiashigaru', 'r-eq-light', 8);
    expect(r.b, `騎兵が弓に負けている（${r.text}）`).toBeGreaterThan(r.a);
    expect(r.a, '弓が生き残っている').toBe(0);
  });

  it('同じ役割どうしは素の数値で決まる（守備の高い槍が勝つ）', () => {
    // ヤマトの槍は `def 2`、ローマの槍は `def 1`。相性は同じなので数値の差が出る。
    const r = duel('y-ashigaru', 'r-hastati', 8);
    expect(r.a, `守備の高い側が負けている（${r.text}）`).toBeGreaterThan(r.b);
  });
});
