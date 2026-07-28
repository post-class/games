import { Vector3, Quaternion, type PerspectiveCamera } from "three";
import type { System } from "../../ecs/System";
import type { World } from "../../ecs/World";
import type { EntityId } from "../../ecs/Entity";
import { Comp, Faction } from "../components";
import type {
  Transform,
  RigidBody,
  FlightModel,
  Health,
  WeaponMount,
  Targeting,
  ShipInfo,
} from "../components";
import { isHostile, isFriendly } from "../factions";
import type { HudView, HudData, RadarContact, HudTargetData, HudNav } from "../../hud/HudView";
import { computeLeadPosition, projectToScreen, computeOffscreenIndicator } from "../../hud/ReticleCalc";
import type { GameStateData } from "../GameState";
import type { MissionManager } from "../mission/MissionManager";
import { WEAPON_DEFS } from "../weapons/WeaponDefs";

const leadPos = new Vector3();
const relPos = new Vector3();
const invQ = new Quaternion();

/** ECS + ミッション状態を集約し HudView に渡す (可変レート系)。 */
export class HudSystem implements System {
  readonly name = "HudSystem";

  constructor(
    private readonly view: HudView,
    private readonly camera: PerspectiveCamera,
    private readonly mission: MissionManager,
    private readonly state: GameStateData,
    private readonly getSimTime: () => number,
  ) {}

  update(world: World): void {
    const player = this.mission.getPlayer();
    const w = window.innerWidth;
    const h = window.innerHeight;
    const def = this.mission.getMission();

    const base = {
      kills: this.state.kills,
      enemiesLeft: this.mission.enemiesAlive(),
      missionName: def?.name ?? "",
      objectives: this.mission.objectives.map((o) => ({
        label: o.label,
        status: o.status,
        optional: o.optional,
      })),
      messages: this.mission.activeMessages(this.getSimTime()),
      phase: this.state.phase,
      result: this.state.result,
      resultText: this.state.resultText,
    };

    if (player === null) {
      this.view.update(this.emptyData(base));
      this.view.setMissileWarning(false);
      return;
    }

    const t = world.getOrThrow<Transform>(player, Comp.Transform);
    const rb = world.getOrThrow<RigidBody>(player, Comp.RigidBody);
    const fm = world.getOrThrow<FlightModel>(player, Comp.FlightModel);
    const health = world.getOrThrow<Health>(player, Comp.Health);
    const wm = world.getOrThrow<WeaponMount>(player, Comp.WeaponMount);
    const targeting = world.get<Targeting>(player, Comp.Targeting);

    const speed = rb.velocity.length();
    const target = this.buildTargetData(world, t, wm, targeting, w, h);
    const radar = this.buildRadar(world, player, t);
    const nav = this.buildNav(t, w, h);

    const data: HudData = {
      ...base,
      speed,
      maxSpeed: fm.afterburnerMaxSpeed,
      throttlePct: Math.min(1, speed / fm.maxLinearSpeed),
      flightAssist: fm.flightAssist,
      afterburner: world.getOrThrow<{ afterburner: boolean }>(player, Comp.ThrusterInput).afterburner,
      shieldPct: health.shield / health.shieldMax,
      armorPct: health.armor / health.armorMax,
      hullPct: health.hull / health.hullMax,
      energyPct: wm.energy / wm.energyMax,
      missiles: wm.missiles,
      flares: wm.flares,
      secondaryName: this.buildSecondaryName(wm),
      secondaryAmmo: this.buildSecondaryAmmo(wm),
      target,
      radar,
      nav,
    };
    this.view.update(data);

    // 被ロック警告: 自機を誘導対象とする誘導ミサイルの飛来を検知。
    let incoming = false;
    for (const mis of world.query(Comp.Missile)) {
      if (world.get<{ target: EntityId | null }>(mis, Comp.Missile)?.target === player) {
        incoming = true;
        break;
      }
    }
    this.view.setMissileWarning(this.state.phase === "Playing" && incoming);
  }

  /** 選択中の副兵装名を WEAPON_DEFS から解決する。未搭載なら空文字。 */
  private buildSecondaryName(wm: WeaponMount): string {
    const secondaries = wm.secondaries;
    if (!secondaries || secondaries.length === 0) return "";
    const idx = wm.activeSecondary ?? 0;
    const id = secondaries[idx];
    if (!id) return "";
    return WEAPON_DEFS[id]?.displayName ?? id;
  }

  /** 選択中の副兵装の残弾数。未搭載なら0。 */
  private buildSecondaryAmmo(wm: WeaponMount): number {
    const secondaries = wm.secondaries;
    if (!secondaries || secondaries.length === 0) return 0;
    const idx = wm.activeSecondary ?? 0;
    const id = secondaries[idx];
    if (!id) return 0;
    return wm.secondaryAmmo?.[id] ?? 0;
  }

  private buildNav(pt: Transform, w: number, h: number): HudNav | null {
    const nav = this.mission.activeNav();
    if (!nav) return null;
    const ind = computeOffscreenIndicator(nav.position, this.camera, w, h);
    return {
      x: ind.x,
      y: ind.y,
      angleRad: ind.angleRad,
      onScreen: ind.onScreen,
      distance: pt.position.distanceTo(nav.position),
      label: nav.label,
    };
  }

  private buildTargetData(
    world: World,
    pt: Transform,
    wm: WeaponMount,
    targeting: Targeting | undefined,
    w: number,
    h: number,
  ): HudTargetData | null {
    if (!targeting || targeting.target === null || !world.isAlive(targeting.target)) return null;
    const tgt = targeting.target;
    if (!world.has(tgt, Comp.Transform)) return null;
    const tt = world.getOrThrow<Transform>(tgt, Comp.Transform);
    const th = world.get<Health>(tgt, Comp.Health);
    const info = world.get<ShipInfo>(tgt, Comp.ShipInfo);
    const trb = world.get<RigidBody>(tgt, Comp.RigidBody);

    const distance = pt.position.distanceTo(tt.position);
    const tvel = trb ? trb.velocity : new Vector3();
    computeLeadPosition(pt.position, wm.gunProjectileSpeed, tt.position, tvel, leadPos);

    const box = projectToScreen(tt.position, this.camera, w, h);
    const lead = projectToScreen(leadPos, this.camera, w, h);
    const arrow = computeOffscreenIndicator(tt.position, this.camera, w, h);

    return {
      name: info ? (info.isAce ? `★ ${info.displayName}` : info.displayName) : "TARGET",
      distance,
      shieldPct: th ? th.shield / th.shieldMax : 0,
      hullPct: th ? th.hull / th.hullMax : 0,
      lockProgress: targeting.lockProgress,
      box: { x: box.x, y: box.y, onScreen: box.onScreen },
      lead: { x: lead.x, y: lead.y, onScreen: lead.onScreen && distance < wm.gunRange },
      arrow,
    };
  }

  private buildRadar(world: World, player: EntityId, pt: Transform): RadarContact[] {
    const contacts: RadarContact[] = [];
    const playerFaction = world.get<Faction>(player, Comp.Faction) ?? Faction.Player;
    const targeting = world.get<Targeting>(player, Comp.Targeting);
    invQ.copy(pt.quaternion).conjugate();
    const ships = world.query(Comp.Transform, Comp.Health, Comp.Faction);
    for (const e of ships) {
      if (e === player) continue;
      const tt = world.getOrThrow<Transform>(e, Comp.Transform);
      const f = world.getOrThrow<Faction>(e, Comp.Faction);
      relPos.copy(tt.position).sub(pt.position).applyQuaternion(invQ);
      contacts.push({
        x: relPos.x,
        y: relPos.y,
        z: relPos.z,
        hostile: isHostile(playerFaction, f),
        friendly: isFriendly(playerFaction, f),
        isTarget: targeting?.target === e,
      });
    }
    return contacts;
  }

  private emptyData(base: Pick<HudData,
    "kills" | "enemiesLeft" | "missionName" | "objectives" | "messages" | "phase" | "result" | "resultText">): HudData {
    return {
      ...base,
      speed: 0,
      maxSpeed: 1,
      throttlePct: 0,
      flightAssist: true,
      afterburner: false,
      shieldPct: 0,
      armorPct: 0,
      hullPct: 0,
      energyPct: 0,
      missiles: 0,
      flares: 0,
      secondaryName: "",
      secondaryAmmo: 0,
      target: null,
      radar: [],
      nav: null,
    };
  }
}
