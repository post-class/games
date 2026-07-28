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

  /** シミュレーション全体の時間スケール (スロー演出用、既定1)。 */
  timeScale = 1;
  /** ヒットストップ残り (ミリ秒)。>0 の間はシミュレーションをほぼ停止する。 */
  private hitStopMs = 0;

  /**
   * 一瞬の時間停止 (撃墜のトドメ等の決定的瞬間に呼ぶ)。
   * シミュレーション時間のみを縮め、描画/カメラ/VFX は実時間で進み続ける (impact freeze)。
   * 固定タイムステップの積分精度 (PHYSICS.fixedDt) 自体は変更しない。
   */
  triggerHitStop(ms: number): void {
    this.hitStopMs = Math.max(this.hitStopMs, ms);
  }

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

    const elapsedMs = nowMs - this.lastMs;
    const realTime = Math.min(elapsedMs / 1000, PHYSICS.maxFrameTime);
    this.lastMs = nowMs;

    // ヒットストップ/スロー中はシミュレーションへ渡す時間のみを縮める。
    let simScale = this.timeScale;
    if (this.hitStopMs > 0) {
      simScale *= 0.05;
      this.hitStopMs = Math.max(0, this.hitStopMs - elapsedMs);
    }
    const simTime = realTime * simScale;

    if (this.shouldRunFixed()) {
      this.accumulator += simTime;
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
    // 描画・カメラ・VFX は実時間で回す (ヒットストップ中も演出は動く)。
    this.scheduler.runVariable(this.world, realTime, alpha);
    // 描画コール計測用に1フレーム分の info をここで確定させてから合成描画する
    // (PerfOverlay は runVariable 中に前フレーム分を読む)。
    this.render.renderer.info.reset();
    this.render.composer.render();

    this.rafId = requestAnimationFrame(this.frame);
  };
}
