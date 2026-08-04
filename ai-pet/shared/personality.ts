/**
 * 性格は自由記述ではなく 8 軸の数値ベクトルで保持する。
 *
 * 既存の AI ペットアプリで最も多い不満は「会話が長引くと汎用アシスタント口調に戻る」
 * （キャラクター崩壊）である。原因は、性格が最初のプロンプトの散文にしか存在せず、
 * 会話履歴が伸びるほど相対的に薄まっていくこと。
 *
 * 本作は性格を数値で保持し、毎リクエストで数値から文章を機械生成して再注入する。
 * これにより履歴の長さに関係なく性格の記述量が一定に保たれる。
 */

export const TRAIT_KEYS = [
  'energy', // 元気
  'clingy', // 甘えん坊
  'willful', // わがまま
  'clever', // 賢さ
  'social', // 社交性
  'gluttony', // 食いしん坊
  'timid', // 臆病さ
  'mischief', // いたずら
] as const;

export type TraitKey = (typeof TRAIT_KEYS)[number];

/** 各軸 0〜100。 */
export type Personality = Record<TraitKey, number>;

export const TRAIT_LABELS: Record<TraitKey, string> = {
  energy: '元気',
  clingy: '甘えん坊',
  willful: 'わがまま',
  clever: '賢さ',
  social: '社交性',
  gluttony: '食いしん坊',
  timid: '臆病さ',
  mischief: 'いたずら',
};

/**
 * 軸ごとの言語化。low / mid / high の3段で、プロンプトに入れる説明文を持つ。
 * 「その軸が行動と口調にどう出るか」まで書くのが重要（LLM が形容詞だけでは演じ分けない）。
 */
const TRAIT_DESCRIPTIONS: Record<TraitKey, [low: string, mid: string, high: string]> = {
  energy: [
    'いつもだらけていて、動くのを面倒がる。返事も短くのんびり',
    '普通の元気さ。疲れたら休む',
    'じっとしていられない。話し方も勢いがあって、感嘆符が多い',
  ],
  clingy: [
    '一人が好き。かまわれ過ぎると距離を取る',
    '適度に寄ってくる',
    '常に飼い主にくっついていたい。少し放置されるとすぐ寂しがって、それを言葉にする',
  ],
  willful: [
    '素直で言われたことを受け入れる',
    'たまに文句を言う',
    '自分の要求を優先する。気に入らないと断る。ねだるのが上手い',
  ],
  clever: [
    '難しい話は分からない。単語が少なく、たまに言葉を間違える',
    '子どもなりの理解力がある',
    '飼い主の言葉の裏を読む。皮肉や気の利いた返しをする',
  ],
  social: [
    '他のペットが苦手。他人の話題を避ける',
    '相手によっては打ち解ける',
    '他のペットや外の世界の話が大好きで、自分から話題にする',
  ],
  gluttony: [
    '食にこだわらない',
    '普通に食べる',
    '食べ物の話題に真っ先に食いつく。何かとごはんに話をつなげる',
  ],
  timid: [
    '物怖じしない。何にでも突っ込む',
    '慎重なところもある',
    '物音や知らないものを怖がる。語尾が弱く、確認したがる',
  ],
  mischief: [
    'おとなしく、いたずらはしない',
    'ときどきちょっかいを出す',
    '物を隠したり驚かせたりするのが好き。悪びれずに白状する',
  ],
};

/** 数値を low / mid / high に落とす。閾値は決定論的（テスト可能）。 */
export function traitBand(value: number): 0 | 1 | 2 {
  if (value <= 33) return 0;
  if (value <= 66) return 1;
  return 2;
}

/**
 * 性格ベクトルからプロンプト用の箇条書きを組み立てる。
 * 極端な軸（<=20 または >=80）は「特に」を付けて強調し、演じ分けを促す。
 */
export function describePersonality(p: Personality): string {
  const lines = TRAIT_KEYS.map((key) => {
    const value = p[key];
    const text = TRAIT_DESCRIPTIONS[key][traitBand(value)];
    const emphasis = value >= 80 || value <= 20 ? '（とても強い特徴）' : '';
    return `- ${TRAIT_LABELS[key]} ${value}/100${emphasis}: ${text}`;
  });
  return lines.join('\n');
}

/** 上位2軸を返す（UI の「この子の特徴」表示と、会話の主導軸に使う）。 */
export function dominantTraits(p: Personality): TraitKey[] {
  return [...TRAIT_KEYS].sort((a, b) => p[b] - p[a]).slice(0, 2);
}

/** 乱数生成器を差し込めるようにしてテストを決定論的にする。 */
export function randomPersonality(rand: () => number = Math.random): Personality {
  const out = {} as Personality;
  for (const key of TRAIT_KEYS) {
    // 極端な個性が出やすいよう、一様分布ではなく端に寄せた分布にする。
    const raw = rand();
    const skewed = raw < 0.5 ? Math.pow(raw * 2, 1.6) / 2 : 1 - Math.pow((1 - raw) * 2, 1.6) / 2;
    out[key] = Math.round(skewed * 100);
  }
  return out;
}

export function clampPersonality(p: Personality): Personality {
  const out = {} as Personality;
  for (const key of TRAIT_KEYS) {
    out[key] = Math.max(0, Math.min(100, Math.round(p[key] ?? 50)));
  }
  return out;
}
