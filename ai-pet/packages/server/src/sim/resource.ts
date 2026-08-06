/**
 * 資源の回復と荒廃度の減衰（docs/02_ゲーム実装プラン/04_サーバ設計.md §1 step()の2番）
 *
 * 負荷方針（1tickを軽く保つ）:
 * - 資源の回復は RESOURCE.regenEveryTicks ごとにまとめて行う（そのtick数ぶんを一度に足す）
 * - 荒廃度の減衰は16384タイルを RESOURCE.decaySweepSlices 分割し、
 *   RESOURCE.decaySweepEveryTicks ごとに1スライスだけ走査する。
 *   1周 = slices × everyTicks tick かかるので、1周ぶんの減衰量をまとめて引く。
 *   decay は Uint8Array（整数）なので、1周ぶんの端数は世界ごとに繰り越して整数化する。
 *   これで「毎タイル走査していない」のに島時間あたりの減衰量は定数どおりになる。
 *
 * 制約: Math.random() 禁止 / parameter property 禁止 / enum 禁止
 */
import { MAP_H, MAP_W, RESOURCE, TICKS_PER_ISLAND_HOUR, type ResourceNode } from '@ai-pet/shared';
import type { WorldClock } from './clock.ts';
import type { IslandWorld } from './world.ts';

const TILE_COUNT = MAP_W * MAP_H;
const SLICE_SIZE = Math.ceil(TILE_COUNT / RESOURCE.decaySweepSlices);
/** 全タイルを1回走査し終えるまでのtick数 */
const SWEEP_CYCLE_TICKS = RESOURCE.decaySweepSlices * RESOURCE.decaySweepEveryTicks;
/** 1周ぶんの減衰量（島時間換算。小数になるので繰り越しが必要） */
const DECAY_PER_CYCLE = (RESOURCE.decayRecoverPerIslandHour * SWEEP_CYCLE_TICKS) / TICKS_PER_ISLAND_HOUR;

interface SweepState {
  /** まだ引けていない端数 */
  carry: number;
  /** この1周で各タイルから引く整数量 */
  amount: number;
}

/** 島ごとの繰り越し。world に手を入れられないのでモジュール側で持つ（弱参照なのでリークしない） */
const sweepStates = new WeakMap<IslandWorld, SweepState>();

/** 資源の回復と荒廃度の減衰。毎tick呼ぶが、内部で低頻度化している（上のコメント参照） */
export function updateResources(world: IslandWorld, tick: number, clock: WorldClock): void {
  if (tick % RESOURCE.regenEveryTicks === 0) regenNodes(world, tick, clock);
  sweepDecay(world, tick);
}

/** 資源から採る。実際に採れた量を返す（在庫不足なら少なく返す）。荒廃度も上げる */
export function harvest(world: IslandWorld, node: ResourceNode, want: number, tick: number): number {
  // 水やりの期限切れはここで片付ける（毎tick全資源を見に行かないため）
  if (node.wateredUntilTick !== undefined && node.wateredUntilTick <= tick) node.wateredUntilTick = undefined;

  if (!Number.isFinite(want) || want <= 0 || node.amount <= 0) return 0;
  const got = Math.min(want, node.amount);
  node.amount -= got;
  if (node.amount < 1e-9) node.amount = 0;
  // 採り過ぎた場所は荒れる（要件2.1「環境の記憶」）。回復が遅くなるのは regenNodes 側
  world.addDecay(Math.floor(node.pos.x), Math.floor(node.pos.y), RESOURCE.decayPerHarvest);
  return got;
}

/** プレイヤーの水やり。回復が一定時間速くなる */
export function water(node: ResourceNode, tick: number): void {
  node.wateredUntilTick = tick + RESOURCE.wateredIslandHours * TICKS_PER_ISLAND_HOUR;
}

/** その資源が今使えるか（在庫があるか） */
export function isAvailable(node: ResourceNode): boolean {
  return node.amount > 0;
}

/** 荒廃度から回復倍率を出す。荒れたタイルほど戻りが遅い */
function decayRegenFactor(world: IslandWorld, node: ResourceNode): number {
  const d = world.decayAt(Math.floor(node.pos.x), Math.floor(node.pos.y));
  return 1 - (d / RESOURCE.maxDecay) * RESOURCE.decayRegenPenalty;
}

function regenNodes(world: IslandWorld, tick: number, clock: WorldClock): void {
  // regenEveryTicks ぶんをまとめて足すので、島時間あたりの量は毎tick回すのと同じ
  const step = RESOURCE.regenEveryTicks / TICKS_PER_ISLAND_HOUR;
  const season = clock.regenMultiplier;

  for (const node of world.resources.values()) {
    if (node.amount >= node.max) continue;
    const watered =
      node.wateredUntilTick !== undefined && node.wateredUntilTick > tick ? RESOURCE.wateredRegenMultiplier : 1;
    const gain = node.regenPerIslandHour * season * watered * decayRegenFactor(world, node) * step;
    if (gain <= 0) continue;
    node.amount = Math.min(node.max, node.amount + gain);
  }
}

function sweepDecay(world: IslandWorld, tick: number): void {
  if (tick % RESOURCE.decaySweepEveryTicks !== 0) return;

  const slice = Math.floor(tick / RESOURCE.decaySweepEveryTicks) % RESOURCE.decaySweepSlices;
  let st = sweepStates.get(world);
  if (!st) {
    st = { carry: 0, amount: 0 };
    sweepStates.set(world, st);
  }
  if (slice === 0) {
    // 1周の頭で「この周に引く整数量」を決め、端数は次の周へ持ち越す
    st.carry += DECAY_PER_CYCLE;
    st.amount = Math.floor(st.carry);
    st.carry -= st.amount;
  }
  const amount = st.amount;
  if (amount <= 0) return;

  const from = slice * SLICE_SIZE;
  const to = Math.min(TILE_COUNT, from + SLICE_SIZE);
  const decay = world.decay;
  for (let i = from; i < to; i++) {
    const v = decay[i] as number;
    if (v === 0) continue;
    decay[i] = v > amount ? v - amount : 0;
  }
}
