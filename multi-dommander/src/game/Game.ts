import { World } from "../ecs/World";
import { SystemScheduler } from "../ecs/System";
import { EventBus } from "../util/EventBus";
import { PHYSICS } from "../config/physicsConfig";
import type { RenderContext } from "../render/SceneSetup";

/**
 * ゲーム全体のオーケストレーション。
 * 固定タイムステップで物理/ロジックを、可変レートで描画を回す (Fix Your Timestep)。
 */
export class Game {
  readonly world = new World();
  readonly scheduler = new SystemScheduler();
  readonly events = new EventBus();

  private accumulator = 0;
  private lastMs = 0;
  private rafId = 0;
  private running = false;

  /** 経過ゲーム時間 (秒)。シールド再生等の時刻基準に使う。 */
  simTime = 0;

  /**
   * 固定ステップ (物理・AI等) を回すかの判定。
   * ブリーフィング/デブリーフ/メニュー中は false にしてシミュレーションを凍結する。
   * 可変ステップ (描画・HUD) は常に実行される。
   */
  shouldRunFixed: () => boolean = () => true;

  constructor(readonly render: RenderContext) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastMs = performance.now();
    this.rafId = requestAnimationFrame(this.frame);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
  }

  private frame = (nowMs: number): void => {
    if (!this.running) return;

    const frameTime = Math.min((nowMs - this.lastMs) / 1000, PHYSICS.maxFrameTime);
    this.lastMs = nowMs;

    if (this.shouldRunFixed()) {
      this.accumulator += frameTime;
      let steps = 0;
      while (this.accumulator >= PHYSICS.fixedDt && steps < PHYSICS.maxSubSteps) {
        this.scheduler.runFixed(this.world, PHYSICS.fixedDt);
        this.simTime += PHYSICS.fixedDt;
        this.accumulator -= PHYSICS.fixedDt;
        steps++;
      }
    } else {
      // 凍結中は蓄積をリセットし、再開時のバースト積分を防ぐ。
      this.accumulator = 0;
    }

    const alpha = this.accumulator / PHYSICS.fixedDt;
    this.scheduler.runVariable(this.world, frameTime, alpha);
    this.render.renderer.render(this.render.scene, this.render.camera);

    this.rafId = requestAnimationFrame(this.frame);
  };
}
