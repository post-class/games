import { Vector3, Quaternion, type Scene, type Object3D } from "three";
import type { World } from "../../ecs/World";
import type { EntityId } from "../../ecs/Entity";
import { Comp, Faction } from "../components";
import type { Targeting } from "../components";
import type { AIController } from "../components/AIController";
import { SHIP_DEFS } from "../ships/shipDefinitions";
import { spawnShip } from "../ships/ShipFactory";
import { createNavMarker } from "../../render/MeshFactory";
import type { MissionDefinition, ShipSpawn, AllySpawn } from "./MissionDefinition";

export type MissionOutcome = "active" | "success" | "failure";

export interface ObjectiveState {
  id: string;
  label: string;
  type: "destroyAll" | "protect" | "reachNav" | "survive";
  optional: boolean;
  status: "active" | "complete" | "failed";
  tag?: string;
  nav?: string;
  seconds?: number;
}

export interface Announcement {
  text: string;
  expireAt: number;
}

const faceYawQuat = new Quaternion();
const yAxis = new Vector3(0, 1, 0);

/**
 * ミッションの実行時状態を管理する。
 * ウェーブ出現・目標評価・勝敗判定を担い、ワールド/シーンへエンティティを投入する。
 * 段階D(キャンペーン)で複数ミッションを load/dispose して切り替える。
 */
export class MissionManager {
  private def: MissionDefinition | null = null;
  private player: EntityId | null = null;
  private wingmen: EntityId[] = [];
  private waveSpawned: boolean[] = [];
  private waveEntities: EntityId[][] = [];
  private tagEntities = new Map<string, EntityId>();
  private navMarkers = new Map<string, Object3D>();
  objectives: ObjectiveState[] = [];
  outcome: MissionOutcome = "active";
  private startTime = 0;
  private announcements: Announcement[] = [];

  constructor(
    private readonly world: World,
    private readonly scene: Scene,
  ) {}

  getPlayer(): EntityId | null {
    return this.player !== null && this.world.isAlive(this.player) ? this.player : null;
  }

  getMission(): MissionDefinition | null {
    return this.def;
  }

  /** ミッションを読み込み、初期エンティティを生成する。 */
  load(def: MissionDefinition, simTime: number): void {
    this.def = def;
    this.startTime = simTime;
    this.outcome = "active";
    this.wingmen = [];
    this.waveSpawned = def.waves.map(() => false);
    this.waveEntities = def.waves.map(() => []);
    this.tagEntities.clear();
    this.announcements = [];

    // プレイヤー。
    const pDef = SHIP_DEFS[def.playerShipId];
    this.player = spawnShip(this.world, this.scene, pDef, {
      position: new Vector3(...def.playerSpawn),
      quaternion: this.yaw(def.playerFacingYaw ?? 0),
      faction: Faction.Player,
    });
    this.world.add(this.player, Comp.PlayerControlled, true);
    this.world.add<Targeting>(this.player, Comp.Targeting, {
      target: null,
      lockProgress: 0,
      lockTime: 0,
    });

    // 僚機・中立(被護衛)。
    for (const ally of [...def.wingmen, ...def.neutrals]) {
      this.spawnAlly(ally);
    }

    // ナビポイントのマーカー。
    for (const nav of def.navPoints) {
      const marker = createNavMarker(nav.radius);
      marker.position.set(...nav.position);
      this.scene.add(marker);
      this.navMarkers.set(nav.id, marker);
    }

    // 目標状態。
    this.objectives = def.objectives.map((o) => ({
      id: o.id,
      label: o.label,
      type: o.type,
      optional: o.optional ?? false,
      status: "active",
      tag: "tag" in o ? o.tag : undefined,
      nav: "nav" in o ? o.nav : undefined,
      seconds: "seconds" in o ? o.seconds : undefined,
    }));

    // start トリガーのウェーブを投入。
    def.waves.forEach((_, i) => this.maybeSpawnWave(i, simTime));
  }

  /** 毎フレーム (固定dt) 呼ばれる。 */
  update(_dt: number, simTime: number): void {
    if (!this.def || this.outcome !== "active") return;

    // ウェーブ出現判定。
    this.def.waves.forEach((_, i) => this.maybeSpawnWave(i, simTime));

    // プレイヤー消滅 = 失敗。
    if (this.getPlayer() === null) {
      this.outcome = "failure";
      return;
    }

    // 目標評価。
    for (const obj of this.objectives) {
      if (obj.status !== "active") continue;
      switch (obj.type) {
        case "protect": {
          const ent = obj.tag ? this.tagEntities.get(obj.tag) : undefined;
          if (ent === undefined || !this.world.isAlive(ent)) obj.status = "failed";
          break;
        }
        case "reachNav": {
          if (this.playerReachedNav(obj.nav)) obj.status = "complete";
          break;
        }
        case "survive": {
          if (simTime - this.startTime >= (obj.seconds ?? 0)) obj.status = "complete";
          break;
        }
        case "destroyAll": {
          if (this.allWavesSpawned() && this.enemiesAlive() === 0) obj.status = "complete";
          break;
        }
      }
    }

    // 勝敗判定 (必須目標のみで評価)。
    const required = this.objectives.filter((o) => !o.optional);
    if (required.some((o) => o.status === "failed")) {
      this.outcome = "failure";
    } else if (required.length > 0 && required.every((o) => o.status === "complete")) {
      this.outcome = "success";
    }
  }

  // ---- 公開ヘルパー (HUD用) ----

  enemiesAlive(): number {
    return this.world
      .query(Comp.Faction, Comp.Health)
      .filter((e) => this.world.get<Faction>(e, Comp.Faction) === Faction.Enemy).length;
  }

  /** 未達成の reachNav 目標の対象ナビ位置。なければ null。 */
  activeNav(): { position: Vector3; label: string } | null {
    if (!this.def) return null;
    for (const obj of this.objectives) {
      if (obj.type === "reachNav" && obj.status === "active" && obj.nav) {
        const nav = this.def.navPoints.find((n) => n.id === obj.nav);
        if (nav) return { position: new Vector3(...nav.position), label: nav.label };
      }
    }
    return null;
  }

  announce(text: string, simTime: number, duration = 4): void {
    this.announcements.push({ text, expireAt: simTime + duration });
  }

  activeMessages(now: number): string[] {
    this.announcements = this.announcements.filter((a) => a.expireAt > now);
    return this.announcements.map((a) => a.text);
  }

  /** ミッションのエンティティ・マーカーをすべて除去する (ミッション切替時)。 */
  dispose(): void {
    for (const marker of this.navMarkers.values()) this.scene.remove(marker);
    this.navMarkers.clear();
    // ワールドの全エンティティのメッシュを除去し破棄。
    for (const e of this.world.query(Comp.Renderable)) {
      const r = this.world.get<{ object: Object3D }>(e, Comp.Renderable);
      if (r) this.scene.remove(r.object);
    }
    for (const e of [...this.world.query(Comp.Transform)]) this.world.destroyEntity(e);
    this.world.flushDestroyed();
    this.player = null;
    this.def = null;
    this.objectives = [];
  }

  // ---- 内部 ----

  private maybeSpawnWave(index: number, simTime: number): void {
    if (!this.def || this.waveSpawned[index]) return;
    const wave = this.def.waves[index];
    if (!this.triggerReady(wave.trigger, simTime)) return;
    this.waveSpawned[index] = true;
    for (const s of wave.ships) {
      const id = this.spawnEnemy(s);
      this.waveEntities[index].push(id);
    }
    if (wave.announce) this.announce(wave.announce, simTime);
  }

  private triggerReady(trigger: MissionDefinition["waves"][number]["trigger"], simTime: number): boolean {
    switch (trigger.type) {
      case "start":
        return true;
      case "time":
        return simTime - this.startTime >= trigger.seconds;
      case "afterWave":
        return this.isWaveCleared(trigger.wave);
    }
  }

  private isWaveCleared(index: number): boolean {
    if (index < 0 || !this.waveSpawned[index]) return false;
    return this.waveEntities[index].every((id) => !this.world.isAlive(id));
  }

  private allWavesSpawned(): boolean {
    return this.waveSpawned.every(Boolean);
  }

  private spawnEnemy(s: ShipSpawn): EntityId {
    const def = SHIP_DEFS[s.shipId];
    const q = s.facingYaw !== undefined ? this.yaw(s.facingYaw) : this.yaw(Math.PI);
    const e = spawnShip(this.world, this.scene, def, {
      position: new Vector3(...s.position),
      quaternion: q,
      faction: Faction.Enemy,
    });
    const ai: AIController = {
      role: "enemy",
      state: "Idle",
      target: null,
      stateTimer: 0,
      aggression: 0.4 + Math.random() * 0.5,
      evadeDir: null,
      detectRange: 3500,
      attackRange: def.weapon.gunRange,
      order: "engage",
      formationSlot: 0,
    };
    this.world.add(e, Comp.AIController, ai);
    return e;
  }

  private spawnAlly(a: AllySpawn): EntityId {
    const def = SHIP_DEFS[a.shipId];
    const e = spawnShip(this.world, this.scene, def, {
      position: new Vector3(...a.position),
      quaternion: this.yaw(a.facingYaw ?? 0),
      faction: Faction.Ally,
    });
    if (a.combatant) {
      const ai: AIController = {
        role: "ally",
        state: "Form",
        target: null,
        stateTimer: 0,
        aggression: 0.6,
        evadeDir: null,
        detectRange: 3500,
        attackRange: def.weapon.gunRange,
        order: "engage",
        formationSlot: this.wingmen.length,
      };
      this.world.add(e, Comp.AIController, ai);
      this.wingmen.push(e);
    }
    if (a.tag) this.tagEntities.set(a.tag, e);
    return e;
  }

  private playerReachedNav(navId: string | undefined): boolean {
    if (!this.def || !navId) return false;
    const player = this.getPlayer();
    if (player === null) return false;
    const nav = this.def.navPoints.find((n) => n.id === navId);
    if (!nav) return false;
    const pos = this.world.get<{ position: Vector3 }>(player, Comp.Transform)?.position;
    if (!pos) return false;
    return pos.distanceTo(new Vector3(...nav.position)) <= nav.radius;
  }

  private yaw(rad: number): Quaternion {
    return faceYawQuat.setFromAxisAngle(yAxis, rad).clone();
  }
}
