/**
 * ペット・記憶・会話ログの永続化（docs/02_ゲーム実装プラン/03_データモデル.md §3 / 07章 §3）
 *
 * `Repo`（db/repo.ts）とは分けている:
 *  - `Repo` は「島の物理」（島・スナップショット・プレイヤー・出来事）を持つ
 *  - こちらは「ペットの心」（ペルソナ・記憶・会話）を持つ
 * スキーマ適用は `Repo` のコンストラクタが済ませているので、こちらは `db` を借りるだけにして
 * schema.sql を二重に流さない（`Repo` を編集せずに機能を足せる形）。
 *
 * 方針:
 *  - 記憶は**全件返さない**。1匹あたり数千件まで育つので、検索対象を絞ってから
 *    `pet/memory.ts` の `selectMemories` に渡す（LLMに載るのは8件）。
 *  - 高頻度更新値は持たない（位置・欲求は island_snapshot 側）。
 *
 * 制約: parameter property 禁止 / enum・namespace 禁止 / 相対importは拡張子込み
 */
import type Database from 'better-sqlite3';
import { LLM, type PetPersona, type Traits } from '@ai-pet/shared';
import type { MemoryKind, MemoryRecord } from '../pet/memory.ts';

export interface PetRow {
  id: number;
  playerId: string;
  persona: PetPersona;
  traits: Traits;
  affection: number;
  summary: string;
  createdAt: number;
}

interface PetDbRow {
  id: number;
  player_id: string;
  species: string;
  name: string;
  persona_json: string;
  traits_json: string;
  affection: number;
  summary: string;
  created_at: number;
}

interface MemoryDbRow {
  id: number;
  pet_id: number;
  tick: number;
  island_day: number;
  kind: string;
  text: string;
  keywords: string;
  importance: number;
  last_access_tick: number;
}

interface ChatDbRow {
  speaker_id: string;
  text: string;
}

/** 検索対象として一度に取り出す既定の件数。ここを超えて古い記憶は「思い出せない」扱いになる */
export const DEFAULT_MEMORY_FETCH = 200;

function toPet(row: PetDbRow): PetRow {
  return {
    id: row.id,
    playerId: row.player_id,
    persona: JSON.parse(row.persona_json) as PetPersona,
    traits: JSON.parse(row.traits_json) as Traits,
    affection: row.affection,
    summary: row.summary,
    createdAt: row.created_at,
  };
}

function toMemory(row: MemoryDbRow): MemoryRecord {
  return {
    id: row.id,
    petId: row.pet_id,
    tick: row.tick,
    islandDay: row.island_day,
    kind: row.kind as MemoryKind,
    text: row.text,
    // keywords は空白区切りで保存する（schema.sql のコメントどおり）
    keywords: row.keywords.length > 0 ? row.keywords.split(' ').filter((w) => w.length > 0) : [],
    importance: row.importance,
    lastAccessTick: row.last_access_tick,
  };
}

export class PetRepo {
  readonly db: Database.Database;
  /** prepare のコストを払い直さないための記憶。SQL文字列をキーにする */
  private stmts: Map<string, Database.Statement>;

  /** `Repo` の `db` をそのまま受け取る（スキーマ適用済みであること） */
  constructor(db: Database.Database) {
    this.db = db;
    this.stmts = new Map();
  }

  private stmt(sql: string): Database.Statement {
    const hit = this.stmts.get(sql);
    if (hit) return hit;
    const s = this.db.prepare(sql);
    this.stmts.set(sql, s);
    return s;
  }

  // ---------- ペット ----------

  /**
   * ペットを作る。`entityId` はシミュレーション側のアクターIDをそのまま主キーにする
   * （記憶やイベントの actor_id と突き合わせられるようにするため）。
   *
   * 1プレイヤー1匹は schema.sql の `player_id ... UNIQUE` が保証する。
   * 2匹目を作ろうとすると better-sqlite3 が例外を投げる（呼び出し側で既存を返すこと）。
   */
  createPet(opts: { playerId: string; persona: PetPersona; traits: Traits; entityId: number }): PetRow {
    const now = Date.now();
    this.stmt(
      `INSERT INTO pet (id, player_id, species, name, persona_json, traits_json, affection, summary, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      opts.entityId,
      opts.playerId,
      opts.persona.species,
      opts.persona.name,
      JSON.stringify(opts.persona),
      JSON.stringify(opts.traits),
      // 既定の懐き度は schema.sql の DEFAULT 30 に合わせる（「すこし慣れてきた」の入口）
      30,
      '',
      now,
    );
    return {
      id: opts.entityId,
      playerId: opts.playerId,
      persona: opts.persona,
      traits: opts.traits,
      affection: 30,
      summary: '',
      createdAt: now,
    };
  }

  findPetByPlayer(playerId: string): PetRow | null {
    const row = this.stmt('SELECT * FROM pet WHERE player_id = ?').get(playerId) as PetDbRow | undefined;
    return row ? toPet(row) : null;
  }

  findPetById(id: number): PetRow | null {
    const row = this.stmt('SELECT * FROM pet WHERE id = ?').get(id) as PetDbRow | undefined;
    return row ? toPet(row) : null;
  }

  /** 懐き度と長期記憶だけを更新する。summary は 400字（LLM.maxSummaryChars）で切る */
  updatePet(id: number, patch: { affection?: number; summary?: string }): void {
    const sets: string[] = [];
    const args: (string | number)[] = [];
    if (patch.affection !== undefined) {
      sets.push('affection = ?');
      args.push(Math.max(0, Math.min(100, patch.affection)));
    }
    if (patch.summary !== undefined) {
      sets.push('summary = ?');
      args.push(patch.summary.slice(0, LLM.maxSummaryChars));
    }
    if (sets.length === 0) return;
    args.push(id);
    this.stmt(`UPDATE pet SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  }

  // ---------- 記憶 ----------

  /** 1tickぶんをまとめて。1トランザクションで書く（half-written を作らない） */
  /**
   * 島にいるすべてのペットのID（接続していないぶんも含む）。
   * 日記は「留守中も島の時間が進んでいる」ことを支える機能なので、不在ペットにも書く。
   */
  allPetIds(): number[] {
    const rows = this.stmt('SELECT id FROM pet ORDER BY id').all() as { id: number }[];
    return rows.map((r) => r.id);
  }

  insertMemories(rows: readonly MemoryRecord[]): void {
    if (rows.length === 0) return;
    const ins = this.stmt(
      `INSERT INTO pet_memory (pet_id, tick, island_day, kind, text, keywords, importance, last_access_tick)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const tx = this.db.transaction((list: readonly MemoryRecord[]) => {
      for (const m of list) {
        ins.run(
          m.petId,
          m.tick,
          m.islandDay,
          m.kind,
          m.text,
          m.keywords.join(' '),
          m.importance,
          m.lastAccessTick,
        );
      }
    });
    tx(rows);
  }

  /**
   * 検索対象を絞って取る（新しい順）。全件は返さない。
   * 「新しい順に200件」だけを候補にしても、日記（kind='diary'）を別に取れば
   * 古い大事な記憶は日記経由で残る（docs §3.4 の狙い）。
   */
  recentMemories(petId: number, opts?: { limit?: number; kinds?: readonly string[] }): MemoryRecord[] {
    const limit = Math.max(1, opts?.limit ?? DEFAULT_MEMORY_FETCH);
    const kinds = opts?.kinds;
    if (kinds && kinds.length > 0) {
      const holes = kinds.map(() => '?').join(', ');
      const rows = this.stmt(
        `SELECT * FROM pet_memory WHERE pet_id = ? AND kind IN (${holes})
         ORDER BY tick DESC, id DESC LIMIT ?`,
      ).all(petId, ...kinds, limit) as MemoryDbRow[];
      return rows.map(toMemory);
    }
    const rows = this.stmt(
      'SELECT * FROM pet_memory WHERE pet_id = ? ORDER BY tick DESC, id DESC LIMIT ?',
    ).all(petId, limit) as MemoryDbRow[];
    return rows.map(toMemory);
  }

  /** その島日ぶん（古い順）。日記の材料に使う */
  memoriesOfDay(petId: number, islandDay: number): MemoryRecord[] {
    const rows = this.stmt(
      'SELECT * FROM pet_memory WHERE pet_id = ? AND island_day = ? ORDER BY tick ASC, id ASC',
    ).all(petId, islandDay) as MemoryDbRow[];
    return rows.map(toMemory);
  }

  /**
   * 参照された記憶に印をつける。
   * `last_access_tick` はいまスコアに入れていないが、
   * 「使われていない記憶を先に捨てる」剪定をあとで入れるために記録しておく。
   */
  touchMemories(ids: readonly number[], tick: number): void {
    if (ids.length === 0) return;
    const upd = this.stmt('UPDATE pet_memory SET last_access_tick = ? WHERE id = ?');
    const tx = this.db.transaction((list: readonly number[]) => {
      for (const id of list) upd.run(tick, id);
    });
    tx(ids);
  }

  /** 記憶の件数（テストと /metrics 用） */
  countMemories(petId: number): number {
    const row = this.stmt('SELECT COUNT(*) AS n FROM pet_memory WHERE pet_id = ?').get(petId) as
      | { n: number }
      | undefined;
    return row?.n ?? 0;
  }

  /**
   * 古い記憶を捨てる。日記と重要な記憶は残す。
   * （放置された島でも `pet_memory` が無限に増えないようにするための逃げ道）
   */
  pruneMemories(petId: number, opts: { beforeIslandDay: number; keepImportanceAtLeast?: number }): number {
    const keep = opts.keepImportanceAtLeast ?? 7;
    const res = this.stmt(
      `DELETE FROM pet_memory
        WHERE pet_id = ? AND island_day < ? AND importance < ? AND kind != 'diary'`,
    ).run(petId, opts.beforeIslandDay, keep);
    return res.changes;
  }

  // ---------- 会話ログ ----------

  insertChat(row: {
    islandId: string;
    tick: number;
    speakerKind: string;
    speakerId: string;
    listenerId?: string;
    text: string;
  }): void {
    this.stmt(
      `INSERT INTO chat_log (island_id, tick, speaker_kind, speaker_id, listener_id, text)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(row.islandId, row.tick, row.speakerKind, row.speakerId, row.listenerId ?? null, row.text);
  }

  /**
   * そのペットが関わった直近の会話（**古い順**で返す。プロンプトにそのまま並べられる形）。
   *
   * `speaker` は `chat_log.speaker_id` そのまま。表示名は持っていないので、
   * 呼び出し側（hub / dialogue）で id → 名前に解決すること
   * （`buildDialoguePrompt` は「ペットの名前と一致するか」で assistant/user を振り分ける）。
   */
  recentChat(petId: number, limit: number): { speaker: string; text: string }[] {
    const n = Math.max(1, Math.trunc(limit));
    const key = String(petId);
    const rows = this.stmt(
      `SELECT speaker_id, text FROM chat_log
        WHERE speaker_id = ? OR listener_id = ?
        ORDER BY tick DESC, id DESC LIMIT ?`,
    ).all(key, key, n) as ChatDbRow[];
    return rows.reverse().map((r) => ({ speaker: r.speaker_id, text: r.text }));
  }
}
