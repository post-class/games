/**
 * アバター4色（D-5）と `petState` の空腹（E-6）を、`ConnectionHub` にWSを繋いだ形で確かめる。
 *
 * 実サーバを子プロセスで起こす形（`tests/integration/restart.spec.ts`）にしなかったのは、
 * **サーバを起こすテストファイルが3つ以上並ぶと CPU の取り合いで間欠失敗した**ため
 * （実際に restart / idleReap が同時実行で落ちた。AI_CODING.md §12 の負荷の話と同じ）。
 * 検証したいのは hello / createPet の応答とDBの往復だけなので、
 * `ws` の代わりに `send` と `on('message')` だけを持つ偽ソケットを渡している。
 */
import { afterEach, describe, expect, test } from 'vitest';
import type { WebSocket } from 'ws';
import type { ServerMsg } from '@ai-pet/shared';
import { IslandSim } from '../../packages/server/src/sim/island.ts';
import { Repo } from '../../packages/server/src/db/repo.ts';
import { PetRepo } from '../../packages/server/src/db/petRepo.ts';
import { LlmClient } from '../../packages/server/src/llm/client.ts';
import { DialogueService } from '../../packages/server/src/pet/dialogue.ts';
import { ReflectionService } from '../../packages/server/src/pet/reflection.ts';
import { GossipReporter } from '../../packages/server/src/pet/gossipReport.ts';
import { PetManager } from '../../packages/server/src/net/petHandlers.ts';
import { ConnectionHub } from '../../packages/server/src/net/hub.ts';
import { PLAYER_AVATARS, avatarFromPlayerId } from '../../packages/server/src/sim/actors.ts';

/** hub が使うのは readyState / send / on(message|close|error) だけ */
class FakeSocket {
  readyState = 1;
  readonly received: ServerMsg[] = [];
  private handlers = new Map<string, ((arg: unknown) => void)[]>();

  send(payload: string): void {
    this.received.push(JSON.parse(payload) as ServerMsg);
  }

  on(event: string, fn: (arg: unknown) => void): this {
    const list = this.handlers.get(event) ?? [];
    list.push(fn);
    this.handlers.set(event, list);
    return this;
  }

  terminate(): void {
    this.readyState = 3;
  }

  close(): void {
    this.readyState = 3;
    for (const fn of this.handlers.get('close') ?? []) fn(undefined);
  }

  /** クライアントからの1通を流し込む */
  clientSend(msg: unknown): void {
    for (const fn of this.handlers.get('message') ?? []) fn(JSON.stringify(msg));
  }

  last<T extends ServerMsg['t']>(t: T, nth = 1): Extract<ServerMsg, { t: T }> {
    const hits = this.received.filter((m) => m.t === t);
    const hit = hits[nth - 1];
    if (!hit) throw new Error(`${t} の${nth}件目が来ていない`);
    return hit as Extract<ServerMsg, { t: T }>;
  }

  asWs(): WebSocket {
    return this as unknown as WebSocket;
  }
}

interface Harness {
  hub: ConnectionHub;
  repo: Repo;
  /** 接続してhelloを送り、welcomeまで済ませたソケットを返す */
  join: (secret: string, displayName?: string) => FakeSocket;
}

const repos: Repo[] = [];
afterEach(() => {
  for (const r of repos.splice(0)) r.close();
});

function newHarness(): Harness {
  const sim = new IslandSim({ islandId: 'main', seed: 'avatar-hub' });
  const repo = new Repo(':memory:');
  repos.push(repo);
  const petRepo = new PetRepo(repo.db);
  const llm = new LlmClient({
    mode: 'mock',
    endpoint: 'https://example.invalid/',
    apiKey: 'dummy',
    apiVersion: '2025-04-01-preview',
    model: 'gpt-5.6-luna',
  });
  const pets = new PetManager(sim, petRepo, new DialogueService(llm, petRepo, sim.world, sim.clock));
  const hub = new ConnectionHub(
    sim,
    repo,
    pets,
    new ReflectionService(llm, petRepo, repo, sim.clock),
    new GossipReporter(petRepo),
  );

  const join = (secret: string, displayName = 'いろびと'): FakeSocket => {
    const sock = new FakeSocket();
    hub.accept(sock.asWs());
    sock.clientSend({ t: 'hello', v: 1, secret, displayName });
    return sock;
  };
  return { hub, repo, join };
}

const PERSONA = { traitTags: [], catchphrase: 'ふうん', likes: '', dislikes: '' };

describe('hello のアバター（D-5）', () => {
  test('species は a..d のどれか（player_a 固定ではない）', () => {
    const h = newHarness();
    const sock = h.join('secret-1');
    const w = sock.last('welcome');
    expect(PLAYER_AVATARS).toContain(w.you.s);
  });

  test('playerId のハッシュどおりに割り振られる（決定論）', () => {
    const h = newHarness();
    const sock = h.join('secret-2');
    const w = sock.last('welcome');
    expect(w.you.s).toBe(avatarFromPlayerId(w.playerId));
  });

  test('再接続をまたいで色が変わらない', () => {
    const h = newHarness();
    const first = h.join('secret-3');
    const before = first.last('welcome').you.s;
    first.close();

    const second = h.join('secret-3');
    expect(second.last('welcome').you.s).toBe(before);
  });
});

describe('createPet のアバター指定（D-5）', () => {
  test('選んだ色が入り、DBにも残る', () => {
    const h = newHarness();
    const sock = h.join('secret-4');
    const playerId = sock.last('welcome').playerId;
    sock.clientSend({ t: 'createPet', species: 'mofi', name: 'もふぃ', persona: PERSONA, avatar: 'd' });
    // createPet の応答は2通目の welcome
    expect(sock.last('welcome', 2).you.s).toBe('d');
    expect(h.repo.findPlayerById(playerId)?.avatar).toBe('d');
  });

  test('選んだ色は再接続後も維持される', () => {
    const h = newHarness();
    const sock = h.join('secret-5');
    sock.clientSend({ t: 'createPet', species: 'hakka', name: 'はっか', persona: PERSONA, avatar: 'c' });
    sock.close();

    const again = h.join('secret-5');
    expect(again.last('welcome').you.s).toBe('c');
  });

  test('avatar を送らなければ hello で決まった色のまま', () => {
    const h = newHarness();
    const sock = h.join('secret-6');
    const before = sock.last('welcome').you.s;
    sock.clientSend({ t: 'createPet', species: 'mizune', name: 'みずね', persona: PERSONA });
    expect(sock.last('welcome', 2).you.s).toBe(before);
  });

  test('不正な avatar のメッセージは弾かれる（ペットも作られない）', () => {
    const h = newHarness();
    const sock = h.join('secret-7');
    sock.clientSend({ t: 'createPet', species: 'mofi', name: 'もふぃ', persona: PERSONA, avatar: 'e' });
    expect(sock.received.some((m) => m.t === 'warn' && m.code === 'bad_message')).toBe(true);
    expect(sock.received.filter((m) => m.t === 'welcome')).toHaveLength(1);
  });
});

describe('welcome / petState の空腹（E-6）', () => {
  test('welcome の pet に生値の hunger が乗る', () => {
    const h = newHarness();
    const sock = h.join('secret-8');
    sock.clientSend({ t: 'createPet', species: 'mofi', name: 'もふぃ', persona: PERSONA });
    const pet = sock.last('welcome', 2).pet;
    expect(pet).not.toBeNull();
    // 生まれたばかりの個体は needs.hunger が 10..40（actors.ts の initialNeeds）。
    // 反転していると 60..90 になるので上限で気づける
    expect(pet?.hunger).toBeGreaterThanOrEqual(0);
    expect(pet?.hunger).toBeLessThanOrEqual(50);
  });

  test('撫でると petState に生値の hunger が乗る', () => {
    const h = newHarness();
    const sock = h.join('secret-9');
    sock.clientSend({ t: 'createPet', species: 'mofi', name: 'もふぃ', persona: PERSONA });
    const petId = sock.last('welcome', 2).pet?.id ?? 0;
    sock.clientSend({ t: 'interact', targetId: petId, act: 'pet' });
    const st = sock.last('petState');
    expect(typeof st.hunger).toBe('number');
    expect(st.hunger).toBeLessThanOrEqual(50);
  });
});
