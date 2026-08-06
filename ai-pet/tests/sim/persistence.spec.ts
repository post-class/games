/**
 * 島の保存と復元のテスト。
 * 「サーバを再起動しても島が続いている」はゲームの前提なので、ここが壊れたら致命的。
 */
import { afterEach, describe, expect, test } from 'vitest';
import { TICKS_PER_ISLAND_DAY } from '@ai-pet/shared';
import { Repo } from '../../packages/server/src/db/repo.ts';
import { IslandSim } from '../../packages/server/src/sim/island.ts';
import { createCritterActor } from '../../packages/server/src/sim/actors.ts';
import { attachAutoSave, resolveSeed, restoreIsland, saveIsland } from '../../packages/server/src/sim/persistence.ts';

const repos: Repo[] = [];
function newRepo(): Repo {
  const r = new Repo(':memory:');
  repos.push(r);
  return r;
}

afterEach(() => {
  for (const r of repos.splice(0)) r.close();
});

function newSim(seed = 'persist-test'): IslandSim {
  return new IslandSim({ islandId: 'main', seed });
}

describe('resolveSeed', () => {
  test('DBが空ならenvのseedを使う', () => {
    const repo = newRepo();
    expect(resolveSeed(repo, 'main', 'env-seed')).toEqual({ seed: 'env-seed', existed: false });
  });

  test('DBに島があればそのseedを優先する（地形が変わらないように）', () => {
    const repo = newRepo();
    const sim = newSim('db-seed');
    saveIsland(sim, repo);
    expect(resolveSeed(repo, 'main', 'env-seed')).toEqual({ seed: 'db-seed', existed: true });
  });
});

describe('保存と復元', () => {
  test('何も保存していなければ復元しない', () => {
    const r = restoreIsland(newSim(), newRepo());
    expect(r.restored).toBe(false);
  });

  test('tick・島日・季節・天気が戻る', () => {
    const repo = newRepo();
    const a = newSim();
    for (let i = 0; i < TICKS_PER_ISLAND_DAY + 500; i++) a.step();
    saveIsland(a, repo);

    const b = newSim();
    const r = restoreIsland(b, repo);
    expect(r.restored).toBe(true);
    expect(b.tick).toBe(a.tick);
    expect(b.clock.islandDay).toBe(a.clock.islandDay);
    expect(b.clock.islandDay).toBe(2);
    expect(b.clock.season).toBe(a.clock.season);
    expect(b.clock.weather).toBe(a.clock.weather);
  });

  test('復元後に進めても天気の抽選位相が一致する（決定論の継続）', () => {
    const repo = newRepo();
    const a = newSim();
    for (let i = 0; i < 5000; i++) a.step();
    saveIsland(a, repo);

    const b = newSim();
    restoreIsland(b, repo);
    for (let i = 0; i < 3000; i++) {
      a.step();
      b.step();
    }
    expect(b.clock.weather).toBe(a.clock.weather);
    expect(b.clock.islandDay).toBe(a.clock.islandDay);
  });

  test('資源の在庫と荒廃度が戻る', () => {
    const repo = newRepo();
    const a = newSim();
    const first = [...a.world.resources.values()][0];
    expect(first).toBeDefined();
    if (first) first.amount = 1.5;
    a.world.addDecay(10, 12, 37);
    saveIsland(a, repo);

    const b = newSim();
    restoreIsland(b, repo);
    expect(b.world.resources.get(first!.id)?.amount).toBeCloseTo(1.5);
    expect(b.world.decayAt(10, 12)).toBe(37);
    expect(b.world.resources.size).toBe(a.world.resources.size);
  });

  test('資源はタイル索引も張り直される', () => {
    const repo = newRepo();
    const a = newSim();
    const node = [...a.world.resources.values()][0]!;
    saveIsland(a, repo);

    const b = newSim();
    restoreIsland(b, repo);
    const found = b.world.resourceOnTile(Math.floor(node.pos.x), Math.floor(node.pos.y));
    expect(found?.id).toBe(node.id);
  });

  test('動物が戻り、プレイヤーは復元されない', () => {
    const repo = newRepo();
    const a = newSim();
    createCritterActor(a.world, { species: 'rabbit', pos: { x: 64.5, y: 64.5 } });
    createCritterActor(a.world, { species: 'cat', pos: { x: 65.5, y: 64.5 } });
    saveIsland(a, repo);

    const b = newSim();
    const r = restoreIsland(b, repo);
    expect(r.critters).toBe(2);
    expect(b.world.countActors('critter')).toBe(2);
    expect(b.world.countActors('player')).toBe(0);
  });

  test('ID採番が続く（復元後に既存IDと衝突しない）', () => {
    const repo = newRepo();
    const a = newSim();
    const lastId = createCritterActor(a.world, { species: 'bird', pos: { x: 64.5, y: 64.5 } }).id;
    saveIsland(a, repo);

    const b = newSim();
    restoreIsland(b, repo);
    expect(b.world.allocId()).toBeGreaterThan(lastId);
  });

  test('RNGの状態が続く（復元後の乱数列が一致する）', () => {
    const repo = newRepo();
    const a = newSim();
    for (let i = 0; i < 300; i++) a.step();
    saveIsland(a, repo);

    const b = newSim();
    restoreIsland(b, repo);
    expect(b.world.rng.getState()).toEqual(a.world.rng.getState());
    expect(b.world.rng.next()).toBe(a.world.rng.next());
  });

  test('壊れたRNG状態（全0）は採用しない', () => {
    const repo = newRepo();
    const a = newSim();
    saveIsland(a, repo);
    repo.db.prepare("UPDATE island_snapshot SET rng_state_json = '[0,0,0,0]'").run();

    const b = newSim();
    restoreIsland(b, repo);
    expect(b.world.rng.getState()).not.toEqual([0, 0, 0, 0]);
    // 退化していない（同じ値を返し続けない）
    const seq = new Set([b.world.rng.next(), b.world.rng.next(), b.world.rng.next()]);
    expect(seq.size).toBe(3);
  });

  test('停止していた時間が offlineMs で分かる', () => {
    const repo = newRepo();
    const a = newSim();
    saveIsland(a, repo);
    repo.db.prepare('UPDATE island SET updated_at = ?').run(Date.now() - 90_000);

    const r = restoreIsland(newSim(), repo);
    expect(r.offlineMs).toBeGreaterThanOrEqual(85_000);
    expect(r.offlineMs).toBeLessThan(120_000);
  });

  test('2回保存・復元を繰り返しても壊れない', () => {
    const repo = newRepo();
    const a = newSim();
    for (let i = 0; i < 100; i++) a.step();
    saveIsland(a, repo);

    const b = newSim();
    restoreIsland(b, repo);
    for (let i = 0; i < 100; i++) b.step();
    saveIsland(b, repo);

    const c = newSim();
    const r = restoreIsland(c, repo);
    expect(r.restored).toBe(true);
    expect(c.tick).toBe(b.tick);
    expect(c.tick).toBe(200);
  });
});

describe('attachAutoSave', () => {
  test('スナップショット間隔で保存される', () => {
    const repo = newRepo();
    const sim = newSim();
    let saves = 0;
    attachAutoSave(sim, repo, () => saves++);
    for (let i = 0; i < 361; i++) sim.step(); // 120tickごと → 3回
    expect(saves).toBe(3);
    expect(repo.loadIsland('main')?.tick).toBe(360);
  });

  test('保存が失敗してもtickは止まらない', () => {
    const repo = newRepo();
    const sim = newSim();
    attachAutoSave(sim, repo);
    repo.close(); // 保存が必ず失敗する状態にする
    expect(() => {
      for (let i = 0; i < 130; i++) sim.step();
    }).not.toThrow();
    expect(sim.tick).toBe(130);
  });
});
