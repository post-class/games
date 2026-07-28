import { Vector3 } from "three";
import type { System } from "../../ecs/System";
import type { World } from "../../ecs/World";
import type { EntityId } from "../../ecs/Entity";
import { Comp, Faction } from "../components";
import type { ThrusterInput, FlightModel, Transform, Targeting, WeaponMount } from "../components";
import type { AIController, WingOrder } from "../components/AIController";
import type { InputManager, FlightAxes, DiscreteActions, EdgeActions } from "../input/InputManager";
import { selectNextTarget, selectNearestTarget, selectFrontTarget } from "./TargetingSystem";

/**
 * プレイヤー入力を PlayerControlled エンティティの ThrusterInput に反映する。
 * フライトアシスト切替・ターゲット選択・僚機コマンドなどのエッジ操作もここで処理する。
 */
export class InputSystem implements System {
  readonly name = "InputSystem";
  private readonly forward = new Vector3(0, 0, 1);

  constructor(
    private readonly input: InputManager,
    private readonly announce: (text: string) => void = () => {},
    private readonly onDropFlare?: () => void,
    /** 訓練モード用: 毎フレームの入力サンプルとターゲット有無を通知する (GameController.updateTutorial へ橋渡し)。 */
    private readonly onTutorialCheck?: (
      axes: FlightAxes,
      discrete: DiscreteActions,
      edges: EdgeActions,
      hasTarget: boolean,
      dt: number,
    ) => void,
    /** Esc (pause エッジ) が入力された際に呼ぶ (GameController.pause への橋渡し)。 */
    private readonly onPause?: () => void,
  ) {}

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

      // フレア射出。
      if (edges.dropFlare && world.has(entity, Comp.WeaponMount)) {
        const wm = world.getOrThrow<WeaponMount>(entity, Comp.WeaponMount);
        if (wm.flares > 0) {
          wm.flares--;
          this.onDropFlare?.();
        }
      }

      // 副兵装(ミサイル種)の巡回切替。
      if (edges.cycleSecondary && world.has(entity, Comp.WeaponMount)) {
        const wm = world.getOrThrow<WeaponMount>(entity, Comp.WeaponMount);
        const secondaries = wm.secondaries;
        if (secondaries && secondaries.length > 0) {
          const current = wm.activeSecondary ?? 0;
          wm.activeSecondary = (current + 1) % secondaries.length;
        }
      }

      this.handleTargeting(world, entity, edges);

      if (this.onTutorialCheck) {
        const targeting = world.get<Targeting>(entity, Comp.Targeting);
        const hasTarget =
          !!targeting && targeting.target !== null && world.isAlive(targeting.target);
        this.onTutorialCheck(axes, discrete, edges, hasTarget, dt);
      }
    }

    this.handleWingCommands(world, edges);

    if (edges.pause) this.onPause?.();

    if (edges.toggleMouseFlight) {
      this.input.mouseFlightEnabled = !this.input.mouseFlightEnabled;
      if (this.input.mouseFlightEnabled) this.input.mouse.resetToCenter();
      this.announce(this.input.mouseFlightEnabled ? "マウス操縦: ON" : "マウス操縦: OFF");
    }

    this.input.clearEdges();
  }

  /** 僚機 (Ally AIController) へ指示を伝達する。 */
  private handleWingCommands(world: World, edges: ReturnType<InputManager["sampleEdges"]>): void {
    let order: WingOrder | null = null;
    let text = "";
    if (edges.cmdFormUp) {
      order = "formUp";
      text = "僚機: 編隊を組め";
    } else if (edges.cmdAttackTarget) {
      order = "attackTarget";
      text = "僚機: 私の敵を攻撃せよ";
    } else if (edges.cmdEngage) {
      order = "engage";
      text = "僚機: 各自交戦せよ";
    }
    if (order === null) return;

    let count = 0;
    for (const e of world.query(Comp.AIController, Comp.Faction)) {
      if (world.get<Faction>(e, Comp.Faction) !== Faction.Ally) continue;
      const ai = world.getOrThrow<AIController>(e, Comp.AIController);
      if (ai.role !== "ally") continue;
      ai.order = order;
      count++;
    }
    if (count > 0) this.announce(text);
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
