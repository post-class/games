/**
 * 第4章 OPERATION DEEP MEASURE — 深層採掘帯（`deep-mining-belt`）。
 *
 * 出典: ストーリー_十章作戦記録.html CHAPTER 04 ／ `chapters.ts` の `veil-ch04`。
 *
 * この章の要点（データに落とすときに崩してはいけないもの）:
 * - オルドは**殺していない**。重力アンカーは兵器ではなく境界標で、契約船は無傷のまま縫い止められている。
 *   だから戦場に**敵対勢力を1機も置かない**。緊張は「撃ち合い」ではなく「残り時間」から来る。
 * - 交渉窓口の重力戦術官アインは敵ではないので撃ってこない。オルド機は `faction: 'ordo'` で置く
 *   （`isHostile('confed', 'ordo')` は false = 非敵対。`src/content/factions.ts` の既定表を参照）。
 * - 参謀ニア・ウィリアムズの在庫の話（空気19時間／掘り出し14時間／往復は1回だけ）が
 *   そのまま目標構成になっている。**乗員救助と証拠回収は両方できない**。
 *
 * ■ ギミックの実装（T6-4）
 * - **重力井戸**: `hazards` に `kind: 'gravity-well'` を足し、アンカーの位置と影響半径を
 *   空域の宣言として置いた。機体（`oe06-ironroot`）を参照していないのは、
 *   参照すると「アンカーを撃てば重力が消える」ことになり、
 *   「撃つか撃たないか」がこの章の選択（BOUNDARY）である前提が崩れるため。
 *   井戸の中では自機の実効質量が `cycle` 秒周期で振れ（加速と旋回の効きが変わる）、
 *   ミサイルは井戸の中心へ引かれて弧を描く。実装は `src/sim/obstacles.ts`。
 *   **敵の難易度パラメータには一切触れていない**（この戦場に敵対勢力はいない）。
 * - **移動する残骸帯**: `hazards.asteroids.drift` で帯全体を航路方向へ流す。
 *   岩の移動そのものは既存の `updateObstacles()` がやっているので、
 *   宣言の無い既存11ミッションの帯は静的なまま変わらない。
 * - 重力が動いた瞬間は、アインの無線＋`announce` と、`timeLimit` 目標の note の
 *   二経路で読める（T6-3 の共鳴パルスと同じ流儀。`src/hud/*` は触らない）。
 */

import type { MissionDef } from '../../../mission/types';
import { veilChapter } from '../chapters';
import { skillFromGrade, veilPerson } from '../people';
import { CLAW, CONTROL, TAG, speakerName, theaterScenery } from './shared';

const scenery = theaterScenery('deep-mining-belt');


/** 重力戦術官アイン（オルド。91年＝オルドの中では若く、短期の言語を扱える） */
const AIN = veilPerson('ordo-03');
/** 空母航空団参謀ニア・ウィリアムズ。ブリーフィングで在庫を数える */
const NIA = veilPerson('confed-11');
/** 爆撃機パイロット オマル・ラーマン。この章では自分の腕を使わない提案をする */
const OMAR = veilPerson('confed-12');
/** 合議王アーク。裁定はこの章では下らない */
const ARC = veilPerson('ordo-01');

/** 契約船の空気（19時間）を出撃1回の尺に落としたもの。数値の調整は T6-4 の重力井戸と併せて行う */
const AIR_SECONDS = 420;

export const VEIL_CH04: MissionDef = {
  id: 'veil-ch04',
  title: `第4章 ${veilChapter(4).title}`,
  system: '深層採掘帯',
  briefingSpeaker: speakerName(NIA.id),
  briefingSpeakerId: NIA.id,
  briefingSpeakerRole: NIA.role,
  briefing: [
    '救出作戦の形をしていない任務です。深層採掘帯を無許可で強行通過した連邦の契約船が、オルドの重力アンカーで縫い止められています。船体は無傷、乗員も生きている。オルドは殺していません。ただ止めているだけです。',
    'ただし合議王アークの裁定は数十年単位で下ります。船内の空気はその前に尽きる。交渉窓口は重力戦術官アイン。彼が告げるのは告発ではなく症状です。連邦が持ち出した門制御核の断片が、採掘帯の地層記憶を焼いている。オルドは補償を求めません。傷が広がる前に断片を止めてほしいだけです。',
    'アンカーは兵器ではなく境界標です。撃てば乗員は今すぐ助かりますが、オルドは記録に「連邦は境界を撃った」と刻みます。証拠回収を先にすれば、契約船の空気は削られていく。',
    '在庫を読みます。契約船の空気は19時間、採掘記録の掘り出しは14時間、往復の燃料が許すのは1回だけ。全部やる余裕はありません。どれを諦めるか、先に決めてください。',
  ],
  // 爆撃機ではなく、牽引索と回収装置を積める中量機で出る（オマルの「腕を使わない提案」）。
  playerShipId: 'scimitar',
  wingman: {
    shipId: 'raptor',
    pilot: speakerName(OMAR.id),
    skill: skillFromGrade(OMAR.grade),
  },
  skybox: scenery.skybox,
  landmarks: scenery.landmarks,
  hazards: [
    // 移動する残骸帯。帯全体が航路方向へ流れるので、
    // 「往路で空けた隙間が復路では埋まっている」状態になる。
    {
      kind: 'asteroids',
      betweenNavs: [0, 1],
      count: 44,
      spread: 1700,
      rockRadius: [18, 90],
      drift: { speed: 55 },
    },
    // 拘束点のまわりの浮遊岩。アンカーが掴んでいる岩塊なので、こちらも一緒に流れる
    {
      kind: 'asteroids',
      atNav: 1,
      count: 26,
      spread: 1500,
      rockRadius: [16, 70],
      drift: { speed: 40, dir: [0.4, 0.1, -1] },
    },
    // 記録の露頭。掘り出し途中の地層は動かない（読み取り対象なので静止させる）
    { kind: 'asteroids', atNav: 2, count: 30, spread: 1600, rockRadius: [20, 110] },
    /**
     * オルドの重力アンカーが作る重力井戸。
     * 位置は `oe06-ironroot`（TAG.support）と同じ NAV 2 のオフセットに合わせる。
     * cycle 8 秒 =「数秒単位で質量が変わる」。swing 0.45 で 0.55〜1.45 倍まで振れる。
     * pull はミサイルを井戸へ引く加速度で、弧を描いて戻ってくる強さ。
     * **敵の性能には触らない。変わるのは自機の機動とミサイルの弾道だけ。**
     */
    {
      kind: 'gravity-well',
      atNav: 1,
      offset: [-1600, 300, -1200],
      count: 1,
      spread: 4200,
      gravity: { cycle: 8, swing: 0.45, pull: 150, speaker: AIN.name },
    },
  ],
  navs: [
    {
      name: 'NAV 1 (境界標)',
      pos: [3000, -600, -14000],
      onArrive: [
        {
          speaker: AIN.name,
          text: '止まれ。ここから先は記憶だ。撃つな、読め。',
          tone: 'command',
        },
      ],
    },
    {
      name: 'NAV 2 (拘束された契約船)',
      pos: [-6000, 1400, -27000],
      arriveRadius: 2200,
      onArrive: [
        {
          speaker: AIN.name,
          text: '船は無傷だ。我々は殺していない。止めているだけだ。',
          tone: 'command',
        },
        {
          speaker: speakerName(OMAR.id),
          text: '空気が減ってる。爆弾じゃなく牽引索で開ける、俺に合わせろ。',
          tone: 'friendly',
          after: 2,
        },
        // 重力井戸の予告。以後、重力が動くたびに無線と目標の note で知らせる
        {
          speaker: AIN.name,
          text: 'これから局所重力を動かす。8秒ごとにお前の機体の重さが変わる。ミサイルは戻ってくるぞ。',
          tone: 'command',
          after: 2.5,
        },
      ],
    },
    {
      name: 'NAV 3 (採掘記録の露頭)',
      pos: [9000, -2200, -34000],
      arriveRadius: 2000,
      onArrive: [
        {
          speaker: AIN.name,
          text: '断片が地層を焼いた跡だ。記録を読め。補償はいらない。',
          tone: 'command',
        },
      ],
    },
    {
      name: '帰投',
      pos: [0, 0, 0],
      arriveRadius: 1400,
      onArrive: [{ speaker: CONTROL, text: `${CLAW}、収容準備。燃料は空だ。`, tone: 'command' }],
    },
  ],
  spawns: [
    // 縫い止められた連邦の契約船。無傷なので撃たれてはいないが、動けない（speed 0）
    {
      shipId: 'drayman',
      count: 1,
      faction: 'confed',
      atNav: 1,
      tag: TAG.escort,
      displayName: '連邦契約船',
      offset: [0, 0, -400],
      speed: 0,
    },
    // 契約船の乗員。船外へ出た3名を拾う
    {
      shipId: 'escape-pod',
      count: 3,
      faction: 'neutral',
      atNav: 1,
      delay: 4,
      offset: [900, 200, 600],
      spread: 900,
      tag: TAG.rescue,
      speed: 6,
      radio: [
        { speaker: CONTROL, text: '乗員の信号、3つ。船外に出ている。', tone: 'command' },
      ],
    },
    // 重力アンカーを打っているオルドの重力輸送タグ。非敵対なので撃ってこない
    {
      shipId: 'oe06-ironroot',
      count: 1,
      faction: 'ordo',
      atNav: 1,
      offset: [-1600, 300, -1200],
      tag: TAG.support,
      speed: 0,
    },
    // アインの機。局所重力を動かすが、こちらへは撃たない
    {
      shipId: 'of02-spar',
      count: 2,
      faction: 'ordo',
      atNav: 1,
      delay: 8,
      offset: [1800, -400, -2000],
      spread: 700,
      tag: TAG.support,
    },
    // 採掘停止の記録を照らしているオルドの観測機。撮影対象（TAG.survey）
    {
      shipId: 'of02-spar',
      count: 2,
      faction: 'ordo',
      atNav: 2,
      offset: [0, 0, -600],
      spread: 500,
      tag: TAG.survey,
      radio: [
        {
          speaker: AIN.name,
          text: '記録は逃げない。だが、お前たちの空気は逃げる。',
          tone: 'command',
        },
      ],
    },
  ],
  objectives: [
    /**
     * 必須。帰投そのものが目標になる（往復の燃料が許すのは1回だけ）。
     * 交戦目標を必須にしないのは、この戦場に敵対勢力がいないため。
     */
    { id: 'home', text: '帰投する (往復の燃料は1回分)', required: true, spec: { kind: 'reachNav', navIndex: 3 } },
    /**
     * 必須。契約船の空気が尽きるまでの時間。
     * 「両方は無理」を作るのはこの制約で、超過すれば任務失敗になる。
     * この目標の note に重力井戸の状態（重い／軽い／反転まで何秒）が載る。
     */
    {
      id: 'air',
      text: '契約船の空気が尽きる前に離脱する (19時間)',
      required: true,
      spec: { kind: 'timeLimit', seconds: AIR_SECONDS },
    },
    /**
     * 任意。乗員救助。
     * 必須にしないのは、この章の選択が「乗員か証拠か」であり、
     * 諦めた側を任務失敗にしてしまうと選択が成立しないため（BOUNDARY の二択）。
     */
    {
      id: 'crew',
      text: '契約船の乗員3名を回収 (証拠回収と両立しない)',
      required: false,
      spec: { kind: 'rescue', tag: TAG.rescue, radius: 300 },
    },
    /**
     * 任意。採掘停止の証拠（地層記憶が焼かれた記録）の確保。
     * こちらも必須にしない。第7章の告発材料になるが、選ばなかった側は失われるだけで、
     * 任務は失敗しない。
     */
    {
      id: 'survey',
      text: '採掘停止の記録を読み取る (乗員救助と両立しない)',
      required: false,
      spec: { kind: 'recon', tag: TAG.survey, seconds: 8, range: 1300, coneDeg: 22 },
    },
    /**
     * 任意。契約船そのものの保全。
     * オルドは撃ってこないので通常は成立するが、こちらの誤射で沈めば失われる。
     * 必須にしないのは、誤射の判定を任務失敗に直結させないため（誤射評価は T6-2 の担当）。
     */
    { id: 'ship', text: '契約船を無傷で残す', required: false, spec: { kind: 'protect', tag: TAG.escort } },
  ],
  openingRadio: [
    { speaker: CONTROL, text: '重力アンカーは兵器ではない。境界標だ。撃てば協定違反になる。', tone: 'command' },
    {
      speaker: speakerName(OMAR.id),
      text: '今日は爆弾を落とさない。牽引索を持って行く。腕は使わない。',
      tone: 'friendly',
      after: 3,
    },
    {
      speaker: AIN.name,
      text: '短期の言語で話す。断片を止めろ。補償はいらない。',
      tone: 'command',
      after: 3,
    },
  ],
  debriefWin: [
    `オルドは感謝も報復もしない。ただ記録する。${ARC.name}の裁定はこの章では下らん。`,
    '千二百年を生きる合議王にとって、今回の出撃は地層に刻まれる細い一本の線だ。',
    'だがその線が、第8章で門周辺の重力固定を差し出すかどうかを決める。人類の側にとって、それは最も長く残る戦果になる。',
  ],
  debriefLoss: [
    '契約船の空気が尽きた。乗員も、記録も、こちらの手には残っていない。',
    'オルドはそれも記録する。境界の内側で人間が息を止めた、という一行として。',
  ],
};
