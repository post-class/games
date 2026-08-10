import { describe, expect, it } from 'vitest';
import { SORTIE_TRUST_CAP, sortieNarrative, type SortieFacts } from '../../src/app/narrative';

/**
 * T4-⑯ の「座席の扱い」を4状態へ繋ぐ配線のテスト。
 *
 * 敵エースの脱出ポッドを撃つ／撃たないは、誤射（識別ミス）や民間損害とは**別の宛先**
 * ＝「敵エースの誓約」だけに効く、という設計を固定する。
 */

/** エース以外の項目を中立にした facts。誓約の増減だけを見たいときに使う。 */
function neutralFacts(over: Partial<SortieFacts> = {}): SortieFacts {
  return {
    rescued: 0,
    enemyRescued: 0,
    escortSurvivors: 0,
    escortTotal: 0,
    wingmenSurvived: 0,
    wingmenLost: 0,
    civilianLosses: 0,
    friendlyFireHits: 0,
    shotsFired: 1,
    playerLost: false,
    objectivesFailed: 0,
    grade: 'complete',
    ...over,
  };
}

function oathDelta(over: Partial<SortieFacts>): number {
  return sortieNarrative(neutralFacts(over)).delta.aceOath ?? 0;
}

function oathLine(over: Partial<SortieFacts>) {
  return sortieNarrative(neutralFacts(over)).lines.find((l) => l.key === 'aceOath');
}

describe('T4-⑯ 座席の扱いが「敵エースの誓約」へ効く', () => {
  it('ポッドを撃たずに残すと誓約が上がる', () => {
    expect(oathDelta({ acePodsSpared: 1 })).toBeGreaterThan(0);
    const line = oathLine({ acePodsSpared: 1 });
    expect(line?.gains.map((g) => g.text).join(' ')).toContain('撃たなかった');
  });

  it('ポッドを撃つと誓約が下がる', () => {
    expect(oathDelta({ acePodsExecuted: 1 })).toBeLessThan(0);
    const line = oathLine({ acePodsExecuted: 1 });
    expect(line?.losses.map((l) => l.text).join(' ')).toContain('脱出ポッドを撃った');
  });

  it('座席を撃つのは単項目で最も重い（助けた 1件 +5 に対し 撃った 1件 -8）', () => {
    const executedOnly = oathLine({ acePodsExecuted: 1 })!;
    const sparedOnly = oathLine({ acePodsSpared: 1 })!;
    const executedWeight = Math.abs(executedOnly.losses[0].delta);
    const sparedWeight = sparedOnly.gains[0].delta;
    expect(executedWeight).toBeGreaterThan(sparedWeight);
    // 誓約を上げる他の手（名乗り・決闘）より重い
    expect(executedWeight).toBeGreaterThan(oathLine({ aceNamesExchanged: 1 })!.gains[0].delta);
    expect(executedWeight).toBeGreaterThan(oathLine({ aceDuelsAccepted: 1 })!.gains[0].delta);
  });

  it('他に何もしていない出撃で座席を撃てば、誓約は明確に負になる', () => {
    expect(oathDelta({ acePodsExecuted: 1 })).toBeLessThanOrEqual(-8);
  });

  it('同じ出撃で救難を積めば正で終わりうる（特例で負に固定していない）', () => {
    // 「破ったら必ず負」という隠れた特例を入れると、内訳の各行と適用値が食い違う。
    // 内訳には減点行がそのまま並ぶので、プレイヤーは何が起きたか読める。
    const delta = oathDelta({
      acePodsExecuted: 1,
      acePodsSpared: 2,
      aceNamesExchanged: 2,
      aceDuelsAccepted: 2,
      enemyRescued: 2,
      rescued: 3,
    });
    expect(delta).toBeGreaterThan(0);
    const line = oathLine({ acePodsExecuted: 1, acePodsSpared: 2 })!;
    expect(line.losses.some((l) => l.text.includes('脱出ポッドを撃った'))).toBe(true);
  });

  it('名を交わす・決闘に応じるは小さく上がる（座席より軽い）', () => {
    const named = oathDelta({ aceNamesExchanged: 1 });
    const duel = oathDelta({ aceDuelsAccepted: 1 });
    const spared = oathDelta({ acePodsSpared: 1 });
    expect(named).toBeGreaterThan(0);
    expect(duel).toBeGreaterThan(0);
    expect(named).toBeLessThan(spared);
    expect(duel).toBeLessThan(spared);
  });

  it('決闘が不成立でも罰されない（不成立は数えていない）', () => {
    // aceDuelsAccepted のみを持ち、declined は facts に存在しない＝罰する経路がない
    expect(oathDelta({})).toBe(0);
  });

  it('増減は 1状態あたりの上限（SORTIE_TRUST_CAP）を超えない', () => {
    expect(oathDelta({ acePodsExecuted: 9 })).toBe(-SORTIE_TRUST_CAP);
    expect(oathDelta({ acePodsSpared: 9, aceNamesExchanged: 9, aceDuelsAccepted: 9 })).toBe(
      SORTIE_TRUST_CAP,
    );
  });
});

describe('T4-⑯ 座席の扱いは誤射・民間損害とは別の宛先である', () => {
  it('ポッドを撃っても航路信頼は動かない（民間損害ではない）', () => {
    const executed = sortieNarrative(neutralFacts({ acePodsExecuted: 2 }));
    const clean = sortieNarrative(neutralFacts({}));
    expect(executed.delta.routeTrust).toBe(clean.delta.routeTrust);
  });

  it('ポッドを撃っても軍令信用は動かない', () => {
    const executed = sortieNarrative(neutralFacts({ acePodsExecuted: 2 }));
    const clean = sortieNarrative(neutralFacts({}));
    expect(executed.delta.commandTrust).toBe(clean.delta.commandTrust);
  });

  it('誤射は従来どおり航路信頼と誓約の両方に効く（座席とは別経路）', () => {
    const ff = sortieNarrative(neutralFacts({ friendlyFireHits: 2 }));
    const clean = sortieNarrative(neutralFacts({}));
    expect(ff.delta.routeTrust!).toBeLessThan(clean.delta.routeTrust!);
    expect(ff.delta.aceOath!).toBeLessThan(clean.delta.aceOath ?? 0);
  });
});

describe('T4-⑯ エースが出ない出撃・旧セーブでも壊れない', () => {
  it('4項目が未指定でも誓約は 0 のまま（訓練・エース不在の章）', () => {
    expect(oathDelta({})).toBe(0);
    expect(oathLine({})).toBeUndefined();
  });

  it('負の値や小数が来ても 0 以上の整数に丸める', () => {
    const weird = { acePodsExecuted: -3, acePodsSpared: 1.6 } as unknown as Partial<SortieFacts>;
    const delta = oathDelta(weird);
    // executed は 0 に丸められ、spared は 2 として扱われる（減点は出ない）
    expect(delta).toBeGreaterThan(0);
  });
});
