import { describe, expect, it } from 'vitest';
import {
  behaviorHint,
  behaviorOf,
  BOX_COUNT,
  planRound,
  rewardFor,
  ROUNDS_PER_GAME,
} from '../shared/minigame.js';
import { clampPersonality, type Personality } from '../shared/personality.js';
import { wishOf, EGG_CARE_REQUIRED } from '../src/sim/wish.js';
import type { Needs, PetView } from '../shared/types.js';

const personality = (patch: Partial<Personality> = {}): Personality =>
  clampPersonality({
    energy: 50,
    clingy: 50,
    willful: 50,
    clever: 50,
    social: 50,
    gluttony: 50,
    timid: 50,
    mischief: 50,
    ...patch,
  } as Personality);

/** 一定の乱数列を返す（テストを決定論的にする）。 */
const seq = (values: number[]): (() => number) => {
  let i = 0;
  return () => values[i++ % values.length];
};

describe('behaviorOf（性格がむずかしさを変える）', () => {
  it('賢いほど多くシャッフルする', () => {
    expect(behaviorOf(personality({ clever: 100 })).shuffles).toBeGreaterThan(
      behaviorOf(personality({ clever: 0 })).shuffles,
    );
  });

  it('いたずら好きほどフェイントを仕掛ける', () => {
    expect(behaviorOf(personality({ mischief: 100 })).feintChance).toBeGreaterThan(0.5);
    expect(behaviorOf(personality({ mischief: 0 })).feintChance).toBe(0);
  });

  it('臆病・甘えん坊ほどヒントを出してしまう', () => {
    const shy = behaviorOf(personality({ timid: 100, clingy: 100 })).hintChance;
    const bold = behaviorOf(personality({ timid: 0, clingy: 0 })).hintChance;
    expect(shy).toBeGreaterThan(bold);
    expect(bold).toBe(0);
  });

  it('くせの説明が性格に応じて変わる', () => {
    expect(behaviorHint(personality({ clever: 100 }))).toContain('はやい');
    expect(behaviorHint(personality({ clever: 0 }))).toContain('ゆっくり');
    expect(behaviorHint(personality({ mischief: 100 }))).toContain('入れかえ');
  });
});

describe('planRound', () => {
  it('答えは必ず箱の範囲に入る', () => {
    for (let i = 0; i < 40; i += 1) {
      const plan = planRound(personality(), seq([i / 40, (i * 7) % 10 / 10, 0.5, 0.9]));
      expect(plan.answer).toBeGreaterThanOrEqual(0);
      expect(plan.answer).toBeLessThan(BOX_COUNT);
      expect(plan.startBox).toBeGreaterThanOrEqual(0);
      expect(plan.startBox).toBeLessThan(BOX_COUNT);
    }
  });

  it('シャッフルは常に異なる2つの箱を入れ替える', () => {
    const plan = planRound(personality({ clever: 100 }), seq([0.1, 0.4, 0.7, 0.2, 0.9, 0.5]));
    for (const [a, b] of plan.swaps) {
      expect(a).not.toBe(b);
    }
  });

  /**
   * このゲームの生命線: 箱の動きを目で追えば当てられること。
   * かつて swaps を「箱の番号の入れ替え」と「位置の入れ替え」で
   * サーバとクライアントが別々に解釈していて、追跡しても当たらなかった。
   * その回帰を防ぐため、クライアントと同じ手順で追跡して答え合わせをする。
   */
  function trackByWatchingCups(plan: ReturnType<typeof planRound>): number {
    // positionOfCup[cup] = その箱がいまある位置
    const positionOfCup = [0, 1, 2];
    const cupAt = (position: number) => positionOfCup.indexOf(position);
    const treatCup = cupAt(plan.startBox);
    for (const [a, b] of plan.swaps) {
      const cupA = cupAt(a);
      const cupB = cupAt(b);
      positionOfCup[cupA] = b;
      positionOfCup[cupB] = a;
    }
    return positionOfCup[treatCup];
  }

  it('フェイントが無ければ、箱を目で追うだけで必ず当たる', () => {
    // mischief 0 → feintChance 0 なのでフェイントは起きない
    for (let i = 0; i < 60; i += 1) {
      const plan = planRound(
        personality({ mischief: 0, clever: (i * 17) % 101 }),
        seq([(i % 10) / 10, ((i * 3) % 10) / 10, ((i * 7) % 10) / 10, 0.99, 0.99]),
      );
      expect(plan.feint).toBe(false);
      expect(trackByWatchingCups(plan)).toBe(plan.answer);
    }
  });

  it('フェイントが起きたときだけ、追跡しても外れる', () => {
    const plan = planRound(personality({ mischief: 100, clever: 0 }), seq([0.1, 0.2, 0.3, 0.01, 0.99]));
    expect(plan.feint).toBe(true);
    expect(trackByWatchingCups(plan)).not.toBe(plan.answer);
  });

  it('フェイントが起きると答えがずれる', () => {
    // mischief 100 → feintChance 0.55。rand が小さければフェイントする
    const plan = planRound(personality({ mischief: 100, clever: 0 }), seq([0.1, 0.2, 0.3, 0.01, 0.99]));
    expect(plan.feint).toBe(true);
  });

  it('ヒントが出るときは答えの箱を指す', () => {
    const plan = planRound(personality({ timid: 100, clingy: 100 }), seq([0.1, 0.2, 0.3, 0.99, 0.01]));
    expect(plan.hintBox).toBe(plan.answer);
  });
});

describe('rewardFor', () => {
  it('あたり数に比例する', () => {
    expect(rewardFor(0)).toBe(0);
    expect(rewardFor(1)).toBeGreaterThan(0);
    expect(rewardFor(2)).toBeGreaterThan(rewardFor(1));
  });

  it('全問正解にはボーナスが付く', () => {
    expect(rewardFor(ROUNDS_PER_GAME)).toBeGreaterThan(rewardFor(ROUNDS_PER_GAME - 1) + 8);
  });
});

// --- してほしいこと（次の一手を示す表示） -------------------------------

const pet = (patch: Partial<PetView> = {}, needs: Partial<Needs> = {}): PetView => ({
  id: 1,
  name: 'テスト',
  species: 'mocha',
  personality: personality(),
  needs: { hunger: 80, fun: 80, clean: 80, energy: 80, mood: 80, ...needs },
  stage: 'child',
  ageHours: 2,
  careScore: 10,
  action: 'idle',
  emotion: 'happy',
  bornAt: 0,
  ...patch,
});

describe('wishOf', () => {
  it('たまごは残りの世話回数を教える', () => {
    const wish = wishOf(pet({ stage: 'egg', careScore: 1 }));
    expect(wish.text).toContain(`あと ${EGG_CARE_REQUIRED - 1}回`);
    expect(wish.want).toBe('food');
  });

  it('世話が足りたたまごは「もうすぐ」に変わる', () => {
    expect(wishOf(pet({ stage: 'egg', careScore: EGG_CARE_REQUIRED })).text).toContain('もうすぐ');
  });

  it('いちばん低いニーズを言葉にする', () => {
    const wish = wishOf(pet({}, { hunger: 15 }));
    expect(wish.want).toBe('food');
    expect(wish.urgent).toBe(true);
  });

  it('軽い不足では急かさない', () => {
    const wish = wishOf(pet({}, { fun: 50 }));
    expect(wish.want).toBe('toy');
    expect(wish.urgent).toBe(false);
  });

  it('複数足りないときは最も低いものを選ぶ', () => {
    const wish = wishOf(pet({}, { hunger: 40, fun: 12, clean: 35 }));
    expect(wish.want).toBe('toy');
  });

  it('拗ねているときは撫でるよう促す', () => {
    const wish = wishOf(pet({}, { mood: 10 }));
    expect(wish.want).toBe('stroke');
    expect(wish.urgent).toBe(true);
  });

  it('満たされているときは急かさない', () => {
    const wish = wishOf(pet());
    expect(wish.want).toBe('none');
    expect(wish.urgent).toBe(false);
  });
});
