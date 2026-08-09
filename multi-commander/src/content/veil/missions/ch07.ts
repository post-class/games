/**
 * 第7章 BROKEN ACCORD — 告発データの搬送（ヴェガ門公証中継所）。
 *
 * 出典: ストーリー_十章作戦記録.html CHAPTER 07 / 実装手順書 §9 T5-07。
 *
 * この章の設計主題は「撃たないこと」である。
 * 積荷は告発データ一箱、護衛はつかない。妨害してくるのは敵ではなく、
 * 停止命令を執行する連邦の哨戒機と、こちらの識別を知り尽くした帝国の急進派だ。
 * 発砲すれば共同設備の保全規約を破り、告発そのものが無効になる。
 *
 * 実装上の敵味方判定について（重要な設計判断）:
 * `factions.ts` の既定では連邦同士は常に非敵対なので、連邦の哨戒機を
 * `faction: 'confed'` で置くと「撃ってくる敵」にはならない。
 * そこで妨害を次の三つに分解した。
 *   1. 哨戒機は撃たない。`cruiseToNav` で中継所へ向かう航路上を横切り、
 *      体当たり判定を持つ障害物として進路を塞ぐ（`resolveShipCollisions` は
 *      陣営を問わず適用される）。
 *   2. 撃てば当たる。銃弾は陣営を見ないので、哨戒機を撃墜できてしまう。
 *      そこで哨戒機に `TAG.escort` を付け、`protect` の任意目標にした。
 *      発砲そのものは `weaponsSafe`（T6-7）が別に数えるので、
 *      「急進派を撃った」と「停止命令の執行者を殺した」を区別して記録できる。
 *   3. 撃ってくるのは帝国の急進派だけ（`kilrathi` = 連邦と敵対）。
 *      オートパイロットは敵機が 4500 以内にいると使えないため、
 *      急進派を振り切るまで中継所へ跳べない。これが「撃たずに振り切る」の実体になる。
 */

import type { MissionDef } from '../../../mission/types';
import { veilChapter } from '../chapters';
import { veilPerson } from '../people';
import { veilTheater } from '../world';
import { CLAW, CONTROL, TAG, speakerName, theaterScenery } from './shared';

const HART_NAME = speakerName('confed-06');
const NIA = veilPerson('confed-11');
const NIA_NAME = speakerName('confed-11');
/** 急進派の執行者。帰投線を狙う流儀のまま、こちらの識別票を読んで追ってくる */
const DAKHAS_NAME = speakerName('kilrashi-04');

/**
 * 停止命令を執行する連邦の哨戒機の呼称。
 * 無線の発信元と護衛対象の表示名で同じ文字列を使うため、ここに集約する。
 */
const RAM_1 = '連邦哨戒機〈ラム 1〉';
const RAM_2 = '連邦哨戒機〈ラム 2〉';

const scenery = theaterScenery('notary-relay');

export const VEIL_CH07: MissionDef = {
  id: 'veil-ch07',
  title: `第7章 ${veilChapter(7).title}`,
  system: veilTheater('notary-relay').name,
  briefingSpeaker: NIA_NAME,
  briefingSpeakerId: 'confed-11',
  briefingSpeakerRole: NIA.role,
  briefing: [
    '戦闘の話をする前に、書庫の照合結果から始めます。第1章の積荷、第2章の帰還者証言、第4章の採掘記録、第6章の同期ログ。四つが同じ製造番号を指しました。',
    '署名されなかった六つ目の条項があります。門制御核の共同管理案です。ラグランジュ事故の直後、連邦の軍需企業と帝国の急進派がこれを葬り、核を二つに割って持ち帰っていました。83年分の戦争は、資源争いでも聖域の防衛でもなく、割られた鍵の後始末です。あなたが撃ってきた敵は、その資産を守る壁でした。',
    '司令部の返信は停止命令です。空母は証拠の確保を理由に足止めされ、搬送先の公証中継所は72時間後に保全のため閉鎖されます。中継所は正義で動きません。正規の書式で、期限内に、五勢力が検証できる形で出すこと。それだけが条件です。',
    '行けます。ただし帰りの燃料と、あなたの経歴のどちらかは戻りません。積荷は一箱、護衛はつきません。ミサイル架は箱で塞ぎました。発砲すれば共同設備の保全規約違反で、告発は一片の効力も失います。撃たずに航路を読んでください。',
  ],
  // 撃ち合わずに振り切る任務なので、最も速い機体を出す（450 / AB 900）。
  playerShipId: 'rapier',
  // 積荷一箱でミサイル架が塞がっている状態を、空の搭載で表す。
  playerMissiles: [],
  // 護衛はつかない（章の前提）。wingman は設定しない。
  skybox: scenery.skybox,
  landmarks: scenery.landmarks,
  hazards: [
    // 保全境界の廃棄物帯。オートパイロットが使えなくなるので、
    // 最後の一区間は自分で航路を読むことになる。
    { kind: 'asteroids', betweenNavs: [1, 2], count: 26, spread: 1700, rockRadius: [14, 70] },
  ],
  navs: [
    {
      name: 'NAV 1 (積出点)',
      pos: [1600, -300, -8000],
      arriveRadius: 1300,
      onArrive: [
        { speaker: CONTROL, text: '積荷の封印を確認。以後、この便の記録は残りません。', tone: 'command' },
      ],
    },
    {
      name: 'NAV 2 (保全境界)',
      pos: [-7000, 900, -19000],
      arriveRadius: 1600,
      onArrive: [
        { speaker: RAM_2, text: '保全境界だ。停止命令が出ている。撃ちたくはない。', tone: 'friendly' },
      ],
    },
    {
      name: 'NAV 3 (公証中継所)',
      pos: [0, 0, -29000],
      arriveRadius: 2400,
      onArrive: [
        { speaker: '公証中継所', text: '書式を受理。提出時刻を記録しました。', tone: 'command' },
      ],
    },
  ],
  spawns: [
    {
      // 停止命令を執行する連邦の哨戒機。撃ってこない代わりに航路を塞ぐ。
      // 撃墜すると `protect` が失敗し、告発の正当性を失ったことになる。
      shipId: 'hornet',
      count: 2,
      faction: 'confed',
      atNav: 0,
      delay: 4,
      offset: [-2600, 400, -3200],
      spread: 700,
      tag: TAG.escort,
      displayName: RAM_1,
      cruiseToNav: 2,
      speed: 240,
      radio: [
        { speaker: RAM_1, text: '所属と行き先を言え。発艦記録が無い。', tone: 'friendly' },
        { speaker: HART_NAME, text: '答えなくていい。抜けろ。', tone: 'command', after: 2 },
      ],
    },
    {
      // 境界側の哨戒機。中継所方向へ巡航し、航路上に居座る。
      shipId: 'scimitar',
      count: 1,
      faction: 'confed',
      atNav: 1,
      delay: 3,
      offset: [1800, -500, -2400],
      tag: TAG.escort,
      displayName: RAM_2,
      cruiseToNav: 2,
      speed: 220,
    },
    {
      // 急進派。こちらの識別票を読んで先回りしてくる（唯一の交戦相手）。
      shipId: 'ke04-mirage',
      count: 2,
      faction: 'kilrathi',
      atNav: 0,
      delay: 9,
      offset: [3400, 800, -2600],
      spread: 600,
      tag: TAG.radical,
      ace: { pilot: DAKHAS_NAME, skillBonus: 0.3 },
      radio: [
        { speaker: DAKHAS_NAME, text: '貴機の識別は83年前から我々の帳簿にある。', tone: 'enemy' },
        { speaker: NIA_NAME, text: '撃たないで。一発でも撃てば告発は紙屑です。', tone: 'command', after: 2.4 },
      ],
    },
    {
      // 第2波。境界を越えたところで追いつかせ、振り切る区間を作る。
      shipId: 'kf06-talon',
      count: 2,
      faction: 'kilrathi',
      atNav: 1,
      delay: 8,
      offset: [-3200, -700, -3400],
      spread: 600,
      tag: TAG.radical,
      radio: [
        { speaker: CONTROL, text: '急進派、2機追加。針路を読まれています。', tone: 'command' },
      ],
    },
  ],
  objectives: [
    {
      // 主目標。この章の勝敗はここだけで決まるので required。
      id: 'deliver',
      text: '告発データを公証中継所へ搬送',
      required: true,
      spec: { kind: 'reachNav', navIndex: 2 },
    },
    {
      // 中継所は72時間後に閉鎖される。期限を過ぎた告発は効力を持たないので required。
      id: 'window',
      text: '受理期限内に到着する（中継所は閉鎖予定）',
      required: true,
      spec: { kind: 'timeLimit', seconds: 300 },
    },
    {
      // 発砲禁止（T6-7）。引き金を引いたかどうかそのものを判定する。
      //
      // **required: false にしている理由**: 正典の受入基準は
      // 「発砲時に『失敗』ではなく『代償』として結果へ反映される（即失敗にしない）」。
      // 必須にすると1発で任務失敗になり、代償として払う機会が消えてしまう。
      // 失敗した記録（この目標の failed）が commandTrust と第8章の認証に効く。
      id: 'restraint',
      text: '一発も撃たない。発砲は共同設備の保全規約違反。告発の正当性を失う',
      required: false,
      spec: { kind: 'weaponsSafe' },
    },
    {
      // 哨戒機の保護。`weaponsSafe` と重なるが、**意味が違うので両方残す**。
      //   ・急進派を撃った → `restraint` だけが失敗（規約違反という代償）
      //   ・停止命令を執行しているだけの連邦哨戒機を落とした → 両方が失敗
      //     （規約違反に加えて、味方を殺して告発を通したことが記録に残る）
      // この差は結果画面で読める重さの差なので、一本化しない。
      id: 'patrol-alive',
      text: '連邦哨戒機を撃墜しない（停止命令の執行者を殺して通した記録を残さない）',
      required: false,
      spec: { kind: 'protect', tag: TAG.escort },
    },
  ],
  openingRadio: [
    { speaker: HART_NAME, text: '命令は後で書き直せる。人は書き直せない。', tone: 'command' },
    { speaker: HART_NAME, text: `${CLAW} は動かせない。箱は君が運ぶ。`, tone: 'command', after: 2.2 },
    { speaker: NIA_NAME, text: '燃料は片道分です。撃たずに、読んで抜けてください。', tone: 'command', after: 2.2 },
  ],
  debriefWin: [
    '告発は期限内に受理された。六つ目の条項は83年遅れで審査に入る。',
    '代償は請求書のように届く。無許可発艦の記録が残り、次の出撃で積める兵装は減り、司令部の無線は事務的になった。',
    'ハートは謝らなかった。「命令は後で書き直せる」と言っただけだ。',
  ],
  debriefLoss: [
    '中継所は保全のため閉鎖された。箱は開かれないまま戻ってきた。',
    '手続きは守られ、経歴は無傷だ。証拠は第8章の停戦交渉に間に合わない。',
    '停戦の書式に、連邦の告発文は一行も載らない。',
  ],
};
