import type { PersonalityId } from './pilots';

/**
 * ブリーフィングの質疑（本家の「Yes, commander. What are we to do if we
 * encounter the enemy?」に相当する一幕）。
 *
 * 艦長の説明が終わったあと、僚機が一つだけ質問する。プレイヤーの答えで
 * 僚機の返しが変わり、発艦前の一言が決まる。
 *
 * ■ この一幕は数値を動かさない
 * 4状態（帰還者／航路信頼／軍令信用／敵エースの誓約）も関係値（bond）も、
 * 敵の強さも搭載兵装も変えない。ブリーフィングは何度でも開き直せるので、
 * ここに数値を置くと同じ答えを選び続けて稼げてしまう。
 * 変わるのは**言葉だけ**であり、隊の空気を出撃前に決めるためのものである。
 */

/** 答えの姿勢。台詞の選び方だけに使う */
export type BriefingStance = 'orders' | 'lives' | 'kills';

export interface BriefingAnswer {
  /** 安定キー */
  stance: BriefingStance;
  /** プレイヤーの答え */
  label: string;
}

export interface BriefingQuestion {
  /** 僚機の質問 */
  text: string;
  answers: BriefingAnswer[];
}

/** 三択の文面は全性格で共通（隊長としての方針表明なので、言い方は変えない） */
const ANSWERS: readonly BriefingAnswer[] = [
  { stance: 'orders', label: '命令どおりに飛ぶ。判断は私が持つ。' },
  { stance: 'lives', label: '拾える者を拾う。数は後で数える。' },
  { stance: 'kills', label: '落とせる相手は落とす。次に楽になる。' },
];

/**
 * 性格ごとの質問。同じ任務でも、誰を連れるかで訊かれることが変わる。
 * 「訊いてから飛ぶ」のが僚機の側の性格表現になっている。
 */
const QUESTIONS: Record<PersonalityId, string> = {
  reckless: '一つだけ。敵に出会ったら、こっちから行っていいのか。',
  steady: '確認します。持ち場を離れる条件は、隊長の指示だけですか。',
  precise: '一点だけ。撃つ順番の優先は、こちらで決めていいんですね。',
  veteran: '訊いておく。今日は何を持って帰れば合格なんだ。',
  grim: '一つ。帰ってこられなかった者の名前は、誰が書くんですか。',
  green: 'あの……こういう時って、まず何を見ればいいんでしょうか。',
};

/** 答えに対する僚機の返し。性格 × 姿勢で決まる */
const REPLIES: Record<PersonalityId, Record<BriefingStance, string>> = {
  reckless: {
    orders: 'わかった。前に出たくなったら、あんたの声を先に聞く。',
    lives: '拾うのか。……いいよ。掩護は俺がやる。',
    kills: 'それでいい。今日は数えられる日になる。',
  },
  steady: {
    orders: '了解。指示があるまで、私は持ち場から動きません。',
    lives: '了解。救難の間、私は撃たれる側に立ちます。',
    kills: '……了解。ただ、守るものの前からは離れません。',
  },
  precise: {
    orders: '了解。優先順は隊長の判断に合わせます。',
    lives: '了解。まず生存者の位置を洗って、順番を作ります。',
    kills: '了解。近いものから確実に落とします。',
  },
  veteran: {
    orders: 'いい答えだ。迷う役はあんたが持て。こっちは手を動かす。',
    lives: '合格の線がはっきりした。名前を持って帰るぞ。',
    kills: '数か。……悪くはない。ただ、機体は替えが効く。お前は効かない。',
  },
  grim: {
    orders: '……わかりました。書く人がいるなら、それでいい。',
    lives: 'あなたがそう言うなら、今日は名簿が短くなる。',
    kills: '名前より数を、ですか。……了解しました。覚えておきます。',
  },
  green: {
    orders: 'は、はい！ 隊長の声を聞きます。それなら、できます。',
    lives: '救うほう……はい、そっちなら訓練でやりました！',
    kills: 'わ、わかりました。深追いはしません。……しないつもりです。',
  },
};

export function briefingQuestion(personality: PersonalityId): BriefingQuestion {
  return { text: QUESTIONS[personality], answers: [...ANSWERS] };
}

export function briefingReply(personality: PersonalityId, stance: BriefingStance): string {
  return REPLIES[personality][stance];
}
