import type { WebGLRenderer } from "three";
import type { System } from "../ecs/System";
import type { World } from "../ecs/World";

/**
 * 開発用の性能オーバーレイ (F3 でトグル)。
 * FPS・フレーム時間・ドローコール・アクティブVFX数を右下に表示する。
 * 60fps 予算 (各フェーズの受け入れ基準) を常時監視するための基準線。
 */
export class PerfOverlay implements System {
  readonly name = "PerfOverlay";
  private readonly el: HTMLDivElement;
  private visible = false;
  private acc = 0;
  private frames = 0;
  private fps = 0;
  private frameMs = 0;

  constructor(
    container: HTMLElement,
    private readonly renderer: WebGLRenderer,
    private readonly getVfxCount: () => number,
  ) {
    this.el = document.createElement("div");
    this.el.style.cssText = [
      "position:absolute",
      "right:8px",
      "bottom:8px",
      "z-index:50",
      "padding:6px 10px",
      "font:11px/1.4 monospace",
      "color:#8fffc8",
      "background:rgba(0,10,20,0.6)",
      "border:1px solid rgba(120,255,200,0.3)",
      "border-radius:4px",
      "pointer-events:none",
      "white-space:pre",
      "display:none",
    ].join(";");
    container.appendChild(this.el);
    window.addEventListener("keydown", (e) => {
      if (e.code === "F3") {
        this.visible = !this.visible;
        this.el.style.display = this.visible ? "block" : "none";
      }
    });
  }

  update(_world: World, dt: number): void {
    if (!this.visible) return;
    this.acc += dt;
    this.frames++;
    if (this.acc >= 0.5) {
      this.fps = this.frames / this.acc;
      this.frameMs = (this.acc / this.frames) * 1000;
      this.acc = 0;
      this.frames = 0;
      const info = this.renderer.info.render;
      this.el.textContent =
        `FPS  ${this.fps.toFixed(0)}  (${this.frameMs.toFixed(1)}ms)\n` +
        `draw ${info.calls}  tri ${(info.triangles / 1000).toFixed(1)}k\n` +
        `vfx  ${this.getVfxCount()}`;
    }
  }
}
