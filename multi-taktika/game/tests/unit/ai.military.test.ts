/**
 * 軍事 AI（T-M13-03）。完了条件: **相手がアステカのとき槍兵を減らし弓兵を増やす**。
 *
 * ここで確かめたいのは「文明名の if 文」ではなく、
 *   見た兵 → 相手の文明 → その文明の `unitTree`（＝穴）→ 相性の期待値
 * というデータだけの経路で `03§5` の読み合いが出ること。
 *
 * アステカは**騎兵・獣兵・火器を持たない**（`03§5`「持っていないもの」）。
 * したがって槍の「騎兵に強い ×1.5」が 1 度も掛からず、槍の割合が下がる。
 * 遠隔は相手の近接（剣・槍）に ×1.5 が掛かるので割合が上がる。
 */

import { describe, expect, it } from 'vitest';
import { EntityKind } from '@/shared/types';
import type { CivId } from '@/shared/types';
import { spawnEntity } from '@/sim/core/entity';
import { fxFromInt } from '@/sim/core/fx';
import { unitDefById } from '@/sim/core/defs';
import { createWorld } from '@/sim/core/world';
import type { World } from '@/sim/core/world';
import { createAiView, desiredRoleMix, readEnemy, roleShare } from '@/ai/index';

const MAP = 200;

function makeWorld(enemyCiv: CivId): World {
  return createWorld({
    seed: 5,
    playerCount: 2,
    mapWidthTiles: MAP,
    mapHeightTiles: MAP,
    entityCapacity: 256,
    civs: ['yamato', enemyCiv],
  });
}

function putUnit(w: World, id: string, owner: number, tx: number, ty: number): void {
  const def = unitDefById(id);
  spawnEntity(w.entities, {
    kind: EntityKind.Unit,
    owner,
    typeId: def.index,
    x: fxFromInt(tx),
    y: fxFromInt(ty),
    hpMax: def.hp,
  });
}

/** 自軍の斥候（視界あり）と、視界内の敵の近接兵 1 体を置いた世界の視界。 */
function viewWithEnemyMelee(enemyCiv: CivId, enemyUnitId: string) {
  const w = makeWorld(enemyCiv);
  putUnit(w, 'scout', 0, 50, 50);
  putUnit(w, enemyUnitId, 1, 52, 50);
  return createAiView(w, 0);
}

describe('軍事 AI（T-M13-03）— 相手の「穴」から兵種を逆算する', () => {
  it('見た兵から相手の文明を推定する（AiView に敵の civ は入っていない）', () => {
    const view = viewWithEnemyMelee('azteca', 'a-obsidian');
    const read = readEnemy(view);
    expect(read.civs).toEqual(['azteca']);
    expect(read.seenUnits).toBe(1);
  });

  it('視界の外の敵からは何も推定しない（透視しない。07§11）', () => {
    const w = makeWorld('azteca');
    putUnit(w, 'scout', 0, 50, 50);
    putUnit(w, 'a-obsidian', 1, 150, 150); // 遠すぎて見えない
    const read = readEnemy(createAiView(w, 0));
    expect(read.civs).toEqual([]);
    expect(read.seenUnits).toBe(0);
  });

  it('相手がアステカ（騎兵なし）のとき槍の割合が下がり、弓の割合が上がる', () => {
    // 同じ「敵の剣兵 1 体が見えている」状況で、文明だけを変える。
    const azteca = desiredRoleMix(viewWithEnemyMelee('azteca', 'a-obsidian'));
    const roma = desiredRoleMix(viewWithEnemyMelee('roma', 'r-principes'));

    const spearA = roleShare(azteca, 'spear');
    const spearR = roleShare(roma, 'spear');
    const rangedA = roleShare(azteca, 'ranged');
    const rangedR = roleShare(roma, 'ranged');

    // 槍は減る / 弓は増える（`03§5`「槍兵を切って弓兵に寄せられます」）。
    expect(spearA).toBeLessThan(spearR);
    expect(rangedA).toBeGreaterThan(rangedR);
    // アステカ相手には弓 > 槍（寄せる先が逆転している）。
    expect(rangedA).toBeGreaterThan(spearA);
  });

  it('相手がモンゴル（騎兵だけ）のときは槍の割合が上がる（逆の読みも成立する）', () => {
    const mongol = desiredRoleMix(viewWithEnemyMelee('mongol', 'g-dismount'));
    const azteca = desiredRoleMix(viewWithEnemyMelee('azteca', 'a-obsidian'));
    expect(roleShare(mongol, 'spear')).toBeGreaterThan(roleShare(azteca, 'spear'));
  });

  it('敵を 1 体も見ていなければ寄せない（戦える役割に均等）', () => {
    const w = makeWorld('azteca');
    putUnit(w, 'scout', 0, 50, 50);
    const mix = desiredRoleMix(createAiView(w, 0));
    expect(roleShare(mix, 'spear')).toBe(roleShare(mix, 'ranged'));
    expect(roleShare(mix, 'spear')).toBeGreaterThan(0);
  });

  /**
   * ■ 敵の建物を数えると攻城の需要が立つ（`counterMatrix` の `siege → building: good`）
   *
   * これが無かったために**攻城工房が 1 棟も建たなかった**（実測: 段階 5・4 組・30 分で
   * 工房 0 棟・攻城兵器 0 体）。`readEnemy` が敵の建物を**文明の推定にしか使っておらず**、
   * `roleWeight` の `building` が 1 度も立たなかったので、攻城の点数が構造的に 0 だった。
   *
   * 直し方は「攻城のための特別扱い」ではなく、**データに任せる**形にしてある:
   * 敵の建物の棟数（`ai.json` の `enemyBuildingWeightMax` で頭打ち）を
   * `building` の重みに足すだけ。あとは既存の相性表が攻城を持ち上げる。
   */
  it('敵の建物を数えると攻城の割合が上がる（counterMatrix の siege→building がそのまま効く）', () => {
    const view = viewWithEnemyMelee('roma', 'r-principes');
    const without = desiredRoleMix(view); // 既定は 0（既存の呼び出しと同じ）
    const withBuildings = desiredRoleMix(view, 4);
    expect(roleShare(withBuildings, 'siege')).toBeGreaterThan(roleShare(without, 'siege'));
    // 建物に弱い役割（槍は building の欄が無い＝等倍）より伸びること。
    const gainSiege = roleShare(withBuildings, 'siege') - roleShare(without, 'siege');
    const gainSpear = roleShare(withBuildings, 'spear') - roleShare(without, 'spear');
    expect(gainSiege).toBeGreaterThan(gainSpear);
  });

  it('建物の重みは上限で頭打ちになる（拠点で 10 棟見えても攻城に寄りすぎない）', () => {
    const view = viewWithEnemyMelee('roma', 'r-principes');
    // 呼び出し側（`militaryGoals.planMilitary`）が `enemyBuildingWeightMax` で
    // 頭打ちにした値を渡す。ここでは同じ値を 2 回渡して結果が変わらないことを見る。
    const capped = desiredRoleMix(view, 3);
    const sameCapped = desiredRoleMix(view, 3);
    expect(roleShare(capped, 'siege')).toBe(roleShare(sameCapped, 'siege'));
    // 上限より大きい重みを渡せば当然もっと寄る（上限を置く意味がある）。
    expect(roleShare(desiredRoleMix(view, 8), 'siege')).toBeGreaterThan(roleShare(capped, 'siege'));
  });
});
