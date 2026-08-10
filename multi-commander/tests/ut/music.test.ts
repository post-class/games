import { afterEach, describe, expect, it, vi } from 'vitest';
import { MusicDirector, type MusicMedia } from '../../src/audio/MusicDirector';
import {
  combatMusicCue,
  DEFAULT_MUSIC_ASSIGNMENT,
  musicPath,
  MUSIC_CUE_POOL,
  MUSIC_CUES,
  MUSIC_FILES,
  resolveMusicPath,
  setMusicAssignment,
  setMusicRandom,
} from '../../src/audio/musicCues';

afterEach(() => {
  setMusicAssignment(undefined);
  setMusicRandom();
});

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
  it('同梱の10曲すべてにpublic配下のMP3を割り当てる', () => {
    expect(Object.keys(MUSIC_FILES)).toHaveLength(10);
    for (const path of Object.values(MUSIC_FILES)) {
      expect(path).toMatch(/^\/audio\/music\/.*\.mp3$/);
    }
  });

  it('11の場面すべてに既定の曲が割り当たっている', () => {
    setMusicAssignment(undefined);
    expect(MUSIC_CUES).toHaveLength(11);
    for (const cue of MUSIC_CUES) {
      expect(musicPath(cue)).toMatch(/^\/audio\/music\/.*\.mp3$/);
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
    expect(media[0].src).toBe(MUSIC_FILES['title-space-fighter']);
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

  it('宿敵キューが同じ曲になったときは、同じMP3を二重にクロスフェードしない', () => {
    setMusicAssignment({ boss: 'boss-black-vortex', nemesis: 'boss-black-vortex' });
    const { director, media } = musicHarness();
    director.playBattle('boss');
    director.update(0.75);
    director.update(3);

    director.playBattle('nemesis');

    expect(musicPath('nemesis')).toBe(MUSIC_FILES['boss-black-vortex']);
    expect(director.current).toBe('nemesis');
    expect(media).toHaveLength(1);
  });
});

describe('戦闘BGMのランダム選曲', () => {
  it('出撃中の場面は既定でランダム、候補は2曲以上ある', () => {
    for (const cue of ['patrol', 'tension', 'combat', 'intenseCombat', 'boss', 'nemesis'] as const) {
      expect(DEFAULT_MUSIC_ASSIGNMENT[cue], cue).toBe('random');
      expect(MUSIC_CUE_POOL[cue].length, cue).toBeGreaterThanOrEqual(2);
    }
  });

  it('候補はすべて同梱曲を指し、先頭は従来の固定曲のまま', () => {
    for (const cue of MUSIC_CUES) {
      expect(MUSIC_CUE_POOL[cue].length, cue).toBeGreaterThan(0);
      for (const file of MUSIC_CUE_POOL[cue]) expect(MUSIC_FILES[file], cue).toBeDefined();
    }
    expect(MUSIC_CUE_POOL.combat[0]).toBe('combat-five-armies');
    expect(MUSIC_CUE_POOL.boss[0]).toBe('boss-black-vortex');
  });

  it('同じ場面を繰り返し要求しても、前回と同じ曲を続けて返さない', () => {
    setMusicAssignment(undefined);
    // 乱数を固定しても「前回引いた曲」を避けるので、同じ曲は連続しない
    setMusicRandom(() => 0);
    const first = resolveMusicPath('combat');
    const second = resolveMusicPath('combat');
    const third = resolveMusicPath('combat');
    expect(second).not.toBe(first);
    expect(third).not.toBe(second);
  });

  it('鳴っている曲は抽選から外す', () => {
    setMusicAssignment(undefined);
    setMusicRandom(() => 0);
    const playing = MUSIC_FILES[MUSIC_CUE_POOL.combat[0]];
    expect(resolveMusicPath('combat', playing)).not.toBe(playing);
  });

  it('曲名を固定した場面は抽選せず、その曲を返す', () => {
    setMusicAssignment({ combat: 'combat-rising-game' });
    for (let i = 0; i < 5; i++) {
      expect(resolveMusicPath('combat')).toBe(MUSIC_FILES['combat-rising-game']);
    }
  });

  it('出撃をまたいで戦闘曲を要求すると、別のMP3へ切り替わる', () => {
    setMusicAssignment(undefined);
    const { director, media } = musicHarness();
    director.playBattle('combat');
    director.update(0.75);
    // 出撃間の画面（母艦）を挟んでから、次の出撃で同じ戦況になる
    director.play('hub');
    director.update(0.75);
    director.playBattle('combat');
    director.update(0.75);

    const combatSources = [media[0].src, media[2].src];
    expect(combatSources[1]).not.toBe(combatSources[0]);
    for (const src of combatSources) {
      expect(MUSIC_CUE_POOL.combat.map((f) => MUSIC_FILES[f])).toContain(src);
    }
  });
});
