import type { FlightAxes, DiscreteActions, EdgeActions } from "../input/InputManager";

/** 訓練ミッションの進行ステップ。 */
export type TutorialStep = "steer" | "throttle" | "target" | "firePrimary" | "fireMissile" | "complete";

/** 旋回入力を維持すべき秒数 (旋回操作の習得判定)。 */
const STEER_HOLD_SECONDS = 2;
/** 旋回操作とみなす入力閾値。 */
const STEER_THRESHOLD = 0.3;
/** スロットル操作とみなす閾値。 */
const THROTTLE_THRESHOLD = 0.5;

/**
 * 訓練ミッションのステップ進行を管理する純粋なステートマシン。
 * 入力を毎フレーム checkProgress() に渡し、条件を満たせば次のステップへ進む。
 * ワールド/ECSには依存せず、InputManager が生成する軸/離散/エッジ入力のみを見る。
 */
export class TutorialManager {
  currentStep: TutorialStep = "steer";
  /** 旋回入力を維持している時間 (秒)。閾値未満に落ちるとリセット。 */
  private steerHoldTime = 0;

  constructor(private readonly mouseEnabled: boolean) {}

  /** 現在のステップに対応する指示テキストを返す。 */
  getInstructionText(): string {
    switch (this.currentStep) {
      case "steer":
        return this.mouseEnabled
          ? "マウスまたは矢印キーで機体を旋回させよう"
          : "矢印キーで機体を旋回させよう";
      case "throttle":
        return "スロットルを50%以上に上げよう";
      case "target":
        return "ターゲットを選択しよう (T / R / Y)";
      case "firePrimary":
        return "主砲を発射しよう (Space / 左クリック)";
      case "fireMissile":
        return "ミサイルを発射しよう (Enter / 右クリック)";
      case "complete":
        return "訓練完了！ 敵を撃墜して任務完了だ";
    }
  }

  /** 完了判定。 */
  isComplete(): boolean {
    return this.currentStep === "complete";
  }

  /**
   * 入力を検証して次のステップへ進むかチェックする。
   * 進んだ場合は true を返す。
   */
  checkProgress(
    axes: FlightAxes,
    discrete: DiscreteActions,
    edges: EdgeActions,
    hasTarget: boolean,
    dt: number,
  ): boolean {
    switch (this.currentStep) {
      case "steer": {
        const steering = Math.abs(axes.pitch) >= STEER_THRESHOLD || Math.abs(axes.yaw) >= STEER_THRESHOLD;
        this.steerHoldTime = steering ? this.steerHoldTime + dt : 0;
        if (this.steerHoldTime >= STEER_HOLD_SECONDS) {
          this.advance("throttle");
          return true;
        }
        return false;
      }
      case "throttle":
        if (axes.throttle >= THROTTLE_THRESHOLD) {
          this.advance("target");
          return true;
        }
        return false;
      case "target":
        if (hasTarget || edges.cycleTargetNext || edges.cycleTargetNearest || edges.targetFront) {
          this.advance("firePrimary");
          return true;
        }
        return false;
      case "firePrimary":
        if (discrete.firePrimary) {
          this.advance("fireMissile");
          return true;
        }
        return false;
      case "fireMissile":
        if (discrete.fireMissile) {
          this.advance("complete");
          return true;
        }
        return false;
      case "complete":
        return false;
    }
  }

  private advance(next: TutorialStep): void {
    this.currentStep = next;
    this.steerHoldTime = 0;
  }
}
