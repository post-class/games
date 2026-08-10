import {
  onSettingsChanged,
  settings,
  sfxDurationScale,
  sfxGain,
  sfxUsesSample,
} from '../app/settings';
import type { DamageStage } from '../hud/damageStage';

type ExplosionSize = 'small' | 'large' | 'torpedo' | 'shield' | 'breach';
type MissileId = 'dumbfire' | 'heat-seeker' | 'image-rec' | 'torpedo' | (string & {});

const AFTER3_WEAPON_AUDIO_IDS = [
  'laser',
  'mass-driver',
  'neutron-gun',
  'particle-cannon',
  'dumbfire',
  'heat-seeker',
  'image-rec',
  'torpedo',
  'pulse-cannon',
  'ion-lance',
  'shield-breaker',
  'armor-breacher',
] as const;

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
  /** 比較資料で採用した after3 の実音声。読み込み失敗時は合成音へ戻す。 */
  private weaponAudioBuffers = new Map<string, AudioBuffer>();
  private weaponAudioLoads = new Map<string, Promise<void>>();
  private engine?: { osc: OscillatorNode; noise: AudioBufferSourceNode; gain: GainNode; filter: BiquadFilterNode };
  private unsub: () => void;
  /** 同時発音数を抑えるための直近再生時刻 */
  private lastPlay = new Map<string, number>();
  /** Web Audio ノードが同時に鳴り続ける数の上限。大量イベント時の音割れを防ぐ。 */
  private activeVoices: number[] = [];
  private readonly maxVoices = 32;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private musicDuck = 1;

  constructor() {
    this.unsub = onSettingsChanged(() => this.applyVolumes());
  }

  /** 入力があったタイミングで呼ぶ (自動再生制限の解除) */
  resume(): void {
    try {
      if (!this.ctx) this.init();
      if (this.ctx?.state === 'suspended') void this.ctx.resume().catch(() => undefined);
    } catch {
      // AudioContext が無い、または自動再生ポリシーに拒否されてもゲームは継続する。
    }
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
    try {
      const source = this.ctx.createMediaElementSource(media);
      source.connect(this.musicBus);
      return source;
    } catch {
      // 同じ media element の二重接続やブラウザ制限では BGM を無音で継続する。
      return undefined;
    }
  }

  private init(): void {
    if (typeof window === 'undefined') return;
    const Ctor: typeof AudioContext | undefined =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    try {
      const ctx = new Ctor();
      const master = ctx.createGain();
      const sfxBus = ctx.createGain();
      const musicBus = ctx.createGain();
      this.ctx = ctx;
      this.master = master;
      this.sfxBus = sfxBus;
      this.musicBus = musicBus;
      sfxBus.connect(master);
      musicBus.connect(master);
      master.connect(ctx.destination);
      this.applyVolumes();

      // ホワイトノイズのバッファを1本作って使い回す
      const len = Math.floor(ctx.sampleRate * 1.5);
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      this.noiseBuffer = buf;
      this.loadAfter3WeaponAudio(ctx);
    } catch {
      this.ctx = undefined;
      this.master = undefined;
      this.sfxBus = undefined;
      this.musicBus = undefined;
      this.noiseBuffer = undefined;
    }
  }

  private applyVolumes(): void {
    if (!this.ctx || !this.master || !this.sfxBus || !this.musicBus) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(settings.volumeMaster, t, 0.05);
    this.sfxBus.gain.setTargetAtTime(settings.volumeSfx, t, 0.05);
    this.musicBus.gain.setTargetAtTime(settings.volumeMusic * 0.6 * this.musicDuck, t, 0.05);
  }

  /** 戦闘の密度に合わせて BGM を少しだけ引き、命中音と無線を読ませる。 */
  setMusicDuck(amount: number): void {
    this.musicDuck = Math.max(0.55, Math.min(1, amount));
    if (this.ctx && this.musicBus) this.musicBus.gain.setTargetAtTime(settings.volumeMusic * 0.6 * this.musicDuck, this.ctx.currentTime, 0.18);
  }

  /** 宿敵・救難・母艦帰投など、記憶に残す短い音型。 */
  motif(kind: 'nemesis' | 'wingman' | 'carrier' | 'return'): void {
    const scale = sfxGain('ui');
    if (scale === null) return;
    if (!this.ctx) return;
    if (this.throttled(`motif-${kind}`, 1.2)) return;
    const notes = kind === 'nemesis' ? [196, 155, 116] : kind === 'wingman' ? [660, 523, 440] : [392, 523, 784];
    notes.forEach((frequency, i) =>
      this.delayedBeep(i * 125, frequency, 0.18, 0.16 * scale, kind === 'nemesis' ? 'sawtooth' : 'triangle'),
    );
  }

  /** 連続発音を間引く (同じ音が1フレームに大量に鳴るのを防ぐ) */
  private throttled(key: string, minInterval: number): boolean {
    const now = this.ctx?.currentTime ?? 0;
    const last = this.lastPlay.get(key) ?? -Infinity;
    if (now - last < minInterval) return true;
    this.lastPlay.set(key, now);
    return false;
  }

  private sfxAudible(): boolean {
    return settings.volumeMaster > 0 && settings.volumeSfx > 0;
  }

  /** 発音枠を予約する。終了時刻だけを持つため onended 非対応の環境でもリークしない。 */
  private reserveVoice(duration: number): boolean {
    if (!this.ctx || !this.sfxBus || !this.sfxAudible()) return false;
    const now = this.ctx.currentTime;
    this.activeVoices = this.activeVoices.filter((until) => until > now);
    if (this.activeVoices.length >= this.maxVoices) return false;
    this.activeVoices.push(now + Math.max(0.02, duration));
    return true;
  }

  private claimVoice(key: string, minInterval: number, duration: number): boolean {
    if (!this.ctx || !this.sfxAudible() || this.throttled(key, minInterval)) return false;
    return this.reserveVoice(duration);
  }

  /**
   * 少し遅らせてビープを鳴らす。
   * カテゴリ判定は呼び出し側で終わっている前提なので、実体の `emitBeep()` を呼ぶ。
   */
  private delayedBeep(delayMs: number, freq: number, duration: number, gain: number, type: OscillatorType): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      this.emitBeep(freq, duration, gain, type);
    }, delayMs);
    this.timers.add(timer);
  }

  /** 距離と左右位置からゲインとパンを作る */
  private spatial(gain: number, distance: number, pan: number): GainNode | undefined {
    if (!this.ctx || !this.sfxBus) return undefined;
    const atten = 1 / (1 + (distance / 900) ** 2);
    const g = this.ctx.createGain();
    g.gain.value = Math.max(0, gain * atten);
    try {
      const p = this.ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, pan));
      g.connect(p);
      p.connect(this.sfxBus);
    } catch {
      // StereoPanner 非対応の環境ではモノラルにフォールバックする。
      g.connect(this.sfxBus);
    }
    return g;
  }

  private noise(duration: number, at = this.ctx?.currentTime ?? 0): AudioBufferSourceNode | undefined {
    if (!this.ctx || !this.noiseBuffer) return undefined;
    try {
      const src = this.ctx.createBufferSource();
      src.buffer = this.noiseBuffer;
      src.loop = true;
      const startAt = Math.max(this.ctx.currentTime, at);
      src.start(startAt);
      src.stop(startAt + duration);
      return src;
    } catch {
      return undefined;
    }
  }

  /** after3 の採用音を先読みする。ゲーム開始直後に未完了でも合成音で継続する。 */
  private loadAfter3WeaponAudio(ctx: AudioContext): void {
    for (const id of AFTER3_WEAPON_AUDIO_IDS) {
      if (this.weaponAudioLoads.has(id) || this.weaponAudioBuffers.has(id)) continue;
      const load = fetch(`/audio/weapons/${id}-after3.wav`)
        .then((response) => {
          if (!response.ok) throw new Error(`weapon audio ${id}: ${response.status}`);
          return response.arrayBuffer();
        })
        .then((data) => ctx.decodeAudioData(data))
        .then((buffer) => {
          if (this.ctx === ctx) this.weaponAudioBuffers.set(id, buffer);
        })
        .catch(() => undefined);
      this.weaponAudioLoads.set(id, load);
    }
  }

  /** 読み込み済みの after3 を距離・左右位置付きで再生する。 */
  private playAfter3WeaponAudio(
    weaponId: string,
    distance: number,
    pan: number,
    gain: number,
  ): boolean {
    if (!this.ctx || !this.sfxBus) return false;
    const buffer = this.weaponAudioBuffers.get(weaponId);
    if (!buffer) return false;
    const out = this.spatial(gain, distance, pan);
    if (!out) return false;
    try {
      const source = this.ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(out);
      source.start(this.ctx.currentTime);
      return true;
    } catch {
      return false;
    }
  }

  // ───────── 効果音 ─────────

  /** 砲撃。武装によって音色を変える。 */
  gun(weaponId: string, distance: number, pan: number): void {
    const scale = sfxGain('gun');
    if (scale === null) return;
    const useSample = sfxUsesSample('gun');
    const after3 = useSample ? this.weaponAudioBuffers.get(weaponId) : undefined;
    const voiceDuration = after3 ? Math.min(after3.duration + 0.05, 2.5) : 0.24;
    if (!this.ctx || !this.claimVoice(`gun-${weaponId}`, weaponId === 'particle-cannon' ? 0.035 : 0.06, voiceDuration)) return;
    if (useSample && this.playAfter3WeaponAudio(weaponId, distance, pan, 0.35 * scale)) return;
    const t = this.ctx.currentTime;
    const out = this.spatial(0.35 * scale, distance, pan);
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
      case 'pulse-cannon':
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(620, t);
        osc.frequency.exponentialRampToValueAtTime(180, t + 0.14);
        filter.frequency.value = 1200;
        filter.Q.value = 1.8;
        break;
      case 'ion-lance':
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(2100, t);
        osc.frequency.exponentialRampToValueAtTime(260, t + 0.22);
        filter.frequency.value = 2800;
        filter.Q.value = 2.6;
        break;
      case 'laser':
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(900, t);
        osc.frequency.exponentialRampToValueAtTime(180, t + 0.09);
        filter.frequency.value = 1800;
        filter.Q.value = 1.6;
        break;
      default: // 未知の主砲はレーザー互換で安全に再生する
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

    // 武器ごとの識別用の副音。低域の衝撃・電気的な高域・粒子の散りを重ねる。
    if (weaponId === 'laser') {
      this.tone(out, 2500, 650, 0.08, 0.1, 0.13, t, 'triangle');
    } else if (weaponId === 'mass-driver') {
      this.tone(out, 760, 280, 0.13, 0.12, 0.18, t, 'square');
      this.tone(out, 92, 42, 0.2, 0.16, 0.2, t, 'sine');
    } else if (weaponId === 'neutron-gun') {
      this.tone(out, 1850, 420, 0.2, 0.15, 0.22, t, 'square');
      this.tone(out, 110, 42, 0.14, 0.18, 0.25, t, 'sine');
    } else if (weaponId === 'particle-cannon') {
      for (let i = 0; i < 3; i++) {
        const at = t + i * 0.025;
        this.tone(out, 2200 - i * 260, 520, 0.08, 0.045, 0.075, at, 'triangle');
      }
    } else if (weaponId === 'pulse-cannon') {
      for (let i = 0; i < 3; i++) {
        this.tone(out, 1180 - i * 150, 380, 0.07, 0.06, 0.09, t + i * 0.035, 'triangle');
      }
    } else if (weaponId === 'ion-lance') {
      this.tone(out, 3200, 620, 0.16, 0.3, 0.34, t, 'sawtooth');
      this.tone(out, 130, 48, 0.16, 0.22, 0.28, t + 0.02, 'sine');
    }
  }

  private tone(
    out: GainNode,
    startFrequency: number,
    endFrequency: number,
    gain: number,
    duration: number,
    stopAfter: number,
    at: number,
    type: OscillatorType,
  ): void {
    if (!this.ctx) return;
    const osc = this.ctx.createOscillator();
    const env = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(Math.max(1, startFrequency), at);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, endFrequency), at + duration * 0.8);
    env.gain.setValueAtTime(Math.max(0.0001, gain), at);
    env.gain.exponentialRampToValueAtTime(0.001, at + duration);
    osc.connect(env);
    env.connect(out);
    osc.start(at);
    osc.stop(at + stopAfter);
  }

  /** シールドで弾かれた金属音 */
  shieldHit(distance: number, pan: number, weaponId?: string): void {
    const scale = sfxGain('impact');
    if (scale === null) return;
    if (!this.ctx || !this.claimVoice(`shield-${weaponId ?? 'generic'}`, 0.03, 0.28)) return;
    const t = this.ctx.currentTime;
    const out = this.spatial(0.4 * scale, distance, pan);
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
    this.tone(
      out,
      weaponId === 'neutron-gun' || weaponId === 'shield-breaker' ? 2800 : 2300,
      weaponId === 'particle-cannon' ? 1200 : weaponId === 'shield-breaker' ? 1500 : 900,
      0.12,
      0.12,
      0.16,
      t,
      'square',
    );
  }

  /** 装甲/船体への被弾。船体まで抜けたときは低く重い音にする。 */
  armorHit(distance: number, pan: number, layer: 'armor' | 'hull' = 'armor', weaponId?: string): void {
    const scale = sfxGain('impact');
    if (scale === null) return;
    const key = layer === 'hull' ? 'hull' : 'armor';
    if (!this.ctx || !this.claimVoice(key, 0.03, layer === 'hull' ? 0.34 : 0.24)) return;
    const t = this.ctx.currentTime;
    const out = this.spatial((layer === 'hull' ? 0.65 : 0.5) * scale, distance, pan);
    if (!out) return;
    const src = this.noise(0.2);
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(layer === 'hull' ? 1500 : 2200, t);
    filter.frequency.exponentialRampToValueAtTime(layer === 'hull' ? 180 : 300, t + 0.18);
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(layer === 'hull' ? 1 : 0.8, t);
    env.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
    if (src) src.connect(filter);
    filter.connect(env);
    env.connect(out);
    this.tone(
      out,
      layer === 'hull' ? 120 : weaponId === 'mass-driver' ? 420 : weaponId === 'armor-breacher' ? 360 : 520,
      layer === 'hull' ? 42 : weaponId === 'particle-cannon' ? 280 : weaponId === 'armor-breacher' ? 160 : 180,
      layer === 'hull' ? 0.55 : 0.25,
      layer === 'hull' ? 0.3 : 0.16,
      layer === 'hull' ? 0.34 : 0.2,
      t,
      'sine',
    );
  }

  /** 爆発。大きさで長さと低音の量を変える。 */
  explosion(distance: number, pan: number, size: ExplosionSize | boolean): void {
    const scale = sfxGain('explosion');
    if (scale === null) return;
    const profile: ExplosionSize = size === true ? 'large' : size === false ? 'small' : size;
    const key = `boom-${profile}`;
    const duration =
      profile === 'torpedo' ? 2.1 : profile === 'large' ? 1.6 : profile === 'breach' ? 0.95 : profile === 'shield' ? 0.8 : 0.7;
    if (!this.ctx || !this.claimVoice(key, 0.05, duration + 0.1)) return;
    const t = this.ctx.currentTime;
    const dur = duration;
    const big = profile !== 'small';
    const torpedo = profile === 'torpedo';
    const out = this.spatial(
      (torpedo ? 1 : profile === 'breach' ? 0.72 : profile === 'shield' ? 0.62 : big ? 0.9 : 0.55) * scale,
      distance,
      pan,
    );
    if (!out) return;

    const src = this.noise(dur);
    if (src) {
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(
        torpedo ? 3200 : profile === 'shield' ? 4200 : profile === 'breach' ? 1900 : big ? 2600 : 1800,
        t,
      );
      filter.frequency.exponentialRampToValueAtTime(torpedo ? 90 : 120, t + dur * 0.8);
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
    sub.frequency.setValueAtTime(torpedo ? 58 : profile === 'breach' ? 72 : profile === 'shield' ? 180 : big ? 90 : 130, t);
    sub.frequency.exponentialRampToValueAtTime(torpedo ? 18 : 28, t + dur * 0.7);
    const subEnv = this.ctx.createGain();
    subEnv.gain.setValueAtTime(
      torpedo ? 1.35 : profile === 'breach' ? 0.82 : profile === 'shield' ? 0.45 : big ? 1.1 : 0.6,
      t,
    );
    subEnv.gain.exponentialRampToValueAtTime(0.001, t + dur * 0.9);
    sub.connect(subEnv);
    subEnv.connect(out);
    sub.start(t);
    sub.stop(t + dur);
    if (torpedo) this.tone(out, 180, 36, 0.5, 0.8, 1.2, t + 0.05, 'sine');
  }

  /** ミサイル発射 */
  missileLaunch(distance: number, pan: number): void;
  missileLaunch(weaponId: MissileId, distance: number, pan: number): void;
  missileLaunch(weaponOrDistance: MissileId | number, distanceOrPan: number, maybePan?: number): void {
    const weaponId: MissileId = typeof weaponOrDistance === 'string' ? weaponOrDistance : 'dumbfire';
    const distance = typeof weaponOrDistance === 'number' ? weaponOrDistance : distanceOrPan;
    const pan = typeof weaponOrDistance === 'number' ? distanceOrPan : (maybePan ?? 0);
    const scale = sfxGain('missile');
    if (scale === null) return;
    const useSample = sfxUsesSample('missile');
    const after3 = useSample ? this.weaponAudioBuffers.get(weaponId) : undefined;
    const duration = after3
      ? Math.min(after3.duration + 0.05, 2.5)
      : weaponId === 'torpedo'
        ? 1.55
        : weaponId === 'image-rec'
          ? 1.05
          : weaponId === 'armor-breacher'
            ? 1.15
            : weaponId === 'shield-breaker'
              ? 0.82
              : 0.9;
    if (!this.ctx || !this.claimVoice(`missile-${weaponId}`, 0.08, duration)) return;
    if (useSample && this.playAfter3WeaponAudio(weaponId, distance, pan, (weaponId === 'torpedo' ? 0.8 : 0.6) * scale)) return;
    const t = this.ctx.currentTime;
    const out = this.spatial(
      (weaponId === 'torpedo' ? 0.8 : weaponId === 'armor-breacher' ? 0.68 : 0.6) * scale,
      distance,
      pan,
    );
    if (!out) return;
    const src = this.noise(duration);
    const filter = this.ctx.createBiquadFilter();
    filter.type = weaponId === 'torpedo' || weaponId === 'armor-breacher' ? 'lowpass' : 'bandpass';
    filter.Q.value = weaponId === 'image-rec' || weaponId === 'shield-breaker' ? 2.4 : 1.4;
    const start =
      weaponId === 'torpedo' ? 100 : weaponId === 'armor-breacher' ? 180 : weaponId === 'image-rec' ? 1500 : weaponId === 'heat-seeker' ? 650 : weaponId === 'shield-breaker' ? 1800 : 400;
    const end =
      weaponId === 'torpedo' ? 520 : weaponId === 'armor-breacher' ? 820 : weaponId === 'image-rec' ? 3200 : weaponId === 'heat-seeker' ? 2800 : weaponId === 'shield-breaker' ? 4200 : 2600;
    filter.frequency.setValueAtTime(start, t);
    filter.frequency.exponentialRampToValueAtTime(end, t + (weaponId === 'torpedo' ? 0.9 : 0.5));
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(weaponId === 'torpedo' ? 1 : 0.9, t + (weaponId === 'image-rec' ? 0.12 : 0.08));
    env.gain.exponentialRampToValueAtTime(0.001, t + duration - 0.05);
    if (src) src.connect(filter);
    filter.connect(env);
    env.connect(out);

    if (weaponId === 'dumbfire') {
      this.tone(out, 130, 58, 0.25, 0.2, 0.28, t, 'sine');
    } else if (weaponId === 'heat-seeker') {
      this.tone(out, 280, 1700, 0.18, 0.7, 0.78, t + 0.05, 'sawtooth');
    } else if (weaponId === 'image-rec') {
      this.tone(out, 520, 1850, 0.14, 0.32, 0.38, t + 0.08, 'triangle');
      this.tone(out, 1850, 900, 0.1, 0.16, 0.2, t + 0.42, 'square');
    } else if (weaponId === 'torpedo') {
      this.tone(out, 72, 32, 0.5, 1.2, 1.5, t, 'sine');
    } else if (weaponId === 'shield-breaker') {
      this.tone(out, 2400, 800, 0.16, 0.22, 0.28, t + 0.05, 'square');
      this.tone(out, 150, 80, 0.08, 0.18, 0.22, t, 'sine');
    } else if (weaponId === 'armor-breacher') {
      this.tone(out, 110, 42, 0.3, 0.45, 0.55, t, 'sine');
      this.tone(out, 420, 120, 0.12, 0.28, 0.34, t + 0.1, 'square');
    }
  }

  /**
   * UI・通知のビープ (W5-B: `ui` カテゴリ)。
   *
   * 実体は `emitBeep()` に分けてある。警報やロック音も内部でビープを鳴らすが、
   * それらは自分のカテゴリ (`warning` / `lock`) で判定して `emitBeep()` を直接呼ぶ。
   * ここで `ui` を見てしまうと「UI を無音にしたら警報も消える」ことになるため。
   */
  beep(freq: number, duration = 0.08, gain = 0.25, type: OscillatorType = 'square'): void {
    const scale = sfxGain('ui');
    if (scale === null) return;
    this.emitBeep(freq, duration, gain * scale, type);
  }

  /** ビープの実体。カテゴリ判定は呼び出し側で済ませる。 */
  private emitBeep(freq: number, duration: number, gain: number, type: OscillatorType): void {
    if (!this.ctx || !this.sfxBus || !this.reserveVoice(duration + 0.03)) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    // exponentialRamp は 0 を受け付けないため下限を入れる (音量倍率が極小のとき)
    env.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t + 0.01);
    env.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    osc.connect(env);
    env.connect(this.sfxBus);
    osc.start(t);
    osc.stop(t + duration + 0.02);
  }

  lockTone(complete: boolean, weaponId?: string): void {
    const scale = sfxGain('lock');
    if (scale === null) return;
    const lengthScale = sfxDurationScale('lock');
    if (this.throttled(`lock-${weaponId ?? 'unknown'}`, complete ? 0.4 : 0.22)) return;
    const torpedo = weaponId === 'torpedo';
    const frequency = complete
      ? torpedo
        ? 520
        : weaponId === 'armor-breacher'
          ? 420
          : weaponId === 'shield-breaker'
            ? 1720
            : weaponId === 'image-rec'
              ? 1180
              : 1500
      : torpedo
        ? 360
        : weaponId === 'armor-breacher'
          ? 300
          : weaponId === 'shield-breaker'
            ? 1150
            : weaponId === 'heat-seeker'
              ? 820
              : 900;
    this.emitBeep(
      frequency,
      (complete ? (torpedo ? 0.24 : 0.14) : torpedo ? 0.1 : 0.06) * lengthScale,
      (torpedo ? 0.28 : 0.22) * scale,
      torpedo ? 'triangle' : 'square',
    );
  }

  /**
   * 被弾段階が1つ進んだことを知らせる一発の音 (T1-②)。
   *
   * 連続警報 (`warning`) とは別に、「段階が変わった瞬間」だけを鳴らす。
   * 段階ごとに高さと波形を変えるので、画面を見ていなくても深刻さが分かる。
   * 同じ段階の連打は既存方針どおり `throttled` で間引く。
   */
  damageStageCue(stage: DamageStage): void {
    if (stage === 'shield-ok') return;
    // 警報カテゴリ。UI ビープを無音にしても、ここは鳴り続ける。
    const scale = sfxGain('warning');
    if (scale === null) return;
    const len = sfxDurationScale('warning');
    if (this.throttled(`stage-${stage}`, 0.6)) return;
    if (stage === 'shield-down') {
      this.emitBeep(880, 0.1 * len, 0.2 * scale, 'square');
      this.delayedBeep(110, 660, 0.1 * len, 0.2 * scale, 'square');
    } else if (stage === 'armor-hit') {
      this.emitBeep(520, 0.14 * len, 0.22 * scale, 'square');
    } else if (stage === 'hull-hit') {
      this.emitBeep(320, 0.2 * len, 0.26 * scale, 'sawtooth');
    } else {
      // ハル危険域。低く長い三連で「もう持たない」ことを伝える
      [260, 220, 180].forEach((f, i) => this.delayedBeep(i * 140, f, 0.22 * len, 0.3 * scale, 'sawtooth'));
    }
  }

  warning(kind: 'missile' | 'lock' | 'shield' | 'hull', weaponId?: string): void {
    const scale = sfxGain('warning');
    if (scale === null) return;
    const len = sfxDurationScale('warning');
    if (this.throttled(`warn-${kind}-${weaponId ?? 'unknown'}`, weaponId === 'torpedo' ? 0.62 : 0.85)) return;
    if (kind === 'missile') {
      const torpedo = weaponId === 'torpedo';
      const frequency = torpedo ? 320 : weaponId === 'image-rec' ? 980 : 1200;
      const duration = (torpedo ? 0.18 : 0.1) * len;
      const gain = (torpedo ? 0.34 : 0.3) * scale;
      const type: OscillatorType = torpedo ? 'triangle' : 'square';
      this.emitBeep(frequency, duration, gain, type);
      this.delayedBeep(torpedo ? 220 : 130, frequency, duration, gain, type);
    } else if (kind === 'lock') {
      this.emitBeep(
        weaponId === 'torpedo' ? 430 : 760,
        (weaponId === 'torpedo' ? 0.18 : 0.12) * len,
        0.2 * scale,
        'triangle',
      );
    } else if (kind === 'hull') {
      // ハル危険域の連続警報。シールド警報より低く、間隔を詰めて鳴らす。
      this.emitBeep(300, 0.16 * len, 0.28 * scale, 'sawtooth');
      this.delayedBeep(190, 240, 0.16 * len, 0.28 * scale, 'sawtooth');
    } else {
      this.emitBeep(420, 0.18 * len, 0.22 * scale, 'sawtooth');
    }
  }

  /**
   * ジャンプ (オートパイロット) の音。
   * 開始で上がり、終了で下がる。鳴っている間は低い唸りを保つ。
   */
  warpTone(on: boolean): void {
    const scale = sfxGain('ui');
    if (scale === null) return;
    if (!this.ctx || !this.sfxBus || !this.reserveVoice(on ? 0.85 : 0.7)) return;
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
    env.gain.exponentialRampToValueAtTime(Math.max(0.0002, 0.16 * scale), t + 0.08);
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
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, 0.09 * scale), t + 0.12);
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
    // 無音設定でも 0 を返して即座に抜ける。戻り値は HUD の口の動きを駆動するだけで、
    // 字幕は別経路なので「声を切っても字幕は残る」挙動になる。
    const scale = sfxGain('voice');
    if (scale === null) return 0;
    if (!this.ctx || !this.sfxBus || text.trim().length === 0) return 0;
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
    if (!this.reserveVoice(dur + 0.2)) return 0;

    // 無線のスケルチ (開くカチッという音)
    this.squelch(t0, 0.035, scale);

    const out = this.ctx.createGain();
    out.gain.value = 0.5 * scale;
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
      g.gain.setValueAtTime(0.02 * scale, t0);
      g.gain.setValueAtTime(0.02 * scale, t0 + dur);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur + 0.1);
      hiss.connect(hp);
      hp.connect(g);
      g.connect(this.sfxBus);
    }

    // 閉じるスケルチ
    this.squelch(t0 + dur + 0.05, 0.05, scale);
    return dur + 0.1;
  }

  /** 無線を開閉するときの短いノイズ */
  private squelch(at: number, dur: number, scale = 1): void {
    if (!this.ctx || !this.sfxBus) return;
    const src = this.noise(dur + 0.05, at);
    if (!src) return;
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 2200;
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0.0001, at);
    env.gain.exponentialRampToValueAtTime(Math.max(0.0002, 0.06 * scale), at + 0.005);
    env.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    src.connect(hp);
    hp.connect(env);
    env.connect(this.sfxBus);
  }

  // ───────── エンジン音 ─────────

  /** 自機のエンジン音を更新する (0..1 の出力と AB) */
  updateEngine(power: number, afterburner: boolean, alive: boolean, profile = 'fighter'): void {
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
    // 無音設定ではノードを残したままゲインだけ 0 へ寄せる (再開時に作り直さない)
    const scale = sfxGain('engine') ?? 0;
    const target = alive ? (0.05 + power * 0.09 + (afterburner ? 0.12 : 0)) * scale : 0;
    e.gain.gain.setTargetAtTime(target, t, 0.12);
    const capital = profile.startsWith('capital:') || profile.startsWith('transport:');
    let hash = 0;
    for (const char of profile) hash = (hash * 17 + char.charCodeAt(0)) % 11;
    const variation = capital ? 0 : hash - 5;
    e.osc.frequency.setTargetAtTime((capital ? 38 : 50 + variation) + power * (capital ? 26 : 45) + (afterburner ? 40 : 0), t, 0.15);
    e.filter.frequency.setTargetAtTime((capital ? 140 : 220 + variation * 14) + power * (capital ? 320 : 500) + (afterburner ? 900 : 0), t, 0.15);
  }

  /** ミッション終了などでエンジン音を止める */
  stopEngine(): void {
    if (!this.ctx || !this.engine) return;
    this.engine.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.15);
  }

  dispose(): void {
    this.unsub();
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.activeVoices.length = 0;
    this.stopEngine();
    try {
      void this.ctx?.close();
    } catch {
      // close() が既に閉じた AudioContext でも破棄処理は完了扱いにする。
    }
    this.ctx = undefined;
    this.master = undefined;
    this.sfxBus = undefined;
    this.musicBus = undefined;
    this.noiseBuffer = undefined;
    this.weaponAudioBuffers.clear();
    this.weaponAudioLoads.clear();
  }
}

export const audio = new AudioManager();
