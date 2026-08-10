import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioManager } from '../../src/audio/AudioManager';
import {
  DEFAULT_SETTINGS,
  DEFAULT_SFX,
  SFX_CATEGORIES,
  SFX_SOFT_DURATION,
  SFX_SOFT_GAIN,
  SFX_SOURCE_OPTIONS,
  resetSettings,
  settings,
  sfxDurationScale,
  sfxGain,
  sfxUsesSample,
  updateSettings,
  type SfxCategory,
  type SfxSetting,
  type SfxSource,
  type Settings,
} from '../../src/app/settings';

/** `sfxGain()` などの純関数へ渡す設定を作る（グローバルの `settings` を汚さない） */
function withSfx(overrides: Partial<Record<SfxCategory, SfxSetting>>): Settings {
  return {
    ...DEFAULT_SETTINGS,
    sfx: { ...DEFAULT_SFX, ...overrides },
  } as Settings;
}

// ───────── AudioContext のモック（tests/ut/audio-manager.test.ts と同じ書き方） ─────────

class FakeParam {
  value = 0;
  /** エンベロープは最終値が 0 付近まで下がるので、指定された値の履歴も残す */
  readonly values: number[] = [];

  private set(value: number): void {
    this.value = value;
    this.values.push(value);
  }

  setTargetAtTime(value: number): void {
    this.set(value);
  }

  setValueAtTime(value: number): void {
    this.set(value);
  }

  exponentialRampToValueAtTime(value: number): void {
    this.set(value);
  }

  linearRampToValueAtTime(value: number): void {
    this.set(value);
  }
}

/** エンベロープの頂点（実際に耳に届く音量）を読む */
function peak(param: FakeParam | undefined): number {
  return param && param.values.length > 0 ? Math.max(...param.values) : 0;
}

class FakeNode {
  connect(_destination: unknown): void {}
}

class FakeBufferSource extends FakeNode {
  buffer?: AudioBuffer;
  loop = false;
  starts: number[] = [];
  stops: number[] = [];

  start(at = 0): void {
    this.starts.push(at);
  }

  stop(at = 0): void {
    this.stops.push(at);
  }
}

class FakeAudioContext {
  readonly currentTime = 10;
  readonly sampleRate = 44100;
  readonly state = 'running';
  readonly destination = {};
  readonly sources: FakeBufferSource[] = [];
  /** spatial() / emitBeep() などが作った GainNode の最終値を見るために保持する */
  readonly gains: FakeParam[] = [];
  oscillatorCount = 0;

  createGain(): GainNode {
    const gain = new FakeParam();
    this.gains.push(gain);
    return Object.assign(new FakeNode(), { gain }) as unknown as GainNode;
  }

  createBiquadFilter(): BiquadFilterNode {
    return Object.assign(new FakeNode(), {
      type: 'lowpass',
      frequency: new FakeParam(),
      Q: new FakeParam(),
    }) as unknown as BiquadFilterNode;
  }

  createOscillator(): OscillatorNode {
    this.oscillatorCount += 1;
    return Object.assign(new FakeNode(), {
      type: 'sine',
      frequency: new FakeParam(),
      start: () => undefined,
      stop: () => undefined,
    }) as unknown as OscillatorNode;
  }

  createStereoPanner(): StereoPannerNode {
    return Object.assign(new FakeNode(), { pan: { value: 0 } }) as unknown as StereoPannerNode;
  }

  createBufferSource(): AudioBufferSourceNode {
    const source = new FakeBufferSource();
    this.sources.push(source);
    return source as unknown as AudioBufferSourceNode;
  }

  createBuffer(_channels: number, length: number, _sampleRate: number): AudioBuffer {
    return { getChannelData: () => new Float32Array(length) } as unknown as AudioBuffer;
  }

  resume(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

/** モック済みの AudioManager を1本立てる */
function startManager(): { manager: AudioManager; context: FakeAudioContext } {
  vi.stubGlobal('window', { AudioContext: FakeAudioContext });
  const manager = new AudioManager();
  manager.resume();
  return { manager, context: manager.context as unknown as FakeAudioContext };
}

beforeEach(() => {
  resetSettings();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetSettings();
});

describe('W5-B 効果音カテゴリの設定（純関数）', () => {
  // ケース①
  it('off で null を返し、soft で音量 0.5 倍・長さ 0.7 倍になる', () => {
    const off = withSfx({ explosion: { source: 'off', gain: 1 } });
    expect(sfxGain('explosion', off)).toBeNull();
    // 同じ設定でも他カテゴリは影響を受けない
    expect(sfxGain('gun', off)).toBe(1);

    const soft = withSfx({ warning: { source: 'soft', gain: 1 } });
    expect(sfxGain('warning', soft)).toBeCloseTo(SFX_SOFT_GAIN);
    expect(sfxDurationScale('warning', soft)).toBeCloseTo(SFX_SOFT_DURATION);
    // 合成音のカテゴリは長さを変えない
    expect(sfxDurationScale('lock', soft)).toBe(1);

    // カテゴリ音量と soft は掛け算になる
    const softHalf = withSfx({ lock: { source: 'soft', gain: 0.5 } });
    expect(sfxGain('lock', softHalf)).toBeCloseTo(0.5 * SFX_SOFT_GAIN);

    // 音量 0 は無音と同じ扱い（null）にして、以降の合成処理へ進まない
    expect(sfxGain('gun', withSfx({ gun: { source: 'sample', gain: 0 } }))).toBeNull();

    // 実音声を使うのは source === 'sample' のときだけ
    expect(sfxUsesSample('gun', withSfx({}))).toBe(true);
    expect(sfxUsesSample('gun', withSfx({ gun: { source: 'synth', gain: 1 } }))).toBe(false);
  });

  // ケース②
  it('カテゴリが許可しない source は正規化で既定へ戻る', () => {
    updateSettings({
      sfx: {
        ...DEFAULT_SFX,
        // 被弾に同梱 wav は無いので 'sample' は弾かれる
        impact: { source: 'sample' as SfxSource, gain: 1 },
        // 爆発に 'soft' は用意していない
        explosion: { source: 'soft' as SfxSource, gain: 1 },
        // 許可されている値はそのまま残る
        warning: { source: 'soft', gain: 1 },
        // 未知の文字列も既定へ
        ui: { source: 'sample-hd' as SfxSource, gain: 1 },
      },
    });

    expect(settings.sfx.impact.source).toBe(DEFAULT_SFX.impact.source);
    expect(settings.sfx.explosion.source).toBe(DEFAULT_SFX.explosion.source);
    expect(settings.sfx.ui.source).toBe(DEFAULT_SFX.ui.source);
    expect(settings.sfx.warning.source).toBe('soft');
  });

  // ケース③
  it('SFX_SOURCE_OPTIONS が全カテゴリを持ち、既定値がその選択肢に含まれる', () => {
    for (const category of SFX_CATEGORIES) {
      const options = SFX_SOURCE_OPTIONS[category];
      expect(options, category).toBeTruthy();
      expect(options.length, category).toBeGreaterThan(0);
      // 設定画面の選択肢は必ず既定値を含む（選び直せなくならないため）
      expect(options, category).toContain(DEFAULT_SFX[category].source);
      // どのカテゴリも「無音」にできる
      expect(options, category).toContain('off');
    }
    expect(Object.keys(SFX_SOURCE_OPTIONS).sort()).toEqual([...SFX_CATEGORIES].sort());
  });

  // ケース④
  it('gain が 0..1 にクランプされ、壊れた値は 1 へ戻る', () => {
    updateSettings({
      sfx: {
        ...DEFAULT_SFX,
        gun: { source: 'sample', gain: 5 },
        missile: { source: 'sample', gain: -3 },
        impact: { source: 'synth', gain: Number.NaN },
        explosion: { source: 'synth', gain: 0.42 },
      },
    });

    expect(settings.sfx.gun.gain).toBe(1);
    expect(settings.sfx.missile.gain).toBe(0);
    expect(settings.sfx.impact.gain).toBe(1);
    expect(settings.sfx.explosion.gain).toBeCloseTo(0.42);
    expect(sfxGain('missile')).toBeNull();
  });
});

describe('W5-B AudioManager が設定に従う', () => {
  it('カテゴリを無音にした音だけが止まり、他カテゴリは鳴る', () => {
    const { manager, context } = startManager();

    updateSettings({ sfx: { ...DEFAULT_SFX, gun: { source: 'off', gain: 1 } } });
    const beforeGun = context.oscillatorCount;
    manager.gun('laser', 100, 0);
    expect(context.oscillatorCount).toBe(beforeGun);

    // 被弾・爆発は無音設定にしていないので鳴る
    manager.shieldHit(100, 0);
    manager.explosion(100, 0, 'large');
    expect(context.oscillatorCount).toBeGreaterThan(beforeGun);

    manager.dispose();
  });

  it('UI を無音にしても警報・ロック音は鳴る（beep 分離の確認）', () => {
    const { manager, context } = startManager();
    updateSettings({ sfx: { ...DEFAULT_SFX, ui: { source: 'off', gain: 1 } } });

    // UI ビープと Nav/ジャンプ音は止まる
    const beforeUi = context.oscillatorCount;
    manager.beep(880);
    manager.warpTone(true);
    manager.motif('wingman');
    expect(context.oscillatorCount).toBe(beforeUi);

    // 警報とロック音は自分のカテゴリで判定するので鳴り続ける
    manager.warning('missile');
    expect(context.oscillatorCount).toBeGreaterThan(beforeUi);
    const beforeLock = context.oscillatorCount;
    manager.lockTone(true, 'heat-seeker');
    expect(context.oscillatorCount).toBeGreaterThan(beforeLock);
    const beforeStage = context.oscillatorCount;
    manager.damageStageCue('hull-hit');
    expect(context.oscillatorCount).toBeGreaterThan(beforeStage);

    manager.dispose();
  });

  it('警報を無音にすると警報と段階通知だけが止まる', () => {
    const { manager, context } = startManager();
    updateSettings({ sfx: { ...DEFAULT_SFX, warning: { source: 'off', gain: 1 } } });

    const before = context.oscillatorCount;
    manager.warning('missile');
    manager.warning('hull');
    manager.damageStageCue('hull-hit');
    expect(context.oscillatorCount).toBe(before);

    manager.beep(880);
    expect(context.oscillatorCount).toBeGreaterThan(before);

    manager.dispose();
  });

  it('警報を控えめにすると音量と長さが下がる', () => {
    const { manager, context } = startManager();

    updateSettings({ sfx: { ...DEFAULT_SFX, warning: { source: 'synth', gain: 1 } } });
    manager.warning('shield');
    expect(peak(context.gains.at(-1))).toBeCloseTo(0.22);

    updateSettings({ sfx: { ...DEFAULT_SFX, warning: { source: 'soft', gain: 1 } } });
    manager.warning('hull');
    expect(peak(context.gains.at(-1))).toBeCloseTo(0.28 * SFX_SOFT_GAIN);

    manager.dispose();
  });

  it('無線を無音にすると 0 秒を返す（字幕と口の動きを壊さない）', () => {
    const { manager } = startManager();

    expect(manager.radioVoice('了解した', 'friendly', 'Sable')).toBeGreaterThan(0);
    updateSettings({ sfx: { ...DEFAULT_SFX, voice: { source: 'off', gain: 1 } } });
    expect(manager.radioVoice('了解した', 'friendly', 'Sable')).toBe(0);

    manager.dispose();
  });

  it('エンジンを無音にしてもノードは残り、ゲインだけ 0 へ寄る', () => {
    const { manager, context } = startManager();

    manager.updateEngine(1, true, true);
    const nodeCount = context.gains.length;
    const running = context.gains.at(-1)?.value ?? 0;
    expect(running).toBeGreaterThan(0);

    updateSettings({ sfx: { ...DEFAULT_SFX, engine: { source: 'off', gain: 1 } } });
    manager.updateEngine(1, true, true);
    // ノードを作り直していない（同じ GainNode を使い続けている）
    expect(context.gains.length).toBe(nodeCount);
    expect(context.gains.at(-1)?.value).toBe(0);

    manager.dispose();
  });

  it('主砲を合成音にすると同梱 wav を使わない', () => {
    const { manager, context } = startManager();
    updateSettings({ sfx: { ...DEFAULT_SFX, gun: { source: 'synth', gain: 1 } } });

    const before = context.oscillatorCount;
    manager.gun('laser', 100, 0);
    // 合成音の経路を通るのでオシレーターが増える（wav 再生なら増えない）
    expect(context.oscillatorCount).toBeGreaterThan(before);

    manager.dispose();
  });

  it('AudioContext が無い環境でも各メソッドが例外を投げない', () => {
    for (const source of ['off', 'soft', 'synth', 'sample'] as SfxSource[]) {
      const sfx = {} as Record<SfxCategory, SfxSetting>;
      // 許可されない組み合わせは正規化で既定へ戻るので、そのまま流し込んで良い
      for (const category of SFX_CATEGORIES) sfx[category] = { source, gain: 0.5 };
      updateSettings({ sfx });

      const manager = new AudioManager();
      expect(() => {
        manager.resume();
        manager.gun('laser', 100, 0);
        manager.missileLaunch('torpedo', 100, 0);
        manager.shieldHit(100, 0);
        manager.armorHit(100, 0, 'hull');
        manager.explosion(100, 0, 'torpedo');
        manager.warning('missile', 'torpedo');
        manager.damageStageCue('hull-critical');
        manager.lockTone(true, 'torpedo');
        manager.beep(440);
        manager.warpTone(true);
        manager.warpTone(false);
        manager.motif('nemesis');
        expect(manager.radioVoice('通信テスト', 'command', 'Base')).toBe(0);
        manager.updateEngine(0.8, false, true);
        manager.stopEngine();
      }, source).not.toThrow();
      manager.dispose();
    }
  });
});
