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

// ───────── 僚機の被弾段階 (T1-②) ─────────
//
// 「被弾した」で終わらせず、シールド喪失 → 装甲被弾 → ハル危険域 と段階を踏ませる。
// プレイヤーが助けに行く判断をできるよう、どこまで削られたかを言葉に出す。

const WING_SHIELD_DOWN: LineSet = {
  reckless: ['シールドが飛んだ！まだやれる！', 'シールドが落ちた。構わん、続ける。'],
  steady: ['シールドが落ちました。次は装甲に来ます。', 'シールド喪失。距離を取ります。'],
  precise: ['シールドが落ちた。被弾すれば装甲に通る。', 'シールド 0。射線から抜ける。'],
  veteran: ['シールドを持っていかれた。まだ死なんがな。', 'シールドが落ちた。少し下がる。'],
  grim: ['……シールドが落ちた。次で装甲だ。', 'シールドが無い。まずいな。'],
  green: ['シールドが、シールドが落ちました！', 'えっ、シールド 0 です！どうすれば！'],
};

const WING_ARMOR_HIT: LineSet = {
  reckless: ['装甲に通った！だが逃げないぞ！', '穴が空いた。まだ飛べる！'],
  steady: ['装甲に被弾。支援をお願いします。', '装甲を削られました。剥がしてください。'],
  precise: ['装甲に通った。後方の一機を頼む。', '装甲被弾。単独では外せない。'],
  veteran: ['装甲を抜かれた。手を貸してくれ。', '老いた腕でもかわせなかった。装甲に通った、頼む。'],
  grim: ['装甲に通った。……長くはない。', '削られている。誰か。'],
  green: ['当てられました、装甲に！助けてください！', '装甲に穴が！怖い、助けて！'],
};

const WING_CRITICAL: LineSet = {
  reckless: ['船体まで来た！おい、笑えないぞ！', 'もう装甲が無い！誰か引き剥がせ！'],
  steady: ['船体に被弾。もう持ちません、支援を！', '限界です。助けてください！'],
  precise: ['船体残量 わずか。離脱するか、支援を要請する。', '致命域だ。引き剥がしてくれ、今すぐ。'],
  veteran: ['ここまでか……いや、まだだ！手を貸せ！', '船体に来た。長くは飛べん。'],
  grim: ['……名前が増える。俺の番か。', '船体だ。もう駄目かもしれない。'],
  green: ['もう駄目です、助けて、助けてください！', '船体に、船体に来てます！誰か！'],
};

export function wingmanShieldDownLine(personality: PersonalityId): string {
  return pick(WING_SHIELD_DOWN, personality);
}
export function wingmanArmorLine(personality: PersonalityId): string {
  return pick(WING_ARMOR_HIT, personality);
}
export function wingmanCriticalLine(personality: PersonalityId): string {
  return pick(WING_CRITICAL, personality);
}

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

// ───────── 酒場の往復会話 (T3-⑪) ─────────
//
// 1行で終わる雑談を「近況 → こちらの返事 → 相手の反応 → 返事 → 締め」の
// 2往復にするための素材。会話の組み立ては `src/app/barTalk.ts` が行う。
//
// **ここは rng を使わない。** 同じ画面を開き直すたびに文章が変わると、
// 選んだ返事で何が変わったのか読めなくなる（テストも固定できない）。
// 台詞の揺らぎは呼び出し側が渡す `seed` で決める。

/**
 * 会話の話題。直前の出撃で「その人に何が起きたか」で決まる。
 * `thanks` / `silent` は僚機として飛んだ人にしか起きない。
 */
export type BarTalkTopic =
  /** 助けを求めて、応えてもらった */
  | 'thanks'
  /** 助けを求めたのに、来てもらえなかった */
  | 'silent'
  /** 一緒に飛んで、無事に帰った */
  | 'flown'
  /** プレイヤーが機体を失って帰投した */
  | 'playerLoss'
  /** 直近で戦死者が出た */
  | 'mourning'
  /** 関係が良い相手の雑談 */
  | 'friendly'
  /** 関係が悪い相手の雑談 */
  | 'cold'
  /** それ以外の雑談 */
  | 'idle';

/** プレイヤーの返事の色。bond の動き方が変わる。 */
export type BarReplyKind = 'warm' | 'blunt';

function pickAt(set: LineSet, id: PersonalityId, seed: number): string {
  const lines = set[id] ?? set.steady;
  const i = ((Math.trunc(seed) % lines.length) + lines.length) % lines.length;
  return lines[i];
}

const BAR_THANKS: LineSet = {
  reckless: ['あんた、あの位置から突っ込んできたな。……助かった。', '借りができた。返すのは次の出撃でいいか。'],
  steady: ['あの時、支援に来てくれましたね。……ありがとうございます。', '呼んで、来てもらえた。それだけで次も飛べます。'],
  precise: ['要請から応答まで十数秒だった。記録に残しておく。', 'あなたが射線を切ってくれた。だから外さずに済んだ。'],
  veteran: ['年寄りを拾いに来たか。恩に着る。', 'あの角度で入るのは無理だと思ったがな。助かった。'],
  grim: ['……来てくれた。名前が増えずに済んだ。', '呼べば誰かが来る。久しぶりの感覚だ。'],
  green: ['助けてくれて、ありがとうございました！ 本当に、駄目かと……。', 'あの時のこと、まだ手が震えてます。でも生きてます。'],
};

const BAR_SILENT: LineSet = {
  reckless: ['……。話すことはない。', '次は自分で何とかする。あんたは呼ばない。'],
  steady: ['……支援を要請しました。届いていましたか。', '責めていません。ただ、覚えているだけです。'],
  precise: ['応答はなかった。事実として記録した。', '次は単独で処理する。その方が確実だ。'],
  veteran: ['見捨てるなら、最初からそう言え。', '……酒はいい。今日は一人で飲む。'],
  grim: ['……呼んだんだが。', '順番が来ただけだ。あなたのせいでは、ない。'],
  green: ['あの、聞こえてましたか。……いえ、いいんです。', '……すみません。何でもないです。'],
};

const BAR_FLOWN: LineSet = {
  reckless: ['さっきの出撃、悪くなかったな。次はもっと前に出るぞ。', '編隊は退屈だが、まあ数は稼げた。'],
  steady: ['さきほどの出撃、無事に戻れて何よりです。', '飛行記録を提出してきました。異常なしです。'],
  precise: ['交戦記録を突き合わせたい。あの旋回、意図があったのか。', '燃料消費が想定より多い。次は配分を変える。'],
  veteran: ['お前の翼は落ち着いている。付いていける。', '飛んだ後の酒が一番うまい。座れ。'],
  grim: ['……今日は誰も欠けなかった。珍しい日だ。', '無事に戻った。それを疑う癖がついてしまった。'],
  green: ['さっきの飛び方、教えてください！ あの、旋回のときの……。', '足を引っ張ってませんでしたか。正直に言ってください。'],
};

const BAR_PLAYER_LOSS: LineSet = {
  reckless: ['機体を捨てて帰ってきたって？ 生きてるならいい。', '派手にやったな。整備班が泣いてたぞ。'],
  steady: ['脱出したと聞きました。……ご無事で何よりです。', '機体は替えが来ます。あなたの替えは来ません。'],
  precise: ['脱出の判断は適切だった。時機としては最適だ。', '機体喪失は記録に残る。だが名前が残る方が重い。'],
  veteran: ['落ちたか。俺は三回だ。まだ足りん。', '生きて降りてきたなら、それが勝ちだ。'],
  grim: ['……あなたの名前を書きかけた。消せてよかった。', '座席だけでも帰ってきた。それでいい。'],
  green: ['脱出したって聞いて、心臓が止まりました！', 'ご無事ですか、本当に？ お怪我は？'],
};

const BAR_TO_WARM: LineSet = {
  reckless: ['……ふん。悪い気はしないな。', 'あんた、案外いい奴だな。'],
  steady: ['……ありがとうございます。少し楽になりました。', 'そう言ってもらえると、次も呼べます。'],
  precise: ['了解した。想定より前向きな返答だ。', 'その言葉は記録しない。覚えておくだけにする。'],
  veteran: ['お前とは飲める。座れ、注いでやる。', 'いい返しだ。若いのに聞かせたい。'],
  grim: ['……そうか。少しだけ、息がしやすくなった。', 'その言葉は持っていく。次の出撃に。'],
  green: ['は、はい！ ありがとうございます！', 'うれしいです。……本当に。'],
};

const BAR_TO_BLUNT: LineSet = {
  reckless: ['……つれないな。まあいい。', 'そういう奴だと思ってたよ。'],
  steady: ['……はい。失礼しました。', '分かりました。余計なことを言いました。'],
  precise: ['理解した。要点だけにする。', '了解。無駄な会話は削る。'],
  veteran: ['まあ、そういう時もある。飲め。', '若い頃の俺と同じ返しだ。後で効くぞ、それは。'],
  grim: ['……そうだな。話しても減らない。', '分かった。黙っている。'],
  green: ['……あ、はい。すみません。', 'そう、ですよね。お邪魔しました。'],
};

const BAR_CLOSE_WARM: LineSet = {
  reckless: ['次は俺を連れて行けよ。翼に付く。', '奢りだ。次の出撃で返してもらう。'],
  steady: ['では、また。次も左後方にいます。', 'お休みなさい。明日も付いていきます。'],
  precise: ['次の出撃で位置を合わせる。以上だ。', 'good night。射線は空けておく。'],
  veteran: ['生きて戻れ。俺も戻る。', '寝ろ。飛ぶ前の睡眠は装甲より効く。'],
  grim: ['……また、ここで会えるように。', '名前を増やさないでくれ。あなたの分も。'],
  green: ['次の出撃、よろしくお願いします！', 'おやすみなさい！ 明日、がんばります！'],
};

const BAR_CLOSE_BLUNT: LineSet = {
  reckless: ['行けよ。俺はもう一杯飲む。', 'ああ、勝手にする。'],
  steady: ['では、失礼します。明日も飛びます。', '……はい。お休みなさい。'],
  precise: ['以上。整備の報告に戻る。', '了解。時間を取らせた。'],
  veteran: ['行け。年寄りは残って飲む。', 'ふん。まあ、そんなもんだ。'],
  grim: ['……ああ。', '分かった。'],
  green: ['あ、はい。……お休みなさい。', 'し、失礼します。'],
};

const OPENING_SETS: Record<Exclude<BarTalkTopic, 'mourning'>, LineSet> = {
  thanks: BAR_THANKS,
  silent: BAR_SILENT,
  flown: BAR_FLOWN,
  playerLoss: BAR_PLAYER_LOSS,
  friendly: BAR_FRIENDLY,
  cold: BAR_COLD,
  idle: BAR_NEUTRAL,
};

/** 1往復目の近況。`mourning` のときだけ戦死者名を差し込む。 */
export function barOpeningLine(
  personality: PersonalityId,
  topic: BarTalkTopic,
  seed: number,
  fallenName?: string,
): string {
  if (topic === 'mourning') {
    return pickAt(BAR_ABOUT_FALLEN, personality, seed).replace('{name}', fallenName ?? '彼');
  }
  return pickAt(OPENING_SETS[topic], personality, seed);
}

/** プレイヤーの返事を受けた相手の反応（2往復目の頭） */
export function barResponseLine(personality: PersonalityId, kind: BarReplyKind, seed: number): string {
  return pickAt(kind === 'warm' ? BAR_TO_WARM : BAR_TO_BLUNT, personality, seed);
}

/** 会話の締め（最後の返事を受けた1行） */
export function barClosingLine(personality: PersonalityId, kind: BarReplyKind, seed: number): string {
  return pickAt(kind === 'warm' ? BAR_CLOSE_WARM : BAR_CLOSE_BLUNT, personality, seed);
}

/**
 * プレイヤー側の返事の文。
 *
 * 1往復目は話題に噛み合う言葉を出す（謝る／記録に留める など）。
 * 2往復目は話題に依らない締めの2択。
 */
const REPLY_LABELS_1: Record<BarTalkTopic, Record<BarReplyKind, string>> = {
  thanks: { warm: '当然だ。次も必ず行く。', blunt: '任務の範囲でやったことだ。' },
  silent: { warm: '悪かった。届いていたのに、行けなかった。', blunt: 'あの時は、他を守る方が先だった。' },
  flown: { warm: 'よく付いてきてくれた。助かった。', blunt: 'report は読んだ。以上だ。' },
  playerLoss: { warm: '心配させたな。次はちゃんと帰る。', blunt: '機体は替えが来る。問題ない。' },
  mourning: { warm: '名前は忘れない。俺も覚えている。', blunt: '悼むのは、任務が終わってからだ。' },
  friendly: { warm: 'その話、もう少し聞かせてくれ。', blunt: '用件だけでいい。' },
  cold: { warm: '言いたいことがあるなら、聞く。', blunt: '不満は報告書に書いてくれ。' },
  idle: { warm: 'その話、もう少し聞かせてくれ。', blunt: '用件だけでいい。' },
};

const REPLY_LABELS_2: Record<BarReplyKind, string> = {
  warm: 'もう一杯付き合う。',
  blunt: 'そろそろ戻る。明日も飛ぶ。',
};

/** `round` は 1 が1往復目の返事、2 が2往復目の返事 */
export function barReplyLabel(topic: BarTalkTopic, round: 1 | 2, kind: BarReplyKind): string {
  return round === 1 ? REPLY_LABELS_1[topic][kind] : REPLY_LABELS_2[kind];
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
