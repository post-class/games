/**
 * 第3章 OPERATION QUIET SEA（静穏海）。
 *
 * 出典（正典）:
 * - `00_initila_constructions/05_story_改善/spec/ストーリー_十章作戦記録.html` CHAPTER 03
 *   （本文6段落／主目標／戦術マップ `ch3`）
 * - 手順書 §9 T5-03
 *
 * ■ この章のねらい
 * 反転した戦場。ニューロウムの機雷は避難船にはまったく反応せず、軍用推進器の熱紋だけに反応する。
 * つまり護衛が近づくほど回廊が危険になる。撃墜の腕は役に立たず、
 * 問われるのは「アウルの共鳴パルスと呼吸を合わせ、安全な一分間を正しい場所に作れるか」だけ。
 * 追ってくる帝国の哨戒機には、撃たずに進路を譲ることができる。
 *
 * ■ ギミックの実装（T6-3）
 * - 熱紋機雷: `hazards.minefield.thermalOnly` で「軍用推進器（戦闘機・爆撃機）の熱紋にだけ
 *   反応する」機雷にした。避難船・救難艇は `role: 'transport'` なので通り抜けられ、
 *   護衛（自機・帝国哨戒機）が近づくほど回廊が危険になる反転が成立する。
 * - 共鳴パルス: `hazards.minefield.resonance` で 80 秒周期・60 秒有効の安全窓を宣言する。
 *   窓が開いている間は機雷が起爆シーケンスに入らない。**自機が発砲すると歌は止まり、
 *   その出撃では二度と窓が開かない**（`MissionRunner.updateResonanceWindow()`）。
 *   窓の状態は無線と `weaponsSafe` 目標の note で読める。
 * - 避難船は `protectCount`（18隻中N隻以上の生存）で数える。
 * - `weaponsSafe` は**任意目標**。撃てば窓が閉じて機雷が起きる＝代償で戻ってくるので、
 *   「撃つ／撃たない」の二択（RULE OF NEUTRALITY）はプレイヤーに残す。
 */

import type { MissionDef } from '../../../mission/types';
import { veilChapter } from '../chapters';
import { veilPerson } from '../people';
import { CLAW, CONTROL, TAG, speakerName, theaterScenery } from './shared';

const CH = veilChapter(3);
const SCENERY = theaterScenery('quiet-sea');


/** アウル 船団指揮者（ブリーフィング話者。武器管制の停止を要求する） */
const AWL = speakerName('serecion-02');
/** クレア・ベネット 救難艇パイロット（この章で一度も引き金を引かない） */
const CLAIRE = speakerName('confed-09');
/** アクス 通信翻訳者（非殺傷の判断を誓約語へ訳し直す） */
const AXS = speakerName('serecion-08');
/** ヴァーク 儀礼通信士（訳された一行を記録に残す） */
const VARK = speakerName('kilrashi-07');
/** ソフィー・ローラン（回廊内でパルスが働く条件を試算した） */
const SOPHIE = speakerName('confed-07');

export const VEIL_CH03: MissionDef = {
  id: CH.missionId,
  title: `第3章 ${CH.title}`,
  system: CH.theaterName,
  briefingSpeaker: AWL,
  briefingSpeakerId: 'serecion-02',
  briefingSpeakerRole: veilPerson('serecion-02').role,
  briefing: [
    '要求は護衛の増派ではない。回廊に入る全艦の武器管制を停止せよ、というものだ。我々に国家はなく、あるのは季節ごとに移動する合唱圏だけ。中立は逃避ではない、誰も見捨てないために選んだ武装だ。連邦の砲を止めなければ、キルラシーの砲も止まらない。',
    `航路はニューロウムの機雷帯が塞いでいる。この機雷は避難船にはまったく反応しない。反応するのは軍用推進器の熱紋だけだ。護衛が近づくほど、回廊は危険になる。我々の共鳴パルスは八十秒ごとに一分間だけ熱紋の判定を鈍らせる。撃てば、その窓は閉じる。`,
    `艦橋は反発した。避難船十八隻の護衛に、非武装で入れというのか、と。${SOPHIE}航法士の試算がその答えだ——回廊内でパルスが働く条件は、周囲に稼働中の火器管制がないこと。つまりお前たちの武装は、防御ではなく回廊を壊す要因として計上されている。`,
    `避難船十八隻のうち六隻は自力航行できない。救難艇の${CLAIRE}が牽引に入る。彼女は今日、一度も引き金を引かない。追ってくる帝国の哨戒機には、撃たずに進路を譲れ。撃たない判断が、そのまま生存率になる。`,
  ],
  // 撃たない章。軽く速い機体で窓の間を往復する
  playerShipId: 'hornet',
  skybox: SCENERY.skybox,
  landmarks: SCENERY.landmarks,
  hazards: [
    // 回廊を塞ぐニューロウムの熱紋機雷帯。
    // `thermalOnly` で避難船・救難艇（transport）には反応しなくなる。
    // 共鳴パルスは回廊全体にかかる規則なので、先頭の機雷帯に一度だけ宣言する
    // （周期・有効時間は正典どおり 80 秒 / 60 秒）。
    {
      kind: 'minefield',
      betweenNavs: [0, 1],
      count: 20,
      spread: 1500,
      faction: 'neurowm',
      thermalOnly: true,
      resonance: { cycle: 80, window: 60, speaker: AWL },
    },
    {
      kind: 'minefield',
      atNav: 1,
      count: 16,
      spread: 1400,
      faction: 'neurowm',
      thermalOnly: true,
    },
    // 回廊の外壁になる岩。避難船の通り道を狭く見せる
    { kind: 'asteroids', atNav: 1, count: 14, spread: 2000, rockRadius: [16, 60] },
  ],
  navs: [
    {
      name: 'NAV 1 (回廊入口)',
      pos: [1200, 300, -11000],
      onArrive: [
        { speaker: AWL, text: '武器管制の停止を確認した。歌に合わせて進め。', tone: 'friendly' },
      ],
    },
    {
      name: 'NAV 2 (機雷帯)',
      pos: [-6200, -800, -24000],
      arriveRadius: 2000,
      onArrive: [
        { speaker: AWL, text: '共鳴パルス、いま一分だけ機雷が鈍る。', tone: 'friendly' },
        { speaker: CLAIRE, text: '牽引に入る。私は今日、引き金に触らない。', tone: 'friendly', after: 3 },
      ],
    },
    {
      name: 'NAV 3 (中立回廊 出口)',
      pos: [8200, 1000, -36000],
      arriveRadius: 2400,
      onArrive: [{ speaker: AWL, text: '船団は回廊を抜けた。歌は途切れていない。', tone: 'friendly' }],
    },
    {
      name: '帰投',
      pos: [0, 0, 0],
      arriveRadius: 1400,
      onArrive: [{ speaker: CONTROL, text: `${CLAW}、着艦を許可する。砲は冷えたままだな。`, tone: 'command' }],
    },
  ],
  spawns: [
    // 避難船18隻のうち、自力航行できる12隻。回廊出口（NAV 3）へ向かって巡航する
    {
      shipId: 'refugee-liner',
      count: 12,
      faction: 'neutral',
      atNav: 0,
      tag: TAG.escort,
      cruiseToNav: 2,
      speed: 55,
      spread: 2400,
      radio: [{ speaker: '避難船団', text: '十二隻、動けます。回廊へ入ります。', tone: 'friendly' }],
    },
    // 自力航行不能の6隻。クレアの救難艇に曳かれて出口へ向かう。
    // 牽引そのものの物理（曳航索・被牽引体）は実装せず、
    // 「救難艇と同じ航路を、自力航行できない速度で進む」ことで表現する。
    // 熱紋機雷は transport に反応しないので、この6隻は機雷帯を通過できる。
    {
      shipId: 'refugee-liner',
      count: 6,
      faction: 'neutral',
      atNav: 0,
      tag: TAG.escort,
      offset: [-2600, -400, 1800],
      spread: 1500,
      cruiseToNav: 2,
      // 曳航速度。自力航行の12隻（55）より明確に遅い
      speed: 22,
      radio: [{ speaker: '避難船団', text: '六隻は機関が死んでいます。曳いてください。', tone: 'friendly' }],
    },
    // クレアの救難艇。牽引に入る非武装機（専用の艇が無いため輸送機で代用）。
    // 曳く6隻と同じ出口へ向かわせ、牽引隊を1つの群として見せる。
    {
      shipId: 'drayman',
      count: 1,
      faction: 'confed',
      atNav: 0,
      // `protectCount` が「避難船18隻」だけを数えられるよう、救難艇は escort に含めない
      tag: TAG.support,
      offset: [-1400, 200, 1000],
      cruiseToNav: 2,
      speed: 40,
      radio: [{ speaker: CLAIRE, text: '救難艇、武装なしで入ります。', tone: 'friendly' }],
    },
    // アウルの気嚢船。共鳴パルスの発生源（撃たない限りパルスは続く）
    {
      shipId: 'sc03-arc',
      count: 1,
      faction: 'serecion',
      atNav: 0,
      tag: TAG.support,
      offset: [2600, 600, -1800],
      speed: 30,
    },
    // 追ってくる帝国の哨戒機。撃たずに進路を譲れる相手として置く（非必須の脅威）
    {
      shipId: 'ke04-mirage',
      count: 2,
      faction: 'kilrathi',
      atNav: 1,
      delay: 30,
      offset: [3400, 800, -3000],
      tag: TAG.target,
      radio: [
        { speaker: CONTROL, text: '帝国哨戒機2機。……撃つな、進路を譲れ。', tone: 'command' },
        { speaker: AWL, text: '撃てば窓が閉じる。機雷が起きる。', tone: 'friendly', after: 3 },
      ],
    },
  ],
  objectives: [
    // 必須①: 章の主目標。避難船18隻のうち14隻以上の生存で護送成立とする。
    //
    // min = 14 の根拠: 正典は「避難船十八隻」と「うち六隻は自力航行できない」しか定めておらず、
    // 許容損失の数値が無い。そこで
    //   (a) 護送作戦として 18 隻の 3/4（13.5隻）を上回る整数＝14 を下限にする、
    //   (b) 自力航行できる12隻を全て守れば 14 に届かないので「牽引の6隻を見捨てる」解を許さない、
    //   (c) それでも 4 隻ぶんの余裕があるので、機雷1発の巻き込みで即失敗にはならない、
    // の3点を満たす値として 14 を選んだ。
    {
      id: 'convoy',
      text: '避難船18隻のうち14隻以上を生存させる（うち6隻は自力航行不能・牽引対象）',
      required: true,
      spec: { kind: 'protectCount', tag: TAG.escort, min: 14 },
    },
    // 必須②: 回廊出口への到達。護送の完了地点なので required
    {
      id: 'corridor',
      text: '中立回廊の出口まで船団を導く',
      required: true,
      spec: { kind: 'reachNav', navIndex: 2 },
    },
    // 任意①: 武器管制の停止。アウルの要求そのものだが、**任意目標**にしてある。
    //   撃つ選択を潰さないため（撃てば共鳴パルスが止まり、機雷が起きる＝代償で返ってくる）。
    //   この目標の note に安全窓の残り秒数が出るので、HUD を触らずに窓の状態が読める。
    {
      id: 'weapons-cold',
      text: '武器管制を停止したまま回廊を抜ける（撃てば共鳴パルスが止まる）',
      required: false,
      spec: { kind: 'weaponsSafe' },
    },
    // 任意②: 撃つ道を選んだ場合の始末。撃たずに譲る解を潰さないよう required にしない
    {
      id: 'patrol',
      text: '（撃つ場合）帝国哨戒機を排除する — 撃たずに進路を譲ってもよい',
      required: false,
      spec: { kind: 'destroyTag', tag: TAG.target },
    },
    // 必須③: 帰投
    {
      id: 'home',
      text: `${CLAW}へ帰投する`,
      required: true,
      spec: { kind: 'reachNav', navIndex: 3 },
    },
  ],
  openingRadio: [
    { speaker: AWL, text: '武器管制を停止せよ。撃つ者は、回廊を壊す者だ。', tone: 'friendly' },
    { speaker: CLAIRE, text: '牽引の六隻は私が受け持つ。あなたは道を空けて。', tone: 'friendly', after: 4 },
  ],
  debriefWin: [
    'アウルは礼を言わない。彼らの言語に感謝という語はない。代わりに、次の季節の航路図が届いた。静穏海の中立回廊は、以後こちらの補給と避難に開かれる。',
    `${AXS}が、連邦機の非殺傷の判断をキルラシーの誓約語へ訳し直した。${VARK}の記録に、こう残っている——「その者は、砲を持ちながら撃たなかった」。`,
    'この一行が、灰冠回廊での決闘の条件を変える。',
  ],
  debriefLoss: [
    '回廊は閉じた。共鳴パルスは止まり、機雷は起きたままだ。避難船団は静穏海の外へ押し戻された。',
    'アウルからの通信は一度もない。次の季節の航路図も、届かない。',
  ],
};
