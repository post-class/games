/**
 * 演出（docs/02_ゲーム実装プラン/06_クライアント設計.md §2 の overlayRoot / tint）
 *
 * 今は「時間帯の色被せ」だけ。天気パーティクルと吹き出しはM3/M4で足す。
 * カメラ非依存なので overlayRoot に置く。
 */
import { Graphics } from 'pixi.js';
import type { Layers } from './stage.ts';

interface TintStyle {
  color: number;
  alpha: number;
}

const TOD_TINT: Record<string, TintStyle> = {
  morning: { color: 0xffd9a0, alpha: 0.1 },
  day: { color: 0xffffff, alpha: 0 },
  evening: { color: 0xff9a6a, alpha: 0.16 },
  night: { color: 0x24356e, alpha: 0.3 },
};

export class TimeTint {
  private readonly g: Graphics;
  private w = 0;
  private h = 0;
  private current: TintStyle = { color: 0xffffff, alpha: 0 };
  /** 目標値へゆっくり寄せる（時間帯が切り替わった瞬間に色が飛ばないように） */
  private goal: TintStyle = { color: 0xffffff, alpha: 0 };

  constructor(layers: Pick<Layers, 'overlayRoot'>) {
    this.g = new Graphics();
    this.g.eventMode = 'none';
    layers.overlayRoot.addChild(this.g);
  }

  setTimeOfDay(tod: string): void {
    this.goal = TOD_TINT[tod] ?? TOD_TINT['day'] ?? { color: 0xffffff, alpha: 0 };
  }

  update(w: number, h: number, dtSec: number): void {
    const k = Math.min(1, dtSec * 1.5);
    this.current = {
      color: this.goal.color,
      alpha: this.current.alpha + (this.goal.alpha - this.current.alpha) * k,
    };
    if (w !== this.w || h !== this.h) {
      this.w = w;
      this.h = h;
      this.g.clear();
      this.g.rect(0, 0, w, h).fill(0xffffff);
    }
    this.g.tint = this.current.color;
    this.g.alpha = this.current.alpha;
  }
}
