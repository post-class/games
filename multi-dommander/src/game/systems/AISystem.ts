import { Vector3, Quaternion } from "three";
import type { System } from "../../ecs/System";
import type { World } from "../../ecs/World";
import type { EntityId } from "../../ecs/Entity";
import { Comp, Faction } from "../components";
import type { Transform, ThrusterInput } from "../components";
import type { AIController } from "../components/AIController";
import { clamp } from "../../util/math";

const dirWorld = new Vector3();
const dirLocal = new Vector3();
const invQ = new Quaternion();
const fwdZ = new Vector3(0, 0, 1);

interface AIContext {
  hasTarget: boolean;
  distance: number;
  aimDot: number; // 機首と目標方向の一致度 (-1..1)
  targetPos: Vector3 | null;
  lowHealth: boolean;
}

/**
 * 敵AI。Idle/Pursue/Attack/Evade のFSM。
 * 状態評価 (evaluateTransition) と行動生成 (computeAction) を分離しテスト容易にする。
 * 生成した ThrusterInput は FlightModelSystem がプレイヤーと同じ経路で処理する。
 */
export class AISystem implements System {
  readonly name = "AISystem";

  update(world: World, dt: number): void {
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

      // ターゲット取得/更新。
      if (ai.target === null || !world.isAlive(ai.target) || !world.has(ai.target, Comp.Transform)) {
        ai.target = this.findTarget(world, entity, myFaction, t.position, ai.detectRange);
      }

      const ctx = this.buildContext(world, entity, ai, t);
      const next = evaluateTransition(ai, ctx);
      if (next !== ai.state) {
        ai.state = next;
        ai.stateTimer = 0;
        if (next === "Evade") {
          // ランダムな回避方向 (ローカル)。
          ai.evadeDir = new Vector3(
            Math.random() * 2 - 1,
            Math.random() * 2 - 1,
            0.3,
          ).normalize();
        }
      }

      this.computeAction(ai, ctx, ti, t);
    }
  }

  private findTarget(
    world: World,
    self: EntityId,
    myFaction: Faction,
    pos: Vector3,
    range: number,
  ): EntityId | null {
    let best: EntityId | null = null;
    let bestDist = range * range;
    const candidates = world.query(Comp.Transform, Comp.Health, Comp.Faction);
    for (const e of candidates) {
      if (e === self) continue;
      const f = world.getOrThrow<Faction>(e, Comp.Faction);
      if (f === myFaction || f === Faction.Neutral) continue;
      const tt = world.getOrThrow<Transform>(e, Comp.Transform);
      const d = tt.position.distanceToSquared(pos);
      if (d < bestDist) {
        bestDist = d;
        best = e;
      }
    }
    return best;
  }

  private buildContext(
    world: World,
    _self: EntityId,
    ai: AIController,
    t: Transform,
  ): AIContext {
    if (ai.target === null) {
      return { hasTarget: false, distance: Infinity, aimDot: -1, targetPos: null, lowHealth: false };
    }
    const tt = world.getOrThrow<Transform>(ai.target, Comp.Transform);
    dirWorld.copy(tt.position).sub(t.position);
    const distance = dirWorld.length();
    if (distance > 1e-3) dirWorld.divideScalar(distance);
    const fwd = fwdZ.clone().applyQuaternion(t.quaternion);
    const aimDot = dirWorld.dot(fwd);
    return { hasTarget: true, distance, aimDot, targetPos: tt.position, lowHealth: false };
  }

  private computeAction(
    ai: AIController,
    ctx: AIContext,
    ti: ThrusterInput,
    t: Transform,
  ): void {
    // 既定は入力ゼロ。
    ti.linear.set(0, 0, 0);
    ti.angular.set(0, 0, 0);
    ti.afterburner = false;
    ti.firePrimary = false;
    ti.fireMissile = false;

    if (!ctx.hasTarget || !ctx.targetPos) {
      // 索敵中は緩やかに前進。
      ti.linear.z = 0.3;
      return;
    }

    if (ai.state === "Evade" && ai.evadeDir) {
      // 回避方向へ旋回しつつ全速前進。
      ti.angular.x = clamp(ai.evadeDir.y, -1, 1);
      ti.angular.y = clamp(ai.evadeDir.x, -1, 1);
      ti.linear.z = 1;
      ti.afterburner = true;
      return;
    }

    // Pursue / Attack: 目標方向へ機首を向ける。
    dirWorld.copy(ctx.targetPos).sub(t.position).normalize();
    invQ.copy(t.quaternion).conjugate();
    dirLocal.copy(dirWorld).applyQuaternion(invQ); // ローカル系での目標方向。

    // pitch(+で機首上げ=+y方向), yaw(+で右=+x方向)。
    const turnGain = 2.5;
    ti.angular.x = clamp(dirLocal.y * turnGain, -1, 1);
    ti.angular.y = clamp(dirLocal.x * turnGain, -1, 1);
    // 目標方向が背後なら旋回を最大化。
    if (dirLocal.z < 0) {
      ti.angular.x = Math.sign(dirLocal.y || 0.1);
      ti.angular.y = Math.sign(dirLocal.x || 0.1);
    }

    // 距離維持: 近すぎたら減速、遠ければ加速。
    const desired = ai.attackRange * 0.6;
    if (ctx.distance > desired * 1.4) {
      ti.linear.z = 1;
      if (ctx.distance > ai.attackRange * 1.5) ti.afterburner = true;
    } else if (ctx.distance < desired * 0.6) {
      ti.linear.z = 0.15;
    } else {
      ti.linear.z = 0.6;
    }

    // 攻撃: 機首が合っていて射程内なら発砲。
    if (ai.state === "Attack" && ctx.aimDot > 0.985 && ctx.distance < ai.attackRange) {
      ti.firePrimary = true;
    }
  }
}

/**
 * 状態遷移の純関数。現状態とコンテキストから次状態を返す。
 */
export function evaluateTransition(ai: AIController, ctx: AIContext): AIController["state"] {
  if (!ctx.hasTarget) return "Idle";

  switch (ai.state) {
    case "Idle":
      return "Pursue";
    case "Pursue":
      if (ctx.aimDot > 0.95 && ctx.distance < ai.attackRange) return "Attack";
      return "Pursue";
    case "Attack":
      // 一定確率/時間で回避へ (単調な張り付き防止)。
      if (ai.stateTimer > 3 + ai.aggression * 2 && ctx.distance < ai.attackRange * 0.5) {
        return "Evade";
      }
      if (ctx.aimDot < 0.7 || ctx.distance > ai.attackRange * 1.2) return "Pursue";
      return "Attack";
    case "Evade":
      if (ai.stateTimer > 1.5) return "Pursue";
      return "Evade";
    default:
      return "Pursue";
  }
}
