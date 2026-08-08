/**
 * `petState` に空腹が乗ることのテスト（E-6）。
 *
 * ここで一番守りたいのは**反転していないこと**。
 * `Needs.hunger` は 0=満たされている / 100=空腹 の「需要値」で、
 * クライアント（`ui/petGauge.ts` の `fullnessRatio`）が `(100 - hunger)/100` に直して
 * 「おなか」バーにする。サーバでも反転すると二重反転で
 * **満腹と餓死寸前が入れ替わる**（バーが満タンのまま餓死する）。
 */
import { afterEach, describe, expect, test } from 'vitest';
import type { ServerMsg } from '@ai-pet/shared';
import { IslandSim } from '../../packages/server/src/sim/island.ts';
import { Repo } from '../../packages/server/src/db/repo.ts';
import { PetRepo } from '../../packages/server/src/db/petRepo.ts';
import { LlmClient } from '../../packages/server/src/llm/client.ts';
import { DialogueService } from '../../packages/server/src/pet/dialogue.ts';
import { PetManager, petToWire } from '../../packages/server/src/net/petHandlers.ts';
import { buildPersona } from '../../packages/server/src/pet/persona.ts';

const repos: Repo[] = [];
afterEach(() => {
  for (const r of repos.splice(0)) r.close();
});

function newHarness() {
  const sim = new IslandSim({ islandId: 'main', seed: 'pet-hunger' });
  const repo = new Repo(':memory:');
  repos.push(repo);
  const petRepo = new PetRepo(repo.db);
  // LLMは触らない（撫でる操作は口ぐせを返すだけでLLMを使わない）
  const llm = new LlmClient({
    mode: 'mock',
    endpoint: 'https://example.invalid/',
    apiKey: 'dummy',
    apiVersion: '2025-04-01-preview',
    model: 'gpt-5.6-luna',
  });
  const dialogue = new DialogueService(llm, petRepo, sim.world, sim.clock);
  const pets = new PetManager(sim, petRepo, dialogue);

  const player = repo.createPlayer({
    secret: 'secret-hunger',
    displayName: 'ためしびと',
    islandId: 'main',
    pos: sim.world.spawn,
  });
  const created = pets.create(
    player.id,
    { species: 'mofi', name: 'もふぃ', persona: {} },
    { x: sim.world.spawn.x, y: sim.world.spawn.y },
  );

  const sent: ServerMsg[] = [];
  const send = (m: ServerMsg): void => void sent.push(m);
  return { sim, repo, petRepo, pets, playerId: player.id, petActor: created.actor, petRow: created.pet, sent, send };
}

/** handlePet が送った petState を取り出す */
function petStateOf(sent: ServerMsg[]): Extract<ServerMsg, { t: 'petState' }> {
  const msg = sent.find((m) => m.t === 'petState');
  if (!msg || msg.t !== 'petState') throw new Error('petState が送られていない');
  return msg;
}

describe('petState の空腹（E-6）', () => {
  test('撫でると hunger が乗る', () => {
    const h = newHarness();
    h.petActor.needs.hunger = 37;
    h.pets.handlePet({ playerId: h.playerId, send: h.send });
    expect(petStateOf(h.sent).hunger).toBe(37);
  });

  test('満腹（needs.hunger=0）のときは 0 が来る＝反転していない', () => {
    const h = newHarness();
    h.petActor.needs.hunger = 0;
    h.pets.handlePet({ playerId: h.playerId, send: h.send });
    // ここが 100 になっていたら反転している（クライアント側で二重反転になる）
    expect(petStateOf(h.sent).hunger).toBe(0);
  });

  test('餓死寸前（needs.hunger=95）のときは 95 が来る', () => {
    const h = newHarness();
    h.petActor.needs.hunger = 95;
    h.pets.handlePet({ playerId: h.playerId, send: h.send });
    expect(petStateOf(h.sent).hunger).toBe(95);
  });

  test('welcome の PetWire にも生値が乗る（入島直後からバーを出せる）', () => {
    const h = newHarness();
    h.petActor.needs.hunger = 12;
    const wire = petToWire(h.petRow, h.petActor.id, h.petActor.needs.hunger);
    expect(wire.hunger).toBe(12);
    // 引数を省いた場合も「満たされている」側に倒す（未受信の縞は出さない）
    expect(petToWire(h.petRow, h.petActor.id).hunger).toBe(0);
  });
});
