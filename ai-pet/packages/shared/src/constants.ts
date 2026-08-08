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
  /**
   * 撤去（G-5）。成功のたびに周辺のクライアントへ snapshot を配り直すので、
   * 連打されると1回の操作が人数ぶんの送信に膨らむ。設置と同じ 1/秒 に抑える。
   */
  remove: { perSec: 1 },
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
  /**
   * 荒廃度の増加/減衰（G-4）。
   *
   * 8 / 3 では**荒れが画面に出なかった**（M3申し送り2「最大0.7%では見えない」）。
   * 原因はバランスの向きで、木1本が生む収穫は 0.15/島時間 しかないので
   * 増加の上限が 8×0.15 = 1.2/島時間 しかなく、減衰 3/島時間 に必ず負けて0へ戻っていた
   * （実った実をまとめて採った瞬間だけ茶色くなり、数島時間で消える）。
   *
   * 20 / 2 にした根拠:
   * - プレイヤーの収穫が効く。畑（fieldMax=10）を採り切ると 20×5 = 100 で真っ茶色になり、
   *   減衰 2/島時間 なので白に戻るまで約2島日かかる
   *   （宣伝資料「荒らした畑は戻るのに時間がかかる」がこれで初めて画面に出る）
   * - 動物だけでも通われている木の実の木・釣り場・畑が p90 で 33〜49 まで上がる（実測）。
   *   30 に上げても平均はむしろ下がった。`WEIGHTS.decayAversion` で動物が荒れた場所を避け、
   *   `decayRegenPenalty` で実りも落ちるため、強くすると散らばって薄まる（負のフィードバック）
   *
   * 上げすぎると `decayRegenPenalty` 経由で食料が減って餓死が連鎖する。
   * この値で `npm run sim:long 21` を回し、個体数 70→120（14島日で頭打ち）・死亡0件を確認している。
   */
  decayPerHarvest: 20,
  decayRecoverPerIslandHour: 2,
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

// ---------- 動物のユーティリティAI（critter.ts の重み） ----------

/**
 * 動物の行動選択（`sim/critter.ts`）のバランス値。
 * M3の時点では critter.ts の中に置いていたが（当時 constants.ts を別作業者が編集中だった）、
 * 定数は1か所に集約する方針なのでここへ移した。critter.ts は `WEIGHTS` としてこれを参照する。
 *
 * base の値は「その行動が最も切迫したときのスコアの上限」の目安。
 *   flee 220  … 生命の危機。ほぼ何にでも勝つ
 *   eat/sleep 100 … 生活の主軸。この2つが日中/夜で入れ替わるのが「昼は働き夜は寝る」の核
 *   drink 78 / socialize 72 / nest 62 … 主軸の隙間に入る行動
 *   rainShelter 62 … 平常時のeat(数点)には勝ち、切迫した空腹(50点前後)には負ける強さ。
 *                    「雨でも腹が減れば出ていく」ようにしたいのでこの位置
 *   wander 14 … 何もないときの基礎値。他が0に近いときだけ勝つ
 */
export const CRITTER_WEIGHTS = {
  base: {
    eat: 100,
    /** 78だと水飲みが交流を押しのけて群れができなかったので下げた */
    drink: 62,
    sleep: 100,
    /** 交流は「群れが生まれる」ための行動。水飲みより優先されるべき */
    socialize: 84,
    flee: 220,
    nest: 62,
    wander: 14,
    goto: 58,
    /** 雨のときだけ出る「森へ避難」候補（kindは goto） */
    rainShelter: 62,
  },
  /** 距離の減衰スケール（このタイル数離れるとスコアが半分になる） */
  distScale: {
    /** 食料は遠くても行く価値がある */
    eat: 20,
    drink: 16,
    /** 寝床は近いところで済ませたい */
    sleep: 10,
    /**
     * 交流の距離減衰。
     * D-7 で 8 まで詰めてみたが、団子は減らず友達の組数だけ落ちた（実測 clump 0.87→0.89 / 友達 -0.5%）。
     * 団子の原因は交流ではなく水場だったので、ここは M3 の 12 のまま。
     */
    socialize: 12,
    nest: 14,
    goto: 18,
    shelter: 20,
  },
  /** 現在の行動への継続ボーナス（docs 04章 §4 の +15） */
  hysteresis: 15,

  /** 探索半径。curiosity で ±20%、霧の日は狭くなる */
  searchRadiusBase: 22,
  fogSearchScale: 0.6,
  /** 空腹が切迫すると食料の探索半径がこの倍率ぶん広がる（1.5 → 最大2.5倍） */
  hungerSearchSpan: 1.5,
  /** 交流相手・脅威を探す半径（全アクター走査を1回で済ませるため共通化する） */
  nearRadius: 14,

  /** traits の効き方。いずれも base + trait * span 倍 */
  trait: {
    gluttonyBase: 0.6,
    gluttonySpan: 0.8,
    /** energy が高い個体は夜更かしする（= sleep が上がりにくい） */
    sleepEnergyBase: 1.3,
    sleepEnergySpan: -0.6,
    sociabilityBase: 0.5,
    sociabilitySpan: 1.0,
    cautionBase: 0.4,
    cautionSpan: 1.0,
    curiosityBase: 0.6,
    curiositySpan: 0.8,
  },

  /** 時間帯 */
  time: {
    sleepNight: 1.6,
    sleepEvening: 1.0,
    sleepDay: 0.45,
    /**
     * 夜だけ加える下駄。
     * 掛け算だけだと「眠気がまだ低い夜」に eat/wander が勝ってしまい、
     * 「夜間睡眠率6割」の不変条件を満たせない。夜に限って sleep に床を作る。
     */
    sleepNightFloor: 26,
    eatDay: 1.15,
    eatNight: 0.6,
    socialDay: 1.15,
    socialNight: 0.35,
    wanderNight: 0.4,
  },

  /** 天気 */
  weather: {
    /** 雨の屋外行動は -30%（docs 04章 §2） */
    rainOutdoor: 0.7,
    /** 霧は見通しが悪いだけなので減衰は軽い */
    fogOutdoor: 0.9,
    /** 水を飲むのは雨でも苦にならない */
    rainDrink: 0.85,
    /** 雨は巣づくり・木の下が有利 */
    rainNest: 1.3,
    /** 夜は避難より睡眠を優先させる */
    rainShelterNight: 0.6,
    /** 空腹が切迫すると避難の魅力がこの割合まで下がる（雨でも食べに出る） */
    rainShelterHungerRelief: 0.85,
  },

  /** 季節。冬は巣ごもり、春は巣づくり（繁殖準備）、夏は水場 */
  season: {
    nest: { spring: 1.4, summer: 0.9, autumn: 1.0, winter: 1.6 },
    thirst: { spring: 1.0, summer: 1.4, autumn: 1.0, winter: 0.8 },
  },

  /** 荒廃度100のタイルはスコアがこの割合だけ下がる（荒れた場所を避ける） */
  decayAversion: 0.4,

  /**
   * 設置物の attract の基準値。attract/attractRef 倍（上限 attractMax）。
   *
   * D-7 で下げようとしたが**やめた**。長期シミュレーションに出てくる設置物（家・噴水・巣・茂み）は
   * すべて attract 0 で、attract を持つのは**プレイヤーが置いたベンチ等だけ**なので効果を実測できない。
   * 「ベンチを置くと動物が集まる」（M7の要件）を弱めるより、
   * 集まりすぎだけを `crowd` の割引で抑える方針にした。
   */
  attractRef: 5,
  attractMax: 2.5,

  /**
   * 密集の抑制（D-7）。
   *
   * 目的地の周りに既に何体いるかで、その候補のスコアを割り引く。
   * **群れそのものは正しい挙動**なので、つがい・小群（free 体まで）は割り引かない。
   * 「同じ相手・同じ寝床・同じ設置物へ4体目以降が向かう」ぶんだけを弱める。
   *
   * radius は描画側の `crowdOffset`（3体以上を扇状にほぐす）が効き始める距離と揃えた。
   * floor を 0 にはしない。0にすると密集地から**全員が離れて**交流が途切れ、
   * M3で `socializeGain` を上げてやっと成立した繁殖（友達→番→出生）が止まる。
   */
  crowd: {
    /** 目的地の周囲をこの半径（タイル）で数える */
    radius: 1.2,
    /** ここまでは割り引かない（自分を含めない他個体の数） */
    free: 2,
    /** free を超えた1体ごとにこの割合だけ下げる */
    penaltyPerActor: 0.18,
    /** 下限。ここまでしか下がらない（群れを解散させないための床） */
    floor: 0.35,
  },

  /** 脅威 */
  threat: {
    /** プレイヤーはこの距離まで近づくと怖い */
    playerRadius: 7,
    /**
     * 大型個体（いのしし）はこの距離。
     * 5だと100体の島で逃走が常時発生し（評価の8%）夜も眠れなかったため 3.5 に下げた。
     */
    bigRadius: 3.5,
    /** 寝ている個体が起きて逃げ出す距離 */
    wakeRadius: 1.8,
    /** 逃げる距離 */
    fleeDistance: 6,
  },

  /** 行動の所要tick。250ms/tick */
  duration: {
    eat: 12,
    /** 8tickだと水飲みが毎秒切り替わって行動ログが埋まったので伸ばした */
    drink: 24,
    /** 1.5島時間ぶん眠る。夜（15分=3600tick）で2〜3回に分かれる */
    sleep: Math.round(TICKS_PER_ISLAND_HOUR * 1.5),
    /** 交流は好感度が育つのに時間が要る（1回20tickだと友達ができなかった） */
    socialize: 60,
    nest: 40,
    wander: 24,
    goto: 16,
    flee: 12,
    other: 8,
  },

  /** 目的地に「着いた」とみなす距離 */
  actRange: 1.2,
  /** 1tickに発行する経路探索リクエストの上限（nav は1tick8件処理） */
  navRequestsPerTick: 6,
  /** 経路が引けなかったときの再要求間隔 */
  navRetryTicks: 8,
  /** これだけ移動しても着かない目的地は諦める（到達不能な島の向こう側など） */
  travelTimeoutTicks: 320,
  /** 1回の採食で取る量 */
  eatPortion: 1.5,
  /** 1回の水飲みで取る量 */
  drinkPortion: 1,
  /**
   * 空腹が0でも水を飲みに行く度合い（D-7）。
   * 0.15 だと**暇な個体が全員水際に立ち続けて**、団子の主因になっていた
   * （水場は島に20か所しかないので120体が6体ずつに分かれて溜まる）。
   */
  drinkIdleNeed: 0.05,
  /** 森タイル探索の結果をキャッシュするtick数（毎回リング探索すると重い） */
  shelterCacheTicks: 80,
  /** 森タイルを探す最大半径 */
  shelterMaxRadius: 12,
  /** 徘徊の目標距離 */
  wanderRadius: 8,
  wanderMinRadius: 3,
  /** 徘徊先を選び直す間隔（ヒステリシスを壊さないよう目標を固定する） */
  wanderBlockTicks: 24,
  /**
   * 巣の設置物を掃除・補充する間隔（C-3）。
   * 死んだ個体の巣を消さないと設置物が無限に増える。
   * 毎tick走らせても O(設置物数) だが、見た目の反映は数秒遅れて構わないので10秒に1回にした。
   */
  nestSyncTicks: 40,
  /** 巣タイルが他個体の巣で埋まっていたときに、代わりの空きタイルを探す半径 */
  nestSpreadRadius: 3,
  /** time slicing の分割数 */
  sliceMod: 8,
} as const;

// ---------- 初期配置 ----------
export const SPAWN = {
  /** 初期個体の年齢は 0〜寿命×この比率 に散らす（全員が同時に寿命を迎えないように） */
  initialAgeMaxRatio: 0.6,
  /** 配置タイルを探す試行回数 */
  findTileMaxTries: 64,
  /**
   * 初期配置で他個体とこれだけ離す（タイル・D-7）。
   *
   * 0.8 では**同じタイルを禁止するだけ**だった（タイル中心に置くので隣タイルの距離は 1.0）。
   * 隣り合ったまま70体置かれるので、開始直後の広場周辺が団子に見えた。
   * 3.5 は「動物の絵（48px＝1.5タイル）が2体ぶん離れる」距離。
   * これ以上（5以上）にすると好適地形の狭い種（frog=水辺 / squirrel=森）が置けなくなり、
   * 緩和ばかり走って結局まとまるので、置き切れる範囲でいちばん広い値にしている。
   */
  minSpacing: 3.5,
  /**
   * 間隔を緩める段階（minSpacing への倍率）。
   *
   * ⚠️ 置けずに個体数が減ると「開始時の個体数」が変わってバランスが崩れる
   * （`INITIAL_CRITTERS` は 70 で釣り合いを取っている）。
   * 好適地形が狭い種でも必ず置き切れるよう、最後は 0（間隔なし）まで緩める。
   */
  spacingRelaxSteps: [1, 0.6, 0.35, 0],
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
