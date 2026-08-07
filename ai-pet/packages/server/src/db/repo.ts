/**
 * SQLite 永続化レイヤ（docs/02_ゲーム実装プラン/03_データモデル.md §3-§4）
 *
 * 原則:
 * - メモリ上の構造体が「正」。ここは保存と復元だけを担う（ゲームロジックを持たない）
 * - 高頻度更新値（位置・欲求）は毎tick書かない。30秒ごとのスナップショットでまとめて保存する
 * - better-sqlite3 は同期API。1回の保存が1tick（250ms）を食い潰さないよう
 *   スナップショットは1トランザクションにまとめる（実測 1ms未満）
 *
 * 制約:
 * - parameter property 禁止（Node の type-stripping で動かすため）
 * - enum / namespace 禁止
 * - 相対importは拡張子込み。schema.sql は import せず node:fs で読む
 */
import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  MAP_H,
  MAP_W,
  type Actor,
  type IslandEvent,
  type IslandEventKind,
  type Construction,
  type Placeable,
  type ResourceNode,
  type Season,
  type Vec2,
  type Weather,
} from '@ai-pet/shared';

/** 荒廃度BLOBの正しい長さ */
export const TILES_DECAY_BYTES = MAP_W * MAP_H;

export interface PlayerRecord {
  id: string;
  secretHash: string;
  displayName: string;
  islandId: string;
  pos: Vec2;
  createdAt: number;
  lastSeenAt: number;
  /** 前回いた島日（留守中サマリの起点） */
  lastSeenIslandDay: number;
}

export interface IslandStateRecord {
  id: string;
  seed: string;
  tick: number;
  islandDay: number;
  season: Season;
  weather: Weather;
  lastWeatherRollTick: number;
  /** unix ms（catch-up判定に使う） */
  updatedAt: number;
}

export interface SnapshotData {
  tick: number;
  /** JSONで保存する（M3で動物が入る。M2では空配列） */
  critters: Actor[];
  resources: ResourceNode[];
  placeables: Placeable[];
  /** 128*128 の荒廃度。BLOBで保存する */
  tilesDecay: Uint8Array;
  /** 復元時にID採番を続けるため */
  nextEntityId: number;
  /** RNGの状態（決定論の継続に必要） */
  rngState: [number, number, number, number];
  /** 共同建設（進捗と貢献者）。地形の張り直しは BuildSystem.restore が行う */
  constructions: Construction[];
}

/** island_event の1行。IslandEvent に採番されたidと島IDが付く */
/** 好感度の1ペア。relation.ts の RelationEntry と同じ形 */
export interface RelationRow {
  a: number;
  b: number;
  score: number;
  metCount: number;
}

export interface IslandEventRecord extends IslandEvent {
  id: number;
  islandId: string;
}

/**
 * secret のハッシュ方式。
 *
 * scryptSync ではなく sha256 + 固定ペッパーを選んだ理由:
 *  1. secret はクライアントが生成する高エントロピーのランダム文字列（人間のパスワードではない）。
 *     辞書攻撃の対象にならないため、鍵導出関数のコスト（数十〜百ms）を払う意味がない。
 *  2. `hello` のたびに secret から引き当てる必要があり、**決定論的なハッシュでないと検索できない**。
 *     scrypt はランダムsaltを行ごとに持つ設計なので、全行スキャンが必要になってしまう。
 *  3. それでも平文は保存しない（DBファイルが漏れても他人になりすませないようにする）。
 *     ペッパーはコード内の固定値。DBだけ漏れたケースを想定した対策なのでこれで足りる。
 */
const SECRET_PEPPER = 'pokomofu-island/v1';

export function hashSecret(secret: string): string {
  return createHash('sha256').update(SECRET_PEPPER).update(secret).digest('hex');
}

// ---------- DBの行の形（snake_case のまま受け取る） ----------
interface IslandRow {
  id: string;
  seed: string;
  tick: number;
  island_day: number;
  season: string;
  weather: string;
  last_weather_roll_tick: number;
  updated_at: number;
}

interface SnapshotRow {
  tick: number;
  critters_json: string;
  resources_json: string;
  placeables_json: string;
  tiles_decay: Buffer;
  next_entity_id: number;
  rng_state_json: string;
  constructions_json: string;
}

interface PlayerRow {
  id: string;
  secret_hash: string;
  display_name: string;
  island_id: string;
  last_pos_x: number;
  last_pos_y: number;
  created_at: number;
  last_seen_at: number;
  last_seen_island_day: number;
}

interface EventRow {
  id: number;
  island_id: string;
  tick: number;
  island_day: number;
  kind: string;
  actor_id: number | null;
  target_id: number | null;
  pos_x: number | null;
  pos_y: number | null;
  text: string;
  importance: number;
}

function toPlayer(row: PlayerRow): PlayerRecord {
  return {
    id: row.id,
    secretHash: row.secret_hash,
    displayName: row.display_name,
    islandId: row.island_id,
    pos: { x: row.last_pos_x, y: row.last_pos_y },
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    lastSeenIslandDay: row.last_seen_island_day ?? 1,
  };
}

function toEvent(row: EventRow): IslandEventRecord {
  const rec: IslandEventRecord = {
    id: row.id,
    islandId: row.island_id,
    kind: row.kind as IslandEventKind,
    tick: row.tick,
    islandDay: row.island_day,
    text: row.text,
    importance: row.importance,
  };
  if (row.actor_id !== null) rec.actorId = row.actor_id;
  if (row.target_id !== null) rec.targetId = row.target_id;
  if (row.pos_x !== null && row.pos_y !== null) rec.pos = { x: row.pos_x, y: row.pos_y };
  return rec;
}

/** 4要素のRNG状態へ。壊れていたらゼロ状態（呼び出し側がseedから作り直す） */
function toRngState(json: string): [number, number, number, number] {
  try {
    const v = JSON.parse(json) as unknown;
    if (Array.isArray(v) && v.length === 4 && v.every((n) => typeof n === 'number')) {
      return [v[0] as number, v[1] as number, v[2] as number, v[3] as number];
    }
  } catch {
    // 壊れたJSONは無視してゼロ状態を返す
  }
  return [0, 0, 0, 0];
}

/** 共同建設の復元。壊れたJSONは空配列（橋が水に戻るだけで破綻はしない） */
function parseConstructions(json: string | null | undefined): Construction[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? (v as Construction[]) : [];
  } catch {
    return [];
  }
}

export class Repo {
  readonly db: Database.Database;
  readonly path: string;

  /** dbPath が ':memory:' ならインメモリ。ディレクトリは自動作成する */
  constructor(dbPath: string) {
    this.path = dbPath;
    if (dbPath !== ':memory:' && !dbPath.startsWith('file:')) {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    // 設計書どおり: 書き込みと読み込みを並行させ、fsyncを最小限にする
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    // schema.sql は import できない（.sql）ので fs で読む
    this.db.exec(readFileSync(join(import.meta.dirname, 'schema.sql'), 'utf8'));
    this.migrate();
  }

  /**
   * 既存DBに後から足したカラムを補う。
   * スキーマは CREATE TABLE IF NOT EXISTS なので、既にあるテーブルには列が増えない。
   */
  private migrate(): void {
    const cols = this.db.prepare('PRAGMA table_info(player)').all() as { name: string }[];
    if (!cols.some((c) => c.name === 'last_seen_island_day')) {
      this.db.exec('ALTER TABLE player ADD COLUMN last_seen_island_day INTEGER NOT NULL DEFAULT 1');
    }
    const snapCols = this.db.prepare('PRAGMA table_info(island_snapshot)').all() as { name: string }[];
    if (snapCols.length > 0 && !snapCols.some((c) => c.name === 'constructions_json')) {
      this.db.exec("ALTER TABLE island_snapshot ADD COLUMN constructions_json TEXT NOT NULL DEFAULT '[]'");
    }
  }

  close(): void {
    // WALをDBファイルへ畳んでから閉じる（graceful shutdown の最後の一手）
    try {
      this.db.pragma('wal_checkpoint(TRUNCATE)');
    } catch {
      // インメモリDBなどWAL非対応でも閉じる処理は続ける
    }
    this.db.close();
  }

  // ---------- 島の状態 ----------

  loadIsland(islandId: string): IslandStateRecord | null {
    const row = this.db.prepare('SELECT * FROM island WHERE id = ?').get(islandId) as IslandRow | undefined;
    if (!row) return null;
    return {
      id: row.id,
      seed: row.seed,
      tick: row.tick,
      islandDay: row.island_day,
      season: row.season as Season,
      weather: row.weather as Weather,
      lastWeatherRollTick: row.last_weather_roll_tick,
      updatedAt: row.updated_at,
    };
  }

  saveIsland(rec: IslandStateRecord): void {
    this.db
      .prepare(
        `INSERT INTO island (id, seed, tick, island_day, season, weather, last_weather_roll_tick, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           seed = excluded.seed,
           tick = excluded.tick,
           island_day = excluded.island_day,
           season = excluded.season,
           weather = excluded.weather,
           last_weather_roll_tick = excluded.last_weather_roll_tick,
           updated_at = excluded.updated_at`,
      )
      .run(
        rec.id,
        rec.seed,
        rec.tick,
        rec.islandDay,
        rec.season,
        rec.weather,
        rec.lastWeatherRollTick,
        rec.updatedAt,
      );
  }

  /** 資源・設置物・荒廃度・アクター（動物）をまとめて保存。1トランザクション */
  saveSnapshot(islandId: string, snap: SnapshotData): void {
    if (snap.tilesDecay.length !== TILES_DECAY_BYTES) {
      throw new Error(`saveSnapshot: tilesDecay の長さが ${TILES_DECAY_BYTES} ではない (${snap.tilesDecay.length})`);
    }
    const stmt = this.db.prepare(
      `INSERT INTO island_snapshot
         (island_id, tick, critters_json, resources_json, placeables_json, tiles_decay,
          next_entity_id, rng_state_json, constructions_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(island_id) DO UPDATE SET
         tick = excluded.tick,
         critters_json = excluded.critters_json,
         resources_json = excluded.resources_json,
         placeables_json = excluded.placeables_json,
         tiles_decay = excluded.tiles_decay,
         next_entity_id = excluded.next_entity_id,
         rng_state_json = excluded.rng_state_json,
         constructions_json = excluded.constructions_json`,
    );
    // 1島＝1行の上書きだが、将来ペット・関係性の保存を同じ契機に足すため
    // 最初からトランザクションで包んでおく（中断で half-written にならない）
    const tx = this.db.transaction((s: SnapshotData) => {
      stmt.run(
        islandId,
        s.tick,
        JSON.stringify(s.critters),
        JSON.stringify(s.resources),
        JSON.stringify(s.placeables),
        Buffer.from(s.tilesDecay),
        s.nextEntityId,
        JSON.stringify(s.rngState),
        JSON.stringify(s.constructions),
      );
    });
    tx(snap);
  }

  loadSnapshot(islandId: string): SnapshotData | null {
    const row = this.db.prepare('SELECT * FROM island_snapshot WHERE island_id = ?').get(islandId) as
      | SnapshotRow
      | undefined;
    if (!row) return null;
    return {
      tick: row.tick,
      critters: JSON.parse(row.critters_json) as Actor[],
      resources: JSON.parse(row.resources_json) as ResourceNode[],
      placeables: JSON.parse(row.placeables_json) as Placeable[],
      // Buffer は Uint8Array のサブクラスだが、DBのバッファを握り続けないようコピーして返す
      tilesDecay: new Uint8Array(row.tiles_decay),
      nextEntityId: row.next_entity_id,
      rngState: toRngState(row.rng_state_json),
      constructions: parseConstructions(row.constructions_json),
    };
  }

  // ---------- プレイヤー ----------

  /** secret（平文）からプレイヤーを引く。無ければ null */
  findPlayerBySecret(secret: string): PlayerRecord | null {
    const row = this.db.prepare('SELECT * FROM player WHERE secret_hash = ?').get(hashSecret(secret)) as
      | PlayerRow
      | undefined;
    return row ? toPlayer(row) : null;
  }

  findPlayerById(id: string): PlayerRecord | null {
    const row = this.db.prepare('SELECT * FROM player WHERE id = ?').get(id) as PlayerRow | undefined;
    return row ? toPlayer(row) : null;
  }

  /** 新規作成。secretは平文で受け取り、ハッシュして保存する */
  createPlayer(opts: { secret: string; displayName: string; islandId: string; pos: Vec2 }): PlayerRecord {
    const now = Date.now();
    const rec: PlayerRecord = {
      id: randomUUID(),
      secretHash: hashSecret(opts.secret),
      displayName: opts.displayName,
      islandId: opts.islandId,
      pos: { x: opts.pos.x, y: opts.pos.y },
      createdAt: now,
      lastSeenAt: now,
      lastSeenIslandDay: 1,
    };
    this.db
      .prepare(
        `INSERT INTO player
           (id, secret_hash, display_name, island_id, last_pos_x, last_pos_y, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        rec.id,
        rec.secretHash,
        rec.displayName,
        rec.islandId,
        rec.pos.x,
        rec.pos.y,
        rec.createdAt,
        rec.lastSeenAt,
      );
    return rec;
  }

  updatePlayer(
    id: string,
    patch: { displayName?: string; pos?: Vec2; lastSeenAt?: number; lastSeenIslandDay?: number },
  ): void {
    const sets: string[] = [];
    const args: (string | number)[] = [];
    if (patch.displayName !== undefined) {
      sets.push('display_name = ?');
      args.push(patch.displayName);
    }
    if (patch.pos !== undefined) {
      sets.push('last_pos_x = ?', 'last_pos_y = ?');
      args.push(patch.pos.x, patch.pos.y);
    }
    if (patch.lastSeenAt !== undefined) {
      sets.push('last_seen_at = ?');
      args.push(patch.lastSeenAt);
    }
    if (patch.lastSeenIslandDay !== undefined) {
      sets.push('last_seen_island_day = ?');
      args.push(patch.lastSeenIslandDay);
    }
    if (sets.length === 0) return;
    args.push(id);
    this.db.prepare(`UPDATE player SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  }

  countPlayers(islandId: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM player WHERE island_id = ?').get(islandId) as
      | { n: number }
      | undefined;
    return row?.n ?? 0;
  }

  // ---------- イベント（M3/M4で使う） ----------

  /** 発生時に即書き込み（1回の flush ぶんを1トランザクションで） */
  insertIslandEvents(islandId: string, events: IslandEvent[]): void {
    if (events.length === 0) return;
    const stmt = this.db.prepare(
      `INSERT INTO island_event (island_id, tick, island_day, kind, actor_id, target_id, pos_x, pos_y, text, importance)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const tx = this.db.transaction((list: IslandEvent[]) => {
      for (const e of list) {
        stmt.run(
          islandId,
          e.tick,
          e.islandDay,
          e.kind,
          e.actorId ?? null,
          e.targetId ?? null,
          e.pos?.x ?? null,
          e.pos?.y ?? null,
          e.text,
          e.importance,
        );
      }
    });
    tx(events);
  }

  /** 新しい順。sinceIslandDay は「その島日以降」（境界を含む） */
  recentIslandEvents(
    islandId: string,
    opts: { sinceIslandDay?: number; minImportance?: number; limit?: number } = {},
  ): IslandEventRecord[] {
    const where: string[] = ['island_id = ?'];
    const args: (string | number)[] = [islandId];
    if (opts.sinceIslandDay !== undefined) {
      where.push('island_day >= ?');
      args.push(opts.sinceIslandDay);
    }
    if (opts.minImportance !== undefined) {
      where.push('importance >= ?');
      args.push(opts.minImportance);
    }
    const limit = opts.limit ?? 100;
    args.push(limit);
    const rows = this.db
      .prepare(
        `SELECT * FROM island_event WHERE ${where.join(' AND ')}
         ORDER BY island_day DESC, tick DESC, id DESC LIMIT ?`,
      )
      .all(...args) as EventRow[];
    return rows.map(toEvent);
  }

  /**
   * 直近 keepIslandDays 島日ぶんだけ残して古いイベントを削除する。削除件数を返す。
   * 基準は「その島に記録されている最新の島日」なので、島が止まっていた分は消えない。
   */
  pruneOldEvents(islandId: string, keepIslandDays: number): number {
    const row = this.db.prepare('SELECT MAX(island_day) AS d FROM island_event WHERE island_id = ?').get(islandId) as
      | { d: number | null }
      | undefined;
    const latest = row?.d ?? null;
    if (latest === null) return 0;
    const cutoff = latest - keepIslandDays;
    const res = this.db
      .prepare('DELETE FROM island_event WHERE island_id = ? AND island_day <= ?')
      .run(islandId, cutoff);
    return res.changes;
  }

  // --- LLM使用量 ---
  // コスト監視の唯一の手がかりなので、成功・失敗どちらも残す（docs 07章§7）。

  insertLlmUsage(row: {
    ts: number;
    playerId?: string | null;
    purpose: string;
    promptTokens: number;
    completionTokens: number;
    latencyMs: number;
    ok: boolean;
  }): void {
    this.db
      .prepare(
        `INSERT INTO llm_usage (ts, player_id, purpose, prompt_tokens, completion_tokens, latency_ms, ok)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.ts,
        row.playerId ?? null,
        row.purpose,
        Math.round(row.promptTokens),
        Math.round(row.completionTokens),
        Math.round(row.latencyMs),
        row.ok ? 1 : 0,
      );
  }

  /** 直近 hours 時間の使用量サマリ（/metrics とコスト確認用） */
  llmUsageSummary(hours = 1): {
    total: number;
    ok: number;
    promptTokens: number;
    completionTokens: number;
    byPurpose: Record<string, number>;
  } {
    const since = Date.now() - hours * 3600_000;
    const rows = this.db
      .prepare(
        `SELECT purpose, SUM(prompt_tokens) AS p, SUM(completion_tokens) AS c,
                COUNT(*) AS n, SUM(ok) AS okn
         FROM llm_usage WHERE ts >= ? GROUP BY purpose`,
      )
      .all(since) as { purpose: string; p: number | null; c: number | null; n: number; okn: number | null }[];

    const out = { total: 0, ok: 0, promptTokens: 0, completionTokens: 0, byPurpose: {} as Record<string, number> };
    for (const r of rows) {
      out.total += r.n;
      out.ok += r.okn ?? 0;
      out.promptTokens += r.p ?? 0;
      out.completionTokens += r.c ?? 0;
      out.byPurpose[r.purpose] = r.n;
    }
    return out;
  }

  // --- 好感度 ---
  // 動物同士の仲は「島が続いている」実感の中心なので、再起動で失わせない。
  // 件数は 1個体あたり RELATION.maxRelationsPerActor で上限があるため全置換で足りる。

  saveRelations(rows: readonly RelationRow[]): void {
    const del = this.db.prepare('DELETE FROM relation');
    const ins = this.db.prepare('INSERT INTO relation (a_id, b_id, score, met_count) VALUES (?, ?, ?, ?)');
    const tx = this.db.transaction((list: readonly RelationRow[]) => {
      del.run();
      for (const r of list) ins.run(r.a, r.b, r.score, r.metCount);
    });
    tx(rows);
  }

  loadRelations(): RelationRow[] {
    const rows = this.db.prepare('SELECT a_id, b_id, score, met_count FROM relation').all() as {
      a_id: number;
      b_id: number;
      score: number;
      met_count: number;
    }[];
    return rows.map((r) => ({ a: r.a_id, b: r.b_id, score: r.score, metCount: r.met_count }));
  }
}
