/**
 * 夜の光源（F-2）。
 *
 * `LightLayer` 本体は Pixi と DOM が必要なので、
 * ここでは「どれが光るか」「どれだけ光るか」「明滅の係数」を検証する。
 */
import { describe, expect, it } from 'vitest';
import {
  drawGlowCanvas,
  flickerFactor,
  lightSpecFor,
  lightStrengthFor,
} from '../../packages/client/src/render/lights.ts';

describe('lightSpecFor', () => {
  it('ランタン・焚き火・天文台は光る', () => {
    expect(lightSpecFor('lantern')).not.toBeNull();
    expect(lightSpecFor('campfire')).not.toBeNull();
    expect(lightSpecFor('observatory')).not.toBeNull();
  });

  it('家は接頭辞でまとめて拾う（アセット名が増えても書き換え不要）', () => {
    const a = lightSpecFor('house_a');
    expect(a).not.toBeNull();
    expect(lightSpecFor('house_b')).toBe(a);
    expect(lightSpecFor('house')).toBe(a);
  });

  it('光らないものは null（ベンチ・看板・花壇・木）', () => {
    expect(lightSpecFor('bench')).toBeNull();
    expect(lightSpecFor('signboard')).toBeNull();
    expect(lightSpecFor('flowerbed')).toBeNull();
    expect(lightSpecFor('berry_tree')).toBeNull();
  });

  it('未知の種類でも落ちない（アセットが無い設置物が来ても無視するだけ）', () => {
    expect(lightSpecFor('')).toBeNull();
    expect(lightSpecFor('mystery_thing')).toBeNull();
  });

  it('焚き火はランタンより広くて激しく揺れる', () => {
    const fire = lightSpecFor('campfire');
    const lamp = lightSpecFor('lantern');
    expect(fire?.radius ?? 0).toBeGreaterThan(lamp?.radius ?? 0);
    expect(fire?.flicker ?? 0).toBeGreaterThan(lamp?.flicker ?? 0);
  });

  it('灯りの色はスタイルガイドの #ffcf7a', () => {
    expect(lightSpecFor('lantern')?.color).toBe(0xffcf7a);
  });
});

describe('lightStrengthFor', () => {
  it('夜が最大、夕は途中、昼は0（昼は1枚も描かない）', () => {
    expect(lightStrengthFor('night')).toBe(1);
    expect(lightStrengthFor('evening')).toBeGreaterThan(0);
    expect(lightStrengthFor('evening')).toBeLessThan(1);
    expect(lightStrengthFor('day')).toBe(0);
  });

  it('未知の時間帯は0', () => {
    expect(lightStrengthFor('twilight-zone')).toBe(0);
  });
});

describe('flickerFactor', () => {
  const fire = lightSpecFor('campfire');

  it('prefers-reduced-motion では常に1（動きだけ止め、明るさは変えない）', () => {
    expect(fire).not.toBeNull();
    if (!fire) return;
    for (let t = 0; t < 3; t += 0.37) expect(flickerFactor(fire, 7, t, true)).toBe(1);
  });

  it('揺れ幅は spec.flicker の範囲に収まる', () => {
    if (!fire) return;
    for (let t = 0; t < 10; t += 0.11) {
      const v = flickerFactor(fire, 3, t, false);
      expect(v).toBeGreaterThanOrEqual(1 - fire.flicker - 1e-9);
      expect(v).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  it('光源ごとに位相がずれる（全部が同じ拍で揺れない）', () => {
    if (!fire) return;
    expect(flickerFactor(fire, 1, 1.2, false)).not.toBeCloseTo(flickerFactor(fire, 2, 1.2, false));
  });

  it('揺れない種類（家の窓）は常に1', () => {
    const win = lightSpecFor('house_a');
    if (!win) return;
    expect(win.flicker).toBe(0);
    expect(flickerFactor(win, 5, 2.5, false)).toBe(1);
  });
});

describe('drawGlowCanvas', () => {
  it('2Dコンテキストが取れない環境でも落ちない（SSR・テスト環境）', () => {
    const fake = { width: 0, height: 0, getContext: () => null } as unknown as HTMLCanvasElement;
    expect(() => drawGlowCanvas(fake, 64)).not.toThrow();
    expect(fake.width).toBe(64);
  });
});
