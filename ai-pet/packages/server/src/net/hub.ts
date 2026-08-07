/**
 * 接続管理（docs/02_ゲーム実装プラン/05_通信プロトコル.md）
 *
 * 役割:
 * - WSの受け付け・認証（M1は匿名で毎回新規。M2で永続化）
 * - 受信メッセージの検証とレート制限
 * - プレイヤーアクターの生成・破棄
 * - 毎tickの差分ブロードキャスト（興味管理は SyncService）
 */
import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import {
  CHUNK,
  MAP_H,
  MAP_W,
  PROTOCOL_VERSION,
  RATE_LIMITS,
  SNAPSHOT_INTERVAL_TICKS,
  TICK_HZ,
  VIEW_MAX_H,
  VIEW_MAX_W,
  parseClientMsg,
  type Actor,
  type ClientMsgType,
  type EntityId,
  type ServerMsg,
  type Vec2,
} from '@ai-pet/shared';
import { actorToWire, createPlayerActor } from '../sim/actors.ts';
import { clearAxisInput, forgetActor, setAxisInput } from '../sim/movement.ts';
import type { IslandSim } from '../sim/island.ts';
import type { Repo } from '../db/repo.ts';
import { SyncService, type ViewRect } from './sync.ts';
import { petCatalog, petToWire, type PetManager } from './petHandlers.ts';
import type { ReflectionService } from '../pet/reflection.ts';
import type { GossipReporter } from '../pet/gossipReport.ts';

/** 島時間を送る間隔（変化がないときでも定期的に同期する） */
const CLOCK_RESEND_TICKS = TICK_HZ * 4;

interface Client {
  ws: WebSocket;
  playerId: string;
  secret: string;
  displayName: string;
  entityId: EntityId;
  joined: boolean;
  /** メッセージ種別ごとの直近呼び出し時刻（レート制限用） */
  rate: Map<string, number[]>;
}

const PLACEABLE_LABEL: Record<string, string> = {
  bench: 'ベンチ',
  flowerbed: '花壇',
  lantern: 'ランタン',
  signboard: '看板',
};

const CONSTRUCTION_LABEL: Record<string, string> = { bridge: '橋', well: '井戸', observatory: '天文台' };

function placeableLabel(type: string): string {
  return PLACEABLE_LABEL[type] ?? type;
}

function constructionLabel(type: string): string {
  return CONSTRUCTION_LABEL[type] ?? type;
}

/** 設置できなかった理由を1文にする */
function placeMessage(reason: string): string {
  const map: Record<string, string> = {
    not_walkable: 'そこには置けません',
    occupied: 'すでに何かあります',
    too_close: 'すこし離して置いてください',
    too_many: 'これ以上は置けません（古いものを片づけてください）',
    out_of_range: '足もとの近くにしか置けません',
    unknown_type: 'それは置けません',
  };
  return map[reason] ?? '置けませんでした';
}

/** 建設に手伝えなかった理由を1文にする */
function contributeMessage(reason: string): string {
  const map: Record<string, string> = {
    not_found: 'そこに工事はありません',
    too_far: '遠くて手伝えません',
    already_done: 'もう完成しています',
    rate: 'すこし休んでからにしましょう',
  };
  return map[reason] ?? 'いまは手伝えません';
}

/** 収穫・水やりが断られた理由を、プレイヤーに読める1文にする */
function interactMessage(reason: string): string {
  const map: Record<string, string> = {
    too_far: '遠くて手がとどきません',
    empty: 'いまは採れるものがありません',
    already_watered: 'もう水をあげたばかりです',
    not_waterable: 'ここに水をやっても育ちません',
    rate: 'すこし休んでからにしましょう',
    not_found: 'そこには何もありません',
  };
  return map[reason] ?? 'いまはできません';
}

function viewRectAround(pos: Vec2): ViewRect {
  const hw = VIEW_MAX_W / 2;
  const hh = VIEW_MAX_H / 2;
  return { x0: pos.x - hw, y0: pos.y - hh, x1: pos.x + hw, y1: pos.y + hh };
}

export class ConnectionHub {
  private clients = new Map<WebSocket, Client>();
  private droppedByRate = 0;
  private invalidMessages = 0;
  private readonly sim: IslandSim;
  private readonly sync: SyncService;
  private readonly repo: Repo;
  private readonly pets: PetManager;
  private readonly reflection: ReflectionService;
  private readonly gossip: GossipReporter;
  private rejoins = 0;
  /** 遅延送信のタイマー（停止時にまとめて解除する） */
  private pendingTimers = new Set<NodeJS.Timeout>();
  private closing = false;

  // 注意: Node の type-stripping で動かすため parameter property は使えない
  constructor(
    sim: IslandSim,
    repo: Repo,
    pets: PetManager,
    reflection: ReflectionService,
    gossip: GossipReporter,
  ) {
    this.sim = sim;
    this.repo = repo;
    this.pets = pets;
    this.reflection = reflection;
    this.gossip = gossip;
    this.sync = new SyncService(sim.world);
    // ペットの追従にはオーナーのアバターが必要（接続中のプレイヤーだけを引く）
    pets.setOwnerLookup((playerId) => this.actorOfPlayer(playerId));
    sim.onTick((tick) => {
      this.broadcastDeltas(tick);
      // 島のスナップショットと同じ間隔でプレイヤーの位置も保存する
      if (tick % SNAPSHOT_INTERVAL_TICKS === 0) this.persistAllPlayers();
    });
  }

  clientCount(): number {
    return this.clients.size;
  }

  /** プレイヤーの表示名（プロンプトに載せる） */
  displayNameOf(playerId: string): string | undefined {
    for (const c of this.clients.values()) if (c.playerId === playerId) return c.displayName;
    return undefined;
  }

  /**
   * あるアクターの近くにいるクライアント全員へ送る（ペット同士の会話の吹き出しなど）。
   * 「席を外している間にペットが話していた」を他のプレイヤーからも見えるようにする。
   */
  sendNearActor(entityId: EntityId, msg: ServerMsg, radius = VIEW_MAX_W / 2): void {
    const actor = this.sim.world.actor(entityId);
    if (!actor) return;
    for (const c of this.clients.values()) {
      if (!c.joined) continue;
      const viewer = this.sim.world.actor(c.entityId);
      if (!viewer) continue;
      if (Math.hypot(viewer.pos.x - actor.pos.x, viewer.pos.y - actor.pos.y) > radius) continue;
      this.send(c, msg);
    }
  }

  /**
   * 一定時間後にアクター周辺へ送る（会話の掛け合いを間を置いて流すため）。
   * サーバ停止時にタイマーが残らないよう、ここで一括管理する。
   */
  sendNearActorDelayed(entityId: EntityId, msg: ServerMsg, delayMs: number): void {
    if (delayMs <= 0) {
      this.sendNearActor(entityId, msg);
      return;
    }
    const timer = setTimeout(() => {
      this.pendingTimers.delete(timer);
      if (!this.closing) this.sendNearActor(entityId, msg);
    }, delayMs);
    this.pendingTimers.add(timer);
  }

  /** 共同建設の状態を全員に配る（進捗が動いたとき・入島時） */
  broadcastConstructions(): void {
    for (const c of this.clients.values()) {
      if (!c.joined) continue;
      this.send(c, this.constructionsMessage(c.playerId));
    }
  }

  /** そのプレイヤー向けの建設一覧（自分の貢献値を載せる） */
  private constructionsMessage(playerId: string): ServerMsg {
    return {
      t: 'constructions',
      items: this.sim.build.constructions().map((c) => ({
        i: c.id,
        ty: c.type,
        x: c.pos.x,
        y: c.pos.y,
        p: c.progress,
        done: c.completedAtTick !== undefined,
        mine: c.contributions[playerId] ?? 0,
      })),
    };
  }

  /** 設置物が増減したので、近くのクライアントへ最新のスナップショットを送り直す */
  private resendSnapshotNear(pos: Vec2, radius = VIEW_MAX_W): void {
    for (const c of this.clients.values()) {
      if (!c.joined) continue;
      const viewer = this.sim.world.actor(c.entityId);
      if (!viewer) continue;
      if (Math.hypot(viewer.pos.x - pos.x, viewer.pos.y - pos.y) > radius) continue;
      this.send(c, this.sync.snapshotMessage(c.playerId, this.sim.clockState()));
    }
  }

  /** 地形が変わったチャンクを、接続中の全員へ送り直す（クライアントは再要求しない設計のため） */
  resendTerrain(tiles: { x: number; y: number }[]): void {
    const chunks = new Set<number>();
    const list: [number, number][] = [];
    for (const t of tiles) {
      const cx = Math.floor(t.x / CHUNK);
      const cy = Math.floor(t.y / CHUNK);
      const key = cy * 64 + cx;
      if (chunks.has(key)) continue;
      chunks.add(key);
      list.push([cx, cy]);
    }
    if (list.length === 0) return;
    for (const c of this.clients.values()) {
      if (!c.joined) continue;
      // まず「捨てて」と伝え、続けて新しい地形を送る
      this.send(c, { t: 'terrainChanged', chunks: list });
      for (const [cx, cy] of list) this.send(c, this.sync.chunkMessage(cx, cy));
    }
  }

  /** ペットのオーナーが接続中なら通知を送る */
  notifyOwnerOfPet(petId: number, text: string, importance = 5): void {
    const session = this.pets.sessionList().find((s) => s.petId === petId);
    if (!session) return;
    const client = this.clientOfPlayer(session.playerId);
    if (client) this.send(client, { t: 'notice', text, importance });
  }

  /** 日記ができたことを、そのペットのオーナーに知らせる */
  sendDiary(petId: number, diary: string, affection: number): void {
    const session = this.pets.sessionList().find((s) => s.petId === petId);
    if (!session) return;
    const client = this.clientOfPlayer(session.playerId);
    if (!client) return;
    this.send(client, { t: 'notice', text: diary, importance: 6 });
    this.send(client, { t: 'petState', affection, mood: 'ねむそう' });
  }

  private clientOfPlayer(playerId: string): Client | undefined {
    for (const c of this.clients.values()) if (c.playerId === playerId && c.joined) return c;
    return undefined;
  }

  /** 接続中プレイヤーのアバター。切断済みなら undefined */
  private actorOfPlayer(playerId: string): Actor | undefined {
    for (const c of this.clients.values()) {
      if (c.playerId === playerId && c.joined) return this.sim.world.actor(c.entityId);
    }
    return undefined;
  }

  tick(): number {
    return this.sim.tick;
  }

  metrics(): Record<string, unknown> {
    return {
      ...this.sim.metrics(),
      clients: this.clients.size,
      droppedByRate: this.droppedByRate,
      invalidMessages: this.invalidMessages,
      actors: this.sim.world.countActors(),
      critters: this.sim.world.countActors('critter'),
      navPending: this.sim.nav.pending(),
      ...this.sim.ecologyMetrics(),
      petActions: this.sim.petStats(),
      pets: this.pets.stats(),
      rejoins: this.rejoins,
      knownPlayers: this.repo.countPlayers(this.sim.islandId),
      sync: this.sync.stats(),
    };
  }

  accept(ws: WebSocket): void {
    const client: Client = {
      ws,
      playerId: '',
      secret: '',
      displayName: '',
      entityId: 0,
      joined: false,
      rate: new Map(),
    };
    this.clients.set(ws, client);

    ws.on('message', (data) => this.onMessage(client, String(data)));
    ws.on('close', () => this.dropClient(client));
    ws.on('error', (e) => {
      console.warn('[ws] error', e.message);
      this.dropClient(client);
    });
  }

  /** 接続中プレイヤーの位置を永続化する（30秒ごと／切断時／停止時） */
  persistAllPlayers(): void {
    const now = Date.now();
    for (const c of this.clients.values()) {
      if (!c.joined) continue;
      const actor = this.sim.world.actor(c.entityId);
      if (!actor) continue;
      try {
        this.repo.updatePlayer(c.playerId, {
          pos: actor.pos,
          lastSeenAt: now,
          lastSeenIslandDay: this.sim.clock.islandDay,
        });
      } catch (e) {
        console.error('[hub] プレイヤーの保存に失敗', e);
      }
    }
  }

  private dropClient(client: Client): void {
    this.clients.delete(client.ws);
    if (!client.joined) return;
    const actor = this.sim.world.actor(client.entityId);
    if (actor) {
      // 切断時点の位置を保存する（次回ログインはここから始まる）
      try {
        this.repo.updatePlayer(client.playerId, {
          pos: actor.pos,
          lastSeenAt: Date.now(),
          lastSeenIslandDay: this.sim.clock.islandDay,
        });
      } catch (e) {
        console.error('[hub] 切断時のプレイヤー保存に失敗', e);
      }
      forgetActor(actor);
    }

    // ペットは島に残す（オーナー不在でも暮らし続ける）。leave は null を返す
    this.pets.leave(client.playerId);
    this.sim.nav.clear(client.entityId);
    this.sim.world.removeActor(client.entityId);
    this.sync.removeClient(client.playerId);
  }

  private onMessage(client: Client, raw: string): void {
    const parsed = parseClientMsg(raw);
    if (!parsed.ok) {
      this.invalidMessages++;
      this.send(client, { t: 'warn', code: 'bad_message', message: parsed.error });
      return;
    }
    const msg = parsed.msg;
    if (!this.allow(client, msg.t)) {
      this.droppedByRate++;
      return;
    }

    // hello 以外は入島後のみ受け付ける
    if (msg.t !== 'hello' && msg.t !== 'ping' && !client.joined) return;

    const world = this.sim.world;
    const actor = client.joined ? world.actor(client.entityId) : undefined;

    switch (msg.t) {
      case 'hello': {
        if (client.joined) return;

        // secret があれば前回のプレイヤーを復元する。無ければ新規発行
        const secret = msg.secret ?? randomUUID();
        const existing = msg.secret ? this.repo.findPlayerBySecret(msg.secret) : null;

        let startPos = world.spawn;
        if (existing) {
          client.playerId = existing.id;
          client.displayName = msg.displayName ?? existing.displayName;
          // 前回の位置に戻す。地形が変わっている等で立てない場合は広場へ
          if (world.canStandAt(existing.pos)) startPos = existing.pos;
          this.rejoins++;
        } else {
          const created = this.repo.createPlayer({
            secret,
            displayName: msg.displayName ?? 'しまびと',
            islandId: this.sim.islandId,
            pos: world.spawn,
          });
          client.playerId = created.id;
          client.displayName = created.displayName;
        }
        client.secret = secret;

        const you = createPlayerActor(world, { name: client.displayName, pos: { ...startPos } });
        client.entityId = you.id;
        client.joined = true;
        this.repo.updatePlayer(client.playerId, {
          displayName: client.displayName,
          pos: you.pos,
          lastSeenAt: Date.now(),
        });

        // 既存のペットを島に出す（無ければクライアントはタマゴ選択へ進む）
        const restored = this.pets.restore(client.playerId, { x: you.pos.x, y: you.pos.y });

        this.sync.addClient({
          clientId: client.playerId,
          actorId: you.id,
          petId: restored?.actor.id ?? null,
          view: viewRectAround(you.pos),
        });

        this.send(client, {
          t: 'welcome',
          v: PROTOCOL_VERSION,
          playerId: client.playerId,
          secret: client.secret,
          entityId: you.id,
          islandId: this.sim.islandId,
          seed: this.sim.seed,
          clock: this.sim.clockState(),
          you: actorToWire(you),
          pet: restored ? petToWire(restored.pet, restored.actor.id) : null,
          // ペットが居ないときだけ図鑑を送る（タマゴ選択UIの材料）
          ...(restored ? {} : { petCatalog: petCatalog() }),
          mapW: MAP_W,
          mapH: MAP_H,
        });
        this.send(client, this.sync.snapshotMessage(client.playerId, this.sim.clockState()));

        // 留守中サマリ（ペットが日記みたいに教えてくれる）
        if (restored && existing) {
          const sinceIslandDay = existing.lastSeenIslandDay;
          const passed = this.sim.clock.islandDay - sinceIslandDay;
          if (passed >= 1) {
            const summary = this.reflection.buildAwaySummary({
              petId: restored.pet.id,
              islandId: this.sim.islandId,
              sinceIslandDay,
              currentIslandDay: this.sim.clock.islandDay,
              petName: restored.pet.persona.name,
            });
            this.send(client, {
              t: 'awaySummary',
              lines: summary.lines,
              islandDaysPassed: summary.islandDaysPassed,
            });
          }
        }
        // 他のペットから聞いた話があれば報告する（宣伝資料「今日ミズネがこんなこと言ってたよ」）
        if (restored) {
          const report = this.gossip.take(restored.pet.id, this.sim.clock.islandDay, restored.pet.persona.name);
          if (report) {
            this.send(client, { t: 'notice', text: report.line, importance: 6 });
            for (const item of report.items) {
              this.send(client, { t: 'notice', text: item.text, importance: 5 });
            }
            this.send(client, {
              t: 'bubble',
              entityId: restored.actor.id,
              text: report.items[0]?.text.slice(0, 40) ?? report.line,
              kind: 'say',
              ms: 6000,
            });
          }
        }

        // 共同建設の進捗（進捗バーの初期表示）
        this.send(client, this.constructionsMessage(client.playerId));

        // 次回の留守中サマリの起点
        this.repo.updatePlayer(client.playerId, { lastSeenIslandDay: this.sim.clock.islandDay });

        console.log(
          `[hub] ${existing ? '再入島' : '新規'} ${client.displayName} (#${you.id}) ` +
            `pos=${you.pos.x.toFixed(1)},${you.pos.y.toFixed(1)} 接続数=${this.clients.size}`,
        );
        break;
      }

      case 'chunkReq': {
        for (const [cx, cy] of msg.chunks) {
          this.send(client, this.sync.chunkMessage(cx, cy));
        }
        break;
      }

      case 'move': {
        if (!actor) return;
        clearAxisInput(actor);
        this.sim.nav.request(actor.id, msg.to);
        break;
      }

      case 'moveAxis': {
        if (!actor) return;
        this.sim.nav.clear(actor.id);
        if (msg.dx === 0 && msg.dy === 0) clearAxisInput(actor);
        else setAxisInput(actor, msg.dx, msg.dy);
        break;
      }

      case 'createPet': {
        if (!actor) return;
        const { pet, actor: petActor } = this.pets.create(
          client.playerId,
          { species: msg.species, name: msg.name, persona: msg.persona },
          { x: actor.pos.x + 1, y: actor.pos.y },
        );
        this.sync.setPetId(client.playerId, petActor.id);
        this.send(client, {
          t: 'welcome',
          v: PROTOCOL_VERSION,
          playerId: client.playerId,
          secret: client.secret,
          entityId: actor.id,
          islandId: this.sim.islandId,
          seed: this.sim.seed,
          clock: this.sim.clockState(),
          you: actorToWire(actor),
          pet: petToWire(pet, petActor.id),
          mapW: MAP_W,
          mapH: MAP_H,
        });
        this.send(client, this.sync.snapshotMessage(client.playerId, this.sim.clockState()));
        this.send(client, {
          t: 'bubble',
          entityId: petActor.id,
          text: pet.persona.catchphrase,
          kind: 'say',
          ms: 3000,
        });
        console.log(`[hub] ペット誕生 ${pet.persona.name}（${pet.persona.species}）owner=${client.displayName}`);
        break;
      }

      case 'say': {
        this.pets.handleSay({
          playerId: client.playerId,
          ownerName: client.displayName,
          text: msg.text,
          send: (m) => this.send(client, m),
        });
        break;
      }

      case 'interact': {
        if (!actor) return;
        const petActor = this.pets.petActorOf(client.playerId);
        if (msg.act === 'pet' && petActor && msg.targetId === petActor.id) {
          this.pets.handlePet({ playerId: client.playerId, send: (m) => this.send(client, m) });
          break;
        }
        if (msg.act === 'harvest' || msg.act === 'water') {
          const opts = {
            playerId: client.playerId,
            playerName: client.displayName,
            actorId: actor.id,
            targetId: msg.targetId,
            // 座標はサーバ権威の値を使う（クライアントの申告は信用しない）
            playerPos: actor.pos,
            tick: this.sim.tick,
          };
          const res =
            msg.act === 'harvest' ? this.sim.interact.harvest(opts) : this.sim.interact.water(opts);
          if (res.ok) {
            this.send(client, { t: 'notice', text: res.text, importance: 3 });
          } else {
            this.send(client, { t: 'warn', code: res.reason, message: interactMessage(res.reason) });
          }
        }
        break;
      }

      case 'place': {
        if (!actor) return;
        const res = this.sim.build.place({
          playerId: client.playerId,
          type: msg.type,
          pos: msg.pos,
          playerPos: actor.pos,
          tick: this.sim.tick,
        });
        if (res.ok) {
          // 設置物は snapshot に載るので、周辺のクライアントへ現在の状態を配り直す
          this.send(client, { t: 'notice', text: `${placeableLabel(msg.type)}を置いた`, importance: 3 });
          this.resendSnapshotNear(actor.pos);
        } else {
          this.send(client, { t: 'warn', code: res.reason, message: placeMessage(res.reason) });
        }
        break;
      }

      case 'contribute': {
        if (!actor) return;
        const res = this.sim.build.contribute({
          playerId: client.playerId,
          constructionId: msg.constructionId,
          playerPos: actor.pos,
          tick: this.sim.tick,
        });
        if (res.ok) {
          this.broadcastConstructions();
          if (res.completed) {
            this.broadcast({ t: 'notice', text: `${constructionLabel(res.construction.type)}が完成した！`, importance: 8 });
          }
        } else if (res.reason !== 'rate') {
          // 連打（rate）は黙って捨てる。それ以外は理由を返す
          this.send(client, { t: 'warn', code: res.reason, message: contributeMessage(res.reason) });
        }
        break;
      }

      case 'ping':
        this.send(client, { t: 'pong', ts: msg.ts, tick: this.sim.tick });
        break;

      default:
        // place / contribute はM7で実装する
        break;
    }
  }

  /** 毎tick、接続ごとに視界を更新して差分を送る */
  private broadcastDeltas(tick: number): void {
    if (this.clients.size === 0) return;
    const sendClock = this.sim.clockChanged || tick % CLOCK_RESEND_TICKS === 0;
    const clock = sendClock ? this.sim.clockState() : undefined;

    for (const client of this.clients.values()) {
      if (!client.joined) continue;
      const actor = this.sim.world.actor(client.entityId);
      if (actor) this.sync.updateView(client.playerId, viewRectAround(actor.pos));
      const msg = this.sync.deltaMessage(client.playerId, tick, clock);
      if (msg) this.send(client, msg);
    }
  }

  /** レート制限。超過したらfalse */
  private allow(client: Client, type: ClientMsgType): boolean {
    const limit = (RATE_LIMITS as Record<string, { perSec: number } | undefined>)[type];
    if (!limit) return true;
    const now = Date.now();
    const windowMs = 1000;
    let hist = client.rate.get(type);
    if (!hist) {
      hist = [];
      client.rate.set(type, hist);
    }
    while (hist.length > 0 && now - (hist[0] as number) > windowMs) hist.shift();
    if (hist.length >= Math.max(1, Math.ceil(limit.perSec))) return false;
    hist.push(now);
    return true;
  }

  send(client: Client, msg: ServerMsg): void {
    if (client.ws.readyState !== 1) return;
    client.ws.send(JSON.stringify(msg));
  }

  broadcast(msg: ServerMsg): void {
    const payload = JSON.stringify(msg);
    for (const c of this.clients.values()) {
      if (c.ws.readyState === 1) c.ws.send(payload);
    }
  }

  closeAll(reason: string): void {
    this.closing = true;
    for (const t of this.pendingTimers) clearTimeout(t);
    this.pendingTimers.clear();
    this.broadcast({ t: 'serverClosing', reason });
    for (const c of this.clients.values()) c.ws.close(1001, 'server closing');
    this.clients.clear();
  }
}
