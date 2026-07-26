import type { Vector3 } from "three";
import type { EntityId } from "../../ecs/Entity";

export type AIState = "Idle" | "Pursue" | "Attack" | "Evade" | "Form";

/** 僚機への指示。enemy には無関係。 */
export type WingOrder = "engage" | "formUp" | "attackTarget";

/** AIの役割。ally は僚機挙動 (編隊/指示)、enemy は自律交戦。 */
export type AIRole = "enemy" | "ally";

/** AIの状態と個体パラメータ。 */
export interface AIController {
  role: AIRole;
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
  /** 僚機の指示 (ally のみ)。 */
  order: WingOrder;
  /** 編隊スロット番号 (ally のみ、隊形位置の決定に使う)。 */
  formationSlot: number;
}
