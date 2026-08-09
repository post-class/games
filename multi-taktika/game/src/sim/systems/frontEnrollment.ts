/**
 * システム 4/14: frontEnrollment — 半径内の自軍を戦域に編入（`07§3`, 実装手順書 §6.1）
 *
 * 責務:
 *  - 各戦域の半径内にいる自軍ユニットの `frontId` を設定する。
 *  - `manual = 1` のユニットは編入しない（プレイヤーの手動操作を令が奪わない）。
 *  - 半径外に出たユニットを外す（`frontId = 0`、`lastOrder` は保持）。
 *  - `memberCount` と中心（重心）・`hpBaseOwn` / `hpBaseEnemy` を更新する。
 *
 * 近傍検索は `grid.queryCircle`（index 昇順で返る）を使う。
 * 複数戦域の半径が重なった場合の帰属は **slot 番号の小さい方を優先**（乱数を使わない）。
 *
 * 担当マイルストーン: **M8**（T-M8-02〜）。
 *
 * 仕様の注意（§16-6）: `Ctrl`+`A` は戦域の兵を含めない。
 * 編入判定は入力層の全選択と独立に保つこと。
 *
 * ---------------------------------------------------------------------------
 * 処理順（決定論のため固定。§16-2）
 * ---------------------------------------------------------------------------
 *   1. 編入: `fronts` の index 昇順（= owner 昇順 → slot 昇順）に円内を走査する。
 *      slot 昇順なので、輪が重なった兵は自動的に**小さい slot に属する**。
 *      すでに大きい slot に属している兵は小さい slot へ移す（同じ規則の裏返し）。
 *   2. 離脱と集計: エンティティを index 昇順に 1 パスして
 *      「半径外に出た兵を外す」「所属数と重心を積む」を同時に行う。
 *   3. 重心と `memberCount` の書き戻し。
 *
 * `hpBaseOwn`（兵力比の分母）は **編入した瞬間の HP をその都度足す**。
 * 「戦域に入った時点の HP 合計」（`07§3`）を、ユニットごとの入場時刻を保存せずに表すため。
 * 敵側（`hpBaseEnemy`）は編入という概念が無いので `frontLifecycle` が観測最大値で更新する。
 *
 * 村人も編入する（`07§3` は「自軍ユニット」と書いており、令「建設」は村人が主役になる）。
 */

import type { PlayerId } from '@/shared/types';
import { EntityKind } from '@/shared/types';
import { distSq, idiv } from '../core/fx';
import { MAX_FRONTS, MAX_PLAYERS, getFront, type World } from '../core/world';
import { collectCircleUnordered, frontSkipManual, stampLastOrder } from '../core/front';

/** `fronts` の長さ。 */
const SLOT_COUNT = MAX_PLAYERS * MAX_FRONTS;

/** 集計用の作業領域（tick 内でのみ意味を持つ。状態ではない）。 */
const sumX = new Int32Array(SLOT_COUNT);
const sumY = new Int32Array(SLOT_COUNT);
const count = new Int32Array(SLOT_COUNT);

export function frontEnrollment(w: World): void {
  enrollNearby(w);
  collectMembers(w);
}

/** 1) 半径内の自軍ユニットを編入する（slot 昇順 = 小さい slot 優先）。 */
function enrollNearby(w: World): void {
  const e = w.entities;
  const skipManual = frontSkipManual();
  const out = w.scratch.neighbors;

  for (let fi = 0; fi < SLOT_COUNT; fi++) {
    const f = w.fronts[fi]!;
    if (!f.active) continue;
    // 編入は「ユニットごとに独立した代入」なので走査順に依存しない（整列しない版を使う）。
    const n = collectCircleUnordered(w, f.x, f.y, f.radius, out);
    for (let k = 0; k < n; k++) {
      const i = out[k]!;
      if (e.kind[i] !== EntityKind.Unit) continue;
      if (e.owner[i] !== f.owner) continue;
      if (skipManual && e.manual[i] === 1) continue;
      const cur = e.frontId[i]!;
      if (cur === f.slot) continue;
      // 既に小さい slot に属している兵は動かさない（重なりは小さい slot 優先）。
      if (cur !== 0 && cur < f.slot) continue;
      e.frontId[i] = f.slot;
      // 入場時点の HP を兵力比の分母に足す。
      f.hpBaseOwn += e.hp[i]!;
    }
  }
}

/**
 * 2) 半径外に出た兵を外し、所属数と重心を集計して書き戻す。
 *
 * 反復は entity index 昇順の 1 パス。座標の総和は整数加算なので順序に依存しない。
 */
function collectMembers(w: World): void {
  const e = w.entities;
  sumX.fill(0);
  sumY.fill(0);
  count.fill(0);

  for (let i = 0; i < e.highWater; i++) {
    if (e.alive[i] !== 1) continue;
    if (e.kind[i] !== EntityKind.Unit) continue;
    const slot = e.frontId[i]!;
    if (slot === 0) continue;
    const owner = e.owner[i]! as PlayerId;
    const f = getFront(w, owner, slot);
    if (f === undefined || !f.active) {
      e.frontId[i] = 0;
      continue;
    }
    // 手動操作を始めた兵は戦域から外れる（`06§5`。`Esc` で復帰すると再編入される）。
    if (frontSkipManual() && e.manual[i] === 1) {
      stampLastOrder(e, i, f);
      e.frontId[i] = 0;
      continue;
    }
    if (distSq(f.x, f.y, e.x[i]!, e.y[i]!) > f.radius * f.radius) {
      // 半径外へ出た。最後の令を保持したまま戦域外になる（`07§3`）。
      stampLastOrder(e, i, f);
      e.frontId[i] = 0;
      continue;
    }
    const fi = slot - 1 + owner * MAX_FRONTS;
    count[fi] = count[fi]! + 1;
    sumX[fi] = sumX[fi]! + e.x[i]!;
    sumY[fi] = sumY[fi]! + e.y[i]!;
  }

  for (let fi = 0; fi < SLOT_COUNT; fi++) {
    const f = w.fronts[fi]!;
    if (!f.active) continue;
    const n = count[fi]!;
    f.memberCount = n;
    if (n === 0) continue; // 所属 0 の戦域は cleanup が閉じる
    f.x = idiv(sumX[fi]!, n);
    f.y = idiv(sumY[fi]!, n);
  }
}
