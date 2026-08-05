import type { NeedKey, PetView } from '../../shared/types.js';

/**
 * 「いま この子が なにを して ほしいか」を1行にする。
 *
 * プレイテストで、次に何をすればいいか分からず手が止まることが分かった。
 * ニーズのバーは並んでいても「で、どうすれば？」に答えていなかったので、
 * 常に1つだけ、いちばん強い要求を言葉で見せる。
 *
 * 決定論的な純関数なのでテストできる（LLM は使わない）。
 */

export interface Wish {
  /** 吹き出しに出す一言。 */
  text: string;
  icon: string;
  /** 強調表示するかどうか（本当に困っているとき）。 */
  urgent: boolean;
  /** 対応する世話の種類。ボタンを光らせるのに使う。 */
  want: 'food' | 'toy' | 'care' | 'stroke' | 'sleep' | 'none';
}

/** 孵化に必要な世話回数（サーバの growth.ts と同じ値）。 */
export const EGG_CARE_REQUIRED = 3;

export function wishOf(pet: PetView): Wish {
  if (pet.stage === 'egg') {
    const remaining = Math.max(0, EGG_CARE_REQUIRED - pet.careScore);
    if (remaining > 0) {
      return {
        text: `あと ${remaining}回 おせわすると うまれそう`,
        icon: '🥚',
        urgent: false,
        want: 'food',
      };
    }
    return { text: 'もうすぐ うまれそう…！', icon: '🥚', urgent: true, want: 'none' };
  }

  // 困っている度合いが強い順に見る。閾値を分けて「深刻」と「そこそこ」を区別する。
  const checks: Array<{ key: NeedKey; want: Wish['want']; icon: string; hard: string; soft: string }> = [
    { key: 'energy', want: 'sleep', icon: '💤', hard: 'もう ねむくて たまらない', soft: 'ちょっと ねむいかも' },
    { key: 'hunger', want: 'food', icon: '🍚', hard: 'おなかが ぺこぺこ！', soft: 'すこし おなかが すいた' },
    { key: 'fun', want: 'toy', icon: '🎾', hard: 'たいくつで しかたない！', soft: 'なにか して あそびたい' },
    { key: 'clean', want: 'care', icon: '🫧', hard: 'からだが べたべた…', soft: 'ちょっと よごれてきた' },
  ];

  let best: Wish | null = null;
  let bestValue = 101;
  for (const check of checks) {
    const value = pet.needs[check.key];
    if (value >= 60 || value >= bestValue) continue;
    bestValue = value;
    best = {
      text: value < 30 ? check.hard : check.soft,
      icon: check.icon,
      urgent: value < 30,
      want: check.want,
    };
  }
  if (best) return best;

  // 困っていないときは仲良し度で表情を変える。
  if (pet.needs.mood < 25) {
    return { text: 'ふん…（そっぽを むいている）', icon: '💧', urgent: true, want: 'stroke' };
  }
  if (pet.needs.mood < 60) {
    return { text: 'もっと かまって ほしいみたい', icon: '💛', urgent: false, want: 'stroke' };
  }
  return { text: 'ごきげん！ いっしょに いたいみたい', icon: '✨', urgent: false, want: 'none' };
}
