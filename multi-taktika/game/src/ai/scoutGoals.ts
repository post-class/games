/**
 * ai/scoutGoals.ts — 探索（斥候を歩かせて資源と敵を見つける）
 *
 * ■ なぜ必要になったか（実測で分かったこと）
 * AI には探索の判断が 1 つも無かった。`AiView.seenResourceNodes` は
 * **その瞬間に視界に入っているものだけ**なので、拠点の周りに見えるのは森と果樹だけ。
 * 石切場と金鉱は拠点から 8 マス（視界のすぐ外）にあり、**30 分回しても
 * 石材と金の採集量が 0** だった。金が入らないと鉄器の世に永久に到達せず、
 * 文明ごとの兵種が 1 体も出ない ―― バランス測定が成立しない根っこがここだった。
 *
 * ■ 何をするか
 * 斥候（`traits` に `scout` を持つ兵。無ければ手空きの兵）を、
 * 拠点を中心とした**同心円上の点を順に**歩かせる。通ったところの資源ノードは
 * `econGoals.rememberNodes` が記憶に足すので、以後その資源を採らせられる。
 *
 * ■ 決定論
 * 行き先は「何歩目か」だけで決める（`AiMemory.scoutStep`）。
 * 角度は整数の表から引き、距離も整数。**乱数も時計も使わない**ので
 * 全端末で同じ斥候が同じ順に同じ点へ向かう。
 *
 * ■ ズルをしない（`07§11`）
 * 見えていない場所へ「歩かせる」だけ。**そこに何があるかは着いてから分かる**。
 * 資源の位置を先に知って動くのではない（`AiView` にそんな情報は無い）。
 */

import type { EntityId } from '@/shared/types';
import { EntityKind, RESOURCE_IDS } from '@/shared/types';
import type { Command } from '@/sim/command';
import { unitDef } from '@/sim/core/defs';
import { FX_ONE } from '@/sim/core/fx';
import { Move, hasTerrain, isPassableFor } from '@/sim/core/terrain';

import type { AiContext } from './AiPlayer';
import { memGet, memSet } from './AiPlayer';
import { knowsResource } from './econGoals';
import type { OwnEntity } from './view';

/**
 * 行き先の方角（8 方向）を整数のベクトルで持つ。
 * **三角関数を使わない**（浮動小数を避ける。§0.3 と同じ方針）。
 * 斜めは長さが約 1.41 倍になるが、探索の行き先なので厳密さは要らない。
 */
const DIRS: readonly (readonly [number, number])[] = [
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
  [0, -1],
  [1, -1],
];

/**
 * 何歩目かで「距離の輪」を決める。8 方向を一周したら外側の輪へ移る。
 * 単位はマス。石切場と金鉱が 8 マス先にあったので、最初の輪を 10 にしてある。
 */
const RINGS: readonly number[] = [10, 18, 28, 40];

/** 何歩目 → 行き先（拠点からの相対マス）。**この関数がテスト対象**。 */
export function scoutTarget(step: number): { dx: number; dy: number } {
  const dir = DIRS[step % DIRS.length]!;
  const ring = RINGS[Math.floor(step / DIRS.length) % RINGS.length]!;
  return { dx: dir[0] * ring, dy: dir[1] * ring };
}

/** まだ見つけていない資源があるか（あるなら探索を続ける価値がある）。 */
export function needsExploration(ctx: AiContext): boolean {
  for (let r = 0; r < RESOURCE_IDS.length; r++) {
    if (!knowsResource(ctx, r)) return true;
  }
  return false;
}

/**
 * 探索に出す 1 体を選ぶ。
 *  1. 斥候（`traits` に `scout`）
 *  2. いなければ、戦域に属していない手空きの兵
 *  3. それもいなければ null（村人は使わない ―― 採集を止めるほうが損）
 */
export function pickScout(ctx: AiContext): OwnEntity | null {
  const list = ctx.view.ownEntities;
  // **戦域が立っているあいだは兵を代用にしない。**
  // 代用にすると攻めている隊から 1 体を引き剥がして遠くへ歩かせてしまう
  // （囮の検証テストで「本命 2 隊のはずが 3 隊出る」という形で表面化した）。
  // 斥候そのものは専用の兵なので、戦っていても出して構わない。
  const allowSoldier = ctx.view.ownFronts.length === 0;
  let fallback: OwnEntity | null = null;
  for (let k = 0; k < list.length; k++) {
    const oe = list[k]!;
    if (oe.kind !== EntityKind.Unit) continue;
    const def = unitDef(oe.typeId);
    if (def.traits.includes('scout')) return oe;
    if (!allowSoldier) continue;
    // 村人は採集を止めたくないので使わない
    if (def.role === 'villager') continue;
    if (oe.frontId === 0 && fallback === null) fallback = oe;
  }
  return fallback;
}

/** 盤の内側に収める（外へ歩かせると経路探索が失敗して止まる）。 */
function clampToMap(ctx: AiContext, xFx: number, yFx: number): { x: number; y: number } {
  const map = ctx.view.map;
  const maxX = (map.widthTiles - 1) * FX_ONE;
  const maxY = (map.heightTiles - 1) * FX_ONE;
  return {
    x: xFx < 0 ? 0 : xFx > maxX ? maxX : xFx,
    y: yFx < 0 ? 0 : yFx > maxY ? maxY : yFx,
  };
}

/** 陸を歩けるマスか（水に向かわせても着かない）。 */
function walkable(ctx: AiContext, xFx: number, yFx: number): boolean {
  const map = ctx.view.map;
  if (!hasTerrain(map)) return true;
  const tx = Math.floor(xFx / FX_ONE);
  const ty = Math.floor(yFx / FX_ONE);
  return isPassableFor(map, tx, ty, Move.Land);
}

/**
 * この判断で出す探索の `Command`。
 *
 * **1 判断につき 1 体・1 命令だけ**（何度も行き先を変えると歩き続けて何も見ない）。
 * 目的の資源をすべて見つけたら止める。
 */
export function planScouting(ctx: AiContext): Command[] {
  if (!needsExploration(ctx)) return [];
  const scout = pickScout(ctx);
  if (scout === null) return [];

  const m = ctx.memory;
  const step = memGet(m.scoutStep, 0);
  const own = ctx.view.ownEntities;
  // 拠点の位置は自軍の建物のうち index が最小のもの（= 町の中心）で代用する。
  let baseX = scout.x;
  let baseY = scout.y;
  for (let k = 0; k < own.length; k++) {
    const oe = own[k]!;
    if (oe.kind === EntityKind.Building) {
      baseX = oe.x;
      baseY = oe.y;
      break;
    }
  }

  // 歩けない行き先は飛ばす（最大で 1 周ぶんだけ試す。無限に探さない）
  for (let tries = 0; tries < DIRS.length * RINGS.length; tries++) {
    const t = scoutTarget(step + tries);
    const p = clampToMap(ctx, baseX + t.dx * FX_ONE, baseY + t.dy * FX_ONE);
    if (!walkable(ctx, p.x, p.y)) continue;
    memSet(m.scoutStep, 0, step + tries + 1);
    return [
      {
        t: 'moveUnits',
        p: ctx.playerId,
        units: [ctx.idOf(scout.index) as EntityId],
        x: p.x,
        y: p.y,
        // 積まない（前の行き先を捨てて新しい方角へ向かわせる）
        queued: false,
      },
    ];
  }
  // 全部が歩けないことは実際には起きないが、起きたら次から先へ進める
  memSet(m.scoutStep, 0, step + 1);
  return [];
}
