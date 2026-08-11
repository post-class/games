/**
 * 合成した効果音の検算（`audio/synth.ts`）。
 *
 * ■ 音は聞かないと分からない ―― では何をテストするのか
 * 「良い音か」はテストできない。テストできるのは**壊れた音の条件**で、
 * それは耳で気付いたときには手遅れになりやすい種類の不具合:
 *  - 頭・終わりが 0 でない → スピーカーが段差を鳴らして「プツッ」と入る
 *  - 音量が 1 を超える     → 割れる
 *  - NaN が混ざる          → 環境によって無音、または雑音
 *  - 長すぎる              → 効果音が重なって何が起きたか分からなくなる
 *  - 鳴らすたびに変わる    → 「この音だけ耳障り」を再現できない
 * どれも「聞けば分かる」が、**10 枠すべてを毎回聞き直すのは無理**なので機械で見る。
 */

import { describe, expect, it } from 'vitest';
import { SFX_NAMES, Sfx, type AudioSink } from '@/audio/sfx';
import { canSynthesize, renderSfxSamples, sfxSeconds } from '@/audio/synth';

/** 実際に使われる周波数（`AudioContext.sampleRate` の代表値）。 */
const RATE = 48000;

describe('効果音の合成', () => {
  it('10 枠すべてが合成できる（`sfx.ts` の枠と 1 対 1）', () => {
    expect(SFX_NAMES.length).toBe(10);
    for (const name of SFX_NAMES) {
      expect(canSynthesize(name), `${name} の音が設計されていない`).toBe(true);
      expect(renderSfxSamples(name, RATE).length).toBeGreaterThan(0);
    }
  });

  it('枠に無い名前は合成できないと分かる', () => {
    expect(canSynthesize('nope')).toBe(false);
  });

  it('音量が 1 を超えない（割れない）', () => {
    for (const name of SFX_NAMES) {
      const s = renderSfxSamples(name, RATE);
      let peak = 0;
      for (let i = 0; i < s.length; i++) {
        const v = Math.abs(s[i]!);
        if (v > peak) peak = v;
      }
      // **1 以下ではなく 0.95 以下を要求する。**
      // `renderSfxSamples` は 1 を超えた値を潰すので「1 以下」は必ず通ってしまい、
      // 割れている音を見逃す。実際に `front_open` はピーク 1.00 に張り付いていた
      // （足し合わせた結果が 1.25 になっていた）。余裕を残して設計させる。
      expect(peak, `${name} の音量が大きすぎる（潰れている疑い）`).toBeLessThanOrEqual(0.95);
      // 逆に小さすぎる（実質無音）のも不具合
      expect(peak, `${name} が実質無音`).toBeGreaterThan(0.05);
    }
  });

  it('NaN や Infinity が混ざらない', () => {
    for (const name of SFX_NAMES) {
      const s = renderSfxSamples(name, RATE);
      for (let i = 0; i < s.length; i++) {
        expect(Number.isFinite(s[i]!), `${name} の ${i} 番目が有限でない`).toBe(true);
      }
    }
  });

  it('頭と終わりが 0 に近い（「プツッ」と鳴らない）', () => {
    for (const name of SFX_NAMES) {
      const s = renderSfxSamples(name, RATE);
      expect(Math.abs(s[0]!), `${name} の頭が 0 でない`).toBeLessThan(0.02);
      expect(Math.abs(s[s.length - 1]!), `${name} の終わりが 0 でない`).toBeLessThan(0.02);
    }
  });

  it('長すぎない（効果音が重なって潰れない）', () => {
    for (const name of SFX_NAMES) {
      // 勝敗の音だけは 1 試合 1 回なので長くてよい。ほかは 1.2 秒まで。
      const limit = name === 'match_end' ? 2 : 1.2;
      expect(sfxSeconds(name), `${name} が長すぎる`).toBeLessThanOrEqual(limit);
      expect(renderSfxSamples(name, RATE).length / RATE).toBeCloseTo(sfxSeconds(name), 2);
    }
  });

  it('頻度が高い音は特に短い（令の到着・押した手触り）', () => {
    // 令は 1 試合に何十回も届き、クリックはそれ以上鳴る。ここが長いと音が渋滞する。
    expect(sfxSeconds('order_arrive')).toBeLessThanOrEqual(0.3);
    expect(sfxSeconds('click')).toBeLessThanOrEqual(0.1);
  });

  it('同じ名前なら毎回同じ波形（乱数を固定してある）', () => {
    for (const name of SFX_NAMES) {
      const a = renderSfxSamples(name, RATE);
      const b = renderSfxSamples(name, RATE);
      expect(Array.from(a.slice(0, 200)), `${name} が呼ぶたびに変わる`).toEqual(
        Array.from(b.slice(0, 200))
      );
    }
  });

  it('名前ごとに違う音になっている（全部同じ音ではない）', () => {
    const seen = new Set<string>();
    for (const name of SFX_NAMES) {
      const s = renderSfxSamples(name, RATE);
      // 先頭 400 サンプルの指紋
      let h = 0;
      for (let i = 0; i < 400 && i < s.length; i++) h = (h * 31 + Math.round(s[i]! * 1000)) | 0;
      seen.add(String(h));
    }
    expect(seen.size, '同じ波形の枠がある').toBe(SFX_NAMES.length);
  });

  it('サンプリング周波数が変わっても成立する（44.1kHz でも同じ長さ）', () => {
    for (const name of SFX_NAMES) {
      const s = renderSfxSamples(name, 44100);
      expect(s.length / 44100).toBeCloseTo(sfxSeconds(name), 2);
    }
  });

  it('不正なサンプリング周波数は落とす（黙って空の音を返さない）', () => {
    expect(() => renderSfxSamples('click', 0)).toThrow();
    expect(() => renderSfxSamples('click', -1)).toThrow();
  });
});

describe('`Sfx` との結線（ファイルが優先・無ければ合成）', () => {
  /** 音源ファイルが無い出力口。 */
  function sinkWithoutFiles(): { sink: AudioSink; played: string[] } {
    const played: string[] = [];
    const fake = { length: 1 } as unknown as AudioBuffer;
    const sink: AudioSink = {
      load: () => Promise.resolve(null), // ファイルは無い
      play: () => played.push('played'),
      synthesize: () => fake,
    };
    return { sink, played };
  }

  it('ファイルが無ければ合成した音が使われる', async () => {
    const { sink } = sinkWithoutFiles();
    const s = new Sfx(sink);
    await s.preloadAll();
    expect(s.loadedNames().length).toBe(SFX_NAMES.length);
  });

  it('ファイルがあればファイルが勝つ（合成は呼ばれない）', async () => {
    const fileBuf = { length: 2 } as unknown as AudioBuffer;
    let synthCalls = 0;
    const sink: AudioSink = {
      load: () => Promise.resolve(fileBuf),
      play: () => undefined,
      synthesize: () => {
        synthCalls++;
        return null;
      },
    };
    const s = new Sfx(sink);
    await s.preloadAll();
    expect(synthCalls, 'ファイルがあるのに合成を呼んでいる').toBe(0);
    expect(s.loadedNames().length).toBe(SFX_NAMES.length);
  });

  it('合成を持たない出力口では今までどおり無音（例外を出さない）', async () => {
    const played: string[] = [];
    const sink: AudioSink = {
      load: () => Promise.resolve(null),
      play: () => played.push('x'),
    };
    const s = new Sfx(sink);
    await s.preloadAll();
    expect(s.loadedNames()).toEqual([]);
    s.play('click', 0);
    expect(played).toEqual([]);
  });

  it('合成した音でも連打の間引きは効く', async () => {
    const { sink, played } = sinkWithoutFiles();
    const s = new Sfx(sink);
    await s.preloadAll();
    s.play('click', 1000);
    s.play('click', 1010); // 間隔が足りない
    s.play('click', 1200);
    expect(played.length).toBe(2);
  });
});
