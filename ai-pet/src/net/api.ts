import type {
  AwayReport,
  ChatTurn,
  EncounterView,
  FriendView,
  GiftView,
  MemoryEpisode,
  MemoryFact,
  PetReply,
  PetView,
  PromiseView,
  RoomLayout,
  SpeciesId,
  VisitView,
} from '../../shared/types.js';
import type { ItemDef } from '../../shared/items.js';

/** サーバとのやりとり。APIキーはサーバ側にあるので、ここには秘密が一切ない。 */

export class ApiError extends Error {}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const text = await response.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      throw new ApiError('サーバの応答が読めませんでした');
    }
  }
  if (!response.ok) {
    const message =
      json && typeof json === 'object' && 'error' in json
        ? String((json as { error: unknown }).error)
        : `通信に失敗しました (${response.status})`;
    throw new ApiError(message);
  }
  return json as T;
}

const post = <T>(path: string, body?: unknown): Promise<T> =>
  request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });

export interface InventoryEntry {
  itemId: string;
  count: number;
}

export interface GrowthEvent {
  from: PetView['stage'];
  to: PetView['stage'];
  coins: number;
}

export interface StateResponse {
  pet: PetView | null;
  coins: number;
  inventory: InventoryEntry[];
  chat?: ChatTurn[];
  report?: AwayReport;
  growth?: GrowthEvent | null;
  /** サーバ側でペット同士の交流を裏で走らせ始めた。 */
  encounterPending?: boolean;
}

export interface CareResponse {
  pet: PetView;
  reply: PetReply;
  llmError?: string;
  inventory: InventoryEntry[];
  coins: number;
  growth?: GrowthEvent | null;
}

export interface ChatResponse {
  pet: PetView;
  reply: PetReply;
  llmError?: string;
}

export interface ThinkResponse {
  pet: PetView;
  reply: PetReply | null;
  skipped?: boolean;
  llmError?: string;
}

export interface DiscoverResponse {
  /** もらえたコイン（レート制限中は 0）。 */
  coins: number;
  /** 発見が記憶に残ったか。 */
  remembered: boolean;
}

export const api = {
  health: () => request<{ ok: boolean; llm: boolean; model: string | null }>('/health'),

  me: () =>
    request<{ user: { id: number; name: string } | null; coins?: number; hasPet?: boolean }>(
      '/auth/me',
    ),
  register: (name: string, password: string) =>
    post<{ user: { id: number; name: string } }>('/auth/register', { name, password }),
  login: (name: string, password: string) =>
    post<{ user: { id: number; name: string } }>('/auth/login', { name, password }),
  logout: () => post<{ ok: boolean }>('/auth/logout'),

  createPet: (name: string, species: SpeciesId) =>
    post<{ pet: PetView }>('/pet/create', { name, species }),
  state: (social = true) => request<StateResponse>(`/pet/state?social=${social ? 1 : 0}`),
  care: (payload: { itemId?: string; kind?: 'pet' }) => post<CareResponse>('/pet/care', payload),
  chat: (text: string) => post<ChatResponse>('/pet/chat', { text }),
  /** spotId を渡すと「いまどこにいるか」を独り言の材料にしてくれる。 */
  think: (spotId?: string | null) => post<ThinkResponse>('/pet/think', { spotId }),
  /**
   * 自律行動中の発見をサーバに知らせる。
   * 文章はサーバが shared/world.ts から引くので、クライアントは場所と番号だけ送る
   * （クライアントの文字列をそのままプロンプトや記憶に入れない）。
   */
  discover: (spotId: string, findIndex: number) =>
    post<DiscoverResponse>('/pet/discover', { spotId, findIndex }),
  greet: (hoursAway: number) => post<ThinkResponse>('/pet/greet', { hoursAway }),
  markEncountersSeen: () => post<{ ok: boolean }>('/pet/encounters/seen'),

  growthSeen: () => post<{ ok: boolean }>('/pet/growth/seen'),

  gameStart: () =>
    post<{
      round: number;
      rounds: number;
      startBox: number;
      swaps: Array<[number, number]>;
      hintBox: number | null;
      behavior: string;
    }>('/pet/game/start'),
  gameGuess: (box: number) =>
    post<{
      correct: boolean;
      answer: number;
      finished: boolean;
      hits: number;
      rounds: number;
      round?: number;
      coins: number;
      startBox?: number;
      swaps?: Array<[number, number]>;
      hintBox?: number | null;
      pet: PetView;
    }>('/pet/game/guess', { box }),

  memory: () => request<{ facts: MemoryFact[]; episodes: MemoryEpisode[] }>('/pet/memory'),
  saveFact: (key: string, value: string) =>
    request<{ facts: MemoryFact[] }>(`/pet/memory/fact/${encodeURIComponent(key)}`, {
      method: 'PUT',
      body: JSON.stringify({ value }),
    }),
  deleteFact: (key: string) =>
    request<{ facts: MemoryFact[] }>(`/pet/memory/fact/${encodeURIComponent(key)}`, {
      method: 'DELETE',
    }),
  updateEpisode: (id: number, patch: { summary?: string; importance?: number; faded?: boolean }) =>
    request<{ episodes: MemoryEpisode[] }>(`/pet/memory/episode/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  deleteEpisode: (id: number) =>
    request<{ episodes: MemoryEpisode[] }>(`/pet/memory/episode/${id}`, { method: 'DELETE' }),

  users: () =>
    request<{
      users: Array<{
        userId: number;
        userName: string;
        petName: string | null;
        petSpecies: SpeciesId | null;
        isFriend: boolean;
      }>;
    }>('/social/users'),
  friends: () => request<{ friends: FriendView[] }>('/social/friends'),
  addFriend: (userId: number) => post<{ ok: boolean }>('/social/friends', { userId }),
  removeFriend: (userId: number) =>
    request<{ ok: boolean }>(`/social/friends/${userId}`, { method: 'DELETE' }),
  visitRoom: (userId: number) =>
    request<{
      host: { id: number; name: string };
      layout: RoomLayout;
      pet: {
        name: string;
        species: SpeciesId;
        stage: string;
        action: string;
        emotion: string;
      } | null;
    }>(`/social/room/${userId}`),
  visits: () => request<{ visits: VisitView[] }>('/social/visits'),
  sendGift: (userId: number, itemId: string, message: string) =>
    post<{ ok: boolean }>('/social/gift', { userId, itemId, message }),
  claimGift: (id: number) => post<{ ok: boolean }>(`/social/gift/${id}/claim`),
  runEncounter: (force = false) =>
    post<{ encounter: EncounterView | null; error?: string }>('/social/encounter', { force }),
  encounters: () => request<{ encounters: EncounterView[] }>('/social/encounters'),

  promises: () => request<{ promises: PromiseView[] }>('/social/promises'),
  addPromise: (text: string) => post<{ ok: boolean }>('/social/promises', { text }),
  completePromise: (id: number) => post<{ ok: boolean }>(`/social/promises/${id}/done`),

  room: () => request<{ layout: RoomLayout; walls: string[]; floors: string[] }>('/room'),
  saveRoom: (layout: RoomLayout) =>
    request<{ layout: RoomLayout }>('/room', { method: 'PUT', body: JSON.stringify(layout) }),
  shop: () => request<{ items: ItemDef[] }>('/room/shop'),
  buy: (itemId: string) => post<{ ok: boolean; coins: number }>('/room/shop/buy', { itemId }),
};

export type { GiftView };
