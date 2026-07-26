import type { EventBus } from "../util/EventBus";

/**
 * サウンドの差し込み口 (雛形)。
 * 現状は Web Audio API による発音を行わず、EventBus のゲームイベントを購読するだけ。
 * 実音源を用意したら playTone/loadSample を実装して各ハンドラから鳴らす。
 */
export class AudioManager {
  private ctx: AudioContext | null = null;

  constructor(events: EventBus) {
    events.on("weaponFired", (e) => this.onWeaponFired(e.kind));
    events.on("hit", () => this.onHit());
    events.on("destroyed", () => this.onDestroyed());
  }

  get enabled(): boolean {
    return this.ctx !== null;
  }

  /** ユーザー操作後に呼ぶと AudioContext を有効化する (ブラウザの自動再生制限対策)。 */
  enable(): void {
    if (this.ctx) return;
    try {
      this.ctx = new AudioContext();
    } catch {
      this.ctx = null;
    }
  }

  private onWeaponFired(_kind: "gun" | "missile"): void {
    // TODO: 発射音。
  }

  private onHit(): void {
    // TODO: 被弾音。
  }

  private onDestroyed(): void {
    // TODO: 爆発音。
  }
}
