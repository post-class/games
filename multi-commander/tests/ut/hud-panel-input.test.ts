import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InputManager } from '../../src/app/input';
import { DEFAULT_KEY_BINDINGS, resetSettings } from '../../src/app/settings';

type Listener = (event: Record<string, unknown>) => void;

function makeWindow(): { addEventListener: (type: string, fn: Listener) => void; removeEventListener: (type: string, fn: Listener) => void; dispatch: (type: string, event: Record<string, unknown>) => void } {
  const listeners = new Map<string, Listener>();
  return {
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type) => listeners.delete(type),
    dispatch: (type, event) => listeners.get(type)?.(event),
  };
}

function makeElement(): HTMLElement {
  const listeners = new Map<string, Listener>();
  return {
    addEventListener: vi.fn((type: string, fn: Listener) => listeners.set(type, fn)),
    removeEventListener: vi.fn((type: string) => listeners.delete(type)),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
  } as unknown as HTMLElement;
}

describe('HUD情報切替入力', () => {
  beforeEach(() => {
    resetSettings();
    vi.stubGlobal('window', makeWindow());
    vi.stubGlobal('navigator', { getGamepads: () => [null] });
    vi.stubGlobal('performance', { now: () => 0 });
  });

  it('デフォルトキーはVで、X/D/Nの既存割り当てを変更しない', () => {
    expect(DEFAULT_KEY_BINDINGS.hudPanelToggle).toBe('KeyV');
    expect(DEFAULT_KEY_BINDINGS.nextSecondary).toBe('KeyX');
    expect(DEFAULT_KEY_BINDINGS.damageDisplay).toBe('KeyD');
    expect(DEFAULT_KEY_BINDINGS.navMap).toBe('KeyN');
  });

  it('Vのkeydownを1回だけアクション化し、押しっぱなしのrepeatは無視する', () => {
    const win = window as unknown as ReturnType<typeof makeWindow>;
    const input = new InputManager(makeElement());
    const event = { code: 'KeyV', repeat: false, altKey: false, ctrlKey: false, preventDefault: vi.fn() };
    win.dispatch('keydown', event);
    expect(input.consumeActions()).toContain('hudPanelToggle');
    expect(event.preventDefault).toHaveBeenCalled();

    win.dispatch('keydown', { ...event, repeat: true });
    expect(input.consumeActions()).toHaveLength(0);
  });
});
