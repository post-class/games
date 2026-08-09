import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InputManager } from '../../src/app/input';
import { resetSettings, settings, updateSettings } from '../../src/app/settings';

type EventListener = (event: Record<string, unknown>) => void;

interface FakeWindow {
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
  dispatch(type: string, event: Record<string, unknown>): void;
}

type TestPad = Omit<Gamepad, 'axes' | 'buttons' | 'vibrationActuator'> & {
  axes: number[];
  buttons: Array<{ pressed: boolean; value: number }>;
  vibrationActuator: { playEffect: ReturnType<typeof vi.fn> };
};

function makeWindow(): FakeWindow {
  const listeners = new Map<string, Set<EventListener>>();
  return {
    addEventListener(type, listener) {
      const bucket = listeners.get(type) ?? new Set<EventListener>();
      bucket.add(listener);
      listeners.set(type, bucket);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    dispatch(type, event) {
      for (const listener of listeners.get(type) ?? []) listener(event);
    },
  };
}

function makeElement(): HTMLElement {
  const listeners = new Map<string, EventListener>();
  return {
    addEventListener: vi.fn((type: string, listener: EventListener) => listeners.set(type, listener)),
    removeEventListener: vi.fn((type: string) => listeners.delete(type)),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
    dispatchEvent: (event: Event & { type: string }) => {
      listeners.get(event.type)?.(event as unknown as Record<string, unknown>);
      return true;
    },
  } as unknown as HTMLElement;
}

function makePad(
  axes: number[] = [0, 0, 0, 0],
  buttonValues: Record<number, number> = {},
): TestPad {
  const buttons = Array.from({ length: 16 }, (_, index) => {
    const value = buttonValues[index] ?? 0;
    return { pressed: value > 0.5, value };
  });
  return {
    id: 'test-pad',
    index: 0,
    connected: true,
    mapping: 'standard',
    timestamp: 0,
    axes,
    buttons,
    vibrationActuator: {
      playEffect: vi.fn(() => Promise.resolve()),
    },
  } as unknown as TestPad;
}

describe('InputManager', () => {
  let fakeWindow: FakeWindow;
  let pads: Array<Gamepad | null>;
  let now = 0;

  beforeEach(() => {
    resetSettings();
    fakeWindow = makeWindow();
    pads = [null];
    vi.stubGlobal('window', fakeWindow);
    vi.stubGlobal('navigator', { getGamepads: () => pads });
    vi.stubGlobal('performance', { now: () => now });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function key(code: string, extra: Record<string, unknown> = {}): ReturnType<typeof vi.fn> {
    const preventDefault = vi.fn();
    fakeWindow.dispatch('keydown', {
      code,
      repeat: false,
      altKey: false,
      ctrlKey: false,
      preventDefault,
      ...extra,
    });
    return preventDefault;
  }

  function connect(pad: TestPad): void {
    pads[0] = pad as unknown as Gamepad;
  }

  it('再割当したキーで保持入力とエッジ入力を受け、旧スロットル別名は再割当後に残らない', () => {
    updateSettings({
      keyBindings: {
        ...settings.keyBindings,
        pitchUp: 'KeyW',
        targetNext: 'F5',
        firePrimary: 'KeyJ',
        throttleUp: 'KeyU',
      },
    });
    const input = new InputManager(makeElement());

    key('KeyW');
    key('KeyJ');
    const preventDefault = key('F5');
    expect(input.pitch).toBe(1);
    expect(input.firePrimary).toBe(true);
    expect(input.consumeActions()).toContain('targetNext');
    expect(preventDefault).toHaveBeenCalled();

    input.throttle = 0.5;
    key('BracketRight');
    input.update(1);
    expect(input.throttle).toBe(0.5);
    key('KeyU');
    input.update(1);
    expect(input.throttle).toBe(1);

    input.dispose();
  });

  it('スロットル増減キーの短い入力を1回の操作として受け付ける', () => {
    const input = new InputManager(makeElement());
    input.throttle = 0;

    key('BracketRight');
    expect(input.throttle).toBe(0.1);
    key('BracketLeft');
    expect(input.throttle).toBe(0);

    input.dispose();
  });

  it('ホイール入力でスロットルを増減する', () => {
    const element = makeElement();
    const input = new InputManager(element);
    input.throttle = 0.5;
    const preventDefault = vi.fn();

    element.dispatchEvent({ type: 'wheel', deltaY: -100, preventDefault } as unknown as Event & { type: string });
    expect(input.throttle).toBe(0.6);
    element.dispatchEvent({ type: 'wheel', deltaY: 100, preventDefault } as unknown as Event & { type: string });
    expect(input.throttle).toBe(0.5);
    expect(preventDefault).toHaveBeenCalledTimes(2);

    input.dispose();
  });

  it('ゲームパッドの軸、ボタン、デッドゾーン、押下エッジを固定更新で読む', () => {
    const input = new InputManager(makeElement());
    const pad = makePad([0.5, -0.5, 0, 0], { 0: 1, 7: 0.4 });
    connect(pad);

    input.update(1 / 60);
    expect(input.gamepadConnected).toBe(true);
    expect(input.yaw).toBeGreaterThan(0);
    expect(input.pitch).toBeGreaterThan(0);
    expect(input.firePrimary).toBe(true);
    expect(input.consumeActions()).toEqual(['fireMissile']);

    input.update(1 / 60);
    expect(input.consumeActions()).toEqual([]);
    pad.buttons[0].pressed = false;
    pad.buttons[0].value = 0;
    input.update(1 / 60);
    pad.buttons[0].pressed = true;
    pad.buttons[0].value = 1;
    input.update(1 / 60);
    expect(input.consumeActions()).toEqual(['fireMissile']);

    pads[0] = null;
    input.update(1 / 60);
    expect(input.gamepadConnected).toBe(false);
    expect(input.yaw).toBe(0);

    input.dispose();
  });

  it('ゲームパッドが中立のときはキーボード/既存スロットルを上書きしない', () => {
    const input = new InputManager(makeElement());
    input.throttle = 0.8;
    const pad = makePad();
    connect(pad);
    input.update(1 / 60);
    expect(input.throttle).toBe(0.8);

    pad.axes[3] = 1;
    input.update(1 / 60);
    expect(input.throttle).toBe(0);
    input.dispose();
  });

  it('複数の入力イベントを遅延テレメトリに取りこぼさず記録する', () => {
    const input = new InputManager(makeElement());
    now = 10;
    key('KeyT');
    now = 12;
    key('KeyR');
    now = 25;
    input.update(1 / 60);

    expect(input.latencyTelemetry).toEqual({ samples: 2, averageMs: 14, maxMs: 15 });
    input.dispose();
  });

  it('対応パッドの振動設定を尊重して振動を発火する', () => {
    const input = new InputManager(makeElement());
    const pad = makePad();
    connect(pad);
    input.update(1 / 60);
    input.rumble(0.8, 50);

    expect(pad.vibrationActuator?.playEffect).toHaveBeenCalledWith('dual-rumble', {
      duration: 50,
      strongMagnitude: 0.8,
      weakMagnitude: 0.5599999999999999,
    });
    input.dispose();
  });

  it('振動APIの同期例外でゲーム入力を壊さない', () => {
    const input = new InputManager(makeElement());
    const pad = makePad();
    pad.vibrationActuator.playEffect = vi.fn(() => {
      throw new Error('unsupported');
    });
    connect(pad);
    input.update(1 / 60);

    expect(() => input.rumble()).not.toThrow();
    input.dispose();
  });
});
