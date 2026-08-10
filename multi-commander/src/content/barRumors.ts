/**
 * 酒場の噂（T8-②）。
 *
 * ■ なぜ必要か
 * これまで酒場の噂は `pilotDialogue.ts` の `RUMORS`（固定9件）から `rng.pick` で
 * 引くだけだった。章が変わっても、艦の状況が変わっても、同じ9件が無作為に出る。
 * つまり噂が「情報」ではなく「飾り」だった。
 *
 * このファイルは噂を **状況の関数** にする。章・4状態・戦死者/負傷者の有無で
 * 出る文が変わり、同じ状況なら同じ文が出る（＝プレイヤーが酒場を開き直しても
 * 話が飛ばない）。
 *
 * ■ 決定論
 * `rng` は使わない。`pilotDialogue.ts` の `pickAt` と同じ流儀で、呼び出し側が
 * seed（章番号・出撃回数など、その場面で固定される整数）を渡す。
 *
 * ■ 難易度には一切効かせない
 * `narrative.ts` の実装規約と同じ。噂は表示テキストだけを変える。
 *
 * ■ 既存の `rumor()` は残す
 * `pilotDialogue.ts` の `rumor()` は他から呼ばれているのでそのままにしてある。
 * このファイルは置き換えではなく、上位の経路として足すもの。
 */

import { PILOT_BOND_KINDS, bondBetween, type PilotBondKind } from './pilotBonds';
import { PILOTS, type PersonalityId } from './pilots';
import { veilPerson } from './veil/people';

// ───────── 酒保（バーテンダー） ─────────

/**
 * 艦の酒保係。
 *
 * **人物名簿（`veil/people.ts`）の `confed-21` / 七瀬 結衣（Iris）/ 補給調整官** を充てる。
 * 選んだ理由:
 * - 酒も食料も嗜好品も「補給」であり、艦内の酒保を回すのは補給調整官の職掌に無理なく収まる。
 * - 実績が「不足する燃料を再配分し、前線航空隊の活動を維持した」＝**数字で戦況を見ている人**。
 *   前線の増減・補給割当の変化を、飛ばない側から最初に知る立場にある。
 * - 戦闘級は4（B級）で飛行隊の8名より低い。戦果の話に加わらないので、
 *   「艦の内側から戦況を見ている中立の観察者」という口調が成立する。
 *
 * 新規人物は作らない（名簿が唯一の出所）。
 */
export const BARTENDER_PERSON_ID = 'confed-21';

/** 酒保の表示名。名簿から引くだけ（ここで名前を複製しない）。 */
export function bartenderName(): string {
  return veilPerson(BARTENDER_PERSON_ID).name;
}

/** 酒保の肩書（「補給調整官」）。名簿から引く。 */
export function bartenderRole(): string {
  return veilPerson(BARTENDER_PERSON_ID).role;
}

// ───────── 型 ─────────

export type RumorSource = 'bartender' | 'deckhand' | 'signals' | 'pilot';

export const RUMOR_SOURCE_LABELS: Record<RumorSource, string> = {
  bartender: '酒保',
  deckhand: '整備班',
  signals: '通信科',
  pilot: '他隊の搭乗員',
};

/**
 * 噂が出る条件。すべて省略可で、省略した項目は無条件。
 *
 * 4状態（`narrative.ts`）は 0..100。`*Below` は「その値を下回るとき」、
 * `*Above` は「その値を上回るとき」（どちらも境界値そのものでは成立しない）。
 * 帰還者は人数ではなく `returneeScore()` 相当の 0..100 を渡す想定。
 */
export interface RumorWhen {
  chapterMin?: number;
  chapterMax?: number;
  returneesBelow?: number;
  returneesAbove?: number;
  routeTrustBelow?: number;
  routeTrustAbove?: number;
  commandTrustBelow?: number;
  commandTrustAbove?: number;
  aceOathBelow?: number;
  aceOathAbove?: number;
  /** 戦死者が出ているか */
  hasFallen?: boolean;
  /** 負傷者がいるか */
  hasWounded?: boolean;
}

export interface Rumor {
  id: string;
  text: string;
  source: RumorSource;
  /** 出る条件。すべて省略可。省略した項目は無条件。 */
  when?: RumorWhen;
}

export interface RumorContext {
  chapter: number;
  gauges?: { returnees: number; routeTrust: number; commandTrust: number; aceOath: number };
  hasFallen?: boolean;
  hasWounded?: boolean;
}

// ───────── 条件判定 ─────────

/**
 * 条件に合うか。
 *
 * 4状態の条件を持つ噂は、`ctx.gauges` が無いときは **出さない**。
 * 「航路信頼が低いときの話」を、値が分からない場面で口にさせないため
 * （プレイヤーが知らない状況を噂が先に断定してしまうのを防ぐ）。
 */
export function whenMatches(when: RumorWhen | undefined, ctx: RumorContext): boolean {
  if (!when) return true;
  if (when.chapterMin !== undefined && ctx.chapter < when.chapterMin) return false;
  if (when.chapterMax !== undefined && ctx.chapter > when.chapterMax) return false;

  const g = ctx.gauges;
  const pairs: Array<[number | undefined, number | undefined, number | undefined]> = [
    [when.returneesBelow, when.returneesAbove, g?.returnees],
    [when.routeTrustBelow, when.routeTrustAbove, g?.routeTrust],
    [when.commandTrustBelow, when.commandTrustAbove, g?.commandTrust],
    [when.aceOathBelow, when.aceOathAbove, g?.aceOath],
  ];
  for (const [below, above, value] of pairs) {
    if (below === undefined && above === undefined) continue;
    if (value === undefined) return false;
    if (below !== undefined && !(value < below)) return false;
    if (above !== undefined && !(value > above)) return false;
  }

  if (when.hasFallen !== undefined && when.hasFallen !== (ctx.hasFallen === true)) return false;
  if (when.hasWounded !== undefined && when.hasWounded !== (ctx.hasWounded === true)) return false;
  return true;
}

/** seed から決定論的に添字を出す。負の seed も 0..len-1 に落とす。 */
function indexAt(len: number, seed: number): number {
  if (len <= 0) return 0;
  const s = Math.trunc(Number.isFinite(seed) ? seed : 0);
  return ((s % len) + len) % len;
}

// ───────── 噂の本体 ─────────

/**
 * 噂の一覧（46件）。
 *
 * 内訳:
 * - `legacy-*` … 既存 `pilotDialogue.ts` の `RUMORS` 9件を移植し、`when` を付けたもの。
 * - `ch01`〜`ch10` … 各章に1件以上。章の作戦（`veil/chapters.ts`）と噛み合う話。
 * - `low-*` / `high-*` … 4状態が低い/高いときだけ出る話。
 * - `fallen-*` / `wounded-*` … 戦死者・負傷者がいるときの話。
 * - `idle-*` … 無条件の雑談。
 *
 * 固有名詞は人物名簿・章データに出てくるものだけを使う（新規に捏造しない）。
 */
export const BAR_RUMORS: readonly Rumor[] = [
  // --- 既存9件の移植（when を付けて、出る場面を絞った） ---
  {
    id: 'legacy-supply',
    text: '補給が遅れているらしい。ミサイルの割り当てが減るという話だ。',
    source: 'deckhand',
    when: { commandTrustBelow: 55 },
  },
  {
    id: 'legacy-recon',
    text: '偵察が言うには、この宙域の敵はまだ増えるらしい。',
    source: 'signals',
  },
  {
    id: 'legacy-ace-names',
    text: 'キルラシーのエースが名前を集めているそうだ。撃墜した相手の名を刻むとか。',
    source: 'pilot',
    when: { chapterMin: 2 },
  },
  {
    id: 'legacy-ash-crown',
    text: '灰冠回廊の連中は、決闘の間だけ砲を止めるらしい。信じるかは別だが。',
    source: 'pilot',
    when: { chapterMin: 4 },
  },
  {
    id: 'legacy-houses',
    text: '帝国にも協定を守る家と、急ぎたがる家があるそうだ。撃つ前に無線を聞け、と。',
    source: 'signals',
    when: { chapterMin: 3 },
  },
  {
    id: 'legacy-record',
    text: '拾った敵の名が、向こうの公式記録に残った奴がいるらしい。',
    source: 'pilot',
    when: { aceOathAbove: 55 },
  },
  {
    id: 'legacy-jump',
    text: '艦の跳躍機関が渋っているらしい。整備班が徹夜している。',
    source: 'deckhand',
  },
  {
    id: 'legacy-reinforce',
    text: '本国から増援が来るという話は、もう三回聞いた。',
    source: 'bartender',
  },
  {
    id: 'legacy-sickbay',
    text: '医務室が満杯だそうだ。無理に飛ぶなということらしい。',
    source: 'deckhand',
    when: { hasWounded: true },
  },

  // --- 章に紐づく噂（十章それぞれ） ---
  {
    id: 'ch01-manifest',
    text: '〈アストラ・メイ〉の積荷目録、医療物資と書いてあったろう。固定されていたのは門制御核の断片だ。書いた奴がまだ名乗り出ていない。',
    source: 'deckhand',
    when: { chapterMin: 1, chapterMax: 2 },
  },
  {
    id: 'ch01-port',
    text: 'オリオン港の哨戒機を四機抜いた分、外周の索敵密度が三割落ちたままだ。キム・ソヨンはその数字を毎日出してきている。',
    source: 'signals',
    when: { chapterMin: 1, chapterMax: 3 },
  },
  {
    id: 'ch02-three',
    text: '拾った漂流者は三人で、三人とも別の敵に撃たれたと言っている。生体記録は完全に一致しているそうだ。',
    source: 'signals',
    when: { chapterMin: 2, chapterMax: 4 },
  },
  {
    id: 'ch02-delay',
    text: '味方の声は必ず遅れて届く。偽装された声は遅れない。小林 直子はそれだけを繰り返しているらしい。',
    source: 'pilot',
    when: { chapterMin: 2, chapterMax: 3 },
  },
  {
    id: 'ch02-drill',
    text: '演習名目の出撃に、脱出ポッドの回収装備が積まれていた。艦長は書類を見て一度確認しただけだと。',
    source: 'deckhand',
    when: { chapterMin: 2, chapterMax: 7 },
  },
  {
    id: 'ch03-corridor',
    text: '静穏海の中立回廊は、セレシオンが歌で維持しているらしい。回廊に入ったら砲を回すな、というのが向こうの作法だ。',
    source: 'signals',
    when: { chapterMin: 3, chapterMax: 5 },
  },
  {
    id: 'ch03-eighteen',
    text: '避難船十八隻、全部が満載だそうだ。撃たれたら中身がそのまま失われる。',
    source: 'bartender',
    when: { chapterMin: 3, chapterMax: 4 },
  },
  {
    id: 'ch04-strata',
    text: '深層採掘帯の岩盤は、オルドにとっては資源じゃなく記憶だそうだ。掘った跡が全部残っていると。',
    source: 'pilot',
    when: { chapterMin: 4, chapterMax: 6 },
  },
  {
    id: 'ch04-anchor',
    text: 'オルドの重力固定は、味方の機体まで同じだけ止める。使うなら事前に伝えろとアインが言ってきている。',
    source: 'signals',
    when: { chapterMin: 4, chapterMax: 8 },
  },
  {
    id: 'ch05-duel',
    text: '灰冠回廊で決闘規約が読み上げられたら、周りは撃たない。読み上げを無視した方が悪者になる。',
    source: 'pilot',
    when: { chapterMin: 5, chapterMax: 7 },
  },
  {
    id: 'ch05-radicals',
    text: '灰冠の近衛と急進派は同じ側で飛んでいて、話が合っていない。セイラクが押さえているうちだけが猶予だ。',
    source: 'signals',
    when: { chapterMin: 5, chapterMax: 8 },
  },
  {
    id: 'ch06-hive',
    text: '巣脈群のニューロウムは侵略しているんじゃなく、傷口を縫おうとしているらしい。縫い方が我々の流儀じゃないだけだと。',
    source: 'signals',
    when: { chapterMin: 6, chapterMax: 8 },
  },
  {
    id: 'ch06-sever',
    text: '共通記録層に一度繋いだら、切り離せないそうだ。繋ぐ命令と切る命令が同じ日に来ている。',
    source: 'deckhand',
    when: { chapterMin: 6, chapterMax: 7 },
  },
  {
    id: 'ch07-sixth',
    text: '五者通行協定に、署名されなかった六つ目の条項があったらしい。誰が消したかで話が変わる。',
    source: 'signals',
    when: { chapterMin: 7, chapterMax: 9 },
  },
  {
    id: 'ch07-notary',
    text: 'ヴェガ門の公証中継所へ搬送するデータの写しが、艦内に三つあるという話だ。数が合っていない。',
    source: 'bartender',
    when: { chapterMin: 7, chapterMax: 8 },
  },
  {
    id: 'ch08-minute',
    text: '通信灯台の回線が一本でも六十秒保てば、艦隊は引き返せる。全部落ちたら門が開く。それだけの話だ。',
    source: 'signals',
    when: { chapterMin: 8, chapterMax: 9 },
  },
  {
    id: 'ch08-five',
    text: '停戦の一分間に、五勢力全部が代表を出してくるらしい。同じ周波数に五つの言葉が乗る。',
    source: 'bartender',
    when: { chapterMin: 8, chapterMax: 8 },
  },
  {
    id: 'ch09-phase',
    text: '門の中は過去を保存しているんじゃない。選ばれなかった未来を反射しているそうだ。入った奴の話が毎回違う理由だと。',
    source: 'pilot',
    when: { chapterMin: 9, chapterMax: 10 },
  },
  {
    id: 'ch09-nine',
    text: '九分間の位相域では、こちらの九分と外の九分が合わない。戻ってきたら日付を確認しろと言われている。',
    source: 'signals',
    when: { chapterMin: 9, chapterMax: 10 },
  },
  {
    id: 'ch10-open-hand',
    text: '門前の最後の一戦は、勝つためじゃなく次に通る者のために撃つそうだ。艦長がそう言ったらしい。',
    source: 'bartender',
    when: { chapterMin: 10 },
  },
  {
    id: 'ch10-three-ends',
    text: '門の始末は三つの案が回っている。永久閉鎖、限定開放、五者共同管理。どれも誰かが損をする。',
    source: 'signals',
    when: { chapterMin: 10 },
  },

  // --- 4状態が低いときだけ出る噂 ---
  {
    id: 'low-returnees',
    text: '回収されなかったポッドの欄が、報告書に空白のまま並んでいる。書記が困っているそうだ。',
    source: 'deckhand',
    when: { returneesBelow: 40 },
  },
  {
    id: 'low-returnees-port',
    text: '港の民間人がこちらの機体番号を覚えなくなったと聞いた。覚える理由がなくなったんだろう。',
    source: 'bartender',
    when: { returneesBelow: 30 },
  },
  {
    id: 'low-route-trust',
    text: 'セレシオンの護衛船が回廊の外まで出てこなくなったらしい。呼んでも返事だけだと。',
    source: 'signals',
    when: { routeTrustBelow: 40 },
  },
  {
    id: 'low-route-trust-refugees',
    text: '避難民が連邦の輸送より第三勢力の船を選び始めたそうだ。運賃は向こうの方が高いのにな。',
    source: 'bartender',
    when: { routeTrustBelow: 35 },
  },
  {
    id: 'low-command-trust',
    text: '艦の出撃記録に、司令部の照合印が増えたらしい。一件ずつ見られているということだ。',
    source: 'deckhand',
    when: { commandTrustBelow: 40 },
  },
  {
    id: 'low-command-trust-ordnance',
    text: 'ミサイルの搭載上限が下げられたと聞いた。理由の欄には「照合中」としか書いていない。',
    source: 'deckhand',
    when: { commandTrustBelow: 30 },
  },
  {
    id: 'low-ace-oath',
    text: '儀礼周波が沈黙している。向こうが読み上げをやめたら、こちらの名前も控えられないということだ。',
    source: 'signals',
    when: { aceOathBelow: 40 },
  },
  {
    id: 'low-ace-oath-hunt',
    text: 'キルラシーの追跡が執拗になったらしい。名前ではなく番号で呼ばれ始めたと。',
    source: 'pilot',
    when: { aceOathBelow: 30 },
  },

  // --- 4状態が高いときだけ出る噂 ---
  {
    id: 'high-returnees',
    text: '医療区画に回した搭乗者の家族が、艦に礼状を送ってきたそうだ。艦務課が張り出している。',
    source: 'bartender',
    when: { returneesAbove: 60 },
  },
  {
    id: 'high-route-trust',
    text: 'セレシオンの船団指揮者が、こちらの航路計画に自分の観測値を足して返してきたらしい。あれは信用の印だと。',
    source: 'signals',
    when: { routeTrustAbove: 60 },
  },
  {
    id: 'high-command-trust',
    text: '司令部から兵装割当の上限緩和が来たそうだ。書類が一枚で済んだのは久しぶりだと整備班が笑っていた。',
    source: 'deckhand',
    when: { commandTrustAbove: 60 },
  },
  {
    id: 'high-ace-oath',
    text: 'ラギティカがこちらの機体番号を正確に読み上げてから撃ってくるらしい。名乗ってから殺すのが向こうの礼儀だと。',
    source: 'pilot',
    when: { aceOathAbove: 65 },
  },
  {
    id: 'high-ace-oath-ceasefire',
    text: '決闘の最中は周りの砲が本当に止まるのを、この目で見た奴がいるそうだ。',
    source: 'pilot',
    when: { aceOathAbove: 70, chapterMin: 5 },
  },

  // --- 戦死者・負傷者がいるときの噂 ---
  {
    id: 'fallen-locker',
    text: '空いた個室の私物を、艦務課がまだ箱に詰めていない。誰も催促していないからだ。',
    source: 'deckhand',
    when: { hasFallen: true },
  },
  {
    id: 'fallen-seat',
    text: 'ここのカウンターの端の席、誰も座らないだろう。片付けろと言う奴もいない。',
    source: 'bartender',
    when: { hasFallen: true },
  },
  {
    id: 'fallen-roster',
    text: '名簿の欄に線を引く仕事は、順番で回ってくる。今週は自分の番だと通信科の奴がこぼしていた。',
    source: 'signals',
    when: { hasFallen: true },
  },
  {
    id: 'wounded-bench',
    text: '医務室から「飛べる」と言って出てきた奴を、医療艇長が三回連れ戻したらしい。',
    source: 'deckhand',
    when: { hasWounded: true },
  },
  {
    id: 'wounded-replacement',
    text: '補充の申請が回っている。到着まで、席が空いたまま出撃表を組むことになる。',
    source: 'bartender',
    when: { hasWounded: true },
  },

  // --- 無条件の雑談 ---
  {
    id: 'idle-coffee',
    text: '合成珈琲の豆が切れて、代わりのが来た。前のより濃いが、味は誰も褒めていない。',
    source: 'bartender',
  },
  {
    id: 'idle-pool',
    text: '奥の玉突き台、右下がりに傾いているそうだ。整備班が測ったら本当に傾いていたらしい。',
    source: 'deckhand',
  },
  {
    id: 'idle-lights',
    text: '第三格納庫の照明が二番だけ切れている。部品はあるのに、順番待ちで三日目だ。',
    source: 'deckhand',
  },
  {
    id: 'idle-bet',
    text: '次の出撃で最初に帰ってくるのは誰か、賭けが立っているらしい。賭け金は珈琲一杯だ。',
    source: 'pilot',
  },
  {
    id: 'idle-music',
    text: '誰かが持ち込んだ録音が、休憩時間ずっと同じ曲を回している。文句を言う奴が出るまで続くだろう。',
    source: 'bartender',
  },
];

/**
 * 条件に合う噂を、決定論的に `count` 件返す（重複なし。足りなければあるだけ）。
 *
 * 選び方は `seed` を起点にした回転。seed を1つ動かすと並びが1つずれるので、
 * 同じ状況でも「別の日」には別の噂が出る。同じ引数なら必ず同じ結果になる。
 */
export function rumorsFor(ctx: RumorContext, seed: number, count: number = 3): Rumor[] {
  const eligible = BAR_RUMORS.filter((r) => whenMatches(r.when, ctx));
  if (eligible.length === 0) return [];
  const take = Math.max(0, Math.min(Math.trunc(count), eligible.length));
  const start = indexAt(eligible.length, seed);
  const out: Rumor[] = [];
  for (let i = 0; i < take; i += 1) out.push(eligible[(start + i) % eligible.length]);
  return out;
}

// ───────── 酒保の一行 ─────────

/**
 * 酒保が状況について言う一行。
 *
 * 噂（`BAR_RUMORS`）と分けてあるのは、こちらが**伝聞ではなく本人の観察**だから。
 * 補給調整官として自分が見ている数字の話をする。
 */
const BARTENDER_LINES: ReadonlyArray<{ text: string; when?: RumorWhen }> = [
  {
    text: 'いらっしゃい。今日の割当は一人二杯まで。文句は補給計画に言って。',
  },
  {
    text: '飲む前に一つ。次の出撃の燃料は確保してある。帰ってくる分もね。',
  },
  {
    text: '数字は正直よ。出撃前の在庫と帰ってきた後の在庫を並べると、その日に何があったか全部分かる。',
  },
  {
    text: '私は飛ばない。だから飛んだ人の顔だけ見ている。今日はまあ、悪くない顔ね。',
    when: { hasFallen: false, hasWounded: false },
  },
  {
    text: '医務室の分の水を先に回してある。無理をした人がいたということでしょう。',
    when: { hasWounded: true },
  },
  {
    text: 'グラスを一つ減らしたわ。増やす方が仕事なのに、これは慣れない。',
    when: { hasFallen: true },
  },
  {
    text: 'ミサイルの割当票を見た。減った分は誰かが決めた数字で、あなたのせいじゃない。',
    when: { commandTrustBelow: 45 },
  },
  {
    text: '司令部から追加割当が来た。書類が通るときは、あっさり通るものね。',
    when: { commandTrustAbove: 60 },
  },
  {
    text: '中立回廊からの補給が細っている。船が来ないんじゃなく、来たがらないの。',
    when: { routeTrustBelow: 40 },
  },
  {
    text: 'セレシオンの船が積荷を余分に置いていったわ。伝票にない分は、たぶん礼のつもり。',
    when: { routeTrustAbove: 60 },
  },
  {
    text: '救護区画の消耗が増えてる。それは、拾えた人がいるということよ。',
    when: { returneesAbove: 60 },
  },
  {
    text: '回収装備の在庫が動いていない。使わずに帰ってくる日は、静かすぎて落ち着かない。',
    when: { returneesBelow: 40 },
  },
  {
    text: '儀礼周波の録音を通信科が回してた。向こうがまだ読み上げているうちは、話が通じるということでしょう。',
    when: { aceOathAbove: 60 },
  },
  {
    text: '向こうの読み上げが止まったそうね。名前を控える相手がいなくなると、次は番号になる。',
    when: { aceOathBelow: 40 },
  },
  {
    text: '門の始末が決まるまで、在庫は三通り用意してある。どの結末でも艦は飯を食うから。',
    when: { chapterMin: 9 },
  },
  {
    text: '着任したばかりでしょう。名前は覚えた。飲む量も覚えるから、程々にね。',
    when: { chapterMax: 2 },
  },
];

/** 状況に合う酒保の一行を、決定論的に1つ返す。 */
export function bartenderLine(ctx: RumorContext, seed: number): string {
  const eligible = BARTENDER_LINES.filter((l) => whenMatches(l.when, ctx));
  const pool = eligible.length > 0 ? eligible : BARTENDER_LINES;
  return pool[indexAt(pool.length, seed)].text;
}

// ───────── 噂の伝播（プレイヤーの行動が別の隊員の口から出る） ─────────

/**
 * 酒場でのプレイヤーの行動の記録。
 *
 * 保存側（`RosterState` など）ではなくUI/セーブの都合で持つ値なので、
 * ここでは「読むだけの型」として定義する。
 */
export interface BarMemory {
  /** 直近に会話を終えた隊員 id（新しい順、最大4件） */
  talkedWith: string[];
  /** 直近に掛け合いへ介入したペアの鍵と、どちらに味方したか */
  intervened?: { bondKey: string; side: 'a' | 'b' | 'defuse' };
  /** 奢った相手の id（最新1件） */
  boughtDrink?: string;
}

/**
 * 話し手から見た、噂の対象の立場。
 *
 * - `favored` … プレイヤーがその相手に味方した
 * - `passed`  … プレイヤーが相手側に味方して、こちら側が立てられなかった
 * - `defused` … プレイヤーが二人をなだめた
 * - `treated` … プレイヤーがその相手に奢った
 * - `talked`  … プレイヤーがその相手と話していた
 */
type GossipStance = 'favored' | 'passed' | 'defused' | 'treated' | 'talked';

/**
 * 相関の種類 × 立場の文。`{name}` は噂の対象のコールサインに置き換える。
 *
 * 「相棒の話なら喜び、不和の相手を立てられたら不満を言う」——
 * 同じ出来事でも、話し手とその相手の間にある関係で意味が反転する。
 * ここが「登場人物が絡み合う」表示面の要なので、6種類すべてを埋めてある。
 */
const GOSSIP: Record<PilotBondKind, Record<GossipStance, readonly string[]>> = {
  mentor: {
    favored: [
      '{name}の側に立ってくれたそうだな。あれは伸びる。俺が言っても信じないから、あんたが言ってくれ。',
      '{name}を庇ったと聞いた。……甘いとは言わない。あの歳なら、まだ庇われていい。',
    ],
    passed: [
      '{name}を退かせたか。教えている側としては、面白くはない。理屈は分かるが。',
      '{name}の言い分は、俺が仕込んだものだ。否定されたのは、あいつじゃなく俺だな。',
    ],
    defused: [
      '間に入ってくれたか。あれは俺が引き下がる話だった。あんたに手間を掛けた。',
      '{name}と俺の話に割り込むとはな。……止めてもらって、正しかった。',
    ],
    treated: [
      '{name}に奢ったんだろう。あいつは酒に弱い。次は水を頼んでやってくれ。',
      '{name}が一杯もらったと嬉しそうにしていた。……そういう覚え方でいい。生き延びる理由になる。',
    ],
    talked: [
      '{name}と長く話していたな。あの後、飛行記録を自分から出してきた。あんたの効果だ。',
      '{name}が誰かに話を聞いてもらうのは珍しい。俺には言わないことも言ったんだろう。',
    ],
  },
  rival: {
    favored: [
      '{name}に肩入れしたと聞いたぞ。次の出撃で数を並べてみせる。それで終わる話だ。',
      '{name}の方が正しかった、か。撃墜数で返す。言葉じゃなくてな。',
    ],
    passed: [
      'あんた、{name}を退かせたな。……ああ、悪い気分じゃない。あいつの前で言うなよ。',
      '{name}が黙ったのは、あんたのせいか。今日は俺の勝ちにしておく。',
    ],
    defused: [
      '{name}と俺を引き分けにしたつもりか。勝負は空でつける。それでいい。',
      'なだめられて終わるとはな。{name}も不満そうだった。そこだけは意見が合う。',
    ],
    treated: [
      '{name}に奢ったのか。俺の分は、次に落とした数で請求する。',
      '{name}が一杯もらった、と自分から言いに来た。自慢しに来たんだ、あれは。',
    ],
    talked: [
      '{name}と何を話した。……いや、聞かない。聞いたら数を数えたくなる。',
      '{name}とずいぶん話し込んでいたな。俺との差は、そこじゃないと思うが。',
    ],
  },
  pair: {
    favored: [
      '{name}を立ててくれたか。助かる。あれは自分から前に出て言う奴じゃない。',
      '{name}の言い分が通ったんだな。俺が横で言うより、あんたが言った方が早い。',
    ],
    passed: [
      '{name}を退かせたのは、少し困る。あいつが黙ると、俺の位置も決まらない。',
      '{name}の話、途中で切られたんだろう。あの続きは俺が聞いておく。',
    ],
    defused: [
      '間に入ってくれて助かった。{name}と揉めたままだと、明日の射線が合わない。',
      '{name}とは長い。なだめてもらう程度で済むなら、安いものだ。',
    ],
    treated: [
      '{name}に奢ったな。あいつは礼を言わないだろう。代わりに言っておく。',
      '{name}が一杯もらったと。……次は俺の番だと言っておいてくれ。',
    ],
    talked: [
      '{name}と話したか。あいつが話す相手が増えるのは、悪くない。',
      '{name}の様子はどうだった。俺には「問題ない」しか言わない。',
    ],
  },
  friction: {
    favored: [
      '{name}の側に立ったのか。……そうか。あれの飛び方で穴が空くのは、俺の持ち場だ。',
      '{name}を立てたと聞いた。次にあいつが勝手に出たら、誰が埋めるか考えてくれ。',
    ],
    passed: [
      '{name}を退かせたな。ようやくだ。記録にも残しておく。',
      '{name}が黙ったか。それで作戦前の打ち合わせが戻るとは思わないが、始まりにはなる。',
    ],
    defused: [
      '仲裁か。……分かった。あんたが間にいる限りは、口を閉じておく。',
      '{name}と俺をなだめるのは、骨だろう。今日のところは効いた。認める。',
    ],
    treated: [
      '{name}に奢ったのか。あんたの酒だ、好きにすればいい。俺は別の卓で飲む。',
      '{name}が一杯もらったと自分で言い回っている。……そういう所が、合わないんだ。',
    ],
    talked: [
      '{name}と話していたな。あいつの言い分だけで判断しないでくれ。俺の記録もある。',
      '{name}と長かったな。何を言われたかは想像がつく。半分は事実だ。',
    ],
  },
  loss: {
    favored: [
      '{name}を庇ったか。あの名前の話をできる相手は、互いにもう一人しかいない。庇ってくれて、いい。',
      '{name}の側に立ってくれたんだな。……あいつが独りで抱えなくなるなら、それでいい。',
    ],
    passed: [
      '{name}を退かせたのか。あいつが強く言うときは、たいてい別の話をしている。汲んでやってくれ。',
      '{name}が黙ったな。あの沈黙は、怒っているんじゃない。思い出しているんだ。',
    ],
    defused: [
      '止めてくれて助かった。{name}と揉めると、話が必ず同じ名前に行き着く。',
      '{name}と俺の間に入るのは、居心地が悪かっただろう。すまない。',
    ],
    treated: [
      '{name}に奢ったか。あいつはグラスを二つ頼む癖がある。訊かないでやってくれ。',
      '{name}が一杯もらったと。……飲む相手がいるなら、飲んだ方がいい。',
    ],
    talked: [
      '{name}と話したか。あいつが名前を口に出したなら、あんたは信用されている。',
      '{name}と長く座っていたな。……あの話を聞いたなら、他では言わないでくれ。',
    ],
  },
  past: {
    favored: [
      '{name}の側に立ったか。昔の隊なら、俺も同じことをしていた。',
      '{name}を立てたんだな。あいつは昔からああいう言い方をする。変わっていない。',
    ],
    passed: [
      '{name}を退かせたか。あの頃なら食い下がってきたぞ。丸くなったな。',
      '{name}が引いたのか。……昔の話をしないのは、そのせいかもしれん。',
    ],
    defused: [
      'なだめられたな。{name}と俺は、まだ話していないことがある。今日じゃなくていい。',
      '間に入ってくれたか。あれは昔からの続きだ。あんたが悪いんじゃない。',
    ],
    treated: [
      '{name}に奢ったのか。昔は逆だった。あいつが払う側だ。',
      '{name}が一杯もらったと。……あの頃と同じ顔で飲むんだろうな。',
    ],
    talked: [
      '{name}と話したか。昔のことを訊いたなら、答えなかっただろう。俺にも答えない。',
      '{name}と長かったな。……あいつが話す気になったなら、俺はまだ待てる。',
    ],
  },
};

/** 相関を持たない相手の話をするときの文。性格ごとに言い方が違う。 */
const GOSSIP_NO_BOND: Record<PersonalityId, readonly string[]> = {
  reckless: ['{name}と飲んでたらしいな。俺も呼べよ。', '{name}の話は聞いた。次は俺の番でいいか。'],
  steady: ['{name}と話されていたと聞きました。あの人が話すのは珍しいです。', '{name}のこと、聞きました。気に掛けてもらえるのはありがたいです。'],
  precise: ['{name}と話したそうだな。内容は聞かない。時間の使い方は自由だ。', '{name}の件は把握した。以上だ。'],
  veteran: ['{name}と飲んだか。あれはまだ若い。付き合ってやってくれ。', '{name}の話は回ってきた。この艦は狭い。'],
  grim: ['……{name}のことは聞いた。話す相手がいるのはいい。', '{name}と話したのか。名前が増える前に、話しておいた方がいい。'],
  green: ['{name}さんと話したんですね！ 何を話したんですか？', '{name}さんのこと聞きました。自分も、いつか誘ってもらえますか。'],
};

/** 性格ごとの言い添え。相関の文の後ろに付けて、話し手の口調を出す。 */
const GOSSIP_TAIL: Record<PersonalityId, readonly string[]> = {
  reckless: ['……で、俺の分の酒はどこだ。', 'まあ、面白かったからいい。'],
  steady: ['……以上です。お邪魔しました。', '報告のつもりで言いました。'],
  precise: ['事実の確認だ。それだけだ。', '記録には残さない。'],
  veteran: ['年寄りの繰り言だ。忘れてくれ。', 'ま、この艦は狭いからな。'],
  grim: ['……この艦は、狭い。', '聞いた話だ。忘れる。'],
  green: ['あ、噂話みたいですみません！', '……こういうの、聞いてよかったんでしょうか。'],
};

/** その隊員のコールサイン。名前の出所は `pilots.ts`（＝人物名簿）に一本化する。 */
function callsignOf(id: string): string {
  return PILOTS.find((p) => p.id === id)?.callsign ?? id;
}

/** 話し手の性格。名簿に無い id を渡されても落ちないようにしておく。 */
function personalityOfSafe(id: string): PersonalityId {
  return PILOTS.find((p) => p.id === id)?.personality ?? 'steady';
}

/** `bondKey` の文字列（`a:b` 形式）から二人の id を取り出す。 */
function splitBondKey(key: string): [string, string] | undefined {
  const parts = key.split(':');
  return parts.length === 2 && parts[0] && parts[1] ? [parts[0], parts[1]] : undefined;
}

/** 噂の候補（対象と立場の組み合わせ）。 */
interface GossipCandidate {
  subject: string;
  stance: GossipStance;
}

/**
 * 「あなたが誰と何をしたか」が、別の隊員の口から出る1行。
 *
 * `speakerId` 自身の話は返さない（自分のことを噂で聞かされるのは変なので）。
 * 話し手の `personality` と、話し手と対象の間の `bondBetween`（相関）で文が変わる。
 * 相関が無い相手なら、性格だけの当たり障りのない一言になる。
 *
 * 候補が無ければ `undefined`（呼び出し側は噂を出さない）。
 */
export function gossipLine(speakerId: string, memory: BarMemory, seed: number): string | undefined {
  const candidates: GossipCandidate[] = [];

  // 介入の記録。味方された側／されなかった側を、話し手から見た立場に変換する。
  const iv = memory.intervened;
  if (iv) {
    const pair = splitBondKey(iv.bondKey);
    if (pair) {
      const [x, y] = pair;
      const bond = bondBetween(x, y);
      // 掛け合いの当事者自身には、その掛け合いの話をさせない（本人の記憶であって噂ではない）
      if (bond && speakerId !== x && speakerId !== y) {
        if (iv.side === 'defuse') {
          candidates.push({ subject: bond.a, stance: 'defused' });
          candidates.push({ subject: bond.b, stance: 'defused' });
        } else {
          const favored = iv.side === 'a' ? bond.a : bond.b;
          const passed = iv.side === 'a' ? bond.b : bond.a;
          candidates.push({ subject: favored, stance: 'favored' });
          candidates.push({ subject: passed, stance: 'passed' });
        }
      }
    }
  }

  if (memory.boughtDrink && memory.boughtDrink !== speakerId) {
    candidates.push({ subject: memory.boughtDrink, stance: 'treated' });
  }

  for (const id of memory.talkedWith.slice(0, 4)) {
    if (id === speakerId) continue;
    candidates.push({ subject: id, stance: 'talked' });
  }

  if (candidates.length === 0) return undefined;

  const personality = personalityOfSafe(speakerId);
  const chosen = candidates[indexAt(candidates.length, seed)];
  const bond = bondBetween(speakerId, chosen.subject);
  const lines = bond ? GOSSIP[bond.kind][chosen.stance] : GOSSIP_NO_BOND[personality];
  const core = lines[indexAt(lines.length, seed + candidates.length)];
  const tail = GOSSIP_TAIL[personality][indexAt(GOSSIP_TAIL[personality].length, seed)];
  return `${core.replace('{name}', callsignOf(chosen.subject))} ${tail}`;
}

/**
 * 噂の対象と話し手の関係を、UIの見出し用に一言で。
 *
 * 相関があれば種類の名前（師弟・不和など）、無ければ `undefined`。
 * 表示するかは呼び出し側の判断。
 */
export function gossipRelationLabel(speakerId: string, subjectId: string): string | undefined {
  const bond = bondBetween(speakerId, subjectId);
  return bond ? PILOT_BOND_KINDS[bond.kind].label : undefined;
}

/**
 * 開発時の整合性チェック。テストから呼ぶ。
 * 実行時の経路では呼ばない（`validatePilotBonds` と同じ扱い）。
 */
export function validateBarRumors(): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const r of BAR_RUMORS) {
    if (seen.has(r.id)) errors.push(`duplicated rumor id: ${r.id}`);
    seen.add(r.id);
    if (r.text.trim().length === 0) errors.push(`empty rumor text: ${r.id}`);
  }
  // 酒保が名簿に居ることの確認（`veilPerson` は未知idで例外を投げる）
  try {
    veilPerson(BARTENDER_PERSON_ID);
  } catch {
    errors.push(`unknown bartender person: ${BARTENDER_PERSON_ID}`);
  }
  return errors;
}
