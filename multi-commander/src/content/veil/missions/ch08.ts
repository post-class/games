/**
 * 第8章 HOLD THE BREATH — 停戦の一分間（ヴェガ門公証中継所）。
 *
 * 出典: ストーリー_十章作戦記録.html CHAPTER 08 / 実装手順書 §9 T5-08。
 *
 * 公証中継所は五勢力の同時承認がなければ証拠を認証しない。
 * その承認を中継するのが三基の通信灯台で、同じ五者署名を流す冗長回線である。
 * 1本でも60秒維持できれば承認は成立し、失われた回線の数だけ次章の通信と援護が細る。
 *
 * ■ 「一機では2基までしか間に合わない」距離設計
 * 自機はラピアーII（巡航 450 / AB 900、AB燃料は8秒しか続かない）。実効はほぼ巡航速度。
 *   発艦点 → 中央灯台        9,002  ≒ 20.0s
 *   中央灯台 → 北灯台        9,388  ≒ 20.9s
 *   中央灯台 → 南灯台        9,343  ≒ 20.8s
 *   北灯台  → 南灯台        18,702  ≒ 41.6s
 * 60秒のうち移動だけで、中央→北（または南）で 40.9s、残りは19秒。
 * 3基目には更に 20.9s が必要で 61.8s となり、原理的に間に合わない。
 * 外側2基（北・南）だけを回る経路も 15,282（34.0s）＋ 41.6s で論外。
 * さらに敵機が 4500 以内にいるとオートパイロットが使えないため、
 * 灯台間の移動を高速巡航（7,000/s）で短縮することもできない。
 * したがって「守る2基を選ぶ」ことが、この章の唯一の操作になる。
 *
 * ■ 陣営の扱い（設計判断）
 * 灯台の船体はニューロウム製の NN04 スカイで、陣営も `neurowm` のまま置く。
 * 既定の関係表ではニューロウムは連邦と敵対しているので、そのままだと自機が
 * 灯台を撃てて灯台も自機を撃つ。そこで `factionStances` に「この出撃の間だけ
 * 連邦とニューロウムは非敵対」と宣言する。連邦陣営に偽装して置くと HUD の
 * 勢力色まで嘘になるので、関係の側を変える方が正しい。
 *
 * 一方で**帝国は陣営単位では停戦にできない**。同じ `kilrathi` の中に
 * 「誓約を守る側（停戦）」と「急進派（灯台を襲う）」が同時にいるからで、
 * 陣営単位の関係表ではこの2つを分けられない。そのため帝国駆逐艦は
 * `neutral`（誰とも交戦しない＝停戦の表現）、急進派は `kilrathi`（敵対）と
 * 陣営を分けて置いている。救難ポッドだけは帝国籍のまま置く。
 * HUD に敵として映る相手へ向かうことが、この章の選択の重さそのものになる。
 */

import type { MissionDef } from '../../../mission/types';
import { veilChapter } from '../chapters';
import { veilPerson } from '../people';
import { veilTheater } from '../world';
import { CLAW, CONTROL, TAG, speakerName, theaterScenery } from './shared';

const HART = veilPerson('confed-06');
const HART_NAME = speakerName('confed-06');
const AWL_NAME = speakerName('serecion-02');
const ARC_NAME = speakerName('ordo-01');
const CROWN_NAME = speakerName('neurowm-01');
const RAGITIKA_NAME = speakerName('kilrashi-03');
const VALKAAN_NAME = speakerName('kilrashi-01');
/** 通訳。セレシオン側とニューロウム側を分担する */
const AKS_NAME = speakerName('serecion-08');
const MEMORIA_NAME = speakerName('neurowm-04');
/** 急進派の重戦闘機隊長。灯台襲撃を率いる（RADICAL_SQUADRON の aceIds より） */
const FEN_NAME = speakerName('kilrashi-08');

const scenery = theaterScenery('notary-relay');

/** 三基の灯台の座標。上のコメントの距離計算はこの3点から出している */
const BEACON_CENTER: [number, number, number] = [0, -200, -9000];
const BEACON_NORTH: [number, number, number] = [-8600, 900, -12600];
const BEACON_SOUTH: [number, number, number] = [8900, -700, -6200];

/** 灯台本体を Nav の真上に置くと自動航行の終点で接触するので、少しずらす */
function beside(p: [number, number, number]): [number, number, number] {
  return [p[0] + 620, p[1] + 240, p[2] + 520];
}

export const VEIL_CH08: MissionDef = {
  id: 'veil-ch08',
  title: `第8章 ${veilChapter(8).title}`,
  system: veilTheater('notary-relay').name,
  briefingSpeaker: HART_NAME,
  briefingSpeakerId: 'confed-06',
  briefingSpeakerRole: HART.role,
  briefing: [
    `画面に五勢力が並んでいる。史上初めてだ。連邦は空母を出す。${AWL_NAME}は避難回廊を開く。${ARC_NAME}は門周辺の重力を固定する。${CROWN_NAME}は通信同期を差し出す。${RAGITIKA_NAME}は大牙王の代理として、誓約の形式でしか承認を出せないと言っている。通訳は${AKS_NAME}と${MEMORIA_NAME}が分担する。`,
    '中継所は五勢力の同時承認がなければ証拠を認証しない。連邦の告発文だけでは一行も通らない。必要な時間は60秒だ。誰も相手を信じていない。それでも書式は揃う。',
    'その60秒を運ぶのが、空域に置いた三基の通信灯台だ。三基は同じ五者署名を中継する冗長回線で、1本でも維持できれば承認は成立する。三本すべて残れば認証記録と後続の支援通信が丸ごと残り、失われた回線の数だけ次章の通信と援護が細る。',
    '急進派が灯台を狙う。灯台は互いに離れている。一機で回れるのは二基までだ。どれを残すかは君が決める。それから——戦闘の途中で、帝国側の被弾艦から救難信号が上がるかもしれない。行くかどうかも君が決めろ。',
  ],
  /**
   * 停戦の60秒だけ、連邦とニューロウムを非敵対にする。
   * 適用は `MissionRunner.build()`、既定への復帰は `dispose()` が必ず行う。
   */
  factionStances: [{ a: 'confed', b: 'neurowm', stance: 'neutral' }],
  playerShipId: 'rapier',
  wingman: { shipId: 'rapier', pilot: veilPerson('confed-24').name, skill: 0.78 },
  skybox: scenery.skybox,
  landmarks: scenery.landmarks,
  hazards: [
    // 中継所周辺の廃棄物。灯台の間を最短で突っ切らせないための薄い帯。
    { kind: 'asteroids', betweenNavs: [1, 2], count: 18, spread: 2200, rockRadius: [14, 55] },
  ],
  navs: [
    {
      name: 'NAV 1 (中央灯台)',
      pos: BEACON_CENTER,
      arriveRadius: 1500,
      onArrive: [
        { speaker: '灯台 2', text: '回線健全。署名の3本目を中継中。', tone: 'friendly' },
      ],
    },
    {
      name: 'NAV 2 (北灯台)',
      pos: BEACON_NORTH,
      arriveRadius: 1500,
      onArrive: [
        { speaker: '灯台 1', text: '被弾しています。まだ流せます。', tone: 'friendly' },
      ],
    },
    {
      name: 'NAV 3 (南灯台)',
      pos: BEACON_SOUTH,
      arriveRadius: 1500,
      onArrive: [
        { speaker: '灯台 3', text: '同期は保っています。長くは無理です。', tone: 'friendly' },
      ],
    },
  ],
  spawns: [
    // ───── 三基の通信灯台。atNav を使うと「到達してから出現」になるので、
    //       絶対座標の offset で開始時から置く。
    //       船体はニューロウムの通信中継艦なので陣営も neurowm のままにし、
    //       停戦の60秒だけ非敵対にする関係を `factionStances` で宣言している
    //       （connfed 陣営に偽装して置くと、HUDの勢力色まで嘘になる）。
    {
      shipId: 'nn04-sky',
      count: 1,
      faction: 'neurowm',
      offset: beside(BEACON_CENTER),
      tag: TAG.beacon,
      speed: 0,
    },
    {
      shipId: 'nn04-sky',
      count: 1,
      faction: 'neurowm',
      offset: beside(BEACON_NORTH),
      tag: TAG.beacon,
      speed: 0,
    },
    {
      shipId: 'nn04-sky',
      count: 1,
      faction: 'neurowm',
      offset: beside(BEACON_SOUTH),
      tag: TAG.beacon,
      speed: 0,
    },
    // ───── 味方艦。護衛を続けるか敵の救難に向かうかの、こちら側の天秤。
    {
      shipId: 'tigers-claw',
      count: 1,
      faction: 'confed',
      offset: [0, -250, 1900],
      tag: TAG.capital,
      speed: 30,
    },
    // ───── 帝国の駆逐艦。停戦中なので撃たない（neutral）。ここから救難信号が上がる。
    {
      shipId: 'kilrashi-destroyer',
      count: 1,
      faction: 'neutral',
      offset: [4200, 500, -13800],
      speed: 40,
      radio: [
        { speaker: RAGITIKA_NAME, text: '我らの砲は沈黙している。誓約の形式に従う。', tone: 'friendly' },
      ],
    },
    // ───── 他勢力の援護。F5では固定で出す。
    // TODO(T4-3): `supportLevel()` の4状態（セレシオン護衛／オルド重力固定／
    //             ニューロウム同期／キルラシー誓約）で顔ぶれを切り替える。
    {
      shipId: 'sc03-arc',
      count: 1,
      faction: 'serecion',
      offset: [-9600, 1300, -13600],
      tag: TAG.support,
      speed: 50,
      radio: [
        { speaker: AWL_NAME, text: '北の回線はこちらが代わりに抱えます。季節が変わるまでは。', tone: 'friendly' },
      ],
    },
    {
      shipId: 'oe06-ironroot',
      count: 1,
      faction: 'ordo',
      offset: [1200, -900, -10400],
      tag: TAG.support,
      speed: 40,
      radio: [
        { speaker: ARC_NAME, text: '重力を固定した。1200年の記録では、これは短い線だ。', tone: 'friendly' },
      ],
    },
    {
      // 救護船。誰とも交戦しない中立として置く（撃たれず、撃たない）。
      shipId: 'nm02-mercy',
      count: 1,
      faction: 'neutral',
      offset: [-1400, 400, -3200],
      tag: TAG.support,
      speed: 40,
      radio: [
        { speaker: MEMORIA_NAME, text: '同期の所要は60秒。数え始めます。', tone: 'friendly' },
      ],
    },
    // ───── 急進派。三基それぞれへ向かう。cruiseToNav で灯台へ直進させる。
    {
      shipId: 'kf06-talon',
      count: 2,
      faction: 'kilrathi',
      delay: 7,
      offset: [1800, 900, -14500],
      spread: 700,
      tag: TAG.radical,
      cruiseToNav: 0,
      radio: [
        { speaker: CONTROL, text: '急進派、中央灯台へ2機。停戦の外から来ています。', tone: 'command' },
      ],
    },
    {
      shipId: 'ke04-mirage',
      count: 2,
      faction: 'kilrathi',
      delay: 13,
      offset: [-10200, 1600, -17400],
      spread: 700,
      tag: TAG.radical,
      cruiseToNav: 1,
      radio: [
        { speaker: CONTROL, text: '北灯台にも2機。両方は守れません。', tone: 'command' },
      ],
    },
    {
      shipId: 'kb05-boarbreaker',
      count: 2,
      faction: 'kilrathi',
      delay: 21,
      offset: [11800, -1200, -9800],
      spread: 800,
      tag: TAG.radical,
      cruiseToNav: 2,
      ace: { pilot: FEN_NAME, skillBonus: 0.28 },
      radio: [
        { speaker: FEN_NAME, text: '書式など残させぬ。灯を消せ。', tone: 'enemy' },
      ],
    },
    // ───── 敵側の救難信号。帝国籍のまま置く（HUDでは敵色で映る）。
    {
      shipId: 'escape-pod',
      count: 2,
      faction: 'kilrathi',
      delay: 30,
      offset: [4600, 300, -13200],
      spread: 320,
      tag: TAG.rescue,
      speed: 0,
      radio: [
        { speaker: '帝国救難信号', text: '……被弾。艦外に二名。', tone: 'enemy' },
        { speaker: VALKAAN_NAME, text: '連邦機よ。行くなら、記録に残す。', tone: 'enemy', after: 2.2 },
      ],
    },
  ],
  objectives: [
    {
      /**
       * 主目標。「1基以上を60秒間」を `holdTag` 1本で表す。
       *
       * `protect` + `survive` の2本に分けていた近似では「灯台が全滅した瞬間に失敗」と
       * 「60秒経った」が独立に判定され、**全滅後に60秒経っても成立してしまう**。
       * `holdTag` は `min` 以上を保っている間だけ時間を積むので、仕様と判定が一致する。
       * 残存本数は `summary().tagSurvivors` から取り、次章の通信と援護量へ渡す。
       */
      id: 'beacons',
      text: '通信灯台の回線を1基以上、60秒間維持する（残した本数が次章の援護になる）',
      required: true,
      spec: { kind: 'holdTag', tag: TAG.beacon, seconds: 60, min: 1 },
    },
    {
      // 味方艦の護衛は「選択」の片側。守らなくても停戦は成立するので required にしない。
      id: 'fleet',
      text: `${CLAW} を守る（護衛を続ければ艦隊は無傷で第9章へ入る）`,
      required: false,
      spec: { kind: 'protect', tag: TAG.capital },
    },
    {
      // 選択のもう片側。敵の救難へ向かうのは義務ではないので required にしない。
      // 救えばヴァルカーンが「名誉ある共同作戦」として承認し、帝国の公式記録に名が残る。
      id: 'enemy-rescue',
      text: '帝国側の救難信号に応じる（応じれば共同作戦として記録される）',
      required: false,
      spec: { kind: 'rescue', tag: TAG.rescue, radius: 320 },
    },
  ],
  openingRadio: [
    { speaker: HART_NAME, text: '連邦は承認する。以上だ。', tone: 'command' },
    { speaker: AWL_NAME, text: '風の向きが変わりました。私たちも承認します。', tone: 'friendly', after: 2 },
    { speaker: CROWN_NAME, text: '同期所要 60 秒。開始。', tone: 'friendly', after: 1.8 },
    { speaker: RAGITIKA_NAME, text: '誓約の形式で承認する。破る者は我らの敵でもある。', tone: 'friendly', after: 2.2 },
    { speaker: AKS_NAME, text: '三基の灯が回線です。守れる数だけ守ってください。', tone: 'friendly', after: 2.2 },
  ],
  debriefWin: [
    '中継所は事務的に判定を返した。認証。六つ目の条項が83年遅れで発効し、門制御核は共同管理下に入る。',
    '停戦は達成の頂点ではない。間に合わなかったものを数えるための一分間だ。消えた灯の数だけ、次の章で聞ける声が減る。',
    'そして次の章で、門が開く。',
  ],
  debriefLoss: [
    '灯は全部消えた。中継所の判定は保留。審査は数か月先へ送られた。',
    '五つの署名は同じ書式に揃っていた。届かなかっただけだ。',
    'それでも次の章で門は開く。今度は、誰の承認もないまま。',
  ],
};
