import { NEED_KEYS, type NeedKey, type Needs } from '../../shared/types.js';
import type { Personality } from '../../shared/personality.js';

/**
 * ニーズはサーバ側で「最終計算時刻からの経過時間」で減衰させる。
 * クライアントが開かれていることに依存しないので、放置しても筋の通った状態になる。
 *
 * 調査で分かった通り、たまごっち型の「死の恐怖」は現代では強すぎる。
 * ここでは死なせず、代わりに mood（なかよし度）が下がり、
 * 会話のトーンが拗ねる方向へ変わることで放置を物語化する。
 */

/**
 * 1時間あたりの減衰量（基準値）。
 *
 * 1日1回しか開かないプレイヤーでも成立するよう、意図的にゆるやかにしている。
 * 以前は空腹が 7/時 で、20時間の放置で全ニーズが 0 になり、
 * 帰ってきた瞬間に「取り返しのつかない状態」を見せてしまっていた（プレイテストで判明）。
 */
const DECAY_PER_HOUR: Record<NeedKey, number> = {
  hunger: 3.6,
  fun: 3,
  clean: 2,
  energy: -5, // energy は寝ている間に回復するので符号が逆（負 = 増える）
  mood: 0, // mood は他ニーズの結果として動くので直接減衰しない
};

/**
 * 放置で減るニーズの下限。
 * ここを 0 にしないのは「この子は勝手に生きていける。ただ寂しいだけ」を表すため。
 * 罰ではなく、mood（なかよし度）が下がることで物語にする方針。
 */
const NEED_FLOOR = 8;
const FLOOR_KEYS: NeedKey[] = ['hunger', 'fun', 'clean'];

const MIN_NEED = 0;
const MAX_NEED = 100;

export function clampNeeds(needs: Needs): Needs {
  const out = {} as Needs;
  for (const key of NEED_KEYS) {
    const value = Number.isFinite(needs[key]) ? needs[key] : 50;
    out[key] = Math.max(MIN_NEED, Math.min(MAX_NEED, Math.round(value)));
  }
  return out;
}

export function initialNeeds(): Needs {
  return { hunger: 70, fun: 70, clean: 90, energy: 80, mood: 60 };
}

/**
 * 性格による減衰の個体差。
 * 食いしん坊なら早く腹が減り、元気なら早く退屈し、いたずら好きなら早く汚れる。
 */
function decayMultiplier(key: NeedKey, personality: Personality): number {
  switch (key) {
    case 'hunger':
      return 0.7 + (personality.gluttony / 100) * 0.8;
    case 'fun':
      return 0.7 + (personality.energy / 100) * 0.8;
    case 'clean':
      return 0.7 + (personality.mischief / 100) * 0.8;
    case 'energy':
      return 0.7 + (personality.energy / 100) * 0.6;
    default:
      return 1;
  }
}

/**
 * mood は他のニーズの平均から目標値を決め、そこへゆっくり引き寄せられる。
 * 「ちゃんと世話されているか」が時間をかけて仲良し度に反映される設計。
 */
function moodTarget(needs: Needs): number {
  const care = (needs.hunger + needs.fun + needs.clean) / 3;
  // 世話が行き届いていれば 85 付近、放置されていれば 15 付近を目指す。
  return 15 + (care / 100) * 70;
}

export interface DecayResult {
  needs: Needs;
  hoursElapsed: number;
}

/**
 * `from` から `to` までの経過時間ぶんニーズを進める。
 * 純粋関数なのでテストしやすく、同じ入力なら必ず同じ結果になる。
 */
export function decayNeeds(
  needs: Needs,
  personality: Personality,
  fromMs: number,
  toMs: number,
): DecayResult {
  const hours = Math.max(0, (toMs - fromMs) / 3_600_000);
  if (hours === 0) return { needs: clampNeeds(needs), hoursElapsed: 0 };

  const next = { ...needs };
  for (const key of NEED_KEYS) {
    if (key === 'mood') continue;
    const decayed = needs[key] - DECAY_PER_HOUR[key] * decayMultiplier(key, personality) * hours;
    // 下限のあるニーズは、すでに下限を割っている値をさらに下げない。
    next[key] = FLOOR_KEYS.includes(key)
      ? Math.max(Math.min(needs[key], NEED_FLOOR), decayed)
      : decayed;
  }

  // mood は目標値へ 1 時間あたり最大 8 ポイント近づく。
  const clampedForMood = clampNeeds({ ...next, mood: needs.mood });
  const target = moodTarget(clampedForMood);
  const pull = Math.min(Math.abs(target - needs.mood), 8 * hours);
  next.mood = needs.mood + Math.sign(target - needs.mood) * pull;

  return { needs: clampNeeds(next), hoursElapsed: hours };
}

export function applyNeedsDelta(needs: Needs, delta: Partial<Needs>): Needs {
  const next = { ...needs };
  for (const key of NEED_KEYS) {
    const change = delta[key];
    if (typeof change === 'number' && Number.isFinite(change)) {
      // LLM 由来の値が暴れないよう1回の変化幅を制限する。
      next[key] = next[key] + Math.max(-25, Math.min(25, change));
    }
  }
  return clampNeeds(next);
}

/** いま最も困っているニーズ。null なら特に困っていない。 */
export function urgentNeed(needs: Needs): NeedKey | null {
  let worst: NeedKey | null = null;
  let worstValue = 45; // これ以上あれば「困っている」とは言わない
  for (const key of ['hunger', 'fun', 'clean', 'energy'] as const) {
    if (needs[key] < worstValue) {
      worst = key;
      worstValue = needs[key];
    }
  }
  return worst;
}

/** 状態を日本語1行にする（プロンプトと留守レポートで共用）。 */
export function describeNeeds(needs: Needs): string {
  const parts: string[] = [];
  parts.push(needs.hunger < 30 ? 'おなかがぺこぺこ' : needs.hunger > 85 ? 'おなかいっぱい' : 'おなかは普通');
  parts.push(needs.fun < 30 ? 'ひどく退屈' : needs.fun > 85 ? 'とても満たされている' : '退屈ではない');
  parts.push(needs.clean < 30 ? '体が汚れている' : 'そこそこきれい');
  parts.push(needs.energy < 25 ? 'とても眠い' : needs.energy > 85 ? '元気いっぱい' : '普通の元気さ');
  parts.push(
    needs.mood < 25
      ? '飼い主に対して拗ねている'
      : needs.mood > 80
        ? '飼い主が大好き'
        : '飼い主とはまあまあ',
  );
  return parts.join('、');
}
