import type { PetAction } from './actions.js';
import type { TraitKey } from './personality.js';
import type { NeedKey } from './types.js';

/**
 * ペットが暮らす「広いマップ」の定義。
 *
 * 以前は 1 部屋・横位置だけの世界で、ペットは同じ床を往復するしかなかった。
 * それだと行動の種類を増やしても「同じ場所で別のポーズを取る」だけになり、
 * 見ていて面白くならない（プレイテストで最初に言われた不満がこれ）。
 *
 * そこで世界を横長の 6 ゾーンに広げ、各ゾーンに**興味スポット**を置いた。
 * ペットは「どのスポットへ行くか」を自分で選んで移動し、その場所ならではの
 * 行動をする。行動が場所と結びつくので、画面を見ているだけで物語が読める。
 *
 * この定義はクライアント（描画・自律行動）とサーバ（プロンプト・留守レポート）の
 * 両方から参照するので shared に置く。座標は完全に決定論的でテストできる。
 */

export const ZONE_IDS = ['bedroom', 'kitchen', 'living', 'bath', 'garden', 'hill'] as const;
export type ZoneId = (typeof ZONE_IDS)[number];

export interface Zone {
  id: ZoneId;
  /** 画面に出す名前。 */
  name: string;
  /** 横幅の比率（合計で世界の幅になる）。 */
  span: number;
  /** 屋内かどうか。屋外は空を描き、臆病な子は行きたがらない。 */
  indoor: boolean;
  /** 壁（屋内）または空（屋外）の色。 */
  back: [string, string];
  /** 床または地面の色。 */
  ground: [string, string];
}

export const ZONES: Zone[] = [
  {
    id: 'bedroom',
    name: 'ねむりべや',
    span: 1.0,
    indoor: true,
    back: ['#efe6f6', '#ddcfea'],
    ground: ['#d9c3a6', '#c2a582'],
  },
  {
    id: 'kitchen',
    name: 'だいどころ',
    span: 1.0,
    indoor: true,
    back: ['#fdf0dc', '#f3ddb8'],
    ground: ['#e9e6ee', '#d2cedd'],
  },
  {
    id: 'living',
    name: 'リビング',
    span: 1.4,
    indoor: true,
    back: ['#fdf3df', '#f6e6c5'],
    ground: ['#e0bd90', '#c99b6a'],
  },
  {
    id: 'bath',
    name: 'みずば',
    span: 0.9,
    indoor: true,
    back: ['#e2f2f8', '#c4e4ef'],
    ground: ['#e5eef2', '#cbdbe3'],
  },
  {
    id: 'garden',
    name: 'にわ',
    span: 1.6,
    indoor: false,
    back: ['#bfe6f7', '#e6f4fb'],
    ground: ['#a9d47c', '#8bbe61'],
  },
  {
    id: 'hill',
    name: 'おかのうえ',
    span: 1.3,
    indoor: false,
    back: ['#a9dcf5', '#dff0fa'],
    ground: ['#9ecd76', '#7fb257'],
  },
];

/** 世界の幅は「画面いくつぶん」か。描画側でカメラの移動量に使う。 */
export const WORLD_SCREENS = 4.6;

const TOTAL_SPAN = ZONES.reduce((sum, zone) => sum + zone.span, 0);

export interface ZoneRange {
  zone: Zone;
  /** 世界座標（0〜1）での左端と右端。 */
  from: number;
  to: number;
}

/** 各ゾーンの世界座標の範囲。span の比率をそのまま 0〜1 に割り当てる。 */
export const ZONE_RANGES: ZoneRange[] = (() => {
  const out: ZoneRange[] = [];
  let cursor = 0;
  for (const zone of ZONES) {
    const width = zone.span / TOTAL_SPAN;
    out.push({ zone, from: cursor, to: cursor + width });
    cursor += width;
  }
  // 端数を吸収して必ず 1 で終わらせる（カメラのクランプが 1 を前提にしている）。
  if (out.length) out[out.length - 1].to = 1;
  return out;
})();

export function zoneAt(worldX: number): Zone {
  for (const range of ZONE_RANGES) {
    if (worldX < range.to) return range.zone;
  }
  return ZONES[ZONES.length - 1];
}

export function findZone(id: string): Zone | undefined {
  return ZONES.find((zone) => zone.id === id);
}

export function zoneRange(id: ZoneId): ZoneRange {
  const found = ZONE_RANGES.find((range) => range.zone.id === id);
  if (!found) throw new Error(`unknown zone: ${id}`);
  return found;
}

/** ゾーン内の相対位置（0〜1）を世界座標に直す。 */
export function zonePoint(id: ZoneId, t: number): number {
  const range = zoneRange(id);
  return range.from + (range.to - range.from) * Math.max(0, Math.min(1, t));
}

/** スポットの見た目の種類。描画側がこれで絵を切り替える。 */
export type SpotArt =
  | 'bed'
  | 'cushion'
  | 'lamp'
  | 'bowl'
  | 'fridge'
  | 'shelf'
  | 'toybox'
  | 'window'
  | 'door'
  | 'tub'
  | 'mirror'
  | 'flowerbed'
  | 'dirt'
  | 'puddle'
  | 'butterfly'
  | 'mailbox'
  | 'tree'
  | 'bench'
  | 'birdnest'
  | 'starspot';

export interface Spot {
  id: string;
  zone: ZoneId;
  /** 画面に出す名前（「にわの みずたまり」のように使う）。 */
  name: string;
  art: SpotArt;
  /** 世界座標（0〜1）。 */
  x: number;
  /** 床の奥行き（0 = 奥、1 = 手前）。 */
  depth: number;
  /** ここに着いたときにする行動。ひとつ抽選する。 */
  actions: PetAction[];
  /** 何もなくても選ばれる素点。 */
  base: number;
  /** このニーズが低いほど強く引かれる。 */
  serves?: NeedKey;
  /** 性格の効き（値は重みへの加算。負も可）。 */
  traits?: Partial<Record<TraitKey, number>>;
  /** 昼だけ／夜だけのスポット。 */
  time?: 'day' | 'night';
  /** ここで起きる小さな発見。ログに流して「勝手に何かしている」感を出す。 */
  finds?: string[];
}

/**
 * 興味スポット。
 *
 * 「ニーズを満たす場所」と「ニーズには関係ないが性格が出る場所」を混ぜてある。
 * 後者がないと、満たされているペットが動かなくなって退屈になる。
 */
export const SPOTS: Spot[] = [
  // --- ねむりべや ---
  {
    id: 'bed',
    zone: 'bedroom',
    name: 'ベッド',
    art: 'bed',
    x: zonePoint('bedroom', 0.35),
    depth: 0.25,
    actions: ['nap', 'roll_around', 'stretch'],
    base: 0.6,
    serves: 'energy',
    traits: { energy: -0.8 },
    finds: ['ベッドの下に まえに かくした ボールが あった。'],
  },
  {
    id: 'cushion',
    zone: 'bedroom',
    name: 'クッション',
    art: 'cushion',
    x: zonePoint('bedroom', 0.75),
    depth: 0.7,
    actions: ['nap', 'daydream', 'roll_around'],
    base: 0.8,
    traits: { clingy: 0.9, clever: 0.5 },
    finds: ['クッションに ごしゅじんの においが のこっていた。'],
  },
  {
    id: 'nightlight',
    zone: 'bedroom',
    name: 'よるのランプ',
    art: 'lamp',
    x: zonePoint('bedroom', 0.08),
    depth: 0.15,
    actions: ['daydream', 'stretch'],
    base: 0.5,
    time: 'night',
    traits: { timid: 1.0, clever: 0.4 },
    finds: ['ランプの あかりに 小さな 虫が あつまっていた。'],
  },

  // --- だいどころ ---
  {
    id: 'bowl',
    zone: 'kitchen',
    name: 'ごはんの おさら',
    art: 'bowl',
    x: zonePoint('kitchen', 0.3),
    depth: 0.75,
    actions: ['eat', 'stare_owner'],
    base: 0.4,
    serves: 'hunger',
    traits: { gluttony: 1.4 },
    finds: ['おさらの すみに ごはんの つぶが ひとつ のこっていた。'],
  },
  {
    id: 'fridge',
    zone: 'kitchen',
    name: 'れいぞうこ',
    art: 'fridge',
    x: zonePoint('kitchen', 0.68),
    depth: 0.2,
    actions: ['stare_owner', 'hide_item', 'stretch'],
    base: 0.5,
    serves: 'hunger',
    traits: { gluttony: 1.2, mischief: 0.8 },
    finds: ['れいぞうこの うらは あたたかい、と おぼえたようだ。'],
  },
  {
    id: 'pantry',
    zone: 'kitchen',
    name: 'おかしの たな',
    art: 'shelf',
    x: zonePoint('kitchen', 0.92),
    depth: 0.5,
    actions: ['hide_item', 'stretch', 'daydream'],
    base: 0.45,
    traits: { mischief: 1.3, gluttony: 0.7, timid: -0.4 },
    finds: ['たなの おくに おかしの ふくろを かくした。'],
  },

  // --- リビング（家具エディタの家具はここに置かれる） ---
  {
    id: 'toybox',
    zone: 'living',
    name: 'おもちゃばこ',
    art: 'toybox',
    x: zonePoint('living', 0.22),
    depth: 0.72,
    actions: ['play', 'hide_item', 'jump_joy'],
    base: 0.6,
    serves: 'fun',
    traits: { energy: 1.0, mischief: 0.6 },
    finds: ['おもちゃばこを ひっくり返して、ひとりで あそんでいた。'],
  },
  {
    id: 'window',
    zone: 'living',
    name: 'まるまど',
    art: 'window',
    x: zonePoint('living', 0.55),
    depth: 0.12,
    actions: ['peek_window', 'daydream', 'sing'],
    base: 0.8,
    traits: { social: 1.2, timid: -0.9, clever: 0.4 },
    finds: [
      '窓のそとを 知らない ねこが 通っていった。',
      '窓ガラスに うつった 自分に 話しかけていた。',
    ],
  },
  {
    id: 'rug',
    zone: 'living',
    name: 'ラグの うえ',
    art: 'cushion',
    x: zonePoint('living', 0.78),
    depth: 0.85,
    actions: ['tidy_room', 'roll_around', 'dance', 'nap'],
    base: 0.9,
    traits: { energy: 0.4 },
    finds: ['ラグの けばだちを 前あしで ならしていた。'],
  },
  {
    id: 'frontdoor',
    zone: 'living',
    name: 'げんかん',
    art: 'door',
    x: zonePoint('living', 0.95),
    depth: 0.35,
    actions: ['stare_owner', 'sulk_corner', 'nuzzle'],
    base: 0.5,
    serves: 'mood',
    traits: { clingy: 1.5 },
    finds: ['ドアの まえで しばらく 耳を たてて 待っていた。'],
  },

  // --- みずば ---
  {
    id: 'tub',
    zone: 'bath',
    name: 'たらい',
    art: 'tub',
    x: zonePoint('bath', 0.35),
    depth: 0.6,
    actions: ['wash', 'stretch'],
    base: 0.4,
    serves: 'clean',
    traits: { timid: -0.5 },
    finds: ['たらいの 水に うつった 自分に おどろいていた。'],
  },
  {
    id: 'mirror',
    zone: 'bath',
    name: 'かがみ',
    art: 'mirror',
    x: zonePoint('bath', 0.75),
    depth: 0.15,
    actions: ['dance', 'wash', 'stretch'],
    base: 0.5,
    traits: { willful: 0.8, social: 0.5 },
    finds: ['かがみの まえで しばらく ポーズを 決めていた。'],
  },

  // --- にわ ---
  {
    id: 'flowerbed',
    zone: 'garden',
    name: 'はなだん',
    art: 'flowerbed',
    x: zonePoint('garden', 0.16),
    depth: 0.3,
    actions: ['sniff_flower', 'sunbathe', 'sing'],
    base: 0.9,
    traits: { timid: -0.3, clever: 0.3 },
    finds: [
      'はなだんで きいろい花が ひとつ 咲いているのを 見つけた。',
      'はなの においを かいで、くしゃみを していた。',
    ],
  },
  {
    id: 'dirt',
    zone: 'garden',
    name: 'つちの ところ',
    art: 'dirt',
    x: zonePoint('garden', 0.4),
    depth: 0.78,
    actions: ['dig', 'bury_treasure'],
    base: 0.8,
    traits: { mischief: 1.2, energy: 0.6, timid: -0.5 },
    finds: [
      'つちを ほったら、ひかる 石を 見つけた。',
      'ほった あなに たいせつな ものを うめて、上を ふみかためていた。',
      'つちの なかから だんごむしが 出てきて、飛びのいていた。',
    ],
  },
  {
    id: 'puddle',
    zone: 'garden',
    name: 'みずたまり',
    art: 'puddle',
    x: zonePoint('garden', 0.6),
    depth: 0.88,
    actions: ['splash_puddle', 'wash'],
    base: 0.6,
    serves: 'clean',
    traits: { energy: 1.0, timid: -0.8, mischief: 0.6 },
    finds: ['みずたまりを 何度も ふんで、あしが どろどろに なった。'],
  },
  {
    id: 'butterfly',
    zone: 'garden',
    name: 'ちょうちょ',
    art: 'butterfly',
    x: zonePoint('garden', 0.78),
    depth: 0.45,
    actions: ['chase_butterfly', 'jump_joy'],
    base: 0.7,
    serves: 'fun',
    time: 'day',
    traits: { energy: 1.4, timid: -0.6 },
    finds: [
      'ちょうちょを おいかけて、にわを ぐるっと 一周した。',
      'ちょうちょが 鼻の先に とまって、じっと 固まっていた。',
    ],
  },
  {
    id: 'mailbox',
    zone: 'garden',
    name: 'ポスト',
    art: 'mailbox',
    x: zonePoint('garden', 0.95),
    depth: 0.22,
    actions: ['check_mail', 'daydream'],
    base: 0.55,
    traits: { social: 1.3, clever: 0.6 },
    finds: [
      'ポストを のぞいて、なにも 入っていないのを たしかめていた。',
      'ポストの 上に とまった とりと しばらく 見つめあっていた。',
    ],
  },

  // --- おかのうえ ---
  {
    id: 'tree',
    zone: 'hill',
    name: 'おおきな木',
    art: 'tree',
    x: zonePoint('hill', 0.28),
    depth: 0.3,
    actions: ['climb_tree', 'stretch', 'nap'],
    base: 0.7,
    traits: { energy: 1.2, timid: -1.0, mischief: 0.5 },
    finds: [
      '木の みきを のぼって、とちゅうで 下を 見て 固まっていた。',
      '木のうろに どんぐりを ためこんでいた。',
    ],
  },
  {
    id: 'bench',
    zone: 'hill',
    name: 'ベンチ',
    art: 'bench',
    x: zonePoint('hill', 0.52),
    depth: 0.7,
    actions: ['sunbathe', 'daydream', 'nap'],
    base: 0.8,
    serves: 'mood',
    time: 'day',
    traits: { clever: 0.8, energy: -0.5 },
    finds: ['ベンチの ひなたで、目を 細めて まるくなっていた。'],
  },
  {
    id: 'birdnest',
    zone: 'hill',
    name: 'ことりの す',
    art: 'birdnest',
    x: zonePoint('hill', 0.72),
    depth: 0.18,
    actions: ['chat_bird', 'sing', 'daydream'],
    base: 0.6,
    traits: { social: 1.6, timid: -0.4 },
    finds: [
      'ことりと 鳴きまねを しあって、あそんでいた。',
      'ことりの すを 遠くから そっと 見まもっていた。',
    ],
  },
  {
    id: 'starspot',
    zone: 'hill',
    name: 'ほし見の おか',
    art: 'starspot',
    x: zonePoint('hill', 0.92),
    depth: 0.55,
    actions: ['stargaze', 'daydream', 'sing'],
    base: 1.0,
    time: 'night',
    traits: { clever: 1.2, clingy: 0.4 },
    finds: [
      'おかの うえで ずっと 空を 見あげていた。',
      'ながれ星を 見つけて、しばらく 動かなかった。',
    ],
  },
];

/** ニーズの不足度（0〜1）。60 以上あれば困っていない扱い。 */
function lack(value: number): number {
  return Math.max(0, (60 - value) / 60);
}

/**
 * そのスポットの基本的な魅力度。ニーズと性格だけで決まる静的な部分。
 *
 * クライアントの自律行動（時刻・距離・目新しさを掛ける）と、
 * サーバの留守レポート（留守中にいた場所を推測する）の両方から使うので、
 * ここに置いて式を1つにしてある。
 */
export function spotAppeal(
  spot: Spot,
  needs: Record<NeedKey, number>,
  personality: Record<TraitKey, number>,
): number {
  let weight = spot.base;
  if (spot.serves) weight += lack(needs[spot.serves]) * 3.2;
  for (const [key, coefficient] of Object.entries(spot.traits ?? {})) {
    weight += (coefficient as number) * (personality[key as TraitKey] / 100);
  }
  return weight;
}

const SPOT_BY_ID = new Map(SPOTS.map((spot) => [spot.id, spot]));

export function findSpot(id: string): Spot | undefined {
  return SPOT_BY_ID.get(id);
}

export function spotsInZone(id: ZoneId): Spot[] {
  return SPOTS.filter((spot) => spot.zone === id);
}

/** 夜（22時〜6時）かどうか。時間で変わるスポットの判定に使う。 */
export function isNight(hour: number): boolean {
  return hour >= 22 || hour < 6;
}

/** 「にわの みずたまり」のような場所の言い方。プロンプトとログで共用する。 */
export function placeLabel(spotId: string): string {
  const spot = findSpot(spotId);
  if (!spot) return 'おうちの なか';
  return `${findZone(spot.zone)?.name ?? ''}の ${spot.name}`;
}
