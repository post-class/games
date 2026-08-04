import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetChatFn, setChatFn, type ChatRequest } from '../server/llm/azure.js';
import { openDb, type Db } from '../server/db.js';
import { petThinks, reactToCare, talkToPet } from '../server/pet/brain.js';
import { listEncounters, pickPartner, runEncounter } from '../server/pet/encounter.js';
import { listEpisodes, listFacts, recentChat } from '../server/pet/memory.js';
import { createPet, petRecordById, type PetRecord } from '../server/pet/store.js';

/**
 * LLM を差し替えて、頭（brain）と交流（encounter）の流れを検証する。
 * 実際の API は呼ばない。
 */

let db: Db;
let pet: PetRecord;
let requests: ChatRequest[];

function addUser(name: string): number {
  const info = db
    .prepare(
      'INSERT INTO users (name, password_hash, coins, created_at, last_seen_at) VALUES (?, ?, 0, 0, 0)',
    )
    .run(name, 'x');
  return Number(info.lastInsertRowid);
}

/** 応答を順番に返すフェイク。 */
function fakeChat(...responses: string[]): void {
  let index = 0;
  setChatFn(async (request) => {
    requests.push(request);
    const response = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return response;
  });
}

const reply = (patch: Record<string, unknown> = {}): string =>
  JSON.stringify({
    say: 'おはよう、ごしゅじん',
    emotion: 'happy',
    action: 'nuzzle',
    needs_delta: { mood: 5 },
    memory_writes: [],
    gift_request: null,
    ...patch,
  });

beforeEach(() => {
  db = openDb(':memory:');
  requests = [];
  const userId = addUser('tester');
  pet = createPet(db, { userId, name: 'プク', species: 'mocha', rand: () => 0.5, now: 0 });
  // こどもの段階にしておく（たまごは話せない）
  db.prepare('UPDATE pets SET care_score = 10, born_at = ? WHERE id = ?').run(-3_600_000, pet.id);
  pet.careScore = 10;
  pet.bornAt = -3_600_000;
});

afterEach(() => {
  resetChatFn();
});

describe('talkToPet', () => {
  it('会話が両方向とも履歴に残る', async () => {
    fakeChat(reply());
    await talkToPet(db, pet, 'おはよう', { now: 1000 });
    const chat = recentChat(db, pet.id, 10);
    expect(chat.map((turn) => turn.role)).toEqual(['owner', 'pet']);
    expect(chat[1].text).toBe('おはよう、ごしゅじん');
  });

  it('性格ベクトルがプロンプトに入る', async () => {
    fakeChat(reply());
    await talkToPet(db, pet, 'おはよう', { now: 1000 });
    const system = requests[0].messages[0].content;
    expect(system).toContain('甘えん坊');
    expect(system).toContain('/100');
    expect(system).toContain('プク');
  });

  it('memory_writes が保存される', async () => {
    fakeChat(
      reply({
        memory_writes: [
          { kind: 'fact', key: 'owner_name', value: 'りょう' },
          { kind: 'episode', summary: 'はじめて名前を聞いた', importance: 5 },
        ],
      }),
    );
    await talkToPet(db, pet, 'ぼくはりょうだよ', { now: 1000 });
    expect(listFacts(db, pet.id)[0]).toMatchObject({ key: 'owner_name', value: 'りょう' });
    expect(listEpisodes(db, pet.id)[0].importance).toBe(5);
  });

  it('覚えた事実は次の会話のプロンプトに入る（忘れない）', async () => {
    fakeChat(reply({ memory_writes: [{ kind: 'fact', key: 'owner_likes', value: 'いちご' }] }));
    await talkToPet(db, pet, 'いちごがすき', { now: 1000 });
    requests = [];
    fakeChat(reply());
    await talkToPet(db, pet, 'なにがすきだったっけ', { now: 2000 });
    expect(requests[0].messages[0].content).toContain('いちご');
  });

  it('崩壊した発話は1回だけ言い直させる', async () => {
    fakeChat(reply({ say: '何かお手伝いできることはありますか？' }), reply({ say: 'ごしゅじん！' }));
    const result = await talkToPet(db, pet, 'やあ', { now: 1000 });
    expect(result.retried).toBe(true);
    expect(result.reply.say).toBe('ごしゅじん！');
    expect(requests).toHaveLength(2);
  });

  it('2回崩壊したら定型に落として崩壊をユーザに見せない', async () => {
    fakeChat(reply({ say: '承知しました' }));
    const result = await talkToPet(db, pet, 'やあ', { now: 1000 });
    expect(result.issues).toContain('guard-failed-twice');
    expect(result.reply.say).not.toContain('承知');
    expect(result.reply.say.length).toBeGreaterThan(0);
  });

  it('LLM が落ちても会話が成立し、状態が壊れない', async () => {
    setChatFn(async () => {
      throw new Error('boom');
    });
    const result = await talkToPet(db, pet, 'やあ', { now: 1000 });
    expect(result.llmError).toBe('boom');
    expect(result.reply.say.length).toBeGreaterThan(0);
    expect(recentChat(db, pet.id, 10)).toHaveLength(2);
  });

  it('壊れた JSON でも落ちない', async () => {
    fakeChat('こんにちは！（JSONではない）');
    const result = await talkToPet(db, pet, 'やあ', { now: 1000 });
    expect(result.reply.say.length).toBeGreaterThan(0);
  });
});

describe('reactToCare', () => {
  it('アイテムの効果は LLM に上書きされない', async () => {
    // LLM が「hunger -25」と返しても、世話の結果は減らさない
    fakeChat(reply({ needs_delta: { hunger: -25, mood: 3 } }));
    const before = pet.needs.hunger;
    await reactToCare(db, pet, { kind: 'feed', itemName: 'いちご' }, { now: 1000 });
    expect(pet.needs.hunger).toBe(before);
    expect(pet.needs.mood).toBeGreaterThan(0);
  });

  it('状況が LLM に伝わる', async () => {
    fakeChat(reply());
    await reactToCare(db, pet, { kind: 'feed', itemName: 'やきざかな' }, { now: 1000 });
    const last = requests[0].messages.at(-1)!.content;
    expect(last).toContain('やきざかな');
  });

  it('LLM が落ちても定型リアクションが返る', async () => {
    setChatFn(async () => {
      throw new Error('down');
    });
    const result = await reactToCare(db, pet, { kind: 'pet' }, { now: 1000 });
    expect(result.reply.say.length).toBeGreaterThan(0);
    expect(result.llmError).toBe('down');
  });
});

describe('petThinks', () => {
  it('思いつきが行動と独り言になる', async () => {
    fakeChat(reply({ action: 'peek_window', say: 'そとが きになるの' }));
    const result = await petThinks(db, pet, { now: 5000 });
    expect(result.reply.action).toBe('peek_window');
    expect(petRecordById(db, pet.id)!.action).toBe('peek_window');
    expect(petRecordById(db, pet.id)!.lastThinkAt).toBe(5000);
  });

  it('LLM が落ちても last_think_at は進める（連打しない）', async () => {
    setChatFn(async () => {
      throw new Error('down');
    });
    await petThinks(db, pet, { now: 7000 });
    expect(petRecordById(db, pet.id)!.lastThinkAt).toBe(7000);
  });
});

describe('ペット同士の交流', () => {
  function addPartner(): PetRecord {
    const userId = addUser('あいて');
    const partner = createPet(db, {
      userId,
      name: 'ソラ',
      species: 'nimbus',
      rand: () => 0.5,
      now: 0,
    });
    db.prepare('UPDATE pets SET care_score = 10, born_at = ? WHERE id = ?').run(-3_600_000, partner.id);
    partner.careScore = 10;
    partner.bornAt = -3_600_000;
    return partner;
  }

  const encounterReply = JSON.stringify({
    lines: [
      { speaker: 'self', text: 'こんにちは！' },
      { speaker: 'other', text: '……近づくな' },
    ],
    souvenir_self: '変わった子に会ったよ',
    souvenir_other: '騒がしい子に会った',
    affinity_delta: -4,
    episode_self: 'しずかな子に会った',
    episode_other: 'にぎやかな子に会った',
  });

  it('両方のペットにログと記憶が残る', async () => {
    const partner = addPartner();
    fakeChat(encounterReply);
    await runEncounter(db, pet, partner, 1000);

    const mine = listEncounters(db, pet.id);
    const theirs = listEncounters(db, partner.id);
    expect(mine[0].souvenir).toBe('変わった子に会ったよ');
    expect(theirs[0].souvenir).toBe('騒がしい子に会った');
    expect(listEpisodes(db, pet.id)[0].summary).toBe('しずかな子に会った');
    expect(listEpisodes(db, partner.id)[0].summary).toBe('にぎやかな子に会った');
  });

  it('相手側から見ると発話者が入れ替わる', async () => {
    const partner = addPartner();
    fakeChat(encounterReply);
    await runEncounter(db, pet, partner, 1000);
    const theirs = listEncounters(db, partner.id);
    expect(theirs[0].lines[0]).toEqual({ speaker: 'other', text: 'こんにちは！' });
  });

  it('相性が悪い出会いは重要度が高い記憶になる（引きずる）', async () => {
    const partner = addPartner();
    fakeChat(encounterReply);
    await runEncounter(db, pet, partner, 1000);
    expect(listEpisodes(db, pet.id)[0].importance).toBe(4);
  });

  it('双方の性格がプロンプトに入る', async () => {
    const partner = addPartner();
    fakeChat(encounterReply);
    await runEncounter(db, pet, partner, 1000);
    const system = requests[0].messages[0].content;
    expect(system).toContain('プク');
    expect(system).toContain('ソラ');
    expect(system).toContain('/100');
  });

  it('生成に失敗したら例外を投げる（呼び出し側が握る）', async () => {
    const partner = addPartner();
    fakeChat('こわれた応答');
    await expect(runEncounter(db, pet, partner, 1000)).rejects.toThrow();
  });

  it('たまごは相手に選ばれない', () => {
    const userId = addUser('たまごの人');
    createPet(db, { userId, name: 'たまご', species: 'pome', rand: () => 0.5, now: 0 });
    expect(pickPartner(db, pet, () => 0, 0)).toBeNull();
  });

  it('社交性が低いと出かけない', () => {
    addPartner();
    pet.personality.social = 0;
    // willingness = 0.15 なので 0.5 では出かけない
    expect(pickPartner(db, pet, () => 0.5, 0)).toBeNull();
  });

  it('社交性が高ければ出かける', () => {
    const partner = addPartner();
    pet.personality.social = 100;
    expect(pickPartner(db, pet, () => 0.5, 0)?.id).toBe(partner.id);
  });
});
