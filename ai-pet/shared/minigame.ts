import type { Personality } from './personality.js';

/**
 * ミニゲーム「どこに かくした？」
 *
 * ペットが3つの箱のどれかにおやつを隠し、飼い主が当てる。
 *
 * ただのアタリハズレにはしない。**性格ベクトルが遊びを変える**のがこのゲームの狙いで、
 * 「この子だから難しい／簡単」という手触りが出る。
 *   - いたずら好き ほど、途中で中身を入れ替えるフェイントを仕掛ける
 *   - 賢い ほど、箱を多くシャッフルする
 *   - 臆病 / 甘えん坊 ほど、つい正解の箱を見てしまって ヒントが出る
 *
 * すべて純関数なのでテストできる。
 */

export const BOX_COUNT = 3;
export const ROUNDS_PER_GAME = 3;
export const COINS_PER_HIT = 8;

export interface GameBehavior {
  /** シャッフル回数（多いほど目で追いにくい）。 */
  shuffles: number;
  /** 最後に中身をこっそり入れ替える確率（0〜1）。 */
  feintChance: number;
  /** 正解の箱をちらっと見てしまう確率（0〜1）。 */
  hintChance: number;
}

export function behaviorOf(personality: Personality): GameBehavior {
  return {
    shuffles: 2 + Math.round((personality.clever / 100) * 4),
    feintChance: (personality.mischief / 100) * 0.55,
    // 臆病さと甘えん坊の平均。飼い主に隠しきれない子ほどヒントが出る。
    hintChance: ((personality.timid + personality.clingy) / 200) * 0.7,
  };
}

/** 難しさの説明。ゲーム開始時に見せて「この子らしさ」を伝える。 */
export function behaviorHint(personality: Personality): string {
  const behavior = behaviorOf(personality);
  const notes: string[] = [];
  if (behavior.shuffles >= 5) notes.push('手つきが とても はやい');
  else if (behavior.shuffles <= 3) notes.push('手つきは ゆっくり');
  if (behavior.feintChance >= 0.3) notes.push('こっそり 入れかえてくるので 油断できない');
  if (behavior.hintChance >= 0.4) notes.push('かくした箱を つい 見てしまう くせがある');
  return notes.length ? notes.join('。') + '。' : 'ふつうの かくしかた。';
}

/**
 * ラウンドの内容。
 *
 * 用語をはっきり分けておく（ここを混ぜると当てられないゲームになる）。
 *   - **位置(position)**: 画面の左・中・右。プレイヤーがクリックするのは位置。
 *   - **箱(cup)**: 個々の箱。おやつは箱の中に留まり、箱ごと位置が入れ替わる。
 *
 * swaps は「位置 p と位置 q にある箱を入れ替える」という指示。
 * おやつは箱に付いていくので、プレイヤーは箱の動きを目で追えば当てられる。
 */
export interface RoundPlan {
  /** 最初におやつを入れた位置。プレイヤーに見せてからシャッフルする。 */
  startBox: number;
  /** シャッフル後、おやつがある位置（プレイヤーのクリックと比べる値）。 */
  answer: number;
  /** 演出用のシャッフル手順（位置 a と位置 b の箱を入れ替える）。 */
  swaps: Array<[number, number]>;
  /** フェイントが入ったか。 */
  feint: boolean;
  /** ヒントとして光らせる位置（なければ null）。 */
  hintBox: number | null;
}

/**
 * 1ラウンドの内容を決める。乱数を差し替えられるのでテストできる。
 * サーバ側で作って答えを保持し、クライアントには startBox / swaps / hintBox だけを渡す。
 */
export function planRound(personality: Personality, rand: () => number = Math.random): RoundPlan {
  const behavior = behaviorOf(personality);
  const startBox = Math.floor(rand() * BOX_COUNT) % BOX_COUNT;

  // positionOfCup[cup] = その箱がいまある位置。最初は箱 i が位置 i にある。
  const positionOfCup = Array.from({ length: BOX_COUNT }, (_, index) => index);
  // おやつが入っている箱（最初の位置にある箱）。
  const treatCup = startBox;

  const swaps: Array<[number, number]> = [];
  for (let i = 0; i < behavior.shuffles; i += 1) {
    const a = Math.floor(rand() * BOX_COUNT) % BOX_COUNT;
    const b = (a + 1 + Math.floor(rand() * (BOX_COUNT - 1))) % BOX_COUNT;
    swaps.push([a, b]);
    // 位置 a と位置 b にある箱を入れ替える。
    const cupAtA = positionOfCup.indexOf(a);
    const cupAtB = positionOfCup.indexOf(b);
    positionOfCup[cupAtA] = b;
    positionOfCup[cupAtB] = a;
  }

  let answer = positionOfCup[treatCup];

  // フェイント: シャッフルのあとに、こっそり隣の箱へ移す（いたずら好きだけ）。
  const feint = rand() < behavior.feintChance;
  if (feint) {
    answer = (answer + 1 + Math.floor(rand() * (BOX_COUNT - 1))) % BOX_COUNT;
  }

  const hintBox = rand() < behavior.hintChance ? answer : null;
  return { startBox, answer, swaps, feint, hintBox };
}

export interface GameResult {
  hits: number;
  rounds: number;
  coins: number;
}

export function rewardFor(hits: number): number {
  // 全問正解にはボーナスを付ける（最後まで遊ぶ動機になる）。
  const base = hits * COINS_PER_HIT;
  return hits === ROUNDS_PER_GAME ? base + 10 : base;
}
