import Database from 'better-sqlite3';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from './env.js';

const here = dirname(fileURLToPath(import.meta.url));

export type Db = Database.Database;

/**
 * DB を開いてスキーマを適用する。
 * `:memory:` を渡せるようにしてテストから同じコードパスを使えるようにしている。
 */
export function openDb(path: string = env.dbPath): Db {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path);
  const schema = readFileSync(resolve(here, 'schema.sql'), 'utf8');
  db.exec(schema);
  migrate(db);
  return db;
}

/**
 * 既存の DB に後から足した列を補う。
 * `CREATE TABLE IF NOT EXISTS` では列の追加が反映されないため、
 * 育成中のデータを消さずに更新できるようにしている。
 */
function migrate(db: Db): void {
  const columns = (table: string): Set<string> =>
    new Set(
      (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
        (row) => row.name,
      ),
    );

  const petColumns = columns('pets');
  // プレイヤーがお祝いを見た段階。stage と食い違っている間だけお祝いを出す。
  if (!petColumns.has('ack_stage')) {
    db.exec("ALTER TABLE pets ADD COLUMN ack_stage TEXT NOT NULL DEFAULT 'egg'");
  }
  // ミニゲームの累計成績（プロフィール表示用）。
  if (!petColumns.has('game_plays')) {
    db.exec('ALTER TABLE pets ADD COLUMN game_plays INTEGER NOT NULL DEFAULT 0');
  }
  if (!petColumns.has('game_hits')) {
    db.exec('ALTER TABLE pets ADD COLUMN game_hits INTEGER NOT NULL DEFAULT 0');
  }
}

let shared: Db | null = null;

export function db(): Db {
  if (!shared) shared = openDb();
  return shared;
}
