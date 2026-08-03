import type { AudioManager } from './AudioManager';
import { midiToHz, TRACKS, type Layer, type Track, type TrackId } from './score';

/**
 * BGM の再生。
 *
 * 譜面 (`score.ts`) を AudioContext のクロックで先読みスケジュールする。
 * requestAnimationFrame のタイミングで鳴らすと音がよれるので、
 * 「今から lookahead 秒先までの音符を予約する」方式にしている。
 *
 * 層ごとに独立したカーソルを持つので、旋律とベースで小節の長さが違っていても崩れない。
 */

/** 何秒先まで予約するか */
const LOOKAHEAD = 0.4;

interface LayerCursor {
  layer: Layer;
  /** 次の音符の予約時刻 */
  nextAt: number;
  /** 譜面上の位置 */
  index: number;
}

export class MusicDirector {
  /** 0 = 静穏, 1 = 乱戦 */
  private intensity = 0;
  private target = 0;
  private playing = false;
  private track?: Track;
  private cursors: LayerCursor[] = [];
  /** クロスフェード用の音量 (0..1) */
  private level = 0;
  private levelTarget = 1;
  /** フェードアウト完了後に切り替える曲 */
  private pending?: TrackId;

  constructor(private audio: AudioManager) {}

  /** 曲を指定して再生する。既に別の曲が鳴っていれば短くフェードして繋ぐ */
  play(id: TrackId): void {
    this.playing = true;
    if (this.track?.id === id) {
      this.levelTarget = 1;
      this.pending = undefined;
      return;
    }
    if (this.track && this.level > 0.05) {
      // 鳴っている曲を消してから次へ
      this.pending = id;
      this.levelTarget = 0;
      return;
    }
    this.switchTo(id);
  }

  private switchTo(id: TrackId): void {
    this.track = TRACKS[id];
    this.pending = undefined;
    this.levelTarget = 1;
    this.level = 0;
    const ctx = this.audio.context;
    const at = (ctx?.currentTime ?? 0) + 0.08;
    this.cursors = this.track.layers.map((layer) => ({ layer, nextAt: at, index: 0 }));
  }

  /** 引数なしの start() は主題を鳴らす */
  start(id: TrackId = 'theme'): void {
    this.play(id);
  }

  stop(): void {
    this.playing = false;
    this.track = undefined;
    this.cursors = [];
    this.level = 0;
    this.pending = undefined;
  }

  /** 鳴らしたまま音量だけ落とす */
  fadeOut(): void {
    this.levelTarget = 0;
  }

  get current(): TrackId | undefined {
    return this.track?.id;
  }

  setIntensity(v: number): void {
    this.target = Math.max(0, Math.min(1, v));
  }

  /** 毎フレーム呼ぶ */
  update(dt: number): void {
    if (!this.playing) return;
    const ctx = this.audio.context;
    const out = this.audio.musicNode;
    if (!ctx || !out) return;

    // 急に切り替わらないよう滑らかに追従
    this.intensity += (this.target - this.intensity) * Math.min(1, dt * 0.8);
    this.level += (this.levelTarget - this.level) * Math.min(1, dt * 2.2);
    if (this.pending && this.level < 0.06) {
      this.switchTo(this.pending);
      return;
    }
    if (!this.track) return;

    const bpm = this.track.bpm + (this.track.bpmBoost ?? 0) * this.intensity;
    const beat = 60 / bpm;
    const until = ctx.currentTime + LOOKAHEAD;

    for (const c of this.cursors) {
      // 緊張度が足りない層は時間だけ進めて鳴らさない (復帰したとき位置がずれないように)
      const active = this.intensity >= (c.layer.fromIntensity ?? 0);
      while (c.nextAt < until) {
        const note = c.layer.notes[c.index % c.layer.notes.length];
        const dur = note.d * beat;
        if (active && note.n !== null) {
          this.note(ctx, out, c.layer, note.n, c.nextAt, dur);
        }
        c.nextAt += dur;
        c.index++;
      }
    }
  }

  private note(
    ctx: AudioContext,
    out: GainNode,
    layer: Layer,
    midi: number,
    at: number,
    beatDur: number,
  ): void {
    const dur = beatDur * (layer.sustain ?? 0.85);
    if (dur <= 0.01) return;
    const freq = midiToHz(midi + (layer.octave ?? 0) * 12);

    const osc = ctx.createOscillator();
    osc.type = layer.wave;
    osc.frequency.value = freq;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = layer.cutoff;

    const env = ctx.createGain();
    const gain = Math.max(0.0002, layer.gain * this.level);
    const attack = Math.min(0.06, dur * 0.25);
    env.gain.setValueAtTime(0.0001, at);
    env.gain.exponentialRampToValueAtTime(gain, at + attack);
    // 減衰を残さないと音が繋がって濁る
    env.gain.exponentialRampToValueAtTime(0.0001, at + dur);

    osc.connect(filter);
    filter.connect(env);
    env.connect(out);
    osc.start(at);
    osc.stop(at + dur + 0.05);
  }
}
