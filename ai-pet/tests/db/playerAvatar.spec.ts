/**
 * プレイヤーのアバター4色（D-5）のサーバ側テスト。
 *
 * 見るのは3つ:
 *  1. **既存DB（avatar列なし）を開いても壊れない**（ALTER が冪等に流れる）
 *  2. 色が再接続・DB再オープンをまたいで変わらない（`Actor.species` に入る値の出どころはDB）
 *  3. 指定が無いときの割り振りが**決定論**（`Math.random` を使っていない）
 */
import { afterAll, describe, expect, test } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Repo } from '../../packages/server/src/db/repo.ts';
import {
  PLAYER_AVATARS,
  avatarFromPlayerId,
  createPlayerActor,
  normalizeAvatar,
} from '../../packages/server/src/sim/actors.ts';
import { IslandWorld } from '../../packages/server/src/sim/world.ts';
import { Rng } from '@ai-pet/shared';

const TMP_ROOT = join(import.meta.dirname, '../../.tmp');
const tmpDirs: string[] = [];

function tmpDbPath(): string {
  mkdirSync(TMP_ROOT, { recursive: true });
  const dir = mkdtempSync(join(TMP_ROOT, 'avatar-test-'));
  tmpDirs.push(dir);
  return join(dir, 'island.db');
}

afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * D-5より前のスキーマ（avatar列なし）の player テーブルを持つDBを作る。
 * `schema.sql` は CREATE TABLE IF NOT EXISTS なので、
 * これを Repo で開いても**列は増えない**——増やすのは `Repo.migrate()` の役目。
 */
function makeLegacyDb(path: string, playerIds: string[]): void {
  const db = new Database(path);
  db.exec(`CREATE TABLE player (
    id TEXT PRIMARY KEY,
    secret_hash TEXT NOT NULL,
    display_name TEXT NOT NULL,
    island_id TEXT NOT NULL,
    last_pos_x REAL NOT NULL,
    last_pos_y REAL NOT NULL,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    last_seen_island_day INTEGER NOT NULL DEFAULT 1
  )`);
  const ins = db.prepare(
    `INSERT INTO player (id, secret_hash, display_name, island_id, last_pos_x, last_pos_y, created_at, last_seen_at)
     VALUES (?, ?, ?, 'main', 64, 64, 1, 1)`,
  );
  for (const id of playerIds) ins.run(id, `hash-${id}`, `旧${id}`);
  db.close();
}

function columnNames(path: string): string[] {
  const db = new Database(path, { readonly: true });
  const cols = db.prepare('PRAGMA table_info(player)').all() as { name: string }[];
  db.close();
  return cols.map((c) => c.name);
}

describe('avatar 列のマイグレーション', () => {
  test('既存DB（avatar列なし）を開いても壊れず、列が足される', () => {
    const path = tmpDbPath();
    makeLegacyDb(path, ['legacy-1', 'legacy-2']);
    expect(columnNames(path)).not.toContain('avatar');

    const repo = new Repo(path);
    repo.close();

    expect(columnNames(path)).toContain('avatar');
  });

  test('何度開いても落ちない（ALTER が冪等）', () => {
    const path = tmpDbPath();
    makeLegacyDb(path, ['legacy-1']);
    for (let i = 0; i < 3; i++) {
      const repo = new Repo(path);
      repo.close();
    }
    const repo = new Repo(path);
    const p = repo.findPlayerById('legacy-1');
    repo.close();
    expect(p?.avatar).toBe(avatarFromPlayerId('legacy-1'));
  });

  test('既存プレイヤーは playerId のハッシュで振り直される（全員 a のままにしない）', () => {
    const path = tmpDbPath();
    // 4色に散ることを見たいので、ハッシュ結果が全色そろうIDを選ぶ
    const ids = ['legacy-a', 'legacy-b', 'legacy-c', 'legacy-d', 'legacy-e', 'legacy-f', 'legacy-g', 'legacy-h'];
    makeLegacyDb(path, ids);
    const repo = new Repo(path);
    const got = ids.map((id) => repo.findPlayerById(id)?.avatar);
    repo.close();
    for (const [i, id] of ids.entries()) expect(got[i]).toBe(avatarFromPlayerId(id));
    // 少なくとも2色以上に分かれている（全員同じ見た目のままではない）
    expect(new Set(got).size).toBeGreaterThan(1);
  });

  test('マイグレーション後の既存プレイヤーは更新できる', () => {
    const path = tmpDbPath();
    makeLegacyDb(path, ['legacy-1']);
    const repo = new Repo(path);
    repo.updatePlayer('legacy-1', { avatar: 'c' });
    expect(repo.findPlayerById('legacy-1')?.avatar).toBe('c');
    repo.close();
  });
});

describe('avatar の保存と復元', () => {
  test('新規プレイヤーには決定論的に色が付く', () => {
    const repo = new Repo(':memory:');
    const p = repo.createPlayer({
      secret: 'secret-x',
      displayName: 'ためし',
      islandId: 'main',
      pos: { x: 64, y: 64 },
    });
    expect(p.avatar).toBe(avatarFromPlayerId(p.id));
    expect(PLAYER_AVATARS).toContain(p.avatar);
    repo.close();
  });

  test('指定した色がそのまま入る', () => {
    const repo = new Repo(':memory:');
    const p = repo.createPlayer({
      secret: 'secret-y',
      displayName: 'ためし',
      islandId: 'main',
      pos: { x: 64, y: 64 },
      avatar: 'd',
    });
    expect(p.avatar).toBe('d');
    expect(repo.findPlayerBySecret('secret-y')?.avatar).toBe('d');
    repo.close();
  });

  test('DBを閉じ直しても（=サーバ再起動・再接続をまたいでも）色は変わらない', () => {
    const path = tmpDbPath();
    const first = new Repo(path);
    const p = first.createPlayer({
      secret: 'secret-z',
      displayName: 'ためし',
      islandId: 'main',
      pos: { x: 64, y: 64 },
    });
    first.updatePlayer(p.id, { avatar: 'b' });
    first.close();

    const second = new Repo(path);
    expect(second.findPlayerBySecret('secret-z')?.avatar).toBe('b');
    expect(second.findPlayerById(p.id)?.avatar).toBe('b');
    second.close();
  });

  test('不正な色はDBに入れない（a に寄せる）', () => {
    const repo = new Repo(':memory:');
    const p = repo.createPlayer({
      secret: 'secret-w',
      displayName: 'ためし',
      islandId: 'main',
      pos: { x: 64, y: 64 },
      avatar: 'zzz',
    });
    expect(p.avatar).toBe('a');
    repo.updatePlayer(p.id, { avatar: 'player_a' });
    expect(repo.findPlayerById(p.id)?.avatar).toBe('a');
    repo.close();
  });
});

describe('未指定のときのフォールバック', () => {
  test('同じ playerId なら何度呼んでも同じ色', () => {
    for (const id of ['abc', 'あいう', '3f2a1c9e-0000-4000-8000-000000000000']) {
      const first = avatarFromPlayerId(id);
      for (let i = 0; i < 5; i++) expect(avatarFromPlayerId(id)).toBe(first);
    }
  });

  test('4色すべてが現れる（ハッシュが偏っていない）', () => {
    const got = new Set<string>();
    for (let i = 0; i < 200; i++) got.add(avatarFromPlayerId(`player-${i}`));
    expect([...got].sort()).toEqual([...PLAYER_AVATARS]);
  });

  test('normalizeAvatar は未知の値・空・undefined を a にする', () => {
    expect(normalizeAvatar(undefined)).toBe('a');
    expect(normalizeAvatar(null)).toBe('a');
    expect(normalizeAvatar('')).toBe('a');
    expect(normalizeAvatar('e')).toBe('a');
    expect(normalizeAvatar('player_a')).toBe('a');
    expect(normalizeAvatar('A')).toBe('a');
    for (const v of PLAYER_AVATARS) expect(normalizeAvatar(v)).toBe(v);
  });
});

describe('プレイヤーアクターの species', () => {
  const world = new IslandWorld(new Rng('avatar-species'));

  test('avatar がそのまま species に入る（アセット名は描画側が組む）', () => {
    for (const v of PLAYER_AVATARS) {
      const a = createPlayerActor(world, { name: 'ためし', avatar: v });
      expect(a.species).toBe(v);
    }
  });

  test('未指定・不正なら a にフォールバックする', () => {
    expect(createPlayerActor(world, { name: 'ためし' }).species).toBe('a');
    expect(createPlayerActor(world, { name: 'ためし', avatar: 'x' }).species).toBe('a');
  });
});
