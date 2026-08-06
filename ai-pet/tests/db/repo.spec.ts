/**
 * 永続化レイヤのテスト（docs/02_ゲーム実装プラン/03_データモデル.md §3-§4）
 *
 * サーバ再起動をまたいで「同じ島・同じ位置」に戻れることが M2 の完了条件なので、
 * 往復（保存→復元）の一致とファイルを閉じ直しても残ることを重点的に見る。
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { MAP_H, MAP_W, type Actor, type IslandEvent, type Placeable, type ResourceNode } from '@ai-pet/shared';
import { Repo, TILES_DECAY_BYTES, type IslandStateRecord, type SnapshotData } from '../../packages/server/src/db/repo.ts';

const TMP_ROOT = join(import.meta.dirname, '../../.tmp');
const tmpDirs: string[] = [];

function tmpDbPath(): string {
  mkdirSync(TMP_ROOT, { recursive: true });
  const dir = mkdtempSync(join(TMP_ROOT, 'db-test-'));
  tmpDirs.push(dir);
  // ディレクトリを自動作成することの確認も兼ねて、1段深いパスを渡す
  return join(dir, 'nested', 'island.db');
}

afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

// ---------- テスト用のデータ生成（Math.random は使わない） ----------

function makeDecay(seed: number): Uint8Array {
  const a = new Uint8Array(TILES_DECAY_BYTES);
  for (let i = 0; i < a.length; i++) a[i] = (i * 7 + seed) % 101;
  return a;
}

function makeCritter(id: number): Actor {
  return {
    id,
    kind: 'critter',
    species: 'rabbit',
    name: `うさ${id}`,
    pos: { x: 10 + id * 0.25, y: 20 + id * 0.5 },
    facing: 'e',
    speed: 1.6,
    anim: 'idle',
    needs: { hunger: 12, sleep: 3, social: 40, safety: 0, curiosity: 8 },
    traits: { energy: 0.5, sociability: 0.6, caution: 0.4, gluttony: 0.3, curiosity: 0.7 },
    ageDays: 3,
    lifespanDays: 80,
    health: 100,
    action: null,
    path: null,
  };
}

function makeResources(n: number): ResourceNode[] {
  const out: ResourceNode[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      id: 1000 + i,
      type: i % 2 === 0 ? 'berry_tree' : 'field',
      pos: { x: (i % 128) + 0.5, y: Math.floor(i / 128) + 0.5 },
      amount: i % 7,
      max: 6,
      regenPerIslandHour: 0.6,
    });
  }
  return out;
}

function makePlaceables(n: number): Placeable[] {
  const out: Placeable[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ id: 2000 + i, type: 'bench', pos: { x: 64.5, y: 64.5 + i }, ownerId: `p${i}`, attract: 1.5 });
  }
  return out;
}

function makeSnapshot(opts?: { tick?: number; resources?: number; critters?: number }): SnapshotData {
  const critters: Actor[] = [];
  for (let i = 0; i < (opts?.critters ?? 3); i++) critters.push(makeCritter(i + 1));
  return {
    tick: opts?.tick ?? 4800,
    critters,
    resources: makeResources(opts?.resources ?? 5),
    placeables: makePlaceables(2),
    tilesDecay: makeDecay(opts?.tick ?? 4800),
    nextEntityId: 3210,
    rngState: [123456789, 362436069, 521288629, 88675123],
  };
}

const ISLAND: IslandStateRecord = {
  id: 'main',
  seed: 'pokomofu-1',
  tick: 14_400 * 3 + 77,
  islandDay: 4,
  season: 'spring',
  weather: 'rain',
  lastWeatherRollTick: 14_400 * 3,
  updatedAt: 1_770_000_000_000,
};

function makeEvent(islandDay: number, importance: number, text: string): IslandEvent {
  return {
    kind: 'quarrel',
    tick: islandDay * 14_400,
    islandDay,
    actorId: 5,
    targetId: 6,
    pos: { x: 1.5, y: 2.5 },
    text,
    importance,
  };
}

// ---------- テスト本体 ----------

describe('Repo（スキーマ）', () => {
  test('必要なテーブルがすべて作られる', () => {
    const repo = new Repo(':memory:');
    const rows = repo.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
    const names = new Set(rows.map((r) => r.name));
    for (const t of [
      'island',
      'island_snapshot',
      'player',
      'pet',
      'island_event',
      'pet_memory',
      'chat_log',
      'relation',
      'llm_usage',
    ]) {
      expect(names.has(t)).toBe(true);
    }
    repo.close();
  });

  test('2回開いても CREATE TABLE IF NOT EXISTS で壊れない', () => {
    const path = tmpDbPath();
    const a = new Repo(path);
    a.saveIsland(ISLAND);
    a.close();
    const b = new Repo(path);
    expect(b.loadIsland('main')?.seed).toBe('pokomofu-1');
    b.close();
  });

  test('ファイルDBでは journal_mode が WAL になる', () => {
    const repo = new Repo(tmpDbPath());
    expect(String(repo.db.pragma('journal_mode', { simple: true })).toLowerCase()).toBe('wal');
    repo.close();
  });
});

describe('Repo（プレイヤー）', () => {
  let repo: Repo;
  beforeEach(() => {
    repo = new Repo(':memory:');
  });
  afterEach(() => {
    repo.close();
  });

  test('作成 → secretで復元 → 位置と表示名の更新が反映される', () => {
    const created = repo.createPlayer({
      secret: 'secret-abc-123',
      displayName: 'ぽこ太',
      islandId: 'main',
      pos: { x: 64.5, y: 64.5 },
    });
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.pos).toEqual({ x: 64.5, y: 64.5 });

    const found = repo.findPlayerBySecret('secret-abc-123');
    expect(found).not.toBeNull();
    expect(found?.id).toBe(created.id);
    expect(found?.displayName).toBe('ぽこ太');

    repo.updatePlayer(created.id, { displayName: 'ぽこ次郎', pos: { x: 12.25, y: 99.75 }, lastSeenAt: 1234 });
    const after = repo.findPlayerBySecret('secret-abc-123');
    expect(after?.displayName).toBe('ぽこ次郎');
    // 座標は REAL でそのまま保存する（丸めない）
    expect(after?.pos).toEqual({ x: 12.25, y: 99.75 });
    expect(after?.lastSeenAt).toBe(1234);
    expect(after?.createdAt).toBe(created.createdAt);
  });

  test('違うsecretでは null', () => {
    repo.createPlayer({ secret: 'right', displayName: 'a', islandId: 'main', pos: { x: 1, y: 2 } });
    expect(repo.findPlayerBySecret('wrong')).toBeNull();
    expect(repo.findPlayerBySecret('')).toBeNull();
  });

  test('patchが空なら何も変わらない', () => {
    const p = repo.createPlayer({ secret: 's', displayName: 'a', islandId: 'main', pos: { x: 1, y: 2 } });
    repo.updatePlayer(p.id, {});
    expect(repo.findPlayerById(p.id)).toEqual(p);
  });

  test('countPlayers は島ごとに数える', () => {
    repo.createPlayer({ secret: 's1', displayName: 'a', islandId: 'main', pos: { x: 1, y: 1 } });
    repo.createPlayer({ secret: 's2', displayName: 'b', islandId: 'main', pos: { x: 2, y: 2 } });
    repo.createPlayer({ secret: 's3', displayName: 'c', islandId: 'other', pos: { x: 3, y: 3 } });
    expect(repo.countPlayers('main')).toBe(2);
    expect(repo.countPlayers('other')).toBe(1);
    expect(repo.countPlayers('none')).toBe(0);
  });

  test('secretが平文でDBに入っていない', () => {
    const dir = join(tmpDbPath(), '..');
    const path = join(dir, 'island.db');
    const secret = 'PLAINTEXT-SECRET-DO-NOT-STORE';
    const r = new Repo(path);
    r.createPlayer({ secret, displayName: 'ぽこ太', islandId: 'main', pos: { x: 1, y: 2 } });
    // 行の中にも平文がない
    const rows = r.db.prepare('SELECT * FROM player').all() as Record<string, unknown>[];
    expect(JSON.stringify(rows)).not.toContain(secret);
    expect(String(rows[0]?.['secret_hash'])).toMatch(/^[0-9a-f]{64}$/);
    r.close();

    // ファイル（WALを含む）にも平文がない
    let scanned = 0;
    for (const name of readdirSync(dir)) {
      const buf = readFileSync(join(dir, name));
      expect(buf.includes(secret)).toBe(false);
      scanned++;
    }
    expect(scanned).toBeGreaterThan(0);
    expect(existsSync(path)).toBe(true);
  });
});

describe('Repo（島の状態）', () => {
  test('保存 → 復元で全フィールドが一致する', () => {
    const repo = new Repo(':memory:');
    expect(repo.loadIsland('main')).toBeNull();
    repo.saveIsland(ISLAND);
    expect(repo.loadIsland('main')).toEqual(ISLAND);

    // 同じidは上書き（1行 = 1島）
    const next: IslandStateRecord = { ...ISLAND, tick: ISLAND.tick + 240, weather: 'fog', updatedAt: ISLAND.updatedAt + 30_000 };
    repo.saveIsland(next);
    expect(repo.loadIsland('main')).toEqual(next);
    expect(repo.db.prepare('SELECT COUNT(*) AS n FROM island').get()).toEqual({ n: 1 });
    repo.close();
  });
});

describe('Repo（スナップショット）', () => {
  test('資源・設置物・荒廃度・nextEntityId・rngStateの往復が一致する', () => {
    const repo = new Repo(':memory:');
    expect(repo.loadSnapshot('main')).toBeNull();

    const snap = makeSnapshot();
    repo.saveSnapshot('main', snap);
    const loaded = repo.loadSnapshot('main');
    expect(loaded).not.toBeNull();
    expect(loaded?.tick).toBe(snap.tick);
    expect(loaded?.critters).toEqual(snap.critters);
    expect(loaded?.resources).toEqual(snap.resources);
    expect(loaded?.placeables).toEqual(snap.placeables);
    expect(loaded?.nextEntityId).toBe(snap.nextEntityId);
    expect(loaded?.rngState).toEqual(snap.rngState);
    // Uint8Array として戻ること（Buffer のままにしない）
    expect(loaded?.tilesDecay).toBeInstanceOf(Uint8Array);
    expect(Array.from(loaded?.tilesDecay ?? [])).toEqual(Array.from(snap.tilesDecay));
    repo.close();
  });

  test('荒廃度BLOBの長さが 128*128 である', () => {
    const repo = new Repo(':memory:');
    repo.saveSnapshot('main', makeSnapshot());
    const row = repo.db.prepare('SELECT length(tiles_decay) AS n FROM island_snapshot').get() as { n: number };
    expect(row.n).toBe(MAP_W * MAP_H);
    expect(row.n).toBe(16_384);
    expect(repo.loadSnapshot('main')?.tilesDecay.length).toBe(TILES_DECAY_BYTES);
    repo.close();
  });

  test('長さの違う荒廃度は拒否する', () => {
    const repo = new Repo(':memory:');
    const bad = { ...makeSnapshot(), tilesDecay: new Uint8Array(10) };
    expect(() => repo.saveSnapshot('main', bad)).toThrow(/tilesDecay/);
    repo.close();
  });

  test('保存→復元を2回繰り返しても壊れない', () => {
    const repo = new Repo(':memory:');
    const first = makeSnapshot({ tick: 120, critters: 2 });
    repo.saveSnapshot('main', first);
    expect(repo.loadSnapshot('main')?.tick).toBe(120);

    const second = makeSnapshot({ tick: 240, critters: 5 });
    repo.saveSnapshot('main', second);
    const loaded = repo.loadSnapshot('main');
    expect(loaded?.tick).toBe(240);
    expect(loaded?.critters).toHaveLength(5);
    expect(Array.from(loaded?.tilesDecay ?? [])).toEqual(Array.from(second.tilesDecay));
    // 1島＝1行を上書きしている
    expect(repo.db.prepare('SELECT COUNT(*) AS n FROM island_snapshot').get()).toEqual({ n: 1 });
    repo.close();
  });

  test('ファイルを閉じて開き直しても内容が残る', () => {
    const path = tmpDbPath();
    const snap = makeSnapshot({ tick: 9600, resources: 30 });
    const a = new Repo(path);
    a.saveIsland(ISLAND);
    a.saveSnapshot('main', snap);
    const player = a.createPlayer({ secret: 'keep-me', displayName: 'ぽこ太', islandId: 'main', pos: { x: 3.5, y: 4.5 } });
    a.insertIslandEvents('main', [makeEvent(4, 7, 'ミズネがハッカとケンカした')]);
    a.close();

    const b = new Repo(path);
    expect(b.loadIsland('main')).toEqual(ISLAND);
    const loaded = b.loadSnapshot('main');
    expect(loaded?.tick).toBe(9600);
    expect(loaded?.resources).toEqual(snap.resources);
    expect(Array.from(loaded?.tilesDecay ?? [])).toEqual(Array.from(snap.tilesDecay));
    expect(loaded?.rngState).toEqual(snap.rngState);
    expect(b.findPlayerBySecret('keep-me')?.id).toBe(player.id);
    expect(b.findPlayerBySecret('keep-me')?.pos).toEqual({ x: 3.5, y: 4.5 });
    expect(b.recentIslandEvents('main')).toHaveLength(1);
    b.close();
  });

  test('saveSnapshot が20ms以内に終わる（資源200件・荒廃度16KB）', () => {
    const repo = new Repo(tmpDbPath());
    const snap = makeSnapshot({ resources: 200, critters: 120 });
    // 初回はステートメントのコンパイル分が乗るので、計測前に1回流す
    repo.saveSnapshot('main', snap);

    const samples: number[] = [];
    for (let i = 0; i < 20; i++) {
      const s = { ...snap, tick: 120 * (i + 1) };
      const t0 = performance.now();
      repo.saveSnapshot('main', s);
      samples.push(performance.now() - t0);
    }
    const worst = Math.max(...samples);
    const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
    console.log(`[db] saveSnapshot 資源200件+動物120体: avg ${avg.toFixed(2)}ms / worst ${worst.toFixed(2)}ms`);
    expect(worst).toBeLessThan(20);
    repo.close();
  });
});

describe('Repo（イベント）', () => {
  let repo: Repo;
  beforeEach(() => {
    repo = new Repo(':memory:');
    repo.insertIslandEvents('main', [
      makeEvent(1, 2, '古い・重要度低'),
      makeEvent(1, 8, '古い・重要度高'),
      makeEvent(5, 3, '中くらい'),
      makeEvent(10, 9, '新しい・重要度高'),
      makeEvent(10, 1, '新しい・重要度低'),
    ]);
    repo.insertIslandEvents('other', [makeEvent(10, 10, '別の島')]);
  });
  afterEach(() => {
    repo.close();
  });

  test('挿入した内容がそのまま戻る', () => {
    const all = repo.recentIslandEvents('main');
    expect(all).toHaveLength(5);
    const first = all[0];
    expect(first?.islandDay).toBe(10);
    expect(first?.islandId).toBe('main');
    expect(first?.kind).toBe('quarrel');
    expect(first?.actorId).toBe(5);
    expect(first?.targetId).toBe(6);
    expect(first?.pos).toEqual({ x: 1.5, y: 2.5 });
    expect(first?.id).toBeGreaterThan(0);
  });

  test('空配列を渡しても何も起きない', () => {
    repo.insertIslandEvents('main', []);
    expect(repo.recentIslandEvents('main')).toHaveLength(5);
  });

  test('島日・重要度・件数で絞り込める', () => {
    // 新しい順。島日とtickが同じものは後に挿入したものが先に来る（id DESC）
    expect(repo.recentIslandEvents('main', { sinceIslandDay: 5 }).map((e) => e.text)).toEqual([
      '新しい・重要度低',
      '新しい・重要度高',
      '中くらい',
    ]);
    expect(repo.recentIslandEvents('main', { minImportance: 8 }).map((e) => e.text)).toEqual([
      '新しい・重要度高',
      '古い・重要度高',
    ]);
    expect(repo.recentIslandEvents('main', { sinceIslandDay: 5, minImportance: 5 }).map((e) => e.text)).toEqual([
      '新しい・重要度高',
    ]);
    expect(repo.recentIslandEvents('main', { limit: 2 })).toHaveLength(2);
    // 島をまたがない
    expect(repo.recentIslandEvents('other')).toHaveLength(1);
  });

  test('位置や関係者のないイベントも保存できる', () => {
    repo.insertIslandEvents('main', [
      { kind: 'weather', tick: 100, islandDay: 11, text: '雨が降ってきた', importance: 2 },
    ]);
    const e = repo.recentIslandEvents('main', { sinceIslandDay: 11 })[0];
    expect(e?.text).toBe('雨が降ってきた');
    expect(e?.actorId).toBeUndefined();
    expect(e?.pos).toBeUndefined();
  });

  test('pruneOldEvents が古いものだけ消す', () => {
    // 最新が島日10。5島日ぶん残す → 島日5以下を削除
    const removed = repo.pruneOldEvents('main', 5);
    expect(removed).toBe(3);
    expect(repo.recentIslandEvents('main').map((e) => e.islandDay)).toEqual([10, 10]);
    // 他の島は消さない
    expect(repo.recentIslandEvents('other')).toHaveLength(1);
    // 2回目は消すものがない
    expect(repo.pruneOldEvents('main', 5)).toBe(0);
    // イベントが無い島では0
    expect(repo.pruneOldEvents('empty', 5)).toBe(0);
  });
});
