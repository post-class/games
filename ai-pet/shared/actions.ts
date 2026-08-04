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
};
