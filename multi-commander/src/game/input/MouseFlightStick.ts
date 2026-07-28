import { applyDeadzoneCurve, clamp } from "../../util/math";

export interface MouseFlightConfig {
  sensitivity: number; // 0.5..2.0, default 1.0
  invertY: boolean; // default false
  deadzone: number; // default 0.06
  curveExpo: number; // default 1.5
}

export const DEFAULT_MOUSE_CONFIG: MouseFlightConfig = {
  sensitivity: 1.0,
  invertY: false,
  deadzone: 0.06,
  curveExpo: 1.5,
};

/**
 * マウスジョイスティック方式。画面中央を基準に、マウス位置の相対オフセットを
 * ピッチ/ヨー入力に変換する。中央から離れるほど入力が強くなる。
 */
export class MouseFlightStick {
  enabled = false;
  private mouseX = 0;
  private mouseY = 0;
  private config: MouseFlightConfig;

  constructor(
    private readonly getViewport: () => { w: number; h: number },
    config?: Partial<MouseFlightConfig>,
  ) {
    this.config = { ...DEFAULT_MOUSE_CONFIG, ...config };
    this.resetToCenter();
  }

  setConfig(config: Partial<MouseFlightConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /** マウス位置を画面中央に戻す (フォーカス外れ/モード切替時のリセット用)。 */
  resetToCenter(): void {
    const { w, h } = this.getViewport();
    this.mouseX = w / 2;
    this.mouseY = h / 2;
  }

  onMouseMove(clientX: number, clientY: number): void {
    this.mouseX = clientX;
    this.mouseY = clientY;
  }

  /** 現在のピッチ/ヨー入力 (-1..1) を返す。 */
  sample(): { pitch: number; yaw: number } {
    if (!this.enabled) return { pitch: 0, yaw: 0 };
    const { w, h } = this.getViewport();
    const { sensitivity, invertY, deadzone, curveExpo } = this.config;
    const dx = (this.mouseX - w / 2) / (w / 2);
    const dy = (this.mouseY - h / 2) / (h / 2);
    const yawScaled = clamp(dx * sensitivity, -1, 1);
    const pitchSign = invertY ? 1 : -1;
    const pitchScaled = clamp(dy * pitchSign * sensitivity, -1, 1);
    const yaw = applyDeadzoneCurve(yawScaled, deadzone, curveExpo);
    const pitch = applyDeadzoneCurve(pitchScaled, deadzone, curveExpo);
    return { pitch, yaw };
  }
}
