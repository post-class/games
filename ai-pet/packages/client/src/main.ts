/**
 * クライアントのエントリポイント。
 *
 * M1: 地形（チャンク焼成）・カメラ・入力・アクター描画を組み立てる。
 * `?mock=1` のときは **サーバなしで** ローカル生成した島とダミーアクターを描く
 * （サーバ側は別作業者の担当なので、描画だけを単体検証できるようにしてある）。
 */
import type { ClockWire, ServerMsg, Vec2 } from '@ai-pet/shared';
import { CHUNK, CHUNKS_X, CHUNKS_Y, TERRAINS } from '@ai-pet/shared';
import { GameSocket, type ConnState } from './net/socket.ts';
import { createStage } from './render/stage.ts';
import { loadTextures } from './render/assets.ts';
import { Camera } from './render/camera.ts';
import { TileMap } from './render/tilemap.ts';
import { ActorLayer } from './render/sprites.ts';
import { TimeTint } from './render/effects.ts';
import { WorldState, interpolatedPos } from './state/world.ts';
import { InputController } from './input.ts';

const SEASON_LABEL: Record<string, string> = { spring: '春', summer: '夏', autumn: '秋', winter: '冬' };
const TOD_LABEL: Record<string, string> = { morning: '朝', day: '昼', evening: '夕', night: '夜' };
const WEATHER_LABEL: Record<string, string> = { clear: '☀️晴れ', cloudy: '☁️くもり', rain: '☔️あめ', fog: '🌫️きり' };

const params = new URLSearchParams(location.search);
const MOCK = params.has('mock');
const T_WATER = TERRAINS.indexOf('water');

const host = document.getElementById('game');
if (!host) throw new Error('#game が見つかりません');

const hudClock = document.getElementById('hud-clock');
const hudNet = document.getElementById('hud-net');
const boot = document.getElementById('boot');
const bootMsg = document.getElementById('boot-msg');

const stage = await createStage(host);
const textures = await loadTextures();
console.log('[client] stage ready', stage.app.renderer.type);

// ---------- 世界と描画 ----------

const world = new WorldState();
const camera = new Camera({ viewW: stage.app.renderer.width, viewH: stage.app.renderer.height });
const tilemap = new TileMap(stage.app.renderer, stage.layers, textures.terrain, CHUNKS_X);
const actorLayer = new ActorLayer(stage.layers, textures.chars, camera);
const tint = new TimeTint(stage.layers);

let clock: ClockWire | null = null;

function renderClock(): void {
  if (!hudClock || !clock) return;
  hudClock.textContent =
    `${clock.islandDay}日目 ${SEASON_LABEL[clock.season] ?? clock.season}・` +
    `${TOD_LABEL[clock.timeOfDay] ?? clock.timeOfDay} ${WEATHER_LABEL[clock.weather] ?? clock.weather}`;
  tint.setTimeOfDay(clock.timeOfDay);
}

function renderNet(state: ConnState, rttMs: number): void {
  if (!hudNet) return;
  const label: Record<ConnState, string> = {
    connecting: '接続中…',
    open: `接続OK ${rttMs}ms`,
    reconnecting: '再接続中…',
    closed: '切断',
  };
  hudNet.textContent = label[state];
  hudNet.className = 'hud-chip' + (state === 'open' ? '' : state === 'connecting' ? ' warn' : ' bad');
}

/** 自アバターの描画位置（予測を優先。無ければ補間値、それも無ければ島の中心） */
function selfPos(nowMs: number): Vec2 {
  if (actorLayer.selfPos) return actorLayer.selfPos;
  const id = world.selfId;
  const view = id === null ? undefined : world.actors.get(id);
  return view ? interpolatedPos(view, nowMs) : { x: camera.mapW / 2, y: camera.mapH / 2 };
}

/** 予測移動の当たり判定（未受信タイルは通す＝最終判定はサーバ） */
function canStand(p: Vec2): boolean {
  const t = world.terrainAt(Math.floor(p.x), Math.floor(p.y));
  return t !== T_WATER;
}

// ---------- 地形チャンクの要求 ----------

/** 要求した時刻（ms）。応答が来たら world.hasChunk が true になるので、来なければ再要求する */
const requestedAt = new Map<number, number>();
/** 再要求までの待ち時間。往復＋サーバのチャンク生成を考えても十分な余裕 */
const CHUNK_RETRY_MS = 3000;

/**
 * 視界＋1チャンクぶんの範囲で、未受信かつ（未要求 or 要求から一定時間経過した）チャンクを列挙する。
 * メッセージが落ちたときに地形に穴が残らないよう、タイムアウトで再要求する。
 */
function missingChunks(): [number, number][] {
  const r = camera.visibleRect(CHUNK);
  const cx0 = Math.max(0, Math.floor(r.x0 / CHUNK));
  const cy0 = Math.max(0, Math.floor(r.y0 / CHUNK));
  const cx1 = Math.min(CHUNKS_X - 1, Math.floor(r.x1 / CHUNK));
  const cy1 = Math.min(CHUNKS_Y - 1, Math.floor(r.y1 / CHUNK));
  const now = performance.now();
  const out: [number, number][] = [];
  for (let cy = cy0; cy <= cy1; cy++) {
    for (let cx = cx0; cx <= cx1; cx++) {
      const key = cy * CHUNKS_X + cx;
      if (world.hasChunk(cx, cy)) {
        requestedAt.delete(key);
        continue;
      }
      const sentAt = requestedAt.get(key);
      if (sentAt !== undefined && now - sentAt < CHUNK_RETRY_MS) continue;
      requestedAt.set(key, now);
      out.push([cx, cy]);
      if (out.length >= 32) return out;
    }
  }
  return out;
}

/** 再接続時は要求済み記録を捨てる（サーバ側の送信済み状態がリセットされるため） */
function resetChunkRequests(): void {
  requestedAt.clear();
}

// ---------- 入力 ----------

let socket: GameSocket | null = null;
let mock: import('./dev/mock.ts').MockIsland | null = null;
/** mockでのクリック移動（次のstepでサーバ値として反映する） */
let pendingTeleport: Vec2 | null = null;

const input = new InputController(host, camera, {
  onMoveAxis: (dx, dy) => socket?.send({ t: 'moveAxis', dx, dy }),
  onMoveTo: (tile) => {
    if (!canStand({ x: tile.x + 0.5, y: tile.y + 0.5 })) return;
    socket?.send({ t: 'move', to: tile });
    // mockは経路探索がないので「サーバ側が瞬間移動させた」ことにする。
    // 予測位置はそのままにしておき、次のstepで来る値へ補正させる（補正経路の確認も兼ねる）
    if (mock) pendingTeleport = { x: tile.x + 0.5, y: tile.y + 0.5 };
  },
  onZoom: (dir) => camera.stepZoom(dir),
});

// ---------- サーバ接続（通常モード） ----------

function onMessage(msg: ServerMsg): void {
  const now = performance.now();
  switch (msg.t) {
    case 'welcome':
      clock = msg.clock;
      renderClock();
      world.selfId = msg.entityId;
      world.applyDelta({ tick: msg.clock.tick, add: [msg.you] }, now);
      actorLayer.setSelf({ x: msg.you.x, y: msg.you.y });
      camera.snapTo({ x: msg.you.x, y: msg.you.y });
      if (msg.pet) world.petId = msg.pet.id;
      boot?.classList.add('hidden');
      console.log('[client] welcome', { playerId: msg.playerId, entityId: msg.entityId, seed: msg.seed });
      break;
    case 'chunk': {
      const applied = world.applyChunk(msg);
      tilemap.applyChunk(applied.cx, applied.cy, applied.tiles);
      break;
    }
    case 'snapshot':
      world.applySnapshot(msg, now);
      clock = msg.clock;
      renderClock();
      break;
    case 'delta':
      world.applyDelta(msg, now);
      if (msg.clock) {
        clock = msg.clock;
        renderClock();
      }
      break;
    case 'serverClosing':
      if (bootMsg) bootMsg.textContent = msg.reason;
      boot?.classList.remove('hidden');
      break;
    case 'warn':
      console.warn('[server warn]', msg.code, msg.message);
      break;
    default:
      break;
  }
}

if (!MOCK) {
  socket = new GameSocket({
    onMessage,
    onState: (state, info) => {
      renderNet(state, info.rttMs);
      // 再接続したらチャンクを取り直す（サーバ側の送信済み状態がリセットされている）
      if (state === 'reconnecting') resetChunkRequests();
    },
  });
  socket.connect();

  // 視界に入ったチャンクを要求する（未受信のみ）
  setInterval(() => {
    if (world.selfId === null) return;
    const chunks = missingChunks();
    if (chunks.length > 0) socket?.send({ t: 'chunkReq', chunks });
  }, 250);
} else {
  // ---------- mockモード（サーバなし） ----------
  const { MockIsland } = await import('./dev/mock.ts');
  mock = new MockIsland(params.get('seed') ?? 'pokomofu');
  world.selfId = mock.selfId;
  world.applySnapshot(mock.snapshot(), performance.now());
  clock = mock.clock();
  renderClock();
  actorLayer.setSelf(mock.spawn);
  camera.snapTo(mock.spawn);
  boot?.classList.add('hidden');
  if (hudNet) {
    hudNet.textContent = 'mock（サーバなし）';
    hudNet.className = 'hud-chip warn';
  }

  // チャンクは要求に応じてローカル生成
  setInterval(() => {
    if (!mock) return;
    for (const [cx, cy] of missingChunks()) {
      const applied = world.applyChunk({ cx, cy, terrain: mock.chunkRle(cx, cy) });
      tilemap.applyChunk(applied.cx, applied.cy, applied.tiles);
    }
  }, 100);

  // サーバのtick相当（4Hz）
  setInterval(() => {
    if (!mock) return;
    if (pendingTeleport) {
      mock.setSelfPos(pendingTeleport);
      pendingTeleport = null;
    } else if (actorLayer.selfPos) {
      mock.setSelfPos(actorLayer.selfPos);
    }
    const d = mock.step(0.25);
    world.applyDelta(d, performance.now());
    clock = d.clock;
    renderClock();
  }, 250);
}

// ---------- メインループ ----------

let lastFrameAt = performance.now();

stage.app.ticker.add(() => {
  const now = performance.now();
  const dtSec = Math.min(0.1, (now - lastFrameAt) / 1000);
  lastFrameAt = now;

  camera.resize(stage.app.renderer.width, stage.app.renderer.height);
  input.update(now);
  actorLayer.predictSelf(input.axis.dx, input.axis.dy, dtSec, canStand);
  camera.follow(selfPos(now));

  stage.layers.worldRoot.position.set(camera.containerX, camera.containerY);
  stage.layers.worldRoot.scale.set(camera.zoom);

  actorLayer.sync(world, now, dtSec);
  tint.update(stage.app.renderer.width, stage.app.renderer.height, dtSec);
});

// 島時間はサーバのtickから来るが、HUDは1秒ごとに進行度を補って表示する
setInterval(() => {
  if (clock && !MOCK) {
    clock.tick += 4;
    renderClock();
  }
}, 1000);

if (params.has('debug')) {
  const { attachDebugPanel } = await import('./ui/debug.ts');
  attachDebugPanel(stage.app, () => ({
    rttMs: socket?.rttMs ?? 0,
    state: MOCK ? 'mock' : (socket?.state ?? 'closed'),
    tick: clock?.tick ?? 0,
    actors: world.actors.size,
    drawn: actorLayer.drawn,
    chunks: tilemap.count,
    zoom: camera.zoom,
    pos: selfPos(performance.now()),
  }));
}
