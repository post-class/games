import { describe, expect, it } from 'vitest';
import {
  FRONTLINE_SYSTEM_IDS,
  frontlineSystemName,
  migrateFrontlineSystemId,
  newFrontlineState,
  normalizeFrontline,
} from '../../src/content/frontline';

/**
 * 旧世界観（McCaffrey / Gimle / Vega 戦役）のセーブを、
 * THE VEIL FRONT の戦域idへ読み替えられることを確認する。
 * 受入基準は「例外を投げず、常に正常な戦況状態が返る」こと。
 */
describe('戦域idの後方互換', () => {
  it('新戦域は5つで、表示名を日本語で引ける', () => {
    expect(FRONTLINE_SYSTEM_IDS).toEqual(['orion-port', 'vega-gate', 'quiet-sea', 'deep-mining-belt', 'hive-veins']);
    expect(FRONTLINE_SYSTEM_IDS.map(frontlineSystemName)).toEqual([
      'オリオン港',
      'ヴェガ門',
      '静穏海',
      '深層採掘帯',
      '巣脈群',
    ]);
  });

  it('初期値は世界観spec §05 の圧力（極高 > 高 > 中 / 不明は中〜高の中間）を写している', () => {
    const s = newFrontlineState().systems;
    expect(s['vega-gate'].pressure).toBe(82); // 極高
    expect(s['orion-port'].pressure).toBe(62); // 高
    expect(s['quiet-sea'].pressure).toBe(44); // 中
    expect(s['deep-mining-belt'].pressure).toBe(44); // 中
    // 不明は中(44)と高(62)の中間
    expect(s['hive-veins'].pressure).toBe(53);
    // control は連邦拠点が最も高く、ニューロウム圏が最も低い
    expect(s['orion-port'].control).toBeGreaterThan(s['vega-gate'].control);
    expect(s['hive-veins'].control).toBeLessThan(s['deep-mining-belt'].control);
  });

  it('旧セーブの戦域名は新戦域へ移行され、値が引き継がれる', () => {
    const legacy = {
      systems: {
        McCaffrey: { control: 61, pressure: 30, logistics: 90 },
        Gimle: { control: 22, pressure: 70, logistics: 12 },
        Vega: { control: 5, pressure: 95, logistics: 40 },
      },
      operations: 7,
      lastSystem: 'Gimle',
      lastKind: 'escort',
    };
    const state = normalizeFrontline(legacy);
    expect(Object.keys(state.systems)).toEqual([...FRONTLINE_SYSTEM_IDS]);
    expect(state.systems['orion-port']).toEqual({ control: 61, pressure: 30, logistics: 90 });
    expect(state.systems['deep-mining-belt']).toEqual({ control: 22, pressure: 70, logistics: 12 });
    expect(state.systems['vega-gate']).toEqual({ control: 5, pressure: 95, logistics: 40 });
    // 旧セーブに無い戦域は既定値のまま残る
    expect(state.systems['quiet-sea']).toEqual(newFrontlineState().systems['quiet-sea']);
    expect(state.systems['hive-veins']).toEqual(newFrontlineState().systems['hive-veins']);
    expect(state.operations).toBe(7);
    expect(state.lastSystem).toBe('deep-mining-belt');
    expect(state.lastKind).toBe('escort');
  });

  it('未知の戦域キー・未知の lastSystem・壊れた値でも例外にならず既定値へ落ちる', () => {
    const broken = {
      systems: {
        Enyo: { control: 10, pressure: 10, logistics: 10 },
        'orion-port': { control: 'abc', pressure: 999, logistics: -50 },
        'quiet-sea': null,
      },
      operations: -3,
      lastSystem: 'Nowhere',
      lastKind: 'dance',
    };
    const state = normalizeFrontline(broken);
    const base = newFrontlineState();
    // 未知キーは無視され、戦域は常に5つ揃う
    expect(Object.keys(state.systems)).toEqual([...FRONTLINE_SYSTEM_IDS]);
    // 数値でない値は既定値、範囲外は 0〜100 へ丸める
    expect(state.systems['orion-port']).toEqual({
      control: base.systems['orion-port'].control,
      pressure: 100,
      logistics: 0,
    });
    expect(state.systems['quiet-sea']).toEqual(base.systems['quiet-sea']);
    expect(state.operations).toBe(0);
    expect(state.lastSystem).toBe(base.lastSystem);
    expect(state.lastKind).toBeUndefined();
  });

  it('セーブ以外の形（null / 配列 / 文字列）を渡しても既定値が返る', () => {
    for (const raw of [null, undefined, 'McCaffrey', 42, []]) {
      expect(() => normalizeFrontline(raw)).not.toThrow();
      expect(Object.keys(normalizeFrontline(raw).systems)).toEqual([...FRONTLINE_SYSTEM_IDS]);
    }
  });

  it('migrateFrontlineSystemId は新id・旧id・未知値を区別する', () => {
    expect(migrateFrontlineSystemId('hive-veins')).toBe('hive-veins');
    expect(migrateFrontlineSystemId('McCaffrey')).toBe('orion-port');
    expect(migrateFrontlineSystemId('Gimle')).toBe('deep-mining-belt');
    expect(migrateFrontlineSystemId('Vega')).toBe('vega-gate');
    // 本編章専用の戦域は動的作戦の対象外なので移行先を持たない
    expect(migrateFrontlineSystemId('notary-relay')).toBeUndefined();
    expect(migrateFrontlineSystemId('ashcrown-corridor')).toBeUndefined();
    expect(migrateFrontlineSystemId(123)).toBeUndefined();
  });
});
