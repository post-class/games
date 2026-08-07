/**
 * プレイヤーのインタラクト（収穫・水やり）（docs/02_ゲーム実装プラン/01_要件とスコープ.md §2.5）
 *
 * `interact` メッセージのうち `act:'harvest'|'water'` をここで処理する。
 * `pet` / `talk` は petHandlers.ts（PetManager）の担当。
 *
 * 方針:
 * - 距離チェックはサーバで行う（docs 05章§3。クライアントの申告は当てにしない）
 * - 資源の増減・荒廃度は resource.ts に任せる（動物の採食と同じ経路を通す）
 * - プレイヤーの持ち物は作らない。採った事実は「島の出来事」として残し、
 *   近くのペットの記憶になる（docs 04章§5）。所持アイテムはMVPのスコープ外。
 *
 * 制約:
 * - Math.random() 禁止
 * - parameter property / enum 禁止（Node の type-stripping で動かすため）
 */
import {
  TICK_HZ,
  type EntityId,
  type ResourceNode,
  type ResourceType,
  type Vec2,
} from '@ai-pet/shared';
import type { WorldClock } from './clock.ts';
import { textHarvest } from './events.ts';
import { harvest as harvestNode, isAvailable, water as waterNode } from './resource.ts';
import { distance, type IslandWorld } from './world.ts';

// ---------- バランス定数 ----------
// TODO: 数値が落ち着いたら shared/src/constants.ts の RESOURCE / INTERACT へ移す
//       （今は constants.ts を他マイルストーンと同時に触りたくないのでここに置いている）

/** インタラクトが届く距離（タイル）。docs §2.5「対象へのインタラクト」 */
const INTERACT_RANGE = 2;
/**
 * 1回の収穫量。動物の採食（petAction.ts の EAT_PORTION 1.5）より多い。
 * 「プレイヤーが手を入れると島が変わる」実感を出しつつ、
 * 木の実の上限が6なのでクールダウン込みで1本を枯らすには数秒かかる、という重さにしている。
 */
const HARVEST_PORTION = 2;
/**
 * 同じプレイヤーの連続インタラクトの間隔（tick）。
 * RATE_LIMITS.interact は4/秒なので、それより緩い「1秒に1回」に絞る。
 * 押しっぱなしで資源を舐め取られると、荒廃度が跳ねて島が回復しなくなるため。
 */
const INTERACT_COOLDOWN_TICKS = TICK_HZ;
/** 収穫を成立させるのに必要な最低在庫。これ未満は「もう採れない」扱い */
const MIN_HARVESTABLE = 1;
/** 収穫・水やりの出来事の重要度（既定の harvest=3 に合わせる） */
const EVENT_IMPORTANCE = 3;
/** クールダウン表が太らないように、この件数を超えたら期限切れぶんを掃除する */
const COOLDOWN_PRUNE_AT = 256;

/** 収穫できる資源。`water`（水場）は飲むだけで収穫対象ではない */
const HARVESTABLE: ReadonlySet<ResourceType> = new Set<ResourceType>(['berry_tree', 'field', 'fishing_spot']);
/** 水やりできる資源。育つものだけ（釣り場と水場に水をやっても意味がない） */
const WATERABLE: ReadonlySet<ResourceType> = new Set<ResourceType>(['field', 'berry_tree']);

/** 出来事の文面に使う「採れたもの」の名前 */
const HARVEST_LABEL: Record<ResourceType, string> = {
  berry_tree: '木の実',
  field: '畑の作物',
  fishing_spot: '魚',
  water: '水',
};
/** 出来事の文面に使う「対象そのもの」の名前 */
const TARGET_LABEL: Record<ResourceType, string> = {
  berry_tree: '木',
  field: '畑',
  fishing_spot: '釣り場',
  water: '水場',
};

// ---------- 型 ----------

export type InteractKind = 'harvest' | 'water';

export type InteractResult =
  | { ok: true; kind: InteractKind; got?: number; text: string; resourceId: EntityId; amount: number }
  | { ok: false; reason: 'not_found' | 'too_far' | 'empty' | 'rate' | 'already_watered' | 'not_waterable' };

export interface InteractDeps {
  emitEvent: (input: {
    kind: 'harvest' | 'build';
    text: string;
    pos?: Vec2;
    actorId?: EntityId;
    importance?: number;
  }) => void;
}

interface InteractOpts {
  playerId: string;
  playerName: string;
  actorId: EntityId;
  targetId: EntityId;
  playerPos: Vec2;
  tick: number;
}

/** 水やりの期限が生きているか。resource.ts と同じ判定 */
function isWatered(node: ResourceNode, tick: number): boolean {
  return node.wateredUntilTick !== undefined && node.wateredUntilTick > tick;
}

export class InteractSystem {
  private world: IslandWorld;
  private clock: WorldClock;
  private deps: InteractDeps;
  /** playerId → 最後にインタラクトが成立したtick（失敗では進めない） */
  private lastActTick = new Map<string, number>();

  private harvestCount = 0;
  private harvestedAmount = 0;
  private waterCount = 0;
  private rejected = 0;

  // 注意: Node の type-stripping で動かすため parameter property は使えない
  constructor(world: IslandWorld, clock: WorldClock, deps: InteractDeps) {
    this.world = world;
    this.clock = clock;
    this.deps = deps;
  }

  /** 収穫する。プレイヤーの持ち物は作らず「島の出来事」として残す（持ち物はスコープ外） */
  harvest(opts: InteractOpts): InteractResult {
    const node = this.world.resources.get(opts.targetId);
    // 水場を収穫しようとした場合も「そんな対象はない」で返す（種別を教える必要がない）
    if (!node || !HARVESTABLE.has(node.type)) return this.reject('not_found');
    if (!this.inRange(opts.playerPos, node)) return this.reject('too_far');
    if (this.onCooldown(opts.playerId, opts.tick)) return this.reject('rate');
    if (!isAvailable(node) || node.amount < MIN_HARVESTABLE) return this.reject('empty');

    // 在庫の減少と荒廃度の増加は resource.ts が面倒を見る（動物の採食と同じ経路）
    const got = harvestNode(this.world, node, HARVEST_PORTION, opts.tick);
    if (got <= 0) return this.reject('empty');

    this.noteAct(opts.playerId, opts.tick);
    this.harvestCount++;
    this.harvestedAmount += got;

    const text = textHarvest(opts.playerName, HARVEST_LABEL[node.type]);
    this.deps.emitEvent({
      kind: 'harvest',
      text,
      pos: node.pos,
      actorId: opts.actorId,
      importance: EVENT_IMPORTANCE,
    });
    return { ok: true, kind: 'harvest', got, text, resourceId: node.id, amount: node.amount };
  }

  /** 水やりする。一定時間だけ資源の回復が速くなる */
  water(opts: InteractOpts): InteractResult {
    const node = this.world.resources.get(opts.targetId);
    if (!node) return this.reject('not_found');
    if (!WATERABLE.has(node.type)) return this.reject('not_waterable');
    if (!this.inRange(opts.playerPos, node)) return this.reject('too_far');
    if (this.onCooldown(opts.playerId, opts.tick)) return this.reject('rate');
    if (isWatered(node, opts.tick)) return this.reject('already_watered');

    waterNode(node, opts.tick);
    this.noteAct(opts.playerId, opts.tick);
    this.waterCount++;

    const text = `${opts.playerName}が${TARGET_LABEL[node.type]}に水をやった`;
    // IslandEventKind に 'water' が無いため 'build'（重要度5相当の「手を入れた」枠）を使う。
    // 収穫と混ざると「誰が採ったか」の集計が濁るので、あえて harvest と分けている。
    this.deps.emitEvent({
      kind: 'build',
      text,
      pos: node.pos,
      actorId: opts.actorId,
      importance: EVENT_IMPORTANCE,
    });
    return { ok: true, kind: 'water', text, resourceId: node.id, amount: node.amount };
  }

  /**
   * その資源にいま何ができるか（クライアントのメニュー表示に使う）。
   *
   * `tick` は水やりの期限を見るために使う。省略された場合は
   * 「一度でも水をやられた資源には水やりを出さない」安全側に倒す
   * （WorldClock は現在tickを保持していないので、呼び出し側から渡すのが正確）。
   */
  actionsFor(resourceId: EntityId, playerPos: Vec2, tick?: number): InteractKind[] {
    const node = this.world.resources.get(resourceId);
    if (!node) return [];
    if (!this.inRange(playerPos, node)) return [];

    const out: InteractKind[] = [];
    if (HARVESTABLE.has(node.type) && node.amount >= MIN_HARVESTABLE) out.push('harvest');
    const watered = tick === undefined ? node.wateredUntilTick !== undefined : isWatered(node, tick);
    if (WATERABLE.has(node.type) && !watered) out.push('water');
    return out;
  }

  stats(): Record<string, unknown> {
    return {
      harvests: this.harvestCount,
      harvestedAmount: Math.round(this.harvestedAmount * 100) / 100,
      waterings: this.waterCount,
      rejected: this.rejected,
      cooldownTracked: this.lastActTick.size,
      islandDay: this.clock.islandDay,
    };
  }

  // ---------- 補助 ----------

  private inRange(playerPos: Vec2, node: ResourceNode): boolean {
    return distance(playerPos, node.pos) <= INTERACT_RANGE;
  }

  private onCooldown(playerId: string, tick: number): boolean {
    const last = this.lastActTick.get(playerId);
    return last !== undefined && tick - last < INTERACT_COOLDOWN_TICKS;
  }

  private noteAct(playerId: string, tick: number): void {
    this.lastActTick.set(playerId, tick);
    if (this.lastActTick.size <= COOLDOWN_PRUNE_AT) return;
    // 退島したプレイヤーぶんが残り続けないように、期限切れは捨てる
    for (const [id, t] of this.lastActTick) {
      if (tick - t >= INTERACT_COOLDOWN_TICKS) this.lastActTick.delete(id);
    }
  }

  private reject(reason: Exclude<InteractResult, { ok: true }>['reason']): InteractResult {
    this.rejected++;
    return { ok: false, reason };
  }
}
