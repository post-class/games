/**
 * 第5章 OPERATION ASH CROWN — 灰冠回廊（`ashcrown-corridor`）。
 *
 * 出典: ストーリー_十章作戦記録.html CHAPTER 05 ／ `chapters.ts` の `veil-ch05`。
 *
 * この章の要点（データに落とすときに崩してはいけないもの）:
 * - **単機決闘**。連邦も一機だけを出す。だから `wingman` を設定しない（＝単独出撃）。
 *   機体フックのとおり、プレイヤーは F-44A ラピアーII（`rapier`）固定、相手は
 *   KF03 グレイハウル（`kf03-greyhaul`）に乗るラギティカ1機だけで始まる。
 * - 決闘の間、帝国の全砲は沈黙する（ヴァルカーンの誓約）。したがって開始時の戦場には
 *   帝国艦隊を**1隻も置かない**。「砲門を開いたまま静止している艦隊」は無線と遠景で示す。
 * - **誓約を破るのは敵ではなく身内**。拡張を望む若い軍家の分艦隊（`RADICAL_SQUADRON`）が
 *   決闘の途中から現れ、決闘空域ごと二機を撃ち抜こうとする。ここで「誓約を守る側と破る側」が
 *   敵味方の線と一致しなくなる。データ上は、同じ `kilrathi` 陣営の中に
 *   「保護対象（`TAG.escort`）」と「撃破対象（`TAG.radical`）」が同時に存在する形で表す。
 * - 最も重い戦果は撃墜ではない。名前を交換した相手が生きていて、その名前が公式記録に残ること。
 *
 * ■ ギミックの実装（T6-5）
 * - **決闘中は艦隊が撃たない**: `factionStances` では表現できない。関係表は陣営単位なので、
 *   同じ `kilrathi` の中で「誓約派＝停戦／急進派＝敵対」を書き分けられない
 *   （第8章のコメントに記録済みの限界）。仮に `kilrathi` を非敵対にすると
 *   急進派も撃ってこなくなり、必須目標の「急進派の阻止」が成立しなくなる。
 *   そのため艦隊は1隻も置かないまま（沈黙は無線と遠景で示す）、
 *   決闘そのものは entity 単位の規則として `src/sim/ai.ts` の決闘規約で実装した。
 * - **ラギティカは撃墜を狙わない**: `ace.duel` を宣言すると、彼女は
 *   `spareHullRatio` を下回った相手には引き金を引かず、ミサイルも使わず、
 *   `measureRange` 前後の距離を保って機動に追随する（癖を測る）。
 *   **技量（skill）と難易度補正は一切変えていない。変えたのは狙い方だけ。**
 * - **急進派の介入で誓約が破れる**: 急進派の群に `breaksOath: true` を立てた。
 *   出現した瞬間に決闘モードが解除され、彼女は**同じ陣営の急進派**へ機首を向ける
 *   （`AceOathRules.onBroken: 'defend-duel'`）。敵味方の線と誓約の線がずれる。
 * - **片翼を失い、脱出信号を出さない**: 誓約が破れてから `crippleAfter` 秒で
 *   機動と武装を失い、漂う状態になる。`eject()` は**呼ばない**
 *   （呼べば「脱出ポッド」として信号を出し、急進派に位置を教えることになる）。
 *   救うには接近するしかないので、任意目標を `rescue` の `disabledOnly` にした。
 *   回収すると `summary().enemyRescued` が増え、帝国側の停戦窓口（第8章）へつながる。
 */

import type { MissionDef } from '../../../mission/types';
import { veilChapter } from '../chapters';
import { RADICAL_SQUADRON } from '../../aces';
import { veilPerson } from '../people';
import { CLAW, CONTROL, TAG, speakerName, theaterScenery } from './shared';

const scenery = theaterScenery('ashcrown-corridor');


/** 決闘士ラギティカ。撃墜した敵の名をすべて記憶している */
const RAGITIKA = veilPerson('kilrashi-03');
/** 儀礼通信士ヴァーク。両者の通信を誓約文として記録し、帝国の公式史に残す */
const VARK = veilPerson('kilrashi-07');
/** 大牙王ヴァルカーン。誓約の主 */
const VALKAAN = veilPerson('kilrashi-01');
/** 艦長ウィリアム・ハート。受諾を選び、無線を開いたままにする */
const HART = veilPerson('confed-06');

/** 決闘が「取材」として成立するまでの時間。名の交換と機動の測り合いに使う */
const DUEL_SECONDS = 90;

export const VEIL_CH05: MissionDef = {
  id: 'veil-ch05',
  title: `第5章 ${veilChapter(5).title}`,
  system: '灰冠回廊',
  briefingSpeaker: speakerName(HART.id),
  briefingSpeakerId: HART.id,
  briefingSpeakerRole: HART.role,
  briefing: [
    `灰冠回廊で、キルラシー帝国艦隊が砲門を開いたまま一斉に静止した。決闘士${RAGITIKA.name}が単機決闘を申し込んできた。${VALKAAN.name}の誓約下では、決闘の間、帝国の全砲は沈黙する。代わりに連邦も一機だけを出す。`,
    `断れば艦隊戦だ。${CLAW}は数で負ける。受ければ、勝敗を一機に預けることになる。私は受諾を選んだ。艦の全員に聞かせろ。名を名乗る戦いというものを、うちの若いのは見たことがない。`,
    'KF03 グレイハウル対 F-44A ラピアーII。相手は加速と旋回で勝る。君は装甲と火力で勝る。ただし彼女は撃墜を狙ってこない。君の機動、被弾許容、僚機を庇う癖――そのすべてが質問だ。決闘は取材でもある。',
    `そして誓約を破るのは敵ではなく身内だ。拡張を望む若い軍家の分艦隊が、決闘空域ごと二機を撃ち抜きに来る。彼らを止めろ。${VARK.name}が両者の通信を誓約文として記録している。この戦争で初めて、勝敗以外のものが記録される。`,
  ],
  // 機体フック: F-44A ラピアーII 対 KF03 グレイハウル。機体は固定する。
  playerShipId: 'rapier',
  // 単機決闘。連邦も一機だけを出すので、僚機を設定しない（wingman なし＝単独出撃）。
  skybox: scenery.skybox,
  landmarks: scenery.landmarks,
  hazards: [
    // 灰冠回廊の灰。決闘空域そのものは開けた場所にして、純粋な一対一の機動戦を成立させる
    { kind: 'asteroids', betweenNavs: [0, 1], count: 24, spread: 1900, rockRadius: [14, 60] },
  ],
  navs: [
    {
      name: 'NAV 1 (回廊進入点)',
      pos: [2600, 500, -13000],
      onArrive: [
        {
          speaker: VARK.name,
          text: '儀礼通信士ヴァーク。これより両者の通信を誓約文として記録する。',
          tone: 'enemy',
        },
      ],
    },
    {
      name: 'NAV 2 (決闘空域)',
      pos: [-4000, -1200, -30000],
      arriveRadius: 2000,
      onArrive: [
        {
          speaker: CONTROL,
          text: '帝国艦隊、砲門は開いたまま静止。……本当に撃ってこない。',
          tone: 'command',
        },
      ],
    },
    {
      name: '帰投',
      pos: [0, 0, 0],
      arriveRadius: 1400,
      onArrive: [
        { speaker: CONTROL, text: '記録は受け取った。名前は残っている。着艦しろ。', tone: 'command' },
      ],
    },
  ],
  spawns: [
    /**
     * ラギティカ1機だけ。`ace` で1機を強化し、機体は KF03 グレイハウルに固定する。
     * `TAG.escort`（保護対象）を付けているのは、急進派の介入後に
     * 「救うか撃墜するか」を任意目標として判定するため。
     */
    {
      shipId: 'kf03-greyhaul',
      count: 1,
      faction: 'kilrathi',
      atNav: 1,
      delay: 3,
      offset: [2600, 400, -2600],
      tag: TAG.escort,
      ace: {
        pilot: RAGITIKA.name,
        skillBonus: 0.3,
        shipId: 'kf03-greyhaul',
        /**
         * 決闘規約。数値はどれも「狙い方」だけに効き、難易度には触らない。
         * - spareHullRatio 0.4: こちらのハルが4割を切ったら引き金を引かない
         *   （撃墜を狙わず、癖を測るための取材として成立させる）
         * - measureRange 900: 一対一の旋回戦が続く距離を保つ
         * - crippleAfter 40: 誓約が破れてから40秒、= 急進派の第2波が入る頃に片翼を失う
         */
        duel: {
          spareHullRatio: 0.4,
          measureRange: 900,
          crippleAfter: 40,
          crippledHullRatio: 0.22,
          speaker: RAGITIKA.name,
        },
      },
      radio: [
        {
          speaker: RAGITIKA.name,
          text: 'あなたは門を盗んだ者か。それとも、帰す者か。',
          tone: 'enemy',
        },
        {
          speaker: VARK.name,
          text: '名を交換せよ。以後の応答はすべて公式史に残る。',
          tone: 'enemy',
          after: 3,
        },
      ],
    },
    /**
     * 急進派の分艦隊（第1波）。決闘の**途中から**出現する。
     * `atNav` + `delay` で「決闘が取材として成立したあと」に現れるようにし、
     * 誓約を破るのが敵ではなく身内であることを時間差で示す。
     */
    {
      shipId: 'kf01-leonfang',
      count: 2,
      faction: 'kilrathi',
      atNav: 1,
      delay: DUEL_SECONDS + 6,
      offset: [-4200, 1200, -3800],
      tag: TAG.radical,
      // この群の出現で誓約が破れる。ラギティカは決闘をやめ、
      // 同じ陣営であるこの分艦隊へ機首を向ける。
      breaksOath: true,
      radio: [
        {
          speaker: RAGITIKA.name,
          text: '……違う。あれは私の側だ。誓約を破るのは、いつも身内だ。',
          tone: 'enemy',
        },
        {
          speaker: CONTROL,
          text: `${RADICAL_SQUADRON.name}。決闘空域ごと二機を撃つつもりだ。`,
          tone: 'command',
          after: 2.5,
        },
      ],
    },
    /**
     * 急進派の分艦隊（第2波）。ラギティカの機体から片翼を奪う側。
     * 片翼喪失そのものは `ace.duel.crippleAfter`（誓約が破れてから40秒）で起き、
     * この波の到着と重なる。以後、彼女は漂うだけで脱出信号を出さない。
     */
    {
      shipId: 'kf06-talon',
      count: 2,
      faction: 'kilrathi',
      atNav: 1,
      delay: DUEL_SECONDS + 40,
      offset: [3800, -1400, -4000],
      tag: TAG.radical,
      breaksOath: true,
      radio: [
        {
          speaker: RAGITIKA.name,
          text: '片翼をやられた。脱出信号は出さない。あれは位置を教える。',
          tone: 'enemy',
        },
      ],
    },
  ],
  objectives: [
    /**
     * 必須。決闘を「取材」として成立させる時間。
     * 名を交換し、互いの癖を測り合う区間で、この間に急進派は現れない。
     * この間、彼女は `ace.duel` の規約で動く（撃墜を狙わず、距離を測る）。
     */
    {
      id: 'duel',
      text: '単機決闘を成立させる (名を交換し、決闘を保つ)',
      required: true,
      spec: { kind: 'survive', seconds: DUEL_SECONDS },
    },
    /**
     * 必須。急進派の阻止。
     * これだけは必須にする。誓約を破る側を止めなければ、決闘空域そのものが消え、
     * 記録（第7章の告発と第8章の停戦の法的根拠）が残らないため。
     */
    {
      id: 'radical',
      text: '急進派分艦隊を阻止 (誓約を破る側を止める)',
      required: true,
      spec: { kind: 'destroyTag', tag: TAG.radical },
    },
    /**
     * 任意。片翼を失ったラギティカの回収。
     * **必須にしない**。救うか撃墜するかはプレイヤーの選択（HONOR CLAUSE）であり、
     * 撃墜しても戦争は終わらない＝任務としては失敗ではない。
     *
     * `disabledOnly` を立てているので、決闘中にすれ違っただけでは回収にならない。
     * 彼女が片翼を失って漂い始めてから接近する必要がある
     * （脱出信号を出さないので、こちらが位置を掴んで寄るしかない）。
     * 回収すると `summary().enemyRescued` が増え、帝国側の停戦窓口が開く。
     */
    {
      id: 'ace',
      text: '決闘の相手を生きたまま持ち帰る (任意: 脱出信号は出ない。接近して回収)',
      required: false,
      spec: { kind: 'rescue', tag: TAG.escort, radius: 500, disabledOnly: true },
    },
    /** 必須。記録を艦へ届けるための帰投。 */
    { id: 'home', text: '帰投する', required: true, spec: { kind: 'reachNav', navIndex: 2 } },
  ],
  openingRadio: [
    {
      speaker: speakerName(HART.id),
      text: '艦の全員に聞かせろ。名を名乗る戦いというものを、うちの若いのは見たことがない。',
      tone: 'command',
    },
    {
      speaker: CONTROL,
      text: '出るのは一機だけだ。僚機は付かない。誓約の条件だ。',
      tone: 'command',
      after: 3.5,
    },
  ],
  debriefWin: [
    'この章で最も重い戦果は撃墜ではない。',
    `名前を交換した相手が生きていて、その名前が公式記録に残っている――${VARK.name}はそう記録した。`,
    '誓約を守る側と破る側が、敵味方の線と一致しなくなった。その記録が、第7章の告発と第8章の停戦の根拠になる。',
  ],
  debriefLoss: [
    '決闘空域は急進派に撃ち抜かれた。誓約は破られ、記録は途中で切れている。',
    `${VALKAAN.name}の側にも、こちらの側にも、示せるものが何も残っていない。`,
  ],
};
