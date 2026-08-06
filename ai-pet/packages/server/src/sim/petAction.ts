/**
 * ペットのReflex層（docs/02_ゲーム実装プラン/07_ペットAI設計.md §1）
 *
 * ここは**LLMを使わない**。歩く・食べる・寝る・オーナーに付いていく、を担う。
 * LLMが落ちていてもペットが「生きて」見えるための土台。
 *
 * LLMが決めた目標（intent）があればそれを優先して実行するが、
 * intentが無い／期限切れ／到達不能なら、この層の既定行動に戻る。
 *
 * 制約:
 * - Math.random() 禁止（world.rng）
 * - parameter property / enum 禁止
 */
import {
  NEEDS,
  TICKS_PER_ISLAND_HOUR,
  type Actor,
  type ActionKind,
  type ActiveAction,
  type PetIntent,
  type Vec2,
} from '@ai-pet/shared';
import { relieveNeed, urgency } from './needs.ts';
import { harvest, isAvailable } from './resource.ts';
import type { NavService } from './nav.ts';
import type { WorldClock } from './clock.ts';
import type { IslandWorld } from './world.ts';

/** オーナーのどれくらい後ろに付くか */
const FOLLOW_DISTANCE = 2.2;
/** これ以上離れたら追いかける */
const FOLLOW_CATCHUP = 3.2;
/** オーナーが遠すぎるときはワープではなく諦めて自分の用事をする */
const FOLLOW_GIVEUP = 60;
/** 空腹・眠気がこの切迫度を超えたら、追従より自分の世話を優先する */
const SELF_CARE_URGENCY = 0.55;
/** 1回の採食量 */
const EAT_PORTION = 1.5;
/** 食料を探す半径（空腹で広がる） */
const FOOD_RADIUS_BASE = 24;
/** 行動の所要tick */
const DURATION: Partial<Record<ActionKind, number>> = {
  eat: 12,
  drink: 24,
  sleep: Math.round(TICKS_PER_ISLAND_HOUR * 1.5),
  follow: 8,
  idle: 8,
  wander: 24,
  explore: 24,
  goto: 16,
  socialize: 40,
  help: 20,
};
/** 目的地に着いたとみなす距離 */
const ACT_RANGE = 1.2;
/** 経路の再要求間隔 */
const NAV_RETRY_TICKS = 8;
/** 1tickに出す経路探索の上限（動物と食い合わないよう控えめに） */
const NAV_REQUESTS_PER_TICK = 2;

export interface PetActionDeps {
  /** オーナーのアバターを引く。未接続なら undefined */
  ownerActorOf: (ownerId: string) => Actor | undefined;
}

interface PetMemo {
  lastNavTick: number;
  arrived: boolean;
  /** intentの実行を諦めたtick（連続で無駄な再試行をしないため） */
  intentFailedAtTick: number;
}

const memos = new WeakMap<Actor, PetMemo>();

function memoOf(actor: Actor): PetMemo {
  let m = memos.get(actor);
  if (!m) {
    m = { lastNavTick: -9999, arrived: false, intentFailedAtTick: -9999 };
    memos.set(actor, m);
  }
  return m;
}

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** オーナーの少し後ろの位置（真上に重ならないように） */
function followSpot(owner: Actor): Vec2 {
  const back: Record<string, Vec2> = {
    n: { x: 0, y: FOLLOW_DISTANCE },
    s: { x: 0, y: -FOLLOW_DISTANCE },
    e: { x: -FOLLOW_DISTANCE, y: 0 },
    w: { x: FOLLOW_DISTANCE, y: 0 },
  };
  const d = back[owner.facing] ?? { x: 0, y: FOLLOW_DISTANCE };
  return { x: owner.pos.x + d.x, y: owner.pos.y + d.y };
}

export class PetActions {
  private world: IslandWorld;
  private nav: NavService;
  private clock: WorldClock;
  private deps: PetActionDeps;
  private byAction: Record<string, number> = {};
  private intentsExecuted = 0;
  private intentsFailed = 0;

  // 注意: Node の type-stripping で動かすため parameter property は使えない
  constructor(world: IslandWorld, nav: NavService, clock: WorldClock, deps: PetActionDeps) {
    this.world = world;
    this.nav = nav;
    this.clock = clock;
    this.deps = deps;
  }

  update(tick: number): void {
    let navBudget = NAV_REQUESTS_PER_TICK;
    for (const pet of this.world.actors.values()) {
      if (pet.kind !== 'pet') continue;
      this.decide(pet, tick);
      navBudget = this.progress(pet, tick, navBudget);
    }
  }

  /** 何をするか決める。intent があれば優先し、無ければ欲求とオーナーで決める */
  private decide(pet: Actor, tick: number): void {
    const intent = this.liveIntent(pet, tick);
    const selfCare = this.selfCareAction(pet, tick);

    // 空腹・眠気が切迫していたら、LLMの目標より生存を優先する
    if (selfCare) {
      this.setAction(pet, selfCare, tick);
      return;
    }
    if (intent) {
      const action = this.actionForIntent(pet, intent, tick);
      if (action) {
        this.setAction(pet, action, tick);
        this.intentsExecuted++;
        return;
      }
      // 実行できない目標は捨てて既定行動に戻す（docs §4.4）
      pet.intent = null;
      this.intentsFailed++;
      memoOf(pet).intentFailedAtTick = tick;
    }
    this.setAction(pet, this.defaultAction(pet, tick), tick);
  }

  /** 期限内で目標が残っていれば返す */
  private liveIntent(pet: Actor, tick: number): PetIntent | null {
    const intent = pet.intent ?? null;
    if (!intent) return null;
    if (intent.expiresAtTick <= tick) {
      pet.intent = null;
      return null;
    }
    return intent;
  }

  /** 生存に関わる行動（空腹・眠気）。必要なければ null */
  private selfCareAction(pet: Actor, tick: number): ActiveAction | null {
    if (urgency(pet.needs.hunger) >= SELF_CARE_URGENCY) {
      const radius = FOOD_RADIUS_BASE * (1 + urgency(pet.needs.hunger));
      const food = this.world.findNearestResource(
        pet.pos,
        ['berry_tree', 'field', 'fishing_spot'],
        radius,
        EAT_PORTION,
      );
      if (food && isAvailable(food)) {
        return { kind: 'eat', targetEntity: food.id, startedAtTick: tick, durationTicks: DURATION.eat ?? 12 };
      }
    }
    const night = this.clock.isNight(tick);
    if (night && urgency(pet.needs.sleep) >= SELF_CARE_URGENCY) {
      return { kind: 'sleep', startedAtTick: tick, durationTicks: DURATION.sleep ?? 900 };
    }
    return null;
  }

  /** 既定行動: オーナーが居れば追従、居なければ島で過ごす */
  private defaultAction(pet: Actor, tick: number): ActiveAction {
    const owner = pet.ownerId ? this.deps.ownerActorOf(pet.ownerId) : undefined;
    if (owner) {
      const d = dist(pet.pos, owner.pos);
      if (d > FOLLOW_CATCHUP && d < FOLLOW_GIVEUP) {
        return {
          kind: 'follow',
          targetEntity: owner.id,
          targetTile: followSpot(owner),
          startedAtTick: tick,
          durationTicks: DURATION.follow ?? 8,
        };
      }
      // 近くにいるならそばで待つ
      return { kind: 'idle', startedAtTick: tick, durationTicks: DURATION.idle ?? 8 };
    }
    // オーナー不在。夜は寝て、昼は少し歩く
    if (this.clock.isNight(tick)) {
      return { kind: 'sleep', startedAtTick: tick, durationTicks: DURATION.sleep ?? 900 };
    }
    return { kind: 'wander', startedAtTick: tick, durationTicks: DURATION.wander ?? 24 };
  }

  /** LLMの目標を実際の行動に変換する（docs §4.4 の対応表） */
  private actionForIntent(pet: Actor, intent: PetIntent, tick: number): ActiveAction | null {
    const owner = pet.ownerId ? this.deps.ownerActorOf(pet.ownerId) : undefined;
    const target = intent.targetEntity !== undefined ? this.world.actor(intent.targetEntity) : undefined;

    switch (intent.goal) {
      case 'follow_owner':
        if (!owner) return null;
        return {
          kind: 'follow',
          targetEntity: owner.id,
          targetTile: followSpot(owner),
          startedAtTick: tick,
          durationTicks: DURATION.follow ?? 8,
        };

      case 'gather': {
        const food = this.world.findNearestResource(
          pet.pos,
          ['berry_tree', 'field'],
          FOOD_RADIUS_BASE * 2,
          EAT_PORTION,
        );
        if (!food) return null;
        return { kind: 'harvest', targetEntity: food.id, startedAtTick: tick, durationTicks: DURATION.eat ?? 12 };
      }

      case 'visit_friend':
      case 'talk_to': {
        if (!target) return null;
        return {
          kind: intent.goal === 'talk_to' ? 'talk' : 'socialize',
          targetEntity: target.id,
          targetTile: { x: target.pos.x, y: target.pos.y },
          startedAtTick: tick,
          durationTicks: DURATION.socialize ?? 40,
        };
      }

      case 'help_critter': {
        if (!target) return null;
        return {
          kind: 'help',
          targetEntity: target.id,
          targetTile: { x: target.pos.x, y: target.pos.y },
          startedAtTick: tick,
          durationTicks: DURATION.help ?? 20,
        };
      }

      case 'rest':
        return { kind: 'sleep', startedAtTick: tick, durationTicks: DURATION.sleep ?? 900 };

      case 'explore':
      case 'watch_stars': {
        const tile = intent.targetTile ?? this.wanderTile(pet, tick);
        if (!tile || !this.world.canStandAt(tile)) return null;
        return {
          kind: intent.goal === 'explore' ? 'explore' : 'goto',
          targetTile: { x: tile.x, y: tile.y },
          startedAtTick: tick,
          durationTicks: DURATION.explore ?? 24,
        };
      }

      default:
        return null;
    }
  }

  /** 目標のない徘徊先。乱数列を汚さないようIDとtickから決める */
  private wanderTile(pet: Actor, tick: number): Vec2 | null {
    const seed = (pet.id * 2654435761 + Math.floor(tick / 100) * 40503) >>> 0;
    const angle = ((seed % 1000) / 1000) * Math.PI * 2;
    const r = 4 + ((seed >>> 10) % 7);
    const tile = { x: pet.pos.x + Math.cos(angle) * r, y: pet.pos.y + Math.sin(angle) * r };
    return this.world.canStandAt(tile) ? tile : null;
  }

  /** 同じ行動なら維持し、違えば差し替える（ちらつき防止） */
  private setAction(pet: Actor, next: ActiveAction, tick: number): void {
    const cur = pet.action;
    // 種別と対象が同じなら「継続」。追従は目標地点が動くだけなので同一扱いにする
    const same = cur !== null && cur.kind === next.kind && cur.targetEntity === next.targetEntity;

    if (cur && same) {
      // 追従だけは目標地点を更新し続ける（オーナーが動くため）
      if (cur.kind === 'follow' && next.targetTile) cur.targetTile = next.targetTile;
      return;
    }

    if (pet.anim === 'sleep' || pet.anim === 'act' || pet.anim === 'talk') pet.anim = 'idle';
    pet.action = next;
    pet.path = null;
    this.nav.clear(pet.id);
    const m = memoOf(pet);
    m.arrived = false;
    m.lastNavTick = -9999;
    this.byAction[next.kind] = (this.byAction[next.kind] ?? 0) + 1;
  }

  /** 目的地へ向かい、着いたら効果を適用する */
  private progress(pet: Actor, tick: number, navBudget: number): number {
    const action = pet.action;
    if (!action) return navBudget;

    // 目標の座標を決める
    let goal: Vec2 | null = null;
    if (action.targetEntity !== undefined) {
      const t = this.world.actor(action.targetEntity);
      if (t) goal = action.kind === 'follow' ? (action.targetTile ?? t.pos) : t.pos;
      else {
        const node = this.world.resources.get(action.targetEntity);
        if (node) goal = node.pos;
        else {
          // 目標が消えた
          pet.action = null;
          return navBudget;
        }
      }
    } else if (action.targetTile) {
      goal = action.targetTile;
    }

    const m = memoOf(pet);

    if (goal) {
      const d = dist(pet.pos, goal);
      if (d > ACT_RANGE) {
        m.arrived = false;
        if (navBudget > 0 && tick - m.lastNavTick >= NAV_RETRY_TICKS && (pet.path?.length ?? 0) === 0) {
          this.nav.request(pet.id, goal);
          m.lastNavTick = tick;
          navBudget--;
        }
        return navBudget;
      }
      if (!m.arrived) {
        m.arrived = true;
        pet.path = null;
      }
    }

    // 到着後の見た目と効果
    switch (action.kind) {
      case 'sleep':
        pet.anim = 'sleep';
        break;
      case 'eat':
      case 'harvest':
      case 'help':
        pet.anim = 'act';
        break;
      case 'talk':
        pet.anim = 'talk';
        break;
      default:
        break;
    }

    if (tick - action.startedAtTick >= action.durationTicks) this.complete(pet, action, tick);
    return navBudget;
  }

  private complete(pet: Actor, action: ActiveAction, tick: number): void {
    switch (action.kind) {
      case 'eat': {
        const node = action.targetEntity !== undefined ? this.world.resources.get(action.targetEntity) : undefined;
        if (node) {
          const got = harvest(this.world, node, EAT_PORTION, tick);
          if (got > 0) relieveNeed(pet, 'hunger', NEEDS.eatRelief * Math.min(1, got / EAT_PORTION));
        }
        break;
      }
      case 'harvest': {
        // オーナーへの土産。持ち物の仕組みはM7なので、いまは自分の空腹を少し満たすだけ
        const node = action.targetEntity !== undefined ? this.world.resources.get(action.targetEntity) : undefined;
        if (node) {
          const got = harvest(this.world, node, EAT_PORTION, tick);
          if (got > 0) relieveNeed(pet, 'hunger', NEEDS.eatRelief * 0.4);
        }
        break;
      }
      case 'help': {
        // 空腹な動物に食べものを分ける（好感度は relation.ts が近接で拾う）
        const other = action.targetEntity !== undefined ? this.world.actor(action.targetEntity) : undefined;
        if (other) relieveNeed(other, 'hunger', NEEDS.eatRelief * 0.5);
        break;
      }
      case 'socialize':
      case 'talk':
        relieveNeed(pet, 'social', NEEDS.socializeRelief);
        break;
      case 'drink':
        relieveNeed(pet, 'hunger', NEEDS.drinkRelief * 0.5);
        break;
      default:
        break;
    }

    // 睡眠は夜のあいだ続けたいので、完了しても夜なら延長する
    if (action.kind === 'sleep' && this.clock.isNight(tick)) {
      action.startedAtTick = tick;
      return;
    }
    if (pet.anim === 'sleep' || pet.anim === 'act' || pet.anim === 'talk') pet.anim = 'idle';
    pet.action = null;
    // 達成したらintentも消す（同じ目標を繰り返さない）
    if (pet.intent && isIntentSatisfiedBy(pet.intent.goal, action.kind)) pet.intent = null;
  }

  stats(): Record<string, unknown> {
    return {
      pets: this.world.countActors('pet'),
      byAction: { ...this.byAction },
      intentsExecuted: this.intentsExecuted,
      intentsFailed: this.intentsFailed,
    };
  }
}

/** 行動が完了したとき、その目標も達成とみなすか */
function isIntentSatisfiedBy(goal: PetIntent['goal'], kind: ActionKind): boolean {
  if (goal === 'gather') return kind === 'harvest';
  if (goal === 'help_critter') return kind === 'help';
  if (goal === 'talk_to') return kind === 'talk';
  if (goal === 'visit_friend') return kind === 'socialize';
  if (goal === 'explore' || goal === 'watch_stars') return kind === 'explore' || kind === 'goto';
  // follow_owner / rest は継続的な目標なので完了で消さない
  return false;
}

/** ペットを退場・切断させるときにキャッシュを捨てる */
export function forgetPet(pet: Actor): void {
  memos.delete(pet);
}

/** バランス調整とテストから参照する値 */
export const PET_ACTION_TUNING = {
  FOLLOW_DISTANCE,
  FOLLOW_CATCHUP,
  FOLLOW_GIVEUP,
  SELF_CARE_URGENCY,
  EAT_PORTION,
  ACT_RANGE,
} as const;
