import { Vector3, Quaternion } from "three";
import type { System } from "../../ecs/System";
import type { World } from "../../ecs/World";
import type { EntityId } from "../../ecs/Entity";
import { Comp, Faction } from "../components";
import type { Transform, ThrusterInput, Targeting, RigidBody, WeaponMount } from "../components";
import type { AIController } from "../components/AIController";
import { isHostile } from "../factions";
import { computeLeadPosition } from "../../hud/ReticleCalc";
import { clamp } from "../../util/math";

const dirWorld = new Vector3();
const dirLocal = new Vector3();
const invQ = new Quaternion();
const fwdZ = new Vector3(0, 0, 1);
const slotWorld = new Vector3();
const leadPos = new Vector3();
const zeroVel = new Vector3();

interface AIContext {
  hasTarget: boolean;
  distance: number;
  aimDot: number;
  targetPos: Vector3 | null;
}

/** 編隊スロットの機体ローカルオフセット (プレイヤー基準)。 */
const FORMATION_SLOTS: Array<[number, number, number]> = [
  [-45, 3, -30],
  [45, 3, -30],
  [-80, 6, -60],
  [80, 6, -60],
];

/**
 * AI システム。
 * - enemy: 自律的に最至近の敵対機を追尾・攻撃・回避する FSM。
 * - ally (僚機): 指示 (engage/formUp/attackTarget) に従う。敵がいなければ編隊で追従。
 * プレイヤー/敵/僚機すべて共通の ThrusterInput を出力し、FlightModelSystem が処理する。
 */
export class AISystem implements System {
  readonly name = "AISystem";

  update(world: World, dt: number): void {
    const player = this.findPlayer(world);
    const entities = world.query(
      Comp.AIController,
      Comp.Transform,
      Comp.ThrusterInput,
      Comp.Faction,
    );
    for (const entity of entities) {
      const ai = world.getOrThrow<AIController>(entity, Comp.AIController);
      const t = world.getOrThrow<Transform>(entity, Comp.Transform);
      const ti = world.getOrThrow<ThrusterInput>(entity, Comp.ThrusterInput);
      const myFaction = world.getOrThrow<Faction>(entity, Comp.Faction);
      ai.stateTimer += dt;

      this.resetInput(ti);

      if (ai.role === "ally") {
        this.updateAlly(world, entity, ai, t, ti, myFaction, player);
      } else {
        this.updateEnemy(world, entity, ai, t, ti, myFaction);
      }
    }
  }

  // ---- enemy ----

  private updateEnemy(
    world: World,
    self: EntityId,
    ai: AIController,
    t: Transform,
    ti: ThrusterInput,
    myFaction: Faction,
  ): void {
    if (!this.targetValid(world, ai.target)) {
      ai.target = this.findNearestHostile(world, self, myFaction, t.position, ai.detectRange);
    }
    const ctx = this.buildContext(world, ai.target, t);
    const next = this.transition(ai, ctx);
    this.applyStateChange(ai, next);
    this.combatAction(world, self, ai, ctx, ti, t);
  }

  // ---- ally (僚機) ----

  private updateAlly(
    world: World,
    self: EntityId,
    ai: AIController,
    t: Transform,
    ti: ThrusterInput,
    myFaction: Faction,
    player: EntityId | null,
  ): void {
    // 指示に応じてターゲットを決定。
    let target: EntityId | null = null;
    if (ai.order === "attackTarget" && player !== null) {
      const pt = world.get<Targeting>(player, Comp.Targeting);
      const cand = pt?.target ?? null;
      target = this.hostileOrNull(world, myFaction, cand);
      if (target === null) {
        target = this.findNearestHostile(world, self, myFaction, t.position, ai.detectRange);
      }
    } else if (ai.order === "engage") {
      if (!this.targetValid(world, ai.target)) {
        ai.target = this.findNearestHostile(world, self, myFaction, t.position, ai.detectRange);
      }
      target = ai.target;
    }
    // formUp は交戦しない。

    if (target !== null && ai.order !== "formUp") {
      ai.target = target;
      const ctx = this.buildContext(world, target, t);
      const next = this.transition(ai, ctx);
      this.applyStateChange(ai, next);
      this.combatAction(world, self, ai, ctx, ti, t);
      return;
    }

    // 交戦対象なし → 編隊追従。
    ai.target = null;
    ai.state = "Form";
    if (player !== null && world.has(player, Comp.Transform)) {
      this.formationFollow(world, self, ai, t, ti, player);
    } else {
      ti.linear.z = 0; // プレイヤー不在時は停止気味。
    }
  }

  private formationFollow(
    world: World,
    self: EntityId,
    ai: AIController,
    t: Transform,
    ti: ThrusterInput,
    player: EntityId,
  ): void {
    const rb = world.getOrThrow<RigidBody>(self, Comp.RigidBody);
    const pt = world.getOrThrow<Transform>(player, Comp.Transform);
    const slot = FORMATION_SLOTS[ai.formationSlot % FORMATION_SLOTS.length];
    slotWorld.set(slot[0], slot[1], slot[2]).applyQuaternion(pt.quaternion).add(pt.position);
    dirWorld.copy(slotWorld).sub(t.position);
    const dist = dirWorld.length();

    if (dist > 8) {
      dirWorld.divideScalar(dist);
      this.aimAt(t, dirWorld, ti, rb.angularVelocity);
      // 距離に応じてスロットル。遠いほど速く。
      ti.linear.z = dist > 200 ? 1 : dist > 60 ? 0.7 : 0.3;
      if (dist > 400) ti.afterburner = true;
    } else {
      // スロット到達: プレイヤーの機首方向に合わせて整列。
      this.aimAt(t, fwdZ.clone().applyQuaternion(pt.quaternion), ti, rb.angularVelocity);
      ti.linear.z = 0.25;
    }
  }

  // ---- 共通ヘルパー ----

  private resetInput(ti: ThrusterInput): void {
    ti.linear.set(0, 0, 0);
    ti.angular.set(0, 0, 0);
    ti.afterburner = false;
    ti.firePrimary = false;
    ti.fireMissile = false;
  }

  private findPlayer(world: World): EntityId | null {
    const players = world.query(Comp.PlayerControlled, Comp.Transform);
    return players.length > 0 ? players[0] : null;
  }

  private targetValid(world: World, target: EntityId | null): boolean {
    return target !== null && world.isAlive(target) && world.has(target, Comp.Transform);
  }

  private hostileOrNull(world: World, myFaction: Faction, target: EntityId | null): EntityId | null {
    if (!this.targetValid(world, target)) return null;
    const f = world.get<Faction>(target!, Comp.Faction);
    return f !== undefined && isHostile(myFaction, f) ? target : null;
  }

  private findNearestHostile(
    world: World,
    self: EntityId,
    myFaction: Faction,
    pos: Vector3,
    range: number,
  ): EntityId | null {
    let best: EntityId | null = null;
    let bestDist = range * range;
    for (const e of world.query(Comp.Transform, Comp.Health, Comp.Faction)) {
      if (e === self) continue;
      const f = world.getOrThrow<Faction>(e, Comp.Faction);
      if (!isHostile(myFaction, f)) continue;
      const tt = world.getOrThrow<Transform>(e, Comp.Transform);
      const d = tt.position.distanceToSquared(pos);
      if (d < bestDist) {
        bestDist = d;
        best = e;
      }
    }
    return best;
  }

  private buildContext(world: World, target: EntityId | null, t: Transform): AIContext {
    if (!this.targetValid(world, target)) {
      return { hasTarget: false, distance: Infinity, aimDot: -1, targetPos: null };
    }
    const tt = world.getOrThrow<Transform>(target!, Comp.Transform);
    dirWorld.copy(tt.position).sub(t.position);
    const distance = dirWorld.length();
    if (distance > 1e-3) dirWorld.divideScalar(distance);
    const fwd = fwdZ.clone().applyQuaternion(t.quaternion);
    const aimDot = dirWorld.dot(fwd);
    return { hasTarget: true, distance, aimDot, targetPos: tt.position };
  }

  private transition(ai: AIController, ctx: AIContext): AIController["state"] {
    return evaluateTransition(ai, ctx);
  }

  private applyStateChange(ai: AIController, next: AIController["state"]): void {
    if (next !== ai.state) {
      ai.state = next;
      ai.stateTimer = 0;
      if (next === "Evade") {
        ai.evadeDir = new Vector3(Math.random() * 2 - 1, Math.random() * 2 - 1, 0.3).normalize();
      }
    }
  }

  /**
   * dirNorm (ワールド系の目標方向) へ機首を向ける PD 制御。
   * 比例項で角度誤差を詰め、微分項 (現在の角速度) でオーバーシュート/スパイラルを抑える。
   * angVel は機体ローカル角速度 (x=pitch, y=yaw)。
   */
  private aimAt(t: Transform, dirNorm: Vector3, ti: ThrusterInput, angVel: Vector3): void {
    invQ.copy(t.quaternion).conjugate();
    dirLocal.copy(dirNorm).applyQuaternion(invQ);
    // 機体ローカルでの目標方位角。z=前方, x=右, y=上。
    const yawErr = Math.atan2(dirLocal.x, dirLocal.z); // + = 目標が右
    const pitchErr = Math.atan2(dirLocal.y, dirLocal.z); // + = 目標が上
    const Kp = 2.4;
    const Kd = 0.45;
    // ダンピング項の符号は各軸の「入力→機首回転」の向きに合わせる。
    // ピッチは物理側で符号反転しているため +angVel.x、ヨーは -angVel.y。
    ti.angular.x = clamp(pitchErr * Kp + angVel.x * Kd, -1, 1);
    ti.angular.y = clamp(yawErr * Kp - angVel.y * Kd, -1, 1);
  }

  private combatAction(
    world: World,
    self: EntityId,
    ai: AIController,
    ctx: AIContext,
    ti: ThrusterInput,
    t: Transform,
  ): void {
    if (!ctx.hasTarget || !ctx.targetPos) {
      ti.linear.z = 0.3;
      return;
    }

    if (ai.state === "Evade" && ai.evadeDir) {
      ti.angular.x = clamp(ai.evadeDir.y, -1, 1);
      ti.angular.y = clamp(ai.evadeDir.x, -1, 1);
      ti.linear.z = 1;
      ti.afterburner = true;
      return;
    }

    // 偏差射撃: ターゲット速度と弾速から命中予測点を求め、そこへ機首を向ける。
    const rb = world.getOrThrow<RigidBody>(self, Comp.RigidBody);
    const wm = world.get<WeaponMount>(self, Comp.WeaponMount);
    const gunSpeed = wm ? wm.gunProjectileSpeed : 1300;
    const trb = ai.target !== null ? world.get<RigidBody>(ai.target, Comp.RigidBody) : undefined;
    const tvel = trb ? trb.velocity : zeroVel;
    computeLeadPosition(t.position, gunSpeed, ctx.targetPos, tvel, leadPos);

    dirWorld.copy(leadPos).sub(t.position).normalize();
    this.aimAt(t, dirWorld, ti, rb.angularVelocity);
    const fwd = fwdZ.clone().applyQuaternion(t.quaternion);
    const leadDot = dirWorld.dot(fwd);

    // ジョスト方式のスロットル制御:
    // - 至近距離で減速して団子化するのを避け、全速で突き抜けて離脱 (extension)。
    // - 中距離 (射撃帯) では速度を抑えて機首を合わせやすくする。
    // - 遠距離では全開で接近。
    // 近距離戦重視: 標的の見かけ角度が大きく命中しやすい ~300m 帯で戦う。
    const firingBand = Math.min(ai.attackRange * 0.22, 320);
    if (ctx.distance < 130) {
      // 至近でのマージは突き抜けて離脱 (次のパスへ)。
      ti.linear.z = 1;
      ti.afterburner = true;
    } else if (ctx.distance > firingBand * 1.3) {
      ti.linear.z = 1;
      if (ctx.distance > ai.attackRange * 0.7) ti.afterburner = true;
    } else {
      // 射撃帯では減速して機首を合わせ続ける。
      ti.linear.z = 0.35;
    }

    // 予測点に機首が合っていて射撃帯内なら発砲。
    if (leadDot > 0.96 && ctx.distance < firingBand * 2) {
      ti.firePrimary = true;
    }
  }
}

/** 状態遷移の純関数。現状態とコンテキストから次状態を返す。 */
export function evaluateTransition(ai: AIController, ctx: AIContext): AIController["state"] {
  if (!ctx.hasTarget) return "Idle";

  switch (ai.state) {
    case "Idle":
    case "Form":
      return "Pursue";
    case "Pursue":
      if (ctx.aimDot > 0.9 && ctx.distance < ai.attackRange) return "Attack";
      return "Pursue";
    case "Attack":
      if (ai.stateTimer > 3 + ai.aggression * 2 && ctx.distance < ai.attackRange * 0.45) {
        return "Evade";
      }
      if (ctx.aimDot < 0.55 || ctx.distance > ai.attackRange * 1.25) return "Pursue";
      return "Attack";
    case "Evade":
      if (ai.stateTimer > 1.5) return "Pursue";
      return "Evade";
    default:
      return "Pursue";
  }
}
