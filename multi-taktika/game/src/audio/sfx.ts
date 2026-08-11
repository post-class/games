/**
 * audio/sfx.ts — 効果音の枠（T-M17-07）
 *
 * ■ 音はどこから来るのか（順番が大事）
 *   1. `public/assets/sfx/<name>.webm` があればそれを鳴らす
 *   2. **無ければ波形を計算して作る**（`audio/synth.ts`）
 *   3. どちらも無い出力口（テストの偽物など）では**静かに無視する**
 * 音が無いことでゲームが止まってはいけないので、3 が既定の振る舞い。
 * 音源ファイルを後から置けば 1 が勝つので、呼び出し側は何も変えなくてよい。
 *
 * ■ なぜ「枠」を先に決めるのか
 * 音を後から足すとき、いちばん面倒なのは「どこで鳴らすか」を探すことで、
 * 音源そのものではない。鳴らす場所を先に決めて名前を付けておけば、
 * 音源が用意できた時点で置くだけになる。
 *
 * ■ 決定論との関係
 * ここは ui 層で、**試合の状態を一切読み書きしない**。
 * 音は端末ごとに鳴る／鳴らないが違ってよい（hash に影響しない）。
 * sim からこのモジュールを import してはいけない（ESLint が層違反として弾く）。
 *
 * ■ 自動再生の制約
 * ブラウザは「利用者が一度も触っていないページ」で音を鳴らせない。
 * `AudioContext` は**最初のキー入力／クリックまで作らない**（作ると suspended
 * 状態のまま溜まる）。`unlock()` を入力の入口から呼ぶ。
 */

import { renderSfxSamples } from './synth';

/**
 * 鳴らす場所の名前。**ここに無い音は鳴らせない**（打ち間違いを型で防ぐ）。
 * 増やすときは同時に「どこで鳴るか」をコメントに書く。
 */
export const SFX_NAMES = [
  /** 戦域が新しく立った（`07§3`）。見ていない戦域で起きるので音が要る */
  'front_open',
  /** 戦域が畳まれた（全滅または後退の完了） */
  'front_close',
  /** 令が届いた（出した瞬間ではなく**届いた瞬間**。`05§14` のずれが耳でも分かる） */
  'order_arrive',
  /** 戦域が崩れかけ（`07§3` の警告。設定の「警告音」で切れる） */
  'warning',
  /** 時代が進んだ */
  'age_up',
  /** 生産が完了した */
  'unit_ready',
  /** 建物が完成した */
  'build_done',
  /** 建物が壊された */
  'building_lost',
  /** 勝敗が決まった */
  'match_end',
  /** ボタン・カードを押した（UI の手触り） */
  'click',
] as const;

export type SfxName = (typeof SFX_NAMES)[number];

/** 音源の場所。`build.py` の出力先と揃えている。 */
export function sfxUrl(name: SfxName): string {
  return `assets/sfx/${name}.webm`;
}

/** 最小の音声出力口（テストで差し替えられるように interface にする）。 */
export interface AudioSink {
  /** 音源を読み込む。無ければ null を返す（例外にしない）。 */
  load(url: string): Promise<AudioBuffer | null>;
  /** 鳴らす。 */
  play(buffer: AudioBuffer, volume: number): void;
  /**
   * 音源ファイルが無いときに**波形を計算して**作る（`audio/synth.ts`）。任意。
   *
   * **順番が大事**: `preload` はまず `load`（ファイル）を試し、無いときだけここに来る。
   * つまり音源ファイルを置けばそちらが勝つ ―― 合成は「ファイルが無いときの本体」で、
   * 後からファイルを足しても呼び出し側は何も変えなくてよい。
   *
   * 実装しない出力口（テストの偽物など）では今までどおり**静かに無音**になる。
   */
  synthesize?(name: SfxName): AudioBuffer | null;
}

/**
 * 効果音。**音源が無くても呼び出し側は何も気にしなくてよい**のが設計の要点。
 *
 * 音量 0 のときは読み込みもしない（無駄な fetch をしない）。
 */
export class Sfx {
  /** 0..1。`Settings` の警告音のオン／オフと合わせて使う。 */
  private volume = 1;
  private enabled = true;
  private sink: AudioSink | null = null;
  private readonly buffers = new Map<SfxName, AudioBuffer | null>();
  /** 読み込み中の重複を防ぐ。 */
  private readonly loading = new Set<SfxName>();
  /** 同じ音が同じ tick に何十回も鳴るのを防ぐ間隔（ms）。 */
  private readonly lastPlayedMs = new Map<SfxName, number>();

  constructor(sink?: AudioSink) {
    if (sink !== undefined) this.sink = sink;
  }

  /** 出力口を差し込む（最初の入力のときに `WebAudioSink` を渡す）。 */
  attach(sink: AudioSink): void {
    this.sink = sink;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
  }

  setVolume(v: number): void {
    this.volume = v < 0 ? 0 : v > 1 ? 1 : v;
  }

  /**
   * 鳴らす。**まだ読み込んでいなければ読み込みを始めて、今回は鳴らさない**。
   * 「最初の 1 回だけ鳴らない」ほうが、鳴らすために待たせるより良い
   * （音は遅れて鳴ると別の出来事に聞こえる）。
   *
   * `nowMs` は連打の間引きに使う。時計をここで読まないのは、
   * テストで間引きを検証できるようにするため。
   */
  play(name: SfxName, nowMs: number, minGapMs = 60): void {
    if (!this.enabled || this.volume === 0 || this.sink === null) return;
    const last = this.lastPlayedMs.get(name);
    if (last !== undefined && nowMs - last < minGapMs) return;
    const buf = this.buffers.get(name);
    if (buf === undefined) {
      void this.preload(name);
      return;
    }
    if (buf === null) return; // 音源が無い枠。静かに無視する
    this.lastPlayedMs.set(name, nowMs);
    this.sink.play(buf, this.volume);
  }

  /** 先に読み込む（試合開始時にまとめて呼ぶ）。失敗しても投げない。 */
  async preload(name: SfxName): Promise<void> {
    if (this.sink === null || this.buffers.has(name) || this.loading.has(name)) return;
    this.loading.add(name);
    try {
      let buf = await this.sink.load(sfxUrl(name));
      // ファイルが無ければ合成する（`audio/synth.ts`）。
      // ファイルが勝つ順番にしてあるので、後から音源を置くだけで差し替わる。
      if (buf === null && this.sink.synthesize !== undefined) {
        buf = this.sink.synthesize(name);
      }
      this.buffers.set(name, buf);
    } catch {
      this.buffers.set(name, null);
    } finally {
      this.loading.delete(name);
    }
  }

  /** 全部の枠を先読みする。 */
  async preloadAll(): Promise<void> {
    for (const n of SFX_NAMES) await this.preload(n);
  }

  /** 用意されている音源の枠（デバッグ表示・テスト用）。 */
  loadedNames(): readonly SfxName[] {
    // `undefined`（未読み込み）と `null`（音源が無い）の両方を除く
    return SFX_NAMES.filter((n) => {
      const b = this.buffers.get(n);
      return b !== undefined && b !== null;
    });
  }
}

/** ブラウザの `AudioContext` を使う出力口。DOM が無い環境では作らない。 */
export class WebAudioSink implements AudioSink {
  private ctx: AudioContext | null = null;

  private ensure(): AudioContext | null {
    if (this.ctx !== null) return this.ctx;
    const Ctor =
      typeof globalThis.AudioContext === 'function'
        ? globalThis.AudioContext
        : (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (Ctor === undefined) return null;
    this.ctx = new Ctor();
    return this.ctx;
  }

  /** 最初の入力のときに呼ぶ（利用者が触る前に音を鳴らせないブラウザの制約）。 */
  unlock(): void {
    const ctx = this.ensure();
    if (ctx !== null && ctx.state === 'suspended') void ctx.resume();
  }

  async load(url: string): Promise<AudioBuffer | null> {
    const ctx = this.ensure();
    if (ctx === null) return null;
    try {
      const res = await fetch(url);
      if (!res.ok) return null; // 音源がまだ無い枠
      return await ctx.decodeAudioData(await res.arrayBuffer());
    } catch {
      return null;
    }
  }

  /**
   * 波形を計算して `AudioBuffer` に詰める（音源ファイルが無い枠）。
   *
   * 合成そのものは `audio/synth.ts` の純関数。ここは**器に移すだけ**にしてある
   * （Web Audio が無い環境＝テストでも音の設計を検証できるようにするため）。
   */
  synthesize(name: SfxName): AudioBuffer | null {
    const ctx = this.ensure();
    if (ctx === null) return null;
    try {
      const samples = renderSfxSamples(name, ctx.sampleRate);
      const buf = ctx.createBuffer(1, samples.length, ctx.sampleRate);
      // `copyToChannel` の型は `Float32Array<ArrayBuffer>` を要求するが、
      // `renderSfxSamples` の戻り値は `ArrayBufferLike`（SharedArrayBuffer も含む）なので
      // そのままでは通らない。**器へ 1 要素ずつ写す**方が型の抜け道を作らずに済む
      // （音は 1 回作ってキャッシュするので、この写しは 1 枠につき 1 度しか走らない）。
      const dst = buf.getChannelData(0);
      for (let i = 0; i < samples.length; i++) dst[i] = samples[i]!;
      return buf;
    } catch {
      return null;
    }
  }

  play(buffer: AudioBuffer, volume: number): void {
    const ctx = this.ensure();
    if (ctx === null) return;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const gain = ctx.createGain();
    gain.gain.value = volume;
    src.connect(gain);
    gain.connect(ctx.destination);
    src.start();
  }
}

/** 画面のどこからでも使える 1 個（音は state を持たないので共有してよい）。 */
export const sfx = new Sfx();
