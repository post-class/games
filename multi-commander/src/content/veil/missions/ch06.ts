/**
 * 第6章 OPERATION COMMON SIGNAL — 巣脈群（`hive-veins`）。
 *
 * 出典: ストーリー_十章作戦記録.html CHAPTER 06 ／ `chapters.ts` の `veil-ch06`。
 *
 * この章の要点（データに落とすときに崩してはいけないもの）:
 * - 命令は「中継器群を破壊せよ」。反対するのは情報作戦士官の朝比奈律で、
 *   命令は変更されず**判断は現場に落ちる**。したがって
 *   **中継器を1基も壊さずに中枢へ到達できる経路が存在しなければならない**。
 *   航路は `NAV 2 (中継器群の外縁)` → `NAV 3 (静脈路)` → `NAV 4 (中枢)` と繋がっており、
 *   中継器（`TAG.target`）の撃破は**どの必須目標の前提にもなっていない**。
 *   Nav 到達は撃破と無関係に判定されるため（`src/sim/nav.ts` の `checkNavArrival`）、
 *   「命令どおり壊してから行く」「一発も撃たずに抜ける」の両方が成立する。
 * - 中枢で応答するのは原初核クラウン。彼の説明は侵略の弁明ではなく**工事の報告**で、
 *   門は閉じかけているのではなく**開きかけている**。
 * - 個体を失うことを死とみなさない相手なので、威嚇も人質も通じない。ドローンは数で押す。
 *
 * F6（T6-6）で入れた二つの規則:
 * - `commsDelay.friendlySeconds: 3` — 味方位置の報告が3秒遅れる（`src/sim/comms.ts`）。
 *   HUD の位置・距離・レーダー・航法マップと ITTS の照準支援がすべて同じ報告位置を使うので、
 *   「僚機の後ろを撃つな」という無線が実挙動と一致する。プレイヤーへの伝達は
 *   T6-3 と同じ二経路（無線＋目標の note）＋HUD の「通信妨害」表示。
 * - `swarmLearning.faction: 'neurowm'` — 撃墜された数に応じて隊形・張り付く数・
 *   回避の入れ方が変わる（`src/sim/ai.ts`）。**HP・攻撃力・弾速・命中補正は変えない。**
 *   段階には上限があり（4機ごとに1段階、上限3段階）、配置した21機のうち12機で頭打ちになる。
 *   「撃つほど不利になる」は成立させるが、詰みは作らない（静脈路を選ばなかった者を殺さない）。
 */

import type { MissionDef } from '../../../mission/types';
import { veilChapter } from '../chapters';
import { skillFromGrade, veilPerson } from '../people';
import { CLAW, CONTROL, TAG, speakerName, theaterScenery } from './shared';

const scenery = theaterScenery('hive-veins');


/** 原初核クラウン。群体最高権力者。彼にとって同意とは得るものではなく待つもの */
const CROWN = veilPerson('neurowm-01');
/** 異種通信アンドロイド メモリア。共通記録層への接続を申し出る */
const MEMORIA = veilPerson('neurowm-04');
/** 情報作戦士官 朝比奈 律。命令に反対する側 */
const RITSU = veilPerson('confed-24');
/** 迎撃編隊リーダー 神谷 隼人。通信遅延の中で位置が3秒遅れて届く僚機 */
const HAYATO = veilPerson('confed-02');

export const VEIL_CH06: MissionDef = {
  id: 'veil-ch06',
  title: `第6章 ${veilChapter(6).title}`,
  system: '巣脈群',
  briefingSpeaker: speakerName(RITSU.id),
  briefingSpeakerId: RITSU.id,
  briefingSpeakerRole: RITSU.role,
  briefing: [
    '命令を読み上げます。巣脈群のニューロウム中継器群を破壊し、通信障害を解消せよ。以上です。命令は変更されませんでした。',
    '反対意見も記録として残します。障害の発生時刻と、ヴェガ門の異常出力の記録が完全に同期しています。中継器は障害の原因ではなく、障害を測っている装置かもしれません。壊すのは構いません。ただ、体温計を割っても熱は下がりません。',
    '現場の条件は最悪です。妨害で味方の位置は3秒遅れて届き、ドローンは撃った数だけ隊形を変えます。個体を失うことを死とみなさない相手に、威嚇も人質も通じません。撃てば撃つほど、群体はこちらの戦い方を学習して増えます。',
    `中枢まで通じる隙間――静脈路が一本あります。中継器を撃たずに抜けられます。中枢で応答するのは原初核${CROWN.name}。意図を確認してください。判断は現場に落ちました。`,
  ],
  playerShipId: 'rapier',
  wingman: {
    shipId: 'scimitar',
    pilot: speakerName(HAYATO.id),
    skill: skillFromGrade(HAYATO.grade),
  },
  skybox: scenery.skybox,
  landmarks: scenery.landmarks,
  /**
   * 通信妨害。味方の位置が3秒遅れて届く（仕様「味方の位置が三秒遅れて届く地獄だ」）。
   * 遅れるのは味方だけで、敵ドローンの位置は遅れない（妨害されているのは味方同士の通信）。
   */
  commsDelay: { friendlySeconds: 3 },
  /**
   * 学習する群体。撃墜された数だけ隊形と攻め方が変わる
   * （仕様「撃てば撃つほど、群体はこちらの戦い方を学習して増える」）。
   * 難易度パラメータは一切変えない。上限は `src/sim/ai.ts` の MAX_SWARM_LEVEL。
   */
  swarmLearning: { faction: 'neurowm' },
  hazards: [
    // 巣脈の壁。中継器群の外縁を岩で囲み、「隙間を抜ける」感触を作る
    { kind: 'asteroids', atNav: 1, count: 34, spread: 1700, rockRadius: [18, 95] },
    // 静脈路。細い隙間なので、帯として航路上にばらまく
    { kind: 'asteroids', betweenNavs: [1, 2], count: 40, spread: 1300, rockRadius: [16, 70] },
    { kind: 'asteroids', atNav: 3, count: 20, spread: 2000, rockRadius: [14, 60] },
  ],
  navs: [
    {
      name: 'NAV 1 (巣脈の入口)',
      pos: [0, 400, -12000],
      onArrive: [
        {
          speaker: CONTROL,
          text: '妨害開始。味方の位置が3秒遅れて届く。表示を信じ切るな。',
          tone: 'command',
        },
      ],
    },
    {
      name: 'NAV 2 (中継器群の外縁)',
      pos: [-7000, -1500, -24000],
      arriveRadius: 2400,
      onArrive: [
        {
          speaker: speakerName(RITSU.id),
          text: '中継器を視認。撃つかどうかは、そちらの判断です。',
          tone: 'command',
        },
        {
          speaker: speakerName(HAYATO.id),
          text: '俺の位置表示、3秒古いぞ。撃つなら俺の後ろを撃つな。',
          tone: 'friendly',
          after: 2.5,
        },
      ],
    },
    {
      name: 'NAV 3 (静脈路)',
      pos: [6000, 1800, -31000],
      arriveRadius: 2000,
      onArrive: [
        {
          speaker: MEMORIA.name,
          text: '通しました。ここは撃たなくても抜けられます。',
          tone: 'enemy',
        },
      ],
    },
    {
      name: 'NAV 4 (中枢)',
      pos: [-3000, -900, -45000],
      arriveRadius: 2600,
      onArrive: [
        {
          speaker: CROWN.name,
          text: '工事の報告をする。門は閉じかけていない。開きかけている。',
          tone: 'enemy',
        },
        {
          speaker: CROWN.name,
          text: '各勢力の航法ログを同期し、裂け目を縫っていた。同意しない文明のログが穴として残る。',
          tone: 'enemy',
          after: 3,
        },
      ],
    },
    {
      name: '帰投',
      pos: [0, 0, 0],
      arriveRadius: 1400,
      onArrive: [{ speaker: CONTROL, text: `${CLAW}、収容する。艦内は割れているぞ。`, tone: 'command' }],
    },
  ],
  spawns: [
    // 中継艦。命令が指す「中継器群」の本体（撃破は任意目標）
    {
      shipId: 'nn04-sky',
      count: 3,
      faction: 'neurowm',
      atNav: 1,
      tag: TAG.target,
      offset: [0, 0, -900],
      spread: 1100,
      speed: 40,
    },
    // ドローン飽和（第1波）
    {
      shipId: 'nr03-mandible',
      count: 6,
      faction: 'neurowm',
      atNav: 1,
      delay: 4,
      offset: [2600, 700, -2400],
      spread: 900,
      radio: [
        { speaker: CONTROL, text: 'ドローン多数。数を数えるな、抜ける先だけ見ろ。', tone: 'command' },
      ],
    },
    // ドローン飽和（第2波）。隊形と攻め方は撃墜数に応じて `swarmLearning` が変える
    {
      shipId: 'nr03-mandible',
      count: 6,
      faction: 'neurowm',
      atNav: 1,
      delay: 52,
      offset: [-2800, -800, -3200],
      spread: 1000,
      radio: [
        {
          speaker: speakerName(HAYATO.id),
          text: '増えてる。……撃った分だけ隊形が変わってないか？',
          tone: 'friendly',
        },
      ],
    },
    // 静脈路の見張り。少数にして「撃たずに抜ける」選択を潰さない
    {
      shipId: 'nr03-mandible',
      count: 3,
      faction: 'neurowm',
      atNav: 2,
      delay: 6,
      offset: [1800, 600, -2200],
      spread: 700,
    },
    // 統治空母。中枢そのもの。クラウンが応答する
    {
      shipId: 'nc01-protocol',
      count: 1,
      faction: 'neurowm',
      atNav: 3,
      tag: TAG.capital,
      offset: [0, 0, -1200],
      speed: 30,
    },
    // 救護シャトル。個体を失うことを死とみなさない群体が、それでも回収に来る
    {
      shipId: 'nm02-mercy',
      count: 2,
      faction: 'neurowm',
      atNav: 3,
      delay: 10,
      offset: [2200, -500, -1600],
      spread: 800,
      tag: TAG.support,
      radio: [
        {
          speaker: MEMORIA.name,
          text: '共通記録層への接続を申し出ます。救難であり、同時に支配です。',
          tone: 'enemy',
        },
      ],
    },
    // 中枢の護衛ドローン
    {
      shipId: 'nr03-mandible',
      count: 6,
      faction: 'neurowm',
      atNav: 3,
      delay: 16,
      offset: [-2600, 900, -2600],
      spread: 1000,
      tag: TAG.guard,
    },
  ],
  objectives: [
    /**
     * 必須。中枢へ到達して意図を確認する。
     * この章の主目標は破壊ではなく「意図の確認」なので、到達だけを必須にする。
     * 中継器の撃破は前提条件になっていない＝壊さずに来た者も同じようにここへ着く。
     */
    {
      id: 'core',
      text: '中枢へ到達し、群体の意図を確認する',
      required: true,
      spec: { kind: 'reachNav', navIndex: 3 },
    },
    /**
     * 任意。司令部の命令そのもの（中継器群の破壊）。
     * **必須にしない**。命令は変更されなかったが判断は現場に落ちており、
     * 「体温計を割っても熱は下がらない」という現場判断を選べる必要があるため。
     * これを必須にすると CONSENT の二択（限定接続／完全遮断）が成立しない。
     */
    {
      id: 'relays',
      text: '命令: 中継器群を破壊 (任意。壊さずに抜ける経路がある)',
      required: false,
      spec: { kind: 'destroyTag', tag: TAG.target },
    },
    /**
     * 任意。中枢のドローン護衛の排除。
     * 数で押す相手なので全滅を必須にはできない（個体を潰しても群体は痛みを感じない）。
     */
    {
      id: 'guards',
      text: '中枢の護衛ドローンを排除',
      required: false,
      spec: { kind: 'destroyTag', tag: TAG.guard },
    },
    /**
     * 必須。妨害圏を抜けて帰投する。
     * 到達目標の note に「味方位置 3秒遅延」が出る（`MissionRunner.commsDelayNote`）。
     */
    { id: 'home', text: '妨害圏を抜けて帰投する', required: true, spec: { kind: 'reachNav', navIndex: 4 } },
  ],
  openingRadio: [
    {
      speaker: CONTROL,
      text: '命令は中継器群の破壊だ。以上、変更はない。',
      tone: 'command',
    },
    {
      speaker: speakerName(RITSU.id),
      text: '壊すのは構いません。ただ、体温計を割っても熱は下がりません。',
      tone: 'command',
      after: 3,
    },
    {
      speaker: speakerName(HAYATO.id),
      text: '妨害が厚い。俺の位置は3秒古い前提で撃ってくれ。',
      tone: 'friendly',
      after: 3,
    },
  ],
  debriefWin: [
    '艦内は割れた。限定接続を選べば、終盤で敵味方すべての航路を同一画面で見渡せる。だが機械に艦隊の航法を預けた指揮官として、連邦内部の反発は避けられない。',
    '完全遮断なら信用は保たれる。代わりに第9章で門の内側を測る手段を失う。',
    `${CROWN.name}は急かさない。彼にとって同意とは、得るものではなく待つものだからだ。`,
  ],
  debriefLoss: [
    '妨害圏の奥で連絡が切れた。中枢の応答も、朝比奈の記録も、届いていない。',
    '群体はこちらの戦い方を学習した隊形で戻ってくる。次はもっと増えている。',
  ],
};
