/**
 * 第10章 OPERATION OPEN HAND — ヴェガ門。
 *
 * 出典（正典）:
 * - `00_initila_constructions/05_story_改善/spec/ストーリー_十章作戦記録.html` CHAPTER 10
 * - 章メタ: `src/content/veil/chapters.ts` の `veil-ch10`（門制御の3択は章側の `choice` が持つ）
 * - 旗艦戦の書式のお手本: `src/content/missions.ts` の `M6_FLAGSHIP`
 *
 * ■ この章の思想
 * 「勝つためではなく、次に通る者のために撃つ。」
 * この空域で戦うのは連邦だけではない。セレシオンは避難船を後方へ抜き、オルドは門の位相を押さえ、
 * ニューロウムは全軍の識別を同期し、キルラシーの決闘士は旗艦の護衛を引き剥がす。
 * **誰も指揮を統一していない。** それぞれが自分の共同体のために動いた結果、たまたま同じ一手になっている。
 *
 * ■ 「共同作戦だが指揮系統がない」ことをどう表すか（F5の実装方針）
 * 1. 他勢力の援護を `atNav` / `delay` の異なる**バラバラのタイミング**で出す。
 *    連邦の突撃と同時ではなく、各勢力が自分の都合で動き出す（同期していない＝命令されていない）。
 * 2. 各勢力の無線は連邦の指示に**応答しない**。自分の共同体の理由だけを言って、結果として噛み合う。
 * 3. `capitalStages` / `capitalSequence` の各段階は、他勢力の動きが「たまたま」前提を作る形にする。
 *    管制が援護を要請する台詞は置かない（要請できる相手がいないため）。
 *
 * ■ 難易度について
 * 4状態（帰還者／航路信頼／軍令信用／敵エースの誓約）は**難易度を上下させない**。
 * 変わるのは味方の顔ぶれと空域の景色だけである（仕様の明示）。
 * したがってこのファイルには敵の技量・攻撃力に関する補正を一切書かない。
 * 援護の顔ぶれを4状態で切り替えるのは T4-3 の担当なので、F5では固定で出す。
 *
 * ■ F5（最小成立版）の範囲
 * ミッション側は**旗艦の無力化まで**。門制御の3択とエンディング演出、帰還者名簿の読み上げは扱わない。
 */

import type { MissionDef } from '../../../mission/types';
import { veilChapter } from '../chapters';
import { CLAW, CONTROL, TAG, speakerName, theaterScenery } from './shared';

/** 無線・ブリーフィングの話者名。人物名簿を単一の出所にする */
const SERECION_02 = speakerName('serecion-02');
const ORDO_01 = speakerName('ordo-01');
const CONFED_06 = speakerName('confed-06');
const NEUROWM_01 = speakerName('neurowm-01');
const CONFED_07 = speakerName('confed-07');
const KILRASHI_03 = speakerName('kilrashi-03');

const scenery = theaterScenery('vega-gate');

export const VEIL_CH10: MissionDef = {
  id: 'veil-ch10',
  title: `第10章 ${veilChapter(10).title}`,
  system: 'ヴェガ門',
  briefingSpeaker: CONFED_06,
  briefingSpeakerId: 'confed-06',
  briefingSpeakerRole: '〈タイガーズ・クロー〉艦長・元救難隊',
  // TODO(T7-1): 最終ブリーフィングに台詞の主導権はない。主人公5名のどの経歴を選んだかで
  //   発言者と語り口が入れ替わる（救難優先なら名簿を、迎撃が得意なら残弾を、訓練生上がりなら
  //   仲間の帰還を最初に口にする）。F5では共通文を置き、差分は T7-1 / T7-5 で載せる。
  briefing: [
    '持ち帰った設計図が示す事実は三つだ。制御核を破壊すれば門は永久に閉じ、この宙域の戦争は終わる。同時に辺境の居住区も切り捨てられる。共鳴させれば全勢力の航路が再起動し、連邦の物流は生き延びるが、開いた扉の管理者は誰でもなくなる。五者共同管理は、最も遅く、最も脆く、最も多くの署名を必要とする道だ。',
    '選ぶ前に、急進派の連合旗艦が最後の突撃を開始した。この空域で戦うのは連邦だけではない。セレシオンの気嚢船が避難船を後方へ抜き、オルドの重力アンカーが門の位相を押さえ、ニューロウムの中継器が全軍の識別を同期し、キルラシーの決闘士が旗艦の護衛を引き剥がす。',
    '誰も指揮を統一していない。それぞれが自分の共同体のために動いた結果、たまたま同じ一手になっている。それがこの戦いの勝ち方だ。勝つためではなく、次に通る者のために撃て。',
    '今日の出撃は、勝ち方を決める出撃だ。負け方はもう決まっている。',
  ],
  // F-44A ラピアー II。対艦魚雷を積んで旗艦の部位を潰す（お手本の M6_FLAGSHIP と同じ構成）。
  /**
   * 共同作戦の関係。この出撃の間だけ連邦とニューロウムを非敵対にする。
   *
   * ニューロウムの中継器は全軍の識別を同期する側として飛ぶので、
   * 既定の「連邦と敵対」のままだと援護機を撃ててしまう。
   *
   * **帝国は陣営単位では味方にできない**。急進派の連合旗艦（`kilrathi`）と
   * 決闘士ラギティカが同じ陣営にいるため、陣営関係を非敵対にすると旗艦も
   * 撃てなくなる。そこでラギティカだけを `neutral` で置いて「撃たない・撃たれない
   * 第三者」として表現している（陣営単位の関係表の限界であり、個体単位の
   * 敵対関係が必要になったらそこを拡張する）。
   */
  factionStances: [{ a: 'confed', b: 'neurowm', stance: 'neutral' }],
  playerShipId: 'rapier',
  playerMissiles: [
    { missileId: 'heat-seeker', count: 2 },
    { missileId: 'torpedo', count: 4 },
  ],
  skybox: scenery.skybox,
  landmarks: scenery.landmarks,
  hazards: [
    // 旗艦の周りに割られた制御核の破片。門の位相が荒れている場所を岩で示す。
    { kind: 'asteroids', atNav: 1, count: 24, spread: 2600, rockRadius: [18, 80] },
  ],
  navs: [
    {
      name: 'NAV 1 (門前・集合点)',
      pos: [5000, 1200, -17000],
      arriveRadius: 1800,
      onArrive: [
        { speaker: CONFED_07, text: '門の位相が揺れています。……誰かが外側から押さえている。', tone: 'friendly' },
      ],
    },
    {
      name: 'NAV 2 (急進派連合旗艦)',
      pos: [-8000, -2500, -34000],
      arriveRadius: 2400,
      onArrive: [
        { speaker: CONTROL, text: '連合旗艦を視認。護衛が上がってくる。', tone: 'command' },
        { speaker: KILRASHI_03, text: '護衛は私が引き剥がす。おまえは本体を狙え。命令ではない、私の都合だ。', tone: 'enemy', after: 2 },
      ],
    },
    {
      name: '帰投',
      pos: [0, 0, 0],
      arriveRadius: 1400,
      onArrive: [
        // TODO(T7-6): 門制御の選択（閉鎖／限定開放／五者共同管理）とエンディング演出。
        { speaker: CLAW, text: '旗艦は止まった。……門制御の選択は、艦橋で待つ。', tone: 'friendly' },
      ],
    },
  ],
  spawns: [
    // ── 急進派連合旗艦とその護衛 ──
    {
      shipId: 'kilrashi-destroyer',
      count: 1,
      faction: 'kilrathi',
      atNav: 1,
      tag: TAG.capital,
      speed: 40,
      radio: [{ speaker: CONTROL, text: '連合旗艦、突撃軌道。あれが五者通行協定を私有した艦だ。', tone: 'command' }],
    },
    {
      shipId: 'kf06-talon',
      count: 2,
      faction: 'kilrathi',
      atNav: 1,
      delay: 4,
      offset: [4600, 1200, 4200],
      tag: TAG.guard,
    },
    {
      shipId: 'kb02-bastion',
      count: 2,
      faction: 'kilrathi',
      atNav: 1,
      delay: 30,
      offset: [-4200, -900, 3800],
      tag: TAG.guard,
      radio: [{ speaker: '急進派通信', text: '門は我らの家門のものだ。誓約など古い。', tone: 'enemy' }],
    },

    // ── 避難船。守れなくても旗艦は落とせるので、目標は任意にする ──
    {
      shipId: 'refugee-liner',
      count: 2,
      faction: 'neutral',
      atNav: 0,
      offset: [1800, -400, 1200],
      spread: 900,
      tag: TAG.escort,
      speed: 30,
      cruiseToNav: 2,
    },

    // ── 他勢力の援護。TAG.support で置く ──
    // TODO(T4-3): 援護の顔ぶれ・機数を4状態（帰還者／航路信頼／軍令信用／敵エースの誓約）で
    //   切り替える。F5では固定で出す。**難易度パラメータは変更しない。**
    //
    // 出現タイミングを意図的にずらしている。連邦の突撃と同期していないこと＝
    // 「誰も指揮を統一していない」ことを、データの上で表現するため。
    {
      // セレシオン: 避難船を後方へ抜く。戦うためではなく、船団の季節航路を守るために来た。
      shipId: 'sh06-halcyon',
      count: 1,
      faction: 'serecion',
      atNav: 0,
      delay: 6,
      offset: [2600, 600, 2000],
      tag: TAG.support,
      speed: 50,
      radio: [{ speaker: SERECION_02, text: '避難船を後方へ抜く。連邦の作戦には加わらない。我々の航路を守るだけだ。', tone: 'friendly' }],
    },
    {
      shipId: 'sc03-arc',
      count: 2,
      faction: 'serecion',
      atNav: 0,
      delay: 14,
      offset: [3400, -300, 1400],
      spread: 800,
      tag: TAG.support,
    },
    {
      // オルド: 門の位相を重力アンカーで押さえる。地層記憶の保全が理由で、連邦のためではない。
      shipId: 'oe06-ironroot',
      count: 1,
      faction: 'ordo',
      atNav: 1,
      delay: 10,
      offset: [-2200, 1600, 5200],
      tag: TAG.support,
      speed: 30,
      radio: [{ speaker: ORDO_01, text: '門の位相を押さえる。理由は我々の地層記憶だ。結果が噛み合うなら、それでよい。', tone: 'friendly' }],
    },
    {
      // ニューロウム: 全軍の識別を同期する。接続を維持したいだけで、勝敗に関心がない。
      shipId: 'nn04-sky',
      count: 2,
      faction: 'neurowm',
      atNav: 1,
      delay: 18,
      offset: [1600, 2200, 4600],
      spread: 900,
      tag: TAG.support,
      radio: [{ speaker: NEUROWM_01, text: '全軍の識別を同期した。誰の指揮下でもない。誤射を減らすためだ。', tone: 'friendly' }],
    },
    {
      shipId: 'nc01-protocol',
      count: 1,
      faction: 'neurowm',
      atNav: 1,
      delay: 26,
      offset: [2400, -1400, 5400],
      tag: TAG.support,
      speed: 40,
    },
    {
      // キルラシーの決闘士。誓約下でこの出撃だけ連邦を撃たないため、敵対テーブルを触らずに
      // `neutral` で置く（`setFactionStance` による切り替えは T6-10 の担当）。
      shipId: 'kf03-greyhaul',
      count: 1,
      faction: 'neutral',
      atNav: 1,
      delay: 8,
      offset: [-3200, -600, 4200],
      tag: TAG.support,
      speed: 70,
      ace: { pilot: 'ラギティカ' },
      radio: [{ speaker: KILRASHI_03, text: '大牙王の誓約に従う。今日は、あの艦の護衛を私が引き受ける。', tone: 'enemy' }],
    },
  ],
  objectives: [
    // 必須: 護衛を分断しないと旗艦の部位に取り付けない（capitalStages の第1段階と同じ条件）。
    {
      id: 'ch10-guards',
      text: '連合旗艦の護衛を分断する',
      required: true,
      spec: { kind: 'destroyTag', tag: TAG.guard },
    },
    // 必須: この章の主目標そのもの。
    {
      id: 'ch10-capital',
      text: '急進派連合旗艦を無力化する',
      required: true,
      spec: { kind: 'destroyTag', tag: TAG.capital },
    },
    // 任意: 避難船はセレシオンが後方へ抜くため、連邦単独の責任ではない。
    // 守れなくても旗艦は落とせるので required にしない（「次に通る者のために撃つ」の任意目標）。
    {
      id: 'ch10-refugees',
      text: '避難船をセレシオンの気嚢船まで通す',
      required: false,
      spec: { kind: 'protect', tag: TAG.escort },
    },
    // 必須: 門制御の選択は艦橋で行うため、帰投まで生きて戻る必要がある。
    // TODO(T7-6): 門制御の選択とエンディング演出（閉鎖／限定開放／五者共同管理）。
    {
      id: 'ch10-home',
      text: '帰投し、門制御の選択に立ち会う',
      required: true,
      spec: { kind: 'reachNav', navIndex: 2 },
    },
  ],
  // 互換用の段階表（護衛 → 旗艦本体）。
  capitalStages: [
    { id: 'guards', text: '連合旗艦の護衛を分断', tag: TAG.guard },
    { id: 'capital', text: '連合旗艦を無力化', tag: TAG.capital },
  ],
  // 部位攻撃の実行順。各段階の前提は「他勢力がたまたま作ってくれた状況」であり、
  // 連邦が要請した結果ではない（無線が誰にも指示を出していないことに注意）。
  capitalSequence: [
    {
      id: 'turret',
      text: '旗艦の砲塔を無力化',
      tag: TAG.capital,
      subsystem: 'turret',
      radio: [{ speaker: KILRASHI_03, text: '護衛は退けた。砲塔が空いている。……礼はいらない。', tone: 'enemy' }],
    },
    {
      id: 'engine',
      text: '旗艦のエンジンを停止',
      tag: TAG.capital,
      subsystem: 'engine',
      radio: [{ speaker: ORDO_01, text: '位相を押さえている。あの艦は跳べない。', tone: 'friendly' }],
    },
    {
      id: 'torpedo',
      text: '旗艦へ対艦魚雷を発射',
      tag: TAG.capital,
      weapon: 'torpedo',
      radio: [
        { speaker: CONFED_06, text: '勝つためではない。次に通る者のために撃て。', tone: 'command' },
      ],
    },
  ],
  openingRadio: [
    { speaker: CONFED_06, text: '今日の出撃は、勝ち方を決める出撃だ。負け方はもう決まっている。', tone: 'command' },
    {
      speaker: CONFED_07,
      text: '他勢力の航跡が入ってきます。……どこからも指揮電文は来ていません。各自の判断です。',
      tone: 'friendly',
      after: 3,
    },
    { speaker: CONTROL, text: '魚雷は NAV 2 到達後に使え。ロック中は直進を保て。', tone: 'command', after: 3 },
  ],
  // 撃墜数の集計は表示しない（仕様）。読み上げられる名前の数だけがプレイヤーの戦績である。
  // TODO(T7-6): 帰還した者の名前を、艦と勢力を問わず一人ずつ読み上げる
  //   （`returneeRollCall()` の出力を差し込む。第1章の民間人も、灰冠回廊で救った敵エースも同じ一覧に並ぶ）。
  debriefWin: [
    '連合旗艦は止まった。門制御は、まだ誰のものでもない。',
    '誰も指揮を統一していなかった。それぞれが自分の共同体のために動いた結果、たまたま同じ一手になった。',
    '〈タイガーズ・クロー〉の最終無線は、勝者の名を読まない。帰ってきた者の名前だけを、艦と勢力を問わず一人ずつ読み上げる。',
  ],
  debriefLoss: [
    '旗艦は門へ到達した。制御核は急進派の手に残り、扉の管理者は一つの家門になった。',
    '読み上げる名前は、今日の分だけ短くなった。',
  ],
};
