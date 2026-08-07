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

/**
 * 個体数の上限（性能の安全弁）。
 * 150に上げたら秋に150まで増えて冬に24体まで崩壊した（増えすぎた島は冬を越せない）。
 * 120に戻し、上限より先に食料（RELATION.breedFoodPerCapita）が効くようにしている。
 */
export const MAX_CRITTERS = 120;
export const MIN_CRITTERS = 40;
/**
 * 90だと島の収容力（春〜秋で100〜120、冬は70前後）を最初から超えていて、
 * 開始から数島日で40体が餓死する立ち上がりになった。
 * 収容力より少なく始めて「島が埋まっていく」形にする。
 */
export const INITIAL_CRITTERS = 70;

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
/**
 * 何も届かなくなってから接続を切るまでの時間（ms）。
 *
 * クライアントは5秒ごとに ping を送る。回線が切れた・端末がスリープした場合は
 * TCPのFINが来ないまま無音になるので、これが無いとアバターが島に残り続ける。
 * 6回分見送る長さにして、一時的な詰まりでは切らない。
 */
export const CLIENT_IDLE_TIMEOUT_MS = 30_000;
/** 無音のクライアントを探す間隔（tick）。10秒ごと */
export const IDLE_SWEEP_INTERVAL_TICKS = 40;

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

  /**
   * traits による増加速度の振れ幅。0.5を中心に (1 ± factor/2) 倍になる。
   * 例: hungerGluttonyFactor 0.8 なら gluttony 0 で0.6倍・1で1.4倍
   */
  hungerGluttonyFactor: 0.8,
  /** energy が高いほど眠気が遅い */
  sleepEnergyFactor: 0.6,
  socialSociabilityFactor: 0.8,
  curiosityTraitFactor: 0.6,
  /** 夜は眠気の進みが速い（夜に寝る習性を作る） */
  sleepNightMultiplier: 1.5,
  /** 睡眠中は代謝が落ちて空腹の進みが遅い */
  sleepHungerMultiplier: 0.5,
  /** 安全欲は脅威が去れば自然に収まる（上げるのは critter.ts） */
  safetyRecoverPerIslandHour: 12,

  /** この空腹を超えると健康が減る */
  starvationHunger: 100,
  /**
   * 8だと冬に全個体が同時に空腹の限界に達し、死が連鎖して個体数が36まで落ちた（下限40を割った）。
   * 4にして「ひと冬なら耐えられる」体力にし、弱い個体から順に減るようにしている。
   */
  starvationHealthPerIslandHour: 4,
  /** 空腹が落ち着いていれば健康は戻る */
  healthRecoverPerIslandHour: 2,
  healthRecoverHungerBelow: 50,

  /** urgency() のカーブ。前半は t^pow で緩く、後半は lateStart から smoothstep で急に立てる */
  urgencyPow: 2.5,
  urgencyLateStart: 0.6,
  urgencyLateWeight: 0.4,
} as const;

// ---------- 資源 ----------
export const RESOURCE = {
  berryTreeMax: 6,
  /**
   * 0.6だと食料の供給が需要の5倍になり、資源が常に満タン＝取り合いが起きなかった
   * （「実りが少ない年はケンカも増える」が成立しない）。
   * 120体の需要が約600/島日なので、春 約900・冬 約350/島日 になるよう絞っている。
   */
  berryRegenPerIslandHour: 0.15,
  fieldMax: 10,
  fieldRegenPerIslandHour: 0.2,
  /** 釣り場は木の実より渋い */
  fishingSpotMax: 4,
  fishingRegenPerIslandHour: 0.5,
  /** 水場は実質枯れない（喉の渇きで詰まらせない） */
  waterSourceMax: 20,
  waterRegenPerIslandHour: 20,
  /** 水やりの効果が続く島時間 */
  wateredIslandHours: 6,
  /** 水やり中の回復倍率 */
  wateredRegenMultiplier: 2,
  /** 荒廃度の増加/減衰 */
  decayPerHarvest: 8,
  decayRecoverPerIslandHour: 3,
  maxDecay: 100,

  /** 資源の回復は毎tickではなく、このtick数ごとにまとめて行う（走査回数を減らす） */
  regenEveryTicks: 10,
  /**
   * 荒廃度の自然減衰は全16384タイルを分割走査する。
   * everyTicks ごとに 1/slices ぶんだけ触るので、1周は slices × everyTicks tick かかる。
   */
  decaySweepSlices: 64,
  decaySweepEveryTicks: 4,
  /** 荒廃度が最大のタイルは回復量が (1 - この値) 倍になる（荒らした畑は戻りが遅い） */
  decayRegenPenalty: 0.8,
} as const;

// ---------- 関係性・世代 ----------
export const RELATION = {
  updateEveryTicks: 20,
  /**
   * 5秒ごとの交流1回あたりの好感度上昇。
   * 0.5だと7島日回しても友達が4組しか生まれず、子が1匹も生まれなかったので上げた
   * （繁殖が止まると個体は寿命で減るだけになり、「世代が続く島」が成立しない）。
   */
  socializeGain: 1.4,
  /**
   * ただ近くにいるだけでも少しずつ馴染む（群れの生活）。
   * 0.15にしたら1島日で個体数が上限に張り付いたので、
   * 「数島時間いっしょに過ごしてようやく番になる」速さ（0.02 ≒ 14/島時間）に落とした。
   */
  proximityGain: 0.02,
  quarrelLoss: 2,
  befriendThreshold: 60,
  /** 繁殖のしきい値は「仲良し」より手前に置く（友達になる前から番になりうる） */
  breedThreshold: 45,
  adultAgeDays: 8,
  lifespanDaysMin: 60,
  lifespanDaysMax: 120,
  maxRelationsPerActor: 24,
  /**
   * 1島日に生まれる数の上限（現在の個体数に対する比率）。
   * 条件を満たすペアが一斉に繁殖すると1日で上限に張り付くため、増え方をなだらかにする。
   */
  maxBirthsPerDayRatio: 0.05,
  /**
   * 1個体あたりこれだけの食料があれば出生率が満額になる（下回ると比例して落ちる）。
   * 食べものが足りない年は増えない、という釣り合いを作るための基準値。
   * 6だと個体数の上限に達するまで増え続けたので、上限より先にここが効くよう 9 にした。
   */
  breedFoodPerCapita: 9,
} as const;

// ---------- 初期配置 ----------
export const SPAWN = {
  /** 初期個体の年齢は 0〜寿命×この比率 に散らす（全員が同時に寿命を迎えないように） */
  initialAgeMaxRatio: 0.6,
  /** 配置タイルを探す試行回数 */
  findTileMaxTries: 64,
  /** 初期配置で他個体とこれだけ離す（タイル） */
  minSpacing: 0.8,
} as const;

/** 季節ごとの倍率と天気テーブル（clear/cloudy/rain/fog の重み） */
export const SEASON_TABLE = {
  spring: { regen: 1.3, weather: [45, 30, 20, 5], birthRate: 1.8 },
  summer: { regen: 1.1, weather: [60, 20, 18, 2], birthRate: 1.0 },
  autumn: { regen: 1.5, weather: [50, 30, 15, 5], birthRate: 0.8 },
  // 冬は設計書どおりの 0.5。
  // 一時 0.75 に緩めていたのは「ほぼ空の資源を選び続けて餓死する」バグの影響で
  // 大量死していたためで、findNearestResource に minAmount を入れて直したので戻した。
  winter: { regen: 0.5, weather: [35, 35, 15, 15], birthRate: 0.2 },
} as const;

// ---------- catch-up ----------
/** tickループが1フレームで追いつく上限 */
export const MAX_CATCHUP_STEPS = 8;
/** 停止中の空白を埋める上限（島時間） */
export const MAX_FASTFORWARD_ISLAND_HOURS = 24;
