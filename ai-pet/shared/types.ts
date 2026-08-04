import type { Emotion, PetAction } from './actions.js';
import type { Personality } from './personality.js';

export type SpeciesId = 'mocha' | 'pome' | 'nimbus';

export interface SpeciesDef {
  id: SpeciesId;
  name: string;
  tagline: string;
  /** 種族ごとの性格バイアス（生成時にベクトルへ加算される）。 */
  bias: Partial<Personality>;
  /** 話し方の土台。性格ベクトルと合わせて speech profile を作る。 */
  speech: string;
  bodyColor: string;
  accentColor: string;
}

export const SPECIES: SpeciesDef[] = [
  {
    id: 'mocha',
    name: 'モカ',
    tagline: 'まるっこい たれ耳の いきもの',
    bias: { clingy: 15, gluttony: 15, timid: 5 },
    speech: 'やわらかい話し方。語尾に「〜だよ」「〜なの」を使う。飼い主を「ごしゅじん」と呼ぶ',
    bodyColor: '#e8b98c',
    accentColor: '#8a5a3b',
  },
  {
    id: 'pome',
    name: 'ポメ',
    tagline: 'ふわふわで うるさい いきもの',
    bias: { energy: 20, mischief: 15, social: 10 },
    speech: '元気で早口。感嘆符が多い。飼い主を「あんた」と呼ぶがなついている',
    bodyColor: '#f6d98a',
    accentColor: '#c98a2e',
  },
  {
    id: 'nimbus',
    name: 'ニンバス',
    tagline: 'くも みたいな ふしぎな いきもの',
    bias: { clever: 20, timid: 10, energy: -15 },
    speech: '落ち着いた話し方。少し古風で、たまに詩のような言い方をする。飼い主を「きみ」と呼ぶ',
    bodyColor: '#c9d8f0',
    accentColor: '#5a76a8',
  },
];

export function findSpecies(id: string): SpeciesDef | undefined {
  return SPECIES.find((s) => s.id === id);
}

/** 各 0〜100。高いほど良い状態（hunger は「満腹度」であって空腹度ではない）。 */
export interface Needs {
  hunger: number;
  fun: number;
  clean: number;
  energy: number;
  mood: number;
}

export const NEED_KEYS = ['hunger', 'fun', 'clean', 'energy', 'mood'] as const;
export type NeedKey = (typeof NEED_KEYS)[number];

export const NEED_LABELS: Record<NeedKey, string> = {
  hunger: 'おなか',
  fun: 'きぶん',
  clean: 'きれい',
  energy: 'げんき',
  mood: 'なかよし',
};

export type GrowthStage = 'egg' | 'child' | 'adult';

export const STAGE_LABELS: Record<GrowthStage, string> = {
  egg: 'たまご',
  child: 'こども',
  adult: 'おとな',
};

export interface PetView {
  id: number;
  name: string;
  species: SpeciesId;
  personality: Personality;
  needs: Needs;
  stage: GrowthStage;
  ageHours: number;
  careScore: number;
  action: PetAction;
  emotion: Emotion;
  bornAt: number;
}

export interface UserView {
  id: number;
  name: string;
}

export interface MemoryFact {
  key: string;
  value: string;
  updatedAt: number;
}

export interface MemoryEpisode {
  id: number;
  summary: string;
  importance: number;
  emotion: Emotion | null;
  createdAt: number;
  lastUsedAt: number;
  useCount: number;
  faded: boolean;
}

export interface ChatTurn {
  id: number;
  role: 'owner' | 'pet';
  text: string;
  emotion: Emotion | null;
  createdAt: number;
}

/** LLM が返すべき構造。parse.ts が厳格に検証する。 */
export interface PetReply {
  say: string;
  emotion: Emotion;
  action: PetAction;
  needsDelta: Partial<Needs>;
  memoryWrites: MemoryWrite[];
  giftRequest: string | null;
}

export type MemoryWrite =
  | { kind: 'fact'; key: string; value: string }
  | { kind: 'episode'; summary: string; importance: number; emotion?: Emotion };

export interface InteractionResult {
  pet: PetView;
  reply: PetReply | null;
  /** LLM が使えなかった場合の理由（UI に控えめに出す）。 */
  llmError?: string;
}

export interface EncounterLine {
  speaker: 'self' | 'other';
  text: string;
}

export interface EncounterView {
  id: number;
  otherPetName: string;
  otherOwnerName: string;
  otherSpecies: SpeciesId;
  lines: EncounterLine[];
  souvenir: string;
  affinityDelta: number;
  createdAt: number;
  seen: boolean;
}

export interface AwayReport {
  hoursAway: number;
  lines: string[];
  encounters: EncounterView[];
  gifts: GiftView[];
  visits: VisitView[];
}

export interface GiftView {
  id: number;
  fromUserName: string;
  itemId: string;
  message: string;
  createdAt: number;
  claimed: boolean;
}

export interface VisitView {
  id: number;
  visitorName: string;
  visitorPetName: string;
  comment: string;
  createdAt: number;
}

export interface FriendView {
  userId: number;
  userName: string;
  petName: string;
  petSpecies: SpeciesId;
  petStage: GrowthStage;
  affinity: number;
}

export interface PromiseView {
  id: number;
  text: string;
  forDate: string;
  done: boolean;
  createdAt: number;
}

export interface RoomLayout {
  wall: string;
  floor: string;
  furniture: Array<{ itemId: string; x: number; y: number }>;
}
