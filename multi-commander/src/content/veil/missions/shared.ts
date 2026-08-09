/**
 * 十章ミッションの共通定義。
 *
 * 章ごとのファイル（`ch01.ts`〜`ch10.ts`）は、場所の見た目とタグ名をここから取る。
 * 同じ戦域が複数の章に出るため（ヴェガ門は第2・9・10章、公証中継所は第7・8章）、
 * 「同じ場所は同じ景色に見える」ことをデータで保証する。
 *
 * 出典: 世界観_歴史仕様.html §02（航路概念図）／ストーリー_十章作戦記録.html 各章の戦術マップ。
 */

import type { LandmarkDef } from '../../../render/Landmarks';
import type { SkyboxOptions } from '../../../render/Starfield';
import { veilPerson } from '../people';
import type { VeilTheaterId } from '../world';

/**
 * 無線・ブリーフィングに出す話者名を人物名簿から取る。
 *
 * 名簿の表記は2種類ある。
 *   - 英字表記 + 読み: 'William Hart（ウィリアム・ハート）' → 'ウィリアム・ハート'
 *   - 日本語表記 + 読み: '小林 直子（コバヤシ ナオコ）' → '小林 直子'
 * どちらも「日本語で表示したい形」を返す。括弧の中を無条件に採ると、
 * 日本人がカタカナ読みで無線に出てしまうので、括弧の前が英字かどうかで分岐する。
 *
 * 話者名の文字列を章側に二重定義しないため、必ずこの関数を通す。
 */
export function speakerName(personId: string): string {
  const name = veilPerson(personId).name;
  const paren = /^(.*?)（([^）]+)）$/.exec(name);
  if (!paren) return name;
  return /[A-Za-z]/.test(paren[1]) ? paren[2] : paren[1];
}

/** 母艦。ブリーフィングと無線の呼称に使う */
export const CLAW = 'TCS タイガーズ・クロー';

/** 管制の呼称 */
export const CONTROL = '管制';

/**
 * ミッション目標から参照するタグ名。
 *
 * 文字列を各章で直接書くと綴り違いで目標が成立しなくなるため、ここに集約する。
 */
export const TAG = {
  /** 護衛・保護する対象（輸送船、避難船、契約船、灯台など） */
  escort: 'escort',
  /** 回収する対象（救難ポッド、漂流者、乗員） */
  rescue: 'rescue',
  /** 撃破すべき主対象 */
  target: 'target',
  /** 主対象の護衛 */
  guard: 'guard',
  /** 旗艦・拠点 */
  capital: 'capital',
  /** 誓約を破る側（急進派の分艦隊） */
  radical: 'radical',
  /** 通信灯台（第8章） */
  beacon: 'beacon',
  /** 偽装信号を返す無人機（第2章） */
  decoy: 'decoy',
  /** 他勢力の援護（セレシオン／オルド／ニューロウム） */
  support: 'support',
  /** 撮影・観測する対象（採掘記録、中継器など） */
  survey: 'survey',
} as const;

/** 戦域ごとの遠景。同じ戦域なら同じ景色になるよう、章から参照する */
export const THEATER_SKYBOX: Record<VeilTheaterId, SkyboxOptions> = {
  // オリオン港。連邦の前進基地。避難民輸送の渋滞空域なので、明るい主星と居住可能惑星を置く
  'orion-port': {
    nebulaHue: 0.56,
    planetColor: 0x2a4a72,
    seed: 5101,
    planetTexture: 'planet-earthlike',
    nebulae: ['nebula-teal', 'nebula-dust'],
  },
  // ヴェガ門。古代中継門。稼働が不安定なので、冷たい光と青い星雲で「開きかけている」空にする
  'vega-gate': {
    nebulaHue: 0.62,
    planetColor: 0x16304f,
    seed: 5102,
    planetTexture: 'planet-ice',
    nebulae: ['nebula-teal', 'nebula-violet'],
    sunColor: 0xbfe4ff,
  },
  // 灰冠回廊。キルラシー圏。灰と血の色を主調にする
  'ashcrown-corridor': {
    nebulaHue: 0.02,
    planetColor: 0x4a2630,
    seed: 5103,
    planetTexture: 'planet-rock',
    nebulae: ['nebula-crimson', 'nebula-dust'],
    sunColor: 0xffb0a0,
  },
  // ラグランジュ裂谷。現在の交戦線。事故跡なので濁った塵の空
  'lagrange-rift': {
    nebulaHue: 0.1,
    planetColor: 0x3a3630,
    seed: 5104,
    planetTexture: 'planet-lava',
    nebulae: ['nebula-dust', 'nebula-crimson'],
  },
  // 静穏海。セレシオンの中立回廊。淡い発光と緑の星雲
  'quiet-sea': {
    nebulaHue: 0.38,
    planetColor: 0x1c4a44,
    seed: 5105,
    planetTexture: 'planet-gas-violet',
    nebulae: ['nebula-teal'],
    sunColor: 0xcaffe8,
  },
  // 深層採掘帯。オルド圏。岩と金色の鉱脈
  'deep-mining-belt': {
    nebulaHue: 0.12,
    planetColor: 0x53431f,
    seed: 5106,
    planetTexture: 'planet-rock',
    nebulae: ['nebula-dust'],
    sunColor: 0xffd9a0,
  },
  // 巣脈群。ニューロウムの中継器群。紫の通信網
  'hive-veins': {
    nebulaHue: 0.78,
    planetColor: 0x342459,
    seed: 5107,
    planetTexture: 'planet-gas-violet',
    nebulae: ['nebula-violet', 'nebula-dust'],
    sunColor: 0xd8c0ff,
  },
  // ヴェガ門公証中継所。五者協定の共同設備。門と同じ空だが、設備の光が加わる
  'notary-relay': {
    nebulaHue: 0.6,
    planetColor: 0x1a3550,
    seed: 5108,
    planetTexture: 'planet-ice',
    nebulae: ['nebula-teal', 'nebula-violet'],
    sunColor: 0xbfe4ff,
  },
};

/**
 * 戦域ごとの巨大構造物。
 * 当たり判定を持たないので、航路から外した位置に置く。
 */
export const THEATER_LANDMARKS: Record<VeilTheaterId, LandmarkDef[]> = {
  'orion-port': [
    { kind: 'station', pos: [-5200, -700, -6400], scale: 1400 },
    { kind: 'gas-giant', pos: [17000, 3000, -34000], scale: 4600, texture: 'planet-earthlike' },
  ],
  'vega-gate': [
    // ヴェイル門そのもの。人類より古い中継門
    { kind: 'jump-gate', pos: [0, 800, -36000], scale: 3200 },
    { kind: 'derelict', pos: [6200, -1100, -18000], scale: 420 },
  ],
  'ashcrown-corridor': [
    { kind: 'gas-giant', pos: [-16000, -2400, -31000], scale: 5200, texture: 'planet-rock' },
    { kind: 'station', pos: [8600, 1200, -12000], scale: 900 },
  ],
  'lagrange-rift': [
    { kind: 'derelict', pos: [-3200, 600, -15000], scale: 900 },
    { kind: 'jump-gate', pos: [11000, -1400, -29000], scale: 1800 },
  ],
  'quiet-sea': [
    // セレシオンの気嚢船団。移動都市なので大きく置く
    { kind: 'station', pos: [-9000, 1600, -20000], scale: 2400 },
    { kind: 'gas-giant', pos: [15000, -2000, -33000], scale: 4200, texture: 'planet-gas-violet' },
  ],
  'deep-mining-belt': [
    { kind: 'gas-giant', pos: [-13000, -1800, -26000], scale: 6000, texture: 'planet-rock' },
    { kind: 'derelict', pos: [3400, 900, -11000], scale: 520 },
  ],
  'hive-veins': [
    { kind: 'station', pos: [4800, -1300, -17000], scale: 1800 },
    { kind: 'gas-giant', pos: [-15000, 2600, -32000], scale: 4800, texture: 'planet-gas-violet' },
  ],
  'notary-relay': [
    // 公証中継所（五者協定の共同設備）と、その先にあるヴェガ門
    { kind: 'station', pos: [0, 0, -30000], scale: 2200 },
    { kind: 'jump-gate', pos: [-9000, 1400, -38000], scale: 2800 },
  ],
};

/** 章の戦域から遠景と構造物をまとめて取る */
export function theaterScenery(id: VeilTheaterId): { skybox: SkyboxOptions; landmarks: LandmarkDef[] } {
  return { skybox: THEATER_SKYBOX[id], landmarks: THEATER_LANDMARKS[id] };
}
