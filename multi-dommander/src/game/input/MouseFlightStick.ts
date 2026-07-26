import { applyDeadzoneCurve } from "../../util/math";

/**
 * マウスジョイスティック方式。画面中央を基準に、マウス位置の相対オフセットを
 * ピッチ/ヨー入力に変換する。中央から離れるほど入力が強くなる。
 */
export class MouseFlightStick {
  enabled = true;
  private mouseX = 0;
  private mouseY = 0;
  private readonly deadzone = 0.06;

  constructor(private readonly getViewport: () => { w: number; h: number }) {
    this.mouseX = window.innerWidth / 2;
    this.mouseY = window.innerHeight / 2;
  }

  onMouseMove(clientX: number, clientY: number): void {
    this.mouseX = clientX;
    this.mouseY = clientY;
  }

  /** 現在のピッチ/ヨー入力 (-1..1) を返す。 */
  sample(): { pitch: number; yaw: number } {
    if (!this.enabled) return { pitch: 0, yaw: 0 };
    const { w, h } = this.getViewport();
    const dx = (this.mouseX - w / 2) / (w / 2);
    const dy = (this.mouseY - h / 2) / (h / 2);
    const yaw = applyDeadzoneCurve(dx, this.deadzone);
    // マウス上移動(dy<0) で機首上げ(pitch+)。
    const pitch = applyDeadzoneCurve(-dy, this.deadzone);
    return { pitch, yaw };
  }
}
