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
import { ObjectLayer } from './render/objects.ts';
import { TimeTint } from './render/effects.ts';
import { WeatherLayer } from './render/weather.ts';
import { Minimap } from './render/minimap.ts';
import { WorldState, interpolatedPos } from './state/world.ts';
import { InputController } from './input.ts';
import { BubbleLayer, ChatUi } from './ui/chat.ts';
import { showEggSelect } from './ui/eggSelect.ts';
import { PetPanel } from './ui/petPanel.ts';
import { TouchPad, isTouchDevice } from './ui/touchPad.ts';
import { Tutorial } from './ui/tutorial.ts';
import { GameAudio, attachAudioToggle } from './ui/audio.ts';

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
const objectLayer = new ObjectLayer(stage.layers, textures.objects, camera);
const tint = new TimeTint(stage.layers);
const weather = new WeatherLayer(stage.layers);
const minimap = new Minimap();
const bubbles = new BubbleLayer();
const petPanel = new PetPanel();

let clock: ClockWire | null = null;
/** 自分のペット（表示名は吹き出しとチャットに使う） */
let petName = 'ペット';

// `?tut=1` で案内をやり直す（動作確認用）
if (params.has('tut')) Tutorial.reset();
const tutorial = new Tutorial();

// 音は既定OFF。HUDのボタンで切り替える
const audio = new GameAudio();
attachAudioToggle(audio);

const chat = new ChatUi({
  onSend: (text) => {
    chat.addLine('わたし', text);
    socket?.send({ t: 'say', text });
    tutorial.did('talk');
    audio.play('talk');
  },
});

function renderClock(): void {
  if (!hudClock || !clock) return;
  hudClock.textContent =
    `${clock.islandDay}日目 ${SEASON_LABEL[clock.season] ?? clock.season}・` +
    `${TOD_LABEL[clock.timeOfDay] ?? clock.timeOfDay} ${WEATHER_LABEL[clock.weather] ?? clock.weather}`;
  tint.setTimeOfDay(clock.timeOfDay);
  weather.setWeather(clock.weather);
  audio.setAmbience(clock.timeOfDay, clock.weather);
}

/** クリック地点のいちばん近い資源 */
function nearestResource(pos: Vec2, maxDist: number): { i: number; amt: number } | null {
  let best: { i: number; amt: number } | null = null;
  let bestD = maxDist;
  for (const r of world.resources.values()) {
    const d = Math.hypot(r.x - pos.x, r.y - pos.y);
    if (d <= bestD) {
      bestD = d;
      best = { i: r.id, amt: r.amount };
    }
  }
  return best;
}

/** クリック地点のいちばん近い建設中のもの */
function nearestConstruction(pos: Vec2, maxDist: number): { i: number } | null {
  let best: { i: number } | null = null;
  let bestD = maxDist;
  for (const c of constructions) {
    if (c.done) continue;
    const d = Math.hypot(c.x - pos.x, c.y - pos.y);
    if (d <= bestD) {
      bestD = d;
      best = { i: c.i };
    }
  }
  return best;
}

/** 共同建設の一覧（クリック判定とHUD表示に使う） */
let constructions: import('@ai-pet/shared').ConstructionWire[] = [];

/** 共同建設の進捗をHUDに出す（近くにあるものだけ） */
function renderConstructions(items: import('@ai-pet/shared').ConstructionWire[]): void {
  constructions = items;
  const el = document.getElementById('hud-build');
  if (!el) return;
  const active = items.filter((c) => !c.done);
  if (active.length === 0) {
    el.classList.add('hidden');
    return;
  }
  const label: Record<string, string> = { bridge: '橋', well: '井戸', observatory: '天文台' };
  const c = active[0];
  if (!c) return;
  el.textContent = `${label[c.ty] ?? c.ty} ${Math.round(c.p)}%${c.mine > 0 ? `（あなた ${Math.round(c.mine)}）` : ''}`;
  el.classList.remove('hidden');
}

/** ペットの懐き度と「いまの目標」をHUDに出す */
function renderPet(affection: number, reason?: string): void {
  const el = document.getElementById('hud-pet');
  if (!el) return;
  const hearts = '♥'.repeat(Math.max(1, Math.round(affection / 20))).padEnd(5, '·');
  el.textContent = `${petName} ${hearts}${reason ? ` / ${reason}` : ''}`;
  el.classList.remove('hidden');
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
  onMoveAxis: (dx, dy) => {
    socket?.send({ t: 'moveAxis', dx, dy });
    if (dx !== 0 || dy !== 0) tutorial.did('move');
  },
  onMoveTo: (tile) => {
    if (!canStand({ x: tile.x + 0.5, y: tile.y + 0.5 })) return;
    socket?.send({ t: 'move', to: tile });
    tutorial.did('move');
    // mockは経路探索がないので「サーバ側が瞬間移動させた」ことにする。
    // 予測位置はそのままにしておき、次のstepで来る値へ補正させる（補正経路の確認も兼ねる）
    if (mock) pendingTeleport = { x: tile.x + 0.5, y: tile.y + 0.5 };
  },
  onZoom: (dir) => camera.stepZoom(dir),
  onPick: (worldPos) => {
    // 対象の優先順は「自分のペット → 資源 → 建設中のもの」。
    // 触れるものが無ければクリック移動（onMoveTo）だけが働く
    const petId = world.petId;
    if (petId !== null) {
      const view = world.actors.get(petId);
      if (view) {
        const p = interpolatedPos(view, performance.now());
        if (Math.hypot(p.x - worldPos.x, p.y - worldPos.y) <= 1.2) {
          petPanel.show();
          socket?.send({ t: 'interact', targetId: petId, act: 'pet' });
          tutorial.did('pet');
          audio.play('pet');
          return;
        }
      }
    }

    const res = nearestResource(worldPos, 1.4);
    if (res) {
      // 在庫があれば収穫、無ければ水やり（畑と木にだけ効く）
      const act = res.amt >= 1 ? 'harvest' : 'water';
      socket?.send({ t: 'interact', targetId: res.i, act });
      tutorial.did('harvest');
      audio.play(act === 'harvest' ? 'harvest' : 'water');
      return;
    }

    const build = nearestConstruction(worldPos, 1.6);
    if (build) socket?.send({ t: 'contribute', constructionId: build.i });
  },
  onCall: () => petPanel.toggle(),
  onPlace: (type) => {
    // 自分の足元に置く（サーバ側で歩ける場所か・近すぎないかを検証する）
    const p = selfPos(performance.now());
    socket?.send({ t: 'place', type, pos: { x: Math.floor(p.x), y: Math.floor(p.y) } });
    tutorial.did('place');
    audio.play('place');
  },
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
      if (msg.pet) {
        world.petId = msg.pet.id;
        petName = msg.pet.name;
        renderPet(msg.pet.affection);
        petPanel.update({ name: msg.pet.name, species: msg.pet.species, affection: msg.pet.affection });
        tutorial.start();
      } else if (msg.petCatalog && msg.petCatalog.length > 0) {
        // ペットが居ないので、タマゴを選んでもらう
        showEggSelect(msg.petCatalog, (sel) => {
          socket?.send({ t: 'createPet', species: sel.species, name: sel.name, persona: sel.persona });
          tutorial.start();
        });
      }
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
    case 'terrainChanged': {
      // 地形が変わったチャンクは焼き直しが必要なので、未受信に戻して取り直す
      for (const [cx, cy] of msg.chunks) {
        world.forgetChunk(cx, cy);
        tilemap.invalidate(cx, cy);
        requestedAt.delete(cy * CHUNKS_X + cx);
      }
      minimap.invalidate();
      break;
    }
    case 'constructions':
      renderConstructions(msg.items);
      break;
    case 'bubble':
      bubbles.show(msg.entityId, msg.text, msg.ms, now);
      break;
    case 'chatChunk':
      chat.appendChunk(msg.convId, petName, msg.delta, msg.done);
      break;
    case 'notice':
      chat.notice(msg.text);
      // 日記は importance 6 で来る（1日の終わりなので合図を変える）
      audio.play((msg.importance ?? 0) >= 6 ? 'diary' : 'notice');
      break;
    case 'petState':
      renderPet(msg.affection, msg.intent?.reason);
      petPanel.update({
        affection: msg.affection,
        mood: msg.mood,
        ...(msg.intent ? { goal: msg.intent.goal, reason: msg.intent.reason } : {}),
      });
      break;
    case 'awaySummary':
      for (const line of msg.lines) chat.notice(line);
      break;
    case 'warn':
      // レート制限などはプレイヤーに見える形で伝える（黙って無視しない）
      if (msg.code === 'say_rate' || msg.code === 'too_far' || msg.code === 'busy') chat.notice(msg.message);
      else console.warn('[server warn]', msg.code, msg.message);
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

// ---------- スマホのバーチャルパッド ----------

/** タッチ端末のときだけ出す。`?pad=1` で強制表示（動作確認用） */
let touchPad: TouchPad | null = null;
if (isTouchDevice() || params.has('pad')) {
  document.body.classList.add('has-pad');
  touchPad = new TouchPad({
    onAxis: (dx, dy) => socket?.send({ t: 'moveAxis', dx, dy }),
    onCall: () => petPanel.toggle(),
    onPlace: (type) => {
      const p = selfPos(performance.now());
      socket?.send({ t: 'place', type, pos: { x: Math.floor(p.x), y: Math.floor(p.y) } });
      tutorial.did('place');
    audio.play('place');
    },
  });
}

// ---------- メインループ ----------

let lastFrameAt = performance.now();

stage.app.ticker.add(() => {
  const now = performance.now();
  const dtSec = Math.min(0.1, (now - lastFrameAt) / 1000);
  lastFrameAt = now;

  camera.resize(stage.app.renderer.width, stage.app.renderer.height);
  input.update(now);
  // キーボードとバーチャルパッドのどちらでも動く（同時に入っていればキーボードを優先）
  const pad = touchPad?.value ?? { dx: 0, dy: 0 };
  const axisX = input.axis.dx !== 0 ? input.axis.dx : pad.dx;
  const axisY = input.axis.dy !== 0 ? input.axis.dy : pad.dy;
  actorLayer.predictSelf(axisX, axisY, dtSec, canStand);
  camera.follow(selfPos(now));

  stage.layers.worldRoot.position.set(camera.containerX, camera.containerY);
  stage.layers.worldRoot.scale.set(camera.zoom);

  objectLayer.sync(world);
  actorLayer.sync(world, now, dtSec);
  tint.update(stage.app.renderer.width, stage.app.renderer.height, dtSec);
  weather.update(stage.app.renderer.width, stage.app.renderer.height, dtSec);
  tutorial.update(now);
  minimap.update(world);

  // 吹き出しはDOMなので、ワールド座標を画面座標に変換して位置だけ動かす
  bubbles.update(now, (entityId) => {
    const view = world.actors.get(entityId);
    if (!view) return null;
    const p = entityId === world.selfId && actorLayer.selfPos ? actorLayer.selfPos : interpolatedPos(view, now);
    const s = camera.worldToScreen(p);
    return { x: s.x, y: s.y - 34 * camera.zoom };
  });
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
    objects: objectLayer.drawn,
    pos: selfPos(performance.now()),
  }));
}
