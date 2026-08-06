import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_KEY_BINDINGS,
  DEFAULT_SETTINGS,
  loadSettings,
  resetSettings,
  settings,
  updateSettings,
} from '../src/app/settings';

describe('settings', () => {
  const storage = new Map<string, string>();
  const localStorageMock = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  };

  beforeEach(() => {
    vi.stubGlobal('localStorage', localStorageMock);
    storage.clear();
    resetSettings();
    storage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('部分保存を既定値から読み込み、不正な操作・アクセシビリティ値を正規化する', () => {
    updateSettings({ keyBindings: { ...settings.keyBindings, targetNext: 'KeyK' } });
    storage.set(
      'multi-commander.settings.v1',
      JSON.stringify({
        mouseSensitivity: 99,
        gamepadDeadzone: -1,
        gamepadSensitivity: Number.NaN,
        subtitleScale: 99,
        reducedFlashes: 'yes',
        colorblindMode: 1,
        difficulty: 'unknown',
        flightMode: 'unknown',
        keyBindings: { pitchUp: 'KeyW' },
      }),
    );

    loadSettings();

    expect(settings.mouseSensitivity).toBe(2.5);
    expect(settings.gamepadDeadzone).toBe(0);
    expect(settings.gamepadSensitivity).toBe(1);
    expect(settings.subtitleScale).toBe(1.8);
    expect(settings.reducedFlashes).toBe(false);
    expect(settings.colorblindMode).toBe(false);
    expect(settings.difficulty).toBe(DEFAULT_SETTINGS.difficulty);
    expect(settings.flightMode).toBe(DEFAULT_SETTINGS.flightMode);
    expect(settings.keyBindings.pitchUp).toBe('KeyW');
    expect(settings.keyBindings.targetNext).toBe(DEFAULT_KEY_BINDINGS.targetNext);
  });

  it('更新APIでも不正値と部分的なキー割り当てを安全に扱う', () => {
    updateSettings({
      gamepadDeadzone: 2,
      subtitleScale: Number.NaN,
      reducedFlashes: 'yes' as unknown as boolean,
      keyBindings: { pitchUp: 'KeyW' } as typeof settings.keyBindings,
    });

    expect(settings.gamepadDeadzone).toBe(0.4);
    expect(settings.subtitleScale).toBe(1);
    expect(settings.reducedFlashes).toBe(false);
    expect(settings.keyBindings.pitchUp).toBe('KeyW');
    expect(settings.keyBindings.yawLeft).toBe(DEFAULT_KEY_BINDINGS.yawLeft);
  });

  it('リセットでキー割り当てを含む既定値を復元し、既定オブジェクトを汚染しない', () => {
    settings.keyBindings.pitchUp = 'KeyW';
    resetSettings();

    expect(settings.keyBindings).toEqual(DEFAULT_KEY_BINDINGS);
    expect(settings.keyBindings).not.toBe(DEFAULT_KEY_BINDINGS);
    expect(DEFAULT_SETTINGS.keyBindings.pitchUp).toBe(DEFAULT_KEY_BINDINGS.pitchUp);
  });

  it('壊れた保存データは既定値へ戻す', () => {
    updateSettings({ colorblindMode: true, gamepadRumble: false });
    storage.set('multi-commander.settings.v1', '{broken');

    loadSettings();

    expect(settings.colorblindMode).toBe(DEFAULT_SETTINGS.colorblindMode);
    expect(settings.gamepadRumble).toBe(DEFAULT_SETTINGS.gamepadRumble);
  });
});
