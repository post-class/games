import { describe, expect, it, vi } from 'vitest';
import { MusicDirector, type MusicMedia } from '../src/audio/MusicDirector';
import { combatMusicCue, musicPath, MUSIC_TRACKS } from '../src/audio/musicCues';

class FakeMedia implements MusicMedia {
  src = '';
  loop = false;
  preload = '';
  volume = 1;
  currentTime = 0;
  play = vi.fn(async () => undefined);
  pause = vi.fn();
  private errors: Array<() => void> = [];

  addEventListener(type: 'error', listener: () => void): void {
    if (type === 'error') this.errors.push(listener);
  }

  fail(): void {
    for (const listener of this.errors) listener();
  }
}

function musicHarness() {
  const media: FakeMedia[] = [];
  const output = {
    musicNode: {} as GainNode,
    connectMusicElement: vi.fn(() => ({} as MediaElementAudioSourceNode)),
  };
  const director = new MusicDirector(output, () => {
    const next = new FakeMedia();
    media.push(next);
    return next;
  });
  return { director, media, output };
}

describe('MP3 BGMキュー', () => {
  it('用途別の10曲すべてにpublic配下のMP3を割り当てる', () => {
    expect(Object.keys(MUSIC_TRACKS)).toHaveLength(10);
    for (const path of Object.values(MUSIC_TRACKS)) {
      expect(path).toMatch(/^\/audio\/music\/.*\.mp3$/);
    }
  });

  it('エース戦を最優先し、次に激戦・通常戦・緊張・哨戒の順で選ぶ', () => {
    expect(combatMusicCue(8, true)).toBe('boss');
    expect(combatMusicCue(4, false)).toBe('intenseCombat');
    expect(combatMusicCue(2, false)).toBe('combat');
    expect(combatMusicCue(1, false)).toBe('tension');
    expect(combatMusicCue(0, false)).toBe('patrol');
  });
});

describe('MP3再生器', () => {
  it('最初の要求でループ再生を始め、同じ曲の再要求では要素を作り直さない', () => {
    const { director, media, output } = musicHarness();
    director.play('title');
    director.start();
    director.update(0.75);

    expect(director.current).toBe('title');
    expect(media).toHaveLength(1);
    expect(media[0].src).toBe(MUSIC_TRACKS.title);
    expect(media[0].loop).toBe(true);
    expect(media[0].play).toHaveBeenCalledOnce();
    expect(media[0].volume).toBeCloseTo(1);
    expect(output.connectMusicElement).toHaveBeenCalledOnce();

    director.play('title');
    expect(media).toHaveLength(1);
  });

  it('曲を切り替えるとクロスフェードし、戦況選曲は3秒間維持する', () => {
    const { director, media } = musicHarness();
    director.playBattle('patrol');
    director.update(0.75);
    director.playBattle('combat');
    expect(director.current).toBe('patrol');

    director.update(3);
    director.playBattle('combat');
    director.update(0.75);
    expect(director.current).toBe('combat');
    expect(media).toHaveLength(2);
    expect(media[0].pause).toHaveBeenCalledOnce();
    expect(media[1].volume).toBeCloseTo(1);
  });

  it('MP3の読込失敗は無音として扱い、次の曲への切替を妨げない', () => {
    const { director, media } = musicHarness();
    director.play('title');
    media[0].fail();
    expect(() => director.update(1)).not.toThrow();

    director.play('hub');
    director.update(1);
    expect(director.current).toBe('hub');
    expect(media).toHaveLength(2);
    expect(media[1].play).toHaveBeenCalledOnce();
  });

  it('宿敵キューはボス曲を再利用し、同じMP3を二重にクロスフェードしない', () => {
    const { director, media } = musicHarness();
    director.playBattle('boss');
    director.update(0.75);
    director.update(3);

    director.playBattle('nemesis');

    expect(musicPath('nemesis')).toBe(MUSIC_TRACKS.boss);
    expect(director.current).toBe('nemesis');
    expect(media).toHaveLength(1);
  });
});
