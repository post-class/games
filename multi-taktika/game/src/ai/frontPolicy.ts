/**
 * ai/frontPolicy.ts — 戦域の AI（T-M13-04 / T-M13-05。実装手順書 §10、`07§3` / `07§4` / `07§11`）
 *
 * 担当:
 *  1. 立っている戦域（`AiView.ownFronts`）に令を配る。使える令は `ai.json` の `usableOrders`
 *  2. **捨てる戦域を決める**（`advantage` / `warning` を見て「後退」を渡す。`07§2` の 12〜20 分）
 *  3. **囮**（`allowDecoy`）。少数の兵で別の戦域を立てて守備を引き剥がす
 *  4. 段階 5 の上乗せ: **固有令**（`allowUniqueOrders`）と**二重旗の下段**（`allowDoubleFlag`）
 *
 * ズルをしない前提（`07§11`）:
 *  - 令の遅延・切り替え間隔はプレイヤーと同条件。**AI 側で短縮しない**
 *    （`pendingOrder` があるうちは次を出さない。切り替え間隔の判定は `sim` に任せる）。
 *  - 敵の戦域は**輪の位置と半径だけ**見える（`AiView.enemyFronts`）。
 *    中身が見えないからこそ囮が成立する（`07§7` / §16-5）。
 */

import type { Command } from '@/sim/command';
import type { OrderId } from '@/shared/types';
import { EntityKind } from '@/shared/types';
import { cfgFx } from '@/sim/core/config';
import { ORDER_DEFS, civDefById, orderDefById, techDefById } from '@/sim/core/defs';
import type { Fx } from '@/sim/core/fx';
import { distSq } from '@/sim/core/fx';

import type { AiContext } from './AiPlayer';
import { memGet, memSet } from './AiPlayer';
import type { OwnFront } from './view';
import { ARRIVE_RADIUS, SQUAD_MIN_UNITS, attackTargets, combatUnits } from './militaryGoals';

// ---------------------------------------------------------------- データ由来の定数

/** 崩れかけの閾値（`front.warnThreshold` = -0.3。Fx）。ここを下回ったら捨てる候補。 */
const WARN_THRESHOLD: Fx = cfgFx('front.warnThreshold');

/** 二重旗の研究 ID（下段の令を使うのに必要。`07§4`）。 */
const DOUBLE_FLAG_TECH = 'nijuuhata';

// ---------------------------------------------------------------- 使える令

/** その段階が実際に出せる令か（`ai.json` の範囲 + 文明 + 二重旗の研究）。 */
export function canUseOrder(ctx: AiContext, orderId: string): boolean {
  if (!ctx.cfg.usableOrders.includes(orderId)) return false;
  const def = findOrder(orderId);
  if (def === null) return false;
  // 他文明の固有令は出せない（`sim` も弾くが、無駄なコマンドを出さない）。
  if (def.civ !== null) {
    if (!ctx.cfg.allowUniqueOrders) return false;
    if (def.civ !== ctx.view.own.civ) return false;
  }
  // 下段は二重旗（研究）が要る（`07§4`「上段 1 枚 + 下段 1 枚」）。
  if (def.tier === 'lower') {
    if (!ctx.cfg.allowDoubleFlag) return false;
    if (ctx.view.own.researched[techDefById(DOUBLE_FLAG_TECH).index] !== true) return false;
  }
  return true;
}

function findOrder(orderId: string): (typeof ORDER_DEFS)[number] | null {
  for (let i = 0; i < ORDER_DEFS.length; i++) if (ORDER_DEFS[i]!.id === orderId) return ORDER_DEFS[i]!;
  return null;
}

/** その文明の固有令（段階 5 だけが使う。`03§5` / `07§11`）。 */
function uniqueOrderOf(ctx: AiContext): string | null {
  const id = civDefById(ctx.view.own.civ).uniqueOrder;
  if (id === '') return null;
  return canUseOrder(ctx, id) ? id : null;
}

// ---------------------------------------------------------------- 公開: 戦域の判断

/** この判断 tick に出す戦域の `Command`（令 + 囮の移動）。 */
export function planFronts(ctx: AiContext): Command[] {
  const cmds: Command[] = [];
  if (ctx.cfg.maxFronts <= 0) return cmds; // 段階 1 は戦域を運用しない

  const fronts = ctx.view.ownFronts;
  const abandon = pickAbandonedFront(ctx);

  // 反復は slot 昇順（`AiView.ownFronts` はその順に作られている）。
  for (let k = 0; k < fronts.length; k++) {
    const f = fronts[k]!;
    // 使える枠数を超えた戦域には令を配らない（`ai.json` の maxFronts）。
    if (f.slot > ctx.cfg.maxFronts) continue;
    // 配達中の令があるうちは出さない（連打しない = プレイヤーと同条件。`06§4`）。
    if (f.pending) continue;
    // 離反中の戦域には令が効かない（`07§10`）。無駄なコマンドを出さない。
    if (f.defected) continue;

    const upper = chooseUpperOrder(ctx, f, abandon === f.slot);
    if (upper !== null && upper !== f.order) {
      cmds.push({ t: 'setOrder', p: ctx.playerId, front: f.slot, order: upper as OrderId, tier: 'upper' });
      continue; // 1 戦域につき 1 枚。次の判断で下段を足す
    }
    const lower = chooseLowerOrder(ctx, f);
    if (lower !== null && lower !== f.orderLower) {
      cmds.push({ t: 'setOrder', p: ctx.playerId, front: f.slot, order: lower as OrderId, tier: 'lower' });
    }
  }

  // 囮（段階 4 以上）。
  const decoy = planDecoy(ctx);
  if (decoy !== null) cmds.push(decoy);

  return cmds;
}

// ---------------------------------------------------------------- 令の選択

/**
 * 上段（移動・配置の方針）を選ぶ。
 *  - 捨てると決めた戦域 → 「後退」
 *  - 崩れかけ（`front.warnThreshold` 未満）で後退が使えない → 「死守」
 *  - 固有令が使えて上段なら固有令（段階 5。`07§11`「固有令まで使用」）
 *  - 優勢（0 以上） → 「突撃」
 *  - それ以外 → 「死守」
 */
function chooseUpperOrder(ctx: AiContext, f: OwnFront, abandoned: boolean): string | null {
  if (abandoned && canUseOrder(ctx, 'retreat')) return 'retreat';

  const unique = uniqueOrderOf(ctx);
  if (unique !== null && orderDefById(unique).tier === 'upper') return unique;

  if (f.advantage < WARN_THRESHOLD) {
    if (canUseOrder(ctx, 'hold')) return 'hold';
    return null;
  }
  if (f.advantage >= 0 && canUseOrder(ctx, 'charge')) return 'charge';
  if (canUseOrder(ctx, 'hold')) return 'hold';
  return null;
}

/**
 * 下段（攻撃目標の優先）を選ぶ。**二重旗を取っている段階 5 だけ**が到達する。
 *  - 固有令が下段ならそれ（交易・火計・奉納）
 *  - 戦域の輪の中に敵の建物が見えていて攻城が使えるなら「包囲」（`allowSiege`）
 *  - それ以外は「略奪」
 */
function chooseLowerOrder(ctx: AiContext, f: OwnFront): string | null {
  const unique = uniqueOrderOf(ctx);
  if (unique !== null && orderDefById(unique).tier === 'lower') return unique;
  if (ctx.cfg.allowSiege && canUseOrder(ctx, 'siege') && enemyBuildingInFront(ctx, f)) return 'siege';
  if (canUseOrder(ctx, 'raid')) return 'raid';
  return null;
}

/** その戦域の輪の中に敵の建物が見えているか（攻城の判断材料）。 */
function enemyBuildingInFront(ctx: AiContext, f: OwnFront): boolean {
  const list = ctx.view.seenEnemies;
  const r2 = f.radius * f.radius;
  for (let k = 0; k < list.length; k++) {
    const s = list[k]!;
    if (s.kind !== EntityKind.Building) continue;
    if (distSq(f.x, f.y, s.x, s.y) <= r2) return true;
  }
  return false;
}

/**
 * **捨てる戦域**を 1 つ選ぶ（`07§2` の「捨てる戦域を選び始める」）。
 *
 * 条件: 崩れかけ（`advantage < front.warnThreshold`）の戦域のうち、
 *  - ほかに優勢な戦域がある（＝そちらに兵を回した方がよい）か
 *  - 中の兵が戦域を保てない人数（`front.spawnMinUnits` 未満）
 * を満たすもの。同条件なら **advantage が最も低い戦域**（同値は slot 昇順）。
 *
 * 戻り値は slot 番号（0 = 捨てない）。**1 回の判断で捨てるのは 1 つだけ**
 * （全戦線を同時に畳むと総崩れになる）。
 */
export function pickAbandonedFront(ctx: AiContext): number {
  const fronts = ctx.view.ownFronts;
  if (fronts.length === 0) return 0;
  let hasWinning = false;
  for (let k = 0; k < fronts.length; k++) if (fronts[k]!.advantage > 0) hasWinning = true;

  let pick = 0;
  let worst = 0;
  for (let k = 0; k < fronts.length; k++) {
    const f = fronts[k]!;
    if (f.advantage >= WARN_THRESHOLD) continue;
    if (!hasWinning && f.memberCount >= SQUAD_MIN_UNITS) continue;
    if (pick === 0 || f.advantage < worst) {
      pick = f.slot;
      worst = f.advantage;
    }
  }
  return pick;
}

// ---------------------------------------------------------------- 囮

/**
 * 囮の戦域を仕込む（`07§11` 段階 4「戦域を上限まで使い、囮を立てます」）。
 *
 * 戦域は**戦闘の結果として自動で生まれる**（`07§3`）ので、AI は
 * 「別の場所へ少数（`front.spawnMinUnits`）を送る」ことしかできない。
 * 送った先で交戦が 2 秒続けば戦域が立ち、相手は守備を割かねばならなくなる。
 * 中身が見えないのが囮の根拠（`07§7`）。
 *
 * 条件:
 *  - `allowDecoy` の段階
 *  - 本命の戦域が既に立っている（囮だけ出しても意味がない）
 *  - 戦域スロットに余裕がある（`ai.json` の maxFronts）
 *  - 送り先が 2 つ以上見えている（本命と別の場所へ送る）
 *  - まだ送っていない兵が `front.spawnMinUnits` 体ある
 */
export function planDecoy(ctx: AiContext): Command | null {
  if (!ctx.cfg.allowDecoy) return null;
  const view = ctx.view;
  if (view.ownFronts.length === 0) return null;
  if (view.ownFronts.length >= ctx.cfg.maxFronts) return null;

  const targets = attackTargets(ctx);
  if (targets.length < 2) return null;
  // 本命（近い方）ではなく**別の場所**を狙う。いちばん遠い候補を選ぶ
  // （守備を大きく引き剥がすため。並びは近い順に固定されている）。
  const target = targets[targets.length - 1]!;

  const m = ctx.memory;
  const units = combatUnits(view);
  const ids: number[] = [];
  const idx: number[] = [];
  for (let k = 0; k < units.length && ids.length < SQUAD_MIN_UNITS; k++) {
    const oe = units[k]!;
    if (oe.frontId !== 0) continue; // 戦っている兵は抜かない
    if (memGet(m.siegeTarget, oe.index) !== 0) continue; // 攻城中の兵も抜かない
    const id = ctx.idOf(oe.index);
    if (id < 0) continue;
    if (memGet(m.dispatched, oe.index) === id) continue;
    ids.push(id);
    idx.push(oe.index);
  }
  if (ids.length < SQUAD_MIN_UNITS) return null;

  for (let k = 0; k < idx.length; k++) {
    memSet(m.dispatched, idx[k]!, ids[k]!);
    memSet(m.dispatchX, idx[k]!, target.x);
    memSet(m.dispatchY, idx[k]!, target.y);
    memSet(m.decoy, idx[k]!, ids[k]!);
  }
  m.decoyTick = view.tick;
  return { t: 'moveUnits', p: ctx.playerId, units: ids, x: target.x, y: target.y, queued: false };
}

/** 囮として送った兵の数（テストと HUD の検証用）。 */
export function decoyCount(ctx: AiContext): number {
  const m = ctx.memory;
  let n = 0;
  for (let i = 0; i < m.decoy.length; i++) if (memGet(m.decoy, i) !== 0) n++;
  return n;
}

/** 到着判定の半径（`militaryGoals` と共有。テストの可読性のため再公開）。 */
export const DECOY_ARRIVE_RADIUS: Fx = ARRIVE_RADIUS;
