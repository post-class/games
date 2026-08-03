import { rng } from '../core/rng';
import type { WingmanOrder } from '../world/entity';

/** 僚機がオーダーに応答する台詞 */
const WINGMAN_ACK: Record<WingmanOrder, string[]> = {
  form: ['了解、翼に付く。', 'フォーメーションに戻る。', '編隊、リード了解。'],
  'attack-my-target': [
    'その目標を狙う。',
    '了解、お前の獲物を叩く。',
    'ロックした。仕留めるぞ。',
  ],
  'break-and-attack': [
    'ブレイク！各自交戦する。',
    '散開する。好きに暴れさせてもらう。',
    '了解、自由射撃だ。',
  ],
  'help-me': ['そっちへ向かう、こらえろ！', '引き剥がす、10秒待て。'],
};

const WINGMAN_KILL = [
  '撃墜確認、いい腕だ。',
  'ナイスショット。',
  'よし、1機減った。',
];

const WINGMAN_TROUBLE = [
  'こいつを引き剥がせない、助けてくれ！',
  '被弾した！背後を取られている！',
  'シールドが持たない、支援を頼む！',
];

const ENEMY_TAUNT = [
  '毛のない猿が飛び方を覚えたか。',
  'お前の骨で牙を研いでやろう。',
  '逃げるなら今のうちだ、人間。',
  'キルラシーの空で死ぬ栄誉をやる。',
];

const PLAYER_TAUNT = [
  '猫よ、そのブリキ缶で私に勝てると思うか。',
  '帝国の腕はそんなものか。',
  'かかってこい、毛玉。',
];

const ENEMY_ACK_TAUNT = [
  'その口を裂いてやる！',
  '許さん、人間！',
  '調子に乗るな、猿め。',
];

export function wingmanAck(order: WingmanOrder): string {
  return rng.pick(WINGMAN_ACK[order]);
}

export function wingmanKillLine(): string {
  return rng.pick(WINGMAN_KILL);
}

export function wingmanTroubleLine(): string {
  return rng.pick(WINGMAN_TROUBLE);
}

export function enemyTaunt(): string {
  return rng.pick(ENEMY_TAUNT);
}

export function playerTaunt(): string {
  return rng.pick(PLAYER_TAUNT);
}

export function enemyTauntReply(): string {
  return rng.pick(ENEMY_ACK_TAUNT);
}

/** キルラシーのパイロット名 (エース以外の雑多な敵に付ける) */
export const KILRATHI_NAMES = [
  'Kirha nar Hhallas',
  'Dakhath',
  'Bhurak',
  'Gilkarg',
  'Hobar',
  'Jukaga',
  'Melek',
  'Nargrast',
  'Ratha',
  'Thrakhath',
];

export function kilrathiName(i: number): string {
  return KILRATHI_NAMES[i % KILRATHI_NAMES.length];
}
