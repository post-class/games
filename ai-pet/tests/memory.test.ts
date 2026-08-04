import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../server/db.js';
import {
  ACTIVE_EPISODE_LIMIT,
  addChatTurn,
  addEpisode,
  applyMemoryWrites,
  baseScore,
  deleteEpisode,
  isFactKey,
  listEpisodes,
  listFacts,
  recallEpisodes,
  recentChat,
  relevance,
  scoreEpisode,
  upsertFact,
} from '../server/pet/memory.js';
import { createPet } from '../server/pet/store.js';

/**
 * 3層記憶。「忘れない・矛盾しない・使われた記憶が定着する」ことを固定する。
 */

const DAY = 86_400_000;
let db: Db;
let petId: number;

beforeEach(() => {
  db = openDb(':memory:');
  db.prepare(
    'INSERT INTO users (name, password_hash, coins, created_at, last_seen_at) VALUES (?, ?, 0, 0, 0)',
  ).run('tester', 'x');
  const pet = createPet(db, { userId: 1, name: 'テスト', species: 'mocha', rand: () => 0.5, now: 0 });
  petId = pet.id;
});

describe('事実層', () => {
  it('同じキーは上書きされるので矛盾しない', () => {
    upsertFact(db, petId, 'owner_name', 'りょう', 100);
    upsertFact(db, petId, 'owner_name', 'はると', 200);
    const facts = listFacts(db, petId);
    expect(facts).toHaveLength(1);
    expect(facts[0].value).toBe('はると');
  });

  it('ホワイトリスト外のキーは保存しない', () => {
    upsertFact(db, petId, 'secret_key', 'あぶない値', 100);
    expect(listFacts(db, petId)).toHaveLength(0);
  });

  it('長すぎる値は切る', () => {
    upsertFact(db, petId, 'owner_likes', 'あ'.repeat(200), 100);
    expect(listFacts(db, petId)[0].value.length).toBe(30);
  });

  it('LLM が説明文を混ぜても最初の一区切りだけ残す（記憶の汚染を防ぐ）', () => {
    // 実際に観測された壊れ方: 名前のあとに無関係な解説が続く
    upsertFact(db, petId, 'owner_name', 'さくら。接続語が保持されました。接続語の「です」は…', 100);
    expect(listFacts(db, petId)[0].value).toBe('さくら');
  });

  it('改行以降も捨てる', () => {
    upsertFact(db, petId, 'owner_likes', 'いちご\nそれから説明が続く', 100);
    expect(listFacts(db, petId)[0].value).toBe('いちご');
  });

  it('複数の好きなものは読点で残る', () => {
    upsertFact(db, petId, 'owner_likes', 'いちご、ぶどう', 100);
    expect(listFacts(db, petId)[0].value).toBe('いちご、ぶどう');
  });

  it('sanitize 後に空になる値は保存しない', () => {
    upsertFact(db, petId, 'owner_likes', '。なにか', 100);
    expect(listFacts(db, petId)).toHaveLength(0);
  });

  it('空文字は保存しない', () => {
    upsertFact(db, petId, 'owner_likes', '   ', 100);
    expect(listFacts(db, petId)).toHaveLength(0);
  });

  it('isFactKey がキーを判定する', () => {
    expect(isFactKey('owner_name')).toBe(true);
    expect(isFactKey('nope')).toBe(false);
    expect(isFactKey(42)).toBe(false);
  });
});

describe('エピソード層のスコアリング', () => {
  it('重要度が高いほどスコアが高い', () => {
    const low = { id: 1, summary: 'a', importance: 1, emotion: null, createdAt: 0, lastUsedAt: 0, useCount: 0, faded: false };
    const high = { ...low, importance: 5 };
    expect(baseScore(high, 0)).toBeGreaterThan(baseScore(low, 0));
  });

  it('古い記憶はスコアが下がる（半減期14日）', () => {
    const episode = { id: 1, summary: 'a', importance: 4, emotion: null, createdAt: 0, lastUsedAt: 0, useCount: 0, faded: false };
    const fresh = baseScore(episode, 0);
    const old = baseScore(episode, 14 * DAY);
    expect(old).toBeCloseTo(fresh / 2, 5);
  });

  it('よく参照される記憶は残りやすい', () => {
    const rare = { id: 1, summary: 'a', importance: 3, emotion: null, createdAt: 0, lastUsedAt: 0, useCount: 0, faded: false };
    const used = { ...rare, useCount: 8 };
    expect(baseScore(used, 0)).toBeCloseTo(baseScore(rare, 0) * 2, 5);
  });

  it('語が一致するとスコアが上がる（日本語も効く）', () => {
    const episode = { id: 1, summary: 'いちごを一緒に食べた', importance: 2, emotion: null, createdAt: 0, lastUsedAt: 0, useCount: 0, faded: false };
    expect(relevance(episode, 'いちご')).toBeGreaterThan(0);
    expect(relevance(episode, 'ロケット')).toBe(0);
    expect(scoreEpisode(episode, 'いちご', 0)).toBeGreaterThan(baseScore(episode, 0));
  });

  it('空のクエリでは関連度ゼロ', () => {
    const episode = { id: 1, summary: 'あそんだ', importance: 2, emotion: null, createdAt: 0, lastUsedAt: 0, useCount: 0, faded: false };
    expect(relevance(episode, '   ')).toBe(0);
  });
});

describe('recallEpisodes', () => {
  it('関連する記憶を優先して選ぶ', () => {
    addEpisode(db, petId, '公園でボールを追いかけた', 2, null, 1000);
    addEpisode(db, petId, 'いちごをもらってうれしかった', 2, null, 1000);
    const picked = recallEpisodes(db, petId, 'いちご', 1, 2000);
    expect(picked[0].summary).toContain('いちご');
  });

  it('選ばれた記憶は参照回数が増える（定着する）', () => {
    addEpisode(db, petId, 'あそんだ', 3, null, 1000);
    recallEpisodes(db, petId, 'あそんだ', 5, 2000);
    expect(listEpisodes(db, petId)[0].useCount).toBe(1);
  });

  it('limit を超えては返さない', () => {
    for (let i = 0; i < 10; i += 1) addEpisode(db, petId, `できごと${i}`, 3, null, 1000);
    expect(recallEpisodes(db, petId, '', 4, 2000)).toHaveLength(4);
  });
});

describe('うすれた記憶', () => {
  it('上限を超えると低スコアのものが faded になる（削除はしない）', () => {
    for (let i = 0; i < ACTIVE_EPISODE_LIMIT + 5; i += 1) {
      // 古くて重要度の低いものから順に入れる
      addEpisode(db, petId, `できごと${i}`, i < 5 ? 1 : 5, null, 1000 + i);
    }
    const active = listEpisodes(db, petId, false);
    const all = listEpisodes(db, petId, true);
    expect(active.length).toBeLessThanOrEqual(ACTIVE_EPISODE_LIMIT);
    expect(all.length).toBe(ACTIVE_EPISODE_LIMIT + 5);
    expect(all.filter((episode) => episode.faded).length).toBe(5);
  });

  it('faded な記憶は recall されない', () => {
    for (let i = 0; i < ACTIVE_EPISODE_LIMIT + 1; i += 1) {
      addEpisode(db, petId, `できごと${i}`, i === 0 ? 1 : 5, null, 1000 + i);
    }
    const picked = recallEpisodes(db, petId, 'できごと0', 100, 2000);
    expect(picked.some((episode) => episode.summary === 'できごと0')).toBe(false);
  });
});

describe('applyMemoryWrites', () => {
  it('fact と episode を両方書き込む', () => {
    const applied = applyMemoryWrites(
      db,
      petId,
      [
        { kind: 'fact', key: 'owner_name', value: 'りょう' },
        { kind: 'episode', summary: 'はじめて会った', importance: 5 },
      ],
      1000,
    );
    expect(applied).toBe(2);
    expect(listFacts(db, petId)).toHaveLength(1);
    expect(listEpisodes(db, petId)).toHaveLength(1);
  });

  it('不正な書き込みは数えない', () => {
    const applied = applyMemoryWrites(
      db,
      petId,
      [
        { kind: 'fact', key: 'bogus', value: 'x' } as never,
        { kind: 'episode', summary: '   ', importance: 3 },
      ],
      1000,
    );
    expect(applied).toBe(0);
  });
});

describe('ユーザによる記憶の訂正', () => {
  it('削除すると recall されなくなる', () => {
    const id = addEpisode(db, petId, 'まちがった記憶', 5, null, 1000);
    expect(id).not.toBeNull();
    deleteEpisode(db, petId, id!);
    expect(listEpisodes(db, petId, true)).toHaveLength(0);
  });
});

describe('直近会話層', () => {
  it('古い順に並べて返す', () => {
    addChatTurn(db, petId, 'owner', 'こんにちは', null, 1000);
    addChatTurn(db, petId, 'pet', 'やあ', 'happy', 1100);
    const chat = recentChat(db, petId, 10);
    expect(chat.map((turn) => turn.text)).toEqual(['こんにちは', 'やあ']);
    expect(chat[1].emotion).toBe('happy');
  });

  it('limit で新しいほうを残す', () => {
    for (let i = 0; i < 20; i += 1) addChatTurn(db, petId, 'owner', `発話${i}`, null, 1000 + i);
    const chat = recentChat(db, petId, 5);
    expect(chat).toHaveLength(5);
    expect(chat[4].text).toBe('発話19');
  });
});
