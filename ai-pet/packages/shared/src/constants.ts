/**
 * ゲームバランスに関わる定数はすべてここに集約する。
 * （docs/02_ゲーム実装プラン/10_テストと品質.md §7 の方針）
 * マジックナンバーを各モジュールに散らさないこと。
 */

// ---------- 時間 ----------
export const TICK_HZ = 4;
export const TICK_MS = 1000 / TICK_HZ;
/** 1tickあたりの秒数 */
export const TICK_SEC = 1 / TICK_HZ;

/** 島の1日 = 実時間60分 */
export const ISLAND_DAY_MINUTES = 60;
export const TICKS_PER_ISLAND_DAY = ISLAND_DAY_MINUTES * 60 * TICK_HZ; // 14400
/** 島の1時間（島の1日を24分割したもの） */
export const TICKS_PER_ISLAND_HOUR = TICKS_PER_ISLAND_DAY / 24; // 600
export const DAYS_PER_SEASON = 7;

/** 時間帯の境界（島日の進行度 0..1） */
export const TIME_OF_DAY_BOUNDS = {
  morning: 0.0,
  day: 0.25,
  evening: 0.55,
  night: 0.75,
} as const;

// ---------- マップ ----------
export const MAP_W = 128;
export const MAP_H = 128;
export const CHUNK = 16;
export const CHUNKS_X = MAP_W / CHUNK;
export const CHUNKS_Y = MAP_H / CHUNK;
/** 1タイルの描画ピクセル数 */
export const TILE_PX = 32;
/** キャラクタースプライトの基準サイズ */
export const CHAR_PX = 48;

// ---------- アクター ----------
export const ACTOR_RADIUS = 0.35;
export const PLAYER_SPEED = 3.2; // タイル/秒
export const CRITTER_SPEED_BASE = 1.6;
export const PET_SPEED = 3.0;

export const MAX_CRITTERS = 120;
export const MIN_CRITTERS = 40;
export const INITIAL_CRITTERS = 90;

// ---------- ネットワーク ----------
export const DEFAULT_PORT = 8787;
export const BROADCAST_EVERY_TICK = 1;
export const SNAPSHOT_INTERVAL_TICKS = 120; // 30秒
/** クライアントの補間バッファ（ms） */
export const INTERP_DELAY_MS = 150;
/** 興味管理: 視界の最大タイル数 */
export const VIEW_MAX_W = 40;
export const VIEW_MAX_H = 24;
/** 視界に加える余裕（タイル） */
export const VIEW_MARGIN = CHUNK;
export const MAX_PLAYERS_PER_ISLAND = 16;

// ---------- レート制限（1プレイヤーあたり） ----------
export const RATE_LIMITS = {
  move: { perSec: 20 },
  moveAxis: { perSec: 20 },
  interact: { perSec: 4 },
  say: { perSec: 0.5, perHour: 60 },
  place: { perSec: 1, perHour: 30 },
  chunkReq: { perSec: 8 },
} as const;

// ---------- LLM ----------
export const LLM = {
  /** ペットの行動決定の間隔（オーナー接続中） */
  decideIntervalTicksOnline: 90 * TICK_HZ,
  /** ペットの行動決定の間隔（オーナー不在） */
  decideIntervalTicksOffline: 600 * TICK_HZ,
  /** intentの有効期間 */
  intentTtlTicks: 90 * TICK_HZ,
  /** 行動決定の最短クールダウン */
  decideCooldownTicks: 30 * TICK_HZ,
  /** ペット間会話のクールダウン（オーナー接続中 / 不在） */
  petTalkCooldownTicksOnline: 5 * 60 * TICK_HZ,
  petTalkCooldownTicksOffline: 20 * 60 * TICK_HZ,

  timeoutMs: { dialogue: 8000, firstToken: 3000, decide: 6000, diary: 20000, petTalk: 8000 },
  maxConcurrent: 8,
  /** 記憶検索で渡す上限 */
  maxMemories: 8,
  maxMemoryChars: 600,
  maxNearby: 8,
  maxChatTurns: 3,
  maxSummaryChars: 400,
  /** サーキットブレーカ */
  breaker: { window: 20, failRatio: 0.5, openMs: 5 * 60 * 1000 },
} as const;

// ---------- 欲求 ----------
export const NEEDS = {
  /** 1島時間あたりの増加量（0..100スケール） */
  hungerPerIslandHour: 6,
  sleepPerIslandHour: 5,
  socialPerIslandHour: 4,
  curiosityPerIslandHour: 3,
  /** 満たしたときの減少量 */
  eatRelief: 45,
  drinkRelief: 20,
  sleepReliefPerIslandHour: 25,
  socializeRelief: 30,
} as const;

// ---------- 資源 ----------
export const RESOURCE = {
  berryTreeMax: 6,
  berryRegenPerIslandHour: 0.6,
  fieldMax: 10,
  fieldRegenPerIslandHour: 0.4,
  /** 荒廃度の増加/減衰 */
  decayPerHarvest: 8,
  decayRecoverPerIslandHour: 3,
  maxDecay: 100,
} as const;

// ---------- 関係性・世代 ----------
export const RELATION = {
  updateEveryTicks: 20,
  socializeGain: 0.5,
  quarrelLoss: 2,
  befriendThreshold: 60,
  breedThreshold: 60,
  adultAgeDays: 8,
  lifespanDaysMin: 60,
  lifespanDaysMax: 120,
  maxRelationsPerActor: 24,
} as const;

/** 季節ごとの倍率と天気テーブル（clear/cloudy/rain/fog の重み） */
export const SEASON_TABLE = {
  spring: { regen: 1.3, weather: [45, 30, 20, 5], birthRate: 1.8 },
  summer: { regen: 1.1, weather: [60, 20, 18, 2], birthRate: 1.0 },
  autumn: { regen: 1.5, weather: [50, 30, 15, 5], birthRate: 0.8 },
  winter: { regen: 0.5, weather: [35, 35, 15, 15], birthRate: 0.2 },
} as const;

// ---------- catch-up ----------
/** tickループが1フレームで追いつく上限 */
export const MAX_CATCHUP_STEPS = 8;
/** 停止中の空白を埋める上限（島時間） */
export const MAX_FASTFORWARD_ISLAND_HOURS = 24;
