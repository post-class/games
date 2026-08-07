/**
 * 音（docs/02_ゲーム実装プラン/06_クライアント設計.md §6 / 09章 M8）
 *
 * 音源ファイルは持たず、WebAudio で合成する。理由:
 * - 初期ロードを 5MB 以内に収めたい（M8完了条件）。mp3 を並べると一番かさばるのが音
 * - このゲームの音は「短いやわらかい合図」と「環境音」だけで足り、
 *   録音素材でなくても目的を果たせる
 *
 * 方針:
 * - 既定はOFF。ブラウザは操作前に音を鳴らせないうえ、
 *   「静かに眺めたい」人のほうが多いゲームなので、鳴らすのは自分で選んでもらう
 * - `AudioContext` はONにした瞬間に作る（OFFのまま遊ぶ人のCPUを使わない）
 * - 環境音（BGM）は和音をゆっくり移すだけのパッド。旋律を付けない
 *   （常時流れるので、旋律があると数分で必ず飽きる）
 */

const ON_KEY = 'pokomofu.audio.on';

export type Sfx = 'harvest' | 'water' | 'pet' | 'place' | 'talk' | 'notice' | 'diary';

/** 効果音の設計値（周波数Hz・長さ秒・波形・音量） */
interface SfxDef {
  freq: number[];
  dur: number;
  type: OscillatorType;
  gain: number;
}

const SFX: Record<Sfx, SfxDef> = {
  // 木の実：低め→高めの2音（「採れた」の合図）
  harvest: { freq: [523.25, 783.99], dur: 0.1, type: 'triangle', gain: 0.16 },
  // 水やり：やわらかい下降
  water: { freq: [880, 587.33], dur: 0.13, type: 'sine', gain: 0.12 },
  // 撫でる：短くまるい1音
  pet: { freq: [659.25], dur: 0.14, type: 'sine', gain: 0.14 },
  // 設置：木を置いた感じの低い2音
  place: { freq: [392, 523.25], dur: 0.12, type: 'triangle', gain: 0.15 },
  // 話しかけ：軽い上昇
  talk: { freq: [587.33, 698.46], dur: 0.08, type: 'sine', gain: 0.1 },
  // 通知：3音の合図
  notice: { freq: [523.25, 659.25, 783.99], dur: 0.1, type: 'triangle', gain: 0.13 },
  // 日記：やさしい3音（1日の終わり）
  diary: { freq: [440, 554.37, 659.25], dur: 0.22, type: 'sine', gain: 0.1 },
};

/** 環境音の和音進行（Cメジャー系の4和音をゆっくり回す） */
const PAD_CHORDS: readonly number[][] = [
  [261.63, 329.63, 392.0], // C
  [293.66, 349.23, 440.0], // Dm
  [349.23, 440.0, 523.25], // F
  [246.94, 293.66, 392.0], // G/B
];
/** 1和音あたりの秒数 */
const PAD_SECONDS = 11;

export class GameAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private padGain: GainNode | null = null;
  private padOscs: OscillatorNode[] = [];
  private padTimer: number | null = null;
  private chordIndex = 0;
  private on: boolean;
  /** 夜は環境音を少し下げる */
  private nightly = 1;

  constructor() {
    this.on = localStorage.getItem(ON_KEY) === '1';
  }

  get enabled(): boolean {
    return this.on;
  }

  /** ON/OFFを切り替えて、その後の状態を返す */
  toggle(): boolean {
    this.on = !this.on;
    localStorage.setItem(ON_KEY, this.on ? '1' : '0');
    if (this.on) {
      this.ensureContext();
      this.startPad();
    } else {
      this.stopPad();
    }
    return this.on;
  }

  /** 効果音を鳴らす。OFFなら何もしない */
  play(name: Sfx): void {
    if (!this.on) return;
    const ctx = this.ensureContext();
    if (!ctx || !this.master) return;

    const def = SFX[name];
    const t0 = ctx.currentTime;
    def.freq.forEach((f, i) => {
      // 和音ではなく短い連続音として並べる（合図は「並び」のほうが聞き分けやすい）
      const start = t0 + i * def.dur * 0.7;
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = def.type;
      osc.frequency.value = f;
      // クリックノイズを避けるため、立ち上がりと減衰を必ず付ける
      g.gain.setValueAtTime(0, start);
      g.gain.linearRampToValueAtTime(def.gain, start + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, start + def.dur);
      osc.connect(g).connect(this.master as GainNode);
      osc.start(start);
      osc.stop(start + def.dur + 0.02);
    });
  }

  /** 夜／雨のときに環境音を落ち着かせる */
  setAmbience(timeOfDay: string, weather: string): void {
    const night = timeOfDay === 'night' ? 0.45 : timeOfDay === 'evening' ? 0.75 : 1;
    const rain = weather === 'rain' ? 0.7 : 1;
    this.nightly = night * rain;
    if (this.padGain && this.ctx) {
      this.padGain.gain.setTargetAtTime(0.045 * this.nightly, this.ctx.currentTime, 1.5);
    }
  }

  private ensureContext(): AudioContext | null {
    if (this.ctx) {
      // 自動再生制限で止められていることがあるので、操作のたびに起こす
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return this.ctx;
    }
    const Ctor = window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    this.ctx = new Ctor();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.9;
    this.master.connect(this.ctx.destination);
    return this.ctx;
  }

  private startPad(): void {
    const ctx = this.ensureContext();
    if (!ctx || !this.master || this.padTimer !== null) return;

    this.padGain = ctx.createGain();
    this.padGain.gain.value = 0;
    // 高い成分を削ってやわらかくする（正弦波でも重ねると耳に刺さる）
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 900;
    this.padGain.connect(lp).connect(this.master);
    this.padGain.gain.setTargetAtTime(0.045 * this.nightly, ctx.currentTime, 3);

    this.playChord();
    this.padTimer = window.setInterval(() => this.playChord(), PAD_SECONDS * 1000);
  }

  private playChord(): void {
    const ctx = this.ctx;
    if (!ctx || !this.padGain) return;

    // 前の和音は重ねたまま消していく（切れ目が聞こえないように）
    const fadeOut = this.padOscs;
    this.padOscs = [];

    const chord = PAD_CHORDS[this.chordIndex % PAD_CHORDS.length] ?? PAD_CHORDS[0]!;
    this.chordIndex++;
    const t0 = ctx.currentTime;

    for (const f of chord) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = f;
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(1, t0 + 2.5);
      osc.connect(g).connect(this.padGain);
      osc.start(t0);
      this.padOscs.push(osc);
    }

    for (const osc of fadeOut) {
      // 2.5秒かけて止める（新しい和音の立ち上がりと入れ違いになる）
      try {
        osc.stop(t0 + 2.6);
      } catch {
        // すでに止まっている場合は無視
      }
    }
  }

  private stopPad(): void {
    if (this.padTimer !== null) {
      clearInterval(this.padTimer);
      this.padTimer = null;
    }
    const ctx = this.ctx;
    if (this.padGain && ctx) {
      this.padGain.gain.setTargetAtTime(0, ctx.currentTime, 0.4);
    }
    const stopAt = ctx ? ctx.currentTime + 1.5 : 0;
    for (const osc of this.padOscs) {
      try {
        osc.stop(stopAt);
      } catch {
        // すでに止まっている場合は無視
      }
    }
    this.padOscs = [];
  }
}

/**
 * 音のON/OFFボタンをHUDに足す。
 * 既にONで保存されている人には、最初の操作で環境音を鳴らし始める。
 */
export function attachAudioToggle(audio: GameAudio): HTMLElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'hud-chip audio-chip';
  btn.dataset['testid'] = 'audio-toggle';

  const render = (): void => {
    btn.textContent = audio.enabled ? '🔊 音あり' : '🔇 音なし';
    btn.setAttribute('aria-pressed', audio.enabled ? 'true' : 'false');
  };
  render();

  btn.addEventListener('click', () => {
    audio.toggle();
    render();
    // 切り替えた合図（ONにしたときだけ鳴る）
    audio.play('pet');
  });

  const hud = document.querySelector('.hud');
  if (hud) hud.appendChild(btn);
  else document.body.appendChild(btn);

  // 保存済みでONの人は、最初のクリック／キー入力で鳴り始めるようにする
  if (audio.enabled) {
    const kick = (): void => {
      audio.toggle(); // いったんOFF→
      audio.toggle(); // ONにし直して環境音を起こす
      render();
      window.removeEventListener('pointerdown', kick);
      window.removeEventListener('keydown', kick);
    };
    window.addEventListener('pointerdown', kick, { once: false });
    window.addEventListener('keydown', kick, { once: false });
  }

  return btn;
}
