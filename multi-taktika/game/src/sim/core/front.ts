/**
 * sim/core/front.ts — 戦域の判定に使う純関数と設定アクセサ（`07§3` / `07§7`, 実装手順書 §6.1）
 *
 * ここには **World を書き換えない関数だけ**を置く。
 * 「式」と「閾値」をシステム（`systems/frontLifecycle.ts` / `systems/frontEnrollment.ts`）から
 * 切り離しておくことで、単体テストが World を組まずに式そのものを検算できる。
 *
 * 決定論の約束:
 *  - 数値リテラルを書かない。すべて `config.json`（`front.*` / `order.*`）から引く（§0.5）。
 *  - 小数は Fx（実数 × 256）。距離比較は平方距離（`*DistSq`）。
 *  - 乱数を一切使わない。戦域の判定に乱数を混ぜるとリプレイが再現しない（§0.3）。
 */

import type { OrderId, PlayerId } from '@/shared/types';
import { EntityKind, orderIndex } from '@/shared/types';
import { cfgBool, cfgFx, cfgInt, cfgTicks, cfgTiles } from './config';
import type { Entities } from './entity';
import { unitDef } from './defs';
import { cellCol, cellRow } from './grid';
import type { Fx } from './fx';
import { FX_ONE, fxClamp, fxDiv, fxFromInt, fxMul, idiv } from './fx';
import { areAllies, type Front, type World } from './world';

// ---------------------------------------------------------------- 設定アクセサ
//
// `cfg*` は内部でキャッシュするので、毎 tick 呼んでも文字列解決は 1 回だけ。

/** 発生判定の半径（Fx）。`front.spawnRadiusTiles` = 15 マス。 */
export function frontSpawnRadius(): Fx {
  return cfgTiles('front.spawnRadiusTiles');
}

/** 発生に必要な戦闘ユニット数（敵味方それぞれ）。`front.spawnMinUnits` = 3。 */
export function frontSpawnMinUnits(): number {
  return cfgInt('front.spawnMinUnits');
}

/** 発生に必要な交戦の継続 tick 数。`front.spawnEngageSec` = 2 秒 = 50 tick。 */
export function frontSpawnEngageTicks(): number {
  return cfgTicks('front.spawnEngageSec');
}

/** 半径の下限（Fx）。`front.growBaseRadiusTiles` = 15 マス。 */
export function frontBaseRadius(): Fx {
  return cfgTiles('front.growBaseRadiusTiles');
}

/** 半径の上限（Fx）。`front.growMaxRadiusTiles` = 30 マス。 */
export function frontMaxRadius(): Fx {
  return cfgTiles('front.growMaxRadiusTiles');
}

/** 半径 +1 マスに必要な所属ユニット数。`front.growUnitsPerRadiusTile` = 4。 */
export function frontUnitsPerRadiusTile(): number {
  return cfgInt('front.growUnitsPerRadiusTile');
}

/** 統合の中心間距離（Fx）。`front.mergeDistTiles` = 20 マス。 */
export function frontMergeDist(): Fx {
  return cfgTiles('front.mergeDistTiles');
}

/** 統合の判定用平方距離（Fx²）。 */
export function frontMergeDistSq(): number {
  const d = frontMergeDist();
  return d * d;
}

/** 分裂の離脱距離（Fx）。`front.splitDistTiles` = 35 マス。 */
export function frontSplitDist(): Fx {
  return cfgTiles('front.splitDistTiles');
}

/** 分裂の判定用平方距離（Fx²）。 */
export function frontSplitDistSq(): number {
  const d = frontSplitDist();
  return d * d;
}

/** 消滅までの無交戦 tick 数。`front.closeIdleSec` = 15 秒 = 375 tick。 */
export function frontCloseIdleTicks(): number {
  return cfgTicks('front.closeIdleSec');
}

/** 警告（点滅）の閾値（Fx）。`front.warnThreshold` = -0.30。 */
export function frontWarnThreshold(): Fx {
  return cfgFx('front.warnThreshold');
}

/** 優勢度の与被ダメージ項の重み（Fx）。`front.advantageDamageWeight` = 0.5。 */
export function frontAdvantageDamageWeight(): Fx {
  return cfgFx('front.advantageDamageWeight');
}

/** 優勢度の残存兵力項の重み（Fx）。`front.advantageStrengthWeight` = 0.5。 */
export function frontAdvantageStrengthWeight(): Fx {
  return cfgFx('front.advantageStrengthWeight');
}

/** `manual = 1` のユニットを編入しないか。`front.enrollSkipManual` = true。 */
export function frontSkipManual(): boolean {
  return cfgBool('front.enrollSkipManual');
}

/** 戦域が閉じたときに最後の令を保持するか。`front.keepLastOrderOnClose` = true。 */
export function frontKeepLastOrderOnClose(): boolean {
  return cfgBool('front.keepLastOrderOnClose');
}

/** 敵の戦域は輪の数と位置のみ見えるか。`front.enemyFrontShowsRingOnly` = true（`07§7`）。 */
export function frontEnemyShowsRingOnly(): boolean {
  return cfgBool('front.enemyFrontShowsRingOnly');
}

/**
 * 令の切り替え間隔（tick）。`order.switchIntervalSec` = 6 秒。
 *
 * 戦域を立てた直後は「まだ 1 枚も渡していない」ので、
 * `lastSwitchTick` をこの分だけ過去に置いて即座に令を渡せるようにする（M9 の判定に効く）。
 */
export function orderSwitchIntervalTicks(): number {
  return cfgTicks('order.switchIntervalSec');
}

// ---------------------------------------------------------------- 判定の純関数

/**
 * 所属ユニット数から半径を求める（T-M8-03）。
 *
 *   radius = clamp(base + floor(memberCount / unitsPerTile), base, max)
 *
 * 除算は `idiv`（0 方向切り捨て）なので浮動小数が混ざらない。
 */
export function frontRadiusForMembers(memberCount: number): Fx {
  const per = frontUnitsPerRadiusTile();
  const base = frontBaseRadius();
  const max = frontMaxRadius();
  const n = memberCount > 0 ? memberCount : 0;
  const grow = per > 0 ? fxFromInt(idiv(n, per)) : 0;
  return fxClamp(base + grow, base, max);
}

/** 優勢度の入力。すべて Fx（HP も Fx）。 */
export interface AdvantageInput {
  /** 直近 10 秒の与ダメージ合計（Fx）。 */
  readonly dealt: Fx;
  /** 直近 10 秒の被ダメージ合計（Fx）。 */
  readonly taken: Fx;
  /** 自軍の現在 HP 合計（Fx）。 */
  readonly hpOwn: Fx;
  /** 自軍が戦域に入った時点の HP 合計（Fx）。 */
  readonly hpBaseOwn: Fx;
  /** 敵軍の現在 HP 合計（Fx）。 */
  readonly hpEnemy: Fx;
  /** 敵軍が戦域に入った時点の HP 合計（Fx）。 */
  readonly hpBaseEnemy: Fx;
}

/**
 * 優勢度（T-M8-07）。`07§3` / 手順書 §6.1 の式そのもの。
 *
 *   advantage = wDmg * clamp((dealt - taken) / max(1, dealt + taken), -1, 1)
 *             + wStr * clamp(自軍残存兵力比 - 敵残存兵力比, -1, 1)
 *
 * 兵力比は「現在 HP 合計 / 戦域に入った時点の HP 合計」。
 * 分母が 0（まだ誰も入っていない / 敵を一度も見ていない）の項は 0 として扱う。
 */
export function computeAdvantage(inp: AdvantageInput): Fx {
  const total = inp.dealt + inp.taken;
  const denom = total > 1 ? total : 1;
  const dmgTerm = fxClamp(fxDiv(inp.dealt - inp.taken, denom), -FX_ONE, FX_ONE);

  const ownRatio = inp.hpBaseOwn > 0 ? fxDiv(inp.hpOwn, inp.hpBaseOwn) : 0;
  const enemyRatio = inp.hpBaseEnemy > 0 ? fxDiv(inp.hpEnemy, inp.hpBaseEnemy) : 0;
  const strTerm = fxClamp(ownRatio - enemyRatio, -FX_ONE, FX_ONE);

  const a =
    fxMul(frontAdvantageDamageWeight(), dmgTerm) + fxMul(frontAdvantageStrengthWeight(), strTerm);
  return fxClamp(a, -FX_ONE, FX_ONE);
}

/** リングバッファ（直近 10 秒）の合計（Fx）。 */
export function sumRing(ring: Int32Array): Fx {
  let s = 0;
  for (let i = 0; i < ring.length; i++) s += ring[i]!;
  return s;
}

/** 警告状態（輪が点滅する。`advantage < front.warnThreshold`）。 */
export function isFrontWarning(f: Front): boolean {
  return f.active && f.advantage < frontWarnThreshold();
}

/**
 * 戦闘ユニットか（発生判定に数える対象）。
 *
 * 「戦闘ユニット」= 攻撃力を持つユニット。村人は除く。
 * 祈祷師・伝令・荷車（`role: support` で `atk = 0`）は数に入らないが、
 * 編入（`frontEnrollment`）の対象にはなる（`07§4` の伝令 -1.0 秒が成立するため）。
 */
export function isCombatUnit(e: Entities, i: number): boolean {
  if (e.kind[i] !== EntityKind.Unit) return false;
  const d = unitDef(e.typeId[i]!);
  if (d.role === 'villager') return false;
  return d.atk > 0;
}

/**
 * `Entities.lastOrder` に入れる値（`ORDER_IDS` の添字 + 1。0 = 令なし）。
 * `orders.json` の記述順は `ORDER_IDS` と一致しているので `ORDER_DEFS` の添字とも一致する。
 */
export function lastOrderValue(id: OrderId | null): number {
  if (id === null) return 0;
  return orderIndex(id) + 1;
}

/**
 * 戦域が今持っている令（上段優先。無ければ下段、どちらも無ければ null）。
 * 離反中（`defected`）の戦域は令を配れないので null を返す。
 */
export function effectiveOrderOf(f: Front): OrderId | null {
  if (f.defected) return null;
  return f.order ?? f.orderLower;
}

/**
 * ユニットに「最後に受けた令」を焼き付ける。
 * 戦域から外れる / 戦域が閉じるときに呼ぶ（`07§3`「最後の令を保持したまま待機」）。
 * 戦域が令を持っていない場合は既存の `lastOrder` を消さない。
 */
export function stampLastOrder(e: Entities, i: number, f: Front): void {
  if (!frontKeepLastOrderOnClose()) return;
  const v = lastOrderValue(effectiveOrderOf(f));
  if (v > 0) e.lastOrder[i] = v;
}

// ---------------------------------------------------------------- 近傍走査

/**
 * 円内のエンティティ index を `out` に積む（**整列しない**版の `queryCircle`）。
 *
 * `grid.queryCircle` は総当たりと順序まで一致させるために結果を index 昇順へ整列するが、
 * 戦域の処理（員数と HP の合計、重心の総和、1 体ずつ独立した `frontId` の代入）は
 * **どれも走査順に依存しない**ので、整列のコストが丸ごと無駄になる。
 * 半径 30 マスの円は 8×8 セルに及び、1 tick に十数回呼ぶため実測で支配的だった
 * （1600 体で 2.0ms/tick → 0.6ms/tick）。
 *
 * **使う側の責務**: この関数の結果に対して行う処理が
 * 「加算」か「対象ごとに独立した代入」だけであることを確認すること。
 * 最小値・最大値の選択や「最初に見つかった 1 つ」を採る処理には使ってはいけない
 * （走査順が結果に出てしまう。§16-2）。
 */
export function collectCircleUnordered(
  w: World,
  cx: Fx,
  cy: Fx,
  r: Fx,
  out: number[]
): number {
  out.length = 0;
  if (r <= 0) return 0;
  const e = w.entities;
  const g = w.grid;
  const rr = r * r;
  const c0 = cellCol(g, cx - r);
  const c1 = cellCol(g, cx + r);
  const r0 = cellRow(g, cy - r);
  const r1 = cellRow(g, cy + r);
  for (let row = r0; row <= r1; row++) {
    const base = row * g.cols;
    for (let col = c0; col <= c1; col++) {
      const cell = base + col;
      const end = g.cellStart[cell + 1]!;
      for (let k = g.cellStart[cell]!; k < end; k++) {
        const i = g.items[k]!;
        if (e.alive[i] !== 1) continue;
        const dx = e.x[i]! - cx;
        const dy = e.y[i]! - cy;
        if (dx * dx + dy * dy <= rr) out.push(i);
      }
    }
  }
  return out.length;
}

// ---------------------------------------------------------------- 視界の例外（T-M8-10）

/**
 * 敵の戦域について**公開してよい情報だけ**を持つ型（`07§7`）。
 *
 * 中身（兵種・数・令・優勢度）は入っていない。**ここにフィールドを足してはいけない。**
 * 少数の兵で戦域を立てて「攻められている」と誤認させる「囮」が、
 * この非対称の上に成立している（§16-5）。
 */
export interface FrontRing {
  /** 誰の戦域か（輪の色）。 */
  readonly owner: PlayerId;
  /** 輪の番号（相手の HUD の何番かは分かる。`07§3` の「輪の数」）。 */
  readonly slot: number;
  /** 中心（Fx）。 */
  readonly x: Fx;
  readonly y: Fx;
  /** 半径（Fx）。輪の大きさ。 */
  readonly radius: Fx;
}

/**
 * 自軍（viewer 自身）の戦域。**視界と無関係に見える**（`07§7` の例外規則）。
 * 反復順は `fronts` の index 昇順 = slot 昇順。
 */
export function ownFronts(w: World, viewer: PlayerId): Front[] {
  const out: Front[] = [];
  for (let s = 0; s < w.fronts.length; s++) {
    const f = w.fronts[s]!;
    if (!f.active) continue;
    if (f.owner !== viewer) continue;
    out.push(f);
  }
  return out;
}

/**
 * 敵の戦域（`07§7`）。**輪の数と位置（と大きさ）だけ**を返す。
 *
 * 視界（霧）は適用しない。「自軍が交戦している場所は視界と無関係に分かる」ため、
 * 相手からも輪の存在は隠せない。逆に**中身は絶対に返さない**ので、
 * UI / AI がこの API を通す限り「囮」が壊れない。
 */
export function visibleEnemyFronts(w: World, viewer: PlayerId): FrontRing[] {
  const out: FrontRing[] = [];
  for (let s = 0; s < w.fronts.length; s++) {
    const f = w.fronts[s]!;
    if (!f.active) continue;
    if (f.owner === viewer) continue;
    if (areAllies(w, f.owner, viewer)) continue;
    out.push({ owner: f.owner, slot: f.slot, x: f.x, y: f.y, radius: f.radius });
  }
  return out;
}
