import type { Emotion } from '../../shared/actions.js';
import { isEmotion } from '../../shared/actions.js';
import type { ChatTurn, MemoryEpisode, MemoryFact, MemoryWrite } from '../../shared/types.js';
import type { Db } from '../db.js';

/**
 * 3層記憶。
 *
 * 既存 AI ペットの2大不満のうち「長期記憶の破綻」に対する構造的な答え。
 *   第1層 事実  : key で上書きされるので矛盾しない。常に全件注入する。
 *   第2層 episode: スコア上位のみ注入。ベクトルDBは使わず、
 *                  importance × 新しさ × 語の一致 の決定論的スコアなのでテストできる。
 *   第3層 直近会話: 最新 k ターンをそのまま。
 *
 * さらに、この3層はすべて「おもいで帳」UI から閲覧・編集・削除できる。
 * AI が間違って覚えた記憶をユーザ自身が直せる、という点が既存アプリにない。
 */

/** 事実層のキーはホワイトリスト。LLM が好き勝手にキーを増やすと収拾がつかなくなる。 */
export const FACT_KEYS = {
  owner_name: '飼い主の呼び名',
  owner_likes: '飼い主の好きなもの',
  owner_dislikes: '飼い主の苦手なもの',
  owner_job: '飼い主の仕事や学校',
  owner_routine: '飼い主の生活リズム',
  favorite_food: 'ペット自身の好きな食べ物',
  favorite_toy: 'ペット自身の好きな遊び',
  fear: 'ペット自身が怖いもの',
  dream: 'ペット自身の夢',
  nickname_for_owner: 'ペットが飼い主を呼ぶときの呼び方',
  shared_joke: '二人の間だけの合言葉や冗談',
  promise: '飼い主とした約束',
} as const;

export type FactKey = keyof typeof FACT_KEYS;

export const MAX_FACT_VALUE_LEN = 60;
export const MAX_EPISODE_LEN = 120;
/** これを超えたら低スコアのエピソードを「うすれた記憶」にする。 */
export const ACTIVE_EPISODE_LIMIT = 60;

export function isFactKey(value: unknown): value is FactKey {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(FACT_KEYS, value);
}

// --- 事実層 ---------------------------------------------------------------

export function listFacts(db: Db, petId: number): MemoryFact[] {
  const rows = db
    .prepare('SELECT key, value, updated_at FROM pet_facts WHERE pet_id = ? ORDER BY key')
    .all(petId) as Array<{ key: string; value: string; updated_at: number }>;
  return rows.map((row) => ({ key: row.key, value: row.value, updatedAt: row.updated_at }));
}

export function upsertFact(db: Db, petId: number, key: string, value: string, now = Date.now()): void {
  if (!isFactKey(key)) return;
  const trimmed = value.trim().slice(0, MAX_FACT_VALUE_LEN);
  if (!trimmed) return;
  db.prepare(
    `INSERT INTO pet_facts (pet_id, key, value, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(pet_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(petId, key, trimmed, now);
}

export function deleteFact(db: Db, petId: number, key: string): void {
  db.prepare('DELETE FROM pet_facts WHERE pet_id = ? AND key = ?').run(petId, key);
}

// --- エピソード層 ---------------------------------------------------------

interface EpisodeRow {
  id: number;
  summary: string;
  importance: number;
  emotion: string | null;
  created_at: number;
  last_used_at: number;
  use_count: number;
  faded: number;
}

function toEpisode(row: EpisodeRow): MemoryEpisode {
  return {
    id: row.id,
    summary: row.summary,
    importance: row.importance,
    emotion: isEmotion(row.emotion) ? row.emotion : null,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    useCount: row.use_count,
    faded: row.faded === 1,
  };
}

export function listEpisodes(db: Db, petId: number, includeFaded = false): MemoryEpisode[] {
  const sql = includeFaded
    ? 'SELECT * FROM pet_episodes WHERE pet_id = ? ORDER BY created_at DESC'
    : 'SELECT * FROM pet_episodes WHERE pet_id = ? AND faded = 0 ORDER BY created_at DESC';
  return (db.prepare(sql).all(petId) as EpisodeRow[]).map(toEpisode);
}

export function addEpisode(
  db: Db,
  petId: number,
  summary: string,
  importance: number,
  emotion: Emotion | null = null,
  now = Date.now(),
): number | null {
  const trimmed = summary.trim().slice(0, MAX_EPISODE_LEN);
  if (!trimmed) return null;
  const clamped = Math.max(1, Math.min(5, Math.round(importance)));
  const info = db
    .prepare(
      `INSERT INTO pet_episodes (pet_id, summary, importance, emotion, created_at, last_used_at, use_count, faded)
       VALUES (?, ?, ?, ?, ?, ?, 0, 0)`,
    )
    .run(petId, trimmed, clamped, emotion, now, now);
  fadeOverflow(db, petId, now);
  return Number(info.lastInsertRowid);
}

export function deleteEpisode(db: Db, petId: number, episodeId: number): void {
  db.prepare('DELETE FROM pet_episodes WHERE pet_id = ? AND id = ?').run(petId, episodeId);
}

export function updateEpisode(
  db: Db,
  petId: number,
  episodeId: number,
  patch: { summary?: string; importance?: number },
): void {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (typeof patch.summary === 'string') {
    sets.push('summary = ?');
    values.push(patch.summary.trim().slice(0, MAX_EPISODE_LEN));
  }
  if (typeof patch.importance === 'number') {
    sets.push('importance = ?');
    values.push(Math.max(1, Math.min(5, Math.round(patch.importance))));
  }
  if (!sets.length) return;
  values.push(petId, episodeId);
  db.prepare(`UPDATE pet_episodes SET ${sets.join(', ')} WHERE pet_id = ? AND id = ?`).run(...values);
}

export function setEpisodeFaded(db: Db, petId: number, episodeId: number, faded: boolean): void {
  db.prepare('UPDATE pet_episodes SET faded = ? WHERE pet_id = ? AND id = ?').run(
    faded ? 1 : 0,
    petId,
    episodeId,
  );
}

/** 活性エピソードが上限を超えたら、スコア下位を faded にする（削除はしない）。 */
function fadeOverflow(db: Db, petId: number, now: number): void {
  const active = listEpisodes(db, petId, false);
  if (active.length <= ACTIVE_EPISODE_LIMIT) return;
  const scored = active
    .map((episode) => ({ episode, score: baseScore(episode, now) }))
    .sort((a, b) => a.score - b.score);
  const overflow = active.length - ACTIVE_EPISODE_LIMIT;
  for (const { episode } of scored.slice(0, overflow)) {
    setEpisodeFaded(db, petId, episode.id, true);
  }
}

const HALF_LIFE_DAYS = 14;

/** 重要度 × 新しさ × 参照実績。参照されるほど残りやすい（人の記憶に近い）。 */
export function baseScore(episode: MemoryEpisode, now: number): number {
  const ageDays = Math.max(0, (now - episode.createdAt) / 86_400_000);
  const recency = Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
  const reinforcement = 1 + Math.min(1, episode.useCount / 8);
  return episode.importance * recency * reinforcement;
}

/** 日本語は空白で切れないので、2〜4文字の連続部分列を鍵にして重なりを見る。 */
function keyGrams(text: string): Set<string> {
  const cleaned = text.replace(/[\s、。！？!?,.「」『』（）()]/g, '');
  const grams = new Set<string>();
  for (const size of [2, 3]) {
    for (let i = 0; i + size <= cleaned.length; i += 1) {
      grams.add(cleaned.slice(i, i + size));
    }
  }
  return grams;
}

export function relevance(episode: MemoryEpisode, query: string): number {
  if (!query.trim()) return 0;
  const queryGrams = keyGrams(query);
  if (!queryGrams.size) return 0;
  const episodeGrams = keyGrams(episode.summary);
  let hits = 0;
  for (const gram of queryGrams) {
    if (episodeGrams.has(gram)) hits += 1;
  }
  // 一致率を 0〜1 にし、重要度と同じくらいの重みになるよう 4 倍する。
  return (hits / queryGrams.size) * 4;
}

export function scoreEpisode(episode: MemoryEpisode, query: string, now: number): number {
  return baseScore(episode, now) + relevance(episode, query);
}

/**
 * プロンプトに入れるエピソードを選ぶ。
 * 選ばれたものは last_used_at / use_count を更新するので、
 * よく使われる記憶が自然に定着し、使われない記憶は薄れていく。
 */
export function recallEpisodes(
  db: Db,
  petId: number,
  query: string,
  limit = 6,
  now = Date.now(),
): MemoryEpisode[] {
  const candidates = listEpisodes(db, petId, false);
  const picked = candidates
    .map((episode) => ({ episode, score: scoreEpisode(episode, query, now) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.episode);

  if (picked.length) {
    const update = db.prepare(
      'UPDATE pet_episodes SET last_used_at = ?, use_count = use_count + 1 WHERE id = ?',
    );
    for (const episode of picked) update.run(now, episode.id);
  }
  return picked;
}

// --- 直近会話層 -----------------------------------------------------------

export function addChatTurn(
  db: Db,
  petId: number,
  role: 'owner' | 'pet',
  text: string,
  emotion: Emotion | null = null,
  now = Date.now(),
): void {
  db.prepare(
    'INSERT INTO chat_turns (pet_id, role, text, emotion, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(petId, role, text.slice(0, 400), emotion, now);
}

export function recentChat(db: Db, petId: number, limit = 12): ChatTurn[] {
  const rows = db
    .prepare('SELECT * FROM chat_turns WHERE pet_id = ? ORDER BY id DESC LIMIT ?')
    .all(petId, limit) as Array<{
    id: number;
    role: string;
    text: string;
    emotion: string | null;
    created_at: number;
  }>;
  return rows
    .reverse()
    .map((row) => ({
      id: row.id,
      role: row.role === 'owner' ? 'owner' : 'pet',
      text: row.text,
      emotion: isEmotion(row.emotion) ? row.emotion : null,
      createdAt: row.created_at,
    }));
}

// --- 書き込みの適用 -------------------------------------------------------

/**
 * LLM が返した memory_writes を検証して適用する。
 * ホワイトリスト外のキー・長すぎる値・空文字は捨てる。適用した件数を返す。
 */
export function applyMemoryWrites(
  db: Db,
  petId: number,
  writes: MemoryWrite[],
  now = Date.now(),
): number {
  let applied = 0;
  for (const write of writes.slice(0, 4)) {
    if (write.kind === 'fact') {
      if (!isFactKey(write.key)) continue;
      if (typeof write.value !== 'string' || !write.value.trim()) continue;
      upsertFact(db, petId, write.key, write.value, now);
      applied += 1;
    } else if (write.kind === 'episode') {
      if (typeof write.summary !== 'string' || !write.summary.trim()) continue;
      const id = addEpisode(
        db,
        petId,
        write.summary,
        write.importance ?? 3,
        write.emotion ?? null,
        now,
      );
      if (id !== null) applied += 1;
    }
  }
  return applied;
}
