/**
 * input/context.ts — 右クリックの文脈指示（T-M5-08。`06§2`）
 *
 *   地面 = 移動 / 敵 = 攻撃 / 資源 = 採集 / 味方建物 = 修理 / 船 = 乗船
 *
 * **カーソルの形が「何が起きるか」を先に見せる**（剣 = 攻撃 / 手 = 採集 / 槌 = 修理 / 足 = 移動）。
 * `resolveContext` は「カーソル形状」と「実際に出す Command」を**同じ判定から**返すので、
 * 見た目と挙動がずれない（完了条件「対象ごとに形が変わり、実際の動作と一致する」）。
 *
 * ■ 申し送り（M10 / 水軍で必要になる Command）
 *   `sim/command.ts` の 15 種には **修理と乗船の Command が無い**。
 *   したがって現状は「対象の位置へ `moveUnits`」に落としている。
 *   カーソルは槌 / 船を出すので、`repair` / `board` の Command が追加され次第
 *   `contextCommand` の該当 case を差し替えるだけでよい（判定はそのまま使える）。
 */

import {
  EntityKind,
  INVALID_ENTITY,
  type EntityId,
  type PlayerId,
} from '@/shared/types';
import type { Command } from '@/sim/command';
import { unitDef } from '@/sim/core/defs';
import { PROGRESS_DONE, resolveIndex } from '@/sim/core/entity';
import { isVillagerIndex } from '@/sim/core/gather';
import { FX_HALF, FX_ONE } from '@/sim/core/fx';
import type { World } from '@/sim/core/world';
import { areAllies } from '@/sim/core/world';
import type { VisibilityQuery } from '@/render/spriteLayer';
import { pickEntityAt } from './selection';

/** 何が起きるかを表すカーソル形状（`06§2`）。 */
export const CursorKind = {
  /** 足 = 移動 */
  Move: 'move',
  /** 剣 = 攻撃 */
  Attack: 'attack',
  /** 手 = 採集 */
  Gather: 'gather',
  /** 槌 = 修理 */
  Repair: 'repair',
  /** 船 = 乗船 */
  Board: 'board',
  /** 何も選んでいない（指示できない） */
  None: 'none',
} as const;
export type CursorKindId = (typeof CursorKind)[keyof typeof CursorKind];

/** 文脈判定の結果。 */
export interface ContextResult {
  readonly cursor: CursorKindId;
  /** 指示の対象（地面なら `INVALID_ENTITY`）。 */
  readonly targetId: EntityId;
}

/**
 * カーソル下に何があるかを判定する。**毎フレーム呼べる軽さ**にしてある。
 *
 * 判定順（上から先に当たったものを採る）:
 *  1. 敵（ユニット・建物） → 攻撃
 *  2. 資源ノード           → 採集（選択に村人が居るときだけ。居なければ移動）
 *  3. 味方の船             → 乗船
 *  4. 味方の建物で建設中 or 損傷している → 修理（村人が居るときだけ）
 *  5. それ以外             → 移動
 */
export function resolveContext(
  w: World,
  viewer: PlayerId,
  tileX: number,
  tileY: number,
  selected: readonly EntityId[],
  vision: VisibilityQuery | null = null,
): ContextResult {
  if (selected.length === 0) return { cursor: CursorKind.None, targetId: INVALID_ENTITY };
  const e = w.entities;
  const hasVillager = selected.some((id) => {
    const i = resolveIndex(e, id);
    return i >= 0 && isVillagerIndex(e, i);
  });

  const targetId = pickEntityAt(w, viewer, tileX, tileY, vision);
  if (targetId === INVALID_ENTITY) {
    return { cursor: CursorKind.Move, targetId: INVALID_ENTITY };
  }
  const i = resolveIndex(e, targetId);
  if (i < 0) return { cursor: CursorKind.Move, targetId: INVALID_ENTITY };

  const kind = e.kind[i]!;
  const owner = e.owner[i]!;
  const isEnemy =
    (kind === EntityKind.Unit || kind === EntityKind.Building || kind === EntityKind.Attachment) &&
    owner !== viewer &&
    !areAllies(w, owner, viewer) &&
    owner < w.playerCount;

  if (isEnemy) return { cursor: CursorKind.Attack, targetId };

  if (kind === EntityKind.Resource) {
    return hasVillager
      ? { cursor: CursorKind.Gather, targetId }
      : { cursor: CursorKind.Move, targetId: INVALID_ENTITY };
  }

  if (kind === EntityKind.Unit && unitDef(e.typeId[i]!).role === 'ship') {
    return { cursor: CursorKind.Board, targetId };
  }

  if (kind === EntityKind.Building || kind === EntityKind.Attachment) {
    const damaged = e.hp[i]! < e.hpMax[i]!;
    const underConstruction = e.buildProgress[i]! < PROGRESS_DONE;
    if (hasVillager && (damaged || underConstruction)) {
      return { cursor: CursorKind.Repair, targetId };
    }
    return { cursor: CursorKind.Move, targetId: INVALID_ENTITY };
  }

  return { cursor: CursorKind.Move, targetId: INVALID_ENTITY };
}

/**
 * 文脈指示を `Command` にする。**選択やカメラは Command にしない**（手順書 §9.1）。
 *
 * @param queued `Shift`+右クリック = 指示の予約（連続指示）。
 *               `moveUnits` だけが `queued` を持つ（`sim/command.ts`）。
 * @returns 出す Command。出せないときは null
 */
export function contextCommand(
  w: World,
  viewer: PlayerId,
  selected: readonly EntityId[],
  tileX: number,
  tileY: number,
  queued: boolean,
  vision: VisibilityQuery | null = null,
): Command | null {
  if (selected.length === 0) return null;
  const units = ownUnits(w, viewer, selected);
  if (units.length === 0) return null;
  const r = resolveContext(w, viewer, tileX, tileY, selected, vision);
  const e = w.entities;

  switch (r.cursor) {
    case CursorKind.Attack:
      return { t: 'attackTarget', p: viewer, units, target: r.targetId };
    case CursorKind.Gather: {
      // 村人以外を混ぜても sim 側が弾くが、無駄な入力を送らないよう絞る
      const villagers = units.filter((id) => {
        const i = resolveIndex(e, id);
        return i >= 0 && isVillagerIndex(e, i);
      });
      if (villagers.length === 0) return null;
      return { t: 'gather', p: viewer, units: villagers, target: r.targetId };
    }
    case CursorKind.Repair:
    case CursorKind.Board: {
      // ★ 申し送り: repair / board の Command が無いので、対象の位置へ移動させる。
      const i = resolveIndex(e, r.targetId);
      if (i < 0) return null;
      return {
        t: 'moveUnits',
        p: viewer,
        units,
        x: e.x[i]!,
        y: e.y[i]!,
        queued,
      };
    }
    case CursorKind.Move:
      return {
        t: 'moveUnits',
        p: viewer,
        units,
        x: tileToFx(tileX),
        y: tileToFx(tileY),
        queued,
      };
    case CursorKind.None:
    default:
      return null;
  }
}

/** 選択のうち「自分のユニット」だけ（建物に移動命令は出せない）。 */
function ownUnits(w: World, viewer: PlayerId, selected: readonly EntityId[]): EntityId[] {
  const e = w.entities;
  const out: EntityId[] = [];
  for (const id of selected) {
    const i = resolveIndex(e, id);
    if (i < 0) continue;
    if (e.kind[i] !== EntityKind.Unit) continue;
    if (e.owner[i] !== viewer) continue;
    out.push(id);
  }
  return out;
}

/** マス単位の小数 → Fx（マスの中心に寄せる）。 */
export function tileToFx(t: number): number {
  return Math.round(Math.floor(t) * FX_ONE + FX_HALF);
}
