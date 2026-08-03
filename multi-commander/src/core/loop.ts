/**
 * 固定タイムステップ物理 + 可変タイムステップ描画のループ。
 * (Glenn Fiedler "Fix Your Timestep" 方式)
 */
export const FIXED_DT = 1 / 60;
const MAX_STEPS_PER_FRAME = 5;

export interface LoopCallbacks {
  /** 固定 dt で呼ばれるシミュレーション更新 */
  fixed: (dt: number) => void;
  /** 毎フレーム1回呼ばれる描画更新。alpha は次ステップへの補間係数 */
  render: (dtReal: number, alpha: number) => void;
}

export class Loop {
  private accumulator = 0;
  private lastTime = 0;
  private rafId = 0;
  private running = false;
  /** 0 でポーズ、0.3 でスローモーション等 */
  timeScale = 1;

  constructor(private cb: LoopCallbacks) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    this.accumulator = 0;
    const tick = (now: number) => {
      if (!this.running) return;
      this.rafId = requestAnimationFrame(tick);
      // タブ復帰などの巨大なジャンプは 0.25 秒で打ち切る
      const dtReal = Math.min((now - this.lastTime) / 1000, 0.25);
      this.lastTime = now;

      this.accumulator += dtReal * this.timeScale;
      let steps = 0;
      while (this.accumulator >= FIXED_DT && steps < MAX_STEPS_PER_FRAME) {
        this.cb.fixed(FIXED_DT);
        this.accumulator -= FIXED_DT;
        steps++;
      }
      if (steps === MAX_STEPS_PER_FRAME) this.accumulator = 0; // 追いつけないときは捨てる

      this.cb.render(dtReal, this.accumulator / FIXED_DT);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
  }

  get isRunning(): boolean {
    return this.running;
  }
}
