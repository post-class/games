import { afterEach, describe, expect, it, vi } from 'vitest';
import { Vector3 } from 'three';
import { AudioManager } from '../src/audio/AudioManager';
import { audio } from '../src/audio/AudioManager';
import { CombatAudio } from '../src/audio/CombatAudio';
import { bus } from '../src/core/events';
import { shipDef } from '../src/content/ships';
import { newAi } from '../src/sim/ai';
import { spawnShip, World } from '../src/world/world';

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

    const seconds = manager.radioVoice('テスト通信', 'friendly', 'Spirit');
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
