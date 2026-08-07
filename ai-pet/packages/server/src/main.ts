/**
 * サーバのエントリポイント。
 * Hono(HTTP) と ws(WebSocket) を同一HTTPサーバに載せ、島の復元→tick開始→保存までを面倒みる。
 */
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { WebSocketServer } from 'ws';
import { PROTOCOL_VERSION, TICK_HZ } from '@ai-pet/shared';
import { env, envSummary } from './env.ts';
import { ConnectionHub } from './net/hub.ts';
import { IslandSim } from './sim/island.ts';
import { spawnInitialCritters } from './sim/spawn.ts';
import { describeFastForward, fastForward, offlineMsToTicks } from './sim/fastforward.ts';
import { Repo } from './db/repo.ts';
import { PetRepo } from './db/petRepo.ts';
import { LlmClient } from './llm/client.ts';
import { Budget } from './llm/budget.ts';
import { DialogueService } from './pet/dialogue.ts';
import { GossipReporter } from './pet/gossipReport.ts';
import { PetTalkService } from './pet/petTalk.ts';
import { PetBrain } from './pet/brain.ts';
import { ReflectionService } from './pet/reflection.ts';
import { DailyCycle } from './pet/dailyCycle.ts';
import { PetManager } from './net/petHandlers.ts';
import {
  attachAutoSave,
  attachEventPersistence,
  resolveSeed,
  restoreIsland,
  saveIsland,
} from './sim/persistence.ts';

// ---------- 島の準備 ----------

const repo = new Repo(env.dbPath);
const { seed, existed } = resolveSeed(repo, env.islandId, env.islandSeed);
if (existed && seed !== env.islandSeed) {
  console.warn(`[island] DBのseed(${seed})を使います（ISLAND_SEED=${env.islandSeed} は無視。地形が変わるため）`);
}

const sim = new IslandSim({ islandId: env.islandId, seed });

let lastSaveAt = Date.now();
attachEventPersistence(sim, repo);
attachAutoSave(sim, repo, () => {
  lastSaveAt = Date.now();
});

// ---------- LLMとペット ----------

const budget = new Budget({ perPlayerPerHour: env.llmMaxRphPerPlayer });
const llm = new LlmClient({
  mode: env.llmMode,
  endpoint: env.azureEndpoint,
  apiKey: env.azureApiKey,
  apiVersion: env.azureApiVersion,
  model: env.petModel,
  budget,
  onUsage: (u) =>
    repo.insertLlmUsage({
      ts: Date.now(),
      playerId: u.playerId ?? null,
      purpose: u.purpose,
      promptTokens: u.promptTokens,
      completionTokens: u.completionTokens,
      latencyMs: u.latencyMs,
      ok: u.ok,
    }),
});
const petRepo = new PetRepo(repo.db);
const dialogue = new DialogueService(llm, petRepo, sim.world, sim.clock);
// 他のペットから聞いた話を、オーナーが戻ってきたときに優先して話題にする
const gossipReporter = new GossipReporter(petRepo);
dialogue.attachGossipReporter(gossipReporter);
const pets = new PetManager(sim, petRepo, dialogue);
sim.attachPets(pets);

// ペットが自分で次の行動を決める層（LLM。90秒/10分ごと）
const brain = new PetBrain(llm, petRepo, sim.world, sim.clock, sim.nav, {
  ownerActorOf: (ownerId) => pets.ownerActorOf(ownerId),
  activePets: () => pets.sessionList(),
  ownerNameOf: (playerId) => hub?.displayNameOf(playerId) ?? 'だれか',
});
pets.attachBrain(brain);
sim.onTick((tick) => brain.update(tick));

// ペット同士の会話（出会うと勝手に話す。噂が双方の記憶に残る）
const petTalk = new PetTalkService(llm, petRepo, sim.world, sim.clock, {
  activePets: () => pets.sessionList(),
  isOwnerOnline: (playerId) => hub?.displayNameOf(playerId) !== undefined,
  ownerNameOf: (playerId) => hub?.displayNameOf(playerId),
});
sim.onTick((tick) => petTalk.update(tick));
petTalk.onLine((entityId, text, delayMs) => {
  hub?.sendNearActorDelayed(entityId, { t: 'bubble', entityId, text, kind: 'say', ms: 3200 }, delayMs);
});
petTalk.onGossip((petId, gossip) => {
  hub?.notifyOwnerOfPet(petId, gossip, 5);
});

// 島日の終わりに日記を書き、長期記憶を圧縮する
const reflection = new ReflectionService(llm, petRepo, repo, sim.clock);
const daily = new DailyCycle(reflection, petRepo, sim.world, {
  allPetIds: () => pets.allPetIds(),
  petActorOf: (petId) => pets.petActorOfPetId(petId),
  ownerVisited: (petId) => pets.ownerVisitedToday(petId),
  onDiary: (petId, diary, affection) => hub?.sendDiary(petId, diary, affection),
});
sim.onIslandDayEnd((endedDay, tick) => daily.onIslandDayEnd(endedDay, tick));

// ---------- 島の復元（ペット系を組んだあとに行う） ----------
// 早送り中に島日をまたぐと日記が書かれるので、`daily` の登録より後でなければならない。

const restore = restoreIsland(sim, repo);
if (restore.restored) {
  console.log(
    `[island] 復元: tick=${restore.tick} ${restore.islandDay}日目 ` +
      `動物${restore.critters}体 資源${restore.resources}件 停止時間=${Math.round(restore.offlineMs / 1000)}秒`,
  );
  // 復元した時点で終わっている島日は書き直さない
  daily.setLastDoneIslandDay(sim.clock.islandDay - 1);
  // 島に残っていたペットをDBのペットと結び直す（記憶と日記の対象にするため）
  const rebound = pets.rebindRestoredPets();
  if (rebound > 0) console.log(`[island] 島に残っていたペット${rebound}匹を引き継ぎました`);

  // 停止していた空白を埋める（docs 04章§6）。ここで島日をまたぐと留守中の日記が書かれる
  const missedTicks = offlineMsToTicks(restore.offlineMs);
  if (missedTicks >= TICK_HZ) {
    console.log(`[island] ${describeFastForward(fastForward(sim, missedTicks))}`);
    saveIsland(sim, repo);
  }
} else {
  // 新規の島だけ動物を散布する（復元時に呼ぶと二重配置になる）
  const critters = spawnInitialCritters(sim.world);
  // 建設予定地（橋・井戸・天文台）もこのときだけ決める
  const built = sim.build.seedConstructions();
  console.log(
    `[island] 新規作成: seed=${seed} 動物${critters.length}体を配置 / ` +
      `建設予定地 ${built.map((b) => b.type).join('・') || 'なし'}`,
  );
  daily.setLastDoneIslandDay(sim.clock.islandDay - 1);
  saveIsland(sim, repo);
}

const hub = new ConnectionHub(sim, repo, pets, reflection, gossipReporter);

// 建設の文面にプレイヤー名を出す／橋の完成で地形が変わったらチャンクを送り直す
sim.setNameLookup((playerId) => hub.displayNameOf(playerId));
sim.onTerrainChanged((tiles) => hub.resendTerrain(tiles));
sim.start();

// ---------- HTTP ----------

const app = new Hono();

app.get('/healthz', (c) =>
  c.json({ ok: true, v: PROTOCOL_VERSION, tick: hub.tick(), clients: hub.clientCount() }),
);

if (env.isDev) {
  app.get('/metrics', (c) =>
    c.json({
      ...hub.metrics(),
      db: repo.path,
      lastSaveAgoSec: Math.round((Date.now() - lastSaveAt) / 1000),
      llm: { ...llm.stats(), health: llm.health(), usage1h: repo.llmUsageSummary(1) },
      brain: brain.stats(),
      reflection: reflection.stats(),
      gossip: gossipReporter.stats(),
      petTalk: petTalk.stats(),
      daily: daily.stats(),
      build: sim.build.stats(),
      interact: sim.interact.stats(),
    }),
  );
}

const server = serve({ fetch: app.fetch, port: env.port }, (info) => {
  console.log(`[server] http://localhost:${info.port}`);
  console.table(envSummary());
});

// ---------- WebSocket ----------

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  if (url.pathname !== '/ws') {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => hub.accept(ws));
});

// ---------- 停止処理 ----------

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] ${signal} 受信。停止処理を開始します`);
  try {
    hub.persistAllPlayers();
    hub.closeAll('サーバを再起動します');
    sim.stop();
    wss.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    saveIsland(sim, repo);
    repo.close();
    console.log('[server] 保存して停止しました');
  } catch (e) {
    console.error('[server] 停止処理でエラー', e);
  }
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
