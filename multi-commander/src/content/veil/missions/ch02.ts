/**
 * 第2章 OPERATION FALSE DAWN（ヴェガ門）。
 *
 * 出典（正典）:
 * - `00_initila_constructions/05_story_改善/spec/ストーリー_十章作戦記録.html` CHAPTER 02
 *   （本文6段落／主目標／戦術マップ `ch2`）
 * - 手順書 §9 T5-02
 *
 * ■ この章のねらい
 * 「撃ち方」ではなく「撃たない訓練」。無人機群は連邦とキルラシー双方の識別を模して返すため、
 * ロックオンの応答が二重化する。この章の主役は撃墜数ではなく**識別**である。
 *
 * ■ T4-⑰「撃たない緊張感」を主役にした（第4期）
 * 着手前のこの章は「誤射ゼロ」が必須で、偽装無人機の撃墜は任意だった。つまり
 * **一発も撃たずに漂流者だけ拾って帰れば必ず勝てた**ので、緊張感が生まれない。
 * そこで次の形に組み替えた。
 *
 *   1. 撃つべき相手（偽装無人機＝キルラシー陣営）の排除を **必須** にした。
 *      → 撃たなければ勝てない。
 *   2. 撃ってはいけない相手（本物の民間船2隻＝中立）を **同じ空域に混ぜた**。
 *      無人機は民間船の船籍名・僚機の呼称をそのまま返すので、
 *      **名前だけを見て撃つと必ず誤射になる**。
 *   3. その民間船の識別確認（`recon`＝照準に収めて近距離を保つ／撃つ必要はない）を
 *      **必須** にした。「照準に入れて、撃たない」という操作そのものが目標になる。
 *   4. 誤射した瞬間に、当てた相手の名前と勢力表示を無線で読み上げる
 *      （`MissionDef.friendlyFireRadio`）。**なぜ誤射になったか**が分かる。
 *
 * ■ 見分ける手段（すべて既存 HUD で読める。HUD 側の変更は無い）
 * - **勢力表示と色**: 右VDU のターゲット情報に `連邦 / キルラシー / 中立` が出る。
 *   ターゲット枠・機体マーカーの色も敵対関係由来（赤い △ が敵、青い ○ が味方・中立）。
 *   これは `src/content/factions.ts` の関係テーブル由来なので**偽装できない**。
 *   ＝「名前は嘘をつくが、勢力表示は嘘をつかない」がこの章の正解手順。
 * - **機種名**: ターゲット情報に機体名が出る。船籍名を返してくる相手の機影が
 *   `KF01 レオンファング`（戦闘機）なら、それは難民船ではない。
 * - **速度**: 民間船は初速 12〜18 m/s で漂う。同じ名前で 200 m/s 超で寄ってくる機体は船ではない。
 * - **通信の遅延**（従来からの判別手段。下記の規約）。
 * - **目標行の note**: `誤射 0` と `収容 n/3`、識別確認の進捗 `%` が常時読める。
 *
 * ■ 判別手段＝通信の遅延（T6-2 の要点。規約は変更していない）
 * `MissionRunner.queueRadio()` は `RadioLineDef.after` を「直前の台詞からの待ち時間」として
 * 積み上げるので、無線の到達順そのものが遅延になる。そこでこの章では次の規約を敷いた。
 *   - **本物の味方（乗員・管制）の台詞には必ず `after` を書く**（門を越えて遅れて届く声）。
 *   - **偽装ドローンが名乗る台詞には `after` を書かない**（遅延ゼロで割り込む声）。
 * 結果、同じ呼称の声が「先に喋った方＝偽装」「遅れて届いた方＝本物」の順で必ず並ぶ。
 * プレイヤーは遅延を数えるだけで判別でき、その規約は単体テストで固定している。
 *
 * ■ 難易度を上げすぎない工夫（詰みにしない）
 * - 偽装無人機は前段3機＋後段2機の計5機だけ。第1章の先遣隊3機に2機足した規模である。
 * - 民間船は撃たれない（中立なので誰とも交戦しない）。放っておけば沈まないので、
 *   「守り切れずに失敗する」経路は存在しない。**誤射だけが失敗経路**である。
 * - 識別確認は 2400m まで届き、角度 26度・所要6秒。漂う船が相手なので追い回す必要がない。
 * - 逃げた無人機は戦域外へ出れば排除扱いになる（`destroyTag` の既定挙動）ので、
 *   1機だけ逃げ回って終われない状態にはならない。
 */

import type { MissionDef } from '../../../mission/types';
import { veilChapter } from '../chapters';
import { veilPerson } from '../people';
import { CLAW, CONTROL, TAG, speakerName, theaterScenery } from './shared';

const CH = veilChapter(2);
const SCENERY = theaterScenery('vega-gate');


/** ソフィー・ローラン 航法士・門解析員（ブリーフィング話者） */
const SOPHIE = speakerName('confed-07');
/** 小林 直子 偵察・電子戦士官（遅延を数えろと繰り返す） */
const NAOKO = speakerName('confed-10');
/** ハート艦長（書類を見て一度だけ確認する） */
const HART = speakerName('confed-06');
/**
 * 偽装ドローンが名乗る声。プレイヤーの僚機の呼称をそのまま返してくる。
 * **この speaker の台詞には `after` を付けない**（遅延ゼロ＝偽装の証拠）。
 * 前段の無人機群の `displayName` にもこれを使う（HUD のターゲット名まで偽装される）。
 */
const SPOOF = '僚機〈ラプター 2〉';
/** 本物の味方の声に付ける最小の遅延（秒）。門を越えて遅れて届く分 */
const RELAY_DELAY = 3;

/**
 * 本物の民間船2隻の船籍名。
 *
 * 人物名ではなく船の呼称なので `people.ts` の対象外。ここが唯一の出所で、
 * 無線・`displayNames`・目標文・偽装側のコピーがすべてこの定数を読む。
 */
const LINER_A = '難民船〈ミナ・ロウ〉';
const LINER_B = '難民船〈セント・アニス〉';

/**
 * 八十三年前の巡洋艦の名。第2章の生存者信号の出所。
 * 正典に固有名の指定が無いため、章題 FALSE DAWN に合わせてこの章で宣言する。
 */
const AURORA = '巡洋艦〈アウロラ〉';

/**
 * 帰還者3名（T4-⑮ / T4-⑰）。
 *
 * 八十三年前に失踪した人物なので現役名簿（`VEIL_PEOPLE` 全76名）には居ない。
 * `people.ts` の**失踪者名簿**（`confed-lost-01`〜`03`）を足し、
 * ここでは `speakerName()` を通した結果だけを渡す。
 * ＝名前の出所は `people.ts` の1系統のまま（この章に文字列を直書きしない）。
 *
 * 並び順は名簿側の証言の順（連邦に撃たれた／キルラシーに撃たれた／誰も撃っていない）。
 */
const DRIFTERS = [
  speakerName('confed-lost-01'),
  speakerName('confed-lost-02'),
  speakerName('confed-lost-03'),
];

export const VEIL_CH02: MissionDef = {
  id: CH.missionId,
  title: `第2章 ${CH.title}`,
  system: CH.theaterName,
  briefingSpeaker: SOPHIE,
  briefingSpeakerId: 'confed-07',
  briefingSpeakerRole: veilPerson('confed-07').role,
  briefing: [
    `断片ログを復号したら、ありえない座標が出ました。2229年のラグランジュ事故で消失した${AURORA}の生存者信号です。八十三年前に消えた船から届いたタイムスタンプが、六時間前を指しています。観測できるものを観測しないのは、航法ではなく信仰です。`,
    `これは正規の命令ではありません。司令部は八十三年前に沈んだ船の座標を認めないので、航法演習の名目で三機分の燃料を確保しました。${HART}艦長は書類を見て一度だけ確認しました。「演習で、脱出ポッドの回収装備を積むのか」。積みます、と答えました。`,
    `門の異常圏には、連邦とキルラシー双方の識別を模した無人機群がいます。厄介なのは、同じ空域に本物の民間船が二隻残っていることです。${LINER_A}と${LINER_B}。無人機はこの二隻の船籍名と、あなたの僚機の呼称をそのまま返してきます。名前で判断すれば、必ず間違えます。`,
    `判別できるものは三つあります。識別表示の勢力、機影、そして通信の遅延です。勢力表示は偽装できません——中立と出ていれば船、キルラシーと出ていれば無人機です。${NAOKO}士官の指示に従ってください。撃つ前に、声の遅延を数えて。`,
    '評価は撃墜数ではありません。無人機を残せば異常圏は閉じられず、民間船に一発でも当てれば任務は失敗です。撃つべきものだけを撃って、漂流者3名を連れて帰ること。',
  ],
  // 脱出ポッドの回収装備を積むため、爆装枠のある機体で出す
  playerShipId: 'scimitar',
  skybox: SCENERY.skybox,
  landmarks: SCENERY.landmarks,
  // 門の外縁に漂う残骸帯。異常圏の入口を「何かが壊れた場所」にする
  hazards: [{ kind: 'asteroids', atNav: 1, count: 20, spread: 1800, rockRadius: [14, 70] }],
  /**
   * 誤射した瞬間の指摘（T4-⑰）。
   * 当てた相手の名前と勢力表示を読み上げるので、「なぜ誤射になったか」が分かる。
   * 宣言したのはこの章だけ（他章の挙動は変わらない）。
   */
  friendlyFireRadio: { speaker: NAOKO, tone: 'command' },
  navs: [
    {
      name: 'NAV 1 (演習空域)',
      pos: [2000, 500, -14000],
      onArrive: [
        // 本物の声は遅れて届く（after あり）
        { speaker: SOPHIE, text: '記録上はここまでが演習です。ここから先はありません。', tone: 'friendly', after: RELAY_DELAY },
      ],
    },
    {
      name: 'NAV 2 (門異常圏)',
      pos: [-8200, -1100, -26000],
      arriveRadius: 2000,
      onArrive: [
        { speaker: NAOKO, text: '生存者信号3つ。民間船が二隻残ってる。撃つ前に、声の遅延を数えて。', tone: 'command', after: RELAY_DELAY },
        { speaker: NAOKO, text: '遅れない声は、こちらの声じゃない。名前ではなく勢力表示を見て。', tone: 'command', after: 3 },
      ],
    },
    {
      name: '帰投',
      pos: [0, 0, 0],
      arriveRadius: 1400,
      onArrive: [
        { speaker: CONTROL, text: '医療班が待っている。着艦しろ。', tone: 'command', after: RELAY_DELAY },
      ],
    },
  ],
  spawns: [
    // 帰還者3名。八十三年前の船から戻ってきた漂流者。
    // 1基ずつ搭乗者名を宣言する（T4-⑮）ので、収容した瞬間に誰を帰したかが分かる。
    // 名前は失踪者名簿（people.ts）由来。ここに文字列を書かない（T4-⑰）
    {
      shipId: 'escape-pod',
      count: 3,
      faction: 'neutral',
      atNav: 1,
      tag: TAG.rescue,
      spread: 1000,
      speed: 5,
      displayNames: DRIFTERS,
    },
    /**
     * 本物の民間船2隻（T4-⑰）。**撃ってはいけない相手**。
     *
     * 中立なので誰とも交戦しない（＝誰にも撃たれない・沈められない）。
     * 沈むのは自機が撃ったときだけなので、失敗経路は誤射に一本化される。
     * 漂う速度にしてあるのは、同じ名前で高速に寄ってくる偽装機と
     * **速度で見分けられる**ようにするため。
     *
     * 1隻ずつ別の群にしているのは、船籍名を `displayName`（固有名の唯一の出所）で
     * 宣言するため。`displayNames` の添字に頼らず、群と名前を1対1にしておく。
     */
    {
      shipId: 'refugee-liner',
      count: 1,
      faction: 'neutral',
      atNav: 1,
      delay: 2,
      offset: [-900, 300, -1800],
      speed: 14,
      tag: TAG.civilian,
      displayName: LINER_A,
      radio: [
        // 本物の船の声。門を越えて遅れて届く（after あり）
        { speaker: LINER_A, text: 'こちら難民船。動力を落として漂っています。撃たないでください。', tone: 'friendly', after: RELAY_DELAY },
        { speaker: NAOKO, text: 'いまの声は遅れた。二隻は本物。識別を確認してから撃って。', tone: 'command', after: 3 },
      ],
    },
    {
      shipId: 'refugee-liner',
      count: 1,
      faction: 'neutral',
      atNav: 1,
      delay: 2,
      offset: [700, -400, -2200],
      speed: 12,
      tag: TAG.civilian,
      displayName: LINER_B,
    },
    // 偽装ドローン群（前段）: 連邦識別を返す。味方と同じ機種を敵陣営で出して紛らわしくする。
    // displayName に僚機の呼称を入れるので、HUD のターゲット名まで偽装される（T4-⑰）。
    // 見分けられるのは勢力表示（キルラシー）と、遅延ゼロの声だけ
    {
      shipId: 'hornet',
      count: 3,
      faction: 'kilrathi',
      atNav: 1,
      delay: 5,
      offset: [2700, 600, -2500],
      tag: TAG.decoy,
      displayName: SPOOF,
      radio: [
        // 偽装の声。遅延ゼロで割り込む（after を書かない）ので、本物より先に届く
        { speaker: SPOOF, text: 'こちらラプター 2。右に付く。撃つな。', tone: 'friendly' },
        // 本物の乗員の声は遅れて届く。この順序が唯一の判別材料
        { speaker: NAOKO, text: '連邦識別が3つ。……うちの機体番号を返してる。', tone: 'command', after: RELAY_DELAY },
        { speaker: NAOKO, text: '今の「ラプター 2」は遅れなかった。あれは味方じゃない。', tone: 'command', after: 3 },
      ],
    },
    // 偽装ドローン群（後段）: 今度は帝国識別。応答が二重化する。
    // さらに民間船の船籍名をそのまま返す（T4-⑰）。名前は同じでも機影は戦闘機
    {
      shipId: 'kf01-leonfang',
      count: 2,
      faction: 'kilrathi',
      atNav: 1,
      delay: 45,
      offset: [-3200, -800, -2700],
      tag: TAG.decoy,
      displayName: LINER_A,
      radio: [
        // 二重化した応答。こちらも遅延ゼロ
        { speaker: LINER_A, text: 'こちら難民船。曳航してくれ。', tone: 'friendly' },
        { speaker: NAOKO, text: `遅れなかった。${LINER_A}の名前を返す機体が2つある。機影を見て——戦闘機よ。`, tone: 'command', after: RELAY_DELAY },
      ],
    },
  ],
  objectives: [
    // 必須①: 章の主目標。漂流者3名の回収。1名でも失うと失敗（rescue の既定挙動）
    {
      id: 'drifters',
      // T4-⑮: 収容は操作になった。半径に入るだけでは拾えない
      text: '漂流者3名を収容する（300m 以内で減速し3秒保つ／誤射ゼロで連れ帰る）',
      required: true,
      spec: { kind: 'rescue', tag: TAG.rescue, radius: 300 },
    },
    // 必須②: 民間船の識別確認（T4-⑰）。**照準に収めて、撃たない**操作そのものを目標にする。
    //   「名前ではなく勢力表示と機影で確かめる」というこの章の正解手順を、
    //   ミッション側の必須目標として要求する。撃つ必要はない（recon は発砲を見ない）
    {
      id: 'identify',
      text: '民間船2隻の識別を確認する（照準に収めて2.4km以内を6秒保つ／勢力表示が中立なら本物）',
      required: true,
      spec: { kind: 'recon', tag: TAG.civilian, seconds: 6, range: 2400, coneDeg: 26 },
    },
    // 必須③: 偽装無人機の排除（T4-⑰ で任意 → 必須）。
    //   ここが「撃たないだけでは通らない」ことの担保。異常圏を閉じるには
    //   偽装信号を出している機体を落とすしかない。
    //   撃つべき相手（キルラシー陣営）と撃ってはいけない相手（中立）が混ざっているので、
    //   撃つ前に識別する必要がある
    {
      id: 'decoys',
      text: '偽装信号を返す無人機を排除する（勢力表示がキルラシーの機体だけ）',
      required: true,
      spec: { kind: 'destroyTag', tag: TAG.decoy },
    },
    // 必須④: この章の評価そのもの。誤射（味方・非敵対勢力への命中）が1発でもあれば失敗。
    //   偽装無人機は敵陣営なので撃っても誤射にならないが、名前を偽装しているので
    //   **名前だけで撃つと本物の民間船・脱出ポッドに当たる**。
    //   誤射した瞬間の指摘は `friendlyFireRadio` が出す
    {
      id: 'no-friendly-fire',
      text: '誤射ゼロ。民間船と漂流者へ1発も当てない',
      required: true,
      spec: { kind: 'noFriendlyFire' },
    },
    // 加点①: 民間船を無傷のまま門の外へ出す。
    //   誤射ゼロでいれば自動的に成立する（中立は誰にも撃たれない）が、
    //   「二隻を残したことが記録に載る」ことを表に出しておく
    {
      id: 'liners-safe',
      text: `${LINER_A}と${LINER_B}を無傷で通す`,
      required: false,
      reward: '＋航路信頼',
      spec: { kind: 'protectCount', tag: TAG.civilian, min: 2 },
    },
    // 必須⑤: 帰投。回収した3名を母艦へ連れ帰るまでが任務
    {
      id: 'home',
      text: `${CLAW}へ帰投する`,
      required: true,
      spec: { kind: 'reachNav', navIndex: 2 },
    },
  ],
  openingRadio: [
    { speaker: SOPHIE, text: '航法演習として発艦します。記録はそう残ります。', tone: 'friendly', after: RELAY_DELAY },
    { speaker: NAOKO, text: '撃つ前に、声の遅延を数えて。三つ数えるまで撃たない。', tone: 'command', after: 4 },
    { speaker: NAOKO, text: 'こちらの声は必ず遅れる。遅れない声は偽装。名前ではなく勢力表示を見て。', tone: 'command', after: 3 },
  ],
  debriefWin: [
    '帰還者は三人。生体記録は完全に一致していて、証言だけが噛み合いません。',
    '一人は連邦艦隊に撃たれたと言い、一人はキルラシーに撃たれたと言い、最後の一人は誰も撃っていないと言います。門が引き込んだのだ、と。',
    `${LINER_A}と${LINER_B}は自力で港へ向かいました。名前を騙った機体だけが、異常圏に残っています。`,
    '矛盾は嘘ではありません。門が返した三つの結果です。……異種通信アンドロイドのメモリアが、共通記録層への接続を申し出ています。繋いだものは、二度と切り離せないかもしれません。',
  ],
  debriefLoss: [
    '信号は消えました。八十三年ぶりに戻ってきたものを、六時間で失ったことになります。',
    '演習の記録は残ります。失われた三人の名前は、どこにも残りません。',
  ],
};
