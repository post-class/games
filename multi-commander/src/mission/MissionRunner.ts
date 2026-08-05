import { Quaternion, Vector3 } from 'three';
import { bus } from '../core/events';
import { forwardOf } from '../core/math';
import { Rng, rng } from '../core/rng';
import { kilrathiName } from '../content/dialogue';
import {
  aceState,
  recordAceEncounter,
  recordAceEscape,
  recordAceKill,
} from '../content/aces';
import { isHostile } from '../content/factions';
import { shipDef } from '../content/ships';
import type { DifficultyProfile } from '../app/settings';
import type { PlaytestObjective, PlaytestRecorder } from '../app/playtest';
import type { ObjectiveView } from '../hud/HudView';
import { newAi } from '../sim/ai';
import { checkNavArrival } from '../sim/nav';
import { stateOf } from '../sim/subsystems';
import type { Entity } from '../world/entity';
import { spawnMine, spawnNav, spawnRock, spawnShip, World } from '../world/world';
import type {
  HazardDef,
  Loadout,
  CapitalStageDef,
  MissionDef,
  ObjectiveDef,
  RadioLineDef,
  SpawnGroupDef,
} from './types';

export type MissionState = 'running' | 'win' | 'loss';

/** 逃走した敵がこの距離まで離れたら「撃退した」として戦域から外す */
const FLED_DISTANCE = 14000;

const _awayCheck = new Vector3();
const _reconFwd = new Vector3();
const _reconTo = new Vector3();
const _navCheck = new Vector3();

interface PendingSpawn {
  group: SpawnGroupDef;
  /** 出現までの残り秒。undefined ならまだ条件を満たしていない */
  timer?: number;
  released: boolean;
}

interface ObjectiveRuntime {
  def: ObjectiveDef;
  state: 'active' | 'done' | 'failed';
  /** protect 用: 生成した護衛対象の id */
  watchIds: number[];
  /** rescue 用: 回収済みの対象 id */
  collected?: Set<number>;
  /** recon 用: 撮影を継続できている秒数 */
  progress?: number;
  /** HUD に出す進捗ラベル (例 "2/3") */
  note?: string;
}

/**
 * ミッションの実行時状態。
 * ワールドの構築、ウェーブ投入、目標評価、勝敗判定を受け持つ。
 */
export class MissionRunner {
  state: MissionState = 'running';
  elapsed = 0;
  /** 直近の固定ステップ長 (目標の進捗計算に使う) */
  private lastDt = 1 / 60;
  /** プレイヤーの撃墜数 (このミッション分) */
  kills = 0;
  /** 撃退した (逃げ切られた) 敵の数 */
  routed = 0;
  /** 僚機の entity id (出撃時に決まる) */
  private wingmanEntityId?: number;
  /** 僚機が撃墜されたか */
  private wingmanLost = false;
  /** 僚機の撃墜数 */
  private wingmanKills = 0;
  /** 僚機の残ハル率 (撃墜時は 0) */
  private wingmanHullRatio = 1;
  /** 僚機が助けを求めたか / それに応えたか */
  private wingmanCalledForHelp = false;
  private wingmanRescued = false;
  /** 護衛対象を失ったか */
  private escortLost = false;
  /** プレイヤーが倒したエースの数 */
  private acesKilled = 0;
  /** 統計画面用。発射と命中をミッション単位で集計する。 */
  private shotsFired = 0;
  private hits = 0;
  private objectives: ObjectiveRuntime[] = [];
  private pending: PendingSpawn[] = [];
  private radioQueue: Array<{ line: RadioLineDef; at: number }> = [];
  private unsubs: Array<() => void> = [];
  private tagIndex = new Map<string, number[]>();
  private capitalStage = 0;
  private capitalTorpedoFired = false;

  constructor(
    readonly world: World,
    readonly def: MissionDef,
    private loadout: Loadout,
    private difficulty: DifficultyProfile,
    private playtest?: PlaytestRecorder,
  ) {}

  /** ワールドを構築して開始する */
  build(): void {
    const world = this.world;
    world.reset();
    this.state = 'running';
    this.elapsed = 0;
    this.kills = 0;
    this.routed = 0;
    this.wingmanEntityId = undefined;
    this.wingmanLost = false;
    this.wingmanKills = 0;
    this.wingmanHullRatio = 1;
    this.wingmanCalledForHelp = false;
    this.wingmanRescued = false;
    this.escortLost = false;
    this.acesKilled = 0;
    this.shotsFired = 0;
    this.hits = 0;
    this.objectives = this.def.objectives.map((d) => ({
      def: d,
      state: 'active',
      watchIds: [],
      collected: d.spec.kind === 'rescue' ? new Set<number>() : undefined,
      progress: d.spec.kind === 'recon' ? 0 : undefined,
    }));
    this.playtest?.recordObjectives(this.playtestObjectiveStates(), 0);
    this.pending = this.def.spawns.map((g) => ({
      group: g,
      // 開始時グループは即時、Nav 紐付けグループは到達時に武装する
      timer: g.atNav === undefined ? (g.delay ?? 0) + this.waveBonus(g) : undefined,
      released: false,
    }));
    this.radioQueue = [];
    this.tagIndex.clear();
    this.capitalStage = 0;
    this.capitalTorpedoFired = false;

    // Nav ポイント
    this.def.navs.forEach((n, i) => {
      spawnNav(world, {
        index: i,
        name: n.name,
        pos: new Vector3(...n.pos),
        arriveRadius: n.arriveRadius ?? 900,
      });
    });

    this.spawnHazards();

    // 自機。最初の Nav の方向を向いて出撃する
    const firstNav = this.def.navs[0];
    const facing = new Quaternion();
    if (firstNav) {
      facing.setFromUnitVectors(
        new Vector3(0, 0, -1),
        new Vector3(...firstNav.pos).normalize(),
      );
    }
    const player = spawnShip(world, {
      def: shipDef(this.loadout.shipId),
      faction: 'confed',
      pos: new Vector3(0, 0, 0),
      quat: facing,
      speed: this.difficulty.id === 'easy' ? shipDef(this.loadout.shipId).maxSpeed * 0.5 : 0,
      label: '自機',
      pilot: 'あなた',
      gunOverride: this.loadout.gunId,
      missileOverride: this.loadout.missiles,
      flareOverride: this.loadout.flares,
      fuelScale: this.difficulty.fuelScale,
    });
    world.playerId = player.id;

    // 僚機。ロードアウト (格納庫での選択) が最優先。
    // 無ければミッション定義の既定を使う (テストや単体起動のため)。
    const wing =
      this.loadout.wingman ??
      (this.def.wingman
        ? {
            pilotId: this.def.wingman.pilot,
            callsign: this.def.wingman.pilot,
            shipId: this.def.wingman.shipId,
            skill: this.def.wingman.skill,
            personality: undefined,
          }
        : undefined);
    if (wing) {
      const e = spawnShip(world, {
        def: shipDef(wing.shipId),
        faction: 'confed',
        pos: new Vector3(((this.loadout.wingmanSlot ?? 2) - 2.5) * 180, -20, 150).applyQuaternion(facing),
        quat: facing,
        speed: 120,
        label: wing.callsign,
        pilot: wing.callsign,
        ai: newAi(wing.skill, {
          leaderId: player.id,
          order: 'form',
          personality: wing.personality,
        }),
      });
      this.wingmanEntityId = e.id;
    }

    // 遅延 0 の開始時グループを即座に投入する
    for (const p of this.pending) {
      if (!p.released && p.timer !== undefined && p.timer <= 0) {
        this.spawnGroup(p.group);
        p.released = true;
      }
    }

    if (this.def.openingRadio) this.queueRadio(this.def.openingRadio, 1.2);

    this.subscribe();
    bus.emit('objectivesChanged', {});
  }

  private subscribe(): void {
    this.dispose();
    this.unsubs.push(
      bus.on('weaponFired', (p) => {
        if (p.isPlayer) this.shotsFired += 1;
        const stage = this.activeCapitalStages[this.capitalStage];
        if (
          p.isPlayer &&
          p.weaponKind === 'missile' &&
          p.weaponId === stage?.weapon &&
          this.tagAlive(stage.tag).alive > 0 &&
          // 魚雷段階は「何かに撃った」だけでなく、旗艦をロックして
          // 発射したときだけ進める。無駄撃ちを意味のある判断にする。
          (stage.weapon !== 'torpedo' ||
            (this.world.player?.ship?.lockedId !== undefined &&
              (this.tagIndex.get(stage.tag) ?? []).includes(this.world.player.ship.lockedId)))
        ) {
          this.capitalTorpedoFired = true;
        }
      }),
      bus.on('shieldHit', (p) => {
        if (p.isPlayer) this.hits += 1;
      }),
      bus.on('armorHit', (p) => {
        if (p.isPlayer) this.hits += 1;
      }),
      bus.on('destroyed', (p) => {
        if (p.target.id === this.world.playerId) {
          const source = p.source?.ship?.pilot ?? p.source?.label ?? p.source?.kind;
          this.playtest?.recordDeath(p.reason ?? 'unknown', this.world.time, source);
        }
        const sourceShip = p.source?.kind === 'ship'
          ? p.source
          : p.source?.projectile
            ? this.world.byId(p.source.projectile.ownerId)
            : p.source?.missile
              ? this.world.byId(p.source.missile.ownerId)
              : undefined;
        if (sourceShip?.ship?.ace && p.target.id === this.wingmanEntityId && p.target.ship?.pilot) {
          const victim = sourceShip.ship.pilot ? aceState(this.loadout.aceStates ?? [], sourceShip.ship.pilot) : undefined;
          if (victim) victim.lastVictim = p.target.ship.pilot;
        }
        if (p.target.ship?.ace) {
          const state = p.target.ship.pilot ? aceState(this.loadout.aceStates ?? [], p.target.ship.pilot) : undefined;
          if (state) recordAceKill(state);
        }
        if (p.killedByPlayer) {
          this.kills++;
          if (p.target.ship?.ace) this.acesKilled++;
        }
        // 僚機の戦死は取り返しがつかないので、ここで確定させる
        if (this.wingmanEntityId !== undefined && p.target.id === this.wingmanEntityId) {
          this.wingmanLost = true;
          this.wingmanHullRatio = 0;
        }
        // 護衛対象の喪失を記録する
        if (p.target.tag && this.protectTags.has(p.target.tag)) this.escortLost = true;
      }),
      bus.on('wingmanInTrouble', (p) => {
        if (this.wingmanEntityId !== undefined && p.entity.id === this.wingmanEntityId) {
          this.wingmanCalledForHelp = true;
        }
      }),
    );
  }

  /** protect 目標で参照されているタグ */
  private get protectTags(): Set<string> {
    const set = new Set<string>();
    for (const o of this.def.objectives) {
      if (o.spec.kind === 'protect') set.add(o.spec.tag);
    }
    return set;
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
  }

  // ───────── 更新 ─────────

  update(dt: number): void {
    if (this.state !== 'running') return;
    this.elapsed += dt;
    this.lastDt = dt;

    this.flushRadio();
    this.tickSpawns(dt);
    this.removeRoutedEnemies();

    const arrived = checkNavArrival(this.world);
    if (arrived?.nav) {
      bus.emit('navReached', { index: arrived.nav.index, name: arrived.nav.name });
      this.playtest?.recordNavReached(arrived.nav.index, arrived.nav.name, this.world.time);
      const navDef = this.def.navs[arrived.nav.index];
      if (navDef?.onArrive) this.queueRadio(navDef.onArrive, 0.6);
      // この Nav で出現するグループを解放
      for (const p of this.pending) {
        if (!p.released && p.group.atNav === arrived.nav.index && p.timer === undefined) {
          p.timer = (p.group.delay ?? 0) + this.waveBonus(p.group);
        }
      }
      bus.emit('objectivesChanged', {});
    }

    this.trackWingman();
    this.evaluateObjectives();
  }

  /**
   * 僚機の状態を追う。
   * 撃墜数・残ハル・救援要請の有無を集め、デブリーフと名簿に渡す。
   */
  private trackWingman(): void {
    if (this.wingmanEntityId === undefined || this.wingmanLost) return;
    const w = this.world.byId(this.wingmanEntityId);
    if (!w?.ship) return;
    this.wingmanKills = w.ship.kills;
    this.wingmanHullRatio = w.ship.hull / Math.max(1, w.ship.def.hull);
    // 助けを求めた後に生き延びていれば「救援された」とみなす
    if (this.wingmanCalledForHelp && this.wingmanHullRatio > 0.2) {
      const threat = this.world.entities.some(
        (e) =>
          e.alive &&
          e.kind === 'ship' &&
          isHostile(w.faction, e.faction) &&
          e.ship?.targetId === w.id &&
          e.pos.distanceToSquared(w.pos) < 900 * 900,
      );
      if (!threat) {
        this.wingmanRescued = true;
        this.wingmanCalledForHelp = false;
      }
    }
  }

  /**
   * 難易度による増援の遅延ボーナス。
   * 「時間差で来る敵の増援」だけを遅らせる。
   * 護衛対象や攻撃目標のように到達と同時に配置されるものには効かせない。
   */
  private waveBonus(g: SpawnGroupDef): number {
    if (g.faction !== 'kilrathi') return 0;
    if (!g.delay) return 0;
    return this.difficulty.waveDelayBonus;
  }

  private tickSpawns(dt: number): void {
    let released = false;
    for (const p of this.pending) {
      if (p.released || p.timer === undefined) continue;
      p.timer -= dt;
      if (p.timer <= 0) {
        this.spawnGroup(p.group);
        p.released = true;
        released = true;
      }
    }
    if (released) bus.emit('objectivesChanged', {});
  }

  /**
   * 小惑星帯・機雷原を配置する。
   * ミッション id を種にした固定乱数なので、同じミッションでは毎回同じ地形になる。
   */
  private spawnHazards(): void {
    const list = this.def.hazards;
    if (!list?.length) return;
    let seed = 0;
    for (let i = 0; i < this.def.id.length; i++) seed = (seed * 31 + this.def.id.charCodeAt(i)) >>> 0;
    const r = new Rng(seed || 1);
    for (const h of list) this.spawnHazard(h, r);
  }

  private spawnHazard(h: HazardDef, r: Rng): void {
    const center = new Vector3();
    const along = new Vector3();
    if (h.betweenNavs) {
      const a = this.def.navs[h.betweenNavs[0]];
      const b = this.def.navs[h.betweenNavs[1]];
      if (a && b) {
        const pa = new Vector3(...a.pos);
        const pb = new Vector3(...b.pos);
        center.copy(pa).add(pb).multiplyScalar(0.5);
        along.copy(pb).sub(pa);
      }
    } else if (h.atNav !== undefined && this.def.navs[h.atNav]) {
      center.set(...this.def.navs[h.atNav].pos);
    }
    if (h.offset) center.add(new Vector3(...h.offset));

    const half = along.length() * 0.5;
    if (half > 1) along.normalize();

    for (let i = 0; i < h.count; i++) {
      const pos = center.clone();
      // 航路指定があれば線に沿って伸ばす (帯・封鎖線)
      if (half > 1) pos.addScaledVector(along, r.range(-half * 0.8, half * 0.8));
      pos.x += r.range(-h.spread, h.spread);
      pos.y += r.range(-h.spread * 0.45, h.spread * 0.45);
      pos.z += r.range(-h.spread, h.spread);
      this.pushOutOfClearZones(pos, r);

      if (h.kind === 'asteroids') {
        const [lo, hi] = h.rockRadius ?? [14, 70];
        spawnRock(this.world, {
          pos,
          radius: r.range(lo, hi),
          vel: new Vector3(r.range(-8, 8), r.range(-4, 4), r.range(-8, 8)),
          variant: Math.floor(r.range(0, 4)),
          seed: r.range(0, 100),
        });
      } else {
        spawnMine(this.world, { pos, ownerFaction: h.faction ?? 'kilrathi' });
      }
    }
  }

  /**
   * Nav 到達点と出撃地点の周りに空白を作る。
   *
   * オートパイロットは Nav へ一気に飛ぶので、そこに岩があると到達した瞬間に死ぬ。
   * 引き直しではなく外へ押し出すことで、Nav 中心に置いた field でも
   * 「Nav の周囲をドーナツ状に取り巻く岩」として成立する。
   */
  private pushOutOfClearZones(pos: Vector3, r: Rng): void {
    const zones: Array<{ c: Vector3; radius: number }> = [
      { c: new Vector3(), radius: 2000 },
      ...this.def.navs.map((n) => ({
        c: new Vector3(...n.pos),
        radius: (n.arriveRadius ?? 900) * 1.3 + 700,
      })),
    ];
    for (const z of zones) {
      _navCheck.copy(pos).sub(z.c);
      const d = _navCheck.length();
      if (d >= z.radius) continue;
      if (d < 1e-3) {
        // 完全に重なったときは適当な方向へ逃がす
        _navCheck.set(r.range(-1, 1), r.range(-0.4, 0.4), r.range(-1, 1));
        if (_navCheck.lengthSq() < 1e-6) _navCheck.set(1, 0, 0);
        _navCheck.normalize();
      } else {
        _navCheck.divideScalar(d);
      }
      pos.copy(z.c).addScaledVector(_navCheck, z.radius + r.range(0, 400));
    }
  }

  private spawnGroup(g: SpawnGroupDef): void {
    const world = this.world;
    const base = new Vector3();
    if (g.atNav !== undefined && this.def.navs[g.atNav]) {
      base.set(...this.def.navs[g.atNav].pos);
    }
    if (g.offset) base.add(new Vector3(...g.offset));

    const spread = g.spread ?? 260;
    const cruise = g.cruiseToNav !== undefined && this.def.navs[g.cruiseToNav]
      ? new Vector3(...this.def.navs[g.cruiseToNav].pos)
      : undefined;

    const player = world.player;
    const skill = g.skill ?? this.difficulty.enemySkill;

    for (let i = 0; i < g.count; i++) {
      const isAce = !!g.ace && i === 0;
      const ace = isAce ? aceState(this.loadout.aceStates ?? [], g.ace!.pilot) : undefined;
      // 一度撃墜した宿敵は、別ミッションの同じ無線だけを残して再出現させない。
      // destroyTag が空になるケースは evaluateObjectives 側で達成扱いにする。
      if (isAce && ace?.status === 'killed') continue;
      if (isAce && ace) recordAceEncounter(ace, this.def.id);
      const id = isAce && g.ace?.shipId ? g.ace.shipId : g.shipId;
      const def = shipDef(id);
      const pos = base
        .clone()
        .add(
          new Vector3(
            rng.signed(spread) + (i - (g.count - 1) / 2) * spread * 0.9,
            rng.signed(spread * 0.4),
            rng.signed(spread),
          ),
        );
      // 自機の方を向いて出現させる (すぐ背後を取られないように)
      const quat = new Quaternion();
      const look = cruise ?? player?.pos ?? new Vector3();
      const dir = look.clone().sub(pos);
      if (dir.lengthSq() > 1e-6) {
        quat.setFromUnitVectors(new Vector3(0, 0, -1), dir.normalize());
      }

      const passive = def.role === 'transport' || def.role === 'capital';
      const aceSkill = ace?.skill ?? skill;
      const ai = newAi(isAce ? Math.min(1, Math.max(skill, aceSkill) + (g.ace?.skillBonus ?? 0.3)) : skill, {
        passive: passive || undefined,
        cruiseTo: cruise,
        leaderId: g.followPlayer ? player?.id : undefined,
        order: g.followPlayer ? 'form' : undefined,
      });

      const pilot = isAce
        ? g.ace!.pilot
        : g.faction === 'kilrathi'
          ? kilrathiName(i + Math.floor(this.elapsed))
          : undefined;

      const e = spawnShip(world, {
        def,
        faction: g.faction,
        pos,
        quat,
        speed: g.speed ?? def.maxSpeed * 0.6,
        tag: g.tag,
        pilot,
        ace: isAce,
        ai,
      });
      if (g.tag) {
        const list = this.tagIndex.get(g.tag) ?? [];
        list.push(e.id);
        this.tagIndex.set(g.tag, list);
      }
      if (isAce && ace && ace.escaped > 0) {
        this.queueRadio(
          [{ speaker: g.ace!.pilot, text: ace.lastVictim ? `${ace.lastVictim} の名を覚えている。次は貴様の番だ。` : 'また会ったな。前回は貴様が生き延びただけだ。', tone: 'enemy' }],
          0.8,
        );
      }
    }

    if (g.radio) this.queueRadio(g.radio, 0.4);
  }

  /**
   * 戦域を離れていく敵を「撃退した」として外す。
   * これが無いと、逃げた敵を追えないまま destroyAll が永久に成立しない。
   * 「遠い」だけでは消さず、自機から離れる方向へ飛んでいることを条件にする
   * (プレイヤーが逃げた場合に、追ってきている敵を消してしまわないため)。
   */
  private removeRoutedEnemies(): void {
    const player = this.world.player;
    if (!player) return;
    for (const e of this.world.entities) {
      if (!e.alive || e.kind !== 'ship' || !e.ai) continue;
      if (!isHostile(player.faction, e.faction)) continue;
      const away = _awayCheck.copy(e.pos).sub(player.pos);
      const d = away.length();
      if (d < FLED_DISTANCE) continue;
      if (d > 1e-4 && away.divideScalar(d).dot(e.vel) <= 0) continue; // まだ向かってくる
      this.world.kill(e);
      this.routed++;
      const ship = e.ship;
      if (ship?.ace && ship.pilot) {
        const state = aceState(this.loadout.aceStates ?? [], ship.pilot);
        if (state) recordAceEscape(state);
      }
      bus.emit('radio', {
        speaker: '管制',
        text: `${e.ship?.pilot ?? e.label ?? '敵機'} が戦域を離脱した。`,
        tone: 'command',
      });
    }
  }

  // ───────── 無線 ─────────

  private queueRadio(lines: RadioLineDef[], startDelay: number): void {
    let t = this.elapsed + startDelay;
    for (const line of lines) {
      t += line.after ?? 2.4;
      this.radioQueue.push({ line, at: t });
    }
  }

  private flushRadio(): void {
    while (this.radioQueue.length && this.radioQueue[0].at <= this.elapsed) {
      const { line } = this.radioQueue.shift()!;
      bus.emit('radio', { speaker: line.speaker, text: line.text, tone: line.tone });
    }
  }

  // ───────── 目標評価 ─────────

  private hostileShipsAlive(): number {
    const player = this.world.player;
    const faction = player?.faction ?? 'confed';
    let n = 0;
    for (const e of this.world.entities) {
      if (!e.alive || e.kind !== 'ship' || !e.ship) continue;
      if (isHostile(faction, e.faction)) n++;
    }
    return n;
  }

  private allSpawnsReleased(): boolean {
    return this.pending.every((p) => p.released);
  }

  private tagAlive(tag: string): { total: number; alive: number } {
    const ids = this.tagIndex.get(tag) ?? [];
    let alive = 0;
    for (const id of ids) if (this.world.byId(id)) alive++;
    return { total: ids.length, alive };
  }

  /**
   * 救助。対象に接近すれば回収したものとして扱う。
   * 撃たれて失われた分は数に入らないので、放置すると達成できなくなる。
   */
  private evaluateRescue(o: ObjectiveRuntime, tag: string, radius: number): void {
    const ids = this.tagIndex.get(tag) ?? [];
    const player = this.world.player;
    const set = (o.collected ??= new Set<number>());
    if (player) {
      for (const id of ids) {
        if (set.has(id)) continue;
        const t = this.world.byId(id);
        if (!t) continue;
        if (t.pos.distanceTo(player.pos) - t.radius > radius) continue;
        set.add(id);
        bus.emit('announce', { text: `${t.label ?? '対象'} を回収`, kind: 'good', durationMs: 1800 });
        bus.emit('radio', {
          speaker: t.label ?? '救助信号',
          text: '……感謝する。母艦まで誘導を頼む。',
          tone: 'friendly',
        });
        // 回収したら戦域から外す (以後は守る必要がない)
        this.world.kill(t);
      }
    }
    // 生存しているうちに回収できなかった対象は失われた。rescue は
    // 「対象すべて」を回収する目標なので、1つでも失えば任務失敗にする。
    let lost = 0;
    for (const id of ids) {
      if (!set.has(id) && !this.world.byId(id)) lost++;
    }
    o.note = `${set.size}/${ids.length}${lost ? ` (喪失 ${lost})` : ''}`;
    if (ids.length > 0 && set.size + lost >= ids.length) {
      o.state = lost === 0 && set.size === ids.length ? 'done' : 'failed';
    }
  }

  /**
   * 偵察 (写真撮影)。対象を正面の狭い角度に一定距離まで収め続ける。
   * 撃つ必要はないが、逃げられたり追い散らされたりすると継続が途切れる。
   */
  private evaluateRecon(
    o: ObjectiveRuntime,
    spec: { tag: string; seconds?: number; range?: number; coneDeg?: number },
  ): void {
    const need = spec.seconds ?? 4;
    const range = spec.range ?? 1200;
    const cos = Math.cos(((spec.coneDeg ?? 18) * Math.PI) / 180);
    const player = this.world.player;
    const ids = this.tagIndex.get(spec.tag) ?? [];
    o.progress ??= 0;

    let holding = false;
    if (player) {
      forwardOf(player.quat, _reconFwd);
      for (const id of ids) {
        const t = this.world.byId(id);
        if (!t) continue;
        _reconTo.copy(t.pos).sub(player.pos);
        const d = _reconTo.length();
        if (d > range || d < 1e-3) continue;
        if (_reconTo.divideScalar(d).dot(_reconFwd) < cos) continue;
        holding = true;
        break;
      }
    }
    // 途切れたら少しだけ巻き戻す (完全リセットは厳しすぎる)
    o.progress = holding
      ? Math.min(need, o.progress + this.lastDt)
      : Math.max(0, o.progress - this.lastDt * 0.6);
    o.note = `${Math.floor((o.progress / need) * 100)}%`;
    if (o.progress >= need) o.state = 'done';
    else if (ids.length > 0 && ids.every((id) => !this.world.byId(id))) o.state = 'failed';
  }

  private evaluateObjectives(): void {
    const before = this.objectives.map((o) => o.state).join(',');
    this.evaluateCapitalStages();

    for (const o of this.objectives) {
      if (o.state === 'failed') continue;
      switch (o.def.spec.kind) {
        case 'destroyAll': {
          const done = this.allSpawnsReleased() && this.hostileShipsAlive() === 0;
          o.state = done ? 'done' : 'active';
          break;
        }
        case 'destroyTag': {
          const t = this.tagAlive(o.def.spec.tag);
          const stages = this.activeCapitalStages;
          const capitalTarget = stages[stages.length - 1]?.tag;
          const waitingForStage = capitalTarget === o.def.spec.tag && this.capitalStage < stages.length;
          o.state = !waitingForStage && ((t.total === 0 && this.allSpawnsReleased()) || (t.total > 0 && t.alive === 0))
            ? 'done'
            : 'active';
          break;
        }
        case 'protect': {
          const t = this.tagAlive(o.def.spec.tag);
          if (t.total > 0 && t.alive === 0) o.state = 'failed';
          else o.state = 'active';
          break;
        }
        case 'reachNav': {
          const idx = o.def.spec.navIndex;
          const nav = this.world.entities.find((e) => e.kind === 'nav' && e.nav?.index === idx);
          o.state = nav?.nav?.reached ? 'done' : 'active';
          break;
        }
        case 'survive': {
          o.state = this.elapsed >= o.def.spec.seconds ? 'done' : 'active';
          o.note = `残り ${Math.max(0, Math.ceil(o.def.spec.seconds - this.elapsed))}s`;
          break;
        }
        case 'rescue': {
          this.evaluateRescue(o, o.def.spec.tag, o.def.spec.radius ?? 260);
          break;
        }
        case 'recon': {
          this.evaluateRecon(o, o.def.spec);
          break;
        }
        case 'timeLimit': {
          const left = o.def.spec.seconds - this.elapsed;
          o.note = `残り ${Math.max(0, Math.ceil(left))}s`;
          if (left <= 0) o.state = 'failed';
          break;
        }
      }
    }

    const after = this.objectives.map((o) => o.state).join(',');
    if (before !== after) {
      bus.emit('objectivesChanged', {});
      this.playtest?.recordObjectives(this.playtestObjectiveStates(), this.world.time);
    }

    // 勝敗判定
    const player = this.world.player;
    if (!player) {
      this.finish('loss');
      return;
    }
    // 脱出は「生き延びたが機体を失った」= 任務失敗
    if (player.ship?.ejected) {
      this.finish('loss');
      return;
    }
    const requiredFailed = this.objectives.some((o) => o.def.required && o.state === 'failed');
    if (requiredFailed) {
      this.finish('loss');
      return;
    }
    const requiredRemaining = this.objectives.some(
      (o) =>
        o.def.required &&
        // protect / timeLimit は「達成する目標」ではなく制約なので、完了条件に数えない
        o.def.spec.kind !== 'protect' &&
        o.def.spec.kind !== 'timeLimit' &&
        o.state !== 'done',
    );
    if (!requiredRemaining) this.finish('win');
  }

  private evaluateCapitalStages(): void {
    const stages = this.activeCapitalStages;
    if (!stages.length) return;
    while (this.capitalStage < stages.length) {
      const stage = stages[this.capitalStage];
      const tag = this.tagAlive(stage.tag);
      // まだその段階のウェーブが出ていないなら、撃破扱いにはしない。
      const hasPending = this.pending.some((p) => !p.released && p.group.tag === stage.tag);
      if (hasPending || (tag.total === 0 && !this.allSpawnsReleased())) return;

      // 段階を待っている間に対象そのものが撃沈された場合は、
      // 「先に落とせてしまった」結果を詰みにしない。最終目標はすでに
      // 達成されているので、残り段階も完了扱いにする。
      if (tag.total > 0 && tag.alive === 0) {
        this.capitalStage = stages.length;
        return;
      }

      const subsystem = stage.subsystem;
      if (subsystem) {
        const targets = (this.tagIndex.get(stage.tag) ?? [])
          .map((id) => this.world.byId(id))
          .filter((e): e is Entity => !!e?.ship);
        if (targets.length === 0 || !targets.every((e) => stateOf(e.ship, subsystem) === 'dead')) return;
      } else if (stage.weapon) {
        if (tag.alive === 0 || !this.capitalTorpedoFired) return;
      } else if (tag.total > 0 && tag.alive > 0) {
        return;
      }

      this.capitalStage += 1;
      this.capitalTorpedoFired = false;
      bus.emit('announce', { text: `段階完了: ${stage.text}`, kind: 'good', durationMs: 2200 });
      if (stage.radio) this.queueRadio(stage.radio, 0.4);
    }
  }

  private get activeCapitalStages(): CapitalStageDef[] {
    return this.def.capitalSequence ?? this.def.capitalStages ?? [];
  }

  /** 艦艇強襲の進行段階。テスト・HUD 拡張用の読み取り専用値。 */
  get capitalStageIndex(): number {
    return this.capitalStage;
  }

  private finish(outcome: MissionState): void {
    if (this.state !== 'running') return;
    // 生存している宿敵は今回も離脱した。撃墜済みの state は変更しない。
    for (const e of this.world.entities) {
      if (!e.alive || e.kind !== 'ship' || !e.ship?.ace || !e.ship.pilot) continue;
      const state = aceState(this.loadout.aceStates ?? [], e.ship.pilot);
      if (state) recordAceEscape(state);
    }
    this.playtest?.recordObjectives(this.playtestObjectiveStates(), this.world.time);
    this.playtest?.finish(outcome === 'win' ? 'win' : 'loss', this.world.time);
    this.state = outcome;
    bus.emit('missionEnded', { outcome: outcome === 'win' ? 'win' : 'loss' });
  }

  private playtestObjectiveStates(): PlaytestObjective[] {
    return this.objectives.map((o) => ({
      id: o.def.id,
      text: o.def.text,
      state: o.state,
    }));
  }

  /** HUD 表示用の目標一覧 */
  objectiveViews(): ObjectiveView[] {
    return this.objectives.map((o) => {
      const base = o.def.required ? o.def.text : `(任意) ${o.def.text}`;
      return {
        text: o.note && o.state === 'active' ? `${base} — ${o.note}` : base,
        state: o.state,
      };
    });
  }

  /** デブリーフ用の集計 */
  summary(): {
    kills: number;
    routed: number;
    objectives: ObjectiveView[];
    seconds: number;
    playerHullRatio: number;
    wingmanLost: boolean;
    wingmanKills: number;
    wingmanHullRatio: number;
    wingmanRescued: boolean;
    wingmanAbandoned: boolean;
    escortLost: boolean;
    acesKilled: number;
    shotsFired: number;
    hits: number;
    shipId: string;
    navsReached: number;
    escortSuccess: boolean;
  } {
    const player = this.world.player;
    return {
      kills: this.kills,
      routed: this.routed,
      objectives: this.objectives.map((o) => ({ text: o.def.text, state: o.state })),
      seconds: this.elapsed,
      playerHullRatio: player?.ship
        ? player.ship.hull / Math.max(1, player.ship.def.hull)
        : 0,
      wingmanLost: this.wingmanLost,
      wingmanKills: this.wingmanKills,
      wingmanHullRatio: this.wingmanHullRatio,
      wingmanRescued: this.wingmanRescued,
      // 助けを求めたまま応えられずに終わった (死んだ or 要請が残ったまま)
      wingmanAbandoned: this.wingmanCalledForHelp || (this.wingmanLost && !this.wingmanRescued),
      escortLost: this.escortLost,
      acesKilled: this.acesKilled,
      shotsFired: this.shotsFired,
      hits: this.hits,
      shipId: player?.ship?.def.id ?? this.loadout.shipId,
      navsReached: this.world.entities.filter((e) => e.kind === 'nav' && e.nav?.reached).length,
      escortSuccess: !this.escortLost,
    };
  }

  /**
   * 戦域を離脱してよいか。
   *
   * 戦闘系の必須目標をすべて片付け、あとは帰投するだけの状態なら true。
   * このとき敵が残っていてもオートパイロットを許可する
   * (でないと「目標達成したのに帰れない」状態で詰む)。
   */
  get canDisengage(): boolean {
    let hasReturnNav = false;
    for (const o of this.objectives) {
      if (!o.def.required) continue;
      if (o.def.spec.kind === 'reachNav') {
        if (o.state !== 'done') hasReturnNav = true;
        continue;
      }
      if (o.def.spec.kind === 'protect') {
        if (o.state === 'failed') return false;
        continue;
      }
      if (o.state !== 'done') return false;
    }
    return hasReturnNav;
  }

  /** 護衛対象など、いま向かうべき Nav */
  get currentNav(): Entity | undefined {
    let best: Entity | undefined;
    for (const e of this.world.entities) {
      if (!e.alive || e.kind !== 'nav' || !e.nav || e.nav.reached) continue;
      if (!best || e.nav.index < best.nav!.index) best = e;
    }
    return best;
  }
}
