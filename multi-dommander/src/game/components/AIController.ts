import type { Vector3 } from "three";
import type { EntityId } from "../../ecs/Entity";

export type AIState = "Idle" | "Pursue" | "Attack" | "Evade";

/** 敵AIの状態と個体パラメータ。 */
export interface AIController {
  state: AIState;
  target: EntityId | null;
  /** 現在状態の経過時間 (ヒステリシス用)。 */
  stateTimer: number;
  /** 0..1。旋回・攻撃の積極性。 */
  aggression: number;
  /** 回避時の目標方向 (ローカル)。 */
  evadeDir: Vector3 | null;
  /** 索敵範囲。 */
  detectRange: number;
  /** 攻撃を許可する最大距離。 */
  attackRange: number;
}
