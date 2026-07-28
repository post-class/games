import { Vector3 } from "three";
import type { System } from "../../ecs/System";
import type { World } from "../../ecs/World";
import type { EntityId } from "../../ecs/Entity";
import { Comp, Faction } from "../components";
import type { Transform, Targeting, WeaponMount } from "../components";
import { isHostile } from "../factions";
import type { MissionManager } from "../mission/MissionManager";

/** 敵性エンティティ (敵対関係かつ Health を持つ) の一覧。 */
function hostiles(world: World, myFaction: Faction): EntityId[] {
  const candidates = world.query(Comp.Transform, Comp.Health, Comp.Faction);
  return candidates.filter((e) => {
    const f = world.get<Faction>(e, Comp.Faction);
    return f !== undefined && isHostile(myFaction, f);
  });
}

/** ID順で次のターゲットを選ぶ (循環)。 */
export function selectNextTarget(
  world: World,
  myFaction: Faction,
  current: EntityId | null,
): EntityId | null {
  const list = hostiles(world, myFaction).sort((a, b) => a - b);
  if (list.length === 0) return null;
  if (current === null) return list[0];
  const idx = list.indexOf(current);
  return list[(idx + 1) % list.length];
}

/** 最も近い敵を選ぶ。 */
export function selectNearestTarget(
  world: World,
  myFaction: Faction,
  from: Vector3,
): EntityId | null {
  let best: EntityId | null = null;
  let bestDist = Infinity;
  for (const e of hostiles(world, myFaction)) {
    const t = world.getOrThrow<Transform>(e, Comp.Transform);
    const d = t.position.distanceToSquared(from);
    if (d < bestDist) {
      bestDist = d;
      best = e;
    }
  }
  return best;
}

/** 前方(視線方向)に最も近い敵を選ぶ。 */
export function selectFrontTarget(
  world: World,
  myFaction: Faction,
  from: Vector3,
  forward: Vector3,
): EntityId | null {
  let best: EntityId | null = null;
  let bestDot = 0.5; // 最低でも±60度以内。
  const dir = new Vector3();
  for (const e of hostiles(world, myFaction)) {
    const t = world.getOrThrow<Transform>(e, Comp.Transform);
    dir.copy(t.position).sub(from);
    if (dir.lengthSq() < 1e-6) continue;
    dir.normalize();
    const dot = dir.dot(forward);
    if (dot > bestDot) {
      bestDot = dot;
      best = e;
    }
  }
  return best;
}

/**
 * ロックオン進行の更新。ターゲットが前方の一定角度内にあり続けるとロックが進む。
 * 死亡ターゲットのクリアも行う。
 */
export class TargetingSystem implements System {
  readonly name = "TargetingSystem";
  private readonly forward = new Vector3(0, 0, 1);
  private readonly dir = new Vector3();

  /**
   * @param mission 難易度補正 (autoTarget/missileLockTimeMul) の参照元。
   *   省略時は自動ターゲット無効・ロック時間等倍で動作する (テスト等での単体利用向け)。
   */
  constructor(private readonly mission?: MissionManager) {}

  update(world: World, dt: number): void {
    const mods = this.mission?.getMods();
    const autoTarget = mods?.autoTarget ?? false;
    const lockTimeMul = mods?.missileLockTimeMul ?? 1.0;

    const entities = world.query(Comp.Targeting, Comp.Transform);
    for (const entity of entities) {
      const targeting = world.getOrThrow<Targeting>(entity, Comp.Targeting);
      if (targeting.target === null) {
        // 自動ターゲット: 前方の最寄り敵のみを候補にし、画面外の敵へ不意に切り替えない。
        if (autoTarget) {
          const t = world.getOrThrow<Transform>(entity, Comp.Transform);
          const myFaction = world.get<Faction>(entity, Comp.Faction) ?? Faction.Player;
          const fwd = this.forward.clone().applyQuaternion(t.quaternion);
          const auto = selectFrontTarget(world, myFaction, t.position, fwd);
          if (auto !== null) targeting.target = auto;
        }
        if (targeting.target === null) {
          targeting.lockProgress = 0;
          continue;
        }
      }
      // ターゲットが消滅していたら解除。
      if (!world.isAlive(targeting.target) || !world.has(targeting.target, Comp.Transform)) {
        targeting.target = null;
        targeting.lockProgress = 0;
        continue;
      }

      const t = world.getOrThrow<Transform>(entity, Comp.Transform);
      const tt = world.getOrThrow<Transform>(targeting.target, Comp.Transform);
      const fwd = this.forward.clone().applyQuaternion(t.quaternion);
      this.dir.copy(tt.position).sub(t.position);
      const dist = this.dir.length();
      if (dist > 1e-3) this.dir.divideScalar(dist);
      const dot = this.dir.dot(fwd);

      // ミサイルロックの射程/角度条件。難易度により所要時間を補正 (Easyは速い)。
      const wm = world.get<WeaponMount>(entity, Comp.WeaponMount);
      const lockRange = wm ? wm.gunRange * 1.5 : 2500;
      const lockDuration = 1.2 * lockTimeMul;
      const withinCone = dot > 0.96 && dist < lockRange;
      if (withinCone) {
        targeting.lockTime += dt;
        targeting.lockProgress = Math.min(1, targeting.lockTime / lockDuration);
      } else {
        targeting.lockTime = Math.max(0, targeting.lockTime - dt * 2);
        targeting.lockProgress = Math.min(1, targeting.lockTime / lockDuration);
      }
    }
  }
}
