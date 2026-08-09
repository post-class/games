import { afterEach, describe, expect, it, vi } from 'vitest';
import { Vector3 } from 'three';
import { AudioManager } from '../../src/audio/AudioManager';
import { audio } from '../../src/audio/AudioManager';
import { CombatAudio, explosionAudioSize } from '../../src/audio/CombatAudio';
import { bus } from '../../src/core/events';
import { shipDef } from '../../src/content/ships';
import { newAi } from '../../src/sim/ai';
import { spawnShip, World } from '../../src/world/world';
import { settings } from '../../src/app/settings';

class FakeParam {
  value = 0;

  setTargetAtTime(value: number): void {
    this.value = value;
  }

  setValueAtTime(value: number): void {
    this.value = value;
  }

  exponentialRampToValueAtTime(value: number): void {
    this.value = value;
  }

  linearRampToValueAtTime(value: number): void {
    this.value = value;
  }
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
  oscillatorCount = 0;

  createGain(): GainNode {
    return Object.assign(new FakeNode(), { gain: new FakeParam() }) as unknown as GainNode;
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AudioManager 無線音声', () => {
  it('終了スケルチのノイズ源を発音予定時刻に開始する', () => {
    vi.stubGlobal('window', { AudioContext: FakeAudioContext });
    const manager = new AudioManager();
    manager.resume();

    const seconds = manager.radioVoice('テスト通信', 'friendly', 'Sable');
    const context = manager.context as unknown as FakeAudioContext;
    const closingSquelch = context.sources[2];

    expect(seconds).toBeGreaterThan(0);
    expect(closingSquelch.starts[0]).toBeCloseTo(10 + seconds - 0.05);
    expect(closingSquelch.stops[0] - closingSquelch.starts[0]).toBeCloseTo(0.1);

    manager.dispose();
  });

  it('空の無線文では口の動き用イベント時間を返さない', () => {
    vi.stubGlobal('window', { AudioContext: FakeAudioContext });
    const manager = new AudioManager();
    manager.resume();

    expect(manager.radioVoice('   ')).toBe(0);

    manager.dispose();
  });
});

describe('AudioManager 戦闘音声の安全性と間引き', () => {
  it('AudioContext が無い環境、音量0、自動再生拒否でも例外を投げない', () => {
    const withoutContext = new AudioManager();
    expect(() => {
      withoutContext.resume();
      withoutContext.gun('laser', 0, 0);
      withoutContext.missileLaunch('torpedo', 0, 0);
      withoutContext.warning('missile', 'torpedo');
    }).not.toThrow();
    withoutContext.dispose();

    vi.stubGlobal('window', { AudioContext: class extends FakeAudioContext {
      override resume(): Promise<void> {
        return Promise.reject(new Error('autoplay denied'));
      }
    } });
    const muted = new AudioManager();
    const previousMaster = settings.volumeMaster;
    const previousSfx = settings.volumeSfx;
    settings.volumeMaster = 0;
    settings.volumeSfx = 0;
    expect(() => {
      muted.resume();
      muted.gun('neutron-gun', 0, 0);
      muted.explosion(0, 0, 'torpedo');
    }).not.toThrow();
    settings.volumeMaster = previousMaster;
    settings.volumeSfx = previousSfx;
    muted.dispose();
  });

  it('4種の主砲・4種のミサイルと命中/爆発音を安全に発音し、同時発音数を制限する', () => {
    vi.stubGlobal('window', { AudioContext: FakeAudioContext });
    const manager = new AudioManager();
    manager.resume();
    const context = manager.context as unknown as FakeAudioContext;

    for (const id of ['laser', 'mass-driver', 'neutron-gun', 'particle-cannon']) {
      manager.gun(id, 100, -0.25);
    }
    for (const id of ['dumbfire', 'heat-seeker', 'image-rec', 'torpedo']) {
      manager.missileLaunch(id, 100, 0.25);
    }
    manager.shieldHit(100, 0);
    manager.armorHit(100, 0, 'armor');
    manager.armorHit(100, 0, 'hull');
    manager.explosion(100, 0, 'small');
    manager.explosion(100, 0, 'large');
    manager.explosion(100, 0, 'torpedo');

    // 同一時刻に異なるイベントを無制限に積まず、上限内で打ち切る。
    const beforeBeeps = context.oscillatorCount;
    for (let i = 0; i < 40; i++) manager.beep(300 + i, 0.2);
    expect(context.oscillatorCount - beforeBeeps).toBeLessThanOrEqual(32);

    const before = context.oscillatorCount;
    manager.gun('laser', 100, 0);
    expect(context.oscillatorCount).toBe(before);
    manager.dispose();
  });
});

describe('CombatAudio 音声プロファイル分類', () => {
  it('爆発イベントの既存情報から小型・大型・魚雷を分類する', () => {
    expect(explosionAudioSize('small', 100)).toBe('small');
    expect(explosionAudioSize('ship', 10)).toBe('large');
    expect(explosionAudioSize('missile', 30)).toBe('small');
    expect(explosionAudioSize('missile', 70)).toBe('torpedo');
  });

  it('weaponFired の weaponId をミサイル音へそのまま渡す', () => {
    const combatAudio = new CombatAudio();
    const launch = vi.spyOn(audio, 'missileLaunch');
    const shooter = spawnShip(new World(), {
      def: shipDef('hornet'),
      faction: 'confed',
      pos: new Vector3(),
      speed: 0,
    });

    for (const weaponId of ['dumbfire', 'heat-seeker', 'image-rec', 'torpedo']) {
      bus.emit('weaponFired', {
        shooter,
        muzzle: new Vector3(),
        direction: new Vector3(0, 0, -1),
        weaponKind: 'missile',
        weaponId,
        isPlayer: false,
      });
    }

    expect(launch.mock.calls.map(([id]) => id)).toEqual(['dumbfire', 'heat-seeker', 'image-rec', 'torpedo']);
    launch.mockRestore();
    combatAudio.dispose();
  });
});

describe('CombatAudio ライトモチーフ', () => {
  it('自機や輸送艦では僚機音を鳴らさず、僚機死亡と帰投だけを識別する', () => {
    const world = new World();
    const player = spawnShip(world, {
      def: shipDef('hornet'),
      faction: 'confed',
      pos: new Vector3(),
      speed: 0,
    });
    world.playerId = player.id;
    const wingman = spawnShip(world, {
      def: shipDef('hornet'),
      faction: 'confed',
      pos: new Vector3(100, 0, 0),
      speed: 0,
      ai: newAi(0.5, { leaderId: player.id }),
    });
    const transport = spawnShip(world, {
      def: shipDef('drayman'),
      faction: 'confed',
      pos: new Vector3(200, 0, 0),
      speed: 0,
    });
    const combatAudio = new CombatAudio();
    combatAudio.update(world, 0.016, true);
    const motif = vi.spyOn(audio, 'motif');

    const destroyed = (target: typeof player) =>
      bus.emit('destroyed', { target, killedByPlayer: false });
    destroyed(player);
    destroyed(transport);
    expect(motif).not.toHaveBeenCalled();

    destroyed(wingman);
    expect(motif).toHaveBeenCalledWith('wingman');
    bus.emit('navReached', { index: 0, name: 'NAV 1' });
    expect(motif).toHaveBeenCalledTimes(1);
    bus.emit('navReached', { index: 1, name: '帰投' });
    expect(motif).toHaveBeenLastCalledWith('carrier');

    combatAudio.dispose();
    motif.mockRestore();
  });
});
