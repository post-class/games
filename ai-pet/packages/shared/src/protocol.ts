/**
 * WebSocketプロトコル（docs/02_ゲーム実装プラン/05_通信プロトコル.md）
 * 受信側は必ず parse してから使う。クライアント発の値を信用しない。
 */
import { z } from 'zod';
import { CHUNK, MAP_H, MAP_W } from './constants.ts';

export const PROTOCOL_VERSION = 1;

const zVec2 = z.object({ x: z.number().finite(), y: z.number().finite() });
const zTilePos = z.object({
  x: z.number().finite().min(0).max(MAP_W - 1),
  y: z.number().finite().min(0).max(MAP_H - 1),
});

const zFacingIdx = z.number().int().min(0).max(3);
const zAnimIdx = z.number().int().min(0).max(4);

// ==================== クライアント → サーバ ====================

export const HelloMsg = z.object({
  t: z.literal('hello'),
  v: z.number().int().optional(),
  secret: z.string().max(128).optional(),
  displayName: z.string().min(1).max(16).optional(),
});

export const ChunkReqMsg = z.object({
  t: z.literal('chunkReq'),
  chunks: z.array(z.tuple([z.number().int().min(0).max(63), z.number().int().min(0).max(63)])).max(64),
});

export const MoveMsg = z.object({
  t: z.literal('move'),
  to: zTilePos,
});

export const MoveAxisMsg = z.object({
  t: z.literal('moveAxis'),
  dx: z.number().min(-1).max(1),
  dy: z.number().min(-1).max(1),
});

export const InteractMsg = z.object({
  t: z.literal('interact'),
  targetId: z.number().int(),
  act: z.enum(['harvest', 'water', 'pet', 'talk']),
});

export const SayMsg = z.object({
  t: z.literal('say'),
  text: z.string().min(1).max(200),
  to: z.number().int().optional(),
});

export const PlaceMsg = z.object({
  t: z.literal('place'),
  type: z.enum(['bench', 'flowerbed', 'lantern', 'signboard']),
  pos: zTilePos,
});

/**
 * 設置物の撤去（G-5）。
 * 撤去できるのは自分が置いたものだけで、判定はサーバ（`BuildSystem.removeByPlayer`）が持つ。
 * ここでは「どれを」だけ受け取る（座標はサーバ権威の値を使うため送らせない）。
 */
export const RemoveMsg = z.object({
  t: z.literal('remove'),
  id: z.number().int(),
});

export const ContributeMsg = z.object({
  t: z.literal('contribute'),
  constructionId: z.number().int(),
});

export const PersonaInput = z.object({
  traitTags: z.array(z.string().min(1).max(10)).max(3),
  catchphrase: z.string().max(16),
  likes: z.string().max(20),
  dislikes: z.string().max(20),
});

export const CreatePetMsg = z.object({
  t: z.literal('createPet'),
  species: z.enum(['mofi', 'mizune', 'hakka', 'momona', 'hoshira']),
  name: z.string().min(1).max(12),
  persona: PersonaInput,
});

export const PingMsg = z.object({
  t: z.literal('ping'),
  ts: z.number(),
});

export const ClientMsg = z.discriminatedUnion('t', [
  HelloMsg,
  ChunkReqMsg,
  MoveMsg,
  MoveAxisMsg,
  InteractMsg,
  SayMsg,
  PlaceMsg,
  RemoveMsg,
  ContributeMsg,
  CreatePetMsg,
  PingMsg,
]);
export type ClientMsg = z.infer<typeof ClientMsg>;
export type ClientMsgType = ClientMsg['t'];

// ==================== サーバ → クライアント ====================
// サーバ発は信頼できるため型定義のみ（parseはしない）。

/** 追加時に送る全量。位置は小数2桁に丸めて送る */
export interface ActorWire {
  i: number;
  /** 0=critter 1=pet 2=player */
  k: 0 | 1 | 2;
  s: string;
  n: string;
  x: number;
  y: number;
  f: number;
  a: number;
  o?: string;
}

/** 更新時の差分 */
export interface ActorDelta {
  i: number;
  x?: number;
  y?: number;
  f?: number;
  a?: number;
}

export interface ResourceWire {
  i: number;
  ty: string;
  x: number;
  y: number;
  amt: number;
  max: number;
}

export interface PlaceableWire {
  i: number;
  ty: string;
  x: number;
  y: number;
  o: string;
}

/** 共同建設の1件（進捗バーの表示用） */
export interface ConstructionWire {
  i: number;
  ty: string;
  x: number;
  y: number;
  /** 0..100 */
  p: number;
  /** 完成済みか */
  done: boolean;
  /** 自分の貢献値 */
  mine: number;
}

export interface ClockWire {
  tick: number;
  islandDay: number;
  dayProgress: number;
  timeOfDay: string;
  season: string;
  weather: string;
}

/** タマゴ選択UIに出す図鑑の1件（ペット未作成のときだけ welcome に載る） */
export interface PetCatalogEntry {
  species: string;
  displayName: string;
  archetype: string;
  suggestedTraitTags: string[];
  defaultCatchphrase: string;
  defaultLikes: string;
  defaultDislikes: string;
}

export interface PetWire {
  id: number;
  species: string;
  name: string;
  affection: number;
  persona: {
    traitTags: string[];
    catchphrase: string;
    likes: string;
    dislikes: string;
    archetype: string;
  };
}

export type ServerMsg =
  | {
      t: 'welcome';
      v: number;
      playerId: string;
      secret: string;
      entityId: number;
      islandId: string;
      seed: string;
      clock: ClockWire;
      you: ActorWire;
      pet: PetWire | null;
      /** ペット未作成のときだけ入る（タマゴ選択UIの材料） */
      petCatalog?: PetCatalogEntry[];
      mapW: number;
      mapH: number;
    }
  | {
      t: 'chunk';
      cx: number;
      cy: number;
      /** 地形のRLE: [terrainIndex, count, ...] */
      terrain: number[];
      resources: ResourceWire[];
    }
  | {
      t: 'snapshot';
      tick: number;
      clock: ClockWire;
      actors: ActorWire[];
      resources: ResourceWire[];
      placeables: PlaceableWire[];
    }
  | {
      t: 'delta';
      tick: number;
      upd?: ActorDelta[];
      add?: ActorWire[];
      rm?: number[];
      res?: { i: number; amt: number }[];
      clock?: ClockWire;
    }
  /**
   * 荒廃度（G-6）。チャンク1つぶんを行優先の CHUNK*CHUNK 配列で送る。
   *
   * 地形と違って RLE にしていないのは、クライアントの `TileMap.setChunkDecay()` が
   * 「長さ256の生配列」を前提に完成しているため（受信側を触らずに繋ぐのを優先した）。
   * そのぶん帯域は送信側で絞る: **興味範囲内で内容が変わったチャンクだけ・1島時間に1回**。
   */
  | { t: 'chunkDecay'; cx: number; cy: number; decay: number[] }
  /**
   * 地形が変わったことの通知（橋の完成など）。
   * クライアントは該当チャンクを捨てて再要求する（焼き直しが必要なため）。
   */
  | { t: 'terrainChanged'; chunks: [number, number][]; tiles?: { x: number; y: number; terrain: number }[] }
  /** 共同建設の状態（入島時と進捗が動いたとき） */
  | { t: 'constructions'; items: ConstructionWire[] }
  | { t: 'bubble'; entityId: number; text: string; kind: 'say' | 'think'; ms: number }
  | { t: 'chatChunk'; convId: string; entityId: number; delta: string; done: boolean }
  | { t: 'notice'; text: string; importance: number }
  | { t: 'awaySummary'; lines: string[]; islandDaysPassed: number }
  | { t: 'petState'; affection: number; intent?: { goal: string; reason: string }; mood: string }
  | { t: 'warn'; code: string; message: string }
  | { t: 'serverClosing'; reason: string }
  | { t: 'pong'; ts: number; tick: number };

export type ServerMsgType = ServerMsg['t'];

/**
 * `chunkDecay` の形をスキーマとして書き留めたもの。
 *
 * サーバ発のメッセージは実行時に parse しない方針なので**通信経路では使わない**が、
 * 「長さ256・0..100の整数」という約束をテストで固定するために持つ
 * （クライアントの `setChunkDecay()` は長さが違うと例外を投げるので、崩れると画面が止まる）。
 */
export const ChunkDecayWireSchema = z.object({
  t: z.literal('chunkDecay'),
  cx: z.number().int().min(0),
  cy: z.number().int().min(0),
  decay: z.array(z.number().int().min(0).max(100)).length(CHUNK * CHUNK),
});

// ==================== ヘルパ ====================

/** 位置は小数2桁で送る（帯域削減） */
export function q2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function encodeFacing(f: 'n' | 'e' | 's' | 'w'): number {
  return f === 'n' ? 0 : f === 'e' ? 1 : f === 's' ? 2 : 3;
}

export function decodeFacing(i: number): 'n' | 'e' | 's' | 'w' {
  return (['n', 'e', 's', 'w'] as const)[i] ?? 's';
}

export function encodeAnim(a: 'idle' | 'walk' | 'act' | 'sleep' | 'talk'): number {
  return a === 'idle' ? 0 : a === 'walk' ? 1 : a === 'act' ? 2 : a === 'sleep' ? 3 : 4;
}

export function decodeAnim(i: number): 'idle' | 'walk' | 'act' | 'sleep' | 'talk' {
  return (['idle', 'walk', 'act', 'sleep', 'talk'] as const)[i] ?? 'idle';
}

/** 数値配列のランレングス符号化（地形チャンク用） */
export function rleEncode(values: readonly number[]): number[] {
  const out: number[] = [];
  let i = 0;
  while (i < values.length) {
    const v = values[i] as number;
    let n = 1;
    while (i + n < values.length && values[i + n] === v) n++;
    out.push(v, n);
    i += n;
  }
  return out;
}

export function rleDecode(rle: readonly number[], expectedLength?: number): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < rle.length; i += 2) {
    const v = rle[i] as number;
    const n = rle[i + 1] as number;
    for (let k = 0; k < n; k++) out.push(v);
  }
  if (expectedLength !== undefined && out.length !== expectedLength) {
    throw new Error(`rleDecode: length mismatch ${out.length} != ${expectedLength}`);
  }
  return out;
}

/** 受信メッセージのparse。失敗しても例外を投げず結果で返す */
export function parseClientMsg(raw: unknown): { ok: true; msg: ClientMsg } | { ok: false; error: string } {
  let data: unknown = raw;
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw);
    } catch {
      return { ok: false, error: 'invalid json' };
    }
  }
  const r = ClientMsg.safeParse(data);
  if (!r.success) return { ok: false, error: r.error.issues[0]?.message ?? 'invalid message' };
  return { ok: true, msg: r.data };
}
