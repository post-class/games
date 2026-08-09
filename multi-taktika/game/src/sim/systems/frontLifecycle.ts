/**
 * システム 3/14: frontLifecycle — 戦域の発生・成長・統合・分裂・消滅（`07§3`, 実装手順書 §6.1）
 *
 * 責務:
 *  - **発生**: 敵味方の戦闘ユニットが半径 15 マス内にそれぞれ 3 体以上いて、
 *    交戦（実ダメージの発生）が 50 tick 継続したら戦域化。中心はその集合の重心。
 *  - **成長**: `radius = clamp(15 + floor(所属数 / 4), 15, 30)` マス。
 *  - **統合**: 中心間距離 ≤ 20 マス → slot 番号の小さい方が吸収し、
 *    **吸収した側（小さい方）の令が全体に適用**される。空いた slot は解放。
 *  - **分裂**: 中心から 35 マス以上離れた集団は、空き slot があれば独立（令を引き継ぐ）。
 *    空きが無ければ `frontId = 0`。
 *  - **消滅**: `tick - lastEngageTick >= 375`（15 秒）。所属ユニットは `lastOrder` を保持して待機。
 *  - **優勢度**: advantage = 0.5*clamp((dealt-taken)/max(1,dealt+taken),-1,1)
 *                        + 0.5*clamp(自軍残存兵力比 - 敵残存兵力比,-1,1)
 *
 * 担当マイルストーン: **M8**（T-M8-01〜）。
 *
 * ---------------------------------------------------------------------------
 * 1 tick の処理順（この順序が結果を決めるので変えない）
 * ---------------------------------------------------------------------------
 *   1. 消滅（無交戦 15 秒）      … 先に閉じてスロットを空ける
 *   2. 統合（中心 20 マス以内）  … さらにスロットが空く
 *   3. 分裂（35 マス以上の離脱）  … 空いたスロットを使える
 *   4. 発生（新しい戦域）        … 残った空きスロットを使う
 *   5. 成長（半径）と優勢度
 * 中心（重心）・`memberCount`・`hpBaseOwn` の更新は次のシステム（`frontEnrollment`）が行うので、
 * ここが見ている所属情報は **前 tick の編入結果**である。1 tick の遅れは意図的
 * （同一 tick 内で「編入 → 分裂 → 編入」が振動するのを防ぐ）。
 *
 * ---------------------------------------------------------------------------
 * 決定論のための全順序（§16-2）
 * ---------------------------------------------------------------------------
 *  - 所属ユニットの列挙は **entity index 昇順**（計数ソートで作るので入力順に依存しない）。
 *  - 統合・分裂の対象戦域は **中心 (y, x) 昇順 → slot 昇順** に並べてから処理する。
 *  - 発生候補は **グリッドのセルを row-major（= y 昇順 → x 昇順）** で走査して作る。
 *    セル内では **playerId 昇順**。重心は「条件を満たしたユニット集合」の平均（index 昇順の総和）。
 *  - 乱数は 1 度も使わない。`Map` / `Set` も使わない。
 *
 * ---------------------------------------------------------------------------
 * 「交戦が 2 秒継続」の判定（近似。ここだけ仕様と厳密に一致しない）
 * ---------------------------------------------------------------------------
 * 実ダメージの発生は `combat.dealDamage` が知っているが、そこが更新する
 * `Front.lastEngageTick` は **戦域が立ってからしか動かない**（戦域の外の戦闘は記録されない）。
 * World に「候補ごとの交戦継続 tick 数」を持つ列は無く、`world.ts` は編集不可なので、
 * **未使用（`active = false`）の戦域スロットが候補の置き場を兼ねる**:
 *   `candidateTicks`      … 近接条件が連続して成立している tick 数（0 = 孵化していない）
 *   `candidateDamageSeen` … 孵化中に実ダメージを 1 度でも観測したか
 *   `candidateHpOwn`      … 前 tick の自軍側 HP 合計
 *   `candidateHpEnemy`    … 前 tick の敵側 HP 合計
 *
 * 候補もスロットを 1 つ押さえる。「スロットが無ければ戦域にならない」（`07§3`）という
 * 規則とそのまま一致するので、専用の候補リストを別に持たない。
 *
 * **実ダメージの検出**: `combat.dealDamage` が更新する `lastEngageTick` は
 * 戦域が立ってからしか動かないので使えない。代わりに
 * 「候補集合の HP 合計が前 tick より減ったか」で見ている。近似なので:
 *   - 円から兵が出て行っただけでも HP 合計は減る（偽陽性）
 *   - 祈祷師の回復で 1 tick の被弾を見落とす（偽陰性）
 * ただし「50 tick 連続の近接」と「その間に 1 度以上の HP 減少」の**両方**を要求するため、
 * 通過するだけの部隊では戦域は立たない。
 *     孵化中の状態はデシンク検出に載らない（World の状態なので**再現性そのものは保たれる**）。
 * 正確にやるには `world.ts` に候補用の列が必要。**申し送り**に書いた。
 *
 * 仕様の注意（§16-8）: スロット上限を超えた戦闘は「起きる」。
 * 戦域にならないだけで、戦闘そのものを抑止してはいけない。
 */

import type { PlayerId } from '@/shared/types';
import { EntityKind, NEUTRAL_OWNER } from '@/shared/types';
import type { Fx } from '../core/fx';
import { distSq, idiv } from '../core/fx';
import {
  ADVANTAGE_WINDOW_TICKS,
  MAX_FRONTS,
  MAX_PLAYERS,
  acquireFrontSlot,
  areAllies,
  frontIndex,
  getFront,
  getPlayer,
  releaseFront,
  type Front,
  type World,
} from '../core/world';
import {
  collectCircleUnordered,
  computeAdvantage,
  frontBaseRadius,
  frontCloseIdleTicks,
  frontMergeDistSq,
  frontRadiusForMembers,
  frontSpawnEngageTicks,
  frontSpawnMinUnits,
  frontSpawnRadius,
  frontSplitDistSq,
  isCombatUnit,
  orderSwitchIntervalTicks,
  stampLastOrder,
  sumRing,
} from '../core/front';

/** `fronts` の長さ（プレイヤーごとに MAX_FRONTS 枠）。 */
const SLOT_COUNT = MAX_PLAYERS * MAX_FRONTS;

// ---------------------------------------------------------------------------
// 作業領域（tick 内でしか意味を持たない。**状態ではない**のでハッシュ対象外）
//
// `World.scratch` に置けない（`world.ts` は編集不可）ため、モジュールに持つ。
// 毎回必ず先頭から作り直すので、tick 間・World 間で値が持ち越されることはない。
// ---------------------------------------------------------------------------

/** 所属ユニットの計数ソート結果の開始位置（長さ SLOT_COUNT + 1）。 */
const groupStart = new Int32Array(SLOT_COUNT + 1);
/** 計数ソートの詰め込みカーソル。 */
const groupCursor = new Int32Array(SLOT_COUNT);
/** 戦域ごとに固めた所属ユニットの entity index（各区間内は index 昇順）。 */
let groupItems = new Int32Array(0);

/** 統合・分裂の処理順を作るための slot 一覧。 */
const sortedSlots: number[] = [];

/**
 * セルごとの「戦闘ユニットがいるプレイヤー」のビットマスク（発生判定の粗い篩）。
 *
 * 数ではなく**在・不在だけ**を持つ理由は速度。1600 体が交戦せずに散っている状況で
 * セル × プレイヤーの員数を毎 tick 数えると、それだけで 1 tick の予算（4ms）を食う
 * （実測 2.1ms/tick → マスクにして 0.1ms 以下）。
 * 「双方の兵が近くにいる」セルだけ `queryCircle` で厳密に数える。
 */
let cellMask = new Uint8Array(0);

/** 今 tick に候補として採用した重心（同じ塊から候補を二重に作らないための除外リスト）。 */
const candOwner: number[] = [];
const candX: number[] = [];
const candY: number[] = [];

/** 今 tick に候補と結びついた（= 継続している）スロット。 */
const matchedSlot = new Uint8Array(SLOT_COUNT);

export function frontLifecycle(w: World): void {
  groupMembers(w);
  closeIdleFronts(w); //   1. 消滅
  mergeFronts(w); //       2. 統合
  splitFronts(w); //       3. 分裂
  spawnFronts(w); //       4. 発生
  updateGrowthAndAdvantage(w); // 5. 成長・優勢度
}

// ---------------------------------------------------------------- 所属ユニットの索引

/**
 * 所属ユニットを戦域ごとに固める（計数ソート、O(生存数 + スロット数)）。
 *
 * 反復を index 昇順で 2 回行うだけなので、**結果は入力順に依存しない**。
 * 併せて「消えた戦域を指したままのユニット」を戦域外へ戻す（防御的整合）。
 */
function groupMembers(w: World): void {
  const e = w.entities;
  groupStart.fill(0);

  let total = 0;
  for (let i = 0; i < e.highWater; i++) {
    if (e.alive[i] !== 1) continue;
    if (e.kind[i] !== EntityKind.Unit) continue;
    const slot = e.frontId[i]!;
    if (slot === 0) continue;
    const owner = e.owner[i]! as PlayerId;
    const f = getFront(w, owner, slot);
    if (f === undefined || !f.active) {
      // 解放済みスロットを指している。令だけ残して戦域外にする。
      e.frontId[i] = 0;
      continue;
    }
    groupStart[frontIndex(owner, slot) + 1] = groupStart[frontIndex(owner, slot) + 1]! + 1;
    total += 1;
  }

  for (let k = 0; k < SLOT_COUNT; k++) {
    groupStart[k + 1] = groupStart[k + 1]! + groupStart[k]!;
    groupCursor[k] = groupStart[k]!;
  }
  if (groupItems.length < total) groupItems = new Int32Array(total + 64);

  for (let i = 0; i < e.highWater; i++) {
    if (e.alive[i] !== 1) continue;
    if (e.kind[i] !== EntityKind.Unit) continue;
    const slot = e.frontId[i]!;
    if (slot === 0) continue;
    const fi = frontIndex(e.owner[i]! as PlayerId, slot);
    groupItems[groupCursor[fi]!] = i;
    groupCursor[fi] = groupCursor[fi]! + 1;
  }
}

/** 戦域の所属ユニットの区間の開始位置（`groupItems` の添字）。 */
function memberBegin(fi: number): number {
  return groupStart[fi]!;
}

/** 戦域の所属ユニットの区間の終端（`groupItems` の添字、終端は含まない）。 */
function memberEnd(fi: number): number {
  return groupStart[fi + 1]!;
}

// ---------------------------------------------------------------- 1. 消滅（T-M8-06）

/**
 * 無交戦が `front.closeIdleSec`（15 秒 = 375 tick）続いた戦域を閉じる。
 *
 * 所属ユニットは `frontId = 0` になるが、**最後の令を `lastOrder` に焼き付けて待機**する
 * （`07§3`「閉じた瞬間、部隊は最後の令を保持したまま待機します」）。
 * 実際の挙動は `unitDecision`（M9）が `lastOrder` を読んで再現する。
 */
function closeIdleFronts(w: World): void {
  const idle = frontCloseIdleTicks();
  const e = w.entities;
  for (let fi = 0; fi < SLOT_COUNT; fi++) {
    const f = w.fronts[fi]!;
    if (!f.active) continue;
    if (w.tick - f.lastEngageTick < idle) continue;
    const end = memberEnd(fi);
    for (let k = memberBegin(fi); k < end; k++) {
      const i = groupItems[k]!;
      stampLastOrder(e, i, f);
      e.frontId[i] = 0;
    }
    releaseFront(w, f.owner, f.slot);
  }
}

// ---------------------------------------------------------------- 2. 統合（T-M8-04）

/**
 * 中心間距離が `front.mergeDistTiles`（20 マス）以内の**同じプレイヤーの**戦域を統合する。
 *
 * `slot` 番号の小さい方が大きい方を吸収し、**吸収した側（小さい方）の令が全体に適用**される
 * （`07§3`）。吸収された slot は解放され、HUD の輪が 1 つ消灯する。
 *
 * 処理順は「中心 (y, x) 昇順 → slot 昇順」の全順序。
 * 3 つ以上が数珠つなぎに近い場合も、この順で 1 組ずつ潰すので結果が一意に決まる。
 */
function mergeFronts(w: World): void {
  const limitSq = frontMergeDistSq();

  for (let p = 0; p < w.playerCount; p++) {
    collectActiveSlots(w, p as PlayerId);
    const n = sortedSlots.length;
    if (n < 2) continue;
    for (let a = 0; a < n; a++) {
      const fa = w.fronts[sortedSlots[a]!]!;
      if (!fa.active) continue;
      for (let b = a + 1; b < n; b++) {
        const fb = w.fronts[sortedSlots[b]!]!;
        if (!fb.active) continue;
        if (distSq(fa.x, fa.y, fb.x, fb.y) > limitSq) continue;
        // slot の小さい方が吸収する側。
        const lo = fa.slot < fb.slot ? fa : fb;
        const hi = fa.slot < fb.slot ? fb : fa;
        absorbFront(w, lo, hi);
        // 所属が動いたので索引を作り直す（次の組を正しい所属で判定するため）。
        groupMembers(w);
        if (!fa.active) break; // fa が吸収された側なら、この a はもう対象外
      }
    }
  }
}

/** そのプレイヤーの active な戦域を「中心 (y, x) 昇順 → slot 昇順」で `sortedSlots` に集める。 */
function collectActiveSlots(w: World, p: PlayerId): void {
  sortedSlots.length = 0;
  for (let s = 1; s <= MAX_FRONTS; s++) {
    const fi = frontIndex(p, s);
    if (w.fronts[fi]!.active) sortedSlots.push(fi);
  }
  sortedSlots.sort((ia, ib) => compareFrontOrder(w.fronts[ia]!, w.fronts[ib]!));
}

/** 全順序: 中心 y 昇順 → x 昇順 → slot 昇順（§16-2）。 */
function compareFrontOrder(a: Front, b: Front): number {
  if (a.y !== b.y) return a.y - b.y;
  if (a.x !== b.x) return a.x - b.x;
  return a.slot - b.slot;
}

/** `hi` の中身を `lo` に吸収して `hi` を解放する。令は `lo`（小さい slot）のものが残る。 */
function absorbFront(w: World, lo: Front, hi: Front): void {
  const e = w.entities;
  const loIdx = frontIndex(lo.owner, lo.slot);
  const hiIdx = frontIndex(hi.owner, hi.slot);

  // 所属ユニットの付け替え（index 昇順）。令は lo のものになるので lastOrder も lo で焼き直す。
  const end = memberEnd(hiIdx);
  for (let k = memberBegin(hiIdx); k < end; k++) {
    const i = groupItems[k]!;
    e.frontId[i] = lo.slot;
    stampLastOrder(e, i, lo);
  }

  // 中心は所属数で重み付けした平均（次の tick に frontEnrollment が正確な重心へ直す）。
  const nLo = countMembers(loIdx);
  const nHi = countMembers(hiIdx);
  const total = nLo + nHi;
  if (total > 0) {
    lo.x = idiv(lo.x * nLo + hi.x * nHi, total);
    lo.y = idiv(lo.y * nLo + hi.y * nHi, total);
  }
  lo.memberCount = total;
  lo.hpBaseOwn += hi.hpBaseOwn;
  lo.hpBaseEnemy += hi.hpBaseEnemy;
  if (hi.lastEngageTick > lo.lastEngageTick) lo.lastEngageTick = hi.lastEngageTick;
  // 与被ダメージの履歴も足し込む（統合直後に優勢度が跳ねないように）。
  for (let t = 0; t < ADVANTAGE_WINDOW_TICKS; t++) {
    lo.dmgDealt[t] = lo.dmgDealt[t]! + hi.dmgDealt[t]!;
    lo.dmgTaken[t] = lo.dmgTaken[t]! + hi.dmgTaken[t]!;
  }
  lo.radius = frontRadiusForMembers(total);

  releaseFront(w, hi.owner, hi.slot);
}

/** 索引上の所属ユニット数。 */
function countMembers(fi: number): number {
  return memberEnd(fi) - memberBegin(fi);
}

// ---------------------------------------------------------------- 3. 分裂（T-M8-05）

/**
 * 中心から `front.splitDistTiles`（35 マス）以上離れた所属ユニットを分離する。
 *
 *  - 空き slot があれば **新しい戦域として独立**（令を引き継ぐ）。
 *  - 空きが無ければその集団は `frontId = 0`（戦域外）。最後の令は保持する（T-M8-05 の完了条件）。
 *
 * 近似: 「離れた集団」をクラスタリングせず、**遠いユニット全部を 1 集団**として扱う
 * （新戦域の中心はその重心）。2 方向に同時に離れた場合は次の tick 以降の分裂で分かれる。
 */
function splitFronts(w: World): void {
  const limitSq = frontSplitDistSq();
  const e = w.entities;
  let changed = false;

  for (let p = 0; p < w.playerCount; p++) {
    collectActiveSlots(w, p as PlayerId);
    for (let k = 0; k < sortedSlots.length; k++) {
      const fi = sortedSlots[k]!;
      const f = w.fronts[fi]!;
      if (!f.active) continue;

      // 遠いユニットを数え、重心と HP 合計を出す（index 昇順の総和 → 順序非依存）。
      let farCount = 0;
      let sx = 0;
      let sy = 0;
      let hpSum = 0;
      const end = memberEnd(fi);
      for (let m = memberBegin(fi); m < end; m++) {
        const i = groupItems[m]!;
        if (distSq(f.x, f.y, e.x[i]!, e.y[i]!) < limitSq) continue;
        farCount += 1;
        sx += e.x[i]!;
        sy += e.y[i]!;
        hpSum += e.hp[i]!;
      }
      if (farCount === 0) continue;

      const slot = acquireFrontSlot(w, f.owner);
      if (slot < 0) {
        // スロット不足: 遠い側は戦域外へ（令は保持）。
        for (let m = memberBegin(fi); m < end; m++) {
          const i = groupItems[m]!;
          if (distSq(f.x, f.y, e.x[i]!, e.y[i]!) < limitSq) continue;
          stampLastOrder(e, i, f);
          e.frontId[i] = 0;
        }
        f.memberCount = countMembers(fi) - farCount;
        changed = true;
        continue;
      }

      // 新戦域として独立。令（上段・下段）を引き継ぐ。
      const nf = getFront(w, f.owner, slot)!;
      nf.active = true;
      nf.x = idiv(sx, farCount);
      nf.y = idiv(sy, farCount);
      nf.radius = frontRadiusForMembers(farCount);
      nf.order = f.order;
      nf.orderLower = f.orderLower;
      nf.pendingOrder = null; // 配達中の令は元の戦域に届く（先取りさせない。§16-4）
      nf.lastSwitchTick = f.lastSwitchTick;
      nf.lastEngageTick = f.lastEngageTick;
      nf.advantage = f.advantage;
      nf.dmgDealt.fill(0);
      nf.dmgTaken.fill(0);
      nf.ringPos = w.tick % ADVANTAGE_WINDOW_TICKS;
      nf.hpBaseOwn = hpSum;
      nf.hpBaseEnemy = 0; // 敵側は frontEnrollment / 優勢度計算が観測して埋める
      nf.defected = f.defected;
      nf.memberCount = farCount;

      for (let m = memberBegin(fi); m < end; m++) {
        const i = groupItems[m]!;
        if (distSq(f.x, f.y, e.x[i]!, e.y[i]!) < limitSq) continue;
        e.frontId[i] = slot;
        stampLastOrder(e, i, nf);
      }
      f.memberCount = countMembers(fi) - farCount;
      changed = true;
    }
  }

  if (changed) groupMembers(w);
}

// ---------------------------------------------------------------- 4. 発生（T-M8-02, T-M8-09）

/**
 * 新しい戦域の発生。
 *
 * 手順:
 *  1. セル × プレイヤーの戦闘ユニット数を作る（1 パス）。
 *  2. グリッドのセルを row-major（y 昇順 → x 昇順）に走査し、
 *     5×5 セル近傍の粗い篩（双方 3 体以上）を通ったセルだけ厳密判定する。
 *     半径 15 マスは 2 セル（1 セル = 8 マス）なので 5×5 は円を必ず覆う = 見落としが無い。
 *  3. 厳密判定（`queryCircle`）で双方 3 体以上なら候補。中心はその集合の重心。
 *  4. 候補を孵化器（未使用スロット）に結びつけ、50 tick 継続 + 実ダメージ観測で戦域化。
 *
 * 空きスロットが無い場合は**何も起きない**（戦闘は続く。§16-8 / T-M8-09）。
 */
function spawnFronts(w: World): void {
  const minUnits = frontSpawnMinUnits();
  const radius = frontSpawnRadius();

  matchedSlot.fill(0);
  candOwner.length = 0;
  candX.length = 0;
  candY.length = 0;

  // 空きスロットが 1 つも無ければ発生の余地が無い（走査そのものを省く）。
  if (!anyFreeSlot(w)) return;

  const globalMask = buildCellMask(w);
  // 敵対する 2 陣営が同時に盤上にいなければ、発生候補は原理的に存在しない。
  // （交戦しない配置での空走査を丸ごと省く。手順書 T-M2-06 の速度予算）
  let hostilePresent = false;
  for (let p = 0; p < w.playerCount; p++) {
    if ((globalMask & (1 << p)) === 0) continue;
    if ((globalMask & enemyMask(w, p as PlayerId)) !== 0) {
      hostilePresent = true;
      break;
    }
  }
  if (!hostilePresent) return;

  const g = w.grid;
  const cellsPerRadius = Math.ceil(radius / g.cellSize);
  const half = idiv(g.cellSize, 2);

  for (let row = 0; row < g.rows; row++) {
    for (let col = 0; col < g.cols; col++) {
      const cell = row * g.cols + col;
      const own = cellMask[cell]!;
      if (own === 0) continue; // 戦闘ユニットがいないセル

      const near = neighborhoodMask(w, row, col, cellsPerRadius);
      const cx = col * g.cellSize + half;
      const cy = row * g.cellSize + half;
      for (let p = 0; p < w.playerCount; p++) {
        if ((own & (1 << p)) === 0) continue; // このセルに p の兵がいない
        if ((near & enemyMask(w, p as PlayerId)) === 0) continue; // 近くに敵がいない
        considerCandidate(w, p as PlayerId, cx, cy, radius, minUnits);
      }
    }
  }

  // 今 tick に候補と結びつかなかった孵化器は「交戦の継続が切れた」ので捨てる。
  for (let fi = 0; fi < SLOT_COUNT; fi++) {
    const f = w.fronts[fi]!;
    if (f.active) continue;
    if (f.candidateTicks === 0) continue;
    if (matchedSlot[fi] === 1) continue;
    clearIncubator(f);
  }
}

/** どこかに 1 つでも使える空きスロットがあるか。 */
function anyFreeSlot(w: World): boolean {
  for (let p = 0; p < w.playerCount; p++) {
    const pl = w.players[p]!;
    const usable = pl.frontSlots < MAX_FRONTS ? pl.frontSlots : MAX_FRONTS;
    for (let s = 1; s <= usable; s++) {
      if (!w.fronts[frontIndex(p as PlayerId, s)]!.active) return true;
    }
  }
  return false;
}

/**
 * セルごとの「戦闘ユニットがいるプレイヤー」のビットマスクを作り直す。
 * 戻り値は全セルの論理和（= 盤上に戦闘ユニットがいるプレイヤーの集合）。
 */
function buildCellMask(w: World): number {
  const g = w.grid;
  if (cellMask.length !== g.cellCount) cellMask = new Uint8Array(g.cellCount);
  else cellMask.fill(0);

  const e = w.entities;
  let all = 0;
  for (let cell = 0; cell < g.cellCount; cell++) {
    const end = g.cellStart[cell + 1]!;
    let mask = 0;
    for (let k = g.cellStart[cell]!; k < end; k++) {
      const i = g.items[k]!;
      if (e.alive[i] !== 1) continue;
      const owner = e.owner[i]!;
      if (owner === NEUTRAL_OWNER || owner >= w.playerCount) continue;
      const bit = 1 << owner;
      if ((mask & bit) !== 0) continue; // そのプレイヤーは既に在と分かっている
      if (!isCombatUnit(e, i)) continue;
      mask |= bit;
    }
    cellMask[cell] = mask;
    all |= mask;
  }
  return all;
}

/** (row, col) の ±`r` セル近傍に兵がいるプレイヤーのビットマスク。 */
function neighborhoodMask(w: World, row: number, col: number, r: number): number {
  const g = w.grid;
  const r0 = row - r < 0 ? 0 : row - r;
  const r1 = row + r >= g.rows ? g.rows - 1 : row + r;
  const c0 = col - r < 0 ? 0 : col - r;
  const c1 = col + r >= g.cols ? g.cols - 1 : col + r;
  let mask = 0;
  for (let y = r0; y <= r1; y++) {
    const base = y * g.cols;
    for (let x = c0; x <= c1; x++) mask |= cellMask[base + x]!;
  }
  return mask;
}

/** そのプレイヤーの敵プレイヤーのビットマスク（味方と中立は含まない）。 */
function enemyMask(w: World, p: PlayerId): number {
  let mask = 0;
  for (let q = 0; q < w.playerCount; q++) {
    if (q === p) continue;
    if (areAllies(w, p, q as PlayerId)) continue;
    mask |= 1 << q;
  }
  return mask;
}

/**
 * 1 つの候補（プレイヤー p、中心 (cx, cy) の半径 15 マス）を厳密に判定して孵化させる。
 *
 * 重心は「条件を満たしたユニット集合」= 円内の自軍戦闘ユニット（手動操作中を除く）と
 * 敵戦闘ユニットの平均座標（`07§3` / 手順書 §6.1）。
 */
function considerCandidate(
  w: World,
  p: PlayerId,
  cx: Fx,
  cy: Fx,
  radius: Fx,
  minUnits: number
): void {
  const e = w.entities;
  const out = w.scratch.neighbors;
  // 員数・HP・重心の総和はすべて加算なので、走査順に依存しない（整列しない版を使う）。
  const n = collectCircleUnordered(w, cx, cy, radius, out);

  let ownN = 0;
  let enemyN = 0;
  let hpOwn = 0;
  let hpEnemy = 0;
  let sx = 0;
  let sy = 0;
  for (let k = 0; k < n; k++) {
    const i = out[k]!;
    if (!isCombatUnit(e, i)) continue;
    const owner = e.owner[i]!;
    if (owner === NEUTRAL_OWNER || owner >= w.playerCount) continue;
    if (owner === p) {
      // 手動操作中の兵は編入されない（`07§3`）ので、戦域の芯にもしない。
      if (e.manual[i] === 1) continue;
      // すでに別の戦域にいる兵は新しい戦域の芯にならない。
      if (e.frontId[i] !== 0) continue;
      ownN += 1;
      hpOwn += e.hp[i]!;
    } else if (!areAllies(w, p, owner as PlayerId)) {
      enemyN += 1;
      hpEnemy += e.hp[i]!;
    } else {
      continue;
    }
    sx += e.x[i]!;
    sy += e.y[i]!;
  }
  if (ownN < minUnits || enemyN < minUnits) return;

  const gx = idiv(sx, ownN + enemyN);
  const gy = idiv(sy, ownN + enemyN);

  // 隣接セルから同じ塊を二重に候補化しない。
  const rr = radius * radius;
  for (let c = 0; c < candOwner.length; c++) {
    if (candOwner[c] !== p) continue;
    if (distSq(candX[c]!, candY[c]!, gx, gy) <= rr) return;
  }
  candOwner.push(p);
  candX.push(gx);
  candY.push(gy);

  incubate(w, p, gx, gy, ownN, hpOwn, hpEnemy, radius);
}

/**
 * 候補を孵化器（未使用スロット）に結びつけ、継続 tick 数を進める。
 * `front.spawnEngageSec`（50 tick）継続し、その間に実ダメージを観測していれば戦域化する。
 */
function incubate(
  w: World,
  p: PlayerId,
  gx: Fx,
  gy: Fx,
  ownN: number,
  hpOwn: Fx,
  hpEnemy: Fx,
  radius: Fx
): void {
  const pl = getPlayer(w, p);
  if (pl === undefined) return;
  const usable = pl.frontSlots < MAX_FRONTS ? pl.frontSlots : MAX_FRONTS;
  const rr = radius * radius;

  // 1) 前 tick から継続している孵化器（中心が半径内）を探す。slot 昇順で最初の 1 つ。
  let slot = -1;
  for (let s = 1; s <= usable; s++) {
    const fi = frontIndex(p, s);
    const f = w.fronts[fi]!;
    if (f.active || f.candidateTicks === 0 || matchedSlot[fi] === 1) continue;
    if (distSq(f.x, f.y, gx, gy) > rr) continue;
    slot = s;
    break;
  }

  // 2) 無ければ空きスロットを 1 つ確保して孵化を始める。空きが無ければ戦域にならない（T-M8-09）。
  if (slot < 0) {
    for (let s = 1; s <= usable; s++) {
      const fi = frontIndex(p, s);
      const f = w.fronts[fi]!;
      if (f.active || f.candidateTicks !== 0 || matchedSlot[fi] === 1) continue;
      slot = s;
      matchedSlot[fi] = 1;
      f.candidateTicks = 1;
      f.x = gx;
      f.y = gy;
      f.candidateDamageSeen = false;
      f.lastEngageTick = 0;
      f.candidateHpOwn = hpOwn;
      f.candidateHpEnemy = hpEnemy;
      f.memberCount = ownN;
      return;
    }
    return;
  }

  // 3) 継続。近接条件が成立している tick 数を進め、HP 合計の減少で実ダメージを検出する。
  const fi = frontIndex(p, slot);
  const f = w.fronts[fi]!;
  matchedSlot[fi] = 1;
  f.candidateTicks += 1;
  if (hpOwn < f.candidateHpOwn || hpEnemy < f.candidateHpEnemy) {
    // どちらかの HP 合計が減った = この継続期間中に実ダメージがあった
    f.candidateDamageSeen = true;
    f.lastEngageTick = w.tick;
  }
  f.candidateHpOwn = hpOwn;
  f.candidateHpEnemy = hpEnemy;
  f.x = gx;
  f.y = gy;
  f.memberCount = ownN;

  // `candidateTicks = 1` が最初に条件を満たした tick なので、継続時間は `candidateTicks - 1` tick。
  if (f.candidateTicks - 1 < frontSpawnEngageTicks()) return;
  if (!f.candidateDamageSeen) return; // 近接しているだけで交戦していない
  activateFront(w, f, gx, gy, hpEnemy);
}

/** 候補をたたむ（次の候補のために完全に初期化する）。 */
function clearIncubator(f: Front): void {
  f.candidateTicks = 0;
  f.candidateDamageSeen = false;
  f.candidateHpOwn = 0;
  f.candidateHpEnemy = 0;
  f.x = 0;
  f.y = 0;
  f.lastEngageTick = 0;
  f.memberCount = 0;
}

/**
 * 戦域を立てる。
 *
 * 所属ユニットの割り当て・`memberCount`・`hpBaseOwn` は直後の `frontEnrollment` が行うので、
 * ここでは器だけを整える。`lastSwitchTick` を切り替え間隔ぶん過去に置いて、
 * **立った瞬間から令を渡せる**ようにしている（M9 の切り替え間隔判定に効く）。
 */
function activateFront(w: World, f: Front, gx: Fx, gy: Fx, hpEnemy: Fx): void {
  f.active = true;
  f.x = gx;
  f.y = gy;
  f.radius = frontBaseRadius();
  f.order = null;
  f.orderLower = null;
  f.pendingOrder = null;
  f.lastSwitchTick = w.tick - orderSwitchIntervalTicks();
  f.lastEngageTick = w.tick;
  f.advantage = 0;
  f.dmgDealt.fill(0);
  f.dmgTaken.fill(0);
  f.ringPos = w.tick % ADVANTAGE_WINDOW_TICKS;
  f.hpBaseOwn = 0; // frontEnrollment が編入したユニットの HP を積む
  f.hpBaseEnemy = hpEnemy;
  f.defected = false;
  f.memberCount = 0;
}

// ---------------------------------------------------------------- 5. 成長と優勢度

/**
 * 半径（T-M8-03）と優勢度（T-M8-07）を更新する。
 *
 * 半径は前 tick の `memberCount` から求める。優勢度は
 *  - 与被ダメージ: `dmgDealt` / `dmgTaken` リングバッファ（直近 250 tick）の合計
 *  - 残存兵力比: 自軍 = 所属ユニットの現在 HP 合計 / `hpBaseOwn`、
 *                敵軍 = 半径内の敵戦闘ユニットの現在 HP 合計 / `hpBaseEnemy`
 * `hpBaseEnemy` は「観測した最大値」で更新する（敵は編入されないので入場時刻が取れない。
 * 敵の HP は削られる一方なので、最大値 = 入ってきた時点の合計に一致する）。
 */
function updateGrowthAndAdvantage(w: World): void {
  const e = w.entities;
  for (let fi = 0; fi < SLOT_COUNT; fi++) {
    const f = w.fronts[fi]!;
    if (!f.active) continue;

    const count = countMembers(fi);
    f.memberCount = count;
    f.radius = frontRadiusForMembers(count);

    let hpOwn = 0;
    const end = memberEnd(fi);
    for (let k = memberBegin(fi); k < end; k++) hpOwn += e.hp[groupItems[k]!]!;
    if (hpOwn > f.hpBaseOwn) f.hpBaseOwn = hpOwn;

    const hpEnemy = enemyStrength(w, f.owner, f.x, f.y, f.radius);
    if (hpEnemy > f.hpBaseEnemy) f.hpBaseEnemy = hpEnemy;

    f.advantage = computeAdvantage({
      dealt: sumRing(f.dmgDealt),
      taken: sumRing(f.dmgTaken),
      hpOwn,
      hpBaseOwn: f.hpBaseOwn,
      hpEnemy,
      hpBaseEnemy: f.hpBaseEnemy,
    });
  }
}

/** 中心 (cx, cy) 半径 r 内にいる敵戦闘ユニットの HP 合計（Fx）。 */
function enemyStrength(w: World, owner: PlayerId, cx: Fx, cy: Fx, r: Fx): Fx {
  const e = w.entities;
  const out = w.scratch.neighbors;
  // HP の合計は加算なので走査順に依存しない。
  const n = collectCircleUnordered(w, cx, cy, r, out);
  let hp = 0;
  for (let k = 0; k < n; k++) {
    const i = out[k]!;
    if (!isCombatUnit(e, i)) continue;
    const o = e.owner[i]!;
    if (o === NEUTRAL_OWNER || o >= w.playerCount) continue;
    if (o === owner || areAllies(w, owner, o as PlayerId)) continue;
    hp += e.hp[i]!;
  }
  return hp;
}
