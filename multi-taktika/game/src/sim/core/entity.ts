/**
 * sim/core/entity.ts — エンティティ SoA + free list + generation（実装手順書 §4.4）
 *
 * 決定論のための不変条件（破ると数十分後にデシンクする。§16-1）:
 *  1. **反復は必ず index 昇順。** `for (let i = 0; i < e.highWater; i++)`。
 *  2. **削除で配列を詰め替えない（swap-remove 禁止）。** index を free list に返して再利用する。
 *  3. 再利用時に generation を +1 する。古い `EntityId` は `isAlive` が false を返す。
 *  4. 死亡は `markDead` で予約するだけ。実際の解放は tick 末の `cleanup` システムが
 *     `flushDead` で行う（tick 中に index が生き返らないようにするため）。
 *
 * EntityId の内訳: 上位 16bit = generation、下位 16bit = index。
 * したがって index は 0..65535、つまり容量上限は 65536。
 */

import type { EntityId, EntityKindId, PlayerId } from '@/shared/types';
import { EntityKind, INVALID_ENTITY, NEUTRAL_OWNER } from '@/shared/types';
import type { Fx } from './fx';
import { FX_ONE } from './fx';

/**
 * `lastDamagedBy` の「まだ誰にも殴られていない」を表す値。
 * playerId は 0..7 なので負値を使う（`NEUTRAL_OWNER` = 255 とは区別する。
 * 中立の砲台に殴られることは無いが、255 だと playerId と紛れるため）。
 */
export const NO_DAMAGER = -1;

/** `lastDamagedTick` の未記録を表す値（tick は 0 から始まるので負値にする）。 */
export const NO_DAMAGE_TICK = -1;

/** index に使えるビット幅。 */
export const ENTITY_INDEX_BITS = 16;

/** index のマスク。 */
export const ENTITY_INDEX_MASK = (1 << ENTITY_INDEX_BITS) - 1;

/** 容量の上限（EntityId の index 幅から決まる）。 */
export const ENTITY_CAPACITY_MAX = ENTITY_INDEX_MASK + 1;

/** generation のマスク（16bit で巡回する）。 */
export const ENTITY_GENERATION_MASK = 0xffff;

/**
 * 生産キューの最大長。既定 5 件だが、ローマの固有研究「軍団編成」で 10 件になる
 * （`03§9` / `05§9`）ので、確保は上限の 10 で行う。
 * 実際に使える長さは研究状態から決まる（`queueCount` の上限判定）。
 */
export const MAX_PRODUCTION_QUEUE = 10;

/**
 * 「建設・生産・研究が完了した」ことを表す番兵値（`buildProgress` などに入れる）。
 *
 * 進捗フィールドは「割合 0..FX_ONE」ではなく**積み上げた仕事量**（1 tick × 1.0 倍速 =
 * FX_ONE）で持つ。割合にすると 30 秒（750 tick）の仕事で 1 tick の増分が
 * 256/750 → 0 に丸められて永久に進まなくなるため。必要量は建物・研究ごとに違うので、
 * 「完成した」ことだけは定義に依存しないこの番兵で表す
 * （実際の必要量 = 最大 180 秒 × 25 tick × 256 ≒ 1.2e6 より十分大きい）。
 *
 * **試合開始時に配置する建物（mapgen / シナリオ）にも必ず入れること。**
 * 0 のままだと「建設中」扱いになり、生産も研究も人口提供も動かない。
 */
export const PROGRESS_DONE = 1 << 30;

/**
 * `researchTech` に入れる時代進化の予約値。
 * 時代進化は「町の中心で行う解読」なので、研究と同じ進捗機構に載せる（`03§2`）。
 * tech index + 1 と衝突しないよう負値にしている。
 */
export const RESEARCH_AGE_ADVANCE = -1;

/**
 * ユニットの行動状態。`Entities.state` の値。
 * M4 以降の各システムが使う。ここでは語彙だけ決めておく。
 * 型は `UnitStateId`（同名 const/type は eslint の no-redeclare に当たるため名前を分ける）。
 */
export const UnitState = {
  Idle: 0,
  Moving: 1,
  Attacking: 2,
  /** 採集中（`carryKind` / `carryAmount` を使う。M4） */
  Gathering: 3,
  /** 搬入点へ運搬中（M4） */
  Hauling: 4,
  /** 建設・修理中（M10） */
  Building: 5,
  /** 士気 0 の退却中（M7 の morale。10 秒で復帰） */
  Routed: 6,
  /** 建物・塔に収容されている（M10） */
  Garrisoned: 7,
} as const;
export type UnitStateId = (typeof UnitState)[keyof typeof UnitState];

/**
 * Structure of Arrays 本体。
 * 新しい属性を足すときは `createEntities` の確保と `clearSlot` の初期化、
 * ハッシュ対象なら `sim/hash.ts` も必ず更新すること。
 */
export interface Entities {
  /** 確保済みスロット数（固定。超えたら spawn が例外を投げる）。 */
  readonly capacity: number;
  /** 生存数。 */
  count: number;
  /** これまでに一度でも使った index の上限 + 1。**反復範囲**。 */
  highWater: number;

  /** 1 = 生存。0 = 未使用または死亡予約済み。 */
  readonly alive: Uint8Array;
  /** 世代番号。index を再利用するたびに +1。 */
  readonly generation: Uint16Array;

  /** `EntityKind` */
  readonly kind: Uint8Array;
  /** playerId 0..7、255 = 中立 */
  readonly owner: Uint8Array;
  /** units.json / buildings.json のインデックス */
  readonly typeId: Uint16Array;

  /** 座標（Fx）。1 マス = FX_ONE。 */
  readonly x: Int32Array;
  readonly y: Int32Array;
  /** 速度（Fx / tick）。M3 の movement が使う。 */
  readonly vx: Int32Array;
  readonly vy: Int32Array;

  /** 体力（Fx） */
  readonly hp: Int32Array;
  readonly hpMax: Int32Array;
  /** 士気（Fx、0..FX_ONE。`07§6`） */
  readonly morale: Int32Array;

  /** 0 = 所属なし、1..6 = 戦域スロット */
  readonly frontId: Uint8Array;
  /** 1 = プレイヤーが手動操作中（令から外れる。`06§5`） */
  readonly manual: Uint8Array;
  /**
   * 戦域が閉じた後も保持する最後の令（`ORDER_IDS` の添字 + 1。0 = なし）。
   * 戦域消滅後に「最後の令を保持して待機」する仕様（`07§3`）のため。
   */
  readonly lastOrder: Uint8Array;

  /** `UnitState` */
  readonly state: Uint8Array;
  /** state に入った tick。0.5s 判断や退却 10 秒の計測に使う。 */
  readonly stateTick: Int32Array;
  /** 現在の目標 EntityId（-1 = なし）。 */
  readonly target: Int32Array;
  /** 移動目標（Fx）。 */
  readonly destX: Int32Array;
  readonly destY: Int32Array;

  /** 攻撃クールダウン（残り tick）。 */
  readonly cooldown: Int32Array;

  /** 運搬中の資源種別（`RESOURCE_IDS` の添字 + 1。0 = 手ぶら）。M4 */
  readonly carryKind: Uint8Array;
  /** 運搬中の量（Fx）。M4 */
  readonly carryAmount: Int32Array;
  /** 資源エンティティの残り埋蔵量（Fx）。農地 1 面 = 食料 400。M4 */
  readonly amount: Int32Array;

  /** 建設進捗（Fx、0..FX_ONE）。M10 */
  readonly buildProgress: Int32Array;

  /**
   * 「帰る場所」の EntityId（-1 = なし）。
   * 村人は搬入点、兵は集合地点、退却兵は最寄り拠点。M4 / M6 / M7 が共有する。
   */
  readonly homeId: Int32Array;

  // ---- 生産・研究（建物側。M6）----
  /**
   * 生産キュー。`queueUnit[i * MAX_PRODUCTION_QUEUE + k]` に
   * **unit typeId + 1** を入れる（0 = 空き）。先頭 `[0]` が生産中。
   */
  readonly queueUnit: Int16Array;
  /** キューに入っている件数（0..MAX_PRODUCTION_QUEUE）。 */
  readonly queueCount: Uint8Array;
  /** 生産中の進捗（Fx、0..FX_ONE）。 */
  readonly prodProgress: Int32Array;
  /** 研究中の tech index + 1（0 = なし）。時代進化も予約語として扱う（`RESEARCH_AGE_ADVANCE`）。 */
  readonly researchTech: Int16Array;
  /** 研究の進捗（Fx、0..FX_ONE）。 */
  readonly researchProgress: Int32Array;
  /** 集合地点（Fx）。生産された兵が自動で向かう（`06§6` の `Ctrl`+右クリック）。 */
  readonly rallyX: Int32Array;
  readonly rallyY: Int32Array;
  /** 収容中の人数（塔・櫓・城・町の中心。M10）。 */
  readonly garrisonCount: Uint8Array;
  /** 付属物（井戸・種籾蔵）の親建物 EntityId（-1 = なし）。M10 */
  readonly attachParent: Int32Array;

  // ---- 掟の判定に使う「誰が壊したか」（M11 / 統合）----
  /**
   * 最後にダメージを与えた playerId（-1 = 誰にも殴られていない）。
   *
   * 掟二（井戸）・掟三（種籾蔵）・掟五（逃亡村人）の犯人を **事実で** 特定するための列。
   * 以前は `loyalty.blameRadiusTiles` の近傍推定で犯人を決めていたが、
   * 「近くにいるだけの無関係なプレイヤーが罰される」ので置き換えた。
   *
   * **友軍被害でも記録する。** 掟の判定に必要なのは「誰が壊したか」の事実であって
   * 敵味方の区別ではない（自分の投石で自分の井戸を割ったら自分が罰される）。
   */
  readonly lastDamagedBy: Int32Array;
  /** `lastDamagedBy` を書いた tick（-1 = 未記録）。「直近に殴られたか」の判定に使う。 */
  readonly lastDamagedTick: Int32Array;

  // ---- free list ----
  /** 解放済み index のスタック（LIFO）。 */
  readonly freeList: Int32Array;
  freeCount: number;
  /** 死亡予約された index（`flushDead` で解放する）。 */
  readonly pendingDead: Int32Array;
  pendingDeadCount: number;
}

/** EntityId を index と generation から作る。 */
export function makeEntityId(index: number, generation: number): EntityId {
  return ((generation & ENTITY_GENERATION_MASK) << ENTITY_INDEX_BITS) | (index & ENTITY_INDEX_MASK);
}

/** EntityId → index。 */
export function entityIndex(id: EntityId): number {
  return id & ENTITY_INDEX_MASK;
}

/** EntityId → generation。 */
export function entityGeneration(id: EntityId): number {
  return (id >>> ENTITY_INDEX_BITS) & ENTITY_GENERATION_MASK;
}

/** SoA を確保する。capacity は 1..65536。 */
export function createEntities(capacity: number): Entities {
  if (!Number.isInteger(capacity) || capacity <= 0 || capacity > ENTITY_CAPACITY_MAX) {
    throw new Error(
      `createEntities: capacity must be 1..${ENTITY_CAPACITY_MAX} (got ${capacity})`
    );
  }
  const e: Entities = {
    capacity,
    count: 0,
    highWater: 0,
    alive: new Uint8Array(capacity),
    generation: new Uint16Array(capacity),
    kind: new Uint8Array(capacity),
    owner: new Uint8Array(capacity),
    typeId: new Uint16Array(capacity),
    x: new Int32Array(capacity),
    y: new Int32Array(capacity),
    vx: new Int32Array(capacity),
    vy: new Int32Array(capacity),
    hp: new Int32Array(capacity),
    hpMax: new Int32Array(capacity),
    morale: new Int32Array(capacity),
    frontId: new Uint8Array(capacity),
    manual: new Uint8Array(capacity),
    lastOrder: new Uint8Array(capacity),
    state: new Uint8Array(capacity),
    stateTick: new Int32Array(capacity),
    target: new Int32Array(capacity),
    destX: new Int32Array(capacity),
    destY: new Int32Array(capacity),
    cooldown: new Int32Array(capacity),
    carryKind: new Uint8Array(capacity),
    carryAmount: new Int32Array(capacity),
    amount: new Int32Array(capacity),
    buildProgress: new Int32Array(capacity),
    homeId: new Int32Array(capacity),
    queueUnit: new Int16Array(capacity * MAX_PRODUCTION_QUEUE),
    queueCount: new Uint8Array(capacity),
    prodProgress: new Int32Array(capacity),
    researchTech: new Int16Array(capacity),
    researchProgress: new Int32Array(capacity),
    rallyX: new Int32Array(capacity),
    rallyY: new Int32Array(capacity),
    garrisonCount: new Uint8Array(capacity),
    attachParent: new Int32Array(capacity),
    lastDamagedBy: new Int32Array(capacity),
    lastDamagedTick: new Int32Array(capacity),
    freeList: new Int32Array(capacity),
    freeCount: 0,
    pendingDead: new Int32Array(capacity),
    pendingDeadCount: 0,
  };
  e.owner.fill(NEUTRAL_OWNER);
  e.target.fill(INVALID_ENTITY);
  e.homeId.fill(INVALID_ENTITY);
  e.attachParent.fill(INVALID_ENTITY);
  e.lastDamagedBy.fill(NO_DAMAGER);
  e.lastDamagedTick.fill(NO_DAMAGE_TICK);
  return e;
}

/** スロットの内容を初期状態に戻す（generation は触らない）。 */
function clearSlot(e: Entities, i: number): void {
  e.alive[i] = 0;
  e.kind[i] = EntityKind.None;
  e.owner[i] = NEUTRAL_OWNER;
  e.typeId[i] = 0;
  e.x[i] = 0;
  e.y[i] = 0;
  e.vx[i] = 0;
  e.vy[i] = 0;
  e.hp[i] = 0;
  e.hpMax[i] = 0;
  e.morale[i] = 0;
  e.frontId[i] = 0;
  e.manual[i] = 0;
  e.lastOrder[i] = 0;
  e.state[i] = UnitState.Idle;
  e.stateTick[i] = 0;
  e.target[i] = INVALID_ENTITY;
  e.destX[i] = 0;
  e.destY[i] = 0;
  e.cooldown[i] = 0;
  e.carryKind[i] = 0;
  e.carryAmount[i] = 0;
  e.amount[i] = 0;
  e.buildProgress[i] = 0;
  e.homeId[i] = INVALID_ENTITY;
  const q = i * MAX_PRODUCTION_QUEUE;
  for (let k = 0; k < MAX_PRODUCTION_QUEUE; k++) e.queueUnit[q + k] = 0;
  e.queueCount[i] = 0;
  e.prodProgress[i] = 0;
  e.researchTech[i] = 0;
  e.researchProgress[i] = 0;
  e.rallyX[i] = 0;
  e.rallyY[i] = 0;
  e.garrisonCount[i] = 0;
  e.attachParent[i] = INVALID_ENTITY;
  e.lastDamagedBy[i] = NO_DAMAGER;
  e.lastDamagedTick[i] = NO_DAMAGE_TICK;
}

/** spawn の引数。数値はすべて Fx か整数。 */
export interface SpawnSpec {
  kind: EntityKindId;
  owner: PlayerId;
  typeId: number;
  x: Fx;
  y: Fx;
  hpMax: Fx;
  /** 省略時は hpMax。 */
  hp?: Fx;
  /** 省略時は FX_ONE（満タン）。 */
  morale?: Fx;
}

/**
 * エンティティを 1 体作る。
 * free list に空きがあれば最後に解放された index を再利用し（LIFO）、
 * なければ highWater を伸ばす。**既存の index の並びは絶対に動かさない。**
 */
export function spawnEntity(e: Entities, spec: SpawnSpec): EntityId {
  let i: number;
  if (e.freeCount > 0) {
    e.freeCount -= 1;
    i = e.freeList[e.freeCount]!;
  } else {
    if (e.highWater >= e.capacity) {
      throw new Error(
        `spawnEntity: entity capacity exhausted (capacity=${e.capacity}). ` +
          'createWorld の entityCapacity を増やすか、cleanup の解放漏れを疑うこと。'
      );
    }
    i = e.highWater;
    e.highWater += 1;
  }
  clearSlot(e, i);
  e.alive[i] = 1;
  e.kind[i] = spec.kind;
  e.owner[i] = spec.owner;
  e.typeId[i] = spec.typeId;
  e.x[i] = spec.x;
  e.y[i] = spec.y;
  e.hpMax[i] = spec.hpMax;
  e.hp[i] = spec.hp ?? spec.hpMax;
  e.morale[i] = spec.morale ?? FX_ONE;
  e.count += 1;
  return makeEntityId(i, e.generation[i]!);
}

/** EntityId が今も同じエンティティを指しているか。 */
export function isAlive(e: Entities, id: EntityId): boolean {
  if (id < 0) return false;
  const i = entityIndex(id);
  if (i >= e.highWater) return false;
  return e.alive[i] === 1 && e.generation[i] === entityGeneration(id);
}

/** index が生存しているか（反復中の高速判定用）。 */
export function isAliveIndex(e: Entities, i: number): boolean {
  return i < e.highWater && e.alive[i] === 1;
}

/** EntityId → 生存 index。無効なら -1。 */
export function resolveIndex(e: Entities, id: EntityId): number {
  return isAlive(e, id) ? entityIndex(id) : -1;
}

/** index の現在の EntityId。 */
export function idOfIndex(e: Entities, i: number): EntityId {
  return makeEntityId(i, e.generation[i]!);
}

/**
 * 死亡を予約する。この時点で `alive = 0` になり以降の反復から外れるが、
 * index は **まだ再利用されない**（同一 tick 内で別のエンティティに化けると
 * 参照が壊れるため）。実際の解放は `flushDead`（cleanup システム）で行う。
 */
export function markDead(e: Entities, id: EntityId): boolean {
  const i = resolveIndex(e, id);
  if (i < 0) return false;
  markDeadIndex(e, i);
  return true;
}

/** index 指定版の死亡予約。 */
export function markDeadIndex(e: Entities, i: number): void {
  if (e.alive[i] !== 1) return;
  e.alive[i] = 0;
  e.count -= 1;
  e.pendingDead[e.pendingDeadCount] = i;
  e.pendingDeadCount += 1;
}

/**
 * 死亡予約された index を free list に返す。tick 末の cleanup が呼ぶ。
 *
 * 予約は index 昇順に並べ替えてから処理する。呼び出し側が index 昇順で反復していれば
 * 既に昇順だが、令や投射物の連鎖で順序が乱れても結果が変わらないようにするため
 * 明示的に整列する（全順序・タイブレーク不要な一意キー）。
 */
export function flushDead(e: Entities): number {
  const n = e.pendingDeadCount;
  if (n === 0) return 0;
  const pending = e.pendingDead.subarray(0, n);
  pending.sort();
  for (let k = 0; k < n; k++) {
    const i = pending[k]!;
    clearSlot(e, i);
    e.generation[i] = (e.generation[i]! + 1) & ENTITY_GENERATION_MASK;
    e.freeList[e.freeCount] = i;
    e.freeCount += 1;
  }
  e.pendingDeadCount = 0;
  return n;
}

/**
 * 生存エンティティの index を昇順で列挙する。
 *
 * ホットパスではクロージャを避けて `for` を直接書くこと
 * （このヘルパはテストと低頻度処理向け）。
 */
export function forEachAlive(e: Entities, fn: (i: number) => void): void {
  for (let i = 0; i < e.highWater; i++) {
    if (e.alive[i] === 1) fn(i);
  }
}
