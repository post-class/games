import { onSettingsChanged, settings } from '../app/settings';

/**
 * Web Audio API による合成効果音。音源ファイルを持たない。
 * ブラウザの制約でユーザー操作まで音を出せないため、resume() を入力時に呼ぶ。
 */
export class AudioManager {
  private ctx?: AudioContext;
  private master?: GainNode;
  private sfxBus?: GainNode;
  private musicBus?: GainNode;
  private noiseBuffer?: AudioBuffer;
  private engine?: { osc: OscillatorNode; noise: AudioBufferSourceNode; gain: GainNode; filter: BiquadFilterNode };
  private unsub: () => void;
  /** 同時発音数を抑えるための直近再生時刻 */
  private lastPlay = new Map<string, number>();

  constructor() {
    this.unsub = onSettingsChanged(() => this.applyVolumes());
  }

  /** 入力があったタイミングで呼ぶ (自動再生制限の解除) */
  resume(): void {
    if (!this.ctx) this.init();
    if (this.ctx?.state === 'suspended') void this.ctx.resume();
  }

  get context(): AudioContext | undefined {
    return this.ctx;
  }

  get musicNode(): GainNode | undefined {
    return this.musicBus;
  }

  /** HTMLAudioElementをBGMバスへ接続する。接続失敗時は呼び出し側が無音で継続する。 */
  connectMusicElement(media: HTMLMediaElement): MediaElementAudioSourceNode | undefined {
    if (!this.ctx || !this.musicBus) return undefined;
    const source = this.ctx.createMediaElementSource(media);
    source.connect(this.musicBus);
    return source;
  }

  private init(): void {
    const Ctor: typeof AudioContext | undefined =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    this.ctx = new Ctor();
    this.master = this.ctx.createGain();
    this.sfxBus = this.ctx.createGain();
    this.musicBus = this.ctx.createGain();
    this.sfxBus.connect(this.master);
    this.musicBus.connect(this.master);
    this.master.connect(this.ctx.destination);
    this.applyVolumes();

    // ホワイトノイズのバッファを1本作って使い回す
    const len = Math.floor(this.ctx.sampleRate * 1.5);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    this.noiseBuffer = buf;
  }

  private applyVolumes(): void {
    if (!this.ctx || !this.master || !this.sfxBus || !this.musicBus) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(settings.volumeMaster, t, 0.05);
    this.sfxBus.gain.setTargetAtTime(settings.volumeSfx, t, 0.05);
    this.musicBus.gain.setTargetAtTime(settings.volumeMusic * 0.6, t, 0.05);
  }

  /** 連続発音を間引く (同じ音が1フレームに大量に鳴るのを防ぐ) */
  private throttled(key: string, minInterval: number): boolean {
    const now = this.ctx?.currentTime ?? 0;
    const last = this.lastPlay.get(key) ?? -Infinity;
    if (now - last < minInterval) return true;
    this.lastPlay.set(key, now);
    return false;
  }

  /** 距離と左右位置からゲインとパンを作る */
  private spatial(gain: number, distance: number, pan: number): GainNode | undefined {
    if (!this.ctx || !this.sfxBus) return undefined;
    const atten = 1 / (1 + (distance / 900) ** 2);
    const g = this.ctx.createGain();
    g.gain.value = Math.max(0, gain * atten);
    const p = this.ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    g.connect(p);
    p.connect(this.sfxBus);
    return g;
  }

  private noise(duration: number): AudioBufferSourceNode | undefined {
    if (!this.ctx || !this.noiseBuffer) return undefined;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    src.start();
    src.stop(this.ctx.currentTime + duration);
    return src;
  }

  // ───────── 効果音 ─────────

  /** 砲撃。武装によって音色を変える。 */
  gun(weaponId: string, distance: number, pan: number): void {
    if (!this.ctx) return;
    if (this.throttled(`gun-${weaponId}`, 0.045)) return;
    const t = this.ctx.currentTime;
    const out = this.spatial(0.35, distance, pan);
    if (!out) return;

    const osc = this.ctx.createOscillator();
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    const env = this.ctx.createGain();

    switch (weaponId) {
      case 'mass-driver':
        osc.type = 'square';
        osc.frequency.setValueAtTime(240, t);
        osc.frequency.exponentialRampToValueAtTime(70, t + 0.12);
        filter.frequency.value = 800;
        filter.Q.value = 1.2;
        break;
      case 'neutron-gun':
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(140, t);
        osc.frequency.exponentialRampToValueAtTime(50, t + 0.2);
        filter.frequency.value = 520;
        filter.Q.value = 2.5;
        break;
      case 'particle-cannon':
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(1400, t);
        osc.frequency.exponentialRampToValueAtTime(320, t + 0.1);
        filter.frequency.value = 2400;
        filter.Q.value = 1;
        break;
      default: // laser
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(900, t);
        osc.frequency.exponentialRampToValueAtTime(180, t + 0.09);
        filter.frequency.value = 1800;
        filter.Q.value = 1.6;
        break;
    }
    env.gain.setValueAtTime(0.9, t);
    env.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
    osc.connect(filter);
    filter.connect(env);
    env.connect(out);
    osc.start(t);
    osc.stop(t + 0.2);
  }

  /** シールドで弾かれた金属音 */
  shieldHit(distance: number, pan: number): void {
    if (!this.ctx) return;
    if (this.throttled('shield', 0.03)) return;
    const t = this.ctx.currentTime;
    const out = this.spatial(0.4, distance, pan);
    if (!out) return;
    const osc = this.ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(1600, t);
    osc.frequency.exponentialRampToValueAtTime(600, t + 0.18);
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0.7, t);
    env.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
    osc.connect(env);
    env.connect(out);
    osc.start(t);
    osc.stop(t + 0.25);
  }

  /** 装甲/船体への被弾 */
  armorHit(distance: number, pan: number): void {
    if (!this.ctx) return;
    if (this.throttled('armor', 0.03)) return;
    const t = this.ctx.currentTime;
    const out = this.spatial(0.5, distance, pan);
    if (!out) return;
    const src = this.noise(0.2);
    if (!src) return;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(2200, t);
    filter.frequency.exponentialRampToValueAtTime(300, t + 0.18);
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0.8, t);
    env.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
    src.connect(filter);
    filter.connect(env);
    env.connect(out);
  }

  /** 爆発。大きさで長さと低音の量を変える。 */
  explosion(distance: number, pan: number, big: boolean): void {
    if (!this.ctx) return;
    if (this.throttled(big ? 'boom-big' : 'boom', 0.05)) return;
    const t = this.ctx.currentTime;
    const dur = big ? 1.6 : 0.7;
    const out = this.spatial(big ? 0.9 : 0.55, distance, pan);
    if (!out) return;

    const src = this.noise(dur);
    if (src) {
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(big ? 2600 : 1800, t);
      filter.frequency.exponentialRampToValueAtTime(120, t + dur * 0.8);
      const env = this.ctx.createGain();
      env.gain.setValueAtTime(1, t);
      env.gain.exponentialRampToValueAtTime(0.001, t + dur);
      src.connect(filter);
      filter.connect(env);
      env.connect(out);
    }
    // 低音の押し
    const sub = this.ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(big ? 90 : 130, t);
    sub.frequency.exponentialRampToValueAtTime(28, t + dur * 0.7);
    const subEnv = this.ctx.createGain();
    subEnv.gain.setValueAtTime(big ? 1.1 : 0.6, t);
    subEnv.gain.exponentialRampToValueAtTime(0.001, t + dur * 0.9);
    sub.connect(subEnv);
    subEnv.connect(out);
    sub.start(t);
    sub.stop(t + dur);
  }

  /** ミサイル発射 */
  missileLaunch(distance: number, pan: number): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const out = this.spatial(0.6, distance, pan);
    if (!out) return;
    const src = this.noise(0.9);
    if (!src) return;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 1.4;
    filter.frequency.setValueAtTime(400, t);
    filter.frequency.exponentialRampToValueAtTime(2600, t + 0.5);
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(0.9, t + 0.08);
    env.gain.exponentialRampToValueAtTime(0.001, t + 0.85);
    src.connect(filter);
    filter.connect(env);
    env.connect(out);
  }

  /** UI・警報のビープ */
  beep(freq: number, duration = 0.08, gain = 0.25, type: OscillatorType = 'square'): void {
    if (!this.ctx || !this.sfxBus) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(gain, t + 0.01);
    env.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    osc.connect(env);
    env.connect(this.sfxBus);
    osc.start(t);
    osc.stop(t + duration + 0.02);
  }

  lockTone(complete: boolean): void {
    if (this.throttled('lock', complete ? 0.4 : 0.22)) return;
    this.beep(complete ? 1500 : 900, complete ? 0.14 : 0.06, 0.22, 'square');
  }

  warning(kind: 'missile' | 'lock' | 'shield'): void {
    if (this.throttled(`warn-${kind}`, 0.85)) return;
    if (kind === 'missile') {
      this.beep(1200, 0.1, 0.3, 'square');
      setTimeout(() => this.beep(1200, 0.1, 0.3, 'square'), 130);
    } else if (kind === 'lock') {
      this.beep(760, 0.12, 0.2, 'triangle');
    } else {
      this.beep(420, 0.18, 0.22, 'sawtooth');
    }
  }

  /**
   * ジャンプ (オートパイロット) の音。
   * 開始で上がり、終了で下がる。鳴っている間は低い唸りを保つ。
   */
  warpTone(on: boolean): void {
    if (!this.ctx || !this.sfxBus) return;
    const t = this.ctx.currentTime;

    // 立ち上がり/立ち下がりのスイープ
    const osc = this.ctx.createOscillator();
    osc.type = 'sawtooth';
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    const env = this.ctx.createGain();
    if (on) {
      osc.frequency.setValueAtTime(80, t);
      osc.frequency.exponentialRampToValueAtTime(520, t + 0.7);
      filter.frequency.setValueAtTime(300, t);
      filter.frequency.exponentialRampToValueAtTime(2600, t + 0.7);
    } else {
      osc.frequency.setValueAtTime(520, t);
      osc.frequency.exponentialRampToValueAtTime(90, t + 0.55);
      filter.frequency.setValueAtTime(2400, t);
      filter.frequency.exponentialRampToValueAtTime(320, t + 0.55);
    }
    const dur = on ? 0.8 : 0.65;
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(0.16, t + 0.08);
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(filter);
    filter.connect(env);
    env.connect(this.sfxBus);
    osc.start(t);
    osc.stop(t + dur + 0.05);

    // 風切り音
    const src = this.noise(dur);
    if (src) {
      const bp = this.ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(on ? 500 : 2200, t);
      bp.frequency.exponentialRampToValueAtTime(on ? 2600 : 500, t + dur);
      bp.Q.value = 0.7;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.09, t + 0.12);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      src.connect(bp);
      bp.connect(g);
      g.connect(this.sfxBus);
    }
  }

  // ───────── 無線の声 ─────────

  /**
   * 無線の「喋っている感じ」を合成する。
   *
   * 実音声を持てないので、帯域を絞ったパルス列で音節の輪郭だけを作る。
   * 話者ごとに基本周波数を変え、口調 (tone) で抑揚の向きを変える。
   * 戻り値は喋り終わるまでの秒数 (顔の口の動きと合わせるために返す)。
   */
  radioVoice(text: string, tone: 'friendly' | 'enemy' | 'command' = 'friendly', speaker = ''): number {
    if (!this.ctx || !this.sfxBus) return 0;
    const t0 = this.ctx.currentTime;

    // 話者名から基本周波数を決める (同じ人物なら毎回同じ声になる)
    let h = 0;
    for (let i = 0; i < speaker.length; i++) h = (h * 31 + speaker.charCodeAt(i)) >>> 0;
    const base =
      tone === 'enemy' ? 105 + (h % 30) : tone === 'command' ? 120 + (h % 26) : 150 + (h % 60);

    // 音節数はテキスト長から。長すぎる台詞でも 2 秒程度で切り上げる
    const syllables = Math.max(2, Math.min(14, Math.round(text.length / 2.4)));
    const step = 0.085;
    const dur = syllables * step;

    // 無線のスケルチ (開くカチッという音)
    this.squelch(t0, 0.035);

    const out = this.ctx.createGain();
    out.gain.value = 0.5;
    // 電話帯域に絞ると「無線越し」に聞こえる
    const band = this.ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = tone === 'enemy' ? 900 : 1200;
    band.Q.value = 0.9;
    out.connect(band);
    band.connect(this.sfxBus);

    for (let i = 0; i < syllables; i++) {
      const at = t0 + 0.04 + i * step;
      // 抑揚: 文末を敵は下げ、味方は少し上げる
      const curve = i / Math.max(1, syllables - 1);
      const bend = tone === 'enemy' ? -0.18 : tone === 'command' ? -0.06 : 0.1;
      const freq = base * (1 + bend * curve + ((h >> i) & 3) * 0.03);
      const len = step * (0.55 + ((h >> (i * 2)) & 3) * 0.1);

      const osc = this.ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(freq, at);
      osc.frequency.linearRampToValueAtTime(freq * 1.04, at + len);
      const env = this.ctx.createGain();
      env.gain.setValueAtTime(0.0001, at);
      env.gain.exponentialRampToValueAtTime(0.09, at + len * 0.25);
      env.gain.exponentialRampToValueAtTime(0.0001, at + len);
      osc.connect(env);
      env.connect(out);
      osc.start(at);
      osc.stop(at + len + 0.02);
    }

    // 喋っている間の弱いキャリアノイズ
    const hiss = this.noise(dur + 0.1);
    if (hiss) {
      const hp = this.ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 1800;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.02, t0);
      g.gain.setValueAtTime(0.02, t0 + dur);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur + 0.1);
      hiss.connect(hp);
      hp.connect(g);
      g.connect(this.sfxBus);
    }

    // 閉じるスケルチ
    this.squelch(t0 + dur + 0.05, 0.05);
    return dur + 0.1;
  }

  /** 無線を開閉するときの短いノイズ */
  private squelch(at: number, dur: number): void {
    if (!this.ctx || !this.sfxBus) return;
    const src = this.noise(dur + 0.05);
    if (!src) return;
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 2200;
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0.0001, at);
    env.gain.exponentialRampToValueAtTime(0.06, at + 0.005);
    env.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    src.connect(hp);
    hp.connect(env);
    env.connect(this.sfxBus);
  }

  // ───────── エンジン音 ─────────

  /** 自機のエンジン音を更新する (0..1 の出力と AB) */
  updateEngine(power: number, afterburner: boolean, alive: boolean): void {
    if (!this.ctx || !this.sfxBus) return;
    const t = this.ctx.currentTime;
    if (!this.engine) {
      const osc = this.ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = 60;
      const noise = this.noise(1e6);
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 300;
      const gain = this.ctx.createGain();
      gain.gain.value = 0;
      osc.connect(filter);
      if (noise) noise.connect(filter);
      filter.connect(gain);
      gain.connect(this.sfxBus);
      osc.start();
      if (!noise) return;
      this.engine = { osc, noise, gain, filter };
    }
    const e = this.engine;
    const target = alive ? 0.05 + power * 0.09 + (afterburner ? 0.12 : 0) : 0;
    e.gain.gain.setTargetAtTime(target, t, 0.12);
    e.osc.frequency.setTargetAtTime(50 + power * 45 + (afterburner ? 40 : 0), t, 0.15);
    e.filter.frequency.setTargetAtTime(220 + power * 500 + (afterburner ? 900 : 0), t, 0.15);
  }

  /** ミッション終了などでエンジン音を止める */
  stopEngine(): void {
    if (!this.ctx || !this.engine) return;
    this.engine.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.15);
  }

  dispose(): void {
    this.unsub();
    this.stopEngine();
    void this.ctx?.close();
    this.ctx = undefined;
  }
}

export const audio = new AudioManager();
