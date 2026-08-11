/**
 * sim/core/gather.ts — 採集・搬入の計算（`07§8`, 実装手順書 §6.6。M4 / T-M4-01〜04, 09, 10）
 *
 * `economy.ts`（システム）から呼ばれる**純関数寄り**の層。World を書き換える関数と
 * 書き換えない関数を明確に分けてあり、テストは後者だけで数値を検証できる。
 *
 * 中核の式（`07§8`）:
 * ```
 * 実効収集速度 = 基礎速度 × 研究倍率 × 文明倍率 × (1 − 運搬損失)
 *   運搬損失 = min(0.50, floor(片道距離マス / 4) * 0.05)
 * ```
 * 「片道距離」は **資源ノード → 搬入点** の直線距離。搬入点が近いほど効率が上がる
 * （森のそばに伐採所を建てるのが最優先の内政行動という設計意図）。
 *
 * 決定論について（§0.3, §16-1）:
 *  - 速度は「毎秒 Fx」で持ち、1 tick 分は `gatherAmountForTick` が
 *    **整数除算の差分**で切り出す。`fx(rate / TICK_RATE)` のように毎 tick の値を
 *    先に丸めると 0.45/秒 が 0.39/秒 になるほど誤差が乗るため、この形にしている。
 *    25 tick 積み上げるとちょうど「毎秒の量」に一致する（テストで担保）。
 *  - 比率（0.05 / 0.5 など）は読み込み時に万分率（bp）の整数へ落としてから Fx にする。
 *    実行中に float を作らない。
 *  - 距離比較は平方距離。近傍の探索は index 昇順で走査し、同距離は **index が小さい方**を採る。
 */

import resourcesJson from '@/data/resources.json' with { type: 'json' };

import type { EntityId, PlayerId } from '@/shared/types';
import { EntityKind, INVALID_ENTITY, NEUTRAL_OWNER, RESOURCE_IDS } from '@/shared/types';

import { TICK_RATE, cfgBool, cfgNum } from './config';
import type { Entities } from './entity';
import {
  UnitState,
  idOfIndex,
  isAliveIndex,
  markDeadIndex,
  resolveIndex,
  spawnEntity,
} from './entity';
import { buildingDef, buildingIndex, roleToIndex, unitDef, unitIndex } from './defs';
import type { GatherFrom, PlayerModifiers } from './effects';
import { depositMul, farmYieldMul, gatherRateMul, getPlayerModifiers } from './effects';
import type { Fx } from './fx';
import { FX_ONE, distSq, fx, fxMul, fxToInt, idiv, isqrt } from './fx';
import type { World } from './world';
import { getPlayer } from './world';

// ---------------------------------------------------------------- config の任意キー

/**
 * 万分率の基数。比率の設定値（0.05 など）を **整数**で扱うために使う。
 * `fx(0.05)` は 13/256 = 5.08% になるが、bp 経由なら 500bp → 12/256 で誤差方向が揃う。
 */
export const BP = 10000;

/** 比率の設定値を bp（万分率）整数で引く。読み込み時の 1 回だけ float に触れる。 */
export function cfgBp(path: string): number {
  return Math.round(cfgNum(path) * BP);
}

/** bp → Fx（0 方向切り捨て）。 */
export function bpToFx(bp: number): Fx {
  return idiv(bp * FX_ONE, BP);
}




/**
 * 農地の自動再建（`07§8`「自動再建の設定も可」/ T-M4-04）。
 *
 * **申し送り**: `config.json` に `economy.farmAutoRebuild` が無いため既定 true で動く。
 * キーを追加すればそのまま効く（コード変更不要）。
 */
export function farmAutoRebuildEnabled(): boolean {
  return cfgBool('economy.farmAutoRebuild');
}

/** 資源の枯渇（試合オプション。無効にすると森と鉱脈が無限になる。`07§14`）。 */
export function resourceDepletionEnabled(): boolean {
  return cfgBool('matchOptions.resourceDepletion.default');
}

/** 村人の自動退避（`07§8` / T-M4-09。設定で無効化可）。 */
export function villagerFleeEnabled(): boolean {
  return cfgBool('economy.villagerFleeToTowerEnabled');
}

// ---------------------------------------------------------------- 資源ノード定義

/**
 * 採集対象（資源ノード）の定義。`Entities.kind === EntityKind.Resource` の
 * `typeId` がこの配列の添字になる。
 *
 * 並び順は `RESOURCE_IDS` の順 × `resources.json` の `gatherFrom` の記述順で固定。
 * **申し送り（M3 mapgen 向け）**: 森・鉱脈・果樹などを配置するときは
 * `resourceNodeIndex('forest')` などでこの index を引き、`spawnResourceNode` を使うこと。
 */
export interface ResourceNodeDef {
  /** `Entities.typeId` に入る値。 */
  readonly index: number;
  /** `resources.json` の `gatherFrom` に出てくるノード ID（`forest` `farm` など）。 */
  readonly id: string;
  /** `RESOURCE_IDS` の添字（この ノードから採れる資源）。 */
  readonly resource: number;
  /** 基礎速度（**毎秒** Fx）。1 tick 分は `gatherAmountForTick` で切り出す。 */
  readonly baseRatePerSec: Fx;
  /** 既定の埋蔵量（Fx）。農地 1 面 = 食料 400（`07§8`）。 */
  readonly deposit: Fx;
  /** 採り切ると消えるか。 */
  readonly depletable: boolean;
  /** 枯れた後に建て直せるか（農地のみ true）。 */
  readonly rebuildable: boolean;
}

/**
 * `gatherFrom` に並んでいるが**マップ上のノードではない**収入経路。
 * 交易・貢納は `market.ts` の担当なのでノード表から外す。
 */
const NON_NODE_GATHER_SOURCES: readonly string[] = ['trade', 'tribute'];

export const RESOURCE_NODE_DEFS: readonly ResourceNodeDef[] = buildResourceNodeDefs();

const nodeIndexById = new Map<string, number>(RESOURCE_NODE_DEFS.map((n, i) => [n.id, i]));

function buildResourceNodeDefs(): ResourceNodeDef[] {
  const src = resourcesJson as unknown as Record<string, Record<string, unknown>>;
  const out: ResourceNodeDef[] = [];
  for (let r = 0; r < RESOURCE_IDS.length; r++) {
    const rid = RESOURCE_IDS[r]!;
    const rec = src[rid];
    if (rec === undefined) throw new Error(`gather: resources.json に "${rid}" がない`);
    const ratePerSec = numOf(rec['baseGatherRatePerSec'], `resources.json:${rid}.baseGatherRatePerSec`);
    const defaultDeposit = numOf(rec['defaultDeposit'], `resources.json:${rid}.defaultDeposit`);
    const byNode = (rec['depositsByNode'] ?? {}) as Record<string, number>;
    const from = (rec['gatherFrom'] ?? []) as string[];
    for (const nodeId of from) {
      if (NON_NODE_GATHER_SOURCES.includes(nodeId)) continue;
      const dep = typeof byNode[nodeId] === 'number' ? byNode[nodeId]! : defaultDeposit;
      out.push({
        index: out.length,
        id: nodeId,
        resource: r,
        baseRatePerSec: fx(ratePerSec),
        deposit: fx(dep),
        depletable: rec['depletable'] === true,
        rebuildable: rec['rebuildable'] === true,
      });
    }
  }
  return out;
}

function numOf(v: unknown, where: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`gather: ${where} が有限の数値でない`);
  }
  return v;
}

/** ノード ID → typeId。未知の ID は例外（黙って 0 にしない）。 */
export function resourceNodeIndex(id: string): number {
  const i = nodeIndexById.get(id);
  if (i === undefined) throw new Error(`gather: 未知の資源ノード "${id}"`);
  return i;
}

/** typeId → ノード定義。 */
export function resourceNodeDef(typeId: number): ResourceNodeDef {
  const d = RESOURCE_NODE_DEFS[typeId];
  if (d === undefined) throw new Error(`gather: 範囲外の資源ノード typeId ${typeId}`);
  return d;
}

// ---------------------------------------------------------------- 定数（構造的なもの）

/**
 * 採集・搬入の到達判定半径（Fx）。
 * 「1 マス = 村人 1 体分の幅」（`07§1`）なのでバランス数値ではなく構造定数。
 * 距離判定は平方距離で行う（`INTERACT_REACH * INTERACT_REACH` と比較）。
 */
export const INTERACT_REACH: Fx = FX_ONE;

/** 村人の role index（`roleToIndex('villager')`）。 */
export const VILLAGER_ROLE_IDX = roleToIndex('villager');

/** 農地の building typeId。 */
export const FARM_BUILDING_TYPE = buildingIndex('farm');

/** 農地の資源ノード typeId。 */
export const FARM_NODE_TYPE = resourceNodeIndex('farm');

/** 交易荷車の unit typeId（`market.ts` / `economy.ts` が使う）。 */
export const TRADE_CART_TYPE = unitIndex('trade_cart');

// ---------------------------------------------------------------- 距離と運搬損失

/** 2 点間の直線距離（Fx）。`isqrt(平方距離)` で求める（float を作らない）。 */
export function distanceFx(x0: Fx, y0: Fx, x1: Fx, y1: Fx): Fx {
  return isqrt(distSq(x0, y0, x1, y1));
}

/**
 * 運搬損失（Fx 比率、0..FX_ONE）。T-M4-02。
 * ```
 * 損失 = min(haulLossMax, floor(片道距離マス / haulLossTilesPerStep) * haulLossPer4Tiles)
 * ```
 * 40 マスで `floor(40/4) * 0.05 = 0.50` となり、上限とちょうど一致して止まる。
 */
export function haulLossRatioFx(oneWayDistFx: Fx): Fx {
  if (oneWayDistFx <= 0) return 0;
  const tiles = fxToInt(oneWayDistFx);
  const stepTiles = cfgNum('economy.haulLossTilesPerStep');
  const steps = idiv(tiles, stepTiles);
  const lossBp = steps * cfgBp('economy.haulLossPer4Tiles');
  const maxBp = cfgBp('economy.haulLossMax');
  return bpToFx(lossBp > maxBp ? maxBp : lossBp);
}

// ---------------------------------------------------------------- 倍率（研究・文明）

/**
 * 資源ノード ID → 効果側の「採集元」（`GatherFrom`）。
 *
 * **名前が一致しないものがある**ので表で持つ。`resources.json` は羊を `sheep` と書き、
 * 効果側（`techs.json:_meta.effectTypes`）は `herd`（畜獣）と書く。
 * 石切場と金鉱はどちらも効果側では `mine`（採掘）にまとまる。
 *
 * 表に無いノードが増えたら**起動時に落とす**（黙って倍率 1.0 になると、
 * 「研究したのに速くならない」が誰にも気付かれないまま残る ―― 実際にそれが起きた）。
 */
const GATHER_FROM_OF_NODE: Readonly<Record<string, GatherFrom>> = {
  farm: 'farm',
  hunt: 'hunt',
  fish: 'fish',
  fruit: 'fruit',
  sheep: 'herd',
  forest: 'forest',
  stone_quarry: 'mine',
  gold_mine: 'mine',
};

/** ノード typeId ごとの `GatherFrom`（起動時に 1 回だけ引く）。 */
const gatherFromByNodeType: readonly GatherFrom[] = RESOURCE_NODE_DEFS.map((n) => {
  const from = GATHER_FROM_OF_NODE[n.id];
  if (from === undefined) {
    throw new Error(
      `gather: 資源ノード "${n.id}" に対応する採集元（GatherFrom）が GATHER_FROM_OF_NODE にない`
    );
  }
  return from;
});

/**
 * そのノードを採るときの採集倍率（Fx）＝ **文明 × 研究 × 建物**の積。
 *
 * ■ ここが長く空いていた（実装漏れ）
 * この関数はもともと `researchGatherMulFx` / `civGatherMulFx` という
 * **1.0 を返すだけのスタブ 2 本**で、「M6 で中身を差し替える」と書いてあった。
 * ところが M6（`core/effects.ts`）で適用エンジンを作ったとき、
 * **ここを差し替えるのを忘れた**。結果:
 *  - ヤマトの「農地の食料 +15%」も、地下水路の「村人の採集 +15%」も、
 *    採集速度を上げる研究も、**すべて効いていなかった**。
 *  - 気付いたきっかけは文明バランスの実測で、ヤマト・唐・ヴァイキング・マリ・モンゴルの
 *    30 分後の数値（人口 32.4 / 建物 19.0 / 資源計 1598.6）が**小数点まで完全に一致**したこと。
 *    5 文明が同じ動きをするのは「文明の差がゲームに届いていない」ということだった。
 * 教訓: **既定値を返すスタブは、忘れても何も壊れないので気付けない。**
 * 未結線を残すなら、既定値ではなく落とすか、結線を検算するテストを先に書く。
 *
 * ■ なぜ倍率をまとめて 1 本にしたか
 * `PlayerModifiers`（`core/effects.ts`）は文明・研究・建物を**すでに 1 つに畳んで**持つ。
 * 分けて取り出す API は無く、分ける意味も無い（`07§8` の式では積になるだけ）。
 */
export function gatherMulFx(w: World, p: PlayerId, nodeTypeId: number): Fx {
  return gatherMulOf(getPlayerModifiers(w, p), nodeTypeId);
}

/**
 * 同じもの。**集約結果を先に引いてある**ときはこちらを使う。
 *
 * ■ なぜ 2 つあるのか（性能）
 * 毎 tick・村人ごとに `getPlayerModifiers` を呼んでいたとき、
 * `economy` が **0.86 ms/tick**（1 tick 1.46 ms のうち 59%）を食っていた。
 * 集約結果は 1 tick のあいだ変わらないので、`systems/economy.ts` は
 * 席ごとに 1 回だけ引いてこちらへ渡す。
 * `gatherMulFx`（World から引く版）はテストと単発の問い合わせ用に残してある。
 */
export function gatherMulOf(m: PlayerModifiers, nodeTypeId: number): Fx {
  const def = resourceNodeDef(nodeTypeId);
  const from = gatherFromByNodeType[nodeTypeId];
  if (from === undefined) throw new Error(`gather: 範囲外の資源ノード typeId ${nodeTypeId}`);
  const resource = RESOURCE_IDS[def.resource];
  if (resource === undefined) throw new Error(`gather: 範囲外の resource ${def.resource}`);
  return gatherRateMul(m, resource, from);
}

/**
 * これから置く資源ノードの埋蔵量（Fx）= 既定値 × `depositMul` ×（農地なら）`farmYieldMul`。
 *
 * ■ ここも未結線だった（`gatherMulFx` と同じ穴）
 * `core/effects.ts` は `depositMul`（坑道: 石材・金の鉱脈 1.3）と
 * `farmYieldMul`（犂 1.3 / 輪作 1.4 / 勧農 1.2）を正しく畳んで持っていたのに、
 * `spawnResourceNode` が `def.deposit` を**固定で**渡していたため、
 * 研究しても埋蔵量が 1 も増えていなかった。適用エンジン側に手を入れる必要はなく、
 * 「ノードを置く 1 箇所」で読めば全経路（mapgen / `spawnFarm` / `rebuildFarm` /
 * `structure.ts` の農地完成時）に同時に届くので、ここに結線した。
 *
 * ■ なぜ「生成する瞬間」に決めるのか（遡って増やさない）
 * 埋蔵量は `Entities.amount` に置かれた**残量そのもの**で、採った分だけ減っていく。
 * 研究完了時に既存ノードの `amount` を増やすと、
 *  - 半分採った畑の残量が突然増える（プレイヤーから見て「湧いた」ように見える）
 *  - 増やす基準が「残量 × 倍率」か「上限 × 倍率 − 採った分」かで結果が変わり、
 *    どちらも「総産出量 × 倍率」にならない（後者は残量が負にもなり得る）
 *  - 研究を跨いだ順序で残量が変わるので、再計算のタイミング違いがそのままデシンクになる
 * ので採らなかった。**研究後に作った農地・置かれた鉱脈だけが増える**。
 * 「犂を入れてから畑を張り直す」が意味を持つのは、内政の判断としても自然。
 *
 * ■ 中立ノード
 * mapgen が置く森・鉱脈は所有者が中立（`NEUTRAL_OWNER`）で、倍率を掛ける相手が
 * 存在しない。所有者を特定できないときは**倍率 1.0**（= 既定値そのまま）を返す。
 * ここで例外を投げるとマップ生成が落ちるので、静かに既定値にする。
 */
export function depositForNewNodeFx(w: World, nodeTypeId: number, owner?: PlayerId): Fx {
  const def = resourceNodeDef(nodeTypeId);
  // 中立 / 席の外 / まだ PlayerState が無い（生成順の都合）→ 倍率なし。
  if (owner === undefined || owner === NEUTRAL_OWNER || owner >= w.playerCount) return def.deposit;
  if (getPlayer(w, owner) === undefined) return def.deposit;
  const resource = RESOURCE_IDS[def.resource];
  if (resource === undefined) throw new Error(`gather: 範囲外の resource ${def.resource}`);
  const m = getPlayerModifiers(w, owner);
  // 掛ける順序は固定（`fxMul` は切り捨てなので順序が結果を決める。§0.3）。
  let v = fxMul(def.deposit, depositMul(m, resource));
  // 農地 1 面の総産出量だけに掛かる倍率（犂・輪作・勧農）。
  if (nodeTypeId === FARM_NODE_TYPE) v = fxMul(v, farmYieldMul(m));
  return v;
}

// ---------------------------------------------------------------- 実効収集速度

/**
 * 実効収集速度（**毎秒** Fx）= 基礎速度 × 倍率 × 倍率 × (1 − 運搬損失)。
 * 運搬損失は資源ノード → 搬入点の片道距離から求める。
 *
 * 倍率を 2 つ受けるのは**テストから任意の値を差し込めるようにするため**。
 * 実戦の呼び出し（`systems/economy.ts`）は `gatherMulFx` の 1 本で足りる
 * （文明・研究・建物は `PlayerModifiers` の中で既に積になっている）。
 */
export function effectiveGatherRatePerSecFx(
  nodeTypeId: number,
  oneWayDistFx: Fx,
  mulFx: Fx = FX_ONE,
  mul2Fx: Fx = FX_ONE
): Fx {
  const def = resourceNodeDef(nodeTypeId);
  const loss = haulLossRatioFx(oneWayDistFx);
  let r = fxMul(def.baseRatePerSec, mulFx);
  r = fxMul(r, mul2Fx);
  r = fxMul(r, FX_ONE - loss);
  return r > 0 ? r : 0;
}

/**
 * 「毎秒 Fx」の速度から **この tick 分**の量（Fx）を切り出す。
 *
 * `elapsedTicks` は採集を始めてから経過した tick 数（0 起点）。
 * 整数除算の差分を取るので、25 tick 分を足すと必ず `ratePerSecFx` に一致し、
 * 端数が消えて速度が目減りすることがない（毎 tick 丸めると 13% 以上ずれる）。
 */
export function gatherAmountForTick(ratePerSecFx: Fx, elapsedTicks: number): Fx {
  if (ratePerSecFx <= 0) return 0;
  const t = elapsedTicks < 0 ? 0 : elapsedTicks;
  const cur = idiv(ratePerSecFx * (t + 1), TICK_RATE);
  const prev = idiv(ratePerSecFx * t, TICK_RATE);
  return cur - prev;
}

/** 村人の運搬容量（Fx）。`economy.carryCapacity` = 10 単位。 */
export function carryCapacityFx(): Fx {
  return fx(cfgNum('economy.carryCapacity'));
}

// ---------------------------------------------------------------- 判定ヘルパ

/** index が生きている資源ノードか。 */
export function isResourceNode(e: Entities, i: number): boolean {
  return isAliveIndex(e, i) && e.kind[i] === EntityKind.Resource;
}

/** index が生きている搬入点（町の中心・伐採所・採掘場・桟橋など）か。 */
export function isDropOffIndex(e: Entities, i: number): boolean {
  if (!isAliveIndex(e, i) || e.kind[i] !== EntityKind.Building) return false;
  return buildingDef(e.typeId[i]!).isDropOff;
}

/** index が村人か。 */
export function isVillagerIndex(e: Entities, i: number): boolean {
  if (!isAliveIndex(e, i) || e.kind[i] !== EntityKind.Unit) return false;
  return unitDef(e.typeId[i]!).roleIdx === VILLAGER_ROLE_IDX;
}

/** `i` が `(tx, ty)` の到達半径内にいるか（平方距離で比較）。 */
/**
 * **相手の大きさを足した到達距離。**
 *
 * `INTERACT_REACH` は 1 マス（村人 1 体分）だが、これを建物の**中心**との距離に
 * そのまま当てると 4×4 の町の中心には**構造的に到達できない**
 * （縁に立っても中心までは 2 マス以上ある）。実測で「満載の村人が搬入点の
 * 1.6 マス手前で永久に止まり、資源が tick 4000 で凍る」という壊れ方をした。
 *
 * 建物には「大きさの半分」を足して、**縁に着いたら到着**とする。
 * 資源ノードや兵は 1×1 相当なので従来どおり。
 */
export function interactReachTo(e: Entities, targetIndex: number): Fx {
  if (e.kind[targetIndex] !== EntityKind.Building && e.kind[targetIndex] !== EntityKind.Attachment) {
    return INTERACT_REACH;
  }
  const def = buildingDef(e.typeId[targetIndex]!);
  const halfW = idiv(def.sizeW * FX_ONE, 2);
  const halfH = idiv(def.sizeH * FX_ONE, 2);
  return INTERACT_REACH + (halfW > halfH ? halfW : halfH);
}

export function withinReach(e: Entities, i: number, tx: Fx, ty: Fx, reach: Fx = INTERACT_REACH): boolean {
  return distSq(e.x[i]!, e.y[i]!, tx, ty) <= reach * reach;
}

/**
 * 最寄りの搬入点（同じプレイヤーの建物）の index。無ければ -1。
 * index 昇順に走査し、同距離なら index が小さい方を採る（全順序を固定）。
 */
export function findNearestDropOffIndex(w: World, owner: PlayerId, x: Fx, y: Fx): number {
  const e = w.entities;
  let best = -1;
  let bestSq = 0;
  for (let i = 0; i < e.highWater; i++) {
    if (e.owner[i] !== owner || !isDropOffIndex(e, i)) continue;
    const d = distSq(x, y, e.x[i]!, e.y[i]!);
    if (best < 0 || d < bestSq) {
      best = i;
      bestSq = d;
    }
  }
  return best;
}

/**
 * 最寄りの資源ノードの index。無ければ -1。
 * `resource` に 0..3 を渡すとその資源だけ、-1 なら資源を問わない。
 */
/**
 * `(x, y)` に最も近い資源ノードの index（資源の種類を問わない）。無ければ -1。
 *
 * 用途は 1 つだけ: **向かっていたノードが、着く前に他の村人に採り切られたとき**の復帰。
 * その瞬間には「何を採るつもりだったか」がどこにも残っていない
 * （`carryKind` は手ぶらなら 0 で、投射物や荷車が別用途で使っているので
 *  「仕事の記憶」に転用できない）。
 * 失った目標の座標のいちばん近くにあるノードを継ぐ ―― mapgen は同じ資源を
 * 塊で置くので、実際にはほぼ同じ資源になる。
 *
 * 決定論: 距離が同じなら index の小さい方（乱数を使わない）。
 */
export function findNearestResourceNodeAnyIndex(w: World, x: Fx, y: Fx): number {
  const e = w.entities;
  let best = -1;
  let bestSq = 0;
  for (let i = 0; i < e.highWater; i++) {
    if (!isResourceNode(e, i)) continue;
    if (e.amount[i]! <= 0) continue;
    const sq = distSq(x, y, e.x[i]!, e.y[i]!);
    if (best < 0 || sq < bestSq) {
      best = i;
      bestSq = sq;
    }
  }
  return best;
}

export function findNearestResourceNodeIndex(w: World, x: Fx, y: Fx, resource: number): number {
  const e = w.entities;
  let best = -1;
  let bestSq = 0;
  for (let i = 0; i < e.highWater; i++) {
    if (!isResourceNode(e, i)) continue;
    if (e.amount[i]! <= 0) continue;
    if (resource >= 0 && resourceNodeDef(e.typeId[i]!).resource !== resource) continue;
    const d = distSq(x, y, e.x[i]!, e.y[i]!);
    if (best < 0 || d < bestSq) {
      best = i;
      bestSq = d;
    }
  }
  return best;
}

/**
 * 最寄りの退避先（塔・櫓・城 = `garrisonCapacity > 0`）の index。無ければ -1。
 * 収容に空きがあるものだけを候補にする。
 */
export function findNearestShelterIndex(w: World, owner: PlayerId, x: Fx, y: Fx): number {
  const e = w.entities;
  let best = -1;
  let bestSq = 0;
  for (let i = 0; i < e.highWater; i++) {
    if (!isAliveIndex(e, i) || e.kind[i] !== EntityKind.Building) continue;
    if (e.owner[i] !== owner) continue;
    const def = buildingDef(e.typeId[i]!);
    if (def.garrisonCapacity <= 0) continue;
    if (e.garrisonCount[i]! >= def.garrisonCapacity) continue;
    const d = distSq(x, y, e.x[i]!, e.y[i]!);
    if (best < 0 || d < bestSq) {
      best = i;
      bestSq = d;
    }
  }
  return best;
}

// ---------------------------------------------------------------- spawn ヘルパ

/** `spawnResourceNode` の任意引数。 */
export interface ResourceNodeSpawnOptions {
  /** 所有者（農地は建てたプレイヤー。森・鉱脈は中立）。 */
  readonly owner?: PlayerId;
  /** 埋蔵量（Fx）。省略時はノード定義の既定値。 */
  readonly amount?: Fx;
  /** 農地の場合の親建物（`Entities.homeId` に入れる）。 */
  readonly parent?: EntityId;
}

/**
 * 資源ノードを 1 つ置く。M3 の mapgen と M4 のテストが共通で使う入口。
 * HP は「壊せない」ことを表すため 1（Fx）固定。埋蔵量は `amount` に入る。
 *
 * 埋蔵量を明示しなかった場合は `depositForNewNodeFx`（既定値 × 研究・文明の倍率）を使う。
 * `opts.amount` を渡した場合は**そのままの値**にする（mapgen が塊の大きさを決めたり、
 * テストが特定の残量から始めたりするので、そこに倍率を重ねると意図が壊れる）。
 */
export function spawnResourceNode(
  w: World,
  nodeTypeId: number,
  x: Fx,
  y: Fx,
  opts?: ResourceNodeSpawnOptions
): EntityId {
  const id = spawnEntity(w.entities, {
    kind: EntityKind.Resource,
    owner: opts?.owner ?? NEUTRAL_OWNER,
    typeId: nodeTypeId,
    x,
    y,
    hpMax: FX_ONE,
  });
  const i = resolveIndex(w.entities, id);
  w.entities.amount[i] = opts?.amount ?? depositForNewNodeFx(w, nodeTypeId, opts?.owner);
  if (opts?.parent !== undefined) w.entities.homeId[i] = opts.parent;
  return id;
}

/** `spawnFarm` の戻り値。 */
export interface FarmPair {
  /** 農地の建物 EntityId。 */
  readonly building: EntityId;
  /** 農地の上に載る資源ノード EntityId（埋蔵量 = 食料 400）。 */
  readonly node: EntityId;
}

/**
 * 農地を 1 面置く（建物 + 資源ノードの対）。
 *
 * 農地は「建物」でありながら「採集対象」でもあるので、埋蔵量を持つノードを
 * 同座標に置き、ノードの `homeId` に建物 EntityId を入れて紐付ける。
 * こうしておくと、枯れたときにノードだけ差し替えれば再建になる（T-M4-04）。
 *
 * 埋蔵量は `spawnResourceNode` が `farmYieldMul`（犂・輪作・勧農）を掛けて決める。
 * `amount` を渡さないのは意図的（ここで固定値を渡すと倍率がまた死ぬ）。
 */
export function spawnFarm(w: World, owner: PlayerId, x: Fx, y: Fx): FarmPair {
  const def = buildingDef(FARM_BUILDING_TYPE);
  const building = spawnEntity(w.entities, {
    kind: EntityKind.Building,
    owner,
    typeId: FARM_BUILDING_TYPE,
    x,
    y,
    hpMax: def.hp,
  });
  const node = spawnResourceNode(w, FARM_NODE_TYPE, x, y, { owner, parent: building });
  return { building, node };
}

// ---------------------------------------------------------------- 農地の再建（T-M4-04）

/**
 * 枯れた農地の再建コスト（資源 index 順の Fx）。
 * `economy.farmRebuildCostRatio`（= 0.5）を建設コストに掛けた「木材半額」。
 */
export function farmRebuildCostFx(): Int32Array {
  const ratioBp = cfgBp('economy.farmRebuildCostRatio');
  const base = buildingDef(FARM_BUILDING_TYPE).cost;
  const out = new Int32Array(base.length);
  for (let r = 0; r < base.length; r++) out[r] = idiv(base[r]! * ratioBp, BP);
  return out;
}

/** プレイヤーが再建コストを払えるか。 */
export function canAffordFarmRebuild(w: World, p: PlayerId): boolean {
  const pl = getPlayer(w, p);
  if (pl === undefined) return false;
  const cost = farmRebuildCostFx();
  for (let r = 0; r < cost.length; r++) {
    if (pl.resources[r]! < cost[r]!) return false;
  }
  return true;
}

/**
 * 枯れた農地を建て直す（木材半額）。
 * 成功すると**新しい資源ノード**の EntityId、失敗すると `INVALID_ENTITY`。
 *
 * `farmBuildingId` は生き残っている農地の建物。建物ごと失われている場合は
 * 再建対象がないので失敗する。
 *
 * **M10（建設）への申し送り**: ここでは資源を引いて即座にノードを復活させている。
 * 建設時間を伴う挙動にするなら `construction.ts` の建設キューへ積む形へ差し替えること
 * （この関数の呼び出し側は `economy.ts` の 1 箇所だけ）。
 */
export function rebuildFarm(w: World, farmBuildingId: EntityId): EntityId {
  const e = w.entities;
  const bi = resolveIndex(e, farmBuildingId);
  if (bi < 0 || e.kind[bi] !== EntityKind.Building || e.typeId[bi] !== FARM_BUILDING_TYPE) {
    return INVALID_ENTITY;
  }
  const owner = e.owner[bi]! as PlayerId;
  const pl = getPlayer(w, owner);
  if (pl === undefined) return INVALID_ENTITY;
  const cost = farmRebuildCostFx();
  for (let r = 0; r < cost.length; r++) {
    if (pl.resources[r]! < cost[r]!) return INVALID_ENTITY;
  }
  for (let r = 0; r < cost.length; r++) pl.resources[r] = pl.resources[r]! - cost[r]!;
  // 埋蔵量は「再建した瞬間」の `farmYieldMul` で決まる（`spawnResourceNode` 側で掛かる）。
  // 研究が終わったあとに建て直した畑から効き始めるのが自然なので、これで正しい。
  return spawnResourceNode(w, FARM_NODE_TYPE, e.x[bi]!, e.y[bi]!, {
    owner,
    parent: farmBuildingId,
  });
}

/**
 * 資源ノードが枯れたときの後始末。
 *  - ノードを `markDead`（採り切ると消える。`07§8`）。
 *  - 農地なら、自動再建が有効で資源が足りていれば新しいノードを返す。
 *    再建しない場合は農地の建物も一緒に消す（枯れた農地は残らない）。
 *
 * 戻り値は「再建された新しいノードの EntityId」。再建しなかった場合は `INVALID_ENTITY`。
 */
export function depleteNode(w: World, nodeIdx: number): EntityId {
  const e = w.entities;
  const def = resourceNodeDef(e.typeId[nodeIdx]!);
  const parent = e.homeId[nodeIdx]!;
  markDeadIndex(e, nodeIdx);
  if (!def.rebuildable) return INVALID_ENTITY;
  if (farmAutoRebuildEnabled()) {
    const revived = rebuildFarm(w, parent);
    if (revived !== INVALID_ENTITY) return revived;
  }
  // 再建しない（オプション OFF / 資源不足）なら、枯れた農地は跡地ごと消える。
  const bi = resolveIndex(e, parent);
  if (bi >= 0) markDeadIndex(e, bi);
  return INVALID_ENTITY;
}

// ---------------------------------------------------------------- 村人への指示

/**
 * 村人に資源ノードを割り当てる（`Gathering` に入れる）。
 * 搬入点は最寄りのものを自動で選び `homeId` に入れる。
 * 移動そのものは M3 の `movement` が `destX/destY` を見て行う。
 */
export function assignVillagerToNode(w: World, villagerId: EntityId, nodeId: EntityId): boolean {
  const e = w.entities;
  const vi = resolveIndex(e, villagerId);
  const ni = resolveIndex(e, nodeId);
  if (vi < 0 || ni < 0) return false;
  if (!isVillagerIndex(e, vi) || !isResourceNode(e, ni)) return false;
  e.target[vi] = nodeId;
  setVillagerState(e, vi, UnitState.Gathering, w.tick);
  const drop = findNearestDropOffIndex(w, e.owner[vi]! as PlayerId, e.x[ni]!, e.y[ni]!);
  e.homeId[vi] = drop >= 0 ? idOfIndex(e, drop) : INVALID_ENTITY;
  e.destX[vi] = e.x[ni]!;
  e.destY[vi] = e.y[ni]!;
  return true;
}

/** 状態と `stateTick` を同時に更新する（採集量の epoch になるので必ずここを通す）。 */
export function setVillagerState(e: Entities, i: number, state: number, tick: number): void {
  if (e.state[i] !== state) {
    e.state[i] = state;
    e.stateTick[i] = tick;
  }
}

// ---------------------------------------------------------------- 遊休村人（T-M4-10）

/**
 * 手が空いた村人の EntityId を **index 昇順**で `out` に詰め、件数を返す（T-M4-10）。
 * `06§5` の `.` / `,` ジャンプ用。列挙順は index 昇順で固定なので、
 * 同じ状態からは常に同じ順序で返る（`Map`/`Set` を使わない理由は §0.3）。
 *
 * 「手が空いた」の定義: 生存する自軍の村人で、
 *  - 状態が `Idle`（採集も搬入も建設もしていない）
 *  - 何も運んでいない
 *  - 有効な作業対象（`target`）を持たない
 */
export function collectIdleVillagers(w: World, owner: PlayerId, out: EntityId[]): number {
  const e = w.entities;
  out.length = 0;
  for (let i = 0; i < e.highWater; i++) {
    if (e.owner[i] !== owner || !isVillagerIndex(e, i)) continue;
    if (e.state[i] !== UnitState.Idle) continue;
    if (e.carryKind[i] !== 0) continue;
    if (resolveIndex(e, e.target[i]!) >= 0) continue;
    out.push(idOfIndex(e, i));
  }
  return out.length;
}
