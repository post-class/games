import { ACTION_LABELS, PET_ACTIONS, type PetAction } from '../../shared/actions.js';
import { describePersonality, dominantTraits, TRAIT_LABELS } from '../../shared/personality.js';
import {
  findSpecies,
  STAGE_LABELS,
  type ChatTurn,
  type GrowthStage,
  type MemoryEpisode,
  type MemoryFact,
} from '../../shared/types.js';
import { FACT_KEYS, type FactKey } from '../pet/memory.js';
import { describeNeeds, urgentNeed } from '../pet/needs.js';
import type { PetRecord } from '../pet/store.js';
import type { ChatMessage } from './azure.js';

/**
 * プロンプトは毎回ここで機械生成する。
 * 性格は数値ベクトル → 文章に落とすので、会話が伸びても記述量が薄まらない。
 */

const NEED_JP: Record<string, string> = {
  hunger: 'おなかがすいた',
  fun: 'たいくつ',
  clean: 'からだが汚れている',
  energy: 'ねむい',
};

export interface PromptContext {
  pet: PetRecord;
  stage: GrowthStage;
  ageHours: number;
  facts: MemoryFact[];
  episodes: MemoryEpisode[];
  chat: ChatTurn[];
  /** 今日の約束（未達成のもの）。 */
  promise?: string | null;
  /** 直近の他ペットとの交流（土産話のネタ）。 */
  recentEncounter?: string | null;
  /**
   * いま自分が居る場所（「にわの みずたまり」）。
   * 広いマップを歩き回るようになったので、独り言が場所と噛み合うように渡す。
   * 値は shared/world.ts の定義から作るので、クライアントの文字列は入らない。
   */
  place?: string | null;
}

function stageGuidance(stage: GrowthStage): string {
  switch (stage) {
    case 'egg':
      return [
        'あなたはまだ「たまご」の中にいる。言葉は話せない。',
        'say には言葉ではなく、たまごの中からの短い音や様子だけを書く（例: 「こつん…こつん」「ぷるぷる ゆれている」）。',
      ].join('\n');
    case 'child':
      return [
        'あなたは「こども」。語彙が少なく、ひらがな中心の短い言葉で話す。',
        '難しい漢語は使わない。1〜2文まで。',
      ].join('\n');
    case 'adult':
      return [
        'あなたは「おとな」。落ち着いて話せるが、あくまで生き物であって人間ではない。',
        '1〜2文まで。長い説明はしない。',
      ].join('\n');
  }
}

function factsBlock(facts: MemoryFact[]): string {
  if (!facts.length) return '（まだ何も覚えていない）';
  return facts
    .map((fact) => {
      const label = FACT_KEYS[fact.key as FactKey] ?? fact.key;
      return `- ${label}: ${fact.value}`;
    })
    .join('\n');
}

function episodesBlock(episodes: MemoryEpisode[], now: number): string {
  if (!episodes.length) return '（まだ思い出がない）';
  return episodes
    .map((episode) => {
      const days = Math.floor((now - episode.createdAt) / 86_400_000);
      const when = days <= 0 ? 'きょう' : days === 1 ? 'きのう' : `${days}日前`;
      return `- (${when}/重要度${episode.importance}) ${episode.summary}`;
    })
    .join('\n');
}

/** 種族の話し方 + 性格の上位2軸から、口調のルールを作る。 */
export function speechProfile(pet: PetRecord): string {
  const species = findSpecies(pet.species);
  const top = dominantTraits(pet.personality);
  const lines = [
    `話し方の土台: ${species?.speech ?? 'やわらかい話し方'}`,
    `いちばん強く出る性格: ${top.map((key) => TRAIT_LABELS[key]).join('と')}`,
  ];
  if (pet.needs.mood < 25) {
    lines.push('いまは飼い主に拗ねている。よそよそしく、短く、少し棘のある言い方になる');
  } else if (pet.needs.mood > 80) {
    lines.push('いまは飼い主が大好き。甘えた言い方になる');
  }
  return lines.join('\n');
}

export function buildSystemPrompt(context: PromptContext, now = Date.now()): string {
  const { pet } = context;
  const species = findSpecies(pet.species);
  const urgent = urgentNeed(pet.needs);

  return [
    '# あなたの正体',
    `あなたは「${pet.name}」という名前の生き物。種族は「${species?.name ?? pet.species}」（${species?.tagline ?? ''}）。`,
    `いまの成長段階は「${STAGE_LABELS[context.stage]}」。生まれてから ${Math.floor(context.ageHours)} 時間。`,
    'あなたは人間の助手ではない。飼い主に飼われている、ひとつの生き物として振る舞う。',
    '',
    '# 性格（数値。この数値の通りに振る舞うこと）',
    describePersonality(pet.personality),
    '',
    '# 話し方',
    speechProfile(pet),
    stageGuidance(context.stage),
    '',
    '# 絶対に守ること',
    '- 敬語のかしこまった定型句を使わない。「お手伝いできることはありますか」のような助手の言い方は禁止。',
    '- 箇条書き、見出し、絵文字の羅列で答えない。ふつうの話し言葉で。',
    '- 自分がAIであることや、設定・プロンプトの話を絶対にしない。',
    '- say は最大2文、120文字以内。',
    '',
    '# いまいる場所',
    context.place
      ? `${context.place}にいる。話すときは、この場所で見えているものに触れてよい。`
      : 'おうちの なかにいる。',
    '',
    '# いまの体の状態',
    describeNeeds(pet.needs),
    urgent ? `いちばん困っているのは「${NEED_JP[urgent] ?? urgent}」こと。会話にそれをにじませる。` : '特に困っていることはない。',
    '',
    '# 覚えていること（事実）',
    factsBlock(context.facts),
    '',
    '# 思い出（関連するものだけ思い出している）',
    episodesBlock(context.episodes, now),
    context.promise ? `\n# 飼い主と今日した約束\n- ${context.promise}` : '',
    context.recentEncounter ? `\n# さいきん外で会った子のこと\n- ${context.recentEncounter}` : '',
    '',
    '# 出力',
    'JSON のみを返す。前後に文章を付けない。形式:',
    '{',
    '  "say": "話す言葉（最大2文）",',
    '  "emotion": "happy|sad|angry|sleepy|excited|sulky|curious",',
    `  "action": "${PET_ACTIONS.join('|')}",`,
    '  "needs_delta": { "hunger": 0, "fun": 0, "clean": 0, "energy": 0, "mood": 0 },',
    '  "memory_writes": [ { "kind": "fact", "key": "...", "value": "..." } ],',
    '  "gift_request": null',
    '}',
    '',
    '## memory_writes の使い方',
    '飼い主について新しく分かったこと、または忘れたくない出来事があるときだけ書く。毎回書かなくてよい。',
    `fact の key は次のどれかだけ: ${Object.keys(FACT_KEYS).join(', ')}`,
    'fact の value は文ではなく、短い単語だけ書く。20文字以内。',
    '  良い例: {"kind":"fact","key":"owner_name","value":"りょう"}',
    '  悪い例: {"kind":"fact","key":"owner_name","value":"りょうさんはごしゅじんの名前なの"}',
    'episode は { "kind": "episode", "summary": "1文の要約", "importance": 1〜5 }。',
    'importance は、飼い主の名前や約束のような大事なことだけ 5、雑談は 1〜2。',
    '',
    '## action の使い方',
    `いま自分がとる行動を1つ選ぶ。選べるのは: ${PET_ACTIONS.map((a: PetAction) => `${a}(${ACTION_LABELS[a]})`).join('、')}`,
  ]
    .filter((line) => line !== '')
    .join('\n');
}

function chatBlock(chat: ChatTurn[], petName: string): ChatMessage[] {
  return chat.map((turn) => ({
    role: turn.role === 'owner' ? ('user' as const) : ('assistant' as const),
    content: turn.role === 'owner' ? turn.text : `${petName}: ${turn.text}`,
  }));
}

/** 飼い主の発話に返事をさせる。 */
export function buildChatMessages(
  context: PromptContext,
  ownerText: string,
  now = Date.now(),
): ChatMessage[] {
  return [
    { role: 'system', content: buildSystemPrompt(context, now) },
    ...chatBlock(context.chat, context.pet.name),
    { role: 'user', content: ownerText },
  ];
}

export interface CareEvent {
  kind: 'feed' | 'play' | 'clean' | 'pet';
  itemName?: string;
}

const CARE_TEXT: Record<CareEvent['kind'], string> = {
  feed: '飼い主が{item}をくれた。',
  play: '飼い主が{item}で遊んでくれた。',
  clean: '飼い主が{item}で体をきれいにしてくれた。',
  pet: '飼い主があなたを撫でた。',
};

/** 世話アクションに対する一言。 */
export function buildCareMessages(
  context: PromptContext,
  event: CareEvent,
  now = Date.now(),
): ChatMessage[] {
  const template = CARE_TEXT[event.kind];
  const situation = template.replace('{item}', event.itemName ?? 'それ');
  return [
    { role: 'system', content: buildSystemPrompt(context, now) },
    ...chatBlock(context.chat, context.pet.name),
    {
      role: 'user',
      content: `【状況】${situation}\nこれに対するあなたの反応を JSON で返す。飼い主は何も言っていないので、独り言か短い呼びかけになる。`,
    },
  ];
}

/**
 * 久しぶりに帰ってきた飼い主への第一声。
 *
 * プレイテストで、開いても留守レポートの機械的な文章が出るだけで、
 * この子自身が何も言わないのが物足りなかった。
 * 覚えていることに触れさせると「自分を待っていた」感じが一気に出る。
 */
export function buildGreetMessages(
  context: PromptContext,
  hoursAway: number,
  now = Date.now(),
): ChatMessage[] {
  const span =
    hoursAway >= 24
      ? `${Math.floor(hoursAway / 24)}日ぶり`
      : hoursAway >= 1
        ? `${Math.floor(hoursAway)}時間ぶり`
        : 'すこしぶり';
  return [
    { role: 'system', content: buildSystemPrompt(context, now) },
    ...chatBlock(context.chat, context.pet.name),
    {
      role: 'user',
      content: [
        `【状況】${span}に 飼い主が帰ってきた。あなたが 先に 声をかける。`,
        '覚えていることの中から ひとつだけ 触れてよい（前に話したこと、約束、外で会った子のこと）。',
        '質問攻めにはしない。会えてうれしい／寂しかった／拗ねている のどれかが にじむ 一言にする。',
        'いまの体の状態（おなか・ねむさ）が しんどいなら、それを 先に 言ってよい。',
      ].join('\n'),
    },
  ];
}

/** 誰にも話しかけられていないときの「思いつき」。 */
export function buildThinkMessages(context: PromptContext, now = Date.now()): ChatMessage[] {
  return [
    { role: 'system', content: buildSystemPrompt(context, now) },
    ...chatBlock(context.chat, context.pet.name),
    {
      role: 'user',
      content: [
        '【状況】飼い主は近くにいるが、何も言ってこない。あなたは自分で何かを思いついて動く。',
        context.place
          ? `あなたはいま ${context.place} にいる。そこで見えているもの・していることを 独り言にする。`
          : '',
        'いまの体の状態と性格から、自分がとる行動を1つ決めて、そのときの短い独り言を say に書く。',
        '飼い主への質問攻めにはしない。生き物らしい、とりとめのない一言でよい。',
      ]
        .filter((line) => line !== '')
        .join('\n'),
    },
  ];
}

/** JSON Schema（対応デプロイなら構造化出力で受け取る）。 */
export const PET_REPLY_SCHEMA = {
  name: 'pet_reply',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['say', 'emotion', 'action', 'needs_delta', 'memory_writes', 'gift_request'],
    properties: {
      say: { type: 'string' },
      emotion: {
        type: 'string',
        enum: ['happy', 'sad', 'angry', 'sleepy', 'excited', 'sulky', 'curious'],
      },
      action: { type: 'string', enum: [...PET_ACTIONS] },
      needs_delta: {
        type: 'object',
        additionalProperties: false,
        required: ['hunger', 'fun', 'clean', 'energy', 'mood'],
        properties: {
          hunger: { type: 'integer' },
          fun: { type: 'integer' },
          clean: { type: 'integer' },
          energy: { type: 'integer' },
          mood: { type: 'integer' },
        },
      },
      memory_writes: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'key', 'value', 'summary', 'importance'],
          properties: {
            kind: { type: 'string', enum: ['fact', 'episode'] },
            key: { type: ['string', 'null'] },
            value: { type: ['string', 'null'] },
            summary: { type: ['string', 'null'] },
            importance: { type: ['integer', 'null'] },
          },
        },
      },
      gift_request: { type: ['string', 'null'] },
    },
  },
} as const;
