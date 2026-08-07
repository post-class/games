/**
 * ペットのDeliberative層（docs/02_ゲーム実装プラン/07_ペットAI設計.md §4）
 *
 * 宣伝資料の「自律行動：次に何をするかをペット自身が選ぶ」の中身。
 *
 * 設計の要点:
 *  1. **tick を止めない**。`update()` は「決定を走らせる価値があるか」だけを見て、
 *     実際のLLM呼び出しは非同期に投げる。1ペット1本まで（`inFlight`）。
 *  2. **選べるかどうかをサーバが先に決める**（§4.2）。存在しない相手・到達不能な場所・
 *     夜しか選べない目標は `GoalOption.available:false` で渡し、そもそも選ばせない。
 *  3. **LLMの出力に権限を与えない**（§4.3 / §8）。返ってくるのは enum の goal と
 *     「まわりの一覧にある名前」だけで、座標は一切受け取らない。
 *     名前は厳密一致で `EntityId` に解決し、解決できなければ落とす。
 *  4. **例外を投げない**。タイムアウト・予算切れ・LLM障害はすべて
 *     ユーティリティAI相当の既定目標（オーナー接続中なら `follow_owner`、不在なら `rest`）に落ちる。
 *
 * 非同期の適用について:
 *   決定の結果（`actor.intent` の書き換えとフックの発火）は await の後に行うが、
 *   `IslandSim.step()` は内部で await しないため、tick の途中に割り込むことはない
 *   （JSは単一スレッドで、step は同期的に走り切る）。よって「tickの隙間で世界が変わる」だけで安全。
 *
 * 制約: parameter property 禁止 / enum・namespace 禁止 / 相対importは拡張子込み / Math.random 禁止
 */
import {
  LLM,
  type Actor,
  type EntityId,
  type PetGoal,
  type PetIntent,
  type Terrain,
  type Vec2,
} from '@ai-pet/shared';
import type { LlmClient } from '../llm/client.ts';
import type { PetRepo } from '../db/petRepo.ts';
import type { IslandWorld } from '../sim/world.ts';
import type { WorldClock } from '../sim/clock.ts';
import type { NavService } from '../sim/nav.ts';
import { PET_ACTION_TUNING } from '../sim/petAction.ts';
import { IntentSchema, parseIntent, type IntentOutput } from './schema.ts';
import {
  buildDecidePrompt,
  moodOf,
  sanitizeQuoted,
  PERSONA_LIMITS,
  type DecideContext,
  type GoalOption,
  type NearbyEntry,
} from './persona.ts';
import { selectMemories } from './memory.ts';

// ---------- 定数 ----------

/** 「まわり」に載せる半径（docs §4.2「10タイル以内」） */
const NEARBY_RADIUS = 10;
/**
 * `gather` の候補を探す半径。
 * Reflex層（petAction.ts）が `gather` を実行するときに使う半径と揃えないと、
 * 「選べる」と言っておいて実行できない目標を作ってしまう。
 */
const GATHER_RADIUS = 48;
/** 1回ぶん採れる量が残っている資源だけを候補にする（ほぼ空の木を選ばせない） */
const GATHER_MIN_AMOUNT = PET_ACTION_TUNING.EAT_PORTION;
/** この空腹度を超えた動物を「助けが必要」とみなす */
const HUNGRY_CRITTER = 60;
/** reason の上限（docs §4.3 の maxLength と同じ） */
const REASON_MAX = 60;
/** 構造化出力は短いので出力トークンは絞る（docs §7） */
const DECIDE_MAX_TOKENS = 200;
/**
 * 話しかけられた直後は決定を走らせない（docs §4.1）。
 * 会話の応答に `#goal:` タグで意思が乗るので、二重にLLMを使わない。
 */
const TALK_SUPPRESS_TICKS = LLM.decideCooldownTicks;
/** 記憶検索の母数（petRepo の既定と同じ） */
const MEMORY_FETCH = 200;
/**
 * 1匹あたり1時間の決定回数の上限（docs §7「行動決定 40/時」）。
 * 90秒間隔ならちょうど40回だが、「intentが完了したら即時（最短30秒）」の道が続けて開くと
 * 最悪120回/時まで伸びて会話ぶんの予算を食いつぶす。ここで先に頭を打たせて、
 * 予算側で弾かれてフォールバックになる（＝会話が犠牲になる）状態を避ける。
 */
const MAX_DECIDES_PER_HOUR = 40;
/** 実時間1時間ぶんのtick数（TICK_HZ=4） */
const TICKS_PER_HOUR = 3600 * 4;
/**
 * 記憶検索のクエリ。「これから何をするか」に効く短い語＋近くの名前で引く
 * （会話と違ってプレイヤーの発話がないので、固定の語彙を種にする）。
 */
const MEMORY_QUERY_BASE = 'いま これから つぎ どこ だれ';

/** 相手がいないと実行できない目標。target が解決できなければ explore に落とす */
const TARGET_GOALS: readonly PetGoal[] = ['visit_friend', 'talk_to', 'help_critter'];

/** 地形の日本語表記（プロンプトの[足もと]用） */
const TERRAIN_JA: Record<Terrain, string> = {
  grass: '草はら',
  dirt: '土',
  sand: '砂浜',
  water: '水べ',
  forest: '森',
  plaza: '広場',
};

// ---------- 外部との継ぎ目 ----------

export interface BrainDeps {
  /** オーナーが接続中ならアバターを返す */
  ownerActorOf: (ownerId: string) => Actor | undefined;
  /** 接続中のペットセッション一覧（DBのpetIdとアクターIDの対応） */
  activePets: () => { playerId: string; petId: number; entityId: EntityId }[];
  /** オーナー名（プロンプトに載せる） */
  ownerNameOf: (playerId: string) => string;
}

export interface DecideOutcome {
  petId: number;
  ok: boolean;
  goal: PetGoal;
  reason: string;
  /** LLMが「いま言いたいこと」を返した場合（サニタイズ済み・40字以内） */
  sayNow?: string;
  /** 却下された理由（parse失敗/到達不能/相手が居ない/予算/LLM障害） */
  rejected?: string;
  fallback: boolean;
}

/**
 * 内部用。解決済みの相手をここだけで持ち回る。
 * `DecideOutcome` に生の `EntityId` を出さないのは、クライアントへ渡す口（フック）を
 * `PetIntent` に一本化して「どこから来たIDか分からない値」を増やさないため。
 */
interface ValidatedOutcome extends DecideOutcome {
  targetEntity?: EntityId;
}

interface BrainState {
  /** 最後に決定を**開始**したtick（完了時ではない。連投を防ぐのが目的） */
  lastDecideTick: number;
  /** 最後に話しかけられたtick */
  lastTalkTick: number;
  /** 決定が走っているか（1ペット1本） */
  inFlight: boolean;
  /** 前回のupdate時点でintentを持っていたか（完了・失敗の検出に使う） */
  hadIntent: boolean;
  /**
   * 「intentが完了/失敗したので早めに考え直したい」印。
   * 立った瞬間はクールダウン中で走れないことがあるので、フラグとして持ち越す
   * （その場で見送ると次の間隔まで考え直せなくなる）。
   */
  wantsImmediate: boolean;
  /** 直前の目標（同じことを延々くり返さないための材料としてプロンプトに載せる） */
  lastIntent: { goal: PetGoal; reason: string } | null;
  /** 決定を開始したtickの履歴（直近1時間ぶんだけ持つ。時間あたりの上限判定用） */
  history: number[];
}

/** 「まわり」の情報と、そこから決まる選択肢をまとめたもの */
interface Survey {
  nearby: NearbyEntry[];
  /** 名前 → EntityId（厳密一致で引く。近い順に先着優先） */
  byName: Map<string, EntityId>;
  goals: GoalOption[];
  /** `gather` の対象（到達性チェックに使う） */
  foodPos: Vec2 | null;
}

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** LLMのテキストをJSONへ。壊れていれば null（例外は投げない） */
function parseIntentText(text: string): IntentOutput | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  return parseIntent(json);
}

export class PetBrain {
  private llm: LlmClient;
  private repo: PetRepo;
  private world: IslandWorld;
  private clock: WorldClock;
  private nav: NavService;
  private deps: BrainDeps;

  private states = new Map<number, BrainState>();
  private sayHooks: ((entityId: EntityId, text: string) => void)[] = [];
  private intentHooks: ((playerId: string, intent: PetIntent, reason: string) => void)[] = [];

  private counters = {
    /** 決定を開始した回数（＝LLM呼び出し回数） */
    decisions: 0,
    ok: 0,
    fallback: 0,
    said: 0,
    /** 決定中に対象が消えた等で適用できなかった回数 */
    dropped: 0,
  };
  private byGoal: Record<string, number> = {};
  private byRejected: Record<string, number> = {};
  /** 直近の決定（デバッグ表示用。`?debug=1` の頭上表示の材料） */
  private recent: DecideOutcome[] = [];

  // 注意: Node の type-stripping で動かすため parameter property は使えない
  constructor(
    llm: LlmClient,
    repo: PetRepo,
    world: IslandWorld,
    clock: WorldClock,
    nav: NavService,
    deps: BrainDeps,
  ) {
    this.llm = llm;
    this.repo = repo;
    this.world = world;
    this.clock = clock;
    this.nav = nav;
    this.deps = deps;
  }

  onSay(fn: (entityId: EntityId, text: string) => void): void {
    this.sayHooks.push(fn);
  }

  onIntent(fn: (playerId: string, intent: PetIntent, reason: string) => void): void {
    this.intentHooks.push(fn);
  }

  /**
   * プレイヤーに話しかけられたことを記録する（docs §4.1）。
   * 直後の決定を抑止するためだけの口。会話側（DialogueService の呼び出し元）から呼ぶ。
   */
  noteTalked(petId: number, tick: number): void {
    this.stateOf(petId).lastTalkTick = tick;
  }

  /** ペットが島から下がったら状態を捨てる（再入島で間隔をやり直す） */
  forget(petId: number): void {
    this.states.delete(petId);
  }

  /**
   * 毎tick呼ぶ。**ここでは await しない**。
   * 間隔・クールダウン・会話直後・二重起動を見て、走らせるものだけ非同期に投げる。
   */
  update(tick: number): void {
    for (const session of this.deps.activePets()) {
      const actor = this.world.actor(session.entityId);
      if (!actor || actor.kind !== 'pet') continue;

      const state = this.stateOf(session.petId);
      // 「持っていたintentが消えた」＝ Reflex層が達成/失敗と判断した。期限切れは数えない
      // （期限切れを即時扱いにすると、不在ペットもTTL（90秒）ごとに考え直して予算が4倍になる）
      const hasIntent = actor.intent !== null && actor.intent !== undefined;
      if (state.hadIntent && !hasIntent) state.wantsImmediate = true;
      state.hadIntent = hasIntent;

      if (state.inFlight) continue;

      const since = tick - state.lastDecideTick;
      // クールダウンは「即時」よりも強い（docs §4.1「ただし最短30秒」）
      if (since < LLM.decideCooldownTicks) continue;
      if (tick - state.lastTalkTick < TALK_SUPPRESS_TICKS) continue;

      const ownerOnline = this.deps.ownerActorOf(session.playerId) !== undefined;
      const interval = ownerOnline ? LLM.decideIntervalTicksOnline : LLM.decideIntervalTicksOffline;
      // 即時の考え直しはオーナー接続中だけ。
      // 不在ペットは10分の間隔を厳守する（docs §7「不在ペット: 行動決定10分」の予算保証）
      const immediate = state.wantsImmediate && ownerOnline;
      if (!immediate && since < interval) continue;
      // 予算の頭打ち。時間あたりの上限に達していたら次の間隔まで待つ
      while (state.history.length > 0 && tick - (state.history[0] as number) > TICKS_PER_HOUR) state.history.shift();
      if (state.history.length >= MAX_DECIDES_PER_HOUR) continue;
      state.wantsImmediate = false;
      state.history.push(tick);

      // 非同期に走らせて結果は後から適用する（シミュレーションを止めない）
      void this.decide(session.petId, tick).catch((e: unknown) => {
        // decide は例外を投げない作りだが、想定外でtickループを壊さないための保険
        console.error('[brain] 決定中に想定外の例外', e);
      });
    }
  }

  /**
   * 1匹ぶんの決定を走らせる。
   * すでに走っている・ペットが居ないなら `null`。それ以外は必ず `DecideOutcome` を返す（例外は投げない）。
   */
  async decide(petId: number, tick: number): Promise<DecideOutcome | null> {
    const state = this.stateOf(petId);
    if (state.inFlight) return null;

    const session = this.deps.activePets().find((s) => s.petId === petId);
    if (!session) return null;
    const actor = this.world.actor(session.entityId);
    if (!actor || actor.kind !== 'pet') return null;
    const pet = this.repo.findPetById(petId);
    if (!pet) return null;

    state.inFlight = true;
    state.lastDecideTick = tick;
    this.counters.decisions++;

    try {
      const ownerActor = this.deps.ownerActorOf(session.playerId);
      const ownerOnline = ownerActor !== undefined;
      const survey = this.survey(actor, ownerActor, tick);
      const messages = buildDecidePrompt(
        this.buildContext({ pet, actor, ownerActor, survey, tick, state, session }),
      );

      const res = await this.llm.complete({
        purpose: 'decide',
        messages,
        maxTokens: DECIDE_MAX_TOKENS,
        schema: IntentSchema,
        playerId: session.playerId,
      });

      const parsed = res.ok ? parseIntentText(res.text) : null;
      // LLM障害・タイムアウト・予算切れ・JSON崩れ → ユーティリティAI相当の既定目標（docs §6）
      const outcome: ValidatedOutcome = parsed
        ? this.validate({ petId, parsed, survey, actor, ownerActor, tick })
        : this.fallbackOutcome(petId, ownerOnline, res.ok ? 'parse' : (res.errorKind ?? 'llm'));

      this.apply(outcome, session, tick, state);
      return outcome;
    } finally {
      state.inFlight = false;
    }
  }

  stats(): Record<string, unknown> {
    let inFlight = 0;
    for (const s of this.states.values()) if (s.inFlight) inFlight++;
    return {
      ...this.counters,
      inFlight,
      tracked: this.states.size,
      byGoal: { ...this.byGoal },
      byRejected: { ...this.byRejected },
      recent: this.recent.map((o) => ({ petId: o.petId, goal: o.goal, reason: o.reason, fallback: o.fallback })),
    };
  }

  // ---------- 内部 ----------

  private stateOf(petId: number): BrainState {
    let s = this.states.get(petId);
    if (!s) {
      // 初回は即決定させる（入島したペットが10分棒立ちにならないように）
      s = {
        lastDecideTick: -Infinity,
        lastTalkTick: -Infinity,
        inFlight: false,
        hadIntent: false,
        wantsImmediate: false,
        lastIntent: null,
        history: [],
      };
      this.states.set(petId, s);
    }
    return s;
  }

  /**
   * 「まわり」と「選べる目標」を作る（docs §4.2）。
   * ここでの判定がそのままプロンプトの `available` になるので、
   * **Reflex層が実行できる条件と一致させる**こと（できないことを選ばせないため）。
   */
  private survey(actor: Actor, ownerActor: Actor | undefined, tick: number): Survey {
    const near = this.world.actorsNear(actor.pos, NEARBY_RADIUS, actor.id).slice(0, LLM.maxNearby);

    const nearby: NearbyEntry[] = [];
    const byName = new Map<string, EntityId>();
    const remember = (name: string, id: EntityId): void => {
      // プロンプトに出るのはサニタイズ後の名前なので、そちらを主キーにする。
      // 生の名前でも引けるようにしておく（DBの名前をそのまま返してくる場合の保険）
      const shown = sanitizeQuoted(name, PERSONA_LIMITS.nearbyName);
      if (shown.length > 0 && !byName.has(shown)) byName.set(shown, id);
      const raw = name.trim();
      if (raw.length > 0 && !byName.has(raw)) byName.set(raw, id);
    };

    const talkable: string[] = [];
    const friends: string[] = [];
    const hungry: string[] = [];

    for (const a of near) {
      nearby.push({
        name: a.name,
        species: a.species,
        kind: a.kind,
        distance: Math.round(dist(a.pos, actor.pos) * 10) / 10,
        doing: a.action?.kind ?? 'idle',
      });
      remember(a.name, a.id);
      if (a.kind === 'pet' || a.kind === 'player') talkable.push(a.name);
      if (a.kind === 'pet' || a.kind === 'critter') friends.push(a.name);
      if (a.kind === 'critter' && a.needs.hunger >= HUNGRY_CRITTER) hungry.push(a.name);
    }
    // オーナーは遠くても名前解決できるようにしておく（follow_owner 以外で指名されうる）
    if (ownerActor) remember(ownerActor.name, ownerActor.id);

    const food = this.world.findNearestResource(
      actor.pos,
      ['berry_tree', 'field'],
      GATHER_RADIUS,
      GATHER_MIN_AMOUNT,
    );
    const night = this.clock.state(tick).timeOfDay === 'night';

    const goals: GoalOption[] = [
      ownerActor
        ? { goal: 'follow_owner', available: true, note: 'オーナーは島にいる' }
        : { goal: 'follow_owner', available: false, note: 'オーナーは留守' },
      { goal: 'explore', available: true },
      friends.length > 0
        ? { goal: 'visit_friend', available: true, note: `${friends.join('、')}が近くにいる` }
        : { goal: 'visit_friend', available: false, note: '近くにだれもいない' },
      food
        ? { goal: 'gather', available: true, note: '近くに実った木か畑がある' }
        : { goal: 'gather', available: false, note: '採れる木の実や畑がない' },
      hungry.length > 0
        ? { goal: 'help_critter', available: true, note: `${hungry.join('、')}がおなかをすかせている` }
        : { goal: 'help_critter', available: false, note: 'おなかをすかせた動物がいない' },
      { goal: 'rest', available: true },
      night
        ? { goal: 'watch_stars', available: true, note: 'いまは夜' }
        : { goal: 'watch_stars', available: false, note: 'まだ夜ではない' },
      talkable.length > 0
        ? { goal: 'talk_to', available: true, note: `${talkable.join('、')}に話しかけられる` }
        : { goal: 'talk_to', available: false, note: '話せる相手が近くにいない' },
    ];

    return { nearby, byName, goals, foodPos: food ? { x: food.pos.x, y: food.pos.y } : null };
  }

  /** プロンプトに渡す文脈。記憶は selectMemories で LLM.maxMemories 件まで */
  private buildContext(opts: {
    pet: { id: number; persona: DecideContext['persona']; affection: number; summary: string };
    actor: Actor;
    ownerActor: Actor | undefined;
    survey: Survey;
    tick: number;
    state: BrainState;
    session: { playerId: string };
  }): DecideContext {
    const { pet, actor, ownerActor, survey, tick, state, session } = opts;
    const clockState = this.clock.state(tick);
    const names = survey.nearby.map((n) => n.name);

    const memories = selectMemories(this.repo.recentMemories(pet.id, { limit: MEMORY_FETCH }), {
      nowTick: tick,
      query: `${MEMORY_QUERY_BASE} ${names.join(' ')}`,
      limit: LLM.maxMemories,
      maxChars: LLM.maxMemoryChars,
      knownNames: [...names, ownerActor?.name ?? ''],
    });

    const terrain = this.world.terrainAt(Math.floor(actor.pos.x), Math.floor(actor.pos.y));

    return {
      persona: pet.persona,
      affection: pet.affection,
      mood: moodOf(actor),
      summary: pet.summary,
      clock: {
        islandDay: clockState.islandDay,
        season: clockState.season,
        timeOfDay: clockState.timeOfDay,
        weather: clockState.weather,
      },
      self: {
        hunger: Math.round(actor.needs.hunger),
        sleep: Math.round(actor.needs.sleep),
        social: Math.round(actor.needs.social),
      },
      terrain: TERRAIN_JA[terrain] ?? terrain,
      nearby: survey.nearby,
      memories: memories.map((m) => ({ text: m.text, islandDay: m.islandDay, kind: m.kind })),
      goals: survey.goals,
      ownerName: this.deps.ownerNameOf(session.playerId),
      ownerOnline: ownerActor !== undefined,
      lastIntent: state.lastIntent,
    };
  }

  /**
   * LLMの出力を検証する（docs §4.3。**安全性の中心**）。
   *
   * 1. goal が enum 外 / JSON崩れ → ここに来る前に `parseIntent` が null を返してフォールバック
   * 2. targetName は「まわりの一覧」の名前と厳密一致でのみ EntityId に解決。合わなければ落とす
   * 3. 選べない目標が返ってきたら explore に置換
   * 4. 相手が必要な目標で相手が居なければ explore に置換
   * 5. 到達不能なら explore に置換（座標はLLMから受け取らない）
   * 6. sayNow / reason は長さ・改行・役割マーカーを落とす
   */
  private validate(opts: {
    petId: number;
    parsed: IntentOutput;
    survey: Survey;
    actor: Actor;
    ownerActor: Actor | undefined;
    tick: number;
  }): ValidatedOutcome {
    const { petId, parsed, survey, actor, ownerActor } = opts;
    let goal: PetGoal = parsed.goal;
    let targetEntity: EntityId | undefined;
    let rejected: string | undefined;

    // 2) 名前の厳密一致だけを認める
    if (parsed.targetName !== null) {
      const key = sanitizeQuoted(parsed.targetName, PERSONA_LIMITS.nearbyName);
      const id = survey.byName.get(key) ?? survey.byName.get(parsed.targetName.trim());
      if (id === undefined) rejected = 'target_unknown';
      else targetEntity = id;
    }

    // 3) 「選べない」と伝えた目標を選んできたら差し替える
    const option = survey.goals.find((g) => g.goal === goal);
    if (option && !option.available) {
      goal = 'explore';
      targetEntity = undefined;
      rejected = rejected ?? 'goal_unavailable';
    }

    // 4) 相手が要る目標なのに相手が解決できていない
    if (TARGET_GOALS.includes(goal) && targetEntity === undefined) {
      goal = 'explore';
      rejected = rejected ?? 'target_missing';
    }

    // 5) 到達可能性。行き先が決まる目標だけ確認する
    const dest = this.destinationOf(goal, targetEntity, ownerActor, survey);
    if (dest && !this.reachable(actor.pos, dest)) {
      goal = 'explore';
      targetEntity = undefined;
      rejected = rejected ?? 'unreachable';
    }

    const reason = sanitizeQuoted(parsed.reason, REASON_MAX) || 'なんとなく そうしたい';
    const sayNow = parsed.sayNow === null ? '' : sanitizeQuoted(parsed.sayNow, PERSONA_LIMITS.sayNow);

    return {
      petId,
      ok: true,
      goal,
      reason,
      ...(sayNow.length > 0 ? { sayNow } : {}),
      ...(rejected ? { rejected } : {}),
      ...(targetEntity !== undefined ? { targetEntity } : {}),
      fallback: false,
    };
  }

  /** その目標で実際に向かう先。無い（Reflex層が自分で決める）なら null */
  private destinationOf(
    goal: PetGoal,
    targetEntity: EntityId | undefined,
    ownerActor: Actor | undefined,
    survey: Survey,
  ): Vec2 | null {
    if (targetEntity !== undefined) {
      const t = this.world.actor(targetEntity);
      return t ? { x: t.pos.x, y: t.pos.y } : null;
    }
    if (goal === 'follow_owner') return ownerActor ? { x: ownerActor.pos.x, y: ownerActor.pos.y } : null;
    if (goal === 'gather') return survey.foodPos;
    // explore / rest / watch_stars は Reflex層が近場の歩ける地点を選ぶので確認不要
    return null;
  }

  /** 歩いて行けるか。至近距離なら経路探索を省く */
  private reachable(from: Vec2, to: Vec2): boolean {
    if (dist(from, to) <= PET_ACTION_TUNING.ACT_RANGE) return true;
    // NavService.solve は「直進 → 目的地の寄せ → A*」の順に見てくれる。
    // findPath は作業領域を使い回すが同期的なので、tickの隙間で呼んでも再入は起きない
    return this.nav.solve(from, to) !== null;
  }

  /** LLMが使えないときの既定目標（docs §6）。Reflex層の既定行動と衝突しない選択にする */
  private fallbackOutcome(petId: number, ownerOnline: boolean, why: string): ValidatedOutcome {
    return {
      petId,
      ok: false,
      goal: ownerOnline ? 'follow_owner' : 'rest',
      reason: ownerOnline ? 'そばにいたい' : 'すこし休んでいる',
      rejected: why,
      // フォールバックのときは何も言わせない（定型セリフの押し売りにしない）
      fallback: true,
    };
  }

  /** 決定をアクターへ反映し、フックへ流す */
  private apply(
    outcome: ValidatedOutcome,
    session: { playerId: string; petId: number; entityId: EntityId },
    tick: number,
    state: BrainState,
  ): void {
    this.byGoal[outcome.goal] = (this.byGoal[outcome.goal] ?? 0) + 1;
    if (outcome.rejected) this.byRejected[outcome.rejected] = (this.byRejected[outcome.rejected] ?? 0) + 1;
    if (outcome.fallback) this.counters.fallback++;
    else this.counters.ok++;
    this.recent.push(outcome);
    if (this.recent.length > 8) this.recent.shift();

    // 待っているあいだにペットが島から下がっていることがある
    const actor = this.world.actor(session.entityId);
    if (!actor || actor.kind !== 'pet') {
      this.counters.dropped++;
      return;
    }

    const intent: PetIntent = {
      goal: outcome.goal,
      ...(outcome.targetEntity !== undefined ? { targetEntity: outcome.targetEntity } : {}),
      reason: outcome.reason,
      expiresAtTick: tick + LLM.intentTtlTicks,
    };
    actor.intent = intent;
    state.hadIntent = true;
    state.lastIntent = { goal: intent.goal, reason: intent.reason };

    for (const fn of this.intentHooks) {
      try {
        fn(session.playerId, intent, intent.reason);
      } catch (e) {
        console.error('[brain] intentフックで例外', e);
      }
    }

    if (outcome.sayNow) {
      this.counters.said++;
      for (const fn of this.sayHooks) {
        try {
          fn(session.entityId, outcome.sayNow);
        } catch (e) {
          console.error('[brain] sayフックで例外', e);
        }
      }
    }
  }
}

/** テストとデバッグから参照する調整値 */
export const BRAIN_TUNING = {
  NEARBY_RADIUS,
  GATHER_RADIUS,
  GATHER_MIN_AMOUNT,
  HUNGRY_CRITTER,
  REASON_MAX,
  DECIDE_MAX_TOKENS,
  TALK_SUPPRESS_TICKS,
  MAX_DECIDES_PER_HOUR,
  TICKS_PER_HOUR,
} as const;
