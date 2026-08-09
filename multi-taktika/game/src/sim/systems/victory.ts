/**
 * システム 13/14: victory — 勝敗判定（`03§10`, 実装手順書 §6.9）
 *
 * 責務:
 *  1. 制圧: 相手の町の中心をすべて破壊
 *  2. 碑の写し: 帝国の世で記念碑を建て 6 分（9,000 tick）守り切る。
 *     建設開始時点で全プレイヤーに位置が公開される（唯一、情報を隠せない行動）
 *  3. 服属: 投了（`resign` コマンド）
 *  4. 敗北: 町の中心を全喪失、または忠誠度 0%。
 *     **戦域 0 本は敗北ではない**（`03§10`。判定に使うのは戦域の数ではなく忠誠度）。
 *
 * 決着したら `w.gameOver = true` と `w.winner` を設定する。チーム戦は**チーム単位**で決まる。
 *
 * 担当マイルストーン: **M11**（T-M11-05〜06）。
 *
 * ---- 状態をどこに置いているか（申し送り）----
 *
 * 「記念碑がいつ完成したか」「町の中心を 1 度でも持ったか」は再現に必要な状態だが、
 * `world.ts` を編集できないため `WeakMap<World, VictoryStore>` に置いている
 * （**状態ハッシュの対象外**）。`World` に足したいもの:
 *   - `PlayerState.monumentCompletedTick`（-1 = 無い）
 *   - `PlayerState.everHadTownCenter`（町の中心を 1 度でも持ったか）
 */

import { AGE_IDS, EntityKind, type PlayerId } from '@/shared/types';
import { cfgBool, cfgStr, cfgTicks } from '../core/config';
import { isBuildingComplete } from '../core/effects';
import type { Fx } from '../core/fx';
import { buildingRevealsToAll, isMonumentBuilding, loyaltyThresholdDefeat } from '../core/law';
import { MAX_PLAYERS, areAllies, type World } from '../core/world';
import { countTownCenters } from './loyalty';

/** 記念碑を守り切る時間（tick）。`victory.monumentHoldSec` = 360 秒 = 9,000 tick。 */
function monumentHoldTicks(): number {
  return cfgTicks('victory.monumentHoldSec');
}

/** 記念碑を建てられる時代（`victory.monumentRequiresAge` = 帝国の世）。 */
function monumentRequiredAgeIndex(): number {
  const id = cfgStr('victory.monumentRequiresAge');
  const i = AGE_IDS.indexOf(id as (typeof AGE_IDS)[number]);
  return i < 0 ? AGE_IDS.length - 1 : i;
}

/** 町の中心を全て失うと敗北か（`victory.defeatOnAllTownCentersLost`）。 */
function defeatOnAllTownCentersLost(): boolean {
  return cfgBool('victory.defeatOnAllTownCentersLost');
}

/** 忠誠度 0 で敗北か（`victory.defeatOnLoyaltyZero`）。 */
function defeatOnLoyaltyZero(): boolean {
  return cfgBool('victory.defeatOnLoyaltyZero');
}

/** 制圧の条件（`victory.conquestRequiresAllTownCentersDestroyed`）。 */
function conquestRequiresAllTownCenters(): boolean {
  return cfgBool('victory.conquestRequiresAllTownCentersDestroyed');
}

/** 戦域 0 本は敗北ではない（`victory.zeroFrontsIsNotDefeat`）。判定に戦域を使わないことの明示。 */
function zeroFrontsIsNotDefeat(): boolean {
  return cfgBool('victory.zeroFrontsIsNotDefeat');
}

/** 記念碑の位置が全プレイヤーに公開されるか（`victory.monumentRevealsPositionToAll`）。 */
function monumentRevealsToAll(): boolean {
  return cfgBool('victory.monumentRevealsPositionToAll');
}

/** M11 が必要とする状態（**ハッシュ対象外**。上のコメント参照）。 */
interface VictoryStore {
  /** 記念碑が完成した tick（-1 = 完成した記念碑を持っていない）。 */
  readonly monumentCompletedTick: Int32Array;
  /** 町の中心を 1 度でも持ったか（持ったことが無いプレイヤーを敗北にしないため）。 */
  readonly everHadTownCenter: Uint8Array;
}

const stores = new WeakMap<World, VictoryStore>();

function getStore(w: World): VictoryStore {
  let s = stores.get(w);
  if (s === undefined) {
    s = {
      monumentCompletedTick: new Int32Array(MAX_PLAYERS).fill(-1),
      everHadTownCenter: new Uint8Array(MAX_PLAYERS),
    };
    stores.set(w, s);
  }
  return s;
}

/** テスト用。World に紐づいた勝敗の作業状態を捨てる。 */
export function resetVictoryState(w: World): void {
  stores.delete(w);
}

// ---------------------------------------------------------------------------
// 公開クエリ（UI / AI / 描画層が使う）
// ---------------------------------------------------------------------------

/** 公開されている記念碑（`07§7`「記念碑だけは例外」）。 */
export interface RevealedMonument {
  readonly owner: PlayerId;
  readonly x: Fx;
  readonly y: Fx;
  /** 完成しているか（建設中でも位置は公開される）。 */
  readonly complete: boolean;
  /** 守り切るまでの残り tick（未完成なら守る時間の全長）。 */
  readonly remainingTicks: number;
}

/**
 * 全プレイヤーに位置が公開されている記念碑の一覧（`revealToAll` の建物）。
 *
 * **建設開始時点**（`buildProgress` が完成に達していなくても）で公開されるのが `03§10` の要点。
 * 反復は index 昇順。
 */
export function revealedMonuments(w: World): RevealedMonument[] {
  const out: RevealedMonument[] = [];
  if (!monumentRevealsToAll()) return out;
  const s = getStore(w);
  const e = w.entities;
  const hold = monumentHoldTicks();
  for (let i = 0; i < e.highWater; i++) {
    if (e.alive[i] !== 1) continue;
    if (e.kind[i] !== EntityKind.Building) continue;
    const typeId = e.typeId[i]!;
    if (!buildingRevealsToAll(typeId) && !isMonumentBuilding(typeId)) continue;
    const owner = e.owner[i]!;
    if (owner >= w.playerCount) continue;
    const complete = isBuildingComplete(w, i);
    const since = s.monumentCompletedTick[owner]!;
    const elapsed = w.tick - since;
    const remaining = complete && since >= 0 ? (hold > elapsed ? hold - elapsed : 0) : hold;
    out.push({
      owner: owner as PlayerId,
      x: e.x[i]!,
      y: e.y[i]!,
      complete,
      remainingTicks: remaining,
    });
  }
  return out;
}

/** そのプレイヤーの記念碑が勝利まで残り何 tick か（完成した記念碑が無ければ -1）。 */
export function monumentRemainingTicks(w: World, p: PlayerId): number {
  const s = stores.get(w);
  if (s === undefined) return -1;
  const t = s.monumentCompletedTick[p]!;
  if (t < 0) return -1;
  const r = monumentHoldTicks() - (w.tick - t);
  return r > 0 ? r : 0;
}

// ---------------------------------------------------------------------------
// システム本体
// ---------------------------------------------------------------------------

export function victory(w: World): void {
  if (w.gameOver) return;
  const s = getStore(w);

  updateDefeats(w, s); //             4. 敗北（町の中心全喪失 / 忠誠度 0 / 投了）
  if (checkMonument(w, s)) return; // 2. 碑の写し
  checkLastTeamStanding(w); //        1. 制圧 / 3. 服属（結果として最後に残ったチームの勝ち）
}

/**
 * 敗北の判定（`03§10`）。
 *
 *  - 町の中心を**すべて失った**（1 度でも持っていたプレイヤーだけが対象）
 *  - 忠誠度が 0%（= すべての旗が離反した状態）
 *  - 投了（`resigned`。服属）
 *
 * **戦域の数は一切見ない。** 序盤の戦域 0 本で敗北しないのはこのため
 * （`victory.zeroFrontsIsNotDefeat`）。
 */
function updateDefeats(w: World, s: VictoryStore): void {
  // 戦域の数を判定に使わないことを設定から確認する（`03§10`）。
  if (!zeroFrontsIsNotDefeat()) {
    throw new Error('victory: victory.zeroFrontsIsNotDefeat = false は 03§10 に反する');
  }
  const counts = countTownCenters(w);
  const zero = loyaltyThresholdDefeat();

  for (let p = 0; p < w.playerCount; p++) {
    const pl = w.players[p]!;
    if (counts[p]! > 0) s.everHadTownCenter[p] = 1;
    if (pl.defeated) continue;

    if (pl.resigned) {
      pl.defeated = true;
      continue;
    }
    if (
      defeatOnAllTownCentersLost() &&
      conquestRequiresAllTownCenters() &&
      s.everHadTownCenter[p] === 1 &&
      counts[p]! === 0
    ) {
      pl.defeated = true;
      continue;
    }
    if (defeatOnLoyaltyZero() && pl.loyalty <= zero) {
      pl.defeated = true;
    }
  }
}

/**
 * 碑の写し（`03§10`）。
 *
 * 帝国の世で建てた記念碑が完成した tick を覚えておき、
 * `victory.monumentHoldSec`（6 分 = 9,000 tick）守り切ったら勝利。
 * 壊されたら（完成した記念碑が無くなったら）時計は捨てられる。
 *
 * @returns 決着したら true
 */
function checkMonument(w: World, s: VictoryStore): boolean {
  const e = w.entities;
  const requiredAge = monumentRequiredAgeIndex();
  const hold = monumentHoldTicks();

  // 完成している記念碑を持っているか（index 昇順の最初の 1 つ）。
  const found = new Int32Array(MAX_PLAYERS).fill(-1);
  for (let i = 0; i < e.highWater; i++) {
    if (e.alive[i] !== 1) continue;
    if (e.kind[i] !== EntityKind.Building) continue;
    if (!isMonumentBuilding(e.typeId[i]!)) continue;
    const owner = e.owner[i]!;
    if (owner >= w.playerCount) continue;
    if (!isBuildingComplete(w, i)) continue;
    if (found[owner]! < 0) found[owner] = i;
  }

  for (let p = 0; p < w.playerCount; p++) {
    const pl = w.players[p]!;
    if (found[p]! < 0) {
      // 完成した記念碑が無い（まだ建設中 / 壊された）→ 時計を捨てる。
      s.monumentCompletedTick[p] = -1;
      continue;
    }
    if (pl.age < requiredAge) continue;
    if (pl.defeated || pl.resigned) continue;
    if (s.monumentCompletedTick[p]! < 0) s.monumentCompletedTick[p] = w.tick;
    if (w.tick - s.monumentCompletedTick[p]! >= hold) {
      declareWinner(w, p as PlayerId);
      return true;
    }
  }
  return false;
}

/**
 * 生き残っているチームが 1 つになったら決着（制圧・服属の結果）。
 *
 * チーム戦は**チーム単位**で決まるので、勝者は残ったチームのうち
 * **playerId が最小の生存者**にする（乱数を使わない）。
 * 全員が倒れた場合は引き分け（`winner = -1`）。
 */
function checkLastTeamStanding(w: World): void {
  let aliveCount = 0;
  let first = -1;
  for (let p = 0; p < w.playerCount; p++) {
    if (w.players[p]!.defeated) continue;
    aliveCount += 1;
    if (first < 0) first = p;
  }

  if (aliveCount === 0) {
    w.gameOver = true;
    w.winner = -1;
    return;
  }
  if (w.playerCount <= 1) return; // 単独プレイ（テスト・練習）は決着させない。

  // 生存者が全員味方（= 1 チームだけ残った）なら決着。
  for (let p = first + 1; p < w.playerCount; p++) {
    if (w.players[p]!.defeated) continue;
    if (!areAllies(w, first as PlayerId, p as PlayerId)) return;
  }
  declareWinner(w, first as PlayerId);
}

/** 決着させる。勝者はチームの代表（playerId 最小の生存者）。 */
function declareWinner(w: World, p: PlayerId): void {
  w.gameOver = true;
  w.winner = p;
  // 勝ったチーム以外は敗北扱いにする（結果画面が「誰が残ったか」で揃うようにする）。
  for (let q = 0; q < w.playerCount; q++) {
    if (areAllies(w, p, q as PlayerId)) continue;
    w.players[q]!.defeated = true;
  }
}
