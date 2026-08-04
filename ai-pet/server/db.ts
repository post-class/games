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
  return db;
}

let shared: Db | null = null;

export function db(): Db {
  if (!shared) shared = openDb();
  return shared;
}
