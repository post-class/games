import type { MissionDef } from '../mission/types';

/**
 * ミッション定義。ここにデータを足せばゲームが増える。
 * 座標は自機の出撃位置を原点とするワールド座標。
 */

const CLAW = 'TCS タイガーズ・クロー';

// ───────── 勝ちルート ─────────

const M1_PATROL: MissionDef = {
  id: 'm1-patrol',
  title: '哨戒 — マッカフリー宙域',
  system: 'McCaffrey',
  briefingSpeaker: 'ハルシオン大佐',
  briefing: [
    '諸君、ようこそタイガーズ・クローへ。挨拶は後だ、いきなり仕事がある。',
    'マッカフリー宙域の外縁で、我が方の航路ブイが3基沈黙した。キルラシーの偵察隊が入り込んでいる可能性が高い。',
    'Nav 1 から Nav 3 を順に確認し、敵の偵察機を排除して帰投せよ。新人の腕試しにはちょうどいい。',
    '一つだけ言っておく。ここで死ぬな。お前の墓を掘る時間が惜しい。',
  ],
  playerShipId: 'hornet',
  wingman: { shipId: 'hornet', pilot: 'Spirit', skill: 0.62 },
  skybox: { nebulaHue: 0.58, planetColor: 0x1d3c5e, seed: 1001 },
  landmarks: [
    { kind: 'gas-giant', pos: [14000, 2600, -30000], scale: 4200, color: 0x3d6a92 },
    { kind: 'station', pos: [-6000, -900, -9000], scale: 700 },
  ],
  hazards: [{ kind: 'asteroids', atNav: 2, count: 18, spread: 1700, rockRadius: [14, 55] }],
  navs: [
    { name: 'NAV 1', pos: [1200, 400, -13000] },
    {
      name: 'NAV 2',
      pos: [-9000, -1200, -24000],
      onArrive: [{ speaker: 'Spirit', text: 'レーダーに反応。猫が来たぞ。', tone: 'friendly' }],
    },
    {
      name: 'NAV 3',
      pos: [7000, 2000, -34000],
      onArrive: [{ speaker: 'Spirit', text: 'ブイの残骸だ…やられてるな。', tone: 'friendly' }],
    },
    {
      name: '帰投',
      pos: [0, 0, 0],
      arriveRadius: 1400,
      onArrive: [{ speaker: '管制', text: 'タイガーズ・クロー、着艦を許可する。', tone: 'command' }],
    },
  ],
  spawns: [
    {
      shipId: 'salthi',
      count: 2,
      faction: 'kilrathi',
      atNav: 1,
      delay: 2,
      offset: [2600, 700, -2400],
      radio: [{ speaker: 'Spirit', text: 'サルシー2機、軽い相手だ。落とすぞ！', tone: 'friendly' }],
    },
    {
      shipId: 'dralthi',
      count: 2,
      faction: 'kilrathi',
      atNav: 2,
      delay: 3,
      offset: [-2800, -600, -2600],
      radio: [{ speaker: 'Spirit', text: 'ドラルシー。さっきよりは硬い。気をつけろ。', tone: 'friendly' }],
    },
  ],
  objectives: [
    { id: 'clear', text: '敵偵察機を全機撃破', required: true, spec: { kind: 'destroyAll' } },
    { id: 'nav3', text: 'NAV 3 まで哨戒', required: true, spec: { kind: 'reachNav', navIndex: 2 } },
    { id: 'home', text: 'タイガーズ・クローへ帰投', required: true, spec: { kind: 'reachNav', navIndex: 3 } },
  ],
  openingRadio: [
    { speaker: '管制', text: '発艦を確認。哨戒コースへ乗れ。', tone: 'command' },
    { speaker: 'Spirit', text: 'お前の翼に付く。オートパイロットは A だ、忘れるなよ。', tone: 'friendly', after: 3 },
  ],
  debriefWin: [
    '偵察隊は排除された。ブイの損失は痛いが、宙域の目は取り戻した。',
    '悪くない初陣だ。次はもう新人扱いはしない。',
  ],
  debriefLoss: [
    '哨戒線は破られたままだ。敵の偵察隊は我々の配置を持ち帰った。',
    '戦況は悪化する。次の任務は防衛だ。',
  ],
};

const M2_ESCORT: MissionDef = {
  id: 'm2-escort',
  title: '護衛 — 補給船団',
  system: 'McCaffrey',
  briefingSpeaker: 'ハルシオン大佐',
  briefing: [
    '前回の哨戒で判ったことがある。奴らは我々の補給線を狙っている。',
    'ドレイマン級輸送艦《エルバ》がクローへ弾薬と燃料を運んでくる。あれが沈めば、我々は2週間戦えない。',
    'Nav 1 で《エルバ》と合流し、Nav 2 の集合点まで護衛せよ。輸送艦を沈められたら任務は失敗だ。',
    '一つ助言をやろう。輸送艦の周りを離れるな。奴らは君を釣りに来る。',
  ],
  playerShipId: 'scimitar',
  wingman: { shipId: 'hornet', pilot: 'Spirit', skill: 0.66 },
  skybox: { nebulaHue: 0.72, planetColor: 0x2a3f6b, seed: 2002 },
  landmarks: [
    { kind: 'jump-gate', pos: [-9000, 1500, -27000], scale: 1300 },
    { kind: 'derelict', pos: [4200, -800, -14000], scale: 350 },
  ],
  hazards: [
    { kind: 'asteroids', betweenNavs: [0, 1], count: 24, spread: 1600, rockRadius: [16, 65] },
  ],
  navs: [
    { name: 'NAV 1 (合流点)', pos: [-2000, 600, -15000] },
    {
      name: 'NAV 2 (集合点)',
      pos: [12000, -1500, -30000],
      arriveRadius: 1600,
      onArrive: [{ speaker: '《エルバ》', text: '護衛に感謝する。ここからは我々だけで行ける。', tone: 'friendly' }],
    },
  ],
  spawns: [
    {
      shipId: 'drayman',
      count: 1,
      faction: 'confed',
      atNav: 0,
      tag: 'convoy',
      cruiseToNav: 1,
      speed: 80,
      radio: [{ speaker: '《エルバ》', text: 'こちらエルバ。護衛の到着を待っていた。', tone: 'friendly' }],
    },
    {
      shipId: 'dralthi',
      count: 3,
      faction: 'kilrathi',
      atNav: 0,
      delay: 2,
      offset: [3000, 800, -2500],
      radio: [{ speaker: 'Spirit', text: '来たぞ、3機だ！輸送艦から離すな！', tone: 'friendly' }],
    },
    {
      shipId: 'krant',
      count: 2,
      faction: 'kilrathi',
      atNav: 0,
      delay: 42,
      offset: [-3500, -900, -3000],
      radio: [
        { speaker: '管制', text: '第2波を探知。クラント2機、輸送艦へ直進中。', tone: 'command' },
      ],
    },
  ],
  objectives: [
    { id: 'protect', text: '輸送艦《エルバ》を守る', required: true, spec: { kind: 'protect', tag: 'convoy' } },
    { id: 'clear', text: '襲撃隊を全機撃退', required: true, spec: { kind: 'destroyAll' } },
    { id: 'arrive', text: 'NAV 2 の集合点まで護衛', required: true, spec: { kind: 'reachNav', navIndex: 1 } },
  ],
  openingRadio: [
    { speaker: '管制', text: '《エルバ》は Nav 1 で待機中。急げ。', tone: 'command' },
  ],
  debriefWin: [
    '《エルバ》は無事に集合点へ着いた。弾薬庫は満たされ、我々はまだ戦える。',
    '輸送船の乗員が君に礼を言っていた。伝えておく。',
  ],
  debriefLoss: [
    '《エルバ》を失った。積んでいた弾薬もろとも、だ。',
    'この宙域を維持する余力はもうない。我々は退がる。',
  ],
};

const M3_STRIKE: MissionDef = {
  id: 'm3-strike',
  title: '強襲 — 前進補給所',
  system: 'Gimle',
  briefingSpeaker: 'ハルシオン大佐',
  briefing: [
    '守りに回っているだけでは戦争は終わらん。攻める番だ。',
    '偵察の結果、ギムレ宙域にキルラシーの前進補給所がある。ドーキア級輸送艦2隻が停泊中だ。',
    'Nav 2 の補給所へ侵入し、輸送艦2隻を破壊せよ。護衛のクラントが3機いる。まず戦闘機を剥がしてから輸送艦を叩け。',
    '君にはラプターを出す。鈍いが、殴り合いには向いている。',
  ],
  playerShipId: 'raptor',
  wingman: { shipId: 'scimitar', pilot: 'Maniac', skill: 0.7 },
  skybox: { nebulaHue: 0.05, planetColor: 0x4a2a20, sunColor: 0xffd9a0, seed: 3003 },
  landmarks: [
    { kind: 'station', pos: [3000, 800, -24000], scale: 1100 },
    { kind: 'gas-giant', pos: [-18000, -3400, -28000], scale: 5000, color: 0x8f6a4a },
  ],
  hazards: [
    { kind: 'asteroids', atNav: 1, count: 30, spread: 1800, rockRadius: [16, 80] },
    { kind: 'minefield', atNav: 1, count: 12, spread: 1200 },
  ],
  navs: [
    { name: 'NAV 1 (侵入点)', pos: [4000, -800, -16000] },
    {
      name: 'NAV 2 (補給所)',
      pos: [-6000, 1500, -32000],
      arriveRadius: 2200,
      onArrive: [{ speaker: 'Maniac', text: '見えたぞ！でっかい的が2つだ、俺が先に沈める！', tone: 'friendly' }],
    },
    { name: '帰投', pos: [0, 0, 0], arriveRadius: 1400 },
  ],
  spawns: [
    {
      shipId: 'dorkir',
      count: 2,
      faction: 'kilrathi',
      atNav: 1,
      tag: 'supply',
      spread: 900,
    },
    {
      shipId: 'krant',
      count: 2,
      faction: 'kilrathi',
      atNav: 1,
      delay: 2,
      offset: [4300, 1000, 4600],
      radio: [{ speaker: 'Maniac', text: '護衛が起きた。任せろ、俺が引きつける。', tone: 'friendly' }],
    },
    {
      shipId: 'salthi',
      count: 2,
      faction: 'kilrathi',
      atNav: 1,
      delay: 62,
      offset: [-3800, -700, -3400],
      radio: [{ speaker: '管制', text: '増援だ。サルシー2機が補給所へ向かっている。', tone: 'command' }],
    },
  ],
  objectives: [
    { id: 'supply', text: 'ドーキア級輸送艦 2 隻を破壊', required: true, spec: { kind: 'destroyTag', tag: 'supply' } },
    { id: 'clear', text: '護衛戦闘機を排除', required: false, spec: { kind: 'destroyAll' } },
    { id: 'home', text: '帰投', required: true, spec: { kind: 'reachNav', navIndex: 2 } },
  ],
  openingRadio: [
    { speaker: 'Maniac', text: 'やっと攻めるのか。付き合ってやるよ、リーダー。', tone: 'friendly' },
  ],
  debriefWin: [
    '補給所は炎上した。ギムレ方面の敵の作戦テンポは確実に落ちる。',
    '攻勢の第一歩だ。よくやった。',
  ],
  debriefLoss: [
    '輸送艦は無傷で逃げた。奴らの補給線は生きている。',
    'こちらの位置も知られた。反撃が来るぞ。',
  ],
};

const M4_DEFEND: MissionDef = {
  id: 'm4-defend',
  title: '防衛戦 — タイガーズ・クロー',
  system: 'Gimle',
  briefingSpeaker: 'ハルシオン大佐',
  briefing: [
    '緊急発艦だ。ブリーフィングは短くする。',
    '敵の攻撃隊がクローへ直進している。艦を沈められたら、この宙域の連邦軍は終わりだ。',
    '発艦したらすぐ交戦になる。波は4つ。最後にエースが来る。名は Bhurak nar Caxki、腕は本物だ。',
    'ラピアーを出す。全速で守れ。艦を落とさせるな。',
  ],
  playerShipId: 'rapier',
  wingman: { shipId: 'rapier', pilot: 'Angel', skill: 0.76 },
  skybox: { nebulaHue: 0.02, planetColor: 0x3a2426, seed: 4004 },
  landmarks: [{ kind: 'sun', pos: [-20000, 5000, -24000], scale: 1500, color: 0xffe0b0 }],
  hazards: [{ kind: 'asteroids', atNav: 0, count: 12, spread: 2200, rockRadius: [18, 60] }],
  navs: [
    {
      name: '防衛点',
      pos: [0, 0, -2600],
      arriveRadius: 1200,
    },
  ],
  spawns: [
    {
      shipId: 'tigers-claw',
      count: 1,
      faction: 'confed',
      tag: 'claw',
      offset: [0, -200, 1800],
      speed: 30,
    },
    {
      shipId: 'dralthi',
      count: 3,
      faction: 'kilrathi',
      delay: 3,
      offset: [1500, 600, -7000],
      radio: [{ speaker: '管制', text: '第1波、ドラルシー3機。防衛点で迎え撃て。', tone: 'command' }],
    },
    {
      shipId: 'krant',
      count: 3,
      faction: 'kilrathi',
      delay: 48,
      offset: [-3000, -700, -8000],
      radio: [{ speaker: '管制', text: '第2波、クラント3機。艦への直進コースだ。', tone: 'command' }],
    },
    {
      shipId: 'gratha',
      count: 2,
      faction: 'kilrathi',
      delay: 96,
      offset: [2500, 900, -8500],
      radio: [
        { speaker: '管制', text: '第3波、グラサ2機。重武装だ、正面から撃ち合うな。', tone: 'command' },
      ],
    },
    {
      shipId: 'jalthi',
      count: 2,
      faction: 'kilrathi',
      delay: 150,
      offset: [-1500, 300, -9000],
      ace: { pilot: 'Bhurak nar Caxki', skillBonus: 0.35 },
      radio: [
        { speaker: '???', text: 'この艦は私が沈める。名を覚えておけ、Bhurak nar Caxki だ。', tone: 'enemy' },
        { speaker: 'Angel', text: 'エースよ。単独で相手にしないで。', tone: 'friendly', after: 2.5 },
      ],
    },
  ],
  objectives: [
    { id: 'claw', text: `${CLAW} を守る`, required: true, spec: { kind: 'protect', tag: 'claw' } },
    { id: 'clear', text: '攻撃隊を全機撃破', required: true, spec: { kind: 'destroyAll' } },
  ],
  openingRadio: [
    { speaker: '管制', text: '全機発艦。艦を守れ、それだけだ。', tone: 'command' },
  ],
  debriefWin: [
    'クローは無傷だ。あの攻撃隊を止めたのは君たちの働きによる。',
    'Bhurak を落としたか。奴の部隊は当分立ち直れんだろう。',
  ],
  debriefLoss: [
    '被弾多数。飛行甲板は半分が使えん。',
    'この状態では攻勢に出られない。撤退の準備を始める。',
  ],
};

const M5_ACE: MissionDef = {
  id: 'm5-ace',
  title: 'エース迎撃 — 血塗られた爪',
  system: 'Vega',
  briefingSpeaker: 'ハルシオン大佐',
  briefing: [
    '一人の敵パイロットについて話す。Khajja nar Ragitika、通称《血塗られた爪》。',
    '連邦のパイロットを17人殺している。うち3人はこのクローの搭乗員だ。',
    '奴の部隊がヴェガ宙域の Nav 2 を単独で哨戒している。罠かもしれん。それでも行く価値がある。',
    '奴はジャルシーに乗っている。6門だ。正面から行けば当たり負けする。旋回戦に持ち込め。',
  ],
  playerShipId: 'rapier',
  wingman: { shipId: 'rapier', pilot: 'Angel', skill: 0.8 },
  skybox: { nebulaHue: 0.85, planetColor: 0x241d4a, sunColor: 0xdfe6ff, seed: 5005 },
  landmarks: [
    { kind: 'derelict', pos: [-3200, 600, -17000], scale: 500 },
    { kind: 'jump-gate', pos: [11000, -1800, -26000], scale: 1200 },
  ],
  hazards: [{ kind: 'asteroids', atNav: 1, count: 28, spread: 1500, rockRadius: [14, 75] }],
  navs: [
    { name: 'NAV 1', pos: [-3000, 900, -15000] },
    {
      name: 'NAV 2 (交戦点)',
      pos: [9000, -2000, -31000],
      arriveRadius: 1800,
    },
    { name: '帰投', pos: [0, 0, 0], arriveRadius: 1400 },
  ],
  spawns: [
    {
      shipId: 'gratha',
      count: 2,
      faction: 'kilrathi',
      atNav: 1,
      delay: 2,
      offset: [3600, 900, 3400],
      tag: 'escort',
      ace: { pilot: 'Khajja nar Ragitika', skillBonus: 0.4, shipId: 'jalthi' },
      radio: [
        {
          speaker: 'Khajja nar Ragitika',
          text: '来たか、猿。お前の名は聞いている。私の18人目になれ。',
          tone: 'enemy',
        },
        { speaker: 'Angel', text: '本人よ。落ち着いて、旋回戦に引き込んで。', tone: 'friendly', after: 3 },
      ],
    },
    {
      shipId: 'salthi',
      count: 3,
      faction: 'kilrathi',
      atNav: 1,
      delay: 40,
      offset: [-3400, 900, -3600],
      radio: [{ speaker: 'Angel', text: '増援！やっぱり罠だったわ。', tone: 'friendly' }],
    },
  ],
  objectives: [
    { id: 'clear', text: '《血塗られた爪》の隊を撃破', required: true, spec: { kind: 'destroyAll' } },
    { id: 'home', text: '帰投', required: true, spec: { kind: 'reachNav', navIndex: 2 } },
  ],
  openingRadio: [
    { speaker: 'Angel', text: '仇を討つ機会よ。でも、熱くならないで。', tone: 'friendly' },
  ],
  debriefWin: [
    'Khajja nar Ragitika は落ちた。3人の仲間の借りは返した。',
    '敵の士気に効く。この一撃は数字以上の意味がある。',
  ],
  debriefLoss: [
    '奴は生きている。18人目の名前が刻まれるところだった。',
    '次は必ず落とせ。奴はまた来る。',
  ],
};

const M6_FLAGSHIP: MissionDef = {
  id: 'm6-flagship',
  title: '旗艦攻撃 — ラーラサ級駆逐艦',
  system: 'Vega',
  briefingSpeaker: 'ハルシオン大佐',
  briefing: [
    '最後の仕事だ。ヴェガ宙域からキルラシーを追い出す。',
    '敵はラーラサ級駆逐艦《カクタグ》を旗艦として展開している。あれを沈めれば残りは退がる。',
    '君のラピアーには対艦魚雷を積む。ロックに5秒かかる。その5秒を、直線飛行で耐えろ。',
    '護衛は重い。ジャルシー2機とグラサ2機だ。僚機と分担して、必ず魚雷手を作れ。',
  ],
  playerShipId: 'rapier',
  // 対艦魚雷を積んで出る
  playerMissiles: [
    { missileId: 'heat-seeker', count: 2 },
    { missileId: 'torpedo', count: 4 },
  ],
  wingman: { shipId: 'rapier', pilot: 'Angel', skill: 0.84 },
  skybox: { nebulaHue: 0.9, planetColor: 0x1b2a4a, seed: 6006 },
  landmarks: [
    { kind: 'gas-giant', pos: [16000, -3000, -29000], scale: 5600, color: 0x6a4f7a },
    { kind: 'station', pos: [-8000, 1400, -20000], scale: 950 },
  ],
  hazards: [{ kind: 'minefield', atNav: 1, count: 18, spread: 1500 }],
  navs: [
    { name: 'NAV 1 (侵入点)', pos: [5000, 1200, -17000] },
    {
      name: 'NAV 2 (敵艦隊)',
      pos: [-8000, -2500, -34000],
      arriveRadius: 2400,
      onArrive: [{ speaker: 'Angel', text: '《カクタグ》を視認。護衛が上がってくるわ。', tone: 'friendly' }],
    },
    { name: '帰投', pos: [0, 0, 0], arriveRadius: 1400 },
  ],
  spawns: [
    {
      shipId: 'ralatha',
      count: 1,
      faction: 'kilrathi',
      atNav: 1,
      tag: 'flagship',
      speed: 40,
    },
    {
      shipId: 'jalthi',
      count: 2,
      faction: 'kilrathi',
      atNav: 1,
      delay: 4,
      offset: [4600, 1200, 4200],
    },
    {
      shipId: 'gratha',
      count: 2,
      faction: 'kilrathi',
      atNav: 1,
      delay: 30,
      offset: [-4200, -900, 3800],
      radio: [{ speaker: 'Angel', text: 'グラサが来た！魚雷手を守るわ、撃って！', tone: 'friendly' }],
    },
  ],
  objectives: [
    { id: 'flagship', text: '駆逐艦《カクタグ》を撃沈', required: true, spec: { kind: 'destroyTag', tag: 'flagship' } },
    { id: 'home', text: '帰投', required: true, spec: { kind: 'reachNav', navIndex: 2 } },
  ],
  openingRadio: [
    { speaker: '管制', text: '魚雷は Nav 2 到達後に使え。ロック中は直進を保て。', tone: 'command' },
  ],
  debriefWin: [
    '《カクタグ》は沈んだ。ヴェガ宙域の敵艦隊は後退を始めている。',
    'この戦域は我々のものだ。よくやった、パイロット。君の名は記録に残る。',
  ],
  debriefLoss: [
    '《カクタグ》は健在だ。ヴェガは奴らの手に残る。',
    '長い戦争になる。だが、まだ終わってはいない。',
  ],
};

// ───────── 敗北ルート ─────────

const L1_RETREAT: MissionDef = {
  id: 'l1-retreat',
  title: '撤退援護 — 損傷艦の脱出',
  system: 'McCaffrey',
  briefingSpeaker: 'ハルシオン大佐',
  briefing: [
    '前の任務の結果、この宙域は維持できなくなった。撤退する。',
    '損傷したドレイマン級《ホーカー》が自力で跳べない。Nav 1 まで曳航中だ。',
    '曳航が終わるまで、90秒だけ持たせろ。撃退しろとは言わん。生きて時間を稼げ。',
    '死ぬな。今は一機も失えない。',
  ],
  playerShipId: 'scimitar',
  wingman: { shipId: 'hornet', pilot: 'Spirit', skill: 0.6 },
  skybox: { nebulaHue: 0.0, planetColor: 0x2a2226, seed: 7007 },
  landmarks: [{ kind: 'derelict', pos: [2400, -500, -9000], scale: 620 }],
  hazards: [{ kind: 'asteroids', atNav: 0, count: 20, spread: 1900, rockRadius: [16, 70] }],
  navs: [{ name: '防衛点', pos: [0, 0, -2200], arriveRadius: 1200 }],
  spawns: [
    {
      shipId: 'drayman',
      count: 1,
      faction: 'confed',
      tag: 'hawker',
      offset: [200, -120, 1200],
      speed: 20,
      radio: [{ speaker: '《ホーカー》', text: 'こちらホーカー。曳航中、機動できない。頼む。', tone: 'friendly' }],
    },
    {
      shipId: 'dralthi',
      count: 2,
      faction: 'kilrathi',
      delay: 4,
      offset: [1800, 500, -6500],
    },
    {
      shipId: 'krant',
      count: 2,
      faction: 'kilrathi',
      delay: 45,
      offset: [-2200, -600, -7000],
      radio: [{ speaker: 'Spirit', text: 'まだ来る！あと少しだ、耐えろ！', tone: 'friendly' }],
    },
  ],
  objectives: [
    { id: 'survive', text: '90 秒間 戦域を維持', required: true, spec: { kind: 'survive', seconds: 90 } },
    { id: 'hawker', text: '《ホーカー》を守る', required: true, spec: { kind: 'protect', tag: 'hawker' } },
  ],
  openingRadio: [
    { speaker: '管制', text: '曳航完了まで 90 秒。持たせろ。', tone: 'command' },
  ],
  debriefWin: [
    '《ホーカー》は跳んだ。乗員 240 名は生きている。',
    '撤退は成功だ。戦線を下げて、やり直す。次は攻める。',
  ],
  debriefLoss: [
    '《ホーカー》は宙域に残された。乗員は…記録に残しておく。',
    '状況はさらに悪い。クローそのものが狙われる。',
  ],
};

const L2_LAST_STAND: MissionDef = {
  id: 'l2-last-stand',
  title: '最終防衛 — クローを死守せよ',
  system: 'Gimle',
  briefingSpeaker: 'ハルシオン大佐',
  briefing: [
    '状況を隠さずに言う。クローは追い詰められている。',
    '敵の主力がこちらへ来ている。跳躍機関の再充填にあと4分かかる。それまで艦は動けない。',
    '発艦できる機体は全部出す。艦を守れ。これに負けたら、この艦は終わりだ。',
    '生き延びろ。それだけを命じる。',
  ],
  playerShipId: 'raptor',
  wingman: { shipId: 'rapier', pilot: 'Angel', skill: 0.78 },
  skybox: { nebulaHue: 0.98, planetColor: 0x321c1c, sunColor: 0xffc9a0, seed: 8008 },
  landmarks: [{ kind: 'sun', pos: [18000, 4200, -22000], scale: 1400, color: 0xffcf90 }],
  hazards: [{ kind: 'asteroids', atNav: 0, count: 16, spread: 2400, rockRadius: [18, 65] }],
  navs: [{ name: '防衛点', pos: [0, 0, -2400], arriveRadius: 1200 }],
  spawns: [
    {
      shipId: 'tigers-claw',
      count: 1,
      faction: 'confed',
      tag: 'claw',
      offset: [0, -220, 1900],
      speed: 20,
    },
    {
      shipId: 'krant',
      count: 3,
      faction: 'kilrathi',
      delay: 3,
      offset: [2000, 700, -7000],
    },
    {
      shipId: 'gratha',
      count: 2,
      faction: 'kilrathi',
      delay: 55,
      offset: [-2600, -800, -7500],
      radio: [{ speaker: '管制', text: '重戦闘機だ。艦の対空火器と協調して落とせ。', tone: 'command' }],
    },
    {
      shipId: 'jalthi',
      count: 3,
      faction: 'kilrathi',
      delay: 115,
      offset: [1200, 200, -8000],
      ace: { pilot: 'Dakhath «Deathstroke»', skillBonus: 0.38 },
      radio: [
        { speaker: 'Dakhath «Deathstroke»', text: 'この艦の最期を見に来た。逃がさん。', tone: 'enemy' },
      ],
    },
  ],
  objectives: [
    { id: 'claw', text: `${CLAW} を守り抜く`, required: true, spec: { kind: 'protect', tag: 'claw' } },
    { id: 'survive', text: '跳躍完了まで 210 秒 耐える', required: true, spec: { kind: 'survive', seconds: 210 } },
  ],
  openingRadio: [
    { speaker: '管制', text: '跳躍まで 210 秒。艦を守れ。', tone: 'command' },
  ],
  debriefWin: [
    'クローは跳んだ。全員生きている。',
    '一度は退がった。だが我々はまだ艦を持っている。反撃の準備を始める。',
  ],
  debriefLoss: [
    'クローは沈んだ。',
    'ヴェガ宙域の連邦軍は事実上消滅した。ここで物語は終わる。',
  ],
};

// ───────── 新種の任務 ─────────

/** 偵察。撃つより「見て帰る」ことが目的。小惑星帯に隠れて近づく */
const M2B_RECON: MissionDef = {
  id: 'm2b-recon',
  title: '偵察 — トール小惑星帯',
  system: 'Thor',
  briefingSpeaker: 'ハルシオン大佐',
  briefing: [
    '補給線への襲撃は続いている。奴らがどこから出てきているのかを知りたい。',
    'トール小惑星帯の奥に、キルラシーの前進拠点があるという報告がある。ドーキア級が停泊しているらしい。',
    'お前の機体には偵察カメラを積ませた。輸送艦を正面 1.2 km 以内に捉えたまま数秒保持すれば撮れる。',
    '交戦は避けろ。撮ったら帰れ。英雄になるのは今日ではない。',
    '一つ厄介なことがある。小惑星帯の中ではオートパイロットが効かない。自分の手で抜けろ。',
  ],
  playerShipId: 'hornet',
  wingman: { shipId: 'hornet', pilot: 'Spirit', skill: 0.66 },
  skybox: { nebulaHue: 0.1, planetColor: 0x5a4636, seed: 2210 },
  landmarks: [
    { kind: 'gas-giant', pos: [-16000, -3000, -26000], scale: 5200, color: 0xa5764a },
    { kind: 'derelict', pos: [2600, -600, -19000], scale: 300 },
  ],
  hazards: [
    {
      kind: 'asteroids',
      betweenNavs: [0, 1],
      count: 46,
      spread: 1500,
      rockRadius: [18, 90],
    },
    { kind: 'asteroids', atNav: 1, count: 26, spread: 1300, rockRadius: [14, 60] },
  ],
  navs: [
    { name: 'NAV 1', pos: [0, 300, -12000] },
    {
      name: 'NAV 2 (拠点)',
      pos: [-3000, -800, -23000],
      onArrive: [
        { speaker: 'Spirit', text: '見えた。停泊してる。……岩の陰から寄れ、正面から行くな。', tone: 'friendly' },
      ],
    },
    {
      name: '帰投',
      pos: [0, 0, 0],
      arriveRadius: 1400,
      onArrive: [{ speaker: '管制', text: 'フィルムを受け取る。よくやった。', tone: 'command' }],
    },
  ],
  spawns: [
    {
      shipId: 'dorkir',
      count: 2,
      faction: 'kilrathi',
      atNav: 1,
      tag: 'target',
      offset: [0, 0, -600],
      spread: 500,
      speed: 40,
    },
    {
      shipId: 'salthi',
      count: 2,
      faction: 'kilrathi',
      atNav: 1,
      delay: 26,
      offset: [2200, 500, -1800],
      radio: [{ speaker: 'Spirit', text: '哨戒に見つかった！撮り終えたらすぐ抜けるぞ。', tone: 'friendly' }],
    },
  ],
  objectives: [
    {
      id: 'photo',
      text: '停泊中の輸送艦を撮影 (正面 1.2 km 以内で保持)',
      required: true,
      spec: { kind: 'recon', tag: 'target', seconds: 5, range: 1200, coneDeg: 20 },
    },
    { id: 'home', text: 'フィルムを持ち帰る', required: true, spec: { kind: 'reachNav', navIndex: 2 } },
    { id: 'quiet', text: '一機も撃たずに帰投', required: false, spec: { kind: 'destroyAll' } },
  ],
  openingRadio: [
    { speaker: '管制', text: '偵察任務だ。撃ち合いに行くんじゃないぞ。', tone: 'command' },
    {
      speaker: 'Spirit',
      text: '岩の中は自動航行が使えない。速度を落とせ、岩は硬いぞ。',
      tone: 'friendly',
      after: 3,
    },
  ],
  debriefWin: [
    '撮れているな。ドーキア級2隻、補給ドラム、そして修理中のグラサ。前進拠点で間違いない。',
    'これで叩ける。次はお前が撃つ番だ。',
  ],
  debriefLoss: [
    'フィルムは無い。拠点の位置は依然として不明のままだ。',
    '我々は目隠しで殴り合うことになる。',
  ],
};

/** 捜索救助。撃墜された味方を拾う。守るものが動かない・撃ち返さない緊張 */
const M3B_SAR: MissionDef = {
  id: 'm3b-sar',
  title: '捜索救助 — 漂流する仲間',
  system: 'Thor',
  briefingSpeaker: 'ハルシオン大佐',
  briefing: [
    '拠点を叩いた帰り道で、第2飛行隊が待ち伏せを喰らった。3機がやられ、脱出は確認されている。',
    '脱出ポッドの信号が3つ、まだ生きている。拾いに行け。接近すれば回収装置が働く。',
    'キルラシーも同じ信号を聞いている。奴らはポッドを撃つ。急げということだ。',
    '難民船《ミルカ》も同じ宙域で足を止めている。エンジンをやられたらしい。守ってやれ。',
  ],
  playerShipId: 'scimitar',
  wingman: { shipId: 'scimitar', pilot: 'Angel', skill: 0.7 },
  skybox: { nebulaHue: 0.72, planetColor: 0x24405e, seed: 3310 },
  landmarks: [
    { kind: 'station', pos: [9000, 1200, -21000], scale: 900 },
    { kind: 'jump-gate', pos: [-12000, 2000, -30000], scale: 1400 },
  ],
  hazards: [{ kind: 'asteroids', atNav: 0, count: 22, spread: 1600, rockRadius: [16, 70] }],
  navs: [
    {
      name: 'NAV 1 (遭難宙域)',
      pos: [1500, -400, -15000],
      onArrive: [
        { speaker: 'Angel', text: 'ポッドの信号、3つとも生きてる。急ぐよ。', tone: 'friendly' },
      ],
    },
    {
      name: '帰投',
      pos: [0, 0, 0],
      arriveRadius: 1400,
      onArrive: [{ speaker: '管制', text: '医療班が待っている。着艦しろ。', tone: 'command' }],
    },
  ],
  spawns: [
    {
      shipId: 'escape-pod',
      count: 3,
      faction: 'neutral',
      atNav: 0,
      tag: 'pods',
      spread: 900,
      speed: 6,
    },
    {
      shipId: 'refugee-liner',
      count: 1,
      faction: 'neutral',
      atNav: 0,
      tag: 'liner',
      offset: [-1800, 300, 900],
      speed: 20,
    },
    {
      shipId: 'dralthi',
      count: 3,
      faction: 'kilrathi',
      atNav: 0,
      delay: 6,
      offset: [3000, 800, -2400],
      radio: [{ speaker: 'Angel', text: 'ドラルシー3機。ポッドを狙ってる、割り込んで！', tone: 'friendly' }],
    },
    {
      shipId: 'krant',
      count: 2,
      faction: 'kilrathi',
      atNav: 0,
      delay: 52,
      offset: [-2600, -900, -2800],
      radio: [{ speaker: 'Angel', text: '第2波。まだポッドが残ってる、任せて！', tone: 'friendly' }],
    },
  ],
  objectives: [
    {
      id: 'pods',
      text: '脱出ポッドを回収',
      required: true,
      spec: { kind: 'rescue', tag: 'pods', radius: 280 },
    },
    { id: 'liner', text: '難民船《ミルカ》を守る', required: true, spec: { kind: 'protect', tag: 'liner' } },
    { id: 'clear', text: '襲撃隊を排除', required: false, spec: { kind: 'destroyAll' } },
    { id: 'home', text: '帰投', required: true, spec: { kind: 'reachNav', navIndex: 1 } },
  ],
  openingRadio: [
    { speaker: '管制', text: '救助任務だ。ポッドに近づけば回収できる。', tone: 'command' },
    {
      speaker: 'Angel',
      text: 'ポッドは撃たれたら終わり。私が敵を引きつける、あなたが拾って。',
      tone: 'friendly',
      after: 3,
    },
  ],
  debriefWin: [
    '3人とも生きている。……いや、拾った数だけがだ。よくやった。',
    '拾われるかもしれないと思えるだけで、パイロットは戦える。今日お前がやったのはそれだ。',
  ],
  debriefLoss: [
    'ポッドの信号はすべて消えた。',
    '医療班は待機を解いた。明日の朝、名前が3つ壁に増える。',
  ],
};

/** 迎撃。時間制限つき。爆撃機がクローに到達する前に落とす */
const M5B_INTERCEPT: MissionDef = {
  id: 'm5b-intercept',
  title: '迎撃 — 雷撃隊を止めろ',
  system: 'Vega',
  briefingSpeaker: 'ハルシオン大佐',
  briefing: [
    '長距離レーダーがグラサの編隊を捉えた。魚雷を抱えている。狙いはクローだ。',
    '奴らが雷撃距離に入るまで 4 分。それまでに全機落とせ。1機でも通せば艦が割れる。',
    '機雷原を敷いた宙域を通ってくる。奴らは避けようとして速度を落とす。そこが狙い目だ。',
    'お前は魚雷持ちを優先しろ。護衛の戦闘機は僚機に任せていい。',
  ],
  playerShipId: 'rapier',
  playerMissiles: [
    { missileId: 'heat-seeker', count: 4 },
    { missileId: 'image-rec', count: 2 },
  ],
  wingman: { shipId: 'rapier', pilot: 'Maniac', skill: 0.76 },
  skybox: { nebulaHue: 0.02, planetColor: 0x402030, seed: 5510 },
  landmarks: [
    { kind: 'sun', pos: [22000, 6000, -26000], scale: 1600, color: 0xffd9a0 },
    { kind: 'derelict', pos: [-5000, -1400, -12000], scale: 420 },
  ],
  hazards: [
    { kind: 'minefield', atNav: 0, count: 16, spread: 1400, faction: 'confed' },
    { kind: 'asteroids', atNav: 0, count: 14, spread: 1800, rockRadius: [16, 55] },
  ],
  navs: [
    {
      name: 'NAV 1 (迎撃点)',
      pos: [0, 200, -11000],
      onArrive: [
        { speaker: 'Maniac', text: '来たぞ！魚雷を抱えたデブが5匹だ。俺は護衛をやる！', tone: 'friendly' },
      ],
    },
    {
      name: '帰投',
      pos: [0, 0, 0],
      arriveRadius: 1400,
      onArrive: [{ speaker: '管制', text: '艦は無傷だ。降りてこい。', tone: 'command' }],
    },
  ],
  spawns: [
    {
      shipId: 'gratha',
      count: 4,
      faction: 'kilrathi',
      atNav: 0,
      delay: 2,
      tag: 'bombers',
      offset: [600, 0, -3200],
      spread: 420,
      cruiseToNav: 1,
      speed: 260,
    },
    {
      shipId: 'jalthi',
      count: 2,
      faction: 'kilrathi',
      atNav: 0,
      delay: 8,
      offset: [-2200, 700, -3600],
    },
    {
      shipId: 'dralthi',
      count: 2,
      faction: 'kilrathi',
      atNav: 0,
      delay: 70,
      offset: [2600, -700, -3800],
      radio: [{ speaker: 'Maniac', text: '増援だと？ 順番待ちしてろ！', tone: 'friendly' }],
    },
  ],
  objectives: [
    {
      id: 'bombers',
      text: '雷撃機グラサを全機撃破',
      required: true,
      spec: { kind: 'destroyTag', tag: 'bombers' },
    },
    { id: 'limit', text: '雷撃開始まで', required: true, spec: { kind: 'timeLimit', seconds: 240 } },
    { id: 'home', text: '帰投', required: true, spec: { kind: 'reachNav', navIndex: 1 } },
  ],
  openingRadio: [
    { speaker: '管制', text: '迎撃発艦。制限時間は 4 分だ。', tone: 'command' },
    {
      speaker: 'Maniac',
      text: '機雷は味方が敷いた分だ、俺たちには反応しない。猫だけが踏む。',
      tone: 'friendly',
      after: 3,
    },
  ],
  debriefWin: [
    '雷撃隊は全滅。魚雷は1本も飛んでこなかった。',
    '艦の乗員2000人は、お前が何をしたかを知らないまま今夜も眠る。それでいい。',
  ],
  debriefLoss: [
    '魚雷が装甲帯を抜けた。格納庫が燃えている。',
    'クローは戦えるが、以前と同じようには戦えない。',
  ],
};

export const MISSIONS: Record<string, MissionDef> = {
  [M1_PATROL.id]: M1_PATROL,
  [M2_ESCORT.id]: M2_ESCORT,
  [M2B_RECON.id]: M2B_RECON,
  [M3_STRIKE.id]: M3_STRIKE,
  [M3B_SAR.id]: M3B_SAR,
  [M4_DEFEND.id]: M4_DEFEND,
  [M5_ACE.id]: M5_ACE,
  [M5B_INTERCEPT.id]: M5B_INTERCEPT,
  [M6_FLAGSHIP.id]: M6_FLAGSHIP,
  [L1_RETREAT.id]: L1_RETREAT,
  [L2_LAST_STAND.id]: L2_LAST_STAND,
};

export function missionDef(id: string): MissionDef {
  const m = MISSIONS[id];
  if (!m) throw new Error(`unknown mission: ${id}`);
  return m;
}
