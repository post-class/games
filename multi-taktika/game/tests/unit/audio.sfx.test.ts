/**
 * 効果音の枠の検証（T-M17-07）。
 *
 * ■ ここで守りたいこと
 *  1. **音源が 1 つも無くてもゲームが動く**。音は「あれば鳴る」だけの追加物。
 *  2. 設定で切ったら本当に鳴らない（`Settings` の「警告音」が効く）。
 *  3. 同じ音が連続で何十回も鳴らない（戦域が同時に 6 つ立つと耳が痛い）。
 */

import { describe, expect, it, vi } from 'vitest';
import { SFX_NAMES, Sfx, sfxUrl, type AudioSink, type SfxName } from '@/audio/sfx';

/** 実在する音源を name で指定できる偽の出力口。 */
function fakeSink(available: readonly SfxName[]) {
  const played: { url: string; volume: number }[] = [];
  const urlOf = new Map(available.map((n) => [sfxUrl(n), n]));
  const sink: AudioSink = {
    load: async (url) => (urlOf.has(url) ? ({ url } as unknown as AudioBuffer) : null),
    play: (buffer, volume) => {
      played.push({ url: (buffer as unknown as { url: string }).url, volume });
    },
  };
  return { sink, played };
}

describe('Sfx — 音源が無くても動く', () => {
  it('出力口を差していなければ play しても何も起きない（例外も出ない）', () => {
    const s = new Sfx();
    expect(() => s.play('warning', 0)).not.toThrow();
  });

  it('音源が無い枠は静かに無視される', async () => {
    const { sink, played } = fakeSink([]);
    const s = new Sfx(sink);
    await s.preloadAll();
    for (const n of SFX_NAMES) s.play(n, 0);
    expect(played).toHaveLength(0);
    expect(s.loadedNames()).toHaveLength(0);
  });

  it('用意された音源だけ鳴る', async () => {
    const { sink, played } = fakeSink(['warning', 'click']);
    const s = new Sfx(sink);
    await s.preloadAll();
    expect(s.loadedNames()).toEqual(['warning', 'click']);
    s.play('warning', 0);
    s.play('front_open', 0); // 音源が無い
    expect(played.map((p) => p.url)).toEqual([sfxUrl('warning')]);
  });

  it('最初の play は読み込みを始めるだけで鳴らない（待たせない）', async () => {
    const { sink, played } = fakeSink(['warning']);
    const s = new Sfx(sink);
    s.play('warning', 0); // 未読み込み → 読み込み開始のみ
    expect(played).toHaveLength(0);
    await vi.waitFor(() => expect(s.loadedNames()).toEqual(['warning']));
    s.play('warning', 100);
    expect(played).toHaveLength(1);
  });
});

describe('Sfx — 設定と間引き', () => {
  it('setEnabled(false) で鳴らない（設定の「警告音」が効く）', async () => {
    const { sink, played } = fakeSink(['warning']);
    const s = new Sfx(sink);
    await s.preloadAll();
    s.setEnabled(false);
    s.play('warning', 0);
    expect(played).toHaveLength(0);
    s.setEnabled(true);
    s.play('warning', 0);
    expect(played).toHaveLength(1);
  });

  it('音量 0 なら鳴らない', async () => {
    const { sink, played } = fakeSink(['warning']);
    const s = new Sfx(sink);
    await s.preloadAll();
    s.setVolume(0);
    s.play('warning', 0);
    expect(played).toHaveLength(0);
  });

  it('音量は 0..1 に丸められる', async () => {
    const { sink, played } = fakeSink(['click']);
    const s = new Sfx(sink);
    await s.preloadAll();
    s.setVolume(5);
    s.play('click', 0);
    expect(played[0]!.volume).toBe(1);
  });

  it('同じ音は間隔を空けないと鳴らない（戦域が同時に 6 つ立っても 1 回）', async () => {
    const { sink, played } = fakeSink(['front_open']);
    const s = new Sfx(sink);
    await s.preloadAll();
    for (let k = 0; k < 6; k++) s.play('front_open', 1000 + k); // 1ms 刻み
    expect(played).toHaveLength(1);
    // 間隔が空けば鳴る
    s.play('front_open', 1000 + 200);
    expect(played).toHaveLength(2);
  });

  it('違う音は間引きの対象にならない（同時に別の出来事は両方聞こえる）', async () => {
    const { sink, played } = fakeSink(['front_open', 'warning']);
    const s = new Sfx(sink);
    await s.preloadAll();
    s.play('front_open', 0);
    s.play('warning', 0);
    expect(played).toHaveLength(2);
  });
});

describe('枠の名前', () => {
  it('名前が重複していない', () => {
    expect(new Set(SFX_NAMES).size).toBe(SFX_NAMES.length);
  });

  it('URL は assets/sfx/<name>.webm', () => {
    expect(sfxUrl('warning')).toBe('assets/sfx/warning.webm');
  });
});
