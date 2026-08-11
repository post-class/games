/**
 * sim/core/population.ts — 人口の集計と上限判定（`03§1` / `07§8`。M4 / T-M4-08）
 *
 * 規則:
 *  - 家 1 軒で +5、町の中心で +10（値は `buildings.json` の `popProvide`）。
 *  - 上限は既定 200（`config.json:population.defaultCap`。対戦設定で変更可）。
 *    建物を建てて増える値は **200 で打ち止め**。
 *  - 村人・兵・攻城兵器・船はすべて人口を食う。攻城兵器 3、戦象 2（`units.json` の `pop`）。
 *  - **上限に達すると生産が止まる**（`07§8`「生産ボタンが止まります」）。
 *    生産キュー本体は M6 の `production.ts` なので、ここは**判定関数だけ**を提供する。
 *
 * 決定論について: 集計は index 昇順の単純走査。`Map`/`Set` を使わない（§0.3）。
 */

import type { PlayerId } from '@/shared/types';
import { EntityKind } from '@/shared/types';

import type { Entities } from './entity';
import { PROGRESS_DONE, isAliveIndex } from './entity';
import { buildingDef, unitDef } from './defs';
import type { PlayerState, World } from './world';
import { getPlayer } from './world';
import { populationCapOption } from './law';

/** 人口上限の上限値（`population.defaultCap` = 200）。 */
export function populationHardCap(): number {
  return populationCapOption();
}

/**
 * その建物が人口上限に加算されるか。
 *
 * 建設中の建物は数えない（`buildProgress` が `PROGRESS_DONE` に達していないもの）。
 * これを見ないと「家を置いた瞬間に人口上限が増える」ことになり、建設時間が意味を失う。
 */
export function providesPopCap(e: Entities, i: number): boolean {
  if (!isAliveIndex(e, i) || e.kind[i] !== EntityKind.Building) return false;
  if (e.buildProgress[i]! < PROGRESS_DONE) return false;
  return buildingDef(e.typeId[i]!).popProvide > 0;
}

/** ユニット 1 体が占める人口（攻城兵器 3・戦象 2・その他 1）。 */
export function unitPopCost(typeId: number): number {
  return unitDef(typeId).pop;
}

/** そのプレイヤーの現在人口を数え直す。 */
export function computePop(w: World, p: PlayerId): number {
  const e = w.entities;
  let pop = 0;
  for (let i = 0; i < e.highWater; i++) {
    if (!isAliveIndex(e, i) || e.kind[i] !== EntityKind.Unit) continue;
    if (e.owner[i] !== p) continue;
    pop += unitPopCost(e.typeId[i]!);
  }
  return pop;
}

/**
 * そのプレイヤーの人口上限を数え直す（家 +5 / 町の中心 +10、既定 200 で打ち止め）。
 * 建物が 1 つも無ければ 0（= 何も生産できない）。
 */
export function computePopCap(w: World, p: PlayerId): number {
  const e = w.entities;
  let cap = 0;
  for (let i = 0; i < e.highWater; i++) {
    if (e.owner[i] !== p || !providesPopCap(e, i)) continue;
    cap += buildingDef(e.typeId[i]!).popProvide;
  }
  const hard = populationHardCap();
  return cap > hard ? hard : cap;
}

/**
 * 全プレイヤーの `pop` / `popCap` を再計算する（`economy` システムが毎 tick 呼ぶ）。
 * playerId 昇順に処理する。
 */
export function refreshPopulation(w: World): void {
  // 毎 tick 呼ばれるので、プレイヤーごとに全走査せず **1 パス**で集計する
  // （プレイヤー数 × エンティティ数の走査は 8 人対戦で無駄が大きい）。
  const e = w.entities;
  const pop = new Int32Array(w.playerCount);
  const cap = new Int32Array(w.playerCount);
  for (let i = 0; i < e.highWater; i++) {
    if (e.alive[i] !== 1) continue;
    const owner = e.owner[i]!;
    if (owner >= w.playerCount) continue;
    if (e.kind[i] === EntityKind.Unit) {
      pop[owner] = pop[owner]! + unitPopCost(e.typeId[i]!);
    } else if (e.kind[i] === EntityKind.Building) {
      const provide = buildingDef(e.typeId[i]!).popProvide;
      if (provide > 0 && providesPopCap(e, i)) cap[owner] = cap[owner]! + provide;
    }
  }
  const hard = populationHardCap();
  for (let p = 0; p < w.playerCount; p++) {
    const pl = w.players[p]!;
    pl.pop = pop[p]!;
    pl.popCap = cap[p]! > hard ? hard : cap[p]!;
  }
}

/** 残り人口枠（負にはならない）。 */
export function popRoom(pl: PlayerState): number {
  const room = pl.popCap - pl.pop;
  return room > 0 ? room : 0;
}

/**
 * そのユニットを 1 体増やせるか（**上限で生産が止まる**の判定。T-M4-08）。
 * M6 の生産キューは、進捗を進める前にこれを呼んで false なら止める。
 */
export function hasPopRoomFor(w: World, p: PlayerId, unitTypeId: number): boolean {
  const pl = getPlayer(w, p);
  if (pl === undefined) return false;
  return popRoom(pl) >= unitPopCost(unitTypeId);
}

/**
 * 人口上限に達しているか（`05§2` の HUD が赤くする条件）。
 * 攻城兵器のように 1 体で 3 枠使うものは「枠が余っていても作れない」ことがあるので、
 * 生産可否の判定には `hasPopRoomFor` を使うこと。
 */
export function isPopCapped(pl: PlayerState): boolean {
  return pl.pop >= pl.popCap;
}
