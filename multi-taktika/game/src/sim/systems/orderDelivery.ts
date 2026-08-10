/**
 * システム 2/14: orderDelivery — 令の遅延カウントダウン → 発効（`07§4`, 実装手順書 §6.2）
 *
 * 責務:
 *  - 各戦域の `pendingOrder.deliverAtTick` に達したら `order` / `orderLower` に反映する。
 *  - 発効時に `lastSwitchTick` を更新する（次の令までの間隔判定に使う）。
 *  - 離反（`defected = true`）した戦域は令を捨てる。
 *
 * 遅延の計算式（**`setOrder` 適用時に確定させ**、ここでは到達判定だけを行う）:
 *   delaySec = clamp((1.5 + dist*0.02 + 伝令補正) * 復唱倍率 + 忠誠度ペナルティ, 0.5, 8.0)
 *   計算順は「(1.5 + dist*0.02) → 伝令加算 → 復唱の乗算 → 忠誠度の加算 → クランプ」。
 *   dist は最も近い発信点（本陣 ∪ 自軍の城 / 大天幕）から戦域中心までの直線距離。
 *   式そのものは `core/order.ts` の `orderDelayMs` にある（テストがそこを直接検算する）。
 *
 * **なぜ発信時に固定するのか**: 配達中に城が建ったり伝令が死んだりしても
 * 「もう出た令」は早くならない / 遅くならない。UI の点線が伸び縮みしないためでもある。
 *
 * 担当マイルストーン: **M9**（T-M9-01〜04）。検算値 dist=200 + 伝令 + 復唱 → 2.25 秒。
 *
 * 注意: 「押した瞬間に効かない」ことがゲームの肝（§16-4）。
 * 先行反映や遅延の短縮を「親切心で」入れてはいけない。
 */

import type { World } from '../core/world';

export function orderDelivery(w: World): void {
  // 反復は index 昇順（= プレイヤー昇順 → スロット昇順）。
  for (let k = 0; k < w.fronts.length; k++) {
    const f = w.fronts[k]!;
    const pending = f.pendingOrder;
    if (pending === null) continue;

    // 使われなくなったスロットに配達中の令が残っていたら捨てる
    // （戦域が閉じた・統合された。`releaseFront` が active を落とす）。
    if (!f.active) {
      f.pendingOrder = null;
      continue;
    }

    // 離反した旗は令を聞かない（`07§10`）。届いた瞬間に破り捨てる。
    // 立っている令もこの時点で無効化する（`unitDecision` は defected を見て既定行動に戻る）。
    if (f.defected) {
      f.pendingOrder = null;
      continue;
    }

    if (w.tick < pending.deliverAtTick) continue;

    // 発効。
    //
    // `single`（二重旗を持っていない）なら**この戦域の令は 1 枚だけ**なので、
    // 段に関係なく前の令を置き換える（`05§10`「各戦域に 1 枚」）。
    // 置く先は上段側（`order`）に固定する ―― 読み手（`unitDecision` など）は
    // 上段・下段の両方を見るので、どちらに入れても効果は同じ。
    // 1 か所に決めておくことで「1 枚しか無いのに 2 枚に見える」状態を作らない。
    if (pending.single) {
      f.order = pending.id;
      f.orderLower = null;
    } else if (pending.tier === 'lower') {
      // 二重旗を持っている戦域は上段・下段それぞれ 1 枚ずつ。同じ段は上書きになる
      // （= 同段の重ね掛けは成立しない。`07§4`）。
      f.orderLower = pending.id;
    } else {
      f.order = pending.id;
    }

    f.lastSwitchTick = w.tick;
    f.pendingOrder = null;
  }
}
