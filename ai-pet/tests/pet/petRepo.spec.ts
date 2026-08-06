/**
 * ペット・記憶・会話ログの永続化テスト（docs/02_ゲーム実装プラン/03_データモデル.md §3）
 *
 * スキーマ適用は `Repo`（編集禁止）が持っているので、`new Repo(':memory:')` の `db` を借りる。
 * これが本番の使い方（`Repo` に手を入れずに機能を足す形）と同じなので、テストも同じ経路を通す。
 */
import { afterEach, describe, expect, test } from 'vitest';
import { LLM, type PetPersona, type Traits } from '@ai-pet/shared';
import { Repo } from '../../packages/server/src/db/repo.ts';
import { PetRepo } from '../../packages/server/src/db/petRepo.ts';
import { buildPersona } from '../../packages/server/src/pet/persona.ts';
import { memoryFromDiary, memoryFromTalk, selectMemories, type MemoryRecord } from '../../packages/server/src/pet/memory.ts';

const repos: Repo[] = [];

function newRepo(): { repo: Repo; pets: PetRepo } {
  const repo = new Repo(':memory:');
  repos.push(repo);
  return { repo, pets: new PetRepo(repo.db) };
}

afterEach(() => {
  while (repos.length > 0) repos.pop()?.close();
});

const TRAITS: Traits = { energy: 0.5, sociability: 0.6, caution: 0.3, gluttony: 0.7, curiosity: 0.4 };

function persona(name = 'ぽこ'): PetPersona {
  return buildPersona({ species: 'mofi', name, traitTags: ['おっとり', '甘えん坊'] });
}

/** player テーブルに1行作る（pet.player_id の参照先。FKは無効だが本番の流れに合わせる） */
function newPlayer(repo: Repo, secret: string): string {
  return repo.createPlayer({ secret, displayName: 'りょう', islandId: 'main', pos: { x: 64, y: 64 } }).id;
}

function mem(petId: number, patch: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    petId,
    tick: 100,
    islandDay: 1,
    kind: 'observe',
    text: 'ミズネが木の実をさがしていた',
    keywords: ['ミズネ', '木の実'],
    importance: 5,
    lastAccessTick: 100,
    ...patch,
  };
}

// ---------- ペット ----------

describe('PetRepo: ペット', () => {
  test('作成 → 取得 → 更新', () => {
    const { repo, pets } = newRepo();
    const playerId = newPlayer(repo, 's1');
    const p = persona();

    const created = pets.createPet({ playerId, persona: p, traits: TRAITS, entityId: 42 });
    expect(created.id).toBe(42);
    expect(created.affection).toBe(30);
    expect(created.summary).toBe('');

    const found = pets.findPetByPlayer(playerId);
    expect(found).not.toBeNull();
    expect(found?.id).toBe(42);
    expect(found?.persona).toEqual(p);
    expect(found?.traits).toEqual(TRAITS);
    expect(pets.findPetById(42)?.playerId).toBe(playerId);

    pets.updatePet(42, { affection: 77.5, summary: 'ミズネと仲良し' });
    const after = pets.findPetByPlayer(playerId);
    expect(after?.affection).toBeCloseTo(77.5);
    expect(after?.summary).toBe('ミズネと仲良し');
  });

  test('いないプレイヤーなら null', () => {
    const { pets } = newRepo();
    expect(pets.findPetByPlayer('nobody')).toBeNull();
    expect(pets.findPetById(1)).toBeNull();
  });

  test('同じ playerId で2匹は作れない（UNIQUE制約）', () => {
    const { repo, pets } = newRepo();
    const playerId = newPlayer(repo, 's1');
    pets.createPet({ playerId, persona: persona(), traits: TRAITS, entityId: 1 });
    expect(() => pets.createPet({ playerId, persona: persona('ふた'), traits: TRAITS, entityId: 2 })).toThrow(
      /UNIQUE/,
    );
  });

  test('別プレイヤーなら作れる', () => {
    const { repo, pets } = newRepo();
    const a = newPlayer(repo, 's1');
    const b = newPlayer(repo, 's2');
    pets.createPet({ playerId: a, persona: persona('あ'), traits: TRAITS, entityId: 1 });
    pets.createPet({ playerId: b, persona: persona('い'), traits: TRAITS, entityId: 2 });
    expect(pets.findPetByPlayer(a)?.persona.name).toBe('あ');
    expect(pets.findPetByPlayer(b)?.persona.name).toBe('い');
  });

  test('summary は 400字で切られる（プロンプトに載る上限）', () => {
    const { repo, pets } = newRepo();
    const playerId = newPlayer(repo, 's1');
    pets.createPet({ playerId, persona: persona(), traits: TRAITS, entityId: 1 });
    pets.updatePet(1, { summary: 'あ'.repeat(1000) });
    expect(pets.findPetById(1)?.summary.length).toBe(LLM.maxSummaryChars);
  });

  test('懐き度は 0..100 に丸まる', () => {
    const { repo, pets } = newRepo();
    const playerId = newPlayer(repo, 's1');
    pets.createPet({ playerId, persona: persona(), traits: TRAITS, entityId: 1 });
    pets.updatePet(1, { affection: 500 });
    expect(pets.findPetById(1)?.affection).toBe(100);
    pets.updatePet(1, { affection: -20 });
    expect(pets.findPetById(1)?.affection).toBe(0);
  });

  test('空のパッチは何もしない', () => {
    const { repo, pets } = newRepo();
    const playerId = newPlayer(repo, 's1');
    pets.createPet({ playerId, persona: persona(), traits: TRAITS, entityId: 1 });
    pets.updatePet(1, {});
    expect(pets.findPetById(1)?.affection).toBe(30);
  });
});

// ---------- 記憶 ----------

describe('PetRepo: 記憶', () => {
  function withPet(): { repo: Repo; pets: PetRepo; petId: number } {
    const { repo, pets } = newRepo();
    const playerId = newPlayer(repo, 's1');
    const petId = 7;
    pets.createPet({ playerId, persona: persona(), traits: TRAITS, entityId: petId });
    return { repo, pets, petId };
  }

  test('挿入と取得（キーワードが往復する）', () => {
    const { pets, petId } = withPet();
    pets.insertMemories([mem(petId), mem(petId, { tick: 200, text: 'ハッカが畑にいた', keywords: ['ハッカ', '畑'] })]);
    const got = pets.recentMemories(petId);
    expect(got).toHaveLength(2);
    // 新しい順
    expect(got[0]?.tick).toBe(200);
    expect(got[0]?.keywords).toEqual(['ハッカ', '畑']);
    expect(got[0]?.id).toBeGreaterThan(0);
    expect(pets.countMemories(petId)).toBe(2);
  });

  test('空配列を渡しても何もしない', () => {
    const { pets, petId } = withPet();
    pets.insertMemories([]);
    expect(pets.countMemories(petId)).toBe(0);
  });

  test('キーワードなしでも往復する', () => {
    const { pets, petId } = withPet();
    pets.insertMemories([mem(petId, { keywords: [] })]);
    expect(pets.recentMemories(petId)[0]?.keywords).toEqual([]);
  });

  test('limit と kinds で絞れる（全件は返さない）', () => {
    const { pets, petId } = withPet();
    const rows: MemoryRecord[] = [];
    for (let i = 0; i < 50; i++) {
      rows.push(mem(petId, { tick: i, kind: i % 5 === 0 ? 'diary' : 'observe' }));
    }
    pets.insertMemories(rows);
    expect(pets.recentMemories(petId, { limit: 10 })).toHaveLength(10);
    const diaries = pets.recentMemories(petId, { kinds: ['diary'] });
    expect(diaries).toHaveLength(10);
    expect(diaries.every((m) => m.kind === 'diary')).toBe(true);
    expect(pets.recentMemories(petId, { kinds: ['talk', 'gossip'] })).toHaveLength(0);
  });

  test('他のペットの記憶は混ざらない', () => {
    const { repo, pets, petId } = withPet();
    const other = newPlayer(repo, 's2');
    pets.createPet({ playerId: other, persona: persona('べつ'), traits: TRAITS, entityId: 99 });
    pets.insertMemories([mem(petId), mem(99), mem(99)]);
    expect(pets.recentMemories(petId)).toHaveLength(1);
    expect(pets.recentMemories(99)).toHaveLength(2);
  });

  test('memoriesOfDay はその島日ぶんを古い順で返す', () => {
    const { pets, petId } = withPet();
    pets.insertMemories([
      mem(petId, { islandDay: 1, tick: 10 }),
      mem(petId, { islandDay: 2, tick: 30 }),
      mem(petId, { islandDay: 2, tick: 20 }),
      mem(petId, { islandDay: 3, tick: 40 }),
    ]);
    const day2 = pets.memoriesOfDay(petId, 2);
    expect(day2.map((m) => m.tick)).toEqual([20, 30]);
  });

  test('touchMemories が last_access_tick を更新する', () => {
    const { pets, petId } = withPet();
    pets.insertMemories([mem(petId), mem(petId, { tick: 200 })]);
    const before = pets.recentMemories(petId);
    const ids = before.map((m) => m.id ?? 0);
    pets.touchMemories(ids, 9999);
    for (const m of pets.recentMemories(petId)) expect(m.lastAccessTick).toBe(9999);
    pets.touchMemories([], 1); // 空でも落ちない
  });

  test('pruneMemories は日記と重要な記憶を残す', () => {
    const { pets, petId } = withPet();
    pets.insertMemories([
      mem(petId, { islandDay: 1, importance: 2 }),
      mem(petId, { islandDay: 1, importance: 8 }),
      mem(petId, { islandDay: 1, importance: 3, kind: 'diary' }),
      mem(petId, { islandDay: 9, importance: 2 }),
    ]);
    const removed = pets.pruneMemories(petId, { beforeIslandDay: 5 });
    expect(removed).toBe(1);
    expect(pets.countMemories(petId)).toBe(3);
  });

  test('DBから取った記憶をそのまま selectMemories に渡せる（結合の形）', () => {
    const { pets, petId } = withPet();
    const rows: MemoryRecord[] = [];
    for (let i = 0; i < 100; i++) {
      rows.push(
        i % 7 === 0
          ? (memoryFromDiary(petId, { tick: i * 10, islandDay: i, diary: `${i}日目の日記。ミズネと話した` }) as MemoryRecord)
          : memoryFromTalk(petId, {
              tick: i * 10,
              islandDay: i,
              ownerName: 'りょう',
              playerText: `${i}回目のはなし`,
              petText: 'うん',
            }),
      );
    }
    pets.insertMemories(rows);
    const picked = selectMemories(pets.recentMemories(petId, { limit: 200 }), {
      nowTick: 1000,
      query: 'ミズネのこと覚えてる?',
      knownNames: ['ミズネ', 'りょう'],
    });
    expect(picked).toHaveLength(LLM.maxMemories);
    // 選んだぶんに印をつけられる（idが返ってきている）
    pets.touchMemories(
      picked.map((m) => m.id ?? 0),
      1000,
    );
    expect(picked.every((m) => (m.id ?? 0) > 0)).toBe(true);
  });
});

// ---------- 会話ログ ----------

describe('PetRepo: 会話ログ', () => {
  test('挿入して古い順に取れる', () => {
    const { repo, pets } = newRepo();
    const playerId = newPlayer(repo, 's1');
    pets.createPet({ playerId, persona: persona(), traits: TRAITS, entityId: 5 });

    pets.insertChat({ islandId: 'main', tick: 1, speakerKind: 'player', speakerId: playerId, listenerId: '5', text: 'おはよう' });
    pets.insertChat({ islandId: 'main', tick: 2, speakerKind: 'pet', speakerId: '5', listenerId: playerId, text: 'ねむいねぇ' });
    pets.insertChat({ islandId: 'main', tick: 3, speakerKind: 'player', speakerId: playerId, listenerId: '5', text: 'おきて' });

    const got = pets.recentChat(5, 10);
    expect(got.map((r) => r.text)).toEqual(['おはよう', 'ねむいねぇ', 'おきて']);
    expect(got[1]?.speaker).toBe('5');
  });

  test('limit は新しいほうを残す', () => {
    const { repo, pets } = newRepo();
    const playerId = newPlayer(repo, 's1');
    pets.createPet({ playerId, persona: persona(), traits: TRAITS, entityId: 5 });
    for (let i = 0; i < 20; i++) {
      pets.insertChat({ islandId: 'main', tick: i, speakerKind: 'player', speakerId: playerId, listenerId: '5', text: `${i}` });
    }
    const got = pets.recentChat(5, 3);
    expect(got.map((r) => r.text)).toEqual(['17', '18', '19']);
  });

  test('関係のない会話は混ざらない', () => {
    const { repo, pets } = newRepo();
    const playerId = newPlayer(repo, 's1');
    pets.createPet({ playerId, persona: persona(), traits: TRAITS, entityId: 5 });
    pets.insertChat({ islandId: 'main', tick: 1, speakerKind: 'pet', speakerId: '99', listenerId: '98', text: 'よその話' });
    pets.insertChat({ islandId: 'main', tick: 2, speakerKind: 'pet', speakerId: '5', text: 'ひとりごと' });
    expect(pets.recentChat(5, 10).map((r) => r.text)).toEqual(['ひとりごと']);
  });
});
