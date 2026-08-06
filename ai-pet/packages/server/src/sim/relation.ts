/**
 * 個体間の関係性と世代交代（docs/02_ゲーム実装プラン/04_サーバ設計.md §4「関係性・世代交代」）
 *
 * 宣伝資料の「こども個体が育ち、性格が親から少し似る」「仲良し・苦手が生まれる」を担う。
 * 低頻度システム（5秒ごと＋島日境界）なので、多少重い処理をしてもよい。
 *
 * 制約:
 * - Math.random() 禁止（world.rng）
 * - parameter property / enum 禁止
 */
import {
  MAX_CRITTERS,
  RELATION,
  TICKS_PER_ISLAND_DAY,
  TICKS_PER_ISLAND_HOUR,
  type Actor,
  type EntityId,
  type Vec2,
} from '@ai-pet/shared';
import { createCritterActor, inheritTraits } from './actors.ts';
import { forgetActor } from './movement.ts';
import { forgetCritter } from './critter.ts';
import { textBefriend, textBorn, textDied, textQuarrel, type EventBus } from './events.ts';
import type { IslandWorld } from './world.ts';
import type { WorldClock } from './clock.ts';

/** 交流していると判定する距離 */
const SOCIAL_RANGE = 2.0;
/** 同じ資源を取り合っていると判定する距離 */
const COMPETE_RANGE = 1.6;
/** ケンカが起きる確率（競合が成立した5秒ごとの判定あたり）。空腹だと上がる */
const QUARREL_BASE_CHANCE = 0.06;
/**
 * 同じペアが続けてケンカできない間隔。
 * 入れないと冬に1島日あたり2500件のケンカが出て、島のログとペットの記憶が
 * ケンカだけで埋まってしまう（実測で発見）。
 */
const QUARREL_COOLDOWN_TICKS = TICKS_PER_ISLAND_HOUR;
/** 好感度がこの値を下回ると「苦手」 */
const DISLIKE_THRESHOLD = -30;
/** 子が生まれるときの親からの距離 */
const BIRTH_OFFSET = 0.8;

function pairKey(a: EntityId, b: EntityId): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

export interface RelationEntry {
  a: EntityId;
  b: EntityId;
  score: number;
  metCount: number;
}

export interface RelationStats {
  pairs: number;
  friends: number;
  dislikes: number;
  births: number;
  deaths: number;
  quarrels: number;
}

export class RelationSystem {
  private world: IslandWorld;
  private clock: WorldClock;
  private bus: EventBus;
  /** ペアごとの好感度。キーは小さいID:大きいID */
  private scores = new Map<string, RelationEntry>();
  private lastIslandDay: number;
  /** ペアごとの直近ケンカtick（クールダウン判定用） */
  private lastQuarrelTick = new Map<string, number>();
  private births = 0;
  private deaths = 0;
  private quarrels = 0;

  // 注意: Node の type-stripping で動かすため parameter property は使えない
  constructor(world: IslandWorld, clock: WorldClock, bus: EventBus) {
    this.world = world;
    this.clock = clock;
    this.bus = bus;
    this.lastIslandDay = clock.islandDay;
  }

  // ---------- 好感度 ----------

  get(a: EntityId, b: EntityId): number {
    return this.scores.get(pairKey(a, b))?.score ?? 0;
  }

  adjust(a: EntityId, b: EntityId, delta: number): number {
    if (a === b) return 0;
    const key = pairKey(a, b);
    let e = this.scores.get(key);
    if (!e) {
      e = { a: Math.min(a, b), b: Math.max(a, b), score: 0, metCount: 0 };
      this.scores.set(key, e);
    }
    const before = e.score;
    e.score = Math.max(-100, Math.min(100, e.score + delta));
    e.metCount++;
    return e.score - before;
  }

  /** 好感度が高い相手（近い順ではなくスコア順） */
  friendsOf(id: EntityId, min = RELATION.befriendThreshold): EntityId[] {
    const out: { id: EntityId; score: number }[] = [];
    for (const e of this.scores.values()) {
      if (e.a !== id && e.b !== id) continue;
      if (e.score < min) continue;
      out.push({ id: e.a === id ? e.b : e.a, score: e.score });
    }
    out.sort((p, q) => q.score - p.score);
    return out.map((o) => o.id);
  }

  entries(): RelationEntry[] {
    return [...this.scores.values()];
  }

  /** スナップショット復元用 */
  restore(entries: readonly RelationEntry[]): void {
    this.scores.clear();
    for (const e of entries) {
      this.scores.set(pairKey(e.a, e.b), { a: Math.min(e.a, e.b), b: Math.max(e.a, e.b), score: e.score, metCount: e.metCount });
    }
  }

  // ---------- 毎tick（実際は低頻度） ----------

  update(tick: number): void {
    if (tick % RELATION.updateEveryTicks === 0) this.updateProximity(tick);

    // 島日の境界で年齢・繁殖・寿命をまとめて処理する
    if (this.clock.islandDay !== this.lastIslandDay) {
      this.lastIslandDay = this.clock.islandDay;
      this.onIslandDay(tick);
    }
  }

  /** 近くにいる個体同士の好感度を動かす。交流なら+、資源の取り合いなら- */
  private updateProximity(tick: number): void {
    const critters: Actor[] = [];
    for (const a of this.world.actors.values()) {
      if (a.kind === 'critter' || a.kind === 'pet') critters.push(a);
    }

    for (let i = 0; i < critters.length; i++) {
      const a = critters[i] as Actor;
      if (a.anim === 'sleep') continue;
      // 近傍だけを見る（全ペア走査を避ける）
      for (const b of this.world.actorsNear(a.pos, SOCIAL_RANGE, a.id)) {
        if (b.kind === 'player') continue;
        if (b.anim === 'sleep') continue;
        // ペアの片側（IDの小さい方）だけが処理する。二重計上と非決定性を防ぐ
        if (a.id > b.id) continue;

        const socializing = a.action?.kind === 'socialize' || b.action?.kind === 'socialize';
        const competing =
          a.action?.kind === 'eat' &&
          b.action?.kind === 'eat' &&
          a.action.targetEntity !== undefined &&
          a.action.targetEntity === b.action.targetEntity &&
          Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y) <= COMPETE_RANGE;

        if (competing) {
          this.onCompete(tick, a, b);
        } else if (!socializing) {
          // 交流行動でなくても、起きて近くにいれば少しずつ馴染む（群れの生活）。
          // これが無いと「交流」行動が噛み合ったペアしか関係が育たず、繁殖が起きなかった。
          this.adjust(a.id, b.id, RELATION.proximityGain);
        }
        if (socializing) {
          const gain = RELATION.socializeGain * (0.6 + (a.traits.sociability + b.traits.sociability) / 2);
          const before = this.get(a.id, b.id);
          this.adjust(a.id, b.id, gain);
          const after = this.get(a.id, b.id);
          // しきい値をまたいだ瞬間だけイベントにする（毎回出すとログが溢れる）
          if (before < RELATION.befriendThreshold && after >= RELATION.befriendThreshold) {
            this.bus.emit(tick, {
              kind: 'befriend',
              text: textBefriend(a.name, b.name),
              actorId: a.id,
              targetId: b.id,
              pos: a.pos,
            });
          }
        }
      }
    }
  }

  /** 同じ資源を取り合った。食料が少ない季節ほどケンカになりやすい */
  private onCompete(tick: number, a: Actor, b: Actor): void {
    this.adjust(a.id, b.id, -RELATION.quarrelLoss);

    // 空腹が切迫しているほど、また季節の実りが悪いほどケンカになる
    const hunger = Math.max(a.needs.hunger, b.needs.hunger) / 100;
    const scarcity = 1 / Math.max(0.4, this.clock.regenMultiplier);
    const temper = 1 + (1 - (a.traits.caution + b.traits.caution) / 2);
    const chance = Math.min(0.5, QUARREL_BASE_CHANCE * (0.5 + hunger) * scarcity * temper);
    if (!this.world.rng.chance(chance)) return;

    // 同じ相手と延々とケンカし続けるのは記録としてうるさいので間隔を空ける
    const key = pairKey(a.id, b.id);
    const last = this.lastQuarrelTick.get(key);
    if (last !== undefined && tick - last < QUARREL_COOLDOWN_TICKS) return;
    this.lastQuarrelTick.set(key, tick);

    this.quarrels++;
    const node = a.action?.targetEntity !== undefined ? this.world.resources.get(a.action.targetEntity) : undefined;
    const over = node ? resourceLabel(node.type) : 'たべもの';
    this.bus.emit(tick, {
      kind: 'quarrel',
      text: textQuarrel(a.name, b.name, over),
      actorId: a.id,
      targetId: b.id,
      pos: a.pos,
    });
    // ケンカした個体は少し離れる（同じ資源に張り付き続けないように）
    const loser = a.needs.safety > b.needs.safety ? a : b;
    loser.action = { kind: 'flee', startedAtTick: tick, durationTicks: 8 };
    loser.needs.safety = Math.min(100, loser.needs.safety + 20);
  }

  // ---------- 島日の境界 ----------

  /** 年齢加算・繁殖・寿命。1島日に1回だけ呼ばれる */
  onIslandDay(tick: number): void {
    const critters: Actor[] = [];
    for (const a of this.world.actors.values()) if (a.kind === 'critter') critters.push(a);

    // 年齢
    for (const a of critters) a.ageDays += 1;

    this.breed(tick, critters);
    this.reap(tick, critters);
    this.prunePairs();
  }

  /** 仲の良い成体ペアから子が生まれる。季節の出生率が掛かる */
  private breed(tick: number, critters: readonly Actor[]): void {
    if (this.world.countActors('critter') >= MAX_CRITTERS) return;
    const rng = this.world.rng;
    const byId = new Map<EntityId, Actor>();
    for (const a of critters) byId.set(a.id, a);

    // 好感度の高いペアを候補にする（同種・双方成体）
    const candidates: RelationEntry[] = [];
    for (const e of this.scores.values()) {
      if (e.score < RELATION.breedThreshold) continue;
      const a = byId.get(e.a);
      const b = byId.get(e.b);
      if (!a || !b) continue;
      if (a.species !== b.species) continue;
      if (a.ageDays < RELATION.adultAgeDays || b.ageDays < RELATION.adultAgeDays) continue;
      if (a.health < 50 || b.health < 50) continue;
      candidates.push(e);
    }
    rng.shuffle(candidates);

    // 食料の余裕で出生率が変わる（食べものが足りない年は増えない）。
    // 個体数の上限だけで増加を止めると「島が上限に張り付く」だけになるので、
    // 生態側の理由で釣り合うようにしている。
    const perCapita = this.world.totalResourceAmount() / Math.max(1, critters.length);
    const foodFactor = Math.max(0, Math.min(1.2, perCapita / RELATION.breedFoodPerCapita));
    const rate = this.clock.birthRateMultiplier * foodFactor;
    // 1島日に増えられる数を制限して、増え方をなだらかにする
    let budget = Math.max(1, Math.floor(this.world.countActors('critter') * RELATION.maxBirthsPerDayRatio));
    for (const e of candidates) {
      if (budget <= 0) break;
      if (this.world.countActors('critter') >= MAX_CRITTERS) break;
      // 1島日あたりの出生確率。季節で大きく変わる（冬はほぼ生まれない）
      if (!rng.chance(Math.min(0.9, 0.25 * rate))) continue;

      const a = byId.get(e.a) as Actor;
      const b = byId.get(e.b) as Actor;
      const pos = birthPositionNear(this.world, a.pos);
      if (!pos) continue;

      const child = createCritterActor(this.world, {
        species: a.species,
        pos,
        ageDays: 0,
        traits: inheritTraits(rng, a.traits, b.traits),
      });
      // 親子は最初から仲が良い
      this.adjust(a.id, child.id, 40);
      this.adjust(b.id, child.id, 40);
      this.births++;
      budget--;
      this.bus.emit(tick, {
        kind: 'born',
        text: textBorn(child.name, a.name),
        actorId: child.id,
        targetId: a.id,
        pos: child.pos,
      });
    }
  }

  /** 寿命・健康の尽きた個体を退場させる */
  private reap(tick: number, critters: readonly Actor[]): void {
    for (const a of critters) {
      const starved = a.health <= 0;
      if (!starved && a.ageDays <= a.lifespanDays) continue;

      this.bus.emit(tick, {
        kind: 'died',
        text: textDied(a.name, starved),
        actorId: a.id,
        pos: a.pos,
      });
      this.removeActor(a);
      this.deaths++;
    }
  }

  private removeActor(a: Actor): void {
    forgetActor(a);
    forgetCritter(a);
    this.world.removeActor(a.id);
    for (const [key, e] of [...this.scores]) {
      if (e.a === a.id || e.b === a.id) {
        this.scores.delete(key);
        this.lastQuarrelTick.delete(key);
      }
    }
  }

  /**
   * 関係の数が増えすぎないよう、弱い関係から捨てる。
   * 1個体あたり RELATION.maxRelationsPerActor まで。
   */
  private prunePairs(): void {
    const perActor = new Map<EntityId, RelationEntry[]>();
    for (const e of this.scores.values()) {
      for (const id of [e.a, e.b]) {
        const list = perActor.get(id);
        if (list) list.push(e);
        else perActor.set(id, [e]);
      }
    }
    for (const [, list] of perActor) {
      if (list.length <= RELATION.maxRelationsPerActor) continue;
      // 絶対値が小さい（どうでもいい）関係から捨てる
      list.sort((p, q) => Math.abs(p.score) - Math.abs(q.score));
      const drop = list.length - RELATION.maxRelationsPerActor;
      for (let i = 0; i < drop; i++) {
        const e = list[i] as RelationEntry;
        this.scores.delete(pairKey(e.a, e.b));
      }
    }
  }

  stats(): RelationStats {
    let friends = 0;
    let dislikes = 0;
    for (const e of this.scores.values()) {
      if (e.score >= RELATION.befriendThreshold) friends++;
      if (e.score <= DISLIKE_THRESHOLD) dislikes++;
    }
    return {
      pairs: this.scores.size,
      friends,
      dislikes,
      births: this.births,
      deaths: this.deaths,
      quarrels: this.quarrels,
    };
  }
}

function resourceLabel(type: string): string {
  const m: Record<string, string> = {
    berry_tree: '木の実',
    field: '畑のもの',
    fishing_spot: 'さかな',
    water: '水場',
  };
  return m[type] ?? 'たべもの';
}

/** 親のそばで、立てるタイルを探す */
function birthPositionNear(world: IslandWorld, from: Vec2): Vec2 | null {
  const rng = world.rng;
  for (let i = 0; i < 12; i++) {
    const angle = rng.next() * Math.PI * 2;
    const pos = { x: from.x + Math.cos(angle) * BIRTH_OFFSET, y: from.y + Math.sin(angle) * BIRTH_OFFSET };
    if (world.canStandAt(pos)) return pos;
  }
  return world.canStandAt(from) ? { x: from.x, y: from.y } : null;
}

/** 島日が変わるtickかどうか（配線側の判定を揃えるためのヘルパ） */
export function isIslandDayBoundary(tick: number): boolean {
  return tick > 0 && tick % TICKS_PER_ISLAND_DAY === 0;
}
