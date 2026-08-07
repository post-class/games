/**
 * 噂の報告のテスト（docs 09章 M6「一方のオーナーがログインしたとき、ペットが噂を報告する」）
 */
import { afterEach, describe, expect, test } from 'vitest';
import { Repo } from '../../packages/server/src/db/repo.ts';
import { PetRepo } from '../../packages/server/src/db/petRepo.ts';
import { GossipReporter } from '../../packages/server/src/pet/gossipReport.ts';
import { memoryFromGossip } from '../../packages/server/src/pet/memory.ts';
import { buildPersona } from '../../packages/server/src/pet/persona.ts';
import { randomTraits } from '../../packages/server/src/sim/actors.ts';
import { Rng } from '@ai-pet/shared';

const repos: Repo[] = [];

afterEach(() => {
  for (const r of repos.splice(0)) r.close();
});

interface Harness {
  petRepo: PetRepo;
  reporter: GossipReporter;
  petId: number;
}

function newHarness(): Harness {
  const repo = new Repo(':memory:');
  repos.push(repo);
  const petRepo = new PetRepo(repo.db);

  const player = repo.createPlayer({
    secret: 's',
    displayName: 'りょう',
    islandId: 'main',
    pos: { x: 64.5, y: 64.5 },
  });
  const pet = petRepo.createPet({
    playerId: player.id,
    persona: buildPersona({ species: 'mizune', name: 'みずね' }),
    traits: randomTraits(new Rng('t')),
    entityId: 5001,
  });
  return { petRepo, reporter: new GossipReporter(petRepo), petId: pet.id };
}

/** 噂を1件記憶に入れる */
function addGossip(h: Harness, opts: { text: string; islandDay: number; tick?: number }): void {
  const rec = memoryFromGossip(h.petId, {
    tick: opts.tick ?? opts.islandDay * 14400,
    islandDay: opts.islandDay,
    fromName: 'ほしら',
    text: opts.text,
  });
  if (rec) h.petRepo.insertMemories([rec]);
}

describe('噂の報告', () => {
  test('噂が無ければ報告しない', () => {
    const h = newHarness();
    expect(h.reporter.take(h.petId, 3, 'みずね')).toBeNull();
    expect(h.reporter.hasPending(h.petId, 3)).toBe(false);
  });

  test('聞いた噂を報告できる', () => {
    const h = newHarness();
    addGossip(h, { text: '川むこうに木の実があるらしい', islandDay: 3 });

    expect(h.reporter.hasPending(h.petId, 3)).toBe(true);
    const report = h.reporter.take(h.petId, 3, 'みずね');
    expect(report).not.toBeNull();
    expect(report?.items).toHaveLength(1);
    expect(report?.items[0]?.text).toContain('木の実');
    expect(report?.line).toContain('みずね');
  });

  test('同じ噂は二度報告しない', () => {
    const h = newHarness();
    addGossip(h, { text: 'ほしらは星が好きらしい', islandDay: 2 });

    expect(h.reporter.take(h.petId, 2, 'みずね')).not.toBeNull();
    expect(h.reporter.take(h.petId, 2, 'みずね')).toBeNull();
    expect(h.reporter.hasPending(h.petId, 2)).toBe(false);
  });

  test('一度に報告するのは2件まで（報告会にしない）', () => {
    const h = newHarness();
    for (let i = 0; i < 5; i++) addGossip(h, { text: `噂その${i}`, islandDay: 3, tick: 3 * 14400 + i });

    const first = h.reporter.take(h.petId, 3, 'みずね');
    expect(first?.items).toHaveLength(2);
    expect(first?.line).toContain('ふたつ');

    // 残りは次の機会に
    const second = h.reporter.take(h.petId, 3, 'みずね');
    expect(second?.items).toHaveLength(2);
  });

  test('古すぎる噂は報告しない（3島日より前）', () => {
    const h = newHarness();
    addGossip(h, { text: 'ずっと前に聞いた話', islandDay: 1 });
    expect(h.reporter.take(h.petId, 10, 'みずね')).toBeNull();
  });

  test('新しい噂は新しい順に報告される', () => {
    const h = newHarness();
    addGossip(h, { text: 'ふるい話', islandDay: 2, tick: 2 * 14400 });
    addGossip(h, { text: 'あたらしい話', islandDay: 3, tick: 3 * 14400 });

    const report = h.reporter.take(h.petId, 3, 'みずね');
    expect(report?.items[0]?.text).toContain('あたらしい');
  });

  test('プロンプト用の噂は報告済みにしない（会話で自然に出す）', () => {
    const h = newHarness();
    addGossip(h, { text: '木の実の話', islandDay: 3 });

    const forPrompt = h.reporter.pendingForPrompt(h.petId, 3);
    expect(forPrompt).toHaveLength(1);
    // 取り出しても「報告済み」にはならない
    expect(h.reporter.hasPending(h.petId, 3)).toBe(true);
    expect(h.reporter.take(h.petId, 3, 'みずね')).not.toBeNull();
  });

  test('プロンプトに混ぜる噂は2件までに絞る', () => {
    const h = newHarness();
    for (let i = 0; i < 6; i++) addGossip(h, { text: `噂${i}`, islandDay: 3, tick: 3 * 14400 + i });
    expect(h.reporter.pendingForPrompt(h.petId, 3).length).toBeLessThanOrEqual(2);
  });

  test('噂の文面は「誰かが言っていた」形になっている（見た事実と混ぜない）', () => {
    const h = newHarness();
    addGossip(h, { text: '川むこうがきれいだった', islandDay: 3 });
    const report = h.reporter.take(h.petId, 3, 'みずね');
    expect(report?.items[0]?.text).toContain('ほしら');
  });

  test('statsで報告数が分かる', () => {
    const h = newHarness();
    addGossip(h, { text: 'はなし', islandDay: 3 });
    h.reporter.take(h.petId, 3, 'みずね');
    const s = h.reporter.stats();
    expect(s['reports']).toBe(1);
    expect(s['items']).toBe(1);
  });
});
