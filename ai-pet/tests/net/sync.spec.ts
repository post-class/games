/**
 * sync.ts（興味管理 / snapshot / delta）のテスト
 * worldgen には依存しない。既定の世界は全面 grass（TERRAINS[0]）。
 */
import { describe, expect, it } from 'vitest';
import { Rng, VIEW_MARGIN, type ActorDelta, type ActorWire, type ClockWire, type ServerMsg } from '@ai-pet/shared';
import { IslandWorld } from '../../packages/server/src/sim/world.ts';
import { createCritterActor, createPetActor, createPlayerActor } from '../../packages/server/src/sim/actors.ts';
import { SyncService, type ViewRect } from '../../packages/server/src/net/sync.ts';

function newWorld(): IslandWorld {
  return new IslandWorld(new Rng('t'));
}

const CLOCK: ClockWire = {
  tick: 1,
  islandDay: 1,
  dayProgress: 0.1,
  timeOfDay: 'morning',
  season: 'spring',
  weather: 'clear',
};

/** 20x14 の視界（VIEW_MAX を超えないサイズ） */
function view(cx: number, cy: number): ViewRect {
  return { x0: cx - 10, y0: cy - 7, x1: cx + 10, y1: cy + 7 };
}

function asDelta(msg: ServerMsg | null): Extract<ServerMsg, { t: 'delta' }> {
  expect(msg).not.toBeNull();
  const m = msg as ServerMsg;
  expect(m.t).toBe('delta');
  return m as Extract<ServerMsg, { t: 'delta' }>;
}

function asSnapshot(msg: ServerMsg): Extract<ServerMsg, { t: 'snapshot' }> {
  expect(msg.t).toBe('snapshot');
  return msg as Extract<ServerMsg, { t: 'snapshot' }>;
}

describe('SyncService snapshot', () => {
  it('範囲内のアクターだけを含む', () => {
    const w = newWorld();
    const me = createPlayerActor(w, { name: 'ぽこ', pos: { x: 20.5, y: 20.5 } });
    const near = createCritterActor(w, { species: 'rabbit', pos: { x: 24.5, y: 20.5 } });
    const far = createCritterActor(w, { species: 'cat', pos: { x: 100.5, y: 100.5 } });

    const sync = new SyncService(w);
    sync.addClient({ clientId: 'c1', actorId: me.id, petId: null, view: view(20, 20) });
    const snap = asSnapshot(sync.snapshotMessage('c1', CLOCK));

    const ids = snap.actors.map((a) => a.i);
    expect(ids).toContain(me.id);
    expect(ids).toContain(near.id);
    expect(ids).not.toContain(far.id);
    expect(snap.tick).toBe(CLOCK.tick);
  });

  it('snapshot 直後の delta は null（変化がない）', () => {
    const w = newWorld();
    const me = createPlayerActor(w, { name: 'ぽこ', pos: { x: 20.5, y: 20.5 } });
    createCritterActor(w, { species: 'rabbit', pos: { x: 22.5, y: 20.5 } });
    const sync = new SyncService(w);
    sync.addClient({ clientId: 'c1', actorId: me.id, petId: null, view: view(20, 20) });
    sync.snapshotMessage('c1', CLOCK);
    expect(sync.deltaMessage('c1', 2)).toBeNull();
  });
});

describe('SyncService delta の add / rm', () => {
  it('初回の delta は範囲内アクターを add で送る', () => {
    const w = newWorld();
    const me = createPlayerActor(w, { name: 'ぽこ', pos: { x: 20.5, y: 20.5 } });
    const other = createCritterActor(w, { species: 'rabbit', pos: { x: 22.5, y: 20.5 } });
    const sync = new SyncService(w);
    sync.addClient({ clientId: 'c1', actorId: me.id, petId: null, view: view(20, 20) });

    const d = asDelta(sync.deltaMessage('c1', 1));
    const added = (d.add ?? []).map((a: ActorWire) => a.i);
    expect(added).toContain(me.id);
    expect(added).toContain(other.id);
    expect(d.rm).toBeUndefined();
  });

  it('範囲に入ると add、出ると rm が出る', () => {
    const w = newWorld();
    const me = createPlayerActor(w, { name: 'ぽこ', pos: { x: 20.5, y: 20.5 } });
    // マージンを超えて十分遠くに置く
    const roamer = createCritterActor(w, { species: 'cat', pos: { x: 20.5 + 10 + VIEW_MARGIN + 5, y: 20.5 } });
    const sync = new SyncService(w);
    sync.addClient({ clientId: 'c1', actorId: me.id, petId: null, view: view(20, 20) });

    const first = asDelta(sync.deltaMessage('c1', 1));
    expect((first.add ?? []).map((a: ActorWire) => a.i)).not.toContain(roamer.id);

    // 範囲内へ移動 → add
    roamer.pos = { x: 25.5, y: 20.5 };
    const entered = asDelta(sync.deltaMessage('c1', 2));
    expect((entered.add ?? []).map((a: ActorWire) => a.i)).toContain(roamer.id);

    // 変化なし → null
    expect(sync.deltaMessage('c1', 3)).toBeNull();

    // 範囲外へ移動 → rm
    roamer.pos = { x: 20.5 + 10 + VIEW_MARGIN + 5, y: 20.5 };
    const left = asDelta(sync.deltaMessage('c1', 4));
    expect(left.rm).toEqual([roamer.id]);

    // 退場も rm（もう送るものがない）
    expect(sync.deltaMessage('c1', 5)).toBeNull();
  });

  it('アクターが退場すると rm が出る', () => {
    const w = newWorld();
    const me = createPlayerActor(w, { name: 'ぽこ', pos: { x: 20.5, y: 20.5 } });
    const other = createCritterActor(w, { species: 'cat', pos: { x: 22.5, y: 20.5 } });
    const sync = new SyncService(w);
    sync.addClient({ clientId: 'c1', actorId: me.id, petId: null, view: view(20, 20) });
    sync.deltaMessage('c1', 1);

    w.removeActor(other.id);
    const d = asDelta(sync.deltaMessage('c1', 2));
    expect(d.rm).toEqual([other.id]);
  });
});

describe('SyncService delta の upd 閾値', () => {
  it('0.02タイル未満の移動では upd が出ない', () => {
    const w = newWorld();
    const me = createPlayerActor(w, { name: 'ぽこ', pos: { x: 20.5, y: 20.5 } });
    const sync = new SyncService(w);
    sync.addClient({ clientId: 'c1', actorId: me.id, petId: null, view: view(20, 20) });
    sync.deltaMessage('c1', 1);

    me.pos.x += 0.01;
    expect(sync.deltaMessage('c1', 2)).toBeNull();
  });

  it('0.02タイル以上の移動で upd が出る', () => {
    const w = newWorld();
    const me = createPlayerActor(w, { name: 'ぽこ', pos: { x: 20.5, y: 20.5 } });
    const sync = new SyncService(w);
    sync.addClient({ clientId: 'c1', actorId: me.id, petId: null, view: view(20, 20) });
    sync.deltaMessage('c1', 1);

    me.pos.x += 0.03;
    const d = asDelta(sync.deltaMessage('c1', 2));
    expect(d.upd).toBeDefined();
    const u = (d.upd as ActorDelta[])[0] as ActorDelta;
    expect(u.i).toBe(me.id);
    expect(u.x).toBeCloseTo(20.53, 6);
    expect(u.y).toBeUndefined();
  });

  it('微小な移動が積み上がれば upd が出る（誤差が溜まらない）', () => {
    const w = newWorld();
    const me = createPlayerActor(w, { name: 'ぽこ', pos: { x: 20.5, y: 20.5 } });
    const sync = new SyncService(w);
    sync.addClient({ clientId: 'c1', actorId: me.id, petId: null, view: view(20, 20) });
    sync.deltaMessage('c1', 1);

    let sent = 0;
    for (let i = 0; i < 10; i++) {
      me.pos.x += 0.01;
      if (sync.deltaMessage('c1', 2 + i) !== null) sent++;
    }
    expect(sent).toBeGreaterThan(0);
  });

  it('facing / anim は変化時のみ含まれる', () => {
    const w = newWorld();
    const me = createPlayerActor(w, { name: 'ぽこ', pos: { x: 20.5, y: 20.5 } });
    const sync = new SyncService(w);
    sync.addClient({ clientId: 'c1', actorId: me.id, petId: null, view: view(20, 20) });
    sync.deltaMessage('c1', 1);

    me.facing = 'n';
    me.anim = 'walk';
    const d1 = asDelta(sync.deltaMessage('c1', 2));
    const u1 = (d1.upd as ActorDelta[])[0] as ActorDelta;
    expect(u1.f).toBe(0);
    expect(u1.a).toBe(1);
    expect(u1.x).toBeUndefined();

    expect(sync.deltaMessage('c1', 3)).toBeNull();
  });
});

describe('SyncService 常時送信対象', () => {
  it('自分のアクターと自分のペットは範囲外でも送られる', () => {
    const w = newWorld();
    const me = createPlayerActor(w, { name: 'ぽこ', pos: { x: 100.5, y: 100.5 } });
    const pet = createPetActor(w, { species: 'mofi', name: 'もふ', ownerId: 'p1', pos: { x: 110.5, y: 110.5 } });
    const stranger = createCritterActor(w, { species: 'cat', pos: { x: 105.5, y: 105.5 } });

    const sync = new SyncService(w);
    // 視界は原点付近。自分もペットも範囲外
    sync.addClient({ clientId: 'c1', actorId: me.id, petId: pet.id, view: view(20, 20) });

    const d = asDelta(sync.deltaMessage('c1', 1));
    const ids = (d.add ?? []).map((a: ActorWire) => a.i);
    expect(ids).toContain(me.id);
    expect(ids).toContain(pet.id);
    expect(ids).not.toContain(stranger.id);
  });

  it('ペットのワイヤには ownerId が入る', () => {
    const w = newWorld();
    const me = createPlayerActor(w, { name: 'ぽこ', pos: { x: 20.5, y: 20.5 } });
    const pet = createPetActor(w, { species: 'mofi', name: 'もふ', ownerId: 'p1', pos: { x: 21.5, y: 20.5 } });
    const sync = new SyncService(w);
    sync.addClient({ clientId: 'c1', actorId: me.id, petId: pet.id, view: view(20, 20) });
    const d = asDelta(sync.deltaMessage('c1', 1));
    const petWire = (d.add ?? []).find((a: ActorWire) => a.i === pet.id) as ActorWire;
    expect(petWire.o).toBe('p1');
    expect(petWire.k).toBe(1);
  });
});

describe('SyncService 資源とチャンク', () => {
  it('在庫が変化した資源だけ res に含まれる', () => {
    const w = newWorld();
    const me = createPlayerActor(w, { name: 'ぽこ', pos: { x: 20.5, y: 20.5 } });
    const tree = w.addResource({
      id: w.allocId(),
      type: 'berry_tree',
      pos: { x: 22.5, y: 20.5 },
      amount: 6,
      max: 6,
      regenPerIslandHour: 0.6,
    });
    const sync = new SyncService(w);
    sync.addClient({ clientId: 'c1', actorId: me.id, petId: null, view: view(20, 20) });
    sync.snapshotMessage('c1', CLOCK);

    expect(sync.deltaMessage('c1', 2)).toBeNull();

    tree.amount = 4;
    const d = asDelta(sync.deltaMessage('c1', 3));
    expect(d.res).toEqual([{ i: tree.id, amt: 4 }]);
    expect(sync.deltaMessage('c1', 4)).toBeNull();
  });

  it('chunkMessage は RLE 地形とチャンク内の資源を返す', () => {
    const w = newWorld();
    w.setTerrain(0, 0, 'water');
    w.addResource({
      id: w.allocId(),
      type: 'field',
      pos: { x: 3.5, y: 3.5 },
      amount: 10,
      max: 10,
      regenPerIslandHour: 0.4,
    });
    const sync = new SyncService(w);
    const msg = sync.chunkMessage(0, 0);
    expect(msg.t).toBe('chunk');
    const m = msg as Extract<ServerMsg, { t: 'chunk' }>;
    // RLE は [値, 個数, ...]。合計は 16*16 = 256
    let total = 0;
    for (let i = 1; i < m.terrain.length; i += 2) total += m.terrain[i] as number;
    expect(total).toBe(256);
    expect(m.resources.length).toBe(1);
  });
});

describe('SyncService その他', () => {
  it('clock を渡せば変化がなくても送る', () => {
    const w = newWorld();
    const me = createPlayerActor(w, { name: 'ぽこ', pos: { x: 20.5, y: 20.5 } });
    const sync = new SyncService(w);
    sync.addClient({ clientId: 'c1', actorId: me.id, petId: null, view: view(20, 20) });
    sync.deltaMessage('c1', 1);
    const d = asDelta(sync.deltaMessage('c1', 2, CLOCK));
    expect(d.clock).toEqual(CLOCK);
  });

  it('updateView で配信範囲が変わる', () => {
    const w = newWorld();
    const me = createPlayerActor(w, { name: 'ぽこ', pos: { x: 20.5, y: 20.5 } });
    const other = createCritterActor(w, { species: 'cat', pos: { x: 80.5, y: 80.5 } });
    const sync = new SyncService(w);
    sync.addClient({ clientId: 'c1', actorId: me.id, petId: null, view: view(20, 20) });
    sync.deltaMessage('c1', 1);

    sync.updateView('c1', view(80, 80));
    const d = asDelta(sync.deltaMessage('c1', 2));
    expect((d.add ?? []).map((a: ActorWire) => a.i)).toContain(other.id);
  });

  it('removeClient 後は null を返す', () => {
    const w = newWorld();
    const me = createPlayerActor(w, { name: 'ぽこ', pos: { x: 20.5, y: 20.5 } });
    const sync = new SyncService(w);
    sync.addClient({ clientId: 'c1', actorId: me.id, petId: null, view: view(20, 20) });
    sync.removeClient('c1');
    expect(sync.deltaMessage('c1', 1)).toBeNull();
    expect(sync.stats().clients).toBe(0);
  });

  it('stats が送信バイト数を数える', () => {
    const w = newWorld();
    const me = createPlayerActor(w, { name: 'ぽこ', pos: { x: 20.5, y: 20.5 } });
    const sync = new SyncService(w);
    sync.addClient({ clientId: 'c1', actorId: me.id, petId: null, view: view(20, 20) });
    sync.snapshotMessage('c1', CLOCK);
    me.pos.x += 1;
    sync.deltaMessage('c1', 2);
    const s = sync.stats();
    expect(s.clients).toBe(1);
    expect(s.lastDeltaBytes).toBeGreaterThan(0);
    expect(s.totalBytes).toBeGreaterThan(s.lastDeltaBytes);
  });
});
