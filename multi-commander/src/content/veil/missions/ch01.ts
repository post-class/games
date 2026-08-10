/**
 * 第1章 OPERATION CINDER BEACON（オリオン港）。
 *
 * 出典（正典）:
 * - `00_initila_constructions/05_story_改善/spec/ストーリー_十章作戦記録.html` CHAPTER 01
 *   （本文6段落／主目標／戦術マップ `ch1`）
 * - 手順書 §9 T5-01
 *
 * ■ この章のねらい
 * 操作の導入でありながら「達成しなかった勝利条件が記録として残る」ことを教える章。
 * 戦闘は軽い（先遣隊3機を追い散らすだけ）。難しいのは同時に走る三本のタイマーである。
 *
 * ■ 「三つ全部は間に合わない」の表現（受入基準）
 * 三つの締切を `timeLimit` として並べ、それぞれに対応する行動目標
 * （帰投誘導／ポッド回収／先遣隊の阻止）を紐づけた。
 * - `bulkhead`  … 輸送船の隔壁が保つ時間（300秒。**必須**）
 * - `pod-life`  … 脱出ポッドの生命維持（240秒。加点）
 * - `deny-window` … 逃げる先遣隊が航路情報を持ち帰るまでの時間（170秒。加点）
 *
 * 三本とも `startAtNav: 1` を宣言し、**NAV 2（救難信号源）に到着してから**計時する（T2-⑤）。
 * 現場までの 60〜90 秒を締切に含めると、到着した瞬間に間に合わないことが確定し、
 * 「操作していないのに目標が失敗する」状態になっていた。
 * 到着後の 300 秒でも「3機の撃破」「散らばったポッド3基の回収」「輸送船を母艦まで誘導」を
 * すべて満たすことはできない。捨てた分は加点を失うだけで任務は成立する。
 *
 * ■ 必須目標（T1-①）
 * 必須は「輸送船を帰投航路に乗せる（`escortArrive`）」「輸送船の生存（`protect`）」
 * 「隔壁の5分（`timeLimit`）」「自機の帰投（`reachNav`）」の4つ。
 * 達成する目標は `escortArrive` と `reachNav` の2つなので、
 * 「制約だけが必須で永久に終わらない」状態にはならない。
 * `escortArrive` は輸送船を Nav 3（帰投）の到達半径へ入れることで達成する。
 * 輸送船は自力では 25km を 5分以内に走り切れないので、
 * オートパイロット（`updateAutopilot` が `AUTOPILOT_ESCORT_RANGE` 以内の味方機を連れて行く）で
 * **一緒に連れ帰る**のが正解手順になる。帰投ボタンを押す前に
 * 「輸送船は隣にいるか」を確認させるのがこの章のねらい。
 */

import type { MissionDef } from '../../../mission/types';
import { veilChapter } from '../chapters';
import { veilPerson } from '../people';
import { CLAW, CONTROL, TAG, speakerName, theaterScenery } from './shared';

const CH = veilChapter(1);
const SCENERY = theaterScenery('orion-port');


/** ハート艦長（ブリーフィング話者・元救難隊） */
const HART = speakerName('confed-06');
/** キム・ソヨン 基地防衛司令（外縁への迎撃機派出に反対する） */
const SEOYEON = speakerName('confed-08');
/** ヴァーク 儀礼通信士（救難義務条文を読み上げる側） */
const VARK = speakerName('kilrashi-07');

/** 輸送船の呼称。無線とブリーフィングで共有する */
const ASTRA = '〈アストラ・メイ〉';

export const VEIL_CH01: MissionDef = {
  id: CH.missionId,
  title: `第1章 ${CH.title}`,
  system: CH.theaterName,
  briefingSpeaker: HART,
  briefingSpeakerId: 'confed-06',
  briefingSpeakerRole: veilPerson('confed-06').role,
  briefing: [
    `オリオン港の外縁は、避難民輸送の順番待ちで三百隻が漂う渋滞空域だ。そこへ連邦識別コードを正しく返す輸送船${ASTRA}から救難信号が入った。機関出力は三割、右舷に長い焼け跡。撃つ前に、拾える者を拾え。順番を間違えるな。`,
    `現場には取り付いたキルラシー先遣隊が3機いる。だが儀礼周波で読み上げられているのは宣戦布告ではない、五者通行協定第四条の救難義務条文だ。奴らもこの船を拾いに来ている。そして航跡記録では、先に撃ったのは輸送船の砲塔だ。両軍がまったく同じ主張をしている——相手が協定を破った、と。`,
    `${SEOYEON}司令はこの出撃に反対している。港内には登録済みの避難民が四万人、哨戒機を四機抜けば外周の索敵密度は三割落ちる。「輸送船一隻に、区画一つを賭けるんですか」。賭ける、と私は答えた。この判断の代価は港の空気として残る。`,
    `覚えておけ。同時に三本のタイマーが走る。輸送船の隔壁、脱出ポッドの生命維持、そして逃げる先遣隊が航路情報を持ち帰るまでの時間だ。三つ全部は間に合わない。拾わなかったものも、記録には残る。`,
  ],
  playerShipId: 'hornet',
  skybox: SCENERY.skybox,
  landmarks: SCENERY.landmarks,
  // 渋滞空域の外縁。待機列の外側に流された残骸と岩で「混んだ港」を出す
  hazards: [{ kind: 'asteroids', atNav: 0, count: 16, spread: 1700, rockRadius: [14, 60] }],
  navs: [
    {
      name: 'NAV 1 (待機列外縁)',
      pos: [1600, 400, -12000],
      onArrive: [
        { speaker: CONTROL, text: '待機列の外側を抜けろ。民間船に近づきすぎるな。', tone: 'command' },
      ],
    },
    {
      name: 'NAV 2 (救難信号源)',
      pos: [-7200, -900, -24000],
      arriveRadius: 1800,
      onArrive: [
        { speaker: ASTRA, text: '隔壁が持たない……頼む、誘導してくれ。', tone: 'friendly' },
        { speaker: VARK, text: '協定第四条。我らもまた、この船を拾う者だ。', tone: 'enemy', after: 3 },
      ],
    },
    {
      name: '帰投',
      pos: [0, 0, 0],
      arriveRadius: 1400,
      onArrive: [{ speaker: CONTROL, text: `${CLAW}、着艦を許可する。`, tone: 'command' }],
    },
  ],
  spawns: [
    // 輸送船〈アストラ・メイ〉。到達したら母艦（NAV 3）へ向けて自力で動き出す
    {
      shipId: 'drayman',
      count: 1,
      faction: 'confed',
      atNav: 1,
      tag: TAG.escort,
      displayName: ASTRA,
      cruiseToNav: 2,
      speed: 100,
      radio: [{ speaker: ASTRA, text: `こちら${ASTRA}。出力三割、まだ動ける。`, tone: 'friendly' }],
    },
    // 脱出ポッド3基。生命維持のタイマーが走っている
    {
      shipId: 'escape-pod',
      count: 3,
      faction: 'neutral',
      atNav: 1,
      tag: TAG.rescue,
      offset: [-1700, -400, 1400],
      spread: 1100,
      speed: 6,
    },
    // キルラシー先遣隊3機。撃破しなければ航路情報を持ち帰る
    {
      shipId: 'kf01-leonfang',
      count: 3,
      faction: 'kilrathi',
      atNav: 1,
      delay: 3,
      offset: [2800, 700, -2600],
      tag: TAG.target,
      radio: [{ speaker: CONTROL, text: '先遣隊3機。輸送船から引き剥がせ。', tone: 'command' }],
    },
  ],
  objectives: [
    // 必須①: 輸送船を帰投航路に乗せる（T1-①）。
    // この章の勝利条件そのもの。「沈まなければ勝ち」を防ぐため、
    // 制約 (protect) ではなく達成する目標 (escortArrive) として置く。
    {
      id: 'astra-home',
      text: `輸送船${ASTRA}を帰投航路に乗せる`,
      required: true,
      spec: { kind: 'escortArrive', tag: TAG.escort, navIndex: 2 },
    },
    // 必須②: 輸送船の生存。沈められた時点で失敗、という意味の制約として残す
    {
      id: 'astra',
      text: `輸送船${ASTRA}を守る`,
      required: true,
      spec: { kind: 'protect', tag: TAG.escort },
    },
    // 必須③: 隔壁の5分。この時間を超えたら輸送船は保たない（T1-①で必須化）
    // TODO(T6-1): 隔壁は本来「時間経過で輸送船が沈む」挙動。protectCount / 損傷連動が入ったら差し替える
    {
      id: 'bulkhead',
      text: `${ASTRA}の隔壁が保つのは救難区域到着から5分。それまでに帰投航路へ乗せる`,
      required: true,
      // 計時は NAV 2（救難信号源）到着から。移動の 60〜90 秒を締切に含めない（T2-⑤）
      spec: { kind: 'timeLimit', seconds: 300, startAtNav: 1 },
    },
    // 加点①: 救難ポッドの回収。章末の選択（救難か追撃か）の片側なので required にしない
    {
      id: 'pods',
      text: '脱出ポッド3基を回収する',
      required: false,
      reward: '＋帰還者3',
      spec: { kind: 'rescue', tag: TAG.rescue, radius: 300 },
    },
    // 加点②: 生命維持のタイマー。ポッド回収と同じ時間を食い合う
    {
      id: 'pod-life',
      text: '脱出ポッドの生命維持は救難区域到着から4分',
      required: false,
      reward: '＋帰還者',
      spec: { kind: 'timeLimit', seconds: 240, startAtNav: 1 },
    },
    // 加点③: 先遣隊の阻止。章末の選択（追撃）の片側。撃たずに帰っても任務は成立する
    {
      id: 'deny',
      text: 'キルラシー先遣隊3機を阻止する',
      required: false,
      reward: '＋軍令信用',
      spec: { kind: 'destroyTag', tag: TAG.target },
    },
    // 加点④: 敵が航路情報を持ち帰るまでの時間。三本目のタイマー
    {
      id: 'deny-window',
      text: '救難区域到着から2分50秒で先遣隊が航路情報を持ち帰る',
      required: false,
      reward: '＋軍令信用',
      spec: { kind: 'timeLimit', seconds: 170, startAtNav: 1 },
    },
    // 必須④: 自機の帰投。主目標の「帰投誘導」に対応する
    {
      id: 'home',
      text: `${CLAW}へ帰投する`,
      required: true,
      spec: { kind: 'reachNav', navIndex: 2 },
    },
  ],
  openingRadio: [
    { speaker: HART, text: '撃つ前に、拾える者を拾え。順番を間違えるな。', tone: 'command' },
    { speaker: SEOYEON, text: '外周の索敵は三割落ちます。長居はしないで。', tone: 'command', after: 4 },
  ],
  debriefWin: [
    `${ASTRA}は港内航路へ乗った。整備員が焼けた装甲板を剥がしている。`,
    '戦果報告は明日でいい。名前を先に確定させろ。救難ポッドの搭乗者名簿は、私が自分の手で書き写す。',
    '——夜、ヴェガ門方向から短い通信が入った。相手は名乗り、こちらの機体番号を正確に読み上げ、一言だけ残して切れた。「次は、名を名乗れる戦いにしよう」。',
  ],
  debriefLoss: [
    `${ASTRA}は外縁で沈んだ。積荷目録は民間医療物資、実際に固定されていたものは分からない。`,
    '名簿は空欄のまま残る。これも記録だ。次はもっと早く拾え。',
  ],
};
