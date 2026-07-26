import { Vector3 } from "three";
import type { System } from "../../ecs/System";
import type { World } from "../../ecs/World";
import type { EntityId } from "../../ecs/Entity";
import { Comp, Faction } from "../components";
import type { ThrusterInput, FlightModel, Transform, Targeting } from "../components";
import type { InputManager } from "../input/InputManager";
import { selectNextTarget, selectNearestTarget, selectFrontTarget } from "./TargetingSystem";

/**
 * プレイヤー入力を PlayerControlled エンティティの ThrusterInput に反映する。
 * フライトアシスト切替・ターゲット選択などのエッジ操作もここで処理する。
 */
export class InputSystem implements System {
  readonly name = "InputSystem";
  private readonly forward = new Vector3(0, 0, 1);

  constructor(private readonly input: InputManager) {}

  update(world: World, dt: number): void {
    const players = world.query(Comp.PlayerControlled, Comp.ThrusterInput, Comp.FlightModel);
    if (players.length === 0) {
      this.input.clearEdges();
      return;
    }

    const axes = this.input.sampleAxes(dt);
    const discrete = this.input.sampleDiscrete();
    const edges = this.input.sampleEdges();

    for (const entity of players) {
      const ti = world.getOrThrow<ThrusterInput>(entity, Comp.ThrusterInput);
      const fm = world.getOrThrow<FlightModel>(entity, Comp.FlightModel);

      // スロットルは前進推力へ写像 (throttle 0..1)。X(ブレーキ)で後退はしない。
      ti.linear.set(0, 0, axes.throttle);
      ti.angular.set(axes.pitch, axes.yaw, axes.roll);
      ti.afterburner = discrete.afterburner;
      ti.firePrimary = discrete.firePrimary;
      ti.fireMissile = discrete.fireMissile;

      if (edges.toggleFlightAssist) fm.flightAssist = !fm.flightAssist;

      this.handleTargeting(world, entity, edges);
    }

    this.input.clearEdges();
  }

  private handleTargeting(
    world: World,
    entity: EntityId,
    edges: ReturnType<InputManager["sampleEdges"]>,
  ): void {
    if (!world.has(entity, Comp.Targeting)) return;
    const targeting = world.getOrThrow<Targeting>(entity, Comp.Targeting);
    const myFaction = world.get<Faction>(entity, Comp.Faction) ?? Faction.Player;

    if (edges.cycleTargetNext) {
      targeting.target = selectNextTarget(world, myFaction, targeting.target);
      targeting.lockProgress = 0;
      targeting.lockTime = 0;
    }
    if (edges.cycleTargetNearest) {
      const t = world.get<Transform>(entity, Comp.Transform);
      if (t) {
        targeting.target = selectNearestTarget(world, myFaction, t.position);
        targeting.lockProgress = 0;
        targeting.lockTime = 0;
      }
    }
    if (edges.targetFront) {
      const t = world.get<Transform>(entity, Comp.Transform);
      if (t) {
        const dir = this.forward.clone().applyQuaternion(t.quaternion);
        targeting.target = selectFrontTarget(world, myFaction, t.position, dir);
        targeting.lockProgress = 0;
        targeting.lockTime = 0;
      }
    }
  }
}
