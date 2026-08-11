import type { MissionDef } from '../../../src/mission/types';

/**
 * `MissionRunner` を検証するためのテスト専用ミッション。
 *
 * ■ なぜ実 content を使わないのか
 * 以前は旧キャンペーンの11ミッション（`m1-patrol` など）を対照実験の土台にしていたが、
 * 戦役を THE VEIL FRONT だけにしたときに削除した。十章のミッションは
 * 「章の物語」に合わせて作られていて `destroyAll` を持たないなど形が違うため、
 * runner の目標判定・ウェーブ投入・難易度の検証にはそのまま使えない。
 *
 * そこで **検証したい形だけを持つ最小のミッション**をここに置く。
 * 実 content を書き換えても runner のテストが巻き添えで落ちない、という利点もある。
 * 機体 id は実在のもの（`src/content/ships.ts`）を使う（`ship-id-migration` の検査対象）。
 */

/** どのミッションでも共通の帰投 Nav */
const HOME = { name: '帰投', pos: [0, 0, 0] as [number, number, number], arriveRadius: 1400 };

/**
 * 哨戒。`destroyAll` と Nav 到達、Nav に紐付いたウェーブ（delay 2 秒）を持つ。
 * 旧 `m1-patrol` の役割。
 */
export const TEST_PATROL: MissionDef = {
  id: 'test-patrol',
  title: 'テスト — 哨戒',
  system: 'テスト空域',
  briefingSpeaker: 'テスト',
  briefingSpeakerId: 'confed-06',
  briefing: ['哨戒せよ。'],
  playerShipId: 'hornet',
  wingman: { shipId: 'hornet', pilot: 'Sable', skill: 0.62 },
  openingRadio: [
    { speaker: '管制', text: '発艦を確認。哨戒コースへ乗れ。', tone: 'command' },
    { speaker: 'Sable', text: 'お前の翼に付く。', tone: 'friendly', after: 3 },
  ],
  navs: [
    { name: 'NAV 1', pos: [1200, 400, -13000] },
    { name: 'NAV 2', pos: [-9000, -1200, -24000] },
    { name: 'NAV 3', pos: [7000, 2000, -34000] },
    HOME,
  ],
  spawns: [
    { shipId: 'ke04-mirage', count: 2, faction: 'kilrathi', atNav: 1, delay: 2, offset: [2600, 700, -2400] },
    { shipId: 'kf03-greyhaul', count: 2, faction: 'kilrathi', atNav: 2, delay: 3, offset: [-2800, -600, -2600] },
  ],
  objectives: [
    { id: 'clear', text: '敵偵察機を全機撃破', required: true, spec: { kind: 'destroyAll' } },
    { id: 'nav3', text: 'NAV 3 まで哨戒', required: true, spec: { kind: 'reachNav', navIndex: 2 } },
    { id: 'home', text: '帰投', required: true, spec: { kind: 'reachNav', navIndex: 3 } },
  ],
  debriefWin: ['達成。'],
  debriefLoss: ['未達。'],
};

/**
 * 護衛。Nav 0 到達で `passive` の輸送艦（tag `convoy`）が出て、`protect` で守る。
 * 旧 `m2-escort` の役割。
 */
export const TEST_ESCORT: MissionDef = {
  id: 'test-escort',
  title: 'テスト — 護衛',
  system: 'テスト空域',
  briefingSpeaker: 'テスト',
  briefingSpeakerId: 'confed-06',
  briefing: ['護衛せよ。'],
  playerShipId: 'hornet',
  navs: [
    { name: 'NAV 1 (合流点)', pos: [2000, 0, -12000], arriveRadius: 2000 },
    { name: 'NAV 2', pos: [-4000, 600, -26000] },
    HOME,
  ],
  spawns: [
    {
      shipId: 'drayman',
      count: 1,
      faction: 'confed',
      atNav: 0,
      tag: 'convoy',
      displayName: '輸送船〈テスト〉',
      cruiseToNav: 2,
    },
    { shipId: 'ke04-mirage', count: 2, faction: 'kilrathi', atNav: 0, delay: 4, offset: [3000, 500, -3000] },
  ],
  objectives: [
    { id: 'convoy', text: '輸送船を守る', required: true, spec: { kind: 'protect', tag: 'convoy' } },
    { id: 'home', text: '帰投', required: true, spec: { kind: 'reachNav', navIndex: 2 } },
  ],
  debriefWin: ['達成。'],
  debriefLoss: ['未達。'],
};

/**
 * 強襲。Nav 1 に tag `supply` の輸送艦が2隻いて、`destroyTag` で全部壊す。
 * 旧 `m3-strike` の役割。
 */
export const TEST_STRIKE: MissionDef = {
  id: 'test-strike',
  title: 'テスト — 強襲',
  system: 'テスト空域',
  briefingSpeaker: 'テスト',
  briefingSpeakerId: 'confed-06',
  briefing: ['補給所を叩け。'],
  playerShipId: 'raptor',
  // 機雷の既定挙動（熱紋限定でも共振でもない）を検証する側の土台になる
  hazards: [
    { kind: 'asteroids', atNav: 1, count: 30, spread: 1800, rockRadius: [16, 80] },
    { kind: 'minefield', atNav: 1, count: 12, spread: 1200 },
  ],
  navs: [
    { name: 'NAV 1 (侵入点)', pos: [4000, -800, -16000] },
    { name: 'NAV 2 (補給所)', pos: [-6000, 1500, -32000], arriveRadius: 2200 },
    HOME,
  ],
  spawns: [
    { shipId: 'kb05-boarbreaker', count: 2, faction: 'kilrathi', atNav: 1, tag: 'supply', spread: 900 },
    { shipId: 'kf01-leonfang', count: 2, faction: 'kilrathi', atNav: 1, delay: 2, offset: [4300, 1000, 4600] },
  ],
  objectives: [
    { id: 'supply', text: '輸送艦 2 隻を破壊', required: true, spec: { kind: 'destroyTag', tag: 'supply' } },
    { id: 'clear', text: '護衛戦闘機を排除', required: false, spec: { kind: 'destroyAll' } },
    { id: 'home', text: '帰投', required: true, spec: { kind: 'reachNav', navIndex: 2 } },
  ],
  debriefWin: ['達成。'],
  debriefLoss: ['未達。'],
};

/**
 * 防衛。150 秒後にエース指定の1機を含むウェーブが来る。
 * 旧 `m4-defend` の役割（エースの検証用）。
 */
export const TEST_DEFEND: MissionDef = {
  id: 'test-defend',
  title: 'テスト — 防衛',
  system: 'テスト空域',
  briefingSpeaker: 'テスト',
  briefingSpeakerId: 'confed-06',
  briefing: ['母艦を守れ。'],
  playerShipId: 'rapier',
  navs: [{ name: 'NAV 1 (防衛線)', pos: [0, 0, -6000], arriveRadius: 2600 }, HOME],
  // 母艦防衛なので、ウェーブは Nav 到達ではなく開始からの経過時間で来る（atNav を持たない）
  spawns: [
    { shipId: 'kf03-greyhaul', count: 2, faction: 'kilrathi', delay: 3, offset: [3000, 400, -4000] },
    {
      shipId: 'kf06-talon',
      count: 1,
      faction: 'kilrathi',
      delay: 150,
      offset: [-2000, 900, -5000],
      ace: { pilot: 'ラギティカ', skillBonus: 0.35 },
    },
  ],
  objectives: [
    { id: 'clear', text: '襲撃隊を撃退', required: true, spec: { kind: 'destroyAll' } },
  ],
  debriefWin: ['達成。'],
  debriefLoss: ['未達。'],
};

/**
 * 旗艦攻撃。砲塔 → エンジン → 魚雷の段階（`capitalSequence`）を持つ。
 * 旧 `m6-flagship` の役割。
 */
export const TEST_FLAGSHIP: MissionDef = {
  id: 'test-flagship',
  title: 'テスト — 旗艦攻撃',
  system: 'テスト空域',
  briefingSpeaker: 'テスト',
  briefingSpeakerId: 'confed-06',
  briefing: ['旗艦を沈めろ。'],
  playerShipId: 'raptor',
  playerMissiles: [{ missileId: 'torpedo', count: 4 }],
  navs: [
    { name: 'NAV 1 (侵入点)', pos: [5000, 1200, -17000] },
    { name: 'NAV 2 (敵艦隊)', pos: [-7000, -1400, -33000], arriveRadius: 2600 },
    HOME,
  ],
  spawns: [
    {
      shipId: 'kilrashi-destroyer',
      count: 1,
      faction: 'kilrathi',
      atNav: 1,
      tag: 'flagship',
      displayName: '駆逐艦《テスト》',
    },
    { shipId: 'kf01-leonfang', count: 2, faction: 'kilrathi', atNav: 1, delay: 2, tag: 'escort', offset: [2600, 400, 2600] },
  ],
  objectives: [
    { id: 'flagship', text: '駆逐艦《テスト》を撃沈', required: true, spec: { kind: 'destroyTag', tag: 'flagship' } },
    { id: 'escort', text: '旗艦護衛を排除', required: false, spec: { kind: 'destroyTag', tag: 'escort' } },
    { id: 'home', text: '帰投', required: true, spec: { kind: 'reachNav', navIndex: 2 } },
  ],
  capitalStages: [
    { id: 'escort', text: '旗艦護衛を排除', tag: 'escort' },
    { id: 'flagship', text: '旗艦を撃破', tag: 'flagship' },
  ],
  capitalSequence: [
    { id: 'turret', text: '旗艦の砲塔を無力化', tag: 'flagship', subsystem: 'turret' },
    { id: 'engine', text: '旗艦のエンジンを停止', tag: 'flagship', subsystem: 'engine' },
    { id: 'torpedo', text: '旗艦へ対艦魚雷を発射', tag: 'flagship', weapon: 'torpedo' },
  ],
  debriefWin: ['達成。'],
  debriefLoss: ['未達。'],
};

/**
 * 捜索救難。Nav 0 到達で脱出ポッド3基（tag `pods`）と難民船（tag `liner`）が出る。
 * 旧 `m3b-sar` の役割。
 */
export const TEST_RESCUE: MissionDef = {
  id: 'test-rescue',
  title: 'テスト — 捜索救難',
  system: 'テスト空域',
  briefingSpeaker: 'テスト',
  briefingSpeakerId: 'confed-06',
  briefing: ['拾えるものを拾え。'],
  playerShipId: 'scimitar',
  navs: [
    { name: 'NAV 1 (救難区域)', pos: [-3000, 500, -18000], arriveRadius: 2400 },
    HOME,
  ],
  spawns: [
    { shipId: 'escape-pod', count: 3, faction: 'confed', atNav: 0, tag: 'pods', spread: 700 },
    { shipId: 'refugee-liner', count: 1, faction: 'confed', atNav: 0, tag: 'liner', displayName: '難民船〈テスト〉' },
  ],
  objectives: [
    { id: 'pods', text: '脱出ポッド 3 基を収容する', required: true, spec: { kind: 'rescue', tag: 'pods', radius: 280 } },
    { id: 'liner', text: '難民船を守る', required: true, spec: { kind: 'protect', tag: 'liner' } },
    { id: 'home', text: '帰投', required: true, spec: { kind: 'reachNav', navIndex: 1 } },
  ],
  debriefWin: ['達成。'],
  debriefLoss: ['未達。'],
};

/**
 * 偵察。Nav 1 に tag `target` がいて、正面に捉え続けると撮影が成立する。
 * 旧 `m2b-recon` の役割。
 */
export const TEST_RECON: MissionDef = {
  id: 'test-recon',
  title: 'テスト — 偵察',
  system: 'テスト空域',
  briefingSpeaker: 'テスト',
  briefingSpeakerId: 'confed-06',
  briefing: ['撮ってこい。'],
  playerShipId: 'hornet',
  navs: [
    { name: 'NAV 1', pos: [2600, -600, -14000] },
    { name: 'NAV 2 (対象)', pos: [-5000, 900, -28000], arriveRadius: 2400 },
    HOME,
  ],
  spawns: [
    { shipId: 'kb05-boarbreaker', count: 1, faction: 'kilrathi', atNav: 1, tag: 'target', displayName: '輸送艦〈テスト〉' },
  ],
  objectives: [
    { id: 'photo', text: '対象を撮影する', required: true, spec: { kind: 'recon', tag: 'target', seconds: 5, range: 1200, coneDeg: 20 } },
    { id: 'home', text: 'フィルムを持ち帰る', required: true, spec: { kind: 'reachNav', navIndex: 2 } },
  ],
  debriefWin: ['達成。'],
  debriefLoss: ['未達。'],
};

/**
 * 迎撃。240 秒の制限時間を持ち、超過すると失敗になる。
 * 旧 `m5b-intercept` の役割。
 */
export const TEST_TIME_LIMIT: MissionDef = {
  id: 'test-time-limit',
  title: 'テスト — 迎撃',
  system: 'テスト空域',
  briefingSpeaker: 'テスト',
  briefingSpeakerId: 'confed-06',
  briefing: ['間に合わせろ。'],
  playerShipId: 'rapier',
  navs: [{ name: 'NAV 1 (迎撃線)', pos: [0, 0, -9000], arriveRadius: 2400 }, HOME],
  spawns: [
    { shipId: 'kb02-bastion', count: 2, faction: 'kilrathi', atNav: 0, tag: 'bombers', spread: 800 },
  ],
  objectives: [
    { id: 'bombers', text: '爆撃機を撃破', required: true, spec: { kind: 'destroyTag', tag: 'bombers' } },
    { id: 'limit', text: '雷撃開始まで', required: true, spec: { kind: 'timeLimit', seconds: 240 } },
    { id: 'home', text: '帰投', required: true, spec: { kind: 'reachNav', navIndex: 1 } },
  ],
  debriefWin: ['達成。'],
  debriefLoss: ['未達。'],
};
