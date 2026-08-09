/**
 * M8 の決定論回帰: 戦域の発生・成長・統合・分裂・消滅が
 * **同一入力で常に同一の結果**になることを確認する（実装手順書 §16-2）。
 *
 * ここで守りたいのは次の 3 点:
 *  1. 同じ World を 2 回回すと、戦域の状態（active / 中心 / 半径 / 優勢度 / 所属）が完全に一致する。
 *  2. `stepWorld` 全体の状態ハッシュも一致する（戦域が状態ハッシュに載っている）。
 *  3. 戦域が**実際に立っている**（テストが空回しになっていないことの確認）。
 *
 * 戦域の判定に乱数は 1 度も使っていないので、`rngCombat` / `rngAi` の状態も一致する。
 */

import { describe, expect, it } from 'vitest';
import { EntityKind } from '@/shared/types';
import { createWorld, type World } from '@/sim/core/world';
import { spawnEntity } from '@/sim/core/entity';
import { FX_ONE, fxFromInt } from '@/sim/core/fx';
import { allocateTerrain } from '@/sim/core/terrain';
import { rebuildGrid } from '@/sim/core/grid';
import { frontLifecycle } from '@/sim/systems/frontLifecycle';
import { frontEnrollment } from '@/sim/systems/frontEnrollment';
import { unitDefById } from '@/sim/core/defs';
import { stepWorld } from '@/sim/index';
import { hashWorld } from '@/sim/hash';

const MAP = 128;
const TICKS = 900; // 36 秒。発生（2 秒）・成長・消滅（15 秒）が一巡する長さ

/** 近接歩兵（`units.json` の `clubman`）。数値リテラルを書かないため defs から引く。 */
const SOLDIER = unitDefById('clubman');

/** 前線 1 本ぶんの兵（近接歩兵）を 2 か所に向かい合わせて置く。 */
function buildScenario(seed: number): World {
  const w = createWorld({
    seed,
    playerCount: 2,
    mapWidthTiles: MAP,
    mapHeightTiles: MAP,
    entityCapacity: 512,
  });
  allocateTerrain(w.map);
  // 城も研究も無い状態だと 1 枠しか無いので、統合・分裂を通すために枠を開けておく。
  for (const pl of w.players) pl.frontSlots = 6;

  // 3 か所（近い 2 か所は統合され、遠い 1 か所は別の戦域として残る配置）。
  // 近接の間合いは 1 マス（`combat.meleeReachTiles`）なので、隣の行に置いて殴り合わせる。
  putSquad(w, 0, 40, 40, 6);
  putSquad(w, 1, 40, 41, 6);
  putSquad(w, 0, 56, 40, 6);
  putSquad(w, 1, 56, 41, 6);
  putSquad(w, 0, 100, 100, 5);
  putSquad(w, 1, 100, 101, 5);
  return w;
}

function putSquad(w: World, owner: number, tx: number, ty: number, n: number): void {
  for (let k = 0; k < n; k++) {
    spawnEntity(w.entities, {
      kind: EntityKind.Unit,
      owner,
      typeId: SOLDIER.index,
      x: fxFromInt(tx + k),
      y: fxFromInt(ty),
      hpMax: SOLDIER.hp,
    });
  }
}

/** 戦域と所属の状態を文字列にする（比較用のスナップショット）。 */
function frontSnapshot(w: World): string {
  const parts: string[] = [];
  for (let s = 0; s < w.fronts.length; s++) {
    const f = w.fronts[s]!;
    if (!f.active) continue;
    parts.push(
      `${f.owner}:${f.slot}:${f.x},${f.y}:r${f.radius}:a${f.advantage}:n${f.memberCount}:e${f.lastEngageTick}`
    );
  }
  const e = w.entities;
  for (let i = 0; i < e.highWater; i++) {
    if (e.alive[i] !== 1) continue;
    parts.push(`u${i}=${e.frontId[i]}/${e.lastOrder[i]}`);
  }
  return parts.join('|');
}

interface RunResult {
  readonly hashes: number[];
  readonly snapshots: string[];
  /** 一度でも active になった戦域の数（テストが空回しでないことの確認用）。 */
  readonly frontsSeen: number;
}

function run(seed: number): RunResult {
  const w = buildScenario(seed);
  const hashes: number[] = [];
  const snapshots: string[] = [];
  const seen = new Set<string>();
  for (let t = 0; t < TICKS; t++) {
    stepWorld(w, []);
    for (let s = 0; s < w.fronts.length; s++) {
      const f = w.fronts[s]!;
      if (f.active) seen.add(`${f.owner}:${f.slot}`);
    }
    if (t % 25 === 0) {
      hashes.push(hashWorld(w));
      snapshots.push(frontSnapshot(w));
    }
  }
  return { hashes, snapshots, frontsSeen: seen.size };
}

/** 戦域だけ（中心・半径・所属数）のスナップショット。ユニット index を含まない。 */
function frontsOnlySnapshot(w: World): string {
  const parts: string[] = [];
  for (let s = 0; s < w.fronts.length; s++) {
    const f = w.fronts[s]!;
    if (!f.active) continue;
    parts.push(`${f.owner}:${f.slot}:${f.x},${f.y}:r${f.radius}:n${f.memberCount}`);
  }
  return parts.join('|');
}

/**
 * `frontLifecycle` → `frontEnrollment` だけを回す（combat を挟まない）。
 * `reverse = true` のときは同じ配置をユニットの生成順だけ逆にして作る。
 */
function runFrontsOnly(reverse: boolean): string[] {
  const w = createWorld({
    seed: 4242,
    playerCount: 2,
    mapWidthTiles: MAP,
    mapHeightTiles: MAP,
    entityCapacity: 512,
  });
  allocateTerrain(w.map);
  for (const pl of w.players) pl.frontSlots = 6;

  const squads: [number, number, number, number][] = [
    [0, 40, 40, 6],
    [1, 40, 41, 6],
    [0, 56, 40, 6],
    [1, 56, 41, 6],
    [0, 100, 100, 5],
    [1, 100, 101, 5],
  ];
  const order = reverse ? [...squads].reverse() : squads;
  for (const [owner, tx, ty, n] of order) putSquad(w, owner, tx, ty, n);

  const out: string[] = [];
  const e = w.entities;
  for (let t = 0; t < 400; t++) {
    rebuildGrid(w.grid, e, w.tick);
    // 全ユニットを一律に削って「実ダメージが発生している」状態を作る（index 非依存）。
    for (let i = 0; i < e.highWater; i++) {
      if (e.alive[i] !== 1) continue;
      if (e.hp[i]! > FX_ONE * 2) e.hp[i] = e.hp[i]! - FX_ONE;
    }
    for (let s = 0; s < w.fronts.length; s++) {
      const f = w.fronts[s]!;
      if (f.active) f.lastEngageTick = w.tick; // 交戦が続いている扱い（消滅させない）
    }
    frontLifecycle(w);
    frontEnrollment(w);
    w.tick += 1;
    if (t % 20 === 0) out.push(frontsOnlySnapshot(w));
  }
  return out;
}

describe('M8 決定論: 戦域の発生・統合・分裂・消滅', () => {
  it('同一シードの 2 回の実行で戦域の状態とハッシュが完全に一致する', () => {
    const a = run(1234);
    const b = run(1234);
    expect(a.frontsSeen).toBeGreaterThan(0); // 実際に戦域が立っている
    expect(b.snapshots).toEqual(a.snapshots);
    expect(b.hashes).toEqual(a.hashes);
  });

  it('別シードでも戦域の判定は乱数に依らないので同じ結果になる', () => {
    // 戦域の発生・統合・分裂は乱数を使わない（`07§3`）。
    // combat も命中確定なので rng を消費しない → シードが違っても同じ経過になる。
    const a = run(1234);
    const b = run(9999);
    expect(b.snapshots).toEqual(a.snapshots);
  });

  it('ユニットの生成順（= entity index の付き方）が変わっても戦域の形は変わらない', () => {
    // 発生候補・統合・分裂の処理順を「座標 (y, x) 昇順 → index 昇順」に固定してあるので、
    // 同じ配置なら **index の付き方が逆でも同じ戦域**になる（§16-2）。
    // combat の目標選択は index をタイブレークに使うため、ここでは
    // 戦域の 2 システムだけを回し、被弾は全ユニット一律の HP 減少で作る。
    const forward = runFrontsOnly(false);
    const reversed = runFrontsOnly(true);
    // 空回しでないこと（実際に戦域が立っているスナップショットがある）。
    expect(forward.some((s) => s.length > 0)).toBe(true);
    expect(reversed).toEqual(forward);
  });

  it('スロット上限を超えた戦闘は戦域にならないが、ユニットは残って戦い続ける', () => {
    const w = buildScenario(7);
    w.players[0]!.frontSlots = 1;
    w.players[1]!.frontSlots = 1;
    for (let t = 0; t < 200; t++) stepWorld(w, []);

    let active = 0;
    for (let s = 0; s < w.fronts.length; s++) if (w.fronts[s]!.active) active += 1;
    // プレイヤー 2 人 × 1 枠 = 最大 2 本まで。
    expect(active).toBeLessThanOrEqual(2);
    // 戦闘そのものは起きている（HP が削れている）。§16-8
    const e = w.entities;
    let damaged = 0;
    for (let i = 0; i < e.highWater; i++) {
      if (e.alive[i] !== 1) continue;
      if (e.hp[i]! < e.hpMax[i]!) damaged += 1;
    }
    expect(damaged).toBeGreaterThan(0);
  });
});
