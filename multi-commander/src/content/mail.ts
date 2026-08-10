/**
 * 自室の私信（T8-③）。Wing Commander: Prophecy の barracks のメール端末に相当する。
 *
 * ■ なぜ必要か
 * 酒場は「その場にいる相手と話す」場所で、いま艦にいない相手（司令部・艦務課・
 * 故郷・敵エース）の言葉が届く経路がなかった。結果、プレイヤーは自分の選択が
 * **艦の外でどう受け取られたか**を知る手段を持たない。
 *
 * 私信はその一方通行の経路を作る。返信はできない（WCP のメール端末と同じ）。
 * 読むだけで、章と4状態と隊の状況が「書類と手紙」の形で返ってくる。
 *
 * ■ 差出人は必ず人物名簿から引く
 * 個人名は `veil/people.ts`（および `pilots.ts` 経由の同名簿）から取得する。
 * 部署名だけは名簿に人物として存在しないので、`MAIL_DEPARTMENTS` に列挙してある。
 * **新しい人名を捏造しない。**
 *
 * ■ 難易度には一切効かせない
 * `narrative.ts` の実装規約と同じ。私信は表示テキストだけを変える。
 */

import { whenMatches, type RumorWhen } from './barRumors';
import { pilotPerson } from './pilots';
import { veilPerson } from './veil/people';

/**
 * 差出人が個人ではない場合の部署名。
 *
 * 人物名簿に「艦務課」という人物は居ないので、ここが唯一の出所になる。
 * 表示にも検証にも同じ配列を使う（テストはこの配列と名簿だけを許可する）。
 */
export const MAIL_DEPARTMENTS: readonly string[] = [
  '司令部 作戦課',
  '艦務課',
  '整備科',
  '補給科',
  '医務室',
  '記録課',
  '通信科',
  '人事課',
  '民間郵便中継',
  '儀礼周波（受信記録）',
];

/**
 * 私信が出る条件。`barRumors.ts` の `RumorWhen` と同じ考え方に、隊員条件を足したもの。
 */
export interface MailWhen extends RumorWhen {
  /** その隊員が飛べる状態のときだけ出す（本人からの私信など） */
  pilotActive?: string;
  /** その隊員が戦死しているときだけ出す（遺族・遺品の連絡など） */
  pilotFallen?: string;
}

export interface MailItem {
  id: string;
  /** 差出人の表示名（人物名簿の名前 or `MAIL_DEPARTMENTS` の部署名） */
  from: string;
  subject: string;
  body: string;
  /** 出る条件。すべて省略可。省略した項目は無条件。 */
  when?: MailWhen;
}

export interface MailContext {
  chapter: number;
  gauges?: { returnees: number; routeTrust: number; commandTrust: number; aceOath: number };
  hasFallen?: boolean;
  hasWounded?: boolean;
  /** 飛べる状態の隊員 id（`availablePilots()` の id 列を渡す想定） */
  activePilots?: readonly string[];
  /** 戦死した隊員 id（`fallen()` の id 列を渡す想定） */
  fallenPilots?: readonly string[];
  /** 戦死者の表示名。本文の `{fallen}` に入る（先頭の1名） */
  fallenNames?: readonly string[];
}

/**
 * 人物名簿の名前から、かなの併記を落とした表示名。
 *
 * 名簿は `七瀬 結衣（ナナセ ユイ）` の形で持っている。差出人欄は短い方が読みやすいので
 * `（` より前を使う。**名前そのものは名簿が出所**で、ここでは切るだけ。
 */
export function mailSenderName(personId: string): string {
  const full = veilPerson(personId).name;
  const i = full.indexOf('（');
  return i > 0 ? full.slice(0, i) : full;
}

/** 飛行隊の隊員の差出人名。`pilots.ts` 経由で同じ名簿を引く。 */
function pilotSender(pilotId: string): string {
  const full = pilotPerson(pilotId).name;
  const i = full.indexOf('（');
  return i > 0 ? full.slice(0, i) : full;
}

/**
 * 私信の一覧（26件）。
 *
 * 内訳:
 * - `hq-*` / `ops-*` / `dept-*` … 司令部・艦務課・整備科などの事務連絡
 * - `pilot-*` … 隊員からの短い私信（`pilotBonds.ts` の相関を反映）
 * - `loss-*` … 戦死者の遺族・遺品に関する連絡（戦死者が出ているときだけ）
 * - `ace-*` … 敵エースからの通信（`aceOath` が高いとき）
 * - `home-*` … 故郷からの手紙（章が進むと内容が変わる）
 */
const MAIL_SEEDS: readonly MailItem[] = [
  // ── 司令部・艦務課からの事務連絡 ─────────────────────────
  {
    id: 'ops-arrival',
    from: '艦務課',
    subject: '個室割当と艦内規則の確認',
    body:
      '着任に伴い、居住区第二層の個室を割り当てた。私物の持ち込みは規定の一箱まで。\n' +
      '酒保の利用は当直明けのみ。飲酒後8時間の搭乗を禁ずる。\n' +
      '以上、確認の署名は端末上で行うこと。',
    when: { chapterMax: 2 },
  },
  {
    id: 'ops-ordnance',
    from: '補給科',
    subject: '兵装割当票（今期）',
    body:
      '当該期のミサイル割当を通知する。搭載上限は割当票の数値を上限とし、超過搭載は認めない。\n' +
      '在庫の再配分は補給調整官の裁量で行うため、格納庫での直接交渉は控えること。',
  },
  {
    id: 'ops-ordnance-cut',
    from: '補給科',
    subject: '【変更】兵装割当の下方修正',
    body:
      '上位命令により、当該期の割当を下方修正する。理由欄は「照合中」とのみ記載されている。\n' +
      '現場としては、割り当てられた数で任務が成立するよう組み直すほかない。',
    when: { commandTrustBelow: 40 },
  },
  {
    id: 'ops-ordnance-raise',
    from: '補給科',
    subject: '兵装割当上限の緩和について',
    body:
      '作戦記録の評価に基づき、当該期の搭載上限を引き上げる。書類は一枚で通った。\n' +
      '整備科と搭載計画をすり合わせること。',
    when: { commandTrustAbove: 62 },
  },
  {
    id: 'dept-maint',
    from: mailSenderName('confed-30'), // 高峰 岳 / Cobalt / 戦闘整備士
    subject: '機体整備報告（応急修理箇所）',
    body:
      '前回の帰投時、右舷装甲板の焼損を応急で処理した。恒久修理は次の補給時になる。\n' +
      '機体の癖が変わっているはずだ。発艦前に舵の応答を一度確認してくれ。\n' +
      '直せる範囲は直す。直せない範囲は、乗る側に伝えるのが自分の仕事だと思っている。',
    when: { chapterMin: 2 },
  },
  {
    id: 'dept-supply',
    from: mailSenderName('confed-21'), // 七瀬 結衣 / Iris / 補給調整官（酒保）
    subject: '（私信）在庫の話',
    body:
      '補給科の公式通知とは別に、こちらから一つ。\n' +
      '出撃前の在庫と帰投後の在庫を並べると、その日に何があったか全部分かってしまいます。\n' +
      '救護区画の消耗が増えている日は、私は少し安心しています。誰かを拾ったということなので。\n' +
      '酒保の割当は一人二杯までです。守ってください。',
    when: { chapterMin: 2 },
  },
  {
    id: 'dept-medical',
    from: mailSenderName('confed-19'), // 早川 千紘 / Meridian / 医療艇長
    subject: '搭乗可否の判定について',
    body:
      '負傷者の搭乗可否は医務室が判定する。飛べると本人が言っても、判定は変わらない。\n' +
      '無理をした機体は替えが来るが、無理をした搭乗員は替えが来ない。\n' +
      '出撃表を組む前に、当室の判定表を確認すること。',
    when: { hasWounded: true },
  },
  {
    id: 'dept-personnel',
    from: '人事課',
    subject: '補充要員の配属予定',
    body:
      '飛行隊の欠員に対し、補充要員の配属を進めている。到着時期は輸送の都合により未定。\n' +
      '到着まで、現員で出撃表を組むこととする。',
    when: { hasFallen: true },
  },
  {
    id: 'ops-discipline',
    from: '司令部 作戦課',
    subject: '【処分通知】無許可出撃に関する照会',
    body:
      '当該期の出撃記録に、事前承認を経ていない発艦が確認された。処分は保留とし、記録に留める。\n' +
      '以後、出撃記録には照合印を付す。一件ずつ確認されるということである。',
    when: { commandTrustBelow: 38 },
  },
  {
    id: 'ops-commend',
    from: mailSenderName('confed-33'), // Kwame Adeyemi / Bastion / 連邦艦隊司令
    subject: '作戦記録に対する所見',
    body:
      '貴官の出撃記録を読んだ。数字ではなく、判断の順序を見ている。\n' +
      '前進基地の防衛線を組み直した経験から言えば、線を守るのは火力ではなく、\n' +
      '「誰を先に退かせるか」を決められる者だ。その順序を崩さないでほしい。',
    when: { commandTrustAbove: 60, chapterMin: 4 },
  },
  {
    id: 'ops-captain',
    from: mailSenderName('confed-06'), // William Hart / Anchor / 艦長
    subject: '名前を先に確定させろ',
    body:
      '戦果報告は明日でいい。搭乗者名簿を先に確定させてくれ。\n' +
      '救難隊にいた二十年で覚えたのは、名前を後回しにすると、そのまま空欄で残るということだ。\n' +
      '撃つ前に、拾える者を拾え。順番を間違えるな。',
  },
  {
    id: 'ops-navigation',
    from: mailSenderName('confed-07'), // Sophie Laurent / Northstar / 航法士・門解析員
    subject: '帰投窓の再計算について',
    body:
      '開口の予測をやり直し、帰投窓を二分延長できた。二分は、機体一機分の猶予に相当する。\n' +
      '観測できるものを観測しないのは、航法ではなく信仰です。次の出撃でも観測値を送ってください。',
    when: { chapterMin: 2 },
  },
  {
    id: 'ops-route-low',
    from: mailSenderName('confed-31'), // 西園寺 蓮 / Nocturne / 外交護衛士官
    subject: '中立勢力からの応答遅延について',
    body:
      'セレシオンおよびオルドからの応答が遅れている。拒否ではなく、様子を見られている。\n' +
      '回廊での発砲記録が一件でも増えると、こちらの説明が全部後回しになる。\n' +
      '砲を回す前に、回廊の外へ出てほしい。',
    when: { routeTrustBelow: 42, chapterMin: 3 },
  },
  {
    id: 'ops-route-high',
    from: mailSenderName('confed-14'), // 水城 玲奈 / Lark / 艦隊広報官
    subject: '避難民向け説明での引用について',
    body:
      '中立回廊での貴官の行動を、避難民向け説明で引用させてもらった。\n' +
      '「連邦機は回廊内で砲を回さなかった」——この一文で、乗船を承諾した家族が四十世帯ある。\n' +
      '広報は嘘を書けない。書けることが増えたのは、現場の判断のおかげです。',
    when: { routeTrustAbove: 60, chapterMin: 3 },
  },
  {
    id: 'ops-signals',
    from: mailSenderName('confed-24'), // 朝比奈 律 / Cipher / 情報作戦士官
    subject: '偽装信号の識別手順（再送）',
    body:
      '味方の声は必ず遅れて届く。偽装された声は遅れない。\n' +
      'ロック応答が二重化した場合、撃たずに遅延を数えること。撃墜数を稼ぐほど誤射の確率が上がる。\n' +
      '手順書を端末に置いた。読んだ記録は残る。',
    when: { chapterMin: 2, chapterMax: 7 },
  },
  {
    id: 'ops-accord',
    from: mailSenderName('confed-11'), // Nia Williams / Hearth / 空母航空団参謀
    subject: '継戦計画の見直しと告発データの扱い',
    body:
      '四十日間の継戦計画を組み直している。前提が一つ崩れた。\n' +
      '五者通行協定の六つ目の条項の件だ。公証中継所へ搬送するまでは、艦内でも写しを増やさないこと。\n' +
      '数が合わなくなった時点で、証拠は証拠でなくなる。',
    when: { chapterMin: 7, chapterMax: 9 },
  },
  {
    id: 'ops-relay',
    from: '通信科',
    subject: '通信灯台の回線割当',
    body:
      '停戦通知の中継に使用する回線を割り当てた。冗長は三本。一本でも六十秒保てば艦隊は引き返せる。\n' +
      '全部落ちた場合の手順は、書いていない。書く意味がないためである。',
    when: { chapterMin: 8, chapterMax: 9 },
  },

  // ── 隊員からの短い私信（相関を反映） ─────────────────────
  {
    id: 'pilot-aster-solace',
    from: pilotSender('aster'), // 黒瀬 日和 / Aster（師弟: Solace）
    subject: '飛行記録の件（Solace について）',
    body:
      '久世の飛行記録を、また勝手に読んで赤で書き込んだ。本人には返してある。\n' +
      '空戦の数はまだ足りないが、救難の判断は速い。伸ばすべきはそちらだと思う。\n' +
      '機体は替えが効く。あいつは効かない。出撃表を組むとき、そこだけ覚えていてほしい。',
    when: { pilotActive: 'aster' },
  },
  {
    id: 'pilot-sable-raven',
    from: pilotSender('sable'), // 桐谷 綾 / Sable（不和: Raven）
    subject: '護衛線の穴について（報告）',
    body:
      '藤堂が独断で囮に出るたび、こちらの護衛線に穴が空きます。三度目に輸送艇が被弾しました。\n' +
      '作戦前の打ち合わせは、こちらからは持ちかけていません。持ちかけても、その場で変えられるので。\n' +
      '責任を問うつもりはありません。ただ、穴を埋める人員をあらかじめ置いてください。',
    when: { pilotActive: 'sable' },
  },
  {
    id: 'pilot-raven-solace',
    from: pilotSender('raven'), // 藤堂 悠真 / Raven（相棒: Solace）
    subject: '（件名なし）',
    body:
      '二度落ちて、二度とも久世の救難艇に拾われた。礼は言っていない。言う気もない。\n' +
      'ただ、出撃前にあいつの機の外装を叩いていくのは続ける。そういう約束にしている。\n' +
      '次も囮は自分がやる。桐谷には、穴の位置だけ先に伝えておく。',
    when: { pilotActive: 'raven', chapterMin: 3 },
  },
  {
    id: 'pilot-vesper-orion',
    from: pilotSender('vesper'), // 柊 奏 / Vesper（相棒: Orion、喪失の共有: Sable）
    subject: '索敵の落とし方について',
    body:
      '橘とは「入る」「見えた」の二語で足ります。こちらが敵の目を潰してから、あの人が撃つまで数秒。\n' +
      'その数秒に他の無線を入れないでください。それだけの願いです。\n' +
      '……名簿に書いた名前は、まだ増やしたくありません。',
    when: { pilotActive: 'vesper', chapterMin: 2 },
  },
  {
    id: 'pilot-nova-tempest',
    from: pilotSender('nova'), // 東雲 澪 / Nova（旧同僚: Tempest、師弟: Solace）
    subject: '単独帰投の手順を渡しました',
    body:
      '久世に、撃ち方ではなく単独で航路を割り出して戻る手順を渡しました。\n' +
      '助ける側が帰れなかったら、助けた意味がないので。\n' +
      '榊の隊にいた頃の話は、まだしていません。訊かれてもいません。それで足りています。',
    when: { pilotActive: 'nova', chapterMin: 3 },
  },
  {
    id: 'pilot-tempest-aster',
    from: pilotSender('tempest'), // 榊 恒一 / Tempest（不和: Aster、好敵手: Orion）
    subject: '記録の件',
    body:
      '黒瀬が俺の独断交戦を一件ずつ艦の記録に残している。処分を求めたことは一度もないそうだ。\n' +
      '「いつか要る」と言うだけだ。あれは脅しだろう。\n' +
      '封鎖線は突き破るものだ。それで補給が通ったなら、記録に何と書かれていても構わない。',
    when: { pilotActive: 'tempest', chapterMin: 4 },
  },
  {
    id: 'pilot-orion-numbers',
    from: pilotSender('orion'), // 橘 蒼真 / Orion（相棒: Sable, Vesper／好敵手: Tempest）
    subject: '射線の確保について',
    body:
      '桐谷が持ち場を動かないので、こちらは射線を計算できる。担当宙域の番号で呼び合えば足りる。\n' +
      '榊とは数機差だ。当てに行く流儀は否定しないが、当たる位置で待つ方が弾は減らない。\n' +
      '以上。報告は距離と数だけにしておく。',
    when: { pilotActive: 'orion', chapterMin: 2 },
  },
  {
    id: 'pilot-solace-thanks',
    from: pilotSender('solace'), // 久世 朔 / Solace（師弟: Aster, Nova／相棒: Raven）
    subject: 'ありがとうございました！',
    body:
      '黒瀬さんに飛行記録を赤で埋められて返ってきました。全部読みました。\n' +
      '東雲さんからは、単独で戻る手順を教わりました。撃ち方じゃないところが不思議です。\n' +
      '藤堂さんは、出撃前に必ず自分の機を叩いていきます。あれ、たぶん挨拶なんだと思います。\n' +
      '自分はまだ空戦は数えるほどですが、拾う方はやれます。よろしくお願いします！',
    when: { pilotActive: 'solace' },
  },

  // ── 戦死者の遺族・遺品 ────────────────────────────
  {
    id: 'loss-effects',
    from: '艦務課',
    subject: '遺品の整理と送付について',
    body:
      '{fallen} の私物整理を進めている。規定の一箱に収まらない分の扱いについて、隊としての意見を求む。\n' +
      '個室の割当変更は、整理が済むまで保留とする。急かす部署はない。',
    when: { hasFallen: true },
  },
  {
    id: 'loss-family',
    from: '記録課',
    subject: '遺族への報告文について（照会）',
    body:
      '{fallen} の遺族へ送る報告文の草案を作成した。戦闘経過の記載範囲について確認したい。\n' +
      '遺族が知りたいのは戦果ではなく、最後に誰が近くにいたかである。過去の返信からそう判断している。\n' +
      '書ける範囲を、隊の側から指定してほしい。',
    when: { hasFallen: true },
  },
  {
    id: 'loss-roster',
    from: '人事課',
    subject: '名簿の線引きについて',
    body:
      '{fallen} の欄に線を引いた。作業は当直の順番で回している。\n' +
      '事務手続きとしては以上だが、飛行隊の名簿からは、貴官の判断で外すまで残す。',
    when: { hasFallen: true, chapterMin: 3 },
  },

  // ── 敵エースからの通信 ───────────────────────────
  {
    id: 'ace-oath',
    from: mailSenderName('kilrashi-03'), // ラギティカ / Blood Oath / 決闘士・編隊長
    subject: '決闘規約についての通知',
    body:
      '儀礼周波では言えぬことを、この経路で送る。届くはずだ。そちらの通信科は有能だ。\n' +
      'あなたの機体番号は控えた。撃墜した相手の名は、すべて記憶している。あなたの名もそこに入る。\n' +
      '一対一が成立している間、周りの砲は止まる。止めるのは私の権限で、破ればこちらの家門が恥をかく。\n' +
      '規約は弱い者を守るためにあるのではない。次に通る者のためにある。',
    when: { aceOathAbove: 58, chapterMin: 4 },
  },
  {
    id: 'ace-rite',
    from: '儀礼周波（受信記録）',
    subject: '読み上げ記録（第四条・救難義務）',
    body:
      '受信した儀礼通信の写しを添付する。読み上げられたのは宣戦布告ではなく、\n' +
      '五者通行協定第四条の救難義務条文であった。読み上げた者は儀礼通信士ヴァークと自称している。\n' +
      '読み上げを無視して発砲した側が、協定上の非を負う。記録は双方に残る。',
    when: { aceOathAbove: 52, chapterMin: 2 },
  },
  {
    id: 'ace-cold',
    from: '儀礼周波（受信記録）',
    subject: '読み上げの停止について',
    body:
      '当該期、儀礼周波での読み上げが確認されていない。\n' +
      '向こうが名を控えるのをやめたということである。以後、こちらの機体は番号で呼ばれる。\n' +
      '決闘規約による砲撃停止も期待できない。周辺機の同時交戦を前提に計画すること。',
    when: { aceOathBelow: 38, chapterMin: 4 },
  },

  // ── 故郷からの手紙（章が進むと内容が変わる） ────────────────
  {
    id: 'home-early',
    from: '民間郵便中継',
    subject: '【転送】家からの手紙',
    body:
      '無事に着いたのなら、それでいい。写真は同封した。台所の窓から撮ったものだ。\n' +
      '港のニュースは見ている。船が三百隻も並ぶ映像に、そちらの艦が映っていた気がした。\n' +
      '食事は取っているか。返事は要らない。読んだかどうかだけ、いつか教えてくれ。',
    when: { chapterMax: 3 },
  },
  {
    id: 'home-mid',
    from: '民間郵便中継',
    subject: '【転送】家からの手紙（続き）',
    body:
      '避難船の話が、こちらでも回るようになった。乗る順番の話ばかりだ。\n' +
      '隣の家は先に出た。うちは残る。荷物をまとめるより、庭の水をやる方が性に合っている。\n' +
      'そちらで誰かを助けたと聞いた。誰から聞いたかは書かない。書くと立場が悪くなる人がいる。',
    when: { chapterMin: 4, chapterMax: 7 },
  },
  {
    id: 'home-late',
    from: '民間郵便中継',
    subject: '【転送】家からの手紙（最後になるかもしれない分）',
    body:
      '門の話が決まるらしいと、こちらの放送が言っている。閉めるとも、開けるとも言う。\n' +
      'どちらでも構わない。決める側にいるのなら、次に通る人のことを考えてくれればいい。\n' +
      '帰ってきたら、台所の窓から同じ写真を撮ろう。それまで、こちらは待っている。',
    when: { chapterMin: 8 },
  },
];

/** 条件判定。`RumorWhen` の部分は `barRumors.ts` に一本化してある。 */
function mailMatches(when: MailWhen | undefined, ctx: MailContext): boolean {
  if (!when) return true;
  if (
    !whenMatches(when, {
      chapter: ctx.chapter,
      gauges: ctx.gauges,
      hasFallen: ctx.hasFallen,
      hasWounded: ctx.hasWounded,
    })
  ) {
    return false;
  }
  // 隊員条件は、その情報が渡されていないときは成立させない
  // （知らない状態を私信が先に断定してしまうのを防ぐ。4状態と同じ扱い）
  if (when.pilotActive !== undefined) {
    if (!ctx.activePilots || !ctx.activePilots.includes(when.pilotActive)) return false;
  }
  if (when.pilotFallen !== undefined) {
    if (!ctx.fallenPilots || !ctx.fallenPilots.includes(when.pilotFallen)) return false;
  }
  return true;
}

/**
 * 条件に合う私信を返す。
 *
 * 並びは「章条件が新しいものが先頭」＝受信箱として自然な順（新しい話題が上）。
 * 章条件を持たない事務連絡は後ろに回る。同じ条件のものは定義順を保つ。
 *
 * 本文の `{fallen}` は `ctx.fallenNames` の先頭で置き換える（無ければ既定の語）。
 */
export function mailFor(ctx: MailContext): MailItem[] {
  const fallenName = ctx.fallenNames && ctx.fallenNames.length > 0 ? ctx.fallenNames[0] : '当該搭乗員';
  const matched = MAIL_SEEDS.filter((m) => mailMatches(m.when, ctx)).map((m) => ({
    ...m,
    body: m.body.replace(/\{fallen\}/g, fallenName),
  }));
  return matched
    .map((m, i) => ({ m, i, key: m.when?.chapterMin ?? 0 }))
    .sort((x, y) => (y.key - x.key) || (x.i - y.i))
    .map((e) => e.m);
}

/** 未読件数の表示などに使う総件数（条件を無視した全件）。 */
export const MAIL_TOTAL = MAIL_SEEDS.length;

/**
 * 開発時の整合性チェック。テストから呼ぶ。
 * 実行時の経路では呼ばない（`validatePilotBonds` と同じ扱い）。
 */
export function validateMail(): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const m of MAIL_SEEDS) {
    if (seen.has(m.id)) errors.push(`duplicated mail id: ${m.id}`);
    seen.add(m.id);
    if (m.from.trim().length === 0) errors.push(`empty mail from: ${m.id}`);
    if (m.subject.trim().length === 0) errors.push(`empty mail subject: ${m.id}`);
    if (m.body.trim().length === 0) errors.push(`empty mail body: ${m.id}`);
  }
  return errors;
}
