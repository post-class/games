/**
 * ペットの行動はホワイトリスト化された enum。
 * LLM が何を返しても、未知の値はここで弾いて 'idle' に落とすので画面が壊れない。
 */

export const PET_ACTIONS = [
  'idle', // その場でぼんやり
  'walk', // うろうろ歩く
  'eat', // 食べる
  'play', // おもちゃで遊ぶ
  'nap', // 寝る
  'wash', // 体をきれいにする
  'peek_window', // 窓の外を見る
  'hide_item', // 物を隠す（いたずら）
  'sulk_corner', // 隅で拗ねる
  'jump_joy', // 跳ねて喜ぶ
  'nuzzle', // すり寄る
  'stare_owner', // 飼い主をじっと見る
  'tidy_room', // 部屋を片付ける
  'daydream', // 空想する
  // --- 広いマップの各スポットでする行動 ---
  'dig', // 土を掘る（にわ）
  'bury_treasure', // 拾ったものを埋める（にわ）
  'sniff_flower', // 花のにおいをかぐ（にわ）
  'splash_puddle', // 水たまりで跳ねる（にわ）
  'chase_butterfly', // ちょうちょを追いかける（にわ）
  'climb_tree', // 木にのぼる（おか）
  'stargaze', // 星を眺める（おか・夜）
  'sunbathe', // ひなたぼっこ（おか・昼）
  'chat_bird', // ことりと話す（おか）
  'check_mail', // ポストを覗く（にわ）
  'dance', // 踊る（みずば・リビング）
  'sing', // 歌う
  'roll_around', // ごろごろ転がる
  'stretch', // せのびをする
] as const;

export type PetAction = (typeof PET_ACTIONS)[number];

export const EMOTIONS = [
  'happy',
  'sad',
  'angry',
  'sleepy',
  'excited',
  'sulky',
  'curious',
] as const;

export type Emotion = (typeof EMOTIONS)[number];

export function isPetAction(value: unknown): value is PetAction {
  return typeof value === 'string' && (PET_ACTIONS as readonly string[]).includes(value);
}

export function isEmotion(value: unknown): value is Emotion {
  return typeof value === 'string' && (EMOTIONS as readonly string[]).includes(value);
}

/** 行動の日本語ラベル（画面のステータス表示・留守レポートで使う）。 */
export const ACTION_LABELS: Record<PetAction, string> = {
  idle: 'ぼーっとしている',
  walk: 'うろうろしている',
  eat: 'ごはんを食べている',
  play: 'おもちゃで遊んでいる',
  nap: 'すやすや寝ている',
  wash: '体をきれいにしている',
  peek_window: '窓の外を眺めている',
  hide_item: '何かを隠している',
  sulk_corner: '隅で拗ねている',
  jump_joy: '跳ねて喜んでいる',
  nuzzle: 'すり寄ってきている',
  stare_owner: 'じっとこっちを見ている',
  tidy_room: '部屋を片付けている',
  daydream: '空想にふけっている',
  dig: 'つちを ほっている',
  bury_treasure: 'たからものを うめている',
  sniff_flower: 'おはなの においを かいでいる',
  splash_puddle: 'みずたまりで はねている',
  chase_butterfly: 'ちょうちょを おいかけている',
  climb_tree: '木に のぼっている',
  stargaze: 'ほしを ながめている',
  sunbathe: 'ひなたぼっこを している',
  chat_bird: 'ことりと はなしている',
  check_mail: 'ポストを のぞいている',
  dance: 'おどっている',
  sing: 'うたっている',
  roll_around: 'ごろごろ ころがっている',
  stretch: 'せのびを している',
};

/** その行動が何秒くらい続くか（クライアント FSM のアニメ尺）。 */
export const ACTION_DURATION_MS: Record<PetAction, number> = {
  idle: 4000,
  walk: 5000,
  eat: 3500,
  play: 5000,
  nap: 12000,
  wash: 4000,
  peek_window: 6000,
  hide_item: 4500,
  sulk_corner: 9000,
  jump_joy: 2500,
  nuzzle: 3500,
  stare_owner: 5000,
  tidy_room: 6000,
  daydream: 7000,
  dig: 5500,
  bury_treasure: 6000,
  sniff_flower: 4500,
  splash_puddle: 5000,
  chase_butterfly: 7000,
  climb_tree: 6500,
  stargaze: 9000,
  sunbathe: 9000,
  chat_bird: 6000,
  check_mail: 4500,
  dance: 5000,
  sing: 4500,
  roll_around: 5000,
  stretch: 3000,
};
