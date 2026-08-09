import { rng } from '../core/rng';
import type { PersonalityId } from './pilots';
import type { WingmanOrder } from '../world/entity';

/**
 * 性格ごとの台詞。
 *
 * 同じ「了解」でも、堅実なパイロットと無鉄砲なパイロットで言い方が違う。
 * ここを分けるだけで僚機が「人」に見えてくる。
 */

type LineSet = Record<PersonalityId, string[]>;

function pick(set: LineSet, id: PersonalityId): string {
  const lines = set[id] ?? set.steady;
  return rng.pick(lines);
}

// ───────── オーダーへの応答 ─────────

const ACK_FORM: LineSet = {
  reckless: ['……はいはい、翼に戻るよ。', '窮屈だな。まあいい、付いていく。', '分かった分かった、編隊だ。'],
  steady: ['了解、翼に付く。', 'フォーメーションに戻ります。', '編隊、リード了解。'],
  precise: ['編隊位置に入る。', '了解。左後方に付く。', '間隔を取って追従する。'],
  veteran: ['了解だ、リーダー。', '若いのを待たせるな。付いていく。', '翼に戻る。無理はするな。'],
  grim: ['……了解。近くにいる方がいい。', '離れると死ぬ。付いていく。', '編隊に戻る。'],
  green: ['りょ、了解です！', '編隊、入ります！位置これで合ってますか？', 'はい、付いていきます！'],
};

const ACK_ATTACK_TARGET: LineSet = {
  reckless: ['そいつは俺のだ！', 'やっと撃たせてくれるのか。', '了解、獲物を横取りするぞ。'],
  steady: ['その目標を狙います。', '了解、あなたの目標へ。', 'ロックした。仕留めます。'],
  precise: ['目標を確認。攻撃に入る。', '了解、同一目標。射線を分ける。', '掛かる。射線に入らないでくれ。'],
  veteran: ['そいつか。任せろ。', '了解、狙いを合わせる。', '見えている。落とす。'],
  grim: ['……了解。あれを消す。', '一機減らす。それだけだ。', '了解した。'],
  green: ['あの機体ですね、行きます！', '了解、狙います……当たるかな。', 'は、はい！攻撃します！'],
};

const ACK_BREAK: LineSet = {
  reckless: ['待ってた！好きにやらせてもらう！', 'ブレイク！ようやくだ！', 'はは、自由射撃だ！'],
  steady: ['ブレイク、各自交戦します。', '了解、散開。', '散開して当たります。'],
  precise: ['散開する。互いの射線に注意。', 'ブレイク。区域を分ける。', '了解、各自で処理する。'],
  veteran: ['散開だな。深追いはするなよ。', '了解。背中は見ておく。', 'ブレイク。生きて戻れ。'],
  grim: ['……散開。孤立はしたくないが。', '了解した。近くにはいる。', 'ブレイクする。'],
  green: ['え、単独で……了解です！', '散開、了解！が、がんばります！', 'はい！やってみます！'],
};

const ACK_HELP: LineSet = {
  reckless: ['来てくれるのか。まあ助かる。', '要らないと言いたいが……頼む。', '早くしろ！'],
  steady: ['助かります、こちらへ。', 'お願いします、引き剥がせない。', '感謝します。'],
  precise: ['支援を要請する。座標を送る。', '助かる。背後を頼む。', '一機引き受けてくれ。'],
  veteran: ['年寄りを助けに来たか。ありがたい。', '任せる。左を頼む。', '感謝する。'],
  grim: ['……来てくれたか。', '助かる。もう駄目だと思った。', '恩に着る。'],
  green: ['助けてください、後ろに付かれてます！', 'お願いします、振り切れません！', 'す、すみません！'],
};

export function ackLine(personality: PersonalityId, order: WingmanOrder): string {
  switch (order) {
    case 'form':
      return pick(ACK_FORM, personality);
    case 'attack-my-target':
      return pick(ACK_ATTACK_TARGET, personality);
    case 'break-and-attack':
      return pick(ACK_BREAK, personality);
    default:
      return pick(ACK_HELP, personality);
  }
}

// ───────── 状況台詞 ─────────

const DISOBEY: LineSet = {
  reckless: ['見えた！行くぞ！', '悪いな、待てない！', '一機くらい構わないだろ！'],
  steady: ['……失礼、目の前に来ました。交戦します。', '離れます、目標が近い。'],
  precise: ['交戦距離に入った。編隊を解く。', '目標が近い。処理する。'],
  veteran: ['勘だ。行かせてもらう。', '目の前のを片付ける。'],
  grim: ['来てしまった。やるしかない。'],
  green: ['あ、あの、来ました！撃ちます！'],
};

const TROUBLE: LineSet = {
  reckless: ['まずい、こいつ速い！', 'ちょっと手を貸せ！', '背中が痛い！'],
  steady: ['被弾しました、背後を取られています！', '引き剥がせません、支援を！'],
  precise: ['後方に一機。振り切れない。支援を要請する。', 'シールドが落ちた。手を貸してくれ。'],
  veteran: ['年貢の納め時か……手を貸せ！', '背後だ、頼む！'],
  grim: ['……終わりかもしれない。誰か。', '駄目だ、外せない。'],
  green: ['助けて！後ろ、後ろです！', '当てられてます、どうすれば！'],
};

const KILL: LineSet = {
  reckless: ['見たか！', 'はは、次！', '一機貰った！'],
  steady: ['撃墜確認。', '一機、落としました。', 'よし。'],
  precise: ['撃墜。次の目標へ移る。', '一機減った。', '処理完了。'],
  veteran: ['まだ腕は落ちてないな。', '一機。', 'ふん、遅い。'],
  grim: ['……一機。', '減った。それだけだ。'],
  green: ['当たった！当たりました！', 'やった、初撃墜です！'],
};

const PLAYER_KILL_PRAISE: LineSet = {
  reckless: ['やるな、リーダー。', '悪くない。次は俺が先だ。'],
  steady: ['見事です。', 'ナイスショット、リーダー。'],
  precise: ['正確だった。', 'good kill。'],
  veteran: ['いい腕だ。生き延びるぞ、それなら。', '筋がいい。'],
  grim: ['……そうやって数が増える。', '一機減った。ありがたい。'],
  green: ['すごい、あんな角度から！', '今の、どうやったんですか！'],
};

const MOURN: LineSet = {
  reckless: ['……嘘だろ。あいつが。', '冗談じゃない。あんな奴が落ちるか。'],
  steady: ['……手を合わせます。', 'こんなことになるとは。'],
  precise: ['……記録しておく。', '一人、欠けた。'],
  veteran: ['また一人だ。慣れることはない。', '見送るのは何度目だろうな。'],
  grim: ['……名前が増えた。全部覚えている。', 'また、だ。'],
  green: ['……嘘、ですよね。', 'さっきまで話してたのに。'],
};

export function disobeyLine(personality: PersonalityId): string {
  return pick(DISOBEY, personality);
}
export function troubleLine(personality: PersonalityId): string {
  return pick(TROUBLE, personality);
}
export function killLine(personality: PersonalityId): string {
  return pick(KILL, personality);
}
export function praiseLine(personality: PersonalityId): string {
  return pick(PLAYER_KILL_PRAISE, personality);
}
export function mournLine(personality: PersonalityId): string {
  return pick(MOURN, personality);
}

// ───────── 酒場の会話 ─────────

export interface BarLine {
  /** 話し手 (パイロット id) */
  speaker: string;
  text: string;
}

/** 関係値ごとの雑談 */
const BAR_NEUTRAL: LineSet = {
  reckless: [
    'なあ、次は俺を連れて行けよ。あんたと飛ぶと数が稼げる。',
    '整備班に怒られた。また機体を擦ったらしい。知らんな。',
  ],
  steady: [
    '無事に戻ってこられて何よりです。……次も、そうであるように。',
    '故郷から手紙が来ました。まだ空は青いそうです。',
  ],
  precise: [
    '交戦記録を見返している。あの角度は無理があった。次は変える。',
    '酒は一杯だけだ。明日も飛ぶ。',
  ],
  veteran: [
    '若いのが増えたな。名前を覚える前に減っていく。',
    '座って飲め。生きてる間しか飲めん。',
  ],
  grim: [
    '……七人だ。この艦で見送った数。数えるのをやめられない。',
    '祈っても減らないが、祈らないともっと減る気がする。',
  ],
  green: [
    'さっきの飛び方、教えてください！あの、旋回のときの……。',
    'まだ一機も落とせてないんです。足を引っ張ってませんか。',
  ],
};

const BAR_FRIENDLY: LineSet = {
  reckless: [
    'あんたには借りがある。まあ、返さないけどな。……いや、返すよ。',
    'あんたの翼なら付いていく。他の奴のは無理だ。',
  ],
  steady: [
    'あの時、助けに来てくれたでしょう。……忘れません。',
    'あなたと組むと、帰れる気がします。理屈じゃなく。',
  ],
  precise: [
    'あなたの判断は速い。私が撃つ前に射線が空いている。',
    '信頼している。次も左後方に付く。',
  ],
  veteran: [
    'お前と飛ぶのは楽だ。背中を心配しなくていい。',
    '生き延びろよ。お前が落ちたら、この隊は終わりだ。',
  ],
  grim: [
    'あなたが来てくれた。……名前を増やさずに済んだ。',
    'まだ祈っている。今度はあなたのために。',
  ],
  green: [
    '憧れてます。あの、真面目に。',
    'あなたに助けてもらった話、みんなにしました。',
  ],
};

const BAR_COLD: LineSet = {
  reckless: [
    'あの時どこにいた？俺が呼んだのに来なかったよな。',
    '次は自分で何とかする。あんたは頼りにならん。',
  ],
  steady: [
    '……あの時、支援を要請しました。届いていましたか。',
    '責めているわけではありません。ただ、覚えているだけです。',
  ],
  precise: [
    '要請への応答が遅い。記録に残してある。',
    '次は自分で処理する。その方が確実だ。',
  ],
  veteran: [
    '見捨てるなら、最初からそう言え。',
    '若い頃は俺もそうだった。だが後で効くぞ、それは。',
  ],
  grim: [
    '……呼んだんだが。まあ、いい。',
    'あなたも、いつか誰かに見捨てられる。',
  ],
  green: [
    'あの、助けを呼んだんですけど……聞こえてました？',
    'すみません、責めてるんじゃないんです。ただ、怖かったので。',
  ],
};

/** 戦死者について語る台詞 */
const BAR_ABOUT_FALLEN: LineSet = {
  reckless: ['{name} のことは考えないようにしてる。考えたら飛べない。'],
  steady: ['{name} の席が空いています。片付ける気になれません。'],
  precise: ['{name} の交戦記録を読んだ。判断は正しかった。運が悪かっただけだ。'],
  veteran: ['{name} は俺より長く飛んでた。順番が違う。'],
  grim: ['{name}。名簿に書いた。これで八人目だ。'],
  green: ['{name} さん、優しかったです。……信じられません。'],
};

export type BarMood = 'neutral' | 'friendly' | 'cold' | 'mourning';

export function barLine(
  personality: PersonalityId,
  mood: BarMood,
  fallenName?: string,
): string {
  if (mood === 'mourning' && fallenName) {
    return pick(BAR_ABOUT_FALLEN, personality).replace('{name}', fallenName);
  }
  if (mood === 'friendly') return pick(BAR_FRIENDLY, personality);
  if (mood === 'cold') return pick(BAR_COLD, personality);
  return pick(BAR_NEUTRAL, personality);
}

/** 戦況についての噂 (酒場で聞ける情報) */
const RUMORS = [
  '補給が遅れているらしい。ミサイルの割り当てが減るという話だ。',
  '偵察が言うには、この宙域の敵はまだ増えるらしい。',
  'キルラシーのエースが名前を集めているそうだ。撃墜した相手の名を刻むとか。',
  '灰冠回廊の連中は、決闘の間だけ砲を止めるらしい。信じるかは別だが。',
  '帝国にも協定を守る家と、急ぎたがる家があるそうだ。撃つ前に無線を聞け、と。',
  '拾った敵の名が、向こうの公式記録に残った奴がいるらしい。',
  '艦の跳躍機関が渋っているらしい。整備班が徹夜している。',
  '本国から増援が来るという話は、もう三回聞いた。',
  '医務室が満杯だそうだ。無理に飛ぶなということらしい。',
];

export function rumor(): string {
  return rng.pick(RUMORS);
}
