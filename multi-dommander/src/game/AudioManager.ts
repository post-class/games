import type { EventBus } from "../util/EventBus";

/**
 * Web Audio API による効果音の合成再生 (音源ファイル不要)。
 * EventBus のゲームイベントを購読し、発射/被弾/爆発などをその場で合成する。
 * ブラウザの自動再生制限のため、最初のユーザー操作で enable() を呼んで有効化する。
 */
export class AudioManager {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  /** 直近の砲声時刻 (連射の音の重なりを間引く)。 */
  private lastGunAt = 0;

  constructor(events: EventBus) {
    events.on("weaponFired", (e) => (e.kind === "gun" ? this.gun() : this.missile()));
    events.on("hit", () => this.hit());
    events.on("destroyed", () => this.explosion());
  }

  get enabled(): boolean {
    return this.ctx !== null;
  }

  /** ユーザー操作後に呼ぶと AudioContext を有効化する。 */
  enable(): void {
    if (this.ctx) return;
    try {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.35;
      this.master.connect(this.ctx.destination);
      this.noiseBuffer = this.makeNoiseBuffer(0.6);
    } catch {
      this.ctx = null;
    }
  }

  private makeNoiseBuffer(seconds: number): AudioBuffer {
    const ctx = this.ctx!;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  private now(): number {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  /** 減衰エンベロープつきのトーン。 */
  private tone(
    type: OscillatorType,
    freqStart: number,
    freqEnd: number,
    duration: number,
    gain: number,
  ): void {
    if (!this.ctx || !this.master) return;
    const t = this.now();
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freqStart, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, freqEnd), t + duration);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + duration + 0.02);
  }

  /** フィルタ付きノイズバースト (爆発/被弾/噴射音の素材)。 */
  private noise(duration: number, filterFreq: number, gain: number, sweepTo?: number): void {
    if (!this.ctx || !this.master || !this.noiseBuffer) return;
    const t = this.now();
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const filter = this.ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(filterFreq, t);
    if (sweepTo) filter.frequency.exponentialRampToValueAtTime(Math.max(1, sweepTo), t + duration);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    src.connect(filter).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + duration + 0.02);
  }

  private gun(): void {
    if (!this.ctx) return;
    // 連射音の重なりを間引く。
    const t = this.now();
    if (t - this.lastGunAt < 0.04) return;
    this.lastGunAt = t;
    this.tone("square", 880, 180, 0.12, 0.18);
  }

  private missile(): void {
    this.tone("sawtooth", 300, 60, 0.5, 0.2);
    this.noise(0.5, 1200, 0.12, 200);
  }

  private hit(): void {
    this.tone("triangle", 500, 200, 0.08, 0.12);
  }

  private explosion(): void {
    this.noise(0.7, 900, 0.5, 60);
    this.tone("sine", 120, 40, 0.6, 0.3);
  }
}
