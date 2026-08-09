/**
 * T-M12-14: 設定画面（`06§12` の全要件。`localStorage` 保存）
 *
 * **アクセシビリティは実装要件であって任意ではない**（手順書 §9.2）ので、
 * 「4 プリセットが全キーを埋めていて衝突が無い」ことを数字で検証する。
 *
 * DOM は触らない（純関数と保存の形だけ）。
 */

import { describe, expect, it } from 'vitest';
import {
  APM_GUIDE,
  COLOR_FREE_CUES,
  KEY_ACTIONS,
  MOUSE_ONLY_CHECKS,
  PRESET_IDS,
  SETTINGS_STORAGE_KEY,
  SETTINGS_VERSION,
  SPEED_MAX,
  SPEED_MIN,
  clampGameSpeed,
  comboFromEvent,
  comboLabel,
  defaultSettings,
  findConflicts,
  loadSettings,
  normalizeSettings,
  presetBindings,
  resolveBindings,
  saveSettings,
  withBinding,
  type PresetId,
  type SettingsStorage,
} from '@/ui/screens/Settings';

/** `localStorage` の代わり（node 環境には localStorage が無い）。 */
function fakeStorage(initial: Record<string, string> = {}): SettingsStorage & {
  data: Record<string, string>;
} {
  const data: Record<string, string> = { ...initial };
  return {
    data,
    getItem: (k) => data[k] ?? null,
    setItem: (k, v) => {
      data[k] = v;
    },
    removeItem: (k) => {
      delete data[k];
    },
  };
}

describe('Settings: プリセット 4 種（`06§12`）', () => {
  it('標準 / WASD / 左手だけ / 他社 RTS 互換 の 4 つ', () => {
    expect(PRESET_IDS).toEqual(['standard', 'wasd', 'oneHand', 'rtsCompat']);
  });

  it('どのプリセットも全操作にキーが割り当たっている（全キー変更可の前提）', () => {
    for (const p of PRESET_IDS) {
      const b = presetBindings(p);
      for (const a of KEY_ACTIONS) {
        expect(b[a.id], `${p} / ${a.id}`).toBeTruthy();
      }
      expect(Object.keys(b)).toHaveLength(KEY_ACTIONS.length);
    }
  });

  it('どのプリセットにもキーの衝突が無い', () => {
    for (const p of PRESET_IDS) {
      expect(findConflicts(presetBindings(p)), `preset ${p}`).toEqual([]);
    }
  });

  it('操作 ID は重複しない', () => {
    const ids = KEY_ACTIONS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('`06§14` の主要キーが標準プリセットに入っている', () => {
    const b = presetBindings('standard');
    expect(b['overview']).toBe('Tab');
    expect(b['front1']).toBe('Digit1');
    expect(b['order1']).toBe('Shift+Digit1');
    expect(b['orderUnique']).toBe('Shift+Digit7');
    expect(b['selectAllCombat']).toBe('Ctrl+KeyA');
    expect(b['score']).toBe('KeyL');
    expect(b['remaining']).toBe('KeyG');
    expect(b['ageCond']).toBe('KeyN');
    expect(b['orderHistory']).toBe('KeyY');
    expect(b['allInfo']).toBe('Alt');
    expect(b['grid1']).toBe('KeyQ');
    expect(b['grid12']).toBe('KeyV');
  });

  it('WASD プリセットはスクロールが WASD になり、グリッドはぶつからない位置へ移る', () => {
    const b = presetBindings('wasd');
    expect(b['scrollUp']).toBe('KeyW');
    expect(b['scrollLeft']).toBe('KeyA');
    expect(b['scrollDown']).toBe('KeyS');
    expect(b['scrollRight']).toBe('KeyD');
    expect(b['grid1']).not.toBe('KeyQ');
    expect(findConflicts(b)).toEqual([]);
  });

  it('左手だけプリセットは右手側のキーを使わない', () => {
    const b = presetBindings('oneHand');
    const rightish = /^(Arrow|F\d|Numpad)|^(Backspace|Enter|Pause|Period|Comma)$|^Key[H-P]$|^Key[UY]$|^Digit[7890]$/;
    for (const a of KEY_ACTIONS) {
      const code = b[a.id]!.split('+').pop()!;
      expect(rightish.test(code), `${a.id} = ${b[a.id]!}`).toBe(false);
    }
  });

  it('左手だけプリセットは 2 回作っても同じ（生成が決定的）', () => {
    expect(presetBindings('oneHand')).toEqual(presetBindings('oneHand'));
  });

  it('他社 RTS 互換は数字キーが部隊グループ', () => {
    const b = presetBindings('rtsCompat');
    expect(b['group1']).toBe('Digit1');
    expect(b['group4']).toBe('Digit4');
    expect(b['front1']).not.toBe('Digit1');
    expect(findConflicts(b)).toEqual([]);
  });
});

describe('Settings: 衝突の検出', () => {
  it('同じキーに 2 つ載っていれば検出する', () => {
    const b = { ...presetBindings('standard'), score: 'KeyG' }; // remaining と同じ
    const c = findConflicts(b);
    expect(c).toHaveLength(1);
    expect(c[0]!.combo).toBe('KeyG');
    expect(c[0]!.actions).toContain('score');
    expect(c[0]!.actions).toContain('remaining');
  });

  it('修飾キーが違えば衝突しない（`A` と `Ctrl`+`A`）', () => {
    expect(findConflicts({ x: 'KeyA', y: 'Ctrl+KeyA' })).toEqual([]);
  });
});

describe('Settings: キーの表示と取り込み', () => {
  it('表示名は人が読める形になる', () => {
    expect(comboLabel('Digit1')).toBe('1');
    expect(comboLabel('Shift+Digit1')).toBe('Shift+1');
    expect(comboLabel('KeyQ')).toBe('Q');
    expect(comboLabel('Ctrl+KeyA')).toBe('Ctrl+A');
    expect(comboLabel('ArrowUp')).toBe('↑');
    expect(comboLabel('')).toBe('未割り当て');
  });

  it('キー入力から割り当てを作る', () => {
    expect(
      comboFromEvent({ code: 'KeyQ', key: 'q', shiftKey: false, ctrlKey: false, metaKey: false, altKey: false }),
    ).toBe('KeyQ');
    expect(
      comboFromEvent({ code: 'Digit1', key: '1', shiftKey: true, ctrlKey: false, metaKey: false, altKey: false }),
    ).toBe('Shift+Digit1');
    expect(
      comboFromEvent({ code: 'KeyA', key: 'a', shiftKey: true, ctrlKey: true, metaKey: false, altKey: false }),
    ).toBe('Ctrl+Shift+KeyA');
  });

  it('修飾キー単独も割り当てられる（`Alt` の情報表示があるため）', () => {
    expect(
      comboFromEvent({ code: 'AltLeft', key: 'Alt', shiftKey: false, ctrlKey: false, metaKey: false, altKey: true }),
    ).toBe('Alt');
  });

  it('Mac の Meta は Ctrl として扱う', () => {
    expect(
      comboFromEvent({ code: 'KeyA', key: 'a', shiftKey: false, ctrlKey: false, metaKey: true, altKey: false }),
    ).toBe('Ctrl+KeyA');
  });
});

describe('Settings: 差分保存', () => {
  it('既定と違う割り当てだけが差分に残る', () => {
    let s = defaultSettings();
    s = withBinding(s, 'score', 'KeyP');
    expect(s.keys).toEqual({ score: 'KeyP' });
    expect(resolveBindings(s)['score']).toBe('KeyP');
    // 既定に戻したら差分から消える（古い既定が焼き付かない）
    s = withBinding(s, 'score', presetBindings('standard')['score']!);
    expect(s.keys).toEqual({});
  });

  it('プリセットを変えると差分の上に新しい既定が乗る', () => {
    let s = defaultSettings();
    s = withBinding(s, 'score', 'KeyP');
    s = { ...s, preset: 'wasd' as PresetId };
    const b = resolveBindings(s);
    expect(b['scrollUp']).toBe('KeyW'); // プリセットの既定
    expect(b['score']).toBe('KeyP'); // 差分が残る
  });
});

describe('Settings: 保存と読み込み（端末に保存。URL には載せない）', () => {
  it('保存したものが読み戻せる', () => {
    const st = fakeStorage();
    const s = { ...defaultSettings(), preset: 'oneHand' as PresetId, gameSpeed: 0.7, peekToggle: true };
    expect(saveSettings(s, st)).toBe(true);
    expect(Object.keys(st.data)).toEqual([SETTINGS_STORAGE_KEY]);
    const back = loadSettings(st);
    expect(back.preset).toBe('oneHand');
    expect(back.gameSpeed).toBe(0.7);
    expect(back.peekToggle).toBe(true);
  });

  it('保存が無ければ既定', () => {
    expect(loadSettings(fakeStorage())).toEqual(defaultSettings());
  });

  it('壊れた JSON でも落ちずに既定に戻る', () => {
    expect(loadSettings(fakeStorage({ [SETTINGS_STORAGE_KEY]: '{oops' }))).toEqual(defaultSettings());
  });

  it('保存できない環境でも例外を投げない', () => {
    const broken: SettingsStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceeded');
      },
      removeItem: () => undefined,
    };
    expect(saveSettings(defaultSettings(), broken)).toBe(false);
    expect(loadSettings(null)).toEqual(defaultSettings());
  });

  it('バージョンが違えばキー割り当てだけ捨てる', () => {
    const raw = { version: SETTINGS_VERSION + 1, preset: 'wasd', keys: { score: 'KeyP' }, gameSpeed: 1.2 };
    const s = normalizeSettings(raw);
    expect(s.version).toBe(SETTINGS_VERSION);
    expect(s.keys).toEqual({});
    expect(s.preset).toBe('wasd');
    expect(s.gameSpeed).toBe(1.2);
  });

  it('知らない操作 ID の割り当ては持ち越さない', () => {
    const s = normalizeSettings({
      version: SETTINGS_VERSION,
      keys: { score: 'KeyP', ghostAction: 'KeyZ' },
    });
    expect(s.keys).toEqual({ score: 'KeyP' });
  });

  it('知らない形の値は既定に戻す', () => {
    const s = normalizeSettings({ preset: 'nope', gameSpeed: 'fast', peekToggle: 'yes' });
    expect(s.preset).toBe('standard');
    expect(s.gameSpeed).toBe(1.0);
    expect(s.peekToggle).toBe(false);
    expect(normalizeSettings(null)).toEqual(defaultSettings());
  });
});

describe('Settings: 速度（`07§14`）', () => {
  it('0.5〜1.5 に丸め、0.1 刻みに合わせる', () => {
    expect(clampGameSpeed(0.1)).toBe(SPEED_MIN);
    expect(clampGameSpeed(9)).toBe(SPEED_MAX);
    expect(clampGameSpeed(1.04)).toBe(1);
    expect(clampGameSpeed(1.26)).toBe(1.3);
    expect(clampGameSpeed(Number.NaN)).toBe(1);
  });

  it('0.1 刻みの浮動小数誤差が表示に出ない', () => {
    for (let v = SPEED_MIN; v <= SPEED_MAX + 1e-9; v += 0.1) {
      const s = clampGameSpeed(v);
      expect(String(s).length).toBeLessThanOrEqual(3);
    }
  });
});

describe('Settings: 長押しを使わない設定 / マウスのみ / 色以外の手がかり / 操作量', () => {
  it('のぞき見と Alt 情報表示の 2 つをトグルにできる', () => {
    const d = defaultSettings();
    expect(d.peekToggle).toBe(false);
    expect(d.altInfoToggle).toBe(false);
    const on = { ...d, peekToggle: true, altInfoToggle: true };
    expect(normalizeSettings(on).peekToggle).toBe(true);
    expect(normalizeSettings(on).altInfoToggle).toBe(true);
  });

  it('マウスのみの代替手段に 6 戦線の運用に要るものが揃っている', () => {
    const all = MOUSE_ONLY_CHECKS.map((c) => c.key).join(' / ');
    expect(all).toContain('1〜6'); // 戦域を選ぶ
    expect(all).toContain('令をセット');
    expect(all).toContain('Tab'); // 俯瞰
    expect(all).toContain('Space'); // 次の警告へ
    for (const c of MOUSE_ONLY_CHECKS) expect(c.mouse.length).toBeGreaterThan(0);
  });

  it('色以外の手がかりに 3 重の警告と旗の形が入っている', () => {
    const joined = COLOR_FREE_CUES.join('\n');
    expect(joined).toContain('旗の形');
    expect(joined).toContain('点滅');
    expect(joined).toContain('音');
    expect(joined).toContain('バッジ');
  });

  it('操作量の目安は 毎分 20〜40 操作 / 約 30 分', () => {
    expect(APM_GUIDE.minApm).toBe(20);
    expect(APM_GUIDE.maxApm).toBe(40);
    expect(APM_GUIDE.matchMinutes).toBe(30);
  });
});
