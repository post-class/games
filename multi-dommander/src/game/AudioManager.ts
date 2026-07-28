import type { EventBus } from "../util/EventBus";
import type { Vector3 } from "three";
import { MusicDirector } from "./audio/MusicDirector";

/**
 * Web Audio API v2: ミキサー・空間音響・動的BGM・エンジン音・警報を統合した音響エンジン。
 * EventBus のゲームイベントを購読し、SE/BGM/警報を再生する。
 * ブラウザの自動再生制限のため、最初のユーザー操作で enable() を呼んで有効化する。
 */
export class AudioManager {
  private ctx: AudioContext | null = null;

  // ミキサー構成: master -> (music | sfx | voice)
  private master: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private voiceBus: GainNode | null = null; // 将来のVO用(未実装)

  private noiseBuffer: AudioBuffer | null = null;
  /** 直近の砲声時刻 (連射の音の重なりを間引く)。 */
  private lastGunAt = 0;

  // 動的BGM
  private music: MusicDirector | null = null;

  // エンジン音(連続ループ)
  private engineHumSource: AudioBufferSourceNode | null = null;
  private engineHumGain: GainNode | null = null;
  private engineHumFilter: BiquadFilterNode | null = null;
  private engineAbSource: AudioBufferSourceNode | null = null;
  private engineAbGain: GainNode | null = null;

  // 警報系(断続音)
  private missileWarningActive = false;
  private missileWarningNextAt = 0;
  private lowShieldAlarmActive = false;
  private lowShieldAlarmNextAt = 0;

  constructor(events: EventBus) {
    // 既存SE購読(後方互換)
    events.on("weaponFired", (e) => {
      this.recordMusicEvent();
      if (e.kind === "gun") {
        this.gun(e.position);
      } else {
        this.missile(e.position);
      }
    });
    events.on("hit", (e) => {
      this.recordMusicEvent();
      this.hit(e.position);
    });
    events.on("destroyed", (e) => {
      this.recordMusicEvent();
      this.explosion(e.position);
    });
  }

  get enabled(): boolean {
    return this.ctx !== null;
  }

  /** ユーザー操作後に呼ぶと AudioContext を有効化し、ミキサー/BGM/エンジン音を初期化する。 */
  enable(): void {
    if (this.ctx) return;
    try {
      this.ctx = new AudioContext();

      // ミキサー構成
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.35; // 既定master音量(既存互換)
      this.master.connect(this.ctx.destination);

      this.musicBus = this.ctx.createGain();
      this.musicBus.gain.value = 0.6; // 既定music音量(控えめ)
      this.musicBus.connect(this.master);

      this.sfxBus = this.ctx.createGain();
      this.sfxBus.gain.value = 0.8;
      this.sfxBus.connect(this.master);

      this.voiceBus = this.ctx.createGain();
      this.voiceBus.gain.value = 0.9;
      this.voiceBus.connect(this.master);

      // ノイズバッファ(SE用)
      this.noiseBuffer = this.makeNoiseBuffer(0.6);

      // 動的BGM初期化
      this.music = new MusicDirector(this.ctx, this.musicBus);

      // エンジン音初期化(ループ開始)
      this.initEngine();

      // AudioContext が suspended 状態なら resume(iOS Safari対策)
      if (this.ctx.state === "suspended") {
        this.ctx.resume().catch(() => {/* ignore */});
      }
    } catch {
      this.ctx = null;
    }
  }

  /** カテゴリ別音量設定(0..1)。 */
  setCategoryVolume(category: "music" | "sfx" | "voice", value: number): void {
    const bus = category === "music" ? this.musicBus : category === "sfx" ? this.sfxBus : this.voiceBus;
    if (bus) bus.gain.value = Math.max(0, Math.min(1, value));
  }

  /** マスター音量設定(0..1)。 */
  setMasterVolume(value: number): void {
    if (this.master) this.master.gain.value = Math.max(0, Math.min(1, value));
  }

  /**
   * リスナー(カメラ)の位置・向きを更新する。
   * 空間音響(PannerNode)の定位に使用される。
   * @param pos カメラのワールド位置
   * @param forward カメラの前方向(正規化済み)
   * @param up カメラの上方向(正規化済み)
   */
  setListener(pos: Vector3, forward: Vector3, up: Vector3): void {
    if (!this.ctx) return;
    const listener = this.ctx.listener;
    if (listener.positionX) {
      // 新API
      listener.positionX.value = pos.x;
      listener.positionY.value = pos.y;
      listener.positionZ.value = pos.z;
      listener.forwardX.value = forward.x;
      listener.forwardY.value = forward.y;
      listener.forwardZ.value = forward.z;
      listener.upX.value = up.x;
      listener.upY.value = up.y;
      listener.upZ.value = up.z;
    } else {
      // 旧API(非推奨だが互換性のため)
      (listener as any).setPosition(pos.x, pos.y, pos.z);
      (listener as any).setOrientation(forward.x, forward.y, forward.z, up.x, up.y, up.z);
    }
  }

  /**
   * エンジン音のパワー更新(毎フレーム呼ばれる)。
   * @param throttle スロットル 0..1
   * @param afterburner アフターバーナーON/OFF
   */
  setEnginePower(throttle: number, afterburner: boolean): void {
    if (!this.ctx || !this.engineHumGain || !this.engineHumFilter || !this.engineAbGain) return;
    const t = this.ctx.currentTime;
    // humレイヤー: 音量とフィルタ周波数をスロットルに追従(時定数0.08秒でスムージング)
    this.engineHumGain.gain.setTargetAtTime(0.08 + throttle * 0.22, t, 0.08);
    this.engineHumFilter.frequency.setTargetAtTime(300 + throttle * 900, t, 0.08);
    // ABレイヤー: ON時は素早く立ち上がり、OFF時はゆっくりフェードアウト
    this.engineAbGain.gain.setTargetAtTime(afterburner ? 0.35 : 0.0, t, afterburner ? 0.05 : 0.25);
  }

  /**
   * ミサイル警報(被ロック警告)のON/OFF。
   * 断続ビープをループ再生/停止する。
   */
  setMissileWarning(on: boolean): void {
    this.missileWarningActive = on;
    if (!on) this.missileWarningNextAt = 0; // 停止時にリセット
  }

  /**
   * 低シールド警報のON/OFF。
   * 低い警告音をループ再生/停止する。
   */
  setLowShieldAlarm(on: boolean): void {
    this.lowShieldAlarmActive = on;
    if (!on) this.lowShieldAlarmNextAt = 0;
  }

  /**
   * 毎フレーム呼ばれる更新処理。BGM・警報の時刻ベーススケジューリングを行う。
   * @param dt 前回からの経過秒
   */
  update(dt: number): void {
    if (!this.ctx) return;

    // BGM更新
    if (this.music) {
      this.music.update(dt);
    }

    // 警報の断続音スケジューリング
    const t = this.ctx.currentTime;
    if (this.missileWarningActive && t >= this.missileWarningNextAt) {
      this.playMissileWarningBeep();
      this.missileWarningNextAt = t + 0.4; // 0.4秒間隔のビープ
    }
    if (this.lowShieldAlarmActive && t >= this.lowShieldAlarmNextAt) {
      this.playLowShieldAlarmTone();
      this.lowShieldAlarmNextAt = t + 0.8; // 0.8秒間隔の警告音
    }
  }

  /** BGMフェーズ変更。 */
  setMusicPhase(phase: "menu" | "briefing" | "playing" | "debrief"): void {
    if (this.music) this.music.setPhase(phase);
  }

  /** 戦闘イベント発生をBGMに記録し、脅威度推定に反映する。 */
  private recordMusicEvent(): void {
    if (this.music) this.music.recordEvent();
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

  /** エンジン音の初期化(常時ループ再生開始)。 */
  private initEngine(): void {
    if (!this.ctx || !this.sfxBus) return;

    // Humレイヤー(低速アイドル〜巡航ノイズ)
    const humBuffer = this.makeEngineNoiseBuffer(2.0, "hum");
    this.engineHumSource = this.ctx.createBufferSource();
    this.engineHumSource.buffer = humBuffer;
    this.engineHumSource.loop = true;
    this.engineHumFilter = this.ctx.createBiquadFilter();
    this.engineHumFilter.type = "lowpass";
    this.engineHumFilter.frequency.value = 300;
    this.engineHumGain = this.ctx.createGain();
    this.engineHumGain.gain.value = 0; // 初期は無音(setEnginePowerで制御)
    this.engineHumSource.connect(this.engineHumFilter).connect(this.engineHumGain).connect(this.sfxBus);
    this.engineHumSource.start();

    // ABレイヤー(広帯域ノイズ)
    const abBuffer = this.makeEngineNoiseBuffer(1.5, "ab");
    this.engineAbSource = this.ctx.createBufferSource();
    this.engineAbSource.buffer = abBuffer;
    this.engineAbSource.loop = true;
    this.engineAbGain = this.ctx.createGain();
    this.engineAbGain.gain.value = 0;
    this.engineAbSource.connect(this.engineAbGain).connect(this.sfxBus);
    this.engineAbSource.start();
  }

  /** エンジン用ノイズバッファ生成(ループに適したゼロクロス処理済み)。 */
  private makeEngineNoiseBuffer(seconds: number, kind: "hum" | "ab"): AudioBuffer {
    const ctx = this.ctx!;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      data[i] = (Math.random() * 2 - 1) * (kind === "hum" ? 0.6 : 0.8);
    }
    // 先頭/末尾を数msフェードしてループクリックノイズを回避
    const fadeLen = Math.floor(ctx.sampleRate * 0.005); // 5ms
    for (let i = 0; i < fadeLen; i++) {
      const t = i / fadeLen;
      data[i] *= t;
      data[len - 1 - i] *= t;
    }
    return buf;
  }

  /** ミサイル警報ビープ(短いパルス)。 */
  private playMissileWarningBeep(): void {
    if (!this.ctx || !this.sfxBus) return;
    const t = this.now();
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = "square";
    osc.frequency.value = 880;
    g.gain.setValueAtTime(0.15, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
    osc.connect(g).connect(this.sfxBus);
    osc.start(t);
    osc.stop(t + 0.1);
  }

  /** 低シールド警報音(低い不協和トーン)。 */
  private playLowShieldAlarmTone(): void {
    if (!this.ctx || !this.sfxBus) return;
    const t = this.now();
    // 不協和なトライアド: C2(65Hz) + F#2(92Hz)
    const osc1 = this.ctx.createOscillator();
    osc1.type = "triangle";
    osc1.frequency.value = 65;
    const g1 = this.ctx.createGain();
    g1.gain.setValueAtTime(0.08, t);
    g1.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    osc1.connect(g1).connect(this.sfxBus);
    osc1.start(t);
    osc1.stop(t + 0.32);

    const osc2 = this.ctx.createOscillator();
    osc2.type = "triangle";
    osc2.frequency.value = 92;
    const g2 = this.ctx.createGain();
    g2.gain.setValueAtTime(0.06, t);
    g2.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    osc2.connect(g2).connect(this.sfxBus);
    osc2.start(t);
    osc2.stop(t + 0.32);
  }

  /** 減衰エンベロープつきのトーン(接続先を指定可能に)。 */
  private tone(
    type: OscillatorType,
    freqStart: number,
    freqEnd: number,
    duration: number,
    gain: number,
    destination: AudioNode,
  ): void {
    if (!this.ctx) return;
    const t = this.now();
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freqStart, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, freqEnd), t + duration);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    osc.connect(g).connect(destination);
    osc.start(t);
    osc.stop(t + duration + 0.02);
  }

  /** フィルタ付きノイズバースト(接続先を指定可能に)。 */
  private noise(
    duration: number,
    filterFreq: number,
    gain: number,
    destination: AudioNode,
    sweepTo?: number,
  ): void {
    if (!this.ctx || !this.noiseBuffer) return;
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
    src.connect(filter).connect(g).connect(destination);
    src.start(t);
    src.stop(t + duration + 0.02);
  }

  /** 空間音響版ヘルパー: PannerNodeを経由してSEを定位再生する。 */
  private playPositional(position: Vector3, build: (dest: AudioNode) => void): void {
    if (!this.ctx || !this.sfxBus) return;
    const panner = this.ctx.createPanner();
    panner.panningModel = "HRTF";
    panner.distanceModel = "inverse";
    panner.refDistance = 50;
    panner.maxDistance = 3000;
    panner.rolloffFactor = 1;
    panner.positionX.value = position.x;
    panner.positionY.value = position.y;
    panner.positionZ.value = position.z;
    panner.connect(this.sfxBus);
    build(panner);
  }

  private gun(position: Vector3): void {
    if (!this.ctx) return;
    // 連射音の重なりを間引く。
    const t = this.now();
    if (t - this.lastGunAt < 0.04) return;
    this.lastGunAt = t;
    // 空間定位で再生
    this.playPositional(position, (dest) => {
      this.tone("square", 880, 180, 0.12, 0.18, dest);
    });
  }

  private missile(position: Vector3): void {
    this.playPositional(position, (dest) => {
      this.tone("sawtooth", 300, 60, 0.5, 0.2, dest);
      this.noise(0.5, 1200, 0.12, dest, 200);
    });
  }

  private hit(position: Vector3): void {
    this.playPositional(position, (dest) => {
      this.tone("triangle", 500, 200, 0.08, 0.12, dest);
    });
  }

  private explosion(position: Vector3): void {
    this.playPositional(position, (dest) => {
      this.noise(0.7, 900, 0.5, dest, 60);
      this.tone("sine", 120, 40, 0.6, 0.3, dest);
    });
  }
}
