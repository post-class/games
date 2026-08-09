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
 * ロックオンの応答が二重化する。正しい判別手段はひとつだけ——通信の遅延を数えること。
 * 味方の声は必ず遅れて届き、偽装された声は遅れない。
 *
 * ■ 誤射ゼロの扱い（T6-2 で実装済み）
 * 章の評価は撃墜数ではなく「誤射ゼロで漂流者を回収できたか」。
 * `noFriendlyFire` を**必須目標**に置き、味方・非敵対勢力（＝僚機と中立の脱出ポッド）へ
 * 1発でも当てた時点で任務失敗にする。偽装機の撃墜は任意目標のままなので、
 * 「撃たずに拾って帰る」解も、「危険を承知で撃つ」解も両方成立する。
 * 「連邦識別を返す無人機」を **味方機と同じ機種（hornet）でキルラシー陣営として** 出すことで、
 * 見た目・識別・応答が紛らわしい状態を再現している。
 *
 * ■ 判別手段＝通信の遅延（T6-2 の要点）
 * `MissionRunner.queueRadio()` は `RadioLineDef.after` を「直前の台詞からの待ち時間」として
 * 積み上げるので、無線の到達順そのものが遅延になる。そこでこの章では次の規約を敷いた。
 *   - **本物の味方（乗員・管制）の台詞には必ず `after` を書く**（門を越えて遅れて届く声）。
 *   - **偽装ドローンが名乗る台詞には `after` を書かない**（遅延ゼロで割り込む声）。
 * 結果、同じ呼称の声が「先に喋った方＝偽装」「遅れて届いた方＝本物」の順で必ず並ぶ。
 * プレイヤーは遅延を数えるだけで判別でき、その規約は単体テストで固定している。
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
 */
const SPOOF = '僚機〈ラプター 2〉';
/** 本物の味方の声に付ける最小の遅延（秒）。門を越えて遅れて届く分 */
const RELAY_DELAY = 3;

export const VEIL_CH02: MissionDef = {
  id: CH.missionId,
  title: `第2章 ${CH.title}`,
  system: CH.theaterName,
  briefingSpeaker: SOPHIE,
  briefingSpeakerId: 'confed-07',
  briefingSpeakerRole: veilPerson('confed-07').role,
  briefing: [
    '断片ログを復号したら、ありえない座標が出ました。2229年のラグランジュ事故で消失した巡洋艦の生存者信号です。八十三年前に消えた船から届いたタイムスタンプが、六時間前を指しています。観測できるものを観測しないのは、航法ではなく信仰です。',
    `これは正規の命令ではありません。司令部は八十三年前に沈んだ船の座標を認めないので、航法演習の名目で三機分の燃料を確保しました。${HART}艦長は書類を見て一度だけ確認しました。「演習で、脱出ポッドの回収装備を積むのか」。積みます、と答えました。`,
    `門の異常圏には、連邦とキルラシー双方の識別を模した無人機群がいます。ロックオンのたびに応答が二重化し、通信にはあなたの僚機の声が混じります。判別手段はひとつだけ、通信の遅延です。${NAOKO}士官の指示に従ってください——撃つ前に、声の遅延を数えて。`,
    'この任務の評価は撃墜数ではありません。誤射ゼロで、漂流者3名を連れて帰ること。焦って撃てば、あなたが撃つのは味方の識別です。',
  ],
  // 脱出ポッドの回収装備を積むため、爆装枠のある機体で出す
  playerShipId: 'scimitar',
  skybox: SCENERY.skybox,
  landmarks: SCENERY.landmarks,
  // 門の外縁に漂う残骸帯。異常圏の入口を「何かが壊れた場所」にする
  hazards: [{ kind: 'asteroids', atNav: 1, count: 20, spread: 1800, rockRadius: [14, 70] }],
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
        { speaker: NAOKO, text: '生存者信号3つ。撃つ前に、声の遅延を数えて。', tone: 'command', after: RELAY_DELAY },
        { speaker: NAOKO, text: '遅れない声は、こちらの声じゃない。', tone: 'command', after: 3 },
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
    // 帰還者3名。八十三年前の船から戻ってきた漂流者
    {
      shipId: 'escape-pod',
      count: 3,
      faction: 'neutral',
      atNav: 1,
      tag: TAG.rescue,
      spread: 1000,
      speed: 5,
    },
    // 偽装ドローン群（前段）: 連邦識別を返す。味方と同じ機種を敵陣営で出して紛らわしくする
    {
      shipId: 'hornet',
      count: 3,
      faction: 'kilrathi',
      atNav: 1,
      delay: 5,
      offset: [2700, 600, -2500],
      tag: TAG.decoy,
      radio: [
        // 偽装の声。遅延ゼロで割り込む（after を書かない）ので、本物より先に届く
        { speaker: SPOOF, text: 'こちらラプター 2。右に付く。撃つな。', tone: 'friendly' },
        // 本物の乗員の声は遅れて届く。この順序が唯一の判別材料
        { speaker: NAOKO, text: '連邦識別が3つ。……うちの機体番号を返してる。', tone: 'command', after: RELAY_DELAY },
        { speaker: NAOKO, text: '今の「ラプター 2」は遅れなかった。あれは味方じゃない。', tone: 'command', after: 3 },
      ],
    },
    // 偽装ドローン群（後段）: 今度は帝国識別。応答が二重化する
    {
      shipId: 'kf01-leonfang',
      count: 2,
      faction: 'kilrathi',
      atNav: 1,
      delay: 45,
      offset: [-3200, -800, -2700],
      tag: TAG.decoy,
      radio: [
        // 二重化した応答。こちらも遅延ゼロ
        { speaker: SPOOF, text: 'ラプター 2、被弾した。援護してくれ。', tone: 'friendly' },
        { speaker: NAOKO, text: '帝国識別。応答が二重化してる。遅延を聞いて。', tone: 'command', after: RELAY_DELAY },
      ],
    },
  ],
  objectives: [
    // 必須①: 章の主目標。漂流者3名の回収。1名でも失うと失敗（rescue の既定挙動）
    {
      id: 'drifters',
      text: '漂流者3名を回収する（誤射ゼロで連れ帰る）',
      required: true,
      spec: { kind: 'rescue', tag: TAG.rescue, radius: 300 },
    },
    // 必須②: この章の評価そのもの。誤射（味方・非敵対勢力への命中）が1発でもあれば失敗。
    //   偽装ドローンは敵陣営なので撃っても誤射にならないが、
    //   紛らわしい相手を撃てば撃つほど、僚機と中立の脱出ポッドに当てる危険が上がる。
    //   撃たずに拾って帰れば、この目標は最後まで成立し続ける。
    {
      id: 'no-friendly-fire',
      text: '誤射ゼロ。味方と中立の識別へ1発も当てない',
      required: true,
      spec: { kind: 'noFriendlyFire' },
    },
    // 任意①: 偽装信号の排除。撃墜数で評価しない章なので required にしない。
    //   （撃たずに漂流者だけ拾って帰る解も成立させる）
    {
      id: 'decoys',
      text: '偽装信号を返す無人機を排除する（撃墜数では評価しない）',
      required: false,
      spec: { kind: 'destroyTag', tag: TAG.decoy },
    },
    // 必須③: 帰投。回収した3名を母艦へ連れ帰るまでが任務
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
    { speaker: NAOKO, text: 'こちらの声は必ず遅れる。遅れない声は偽装。それだけ覚えて。', tone: 'command', after: 3 },
  ],
  debriefWin: [
    '帰還者は三人。生体記録は完全に一致していて、証言だけが噛み合いません。',
    '一人は連邦艦隊に撃たれたと言い、一人はキルラシーに撃たれたと言い、最後の一人は誰も撃っていないと言います。門が引き込んだのだ、と。',
    '矛盾は嘘ではありません。門が返した三つの結果です。……異種通信アンドロイドのメモリアが、共通記録層への接続を申し出ています。繋いだものは、二度と切り離せないかもしれません。',
  ],
  debriefLoss: [
    '信号は消えました。八十三年ぶりに戻ってきたものを、六時間で失ったことになります。',
    '演習の記録は残ります。失われた三人の名前は、どこにも残りません。',
  ],
};
