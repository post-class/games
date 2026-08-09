/**
 * システム 14/14: cleanup — 死亡処理・free list 返却・戦域スロット解放（実装手順書 §4.6）
 *
 * 責務:
 *  - **建物が死んだときの後処理**（跡地の登録・修飾子と戦域スロットの再計算）を
 *    `onBuildingDestroyed` に流す。`flushDead` の**前**に行う（座標と typeId が必要）。
 *  - `markDead` で予約された index を free list に返し、generation を +1 する（`flushDead`）。
 *    tick の**末尾**で行うことで、tick 中に index が別のエンティティへ化けないことを保証する。
 *  - 所属ユニットが 0 になった戦域スロットの解放（M8 で追加）。
 *
 * 担当マイルストーン: free list の返却は **M2**、建物破壊フックの結線は **M10（統合）**。
 * 戦域スロットの解放は M8。
 *
 * ---- なぜフックが「ここ 1 箇所」なのか ----
 *
 * 建物の HP を 0 にするのは `combat.dealDamage` だが、そこに書くと
 * 「他の死因（投射物・自壊・掟による処理・将来の追加）を足すたびに呼び忘れる」。
 * `markDeadIndex` は `alive = 0` にするだけで中身を消さないので、
 * **死亡予約の一覧（`pendingDead`）を tick 末に 1 回なめる**のが漏れも二重呼びも無い唯一の位置。
 * `alive = 0` の時点で他システムの反復からは外れているため、
 * 「壊れた建物が同じ tick に人口や戦域スロットを提供し続ける」ことも起きない。
 */

import type { PlayerId } from '@/shared/types';
import { EntityKind } from '@/shared/types';
import { flushDead } from '../core/entity';
import { getFront, releaseFront, type World } from '../core/world';
import { onBuildingDestroyed } from './construction';
import { spawnFleeingVillagers } from './loyalty';

export function cleanup(w: World): void {
  // 1) 建物・付属物の破壊後処理。index 昇順に並べてから呼ぶ（呼び出し順を全順序に固定する）。
  //    `flushDead` も同じ subarray を昇順に整列するので、ここで整列しても二重整列にならない。
  const e = w.entities;
  const n = e.pendingDeadCount;
  if (n > 0) {
    const pending = e.pendingDead.subarray(0, n);
    pending.sort();
    for (let k = 0; k < n; k++) {
      const i = pending[k]!;
      const kind = e.kind[i]!;
      if (kind !== EntityKind.Building && kind !== EntityKind.Attachment) continue;
      // 跡地タイマーの登録・修飾子と戦域スロットの再計算はすべてこの中に集約されている。
      onBuildingDestroyed(w, i);
      // 掟五（`07§10`）: 落ちた城・町の中心から逃げる村人を出す（M11）。
      // `onBuildingDestroyed` の**後**に呼ぶ（跡地と修飾子を先に確定させてから
      // 新しいエンティティを生む。順序を逆にすると新しい村人が跡地判定に混ざる）。
      spawnFleeingVillagers(w, i);
    }
  }

  // 2) 死亡予約された index を free list へ返す（index 昇順で処理される）。
  flushDead(w.entities);

  // 3) 所属ユニットが 0 になった戦域スロットを解放する（M8 / T-M8-01）。
  //    `frontEnrollment` が数えた `memberCount` は combat より前の値なので、
  //    「この tick に全滅した戦域」を取り逃がす。ここで**生存者だけを数え直す**。
  releaseEmptyFronts(w);
}

/**
 * 所属ユニットが 1 体もいない戦域を閉じる。
 *
 * 戦域は「戦っている部隊の集まり」なので、部隊が全滅（または全員離脱）した時点で
 * 輪は消える。無交戦 15 秒の消滅（`frontLifecycle`）とは別の経路で、
 * **全滅したのに 15 秒間スロットを占有し続ける**のを防ぐのが目的。
 *
 * 反復は index 昇順の 1 パス（`Map` を使わない。実装手順書 §0.3）。
 * `memberCount` も生存者の数で上書きするので、次の tick の半径計算が死者を数えない。
 */
function releaseEmptyFronts(w: World): void {
  const e = w.entities;
  for (let fi = 0; fi < w.fronts.length; fi++) w.fronts[fi]!.memberCount = 0;

  for (let i = 0; i < e.highWater; i++) {
    if (e.alive[i] !== 1) continue;
    if (e.kind[i] !== EntityKind.Unit) continue;
    const slot = e.frontId[i]!;
    if (slot === 0) continue;
    const f = getFront(w, e.owner[i]! as PlayerId, slot);
    if (f === undefined || !f.active) {
      e.frontId[i] = 0;
      continue;
    }
    f.memberCount += 1;
  }

  for (let fi = 0; fi < w.fronts.length; fi++) {
    const f = w.fronts[fi]!;
    if (!f.active) continue;
    if (f.memberCount > 0) continue;
    releaseFront(w, f.owner, f.slot);
  }
}
