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
    this.accumulator += frameTime;

    let steps = 0;
    while (this.accumulator >= PHYSICS.fixedDt && steps < PHYSICS.maxSubSteps) {
      this.scheduler.runFixed(this.world, PHYSICS.fixedDt);
      this.simTime += PHYSICS.fixedDt;
      this.accumulator -= PHYSICS.fixedDt;
      steps++;
    }

    const alpha = this.accumulator / PHYSICS.fixedDt;
    this.scheduler.runVariable(this.world, frameTime, alpha);
    this.render.renderer.render(this.render.scene, this.render.camera);

    this.rafId = requestAnimationFrame(this.frame);
  };
}
