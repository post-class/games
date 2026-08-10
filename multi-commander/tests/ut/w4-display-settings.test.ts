import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COCKPIT_STYLES,
  DEFAULT_SETTINGS,
  loadSettings,
  resetSettings,
  settings,
  type CockpitStyle,
} from '../../src/app/settings';
import { COCKPIT_ZONES, visibleZones, type CockpitZone } from '../../src/render/Cockpit';

/**
 * W4 — 設定の「表示」タブ (コクピットの表示方法とガラスの濃さ)。
 *
 * ① 表示方法 5値 → 出す zone の対応表 (`visibleZones()`)
 * ②③④ 保存データの移行と正規化 (`loadSettings()` 経由。設定モジュールは読むだけ)
 */

/** 保存キー。settings.ts の KEY と同じ (テストからは export されていないので直書き)。 */
const KEY = 'multi-commander.settings.v1';

describe('W4 コクピットの表示方法 (visibleZones)', () => {
  /** 期待する対応表。仕様 (specs/02) の 4-4 をそのまま書き写したもの。 */
  const EXPECTED: Record<CockpitStyle, CockpitZone[]> = {
    full: ['frame', 'glass', 'dash'],
    glass: ['glass', 'dash'],
    frame: ['frame', 'dash'],
    dash: ['dash'],
    off: [],
  };

  it('5値それぞれで出す zone が仕様どおり', () => {
    for (const style of COCKPIT_STYLES) {
      const zones = visibleZones(style);
      expect([...zones].sort(), `style=${style}`).toEqual([...EXPECTED[style]].sort());
    }
  });

  it('計器盤は off 以外では必ず出る / off では何も出ない', () => {
    for (const style of COCKPIT_STYLES) {
      expect(visibleZones(style).has('dash'), `style=${style}`).toBe(style !== 'off');
    }
    expect(visibleZones('off').size).toBe(0);
  });

  it('返す zone は CockpitZone の 3種のみ (グループ名と一致する)', () => {
    for (const style of COCKPIT_STYLES) {
      for (const zone of visibleZones(style)) {
        expect(COCKPIT_ZONES).toContain(zone);
      }
    }
  });

  it('呼び出しごとに独立した Set を返す (呼び出し元が変更しても次回に影響しない)', () => {
    const a = visibleZones('full');
    a.delete('glass');
    expect(visibleZones('full').has('glass')).toBe(true);
  });
});

describe('W4 保存データの移行と正規化', () => {
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

  // ② 版3以前の boolean からの移行
  it('版3で コクピット表示 OFF の保存データは cockpitStyle = dash になる', () => {
    // 旧 OFF でも DOM の計器盤は出ていたので、見え方を引き継ぐのは 'dash' (= 'off' ではない)
    storage.set(KEY, JSON.stringify({ settingsVersion: 3, cockpitDecorations: false }));

    loadSettings();

    expect(settings.cockpitStyle).toBe('dash');
    expect(settings.settingsVersion).toBe(DEFAULT_SETTINGS.settingsVersion);
  });

  it('版3で コクピット表示 ON / 未指定の保存データは cockpitStyle = full になる', () => {
    storage.set(KEY, JSON.stringify({ settingsVersion: 3, cockpitDecorations: true }));
    loadSettings();
    expect(settings.cockpitStyle).toBe('full');

    storage.set(KEY, JSON.stringify({ settingsVersion: 3, volumeMaster: 0.5 }));
    loadSettings();
    expect(settings.cockpitStyle).toBe('full');
  });

  it('版が書かれていない保存データも full へ写す (版1 扱い)', () => {
    storage.set(KEY, JSON.stringify({ mouseSensitivity: 1.2 }));

    loadSettings();

    expect(settings.cockpitStyle).toBe('full');
  });

  // ③ 版4以降の選択は尊重する
  it('版4で自分が選んだ cockpitStyle は移行で上書きされない', () => {
    storage.set(
      KEY,
      JSON.stringify({ settingsVersion: 4, cockpitStyle: 'glass', cockpitDecorations: false }),
    );

    loadSettings();

    // 版4以降は cockpitDecorations を見ない (見ていたら 'dash' に潰れる)
    expect(settings.cockpitStyle).toBe('glass');
  });

  it('版4で選んだ glassOpacity も保持される', () => {
    storage.set(KEY, JSON.stringify({ settingsVersion: 4, cockpitStyle: 'dash', glassOpacity: 0 }));

    loadSettings();

    expect(settings.cockpitStyle).toBe('dash');
    expect(settings.glassOpacity).toBe(0);
  });

  // ④ 不正値の正規化
  it('不正な cockpitStyle は既定へ戻す', () => {
    storage.set(KEY, JSON.stringify({ settingsVersion: 4, cockpitStyle: 'canopy' }));
    loadSettings();
    expect(settings.cockpitStyle).toBe(DEFAULT_SETTINGS.cockpitStyle);

    storage.set(KEY, JSON.stringify({ settingsVersion: 4, cockpitStyle: 3 }));
    loadSettings();
    expect(settings.cockpitStyle).toBe(DEFAULT_SETTINGS.cockpitStyle);
  });

  it('範囲外・非数の glassOpacity は 0..1 へ丸める', () => {
    const cases: Array<[unknown, number]> = [
      [5, 1],
      [-1, 0],
      ['dark', DEFAULT_SETTINGS.glassOpacity],
      [null, DEFAULT_SETTINGS.glassOpacity],
      [0.7, 0.7],
    ];
    for (const [raw, expected] of cases) {
      storage.set(KEY, JSON.stringify({ settingsVersion: 4, glassOpacity: raw }));
      loadSettings();
      expect(settings.glassOpacity, `glassOpacity=${String(raw)}`).toBe(expected);
    }
  });

  it('既定値は 5値の1つで、実効の濃さが GLASS_OPACITY の既定と一致する', () => {
    expect(COCKPIT_STYLES).toContain(DEFAULT_SETTINGS.cockpitStyle);
    expect(DEFAULT_SETTINGS.cockpitStyle).toBe('full');
    // 0.4 × GLASS_OPACITY_MAX(0.25) = 0.1 = GLASS_OPACITY
    expect(DEFAULT_SETTINGS.glassOpacity).toBe(0.4);
  });
});
