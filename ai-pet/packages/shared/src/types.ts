/** クライアント・サーバ共通の型定義（docs/02_ゲーム実装プラン/03_データモデル.md） */

export type EntityId = number;
export type PlayerId = string;

export interface Vec2 {
  x: number;
  y: number;
}

export type TimeOfDay = 'morning' | 'day' | 'evening' | 'night';
export type Season = 'spring' | 'summer' | 'autumn' | 'winter';
export type Weather = 'clear' | 'cloudy' | 'rain' | 'fog';

export const SEASONS: readonly Season[] = ['spring', 'summer', 'autumn', 'winter'];
export const WEATHERS: readonly Weather[] = ['clear', 'cloudy', 'rain', 'fog'];

export interface ClockState {
  tick: number;
  islandDay: number;
  /** 島日の進行度 0..1 */
  dayProgress: number;
  timeOfDay: TimeOfDay;
  season: Season;
  weather: Weather;
}

// ---------- 地形 ----------
export type Terrain = 'grass' | 'dirt' | 'sand' | 'water' | 'forest' | 'plaza';
export const TERRAINS: readonly Terrain[] = ['grass', 'dirt', 'sand', 'water', 'forest', 'plaza'];

export interface Tile {
  terrain: Terrain;
  walkable: boolean;
  /** 荒廃度 0..100 */
  decay: number;
  resourceId?: EntityId;
}

// ---------- アクター ----------
export type ActorKind = 'critter' | 'pet' | 'player';
export type Facing = 'n' | 'e' | 's' | 'w';
export const FACINGS: readonly Facing[] = ['n', 'e', 's', 'w'];
export type AnimName = 'idle' | 'walk' | 'act' | 'sleep' | 'talk';
export const ANIMS: readonly AnimName[] = ['idle', 'walk', 'act', 'sleep', 'talk'];

/** 0..100（0=満たされている, 100=切迫） */
export interface Needs {
  hunger: number;
  sleep: number;
  social: number;
  safety: number;
  curiosity: number;
}

/** 性格。0..1。親から遺伝する */
export interface Traits {
  energy: number;
  sociability: number;
  caution: number;
  gluttony: number;
  curiosity: number;
}

export type ActionKind =
  | 'idle'
  | 'wander'
  | 'goto'
  | 'eat'
  | 'drink'
  | 'sleep'
  | 'socialize'
  | 'flee'
  | 'nest'
  | 'harvest'
  | 'water'
  | 'pet'
  | 'talk'
  | 'follow'
  | 'explore'
  | 'help';

export interface ActiveAction {
  kind: ActionKind;
  targetEntity?: EntityId;
  targetTile?: Vec2;
  startedAtTick: number;
  durationTicks: number;
}

export type PetGoal =
  | 'follow_owner'
  | 'explore'
  | 'visit_friend'
  | 'gather'
  | 'help_critter'
  | 'rest'
  | 'watch_stars'
  | 'talk_to';

export const PET_GOALS: readonly PetGoal[] = [
  'follow_owner',
  'explore',
  'visit_friend',
  'gather',
  'help_critter',
  'rest',
  'watch_stars',
  'talk_to',
];

export interface PetIntent {
  goal: PetGoal;
  targetEntity?: EntityId;
  targetTile?: Vec2;
  /** 1文。デバッグ表示と日記の材料 */
  reason: string;
  expiresAtTick: number;
}

export interface Actor {
  id: EntityId;
  kind: ActorKind;
  /** アセット名と一致させる（例: rabbit, mofi） */
  species: string;
  name: string;
  pos: Vec2;
  facing: Facing;
  speed: number;
  anim: AnimName;

  needs: Needs;
  traits: Traits;
  ageDays: number;
  lifespanDays: number;
  health: number;

  action: ActiveAction | null;
  path: Vec2[] | null;

  // ペットのみ
  ownerId?: PlayerId;
  affection?: number;
  intent?: PetIntent | null;
}

// ---------- 資源・設置物 ----------
export type ResourceType = 'berry_tree' | 'field' | 'fishing_spot' | 'water';

export interface ResourceNode {
  id: EntityId;
  type: ResourceType;
  pos: Vec2;
  amount: number;
  max: number;
  regenPerIslandHour: number;
  wateredUntilTick?: number;
}

/**
 * 設置物の種別。
 *
 * 前半4種はプレイヤーが置けるもの（`PlaceMsg` の z.enum と一致させる）。
 * `well` / `observatory` は**共同建設の完成物**なので、プレイヤーからは置けない
 * （`PlaceMsg` 側には足さないこと）。
 *
 * `house_a`〜`fence_v` は**島の生成時に worldgen が置く「暮らしの痕跡」**（C-1 / C-2）。
 * これもプレイヤーは置けないので `PlaceMsg` 側には足さない。
 * 柵は向きで絵が変わるため、1種別＋回転ではなく `fence_h` / `fence_v` の2種別にしている
 * （`objects.ts` は `obj_<type>.png` をそのまま引くだけで回転を持たないため）。
 */
export type PlaceableType =
  | 'bench'
  | 'flowerbed'
  | 'lantern'
  | 'signboard'
  | 'well'
  | 'observatory'
  | 'house_a'
  | 'house_b'
  | 'house_c'
  | 'windmill'
  | 'fountain'
  | 'fence_h'
  | 'fence_v';

export interface Placeable {
  id: EntityId;
  type: PlaceableType;
  pos: Vec2;
  ownerId: PlayerId;
  /** 動物を引き寄せる強さ */
  attract: number;
}

export type ConstructionType = 'bridge' | 'well' | 'observatory';

export interface Construction {
  id: EntityId;
  type: ConstructionType;
  pos: Vec2;
  progress: number;
  contributions: Record<PlayerId, number>;
  completedAtTick?: number;
}

// ---------- ペット ----------
export type PetSpecies = 'mofi' | 'mizune' | 'hakka' | 'momona' | 'hoshira';
export const PET_SPECIES: readonly PetSpecies[] = ['mofi', 'mizune', 'hakka', 'momona', 'hoshira'];

export interface PetPersona {
  species: PetSpecies;
  name: string;
  archetype: string;
  traitTags: string[];
  catchphrase: string;
  likes: string;
  dislikes: string;
  speechStyle: string;
}

// ---------- イベント ----------
export type IslandEventKind =
  | 'born'
  | 'died'
  | 'quarrel'
  | 'befriend'
  | 'harvest'
  | 'build'
  | 'weather'
  | 'player_say'
  | 'pet_say';

export interface IslandEvent {
  kind: IslandEventKind;
  tick: number;
  islandDay: number;
  actorId?: EntityId;
  targetId?: EntityId;
  pos?: Vec2;
  /** 日本語1文 */
  text: string;
  /** 1..10 */
  importance: number;
}
