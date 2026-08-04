import type { Emotion, PetAction } from './actions.js';
import type { GrowthStage, SpeciesId } from './types.js';

/**
 * LLM を待たずに即座に出す定型リアクション。
 *
 * My Talking Tom の「触った瞬間に必ず反応が返る」手触りを再現するための仕組み。
 * クライアントはこれを即表示し、LLM の一言が返ってきたら差し替える。
 * サーバ側でも LLM が使えないときのフォールバックとして同じものを使う。
 */

export type CareKind = 'feed' | 'play' | 'clean' | 'pet';

interface ReactionSet {
  say: string[];
  emotion: Emotion;
  action: PetAction;
}

const BY_SPECIES: Record<SpeciesId, Record<CareKind, ReactionSet>> = {
  mocha: {
    feed: { say: ['もぐもぐ…おいしいの', 'これ すきなやつ！', 'ごしゅじん、ありがと'], emotion: 'happy', action: 'eat' },
    play: { say: ['あそぶ！あそぶ！', 'それ とって いい？', 'たのしいの'], emotion: 'excited', action: 'play' },
    clean: { say: ['くすぐったいよ…', 'ふわふわに なった', 'きもちいいの'], emotion: 'happy', action: 'wash' },
    pet: { say: ['えへへ', 'もっと なでて', 'ごしゅじんの て、あったかい'], emotion: 'happy', action: 'nuzzle' },
  },
  pome: {
    feed: { say: ['やった！ごはん！', 'はやく はやく！', 'もぐ！うまい！'], emotion: 'excited', action: 'eat' },
    play: { say: ['きたきた！いくよ！', 'とんでけー！', 'まだ やる！'], emotion: 'excited', action: 'play' },
    clean: { say: ['うわっ、つめたい！', 'まあ いいけど', 'ぴかぴかだ！'], emotion: 'curious', action: 'wash' },
    pet: { say: ['もっと！', 'そこ そこ！', 'あんた やるじゃん'], emotion: 'happy', action: 'nuzzle' },
  },
  nimbus: {
    feed: { say: ['…いただこう', 'きみの手はあたたかいな', 'ふむ、悪くない'], emotion: 'happy', action: 'eat' },
    play: { say: ['少しだけなら', 'ふわり…', 'きみは元気だな'], emotion: 'curious', action: 'play' },
    clean: { say: ['…ん、すこし冷たい', 'きれいになったようだ', 'ありがとう'], emotion: 'happy', action: 'wash' },
    pet: { say: ['……ふう', 'そのまま、もう少し', 'きみがいると しずかだ'], emotion: 'happy', action: 'nuzzle' },
  },
};

/** 拗ねているとき（mood が低い）は世話しても素直に喜ばない。 */
const SULKY_BY_SPECIES: Record<SpeciesId, string[]> = {
  mocha: ['……いまは いいの', 'ずっと ひとりだった', 'ふん'],
  pome: ['おそいよ！', 'いまさら？', 'ふーん'],
  nimbus: ['……ずいぶん待った', 'いま来たのか', 'ふ、そうか'],
};

/** たまごはまだ言葉を話せないので、音と揺れだけを返す。 */
const EGG_REACTIONS = ['こつん…こつん', 'ぷるぷる ゆれている', 'ころん…と かたむいた', 'なかで なにかが うごいた'];

export function localReaction(
  species: SpeciesId,
  kind: CareKind,
  mood: number,
  pick: (length: number) => number = (length) => Math.floor(Math.random() * length),
  stage: GrowthStage = 'child',
): { say: string; emotion: Emotion; action: PetAction } {
  if (stage === 'egg') {
    return { say: EGG_REACTIONS[pick(EGG_REACTIONS.length)], emotion: 'curious', action: 'idle' };
  }
  if (mood < 25) {
    const options = SULKY_BY_SPECIES[species];
    return { say: options[pick(options.length)], emotion: 'sulky', action: 'sulk_corner' };
  }
  const set = BY_SPECIES[species][kind];
  return { say: set.say[pick(set.say.length)], emotion: set.emotion, action: set.action };
}

/** LLM が落ちているときの会話フォールバック。ペットらしさは保つ。 */
const CHAT_FALLBACK: Record<SpeciesId, string[]> = {
  mocha: ['……（じっと 見ている）', 'うにゅ？', 'よく わかんないけど、そばにいる'],
  pome: ['ん？なんだって？', 'いま ねむい！', 'あとで きく！'],
  nimbus: ['……（首をかたむけた）', 'いまは 言葉が出ない', 'そばにいるよ'],
};

export function chatFallback(
  species: SpeciesId,
  pick: (length: number) => number = (length) => Math.floor(Math.random() * length),
): string {
  const options = CHAT_FALLBACK[species];
  return options[pick(options.length)];
}
