/**
 * 荒廃度の送信プロトコル（G-6）のテスト。
 *
 * ここで守りたいのは2つ:
 *  1. クライアントの `TileMap.setChunkDecay()` が受け取れる形（長さ256・0..100）であること
 *  2. **変化がないときに1バイトも送らない**こと（帯域は約5.4KB/秒/人しか余裕がない）
 */
import { describe, expect, it } from 'vitest';
import { CHUNK, ChunkDecayWireSchema, Rng, type ServerMsg } from '@ai-pet/shared';
import { IslandWorld } from '../../packages/server/src/sim/world.ts';
import { createPlayerActor } from '../../packages/server/src/sim/actors.ts';
import {
  DECAY_MAX_CHUNKS_PER_PASS,
  DECAY_QUANT,
  SyncService,
  type ViewRect,
} from '../../packages/server/src/net/sync.ts';

function newWorld(): IslandWorld {
  return new IslandWorld(new Rng('decay'));
}

/** 20x14 の視界（sync.spec.ts と同じ作り） */
function view(cx: number, cy: number): ViewRect {
  return { x0: cx - 10, y0: cy - 7, x1: cx + 10, y1: cy + 7 };
}

/** 視界の中心が (cx,cy) のクライアントを1つ持つ SyncService */
function setup(cx = 20, cy = 20): { world: IslandWorld; sync: SyncService } {
  const world = newWorld();
  const me = createPlayerActor(world, { name: 'ぽこ', pos: { x: cx + 0.5, y: cy + 0.5 } });
  const sync = new SyncService(world);
  sync.addClient({ clientId: 'c1', actorId: me.id, petId: null, view: view(cx, cy) });
  return { world, sync };
}

function asChunkDecay(msg: ServerMsg): Extract<ServerMsg, { t: 'chunkDecay' }> {
  expect(msg.t).toBe('chunkDecay');
  return msg as Extract<ServerMsg, { t: 'chunkDecay' }>;
}

describe('chunkDecay のスキーマ', () => {
  it('長さ256・0..100の整数で送られる', () => {
    const { world, sync } = setup();
    world.addDecay(18, 22, 100);
    const msgs = sync.decayMessages('c1');
    expect(msgs.length).toBe(1);
    // クライアントは長さが違うと例外を投げるので、ここで形を固定しておく
    const parsed = ChunkDecayWireSchema.safeParse(msgs[0]);
    expect(parsed.success).toBe(true);
    const m = asChunkDecay(msgs[0] as ServerMsg);
    expect(m.decay.length).toBe(CHUNK * CHUNK);
  });

  it('行優先の並びで、荒れたタイルの位置が一致する', () => {
    const { world, sync } = setup();
    // チャンク(1,1) の中の (x=20,y=22) → チャンク内 (4,6)
    world.addDecay(20, 22, 60);
    const m = asChunkDecay(sync.decayMessages('c1')[0] as ServerMsg);
    expect([m.cx, m.cy]).toEqual([1, 1]);
    expect(m.decay[6 * CHUNK + 4]).toBe(60);
    // それ以外は0
    expect(m.decay.filter((v) => v !== 0).length).toBe(1);
  });

  it('上限を超える値は送られない（0..100に収まる）', () => {
    const { world, sync } = setup();
    world.addDecay(20, 22, 999);
    const m = asChunkDecay(sync.decayMessages('c1')[0] as ServerMsg);
    expect(Math.max(...m.decay)).toBe(100);
    expect(ChunkDecayWireSchema.safeParse(m).success).toBe(true);
  });
});

describe('chunkDecay は変化がないと送らない', () => {
  it('荒廃度が0の島では1通も送らない', () => {
    const { sync } = setup();
    expect(sync.decayMessages('c1')).toEqual([]);
    expect(sync.decayMessages('c1')).toEqual([]);
    expect(sync.stats().decayBytes).toBe(0);
  });

  it('2回目は送らない（同じ内容を送り直さない）', () => {
    const { world, sync } = setup();
    world.addDecay(20, 22, 50);
    expect(sync.decayMessages('c1').length).toBe(1);
    const bytes = sync.stats().decayBytes;
    expect(bytes).toBeGreaterThan(0);
    expect(sync.decayMessages('c1')).toEqual([]);
    expect(sync.decayMessages('c1')).toEqual([]);
    // 送っていないので統計も増えない
    expect(sync.stats().decayBytes).toBe(bytes);
  });

  it('量子化幅より小さい変化では送らない', () => {
    const { world, sync } = setup();
    world.addDecay(20, 22, 50);
    expect(sync.decayMessages('c1').length).toBe(1);
    // 見た目が変わらない差（tintは0..100を線形補間するだけ）
    world.addDecay(20, 22, DECAY_QUANT - 1);
    expect(sync.decayMessages('c1')).toEqual([]);
    // 量子化の段が変われば送る
    world.addDecay(20, 22, 1);
    const m = asChunkDecay(sync.decayMessages('c1')[0] as ServerMsg);
    expect(m.decay[6 * CHUNK + 4]).toBe(50 + DECAY_QUANT);
  });

  it('0に戻ったチャンクは「白へ戻す」1通だけ送る', () => {
    const { world, sync } = setup();
    world.addDecay(20, 22, 50);
    expect(sync.decayMessages('c1').length).toBe(1);
    world.addDecay(20, 22, -50);
    const msgs = sync.decayMessages('c1');
    expect(msgs.length).toBe(1);
    expect(Math.max(...asChunkDecay(msgs[0] as ServerMsg).decay)).toBe(0);
    // 以降は「全部0」なので送らない
    expect(sync.decayMessages('c1')).toEqual([]);
  });

  it('興味範囲の外は送らない', () => {
    const { world, sync } = setup(20, 20);
    // 視界(20x14)+VIEW_MARGIN(16) の外側
    world.addDecay(120, 120, 100);
    expect(sync.decayMessages('c1')).toEqual([]);
  });

  it('未知のクライアントには空を返す', () => {
    const { world, sync } = setup();
    world.addDecay(20, 22, 100);
    expect(sync.decayMessages('nobody')).toEqual([]);
    expect(sync.chunkDecayMessage('nobody', 1, 1)).toBeNull();
  });
});

describe('chunkDecay の帯域の上限', () => {
  it('1回のパスで送るチャンク数に上限がある', () => {
    const world = newWorld();
    // 視界の上限いっぱい（40x24）＋余裕16 で24チャンクぶんが興味範囲に入る
    const me = createPlayerActor(world, { name: 'ぽこ', pos: { x: 64.5, y: 64.5 } });
    const sync = new SyncService(world);
    sync.addClient({
      clientId: 'c1',
      actorId: me.id,
      petId: null,
      view: { x0: 44, y0: 52, x1: 84, y1: 76 },
    });
    // 興味範囲の全チャンクを荒らす
    for (let cy = 2; cy <= 5; cy++) {
      for (let cx = 1; cx <= 6; cx++) world.addDecay(cx * CHUNK + 1, cy * CHUNK + 1, 100);
    }
    const first = sync.decayMessages('c1');
    expect(first.length).toBe(DECAY_MAX_CHUNKS_PER_PASS);
    // 残りは次のパスへ回る（取りこぼさない）
    const second = sync.decayMessages('c1');
    expect(second.length).toBe(DECAY_MAX_CHUNKS_PER_PASS);
    const keys = new Set([...first, ...second].map((m) => JSON.stringify([m.t === 'chunkDecay' ? m.cx : -1, m.t === 'chunkDecay' ? m.cy : -1])));
    expect(keys.size).toBe(DECAY_MAX_CHUNKS_PER_PASS * 2);
  });

  it('1通あたりのバイト数は1KB未満（帯域の見積りを固定する）', () => {
    const { world, sync } = setup();
    for (let i = 0; i < CHUNK * CHUNK; i++) {
      world.addDecay(16 + (i % CHUNK), 16 + Math.floor(i / CHUNK), 100);
    }
    expect(sync.decayMessages('c1').length).toBe(1);
    // 全タイルが最大値（"100," が256個）でもこの程度に収まる
    expect(sync.stats().lastDecayBytes).toBeLessThan(1100);
  });
});

describe('chunkDecayMessage（chunkReq への相乗り）', () => {
  it('すでに送ったチャンクでも送り直す（相手は焼き直しで荒廃度を失っている）', () => {
    const { world, sync } = setup();
    world.addDecay(20, 22, 50);
    expect(sync.decayMessages('c1').length).toBe(1);
    const m = asChunkDecay(sync.chunkDecayMessage('c1', 1, 1) as ServerMsg);
    expect(m.decay[6 * CHUNK + 4]).toBe(50);
    // 送り直したあとは「送信済み」に戻るので、定期送信では出てこない
    expect(sync.decayMessages('c1')).toEqual([]);
  });

  it('荒れていないチャンクは null（1バイトも増えない）', () => {
    const { sync } = setup();
    expect(sync.chunkDecayMessage('c1', 1, 1)).toBeNull();
  });

  it('地図の外のチャンクは null', () => {
    const { sync } = setup();
    expect(sync.chunkDecayMessage('c1', -1, 0)).toBeNull();
    expect(sync.chunkDecayMessage('c1', 99, 0)).toBeNull();
  });
});
