/**
 * パイロット名簿の定義。
 *
 * 僚機を「名前と技量パラメータ」から「人」にするためのデータ。
 * 性格は飛び方 (AI) と無線の口調の両方に効く。
 *
 * ■ 人物の出所（T2-2）
 * 名前・二つ名・戦闘級は `src/content/veil/people.ts`（THE VEIL FRONT 人物名簿）が単一の出所。
 * ここでは `personId` で人物を参照し、表示名 (`name`) と無線の呼び名 (`callsign`) は
 * 人物名簿の `name` / `epithet` をそのまま使う（複製しない）。
 * 技量 (`skill`) も戦闘級から `skillFromGrade()` で一意に決め、ハードコードしない。
 * このファイルが独自に持つのは、ゲーム側の都合で決まる値だけ（性格・好みの機体・SVGの顔）。
 */

import { skillFromGrade, veilPerson, type VeilPerson } from './veil/people';

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
  /** 人物名簿 (`src/content/veil/people.ts`) の id。名前・二つ名・戦闘級の出所。 */
  personId: string;
  /** 無線に出る呼び名。人物名簿の `epithet`。 */
  callsign: string;
  /** 本名。人物名簿の `name`。 */
  name: string;
  personality: PersonalityId;
  /** 初期技量 0..1。人物の戦闘級から `skillFromGrade()` で導出する。 */
  skill: number;
  /** 好んで乗る機体 (在庫にあれば) */
  preferredShip: string;
  /** 紹介文 (名簿と酒場で使う)。人物名簿の役割・実績から組み立てる。 */
  bio: string;
  portrait: PortraitSpec;
  /**
   * 顔画像 (`public/art/tex/face-<id>-<表情>.jpg`) の id。
   * 人物名簿の id と同一（肖像は人物単位で用意されている）。
   */
  faceId: string;
}

/** 名簿1名分の、ゲーム側だけで決まる値。 */
interface PilotSeed {
  id: string;
  /** 人物名簿の id */
  personId: string;
  personality: PersonalityId;
  preferredShip: string;
  /** 性格の一言。人物名簿の役割・実績のあとに足す。 */
  note: string;
  portrait: PortraitSpec;
}

/**
 * 飛行隊の名簿（8名）。
 *
 * アウレリア連邦の人物名簿から、僚機として飛ぶ役割の8名を選んでいる。
 * 主人公候補5名 (`confed-01`〜`-05`) はプレイヤーが操縦する側なので、ここには入れない。
 * id は人物の二つ名 (`epithet`) を小文字にしたもの。
 */
const PILOT_SEEDS: readonly PilotSeed[] = [
  {
    id: 'sable',
    personId: 'confed-17', // 桐谷 綾 / Sable / 近接護衛パイロット / S級
    personality: 'steady',
    preferredShip: 'hornet',
    note: '持ち場を離れない。守る相手を決めたら、そこから動かない。',
    portrait: { skin: '#e7c9a4', hair: '#2b2119', hairStyle: 'tied', eyes: 'normal' },
  },
  {
    id: 'tempest',
    personId: 'confed-25', // 榊 恒一 / Tempest / 突撃艇隊長 / S級
    personality: 'reckless',
    preferredShip: 'scimitar',
    note: '封鎖線は突き破るものだと思っている。「編隊を組め」の次の秒には前に出ている。',
    portrait: { skin: '#f0d3ae', hair: '#2f2318', hairStyle: 'short', eyes: 'wide', marks: ['stubble'] },
  },
  {
    id: 'orion',
    personId: 'confed-23', // 橘 蒼真 / Orion / 長距離迎撃士 / S級
    personality: 'precise',
    preferredShip: 'rapier',
    note: '無駄弾を撃たない。報告は距離と数だけで、余計なことを言わない。',
    portrait: { skin: '#e8cdb0', hair: '#3b4a5a', hairStyle: 'short', eyes: 'sharp', marks: ['visor'] },
  },
  {
    id: 'aster',
    personId: 'confed-18', // 黒瀬 日和 / Aster / 戦術解析官 / A級
    personality: 'veteran',
    preferredShip: 'raptor',
    note: '伏撃を先に見つける癖がある。「機体は替えが効く。お前は効かない」が口癖。',
    portrait: { skin: '#dfbe98', hair: '#4a4a4a', hairStyle: 'tied', eyes: 'tired', marks: ['scar'] },
  },
  {
    id: 'vesper',
    personId: 'confed-15', // 柊 奏 / Vesper / 電子戦操縦士 / S級
    personality: 'grim',
    preferredShip: 'rapier',
    note: '撃つより先に敵の目を潰す。誰が帰ってこなかったかを、全員覚えている。',
    portrait: { skin: '#f2dcc4', hair: '#1f2a33', hairStyle: 'long', eyes: 'tired' },
  },
  {
    id: 'nova',
    personId: 'confed-20', // 東雲 澪 / Nova / 偵察飛行士 / S級
    personality: 'precise',
    preferredShip: 'hornet',
    note: '単独行動に慣れている。状況判断が早く、指示が簡潔。',
    portrait: { skin: '#f0d6ba', hair: '#7a5a2b', hairStyle: 'short', eyes: 'sharp' },
  },
  {
    id: 'raven',
    personId: 'confed-26', // 藤堂 悠真 / Raven / 艦載機パイロット / A級
    personality: 'reckless',
    preferredShip: 'hornet',
    note: '囮役を自分から引き受ける。深追いの癖が直らない。',
    portrait: { skin: '#c99b72', hair: '#1c1c1c', hairStyle: 'buzz', eyes: 'sharp', marks: ['bandana'] },
  },
  {
    id: 'solace',
    personId: 'confed-28', // 久世 朔 / Solace / 救難艇操縦士 / A級
    personality: 'green',
    preferredShip: 'hornet',
    note: '救助の腕は確かだが、空戦は数えるほどしかしていない。よく喋る。',
    portrait: { skin: '#d9ab80', hair: '#2a2a2a', hairStyle: 'short', eyes: 'wide' },
  },
];

function buildPilot(seed: PilotSeed): PilotDef {
  const person = veilPerson(seed.personId);
  return {
    id: seed.id,
    personId: person.id,
    // 表示名は人物名簿の値をそのまま使う (このファイルでは複製しない)
    callsign: person.epithet,
    name: person.name,
    personality: seed.personality,
    // 技量は戦闘級から一意に決まる
    skill: skillFromGrade(person.grade),
    preferredShip: seed.preferredShip,
    bio: `${person.role}。${person.achievement}${seed.note}`,
    portrait: seed.portrait,
    // 肖像は人物単位で用意されているので、顔画像id は人物id をそのまま使う
    faceId: person.id,
  };
}

/** 飛行隊の名簿。 */
export const PILOTS: PilotDef[] = PILOT_SEEDS.map(buildPilot);

export function pilotDef(id: string): PilotDef {
  const p = PILOTS.find((x) => x.id === id);
  if (!p) throw new Error(`unknown pilot: ${id}`);
  return p;
}

/** そのパイロットの人物名簿エントリ。 */
export function pilotPerson(id: string): VeilPerson {
  return veilPerson(pilotDef(id).personId);
}

/**
 * 顔画像に使う id。
 * TODO(T2-6): 新人物の肖像を用意したら、この暫定マッピングを外して id をそのまま使う。
 */
export function pilotFaceId(id: string): string {
  const p = PILOTS.find((x) => x.id === id);
  return p ? p.faceId : id;
}

export function personalityOf(id: string): Personality {
  return PERSONALITIES[pilotDef(id).personality];
}

/** 出撃可能な初期メンバー (キャンペーン開始時の飛行隊) */
export const STARTING_SQUADRON = ['sable', 'tempest', 'orion', 'aster', 'vesper'];

/** 補充で来る候補 (戦死者が出たときに順に配属される) */
export const REPLACEMENT_POOL = ['nova', 'raven', 'solace'];
