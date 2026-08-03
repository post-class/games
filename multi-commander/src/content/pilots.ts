/**
 * パイロット名簿の定義。
 *
 * 僚機を「名前と技量パラメータ」から「人」にするためのデータ。
 * 性格は飛び方 (AI) と無線の口調の両方に効く。
 */

export type PersonalityId = 'reckless' | 'steady' | 'precise' | 'veteran' | 'grim' | 'green';

export interface Personality {
  id: PersonalityId;
  label: string;
  /**
   * 命令への従順さ 0..1。
   * 低いと「編隊」指令を無視して勝手に交戦する。
   */
  obedience: number;
  /**
   * 攻撃性 0..1。
   * 高いと遠くの敵にも突っ込み、深追いする。
   */
  aggression: number;
  /**
   * 慎重さ 0..1。
   * 高いと回避機動を早めに入れ、無理な射撃をしない。
   */
  caution: number;
  /**
   * 粘り 0..1。
   * 高いと損傷しても士気が折れにくい。
   */
  grit: number;
  /** 経験で技量が伸びる速さ */
  growth: number;
}

export const PERSONALITIES: Record<PersonalityId, Personality> = {
  reckless: {
    id: 'reckless',
    label: '無鉄砲',
    obedience: 0.2,
    aggression: 0.95,
    caution: 0.15,
    grit: 0.8,
    growth: 0.8,
  },
  steady: {
    id: 'steady',
    label: '堅実',
    obedience: 0.9,
    aggression: 0.5,
    caution: 0.6,
    grit: 0.7,
    growth: 1.0,
  },
  precise: {
    id: 'precise',
    label: '冷静',
    obedience: 0.85,
    aggression: 0.6,
    caution: 0.55,
    grit: 0.85,
    growth: 0.9,
  },
  veteran: {
    id: 'veteran',
    label: '老練',
    obedience: 0.75,
    aggression: 0.55,
    caution: 0.7,
    grit: 0.95,
    growth: 0.4,
  },
  grim: {
    id: 'grim',
    label: '厭世',
    obedience: 0.8,
    aggression: 0.3,
    caution: 0.9,
    grit: 0.5,
    growth: 0.7,
  },
  green: {
    id: 'green',
    label: '新兵',
    obedience: 0.95,
    aggression: 0.4,
    caution: 0.35,
    grit: 0.4,
    growth: 1.6,
  },
};

/** 顔の描き分けに使うパラメータ (SVG ポートレートの生成に渡す) */
export interface PortraitSpec {
  skin: string;
  hair: string;
  /** 髪型 */
  hairStyle: 'short' | 'long' | 'buzz' | 'bald' | 'tied';
  /** 目つき */
  eyes: 'normal' | 'sharp' | 'tired' | 'wide';
  /** 特徴 */
  marks?: Array<'scar' | 'stubble' | 'visor' | 'bandana'>;
}

export interface PilotDef {
  id: string;
  /** 無線に出る呼び名 */
  callsign: string;
  /** 本名 */
  name: string;
  personality: PersonalityId;
  /** 初期技量 0..1 */
  skill: number;
  /** 好んで乗る機体 (在庫にあれば) */
  preferredShip: string;
  /** 紹介文 (名簿と酒場で使う) */
  bio: string;
  portrait: PortraitSpec;
}

/**
 * 飛行隊の名簿。
 * Spirit / Maniac / Angel は既に無線台詞で使っていたので踏襲し、
 * 残りはこの作品用に用意した。
 */
export const PILOTS: PilotDef[] = [
  {
    id: 'spirit',
    callsign: 'Spirit',
    name: '田中 真理子',
    personality: 'steady',
    skill: 0.62,
    preferredShip: 'hornet',
    bio: '指示に忠実で、決して持ち場を離れない。故郷に婚約者がいるという噂がある。',
    portrait: { skin: '#e7c9a4', hair: '#2b2119', hairStyle: 'tied', eyes: 'normal' },
  },
  {
    id: 'maniac',
    callsign: 'Maniac',
    name: 'Todd Marsh',
    personality: 'reckless',
    skill: 0.7,
    preferredShip: 'scimitar',
    bio: '腕はある。命令は聞かない。「編隊を組め」と言った次の秒に単独で突っ込んでいる。',
    portrait: { skin: '#f0d3ae', hair: '#8a5a2b', hairStyle: 'short', eyes: 'wide', marks: ['stubble'] },
  },
  {
    id: 'angel',
    callsign: 'Angel',
    name: 'Jeanne Duval',
    personality: 'precise',
    skill: 0.8,
    preferredShip: 'rapier',
    bio: '無駄弾を撃たない。指示は簡潔で、状況判断が早い。飛行隊で最も信頼されている。',
    portrait: { skin: '#f2dcc4', hair: '#c9a227', hairStyle: 'long', eyes: 'sharp' },
  },
  {
    id: 'tinman',
    callsign: 'Tinman',
    name: 'Peter Kowalczyk',
    personality: 'veteran',
    skill: 0.76,
    preferredShip: 'raptor',
    bio: '三度撃墜されて三度帰ってきた。「機体は替えが効く。お前は効かない」が口癖。',
    portrait: { skin: '#c99b72', hair: '#3a3a3a', hairStyle: 'buzz', eyes: 'tired', marks: ['scar'] },
  },
  {
    id: 'cricket',
    callsign: 'Cricket',
    name: 'Amara Osei',
    personality: 'green',
    skill: 0.38,
    preferredShip: 'hornet',
    bio: '士官学校を出たばかり。よく喋る。まだ誰も撃墜していない。',
    portrait: { skin: '#8a5b3a', hair: '#191919', hairStyle: 'short', eyes: 'wide' },
  },
  {
    id: 'padre',
    callsign: 'Padre',
    name: 'Tomás Rivas',
    personality: 'grim',
    skill: 0.66,
    preferredShip: 'scimitar',
    bio: '出撃前に必ず祈る。戦死者の名前を全員覚えている。それが重荷になっている。',
    portrait: { skin: '#d9ab80', hair: '#2a2a2a', hairStyle: 'short', eyes: 'tired', marks: ['stubble'] },
  },
  {
    id: 'slate',
    callsign: 'Slate',
    name: 'Yuri Beklemishev',
    personality: 'precise',
    skill: 0.72,
    preferredShip: 'rapier',
    bio: '無口。報告は数字だけ。だが射撃は正確で、指示された的を確実に減らす。',
    portrait: { skin: '#e8cdb0', hair: '#6b6b6b', hairStyle: 'short', eyes: 'sharp', marks: ['visor'] },
  },
  {
    id: 'nomad',
    callsign: 'Nomad',
    name: 'Kaia Tuisamoa',
    personality: 'reckless',
    skill: 0.6,
    preferredShip: 'hornet',
    bio: '所属を三度変えている。腕は荒いが度胸がある。深追いの癖が直らない。',
    portrait: { skin: '#a9744c', hair: '#1c1c1c', hairStyle: 'long', eyes: 'sharp', marks: ['bandana'] },
  },
];

export function pilotDef(id: string): PilotDef {
  const p = PILOTS.find((x) => x.id === id);
  if (!p) throw new Error(`unknown pilot: ${id}`);
  return p;
}

export function personalityOf(id: string): Personality {
  return PERSONALITIES[pilotDef(id).personality];
}

/** 出撃可能な初期メンバー (キャンペーン開始時の飛行隊) */
export const STARTING_SQUADRON = ['spirit', 'maniac', 'angel', 'tinman', 'padre'];

/** 補充で来る候補 (戦死者が出たときに順に配属される) */
export const REPLACEMENT_POOL = ['cricket', 'slate', 'nomad'];
