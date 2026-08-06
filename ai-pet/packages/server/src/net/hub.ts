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
  MAP_H,
  MAP_W,
  PROTOCOL_VERSION,
  RATE_LIMITS,
  SNAPSHOT_INTERVAL_TICKS,
  TICK_HZ,
  VIEW_MAX_H,
  VIEW_MAX_W,
  parseClientMsg,
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
  private rejoins = 0;

  // 注意: Node の type-stripping で動かすため parameter property は使えない
  constructor(sim: IslandSim, repo: Repo) {
    this.sim = sim;
    this.repo = repo;
    this.sync = new SyncService(sim.world);
    sim.onTick((tick) => {
      this.broadcastDeltas(tick);
      // 島のスナップショットと同じ間隔でプレイヤーの位置も保存する
      if (tick % SNAPSHOT_INTERVAL_TICKS === 0) this.persistAllPlayers();
    });
  }

  clientCount(): number {
    return this.clients.size;
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
        this.repo.updatePlayer(c.playerId, { pos: actor.pos, lastSeenAt: now });
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
        this.repo.updatePlayer(client.playerId, { pos: actor.pos, lastSeenAt: Date.now() });
      } catch (e) {
        console.error('[hub] 切断時のプレイヤー保存に失敗', e);
      }
      forgetActor(actor);
    }
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

        this.sync.addClient({
          clientId: client.playerId,
          actorId: you.id,
          petId: null,
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
          pet: null,
          mapW: MAP_W,
          mapH: MAP_H,
        });
        this.send(client, this.sync.snapshotMessage(client.playerId, this.sim.clockState()));
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

      case 'ping':
        this.send(client, { t: 'pong', ts: msg.ts, tick: this.sim.tick });
        break;

      default:
        // interact / say / place / contribute / createPet はM4以降で実装する
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
    this.broadcast({ t: 'serverClosing', reason });
    for (const c of this.clients.values()) c.ws.close(1001, 'server closing');
    this.clients.clear();
  }
}
