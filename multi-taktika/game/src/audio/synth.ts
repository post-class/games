/**
 * audio/synth.ts — 効果音を**その場で合成する**（音源ファイルの代わり）
 *
 * ■ なぜ合成するのか
 * `sfx.ts` は「音源ファイルを置けば鳴る」枠を用意してあるが、
 * **10 枠すべてが空**だった。無音のゲームは、絵が入っていないより安っぽく感じる
 * （戦域が立ったことも、令が届いたことも、耳では何も分からない）。
 * 効果音の素材を用意する手立てが無いので、**波形を計算して作る**。
 *
 * ファイルを置いたらそちらが優先される（`Sfx.preload` はまず `load` を試す）。
 * つまりこれは「本物が来るまでの代役」ではなく「本物が無いときの本体」で、
 * どちらでも同じように鳴る。
 *
 * ■ 音の方向（`02_世界観.html` の軍制から）
 * この世界の命令は **旗鼓（きこ）** ―― 色旗と大太鼓 ―― と騎馬の伝令で届く。
 * だから電子音ではなく、**太鼓・木・鐘**の音に寄せる。
 *  - 戦域が立つ / 畳む … 太鼓（低い胴の音）
 *  - 令が届く          … 鼓の 2 連打（軽く、短く。いちばん頻度が高いので邪魔にならない量）
 *  - 時代が進む        … 鐘（5 度上がる。祝いの音）
 *  - 建物が壊れる      … 崩落（雑音 + 低い唸り）
 *
 * ■ 決定論について
 * ここは ui 層で試合の状態を読み書きしないので、hash には影響しない。
 * ただし**乱数は自前の xorshift で固定種**にしてある。`Math.random` を使うと
 * 鳴るたびに雑音が変わり、「この音だけ耳障り」という不具合を再現できなくなる。
 *
 * ■ なぜ Web Audio の API を使わずに波形を書くのか
 * `OscillatorNode` を繋いで作ると、**テストで音を検証できない**（jsdom に Web Audio が無い）。
 * ここは「サンプル値の配列を返す純関数」にしてあるので、
 * 長さ・音量・終わりの収束（プツッと切れないか）をテストで確かめられる。
 * `AudioBuffer` への詰め替えは `sfx.ts` の出力口が受け持つ。
 */

import type { SfxName } from './sfx';

/** 音の設計 1 件。 */
interface Voice {
  /** 長さ（秒）。**短く**する ―― 効果音が重なると何が起きたのか分からなくなる。 */
  readonly seconds: number;
  /** サンプル 1 つを返す。`t` は 0..seconds の秒数。戻り値は -1..1。 */
  sample(t: number, rng: Rng): number;
}

/**
 * 固定種の乱数（xorshift32）。雑音を作るのに使う。
 * `Math.random` を使わない理由はファイル冒頭のとおり。
 */
class Rng {
  private s: number;

  constructor(seed: number) {
    // 0 は xorshift の不動点なので避ける
    this.s = seed === 0 ? 0x9e3779b9 : seed >>> 0;
  }

  /** -1..1 の一様乱数。 */
  next(): number {
    let x = this.s;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.s = x >>> 0;
    return (this.s / 0xffffffff) * 2 - 1;
  }
}

// ---------------------------------------------------------------- 部品

/** 指数の減衰。`half` 秒ごとに半分になる。 */
function decay(t: number, half: number): number {
  return Math.pow(0.5, t / half);
}

/**
 * 立ち上がりと終わりを丸める窓。
 *
 * **これが無いと「プツッ」と鳴る。** 波形が 0 でないところで切れると
 * スピーカーが段差を再生してしまうため、頭 3ms と終わり 15ms を絞る。
 */
function window_(t: number, seconds: number): number {
  const attack = 0.003;
  const release = 0.015;
  if (t < attack) return t / attack;
  const left = seconds - t;
  if (left < release) return left < 0 ? 0 : left / release;
  return 1;
}

/** 正弦波。 */
function sine(t: number, hz: number): number {
  return Math.sin(2 * Math.PI * hz * t);
}

/**
 * 太鼓の胴。低い正弦波の**音程を下げながら**鳴らすと打撃音になる
 * （張った膜は叩いた瞬間がいちばん高く、すぐ下がる）。
 */
function drum(t: number, hz0: number, hz1: number, half: number): number {
  const k = decay(t, half);
  const hz = hz1 + (hz0 - hz1) * k;
  return sine(t, hz) * k;
}

/** 木を叩く音。高い成分が一瞬だけ出て、すぐ消える。 */
function knock(t: number, hz: number, rng: Rng): number {
  const k = decay(t, 0.035);
  return (sine(t, hz) * 0.7 + rng.next() * 0.3) * k;
}

/** 鐘。倍音を少し混ぜると金属らしくなる。 */
function bell(t: number, hz: number, half: number): number {
  const k = decay(t, half);
  return (sine(t, hz) + sine(t, hz * 2.76) * 0.35 + sine(t, hz * 5.4) * 0.12) * k * 0.7;
}

/** 低い唸りつきの雑音（崩落）。 */
function rumble(t: number, rng: Rng): number {
  const k = decay(t, 0.16);
  return (rng.next() * 0.6 + sine(t, 70) * 0.4) * k;
}

// ---------------------------------------------------------------- 音の設計
//
// **音量は控えめに揃える**（0.5 前後）。効果音が重なる場面（戦域が 3 本立って
// 令が届いて生産が終わる）で音が割れるのを避けるため。

const VOICES: Readonly<Record<SfxName, Voice>> = {
  // 戦域が立った ―― 大太鼓。ここは見ていない場所で起きるので、いちばん通る音にする。
  front_open: {
    seconds: 0.6,
    // 2 つの胴を足すので、**足した結果**が 1 を超えないようにする。
    // 最初 0.75 + 0.5 = 1.25 にしていたら実測ピークが 1.00 に張り付き、
    // クランプが働いて頭が潰れていた（＝割れた音）。合計 0.86 に落とした。
    sample: (t) => (drum(t, 190, 72, 0.09) * 0.52 + drum(t, 96, 54, 0.22) * 0.34) * window_(t, 0.6),
  },
  // 戦域が畳まれた ―― 同じ太鼓を低く、短く。立つ音と対になるように音程だけ変える。
  front_close: {
    seconds: 0.45,
    sample: (t) => drum(t, 120, 48, 0.13) * 0.6 * window_(t, 0.45),
  },
  // 令が届いた ―― 鼓の 2 連打。**いちばん頻度が高い**ので短く軽く。
  order_arrive: {
    seconds: 0.22,
    sample: (t, rng) => {
      const a = knock(t, 720, rng) * 0.42;
      const b = t >= 0.075 ? knock(t - 0.075, 940, rng) * 0.34 : 0;
      return (a + b) * window_(t, 0.22);
    },
  },
  // 崩れかけ ―― 短 2 度でぶつける（きれいに響かせない）。設定で切れる音（`06`）。
  warning: {
    seconds: 0.5,
    sample: (t) => {
      const k = decay(t, 0.2);
      const wob = t < 0.25 ? 0 : 1; // 途中で 1 段上げて「催促」に聞こえるようにする
      return (sine(t, 494 + wob * 36) * 0.5 + sine(t, 523 + wob * 36) * 0.35) * k * window_(t, 0.5);
    },
  },
  // 時代が進んだ ―― 鐘が 5 度上がる（下から上へ）。祝いなので少し長い。
  age_up: {
    seconds: 1.1,
    sample: (t) => {
      const low = bell(t, 392, 0.5) * 0.5;
      const high = t >= 0.16 ? bell(t - 0.16, 588, 0.55) * 0.5 : 0;
      return (low + high) * window_(t, 1.1);
    },
  },
  // 生産が完了 ―― 軽い撥弦。頻度が高いので極力おとなしく。
  unit_ready: {
    seconds: 0.2,
    sample: (t) => sine(t, 660) * decay(t, 0.05) * 0.34 * window_(t, 0.2),
  },
  // 建物が完成 ―― 木槌 2 打 + 低い響き（建てた重さを出す）。
  build_done: {
    seconds: 0.4,
    sample: (t, rng) => {
      const a = knock(t, 300, rng) * 0.5;
      const b = t >= 0.1 ? knock(t - 0.1, 240, rng) * 0.45 : 0;
      return (a + b + drum(t, 110, 80, 0.12) * 0.25) * window_(t, 0.4);
    },
  },
  // 建物が壊された ―― 崩落。
  building_lost: {
    seconds: 0.7,
    sample: (t, rng) => rumble(t, rng) * 0.55 * window_(t, 0.7),
  },
  // 勝敗が決まった ―― 銅鑼。いちばん長い音だが、鳴るのは 1 試合 1 回だけ。
  match_end: {
    seconds: 1.6,
    sample: (t, rng) => {
      const g = bell(t, 165, 0.85) * 0.55;
      const air = rng.next() * 0.06 * decay(t, 0.08);
      return (g + air) * window_(t, 1.6);
    },
  },
  // 押した手触り ―― ごく短い木の音。長いと連打で濁る。
  click: {
    seconds: 0.06,
    sample: (t, rng) => knock(t, 1100, rng) * 0.22 * window_(t, 0.06),
  },
};

// ---------------------------------------------------------------- 出力

/** 合成できる名前か（`sfx.ts` の枠と 1 対 1）。 */
export function canSynthesize(name: string): name is SfxName {
  return Object.prototype.hasOwnProperty.call(VOICES, name);
}

/** その音の長さ（秒）。テストと先読みの見積りに使う。 */
export function sfxSeconds(name: SfxName): number {
  return VOICES[name].seconds;
}

/**
 * 音を作る。**純関数**（同じ名前・同じサンプリング周波数なら必ず同じ配列）。
 *
 * 戻り値はモノラルのサンプル列（-1..1）。`AudioBuffer` に詰めるのは呼び出し側。
 */
export function renderSfxSamples(name: SfxName, sampleRate: number): Float32Array {
  if (!(sampleRate > 0)) throw new Error(`synth: サンプリング周波数が不正 ${sampleRate}`);
  const v = VOICES[name];
  const n = Math.max(1, Math.round(v.seconds * sampleRate));
  const out = new Float32Array(n);
  // 種は名前ごとに変える（全部同じ雑音だと「同じ音」に聞こえる）。
  // 名前から作るので、実行するたびに変わることはない。
  const rng = new Rng(hashName(name));
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const s = v.sample(t, rng);
    // 設計の間違いで 1 を超えても、割れた音を出さずに頭を潰す
    out[i] = s > 1 ? 1 : s < -1 ? -1 : s;
  }
  return out;
}

/** 名前 → 乱数の種（FNV-1a。`sim` のハッシュと同じ流儀）。 */
function hashName(name: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
