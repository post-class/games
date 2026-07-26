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
import type { HudView, HudData, RadarContact, HudTargetData } from "../../hud/HudView";
import { computeLeadPosition, projectToScreen, computeOffscreenIndicator } from "../../hud/ReticleCalc";
import type { GameStateData } from "../GameState";

const leadPos = new Vector3();
const relPos = new Vector3();
const invQ = new Quaternion();

/** ECS の状態を集約し HudView に渡す (可変レート系)。 */
export class HudSystem implements System {
  readonly name = "HudSystem";

  constructor(
    private readonly view: HudView,
    private readonly camera: PerspectiveCamera,
    private readonly getPlayer: () => EntityId | null,
    private readonly state: GameStateData,
  ) {}

  update(world: World): void {
    const player = this.getPlayer();
    const w = window.innerWidth;
    const h = window.innerHeight;

    const enemiesLeft = world
      .query(Comp.Faction, Comp.Health)
      .filter((e) => world.get<Faction>(e, Comp.Faction) === Faction.Enemy).length;

    if (player === null || !world.isAlive(player)) {
      // プレイヤー消滅時も最低限の表示は維持。
      this.view.update(this.emptyData(enemiesLeft));
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

    const data: HudData = {
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
      kills: this.state.kills,
      enemiesLeft,
      target,
      radar,
      phase: this.state.phase,
    };
    this.view.update(data);
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

    // リード位置 (自機の砲口速度で予測)。
    const tvel = trb ? trb.velocity : new Vector3();
    computeLeadPosition(pt.position, wm.gunProjectileSpeed, tt.position, tvel, leadPos);

    const box = projectToScreen(tt.position, this.camera, w, h);
    const lead = projectToScreen(leadPos, this.camera, w, h);
    const arrow = computeOffscreenIndicator(tt.position, this.camera, w, h);

    return {
      name: info?.displayName ?? "TARGET",
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
        hostile: f !== playerFaction && f !== Faction.Neutral,
        isTarget: targeting?.target === e,
      });
    }
    return contacts;
  }

  private emptyData(enemiesLeft: number): HudData {
    return {
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
      kills: this.state.kills,
      enemiesLeft,
      target: null,
      radar: [],
      phase: this.state.phase,
    };
  }
}
