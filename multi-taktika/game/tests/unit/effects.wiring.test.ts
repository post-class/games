/**
 * 効果適用エンジンが **sim に結線されているか**の検算（端から端まで）。
 *
 * ■ なぜこのファイルが必要になったか（**消さないこと**）
 * `core/effects.ts` の効果の計算には 45 件の単体テストがあり、全部緑だった。
 * それでも **研究 20 本・建物 3 件の効果が一切効いていなかった** ―― sim 側が
 * 集計結果を読んでいなかったからで、入口が「引数を無視して既定値を返す関数」だったため
 * **忘れても何も壊れず、1900 本のテストが全部緑のまま**だった。
 *
 * **計算のテストは結線を保証しない。** だから「研究する前と後で挙動が変わること」を
 * ここで見る。値そのもの（+1 なのか +2 なのか）は `techs.json` を触れば変わるので見ない。
 * 見るのは **「変わるか / 変わらないか」** だけ。
 *
 * 対になるファイル:
 *  - `gather.effects.test.ts` … 採集倍率
 *  - `sight.effects.test.ts`  … 建物の視界（測量）
 */

import { describe, expect, it } from 'vitest';
import { createMatch } from '@/sim';
import { UNIT_DEFS, techIndex, unitDefById } from '@/sim/core/defs';
import {
  applyUnitStat,
  depositMul,
  farmYieldMul,
  getPlayerModifiers,
  markModifiersDirty,
  tradeIncomeMul,
} from '@/sim/core/effects';
import { FX_ONE } from '@/sim/core/fx';
import type { CivId } from '@/shared/types';
import type { World } from '@/sim/core/world';

function newWorld(civ: CivId = 'yamato'): World {
  return createMatch({ seed: 3, playerCount: 2, civs: [civ, 'mongol'] }).world;
}

/** 席 0 に研究を 1 つ与える（集計をやり直させる）。 */
function research(w: World, id: string): void {
  w.players[0]!.researched[techIndex(id)] = 1;
  markModifiersDirty(w, 0);
}

describe('研究がユニットの数値に届く（`unitStat`）', () => {
  it('「打刃」で近接兵の攻撃が上がる', () => {
    const w = newWorld();
    const def = unitDefById('y-ashigaru');
    const before = applyUnitStat(getPlayerModifiers(w, 0), def, 'atk', def.atk);
    research(w, 'uchiba');
    const after = applyUnitStat(getPlayerModifiers(w, 0), def, 'atk', def.atk);
    expect(after, '打刃を研究しても攻撃が上がらない ―― 効果が結線されていない').toBeGreaterThan(
      before
    );
  });

  it('「打刃」は遠隔兵の攻撃を上げない（対象の絞り込みが効いている）', () => {
    const w = newWorld();
    const def = unitDefById('y-yumiashigaru');
    const before = applyUnitStat(getPlayerModifiers(w, 0), def, 'atk', def.atk);
    research(w, 'uchiba');
    expect(applyUnitStat(getPlayerModifiers(w, 0), def, 'atk', def.atk)).toBe(before);
  });

  it('「革鎧」で歩兵の防御が上がる', () => {
    const w = newWorld();
    const def = unitDefById('y-ashigaru');
    const before = applyUnitStat(getPlayerModifiers(w, 0), def, 'def', def.def);
    research(w, 'kawayoroi');
    expect(applyUnitStat(getPlayerModifiers(w, 0), def, 'def', def.def)).toBeGreaterThan(before);
  });

  it('「射法」で遠隔兵の射程が伸びる', () => {
    const w = newWorld();
    const def = unitDefById('y-yumiashigaru');
    // 射程のフィールドは `range`（効果側の stat 名は `rangeTiles`）。
    const before = applyUnitStat(getPlayerModifiers(w, 0), def, 'rangeTiles', def.range);
    research(w, 'shahou');
    expect(
      applyUnitStat(getPlayerModifiers(w, 0), def, 'rangeTiles', def.range)
    ).toBeGreaterThan(before);
  });

  it('研究は**相手**の兵には効かない', () => {
    const w = newWorld();
    const def = unitDefById('y-ashigaru');
    const before = applyUnitStat(getPlayerModifiers(w, 1), def, 'atk', def.atk);
    research(w, 'uchiba');
    expect(applyUnitStat(getPlayerModifiers(w, 1), def, 'atk', def.atk)).toBe(before);
  });
});

describe('エリート兵も自分の系統の研究を受けられる（`line: elite` の取りこぼし）', () => {
  /**
   * `units.json` はエリート兵の `line` を `elite` にしている。系統の列が 1 つしかないので、
   * そう書くと**エリートが近接でも遠隔でもなくなり**、`03§9` の
   * 「打刃 ― 近接兵の攻撃 +1」がエリートに効かない。
   * 城で作った切り札が、研究を積んだ通常兵より弱いという逆転になる。
   */
  it('「打刃」（近接兵）が近接のエリート（武士）にも効く', () => {
    const w = newWorld();
    const def = unitDefById('y-bushi');
    const before = applyUnitStat(getPlayerModifiers(w, 0), def, 'atk', def.atk);
    research(w, 'uchiba');
    expect(
      applyUnitStat(getPlayerModifiers(w, 0), def, 'atk', def.atk),
      '近接のエリートに近接の研究が効かない'
    ).toBeGreaterThan(before);
  });

  it('「打刃」（近接兵）は**遠隔の**エリート（連弩兵）には効かない', () => {
    // エリートを一律 melee 扱いにすると、ここが通ってしまう（取り違え）。
    const w = newWorld('tou');
    const def = unitDefById('t-renkyu');
    const before = applyUnitStat(getPlayerModifiers(w, 0), def, 'atk', def.atk);
    research(w, 'uchiba');
    expect(applyUnitStat(getPlayerModifiers(w, 0), def, 'atk', def.atk)).toBe(before);
  });

  it('「鏃」（遠隔兵）が遠隔のエリート（連弩兵）に効く', () => {
    const w = newWorld('tou');
    const def = unitDefById('t-renkyu');
    const before = applyUnitStat(getPlayerModifiers(w, 0), def, 'atk', def.atk);
    research(w, 'yajiri');
    expect(applyUnitStat(getPlayerModifiers(w, 0), def, 'atk', def.atk)).toBeGreaterThan(before);
  });

  it('「馬鎧」（騎兵・獣兵）が獣のエリート（親衛象）に効く', () => {
    const w = newWorld('persia');
    const def = unitDefById('p-guard-elephant');
    const before = applyUnitStat(getPlayerModifiers(w, 0), def, 'def', def.def);
    research(w, 'bayoroi');
    expect(applyUnitStat(getPlayerModifiers(w, 0), def, 'def', def.def)).toBeGreaterThan(before);
  });

  it('すべてのエリート兵が、何らかの研究の恩恵を受けられる', () => {
    // 対象から漏れたエリートがいたらここで落ちる（新しいエリートを足したときの番人）。
    //
    // 「攻撃研究」で揃えられない理由: `techs.json` に**騎兵・獣兵の攻撃研究は無い**
    // （打刃・鋼刃は近接、鏃・鋼鏃は遠隔だけ）。だから親衛象・親衛弓騎兵は
    // 防御（馬鎧）で見る。研究の並びは資料 `03§9` の設計なので、
    // ここを「攻撃で揃うべき」と読み替えてはいけない。
    const w0 = newWorld();
    const elites = UNIT_DEFS.filter((d) => d.line === 'elite');
    expect(elites.length).toBeGreaterThan(0);
    for (const def of elites) {
      const stat = def.role === 'cavalry' || def.role === 'beast' ? 'def' : 'atk';
      const baseValue = stat === 'def' ? def.def : def.atk;
      const base = applyUnitStat(getPlayerModifiers(w0, 0), def, stat, baseValue);
      const w2 = newWorld();
      research(w2, 'uchiba'); // 近接の攻撃
      research(w2, 'yajiri'); // 遠隔の攻撃
      research(w2, 'bayoroi'); // 騎兵・獣兵の防御
      const after = applyUnitStat(getPlayerModifiers(w2, 0), def, stat, baseValue);
      expect(after, `エリート ${def.id}（${def.role}）がどの研究も受けない`).toBeGreaterThan(base);
    }
  });
});

describe('内政の効果が届く', () => {
  it('「犂」で農地の産出が上がる（`farmYieldMul`）', () => {
    const w = newWorld();
    const before = farmYieldMul(getPlayerModifiers(w, 0));
    research(w, 'suki');
    expect(farmYieldMul(getPlayerModifiers(w, 0))).toBeGreaterThan(before);
  });

  it('「坑道」で石材・金の埋蔵量が増える（`depositMul`）', () => {
    const w = newWorld();
    const before = depositMul(getPlayerModifiers(w, 0), 'gold');
    research(w, 'koudou');
    expect(depositMul(getPlayerModifiers(w, 0), 'gold')).toBeGreaterThan(before);
  });

  it('「隊商」で交易収入が増える（`tradeIncomeMul`）', () => {
    const w = newWorld();
    const before = tradeIncomeMul(getPlayerModifiers(w, 0));
    research(w, 'taisho');
    expect(tradeIncomeMul(getPlayerModifiers(w, 0))).toBeGreaterThan(before);
  });

  it('研究前の倍率はちょうど 1.0（余計な倍率が混ざっていない）', () => {
    const w = newWorld('mongol');
    const m = getPlayerModifiers(w, 0);
    expect(farmYieldMul(m)).toBe(FX_ONE);
    expect(tradeIncomeMul(m)).toBe(FX_ONE);
    expect(depositMul(m, 'gold')).toBe(FX_ONE);
  });
});
