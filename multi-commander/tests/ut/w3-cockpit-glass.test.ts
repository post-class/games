import { describe, expect, it } from 'vitest';
import {
  CAMERA_NEAR,
  CENTER_CLEAR_HALF,
  GLASS,
  GLASS_OPACITY,
  GLASS_OPACITY_MAX,
  cockpitParts,
  intrudesCenterWindow,
  isOpaqueCockpitMaterial,
  nearestDistance,
  opaqueBlockers,
  partNdcArea,
  partNdcBounds,
  type CockpitPart,
  type ViewSpec,
} from '../../src/render/Cockpit';

/**
 * W3 — 風防の側壁・天蓋をガラスにする。
 *
 * ねらいは「開口部の外側に、視界を塞ぐ不透明な大面積が残っていないこと」。
 * ガラス化しても構図の約束（中央 60% を侵さない / near 面より手前に置かない）は
 * 崩れていないことを、既存の t1d と同じ純関数で確認する。
 */

/** 検証する画面比と画角の組み合わせ（16:9 / 21:9 / 4:3 × FOV 70 / 86）。 */
const VIEWS: Array<{ name: string; view: ViewSpec }> = [];
for (const [name, aspect] of [['16:9', 16 / 9], ['21:9', 21 / 9], ['4:3', 4 / 3]] as const) {
  for (const fovDeg of [70, 86]) {
    VIEWS.push({ name: `${name} / FOV ${fovDeg}`, view: { aspect, fovDeg } });
  }
}

const glassParts = (): CockpitPart[] => cockpitParts().filter((p) => p.zone === 'glass');

const describePart = (i: number, p: CockpitPart, view: ViewSpec) => {
  const b = partNdcBounds(p, view);
  return `#${i} ${p.mat} x[${b.minX.toFixed(2)},${b.maxX.toFixed(2)}] y[${b.minY.toFixed(2)},${b.maxY.toFixed(2)}]`;
};

describe('W3 ① 風防のガラスは天蓋1枚 + 側壁2枚', () => {
  it('zone が glass の部品はちょうど 3つで、すべて GLASS マテリアル', () => {
    const glass = glassParts();
    expect(glass).toHaveLength(3);
    expect(glass.map((p) => p.mat)).toEqual([GLASS, GLASS, GLASS]);
  });

  it('天蓋は中央 1枚、側壁は左右対称の 2枚（位置と寸法は W3 で変えていない）', () => {
    const glass = glassParts();
    const canopy = glass.filter((p) => Math.abs(p.pos[0]) < 1e-6);
    const walls = glass.filter((p) => Math.abs(p.pos[0]) > 1e-6);
    expect(canopy).toHaveLength(1);
    expect(canopy[0].pos).toEqual([0, 0.828, -1.07]);
    expect(canopy[0].scale).toEqual([3.7, 0.09, 0.7]);
    expect(walls).toHaveLength(2);
    // 左右対称（x と rot.y が反転しているだけ）
    expect(walls.map((p) => p.pos[0]).sort((a, b) => a - b)).toEqual([-1.455, 1.455]);
    for (const w of walls) {
      expect(w.scale).toEqual([0.12, 2.2, 0.72]);
      expect(Math.abs(w.rot[1])).toBeCloseTo(0.25, 10);
    }
  });

  it('ガラス以外は不透明として扱う（判定の根拠は 1か所）', () => {
    expect(isOpaqueCockpitMaterial(GLASS)).toBe(false);
    expect(isOpaqueCockpitMaterial('frame')).toBe(true);
    expect(isOpaqueCockpitMaterial('frameDark')).toBe(true);
  });

  it('ガラスの濃さの既定値と上限', () => {
    expect(GLASS_OPACITY).toBe(0.1);
    expect(GLASS_OPACITY_MAX).toBe(0.25);
    expect(GLASS_OPACITY).toBeLessThanOrEqual(GLASS_OPACITY_MAX);
  });

  it('骨組みは残っている（柱・桁・縦桟を消していない）', () => {
    const frame = cockpitParts().filter((p) => p.zone === 'frame');
    // 縦桟（マリオン）は左右 3本ずつ = 6本
    const mullions = frame.filter(
      (p) => p.scale[0] === 0.045 && p.scale[1] === 1.9 && p.scale[2] === 0.055,
    );
    expect(mullions).toHaveLength(6);
    expect(frame.filter((p) => p.mat === 'rivet').length).toBeGreaterThan(0);
  });
});

describe('W3 ②③ ガラスも構図の約束を守る', () => {
  it('ガラスは画面中央 60% を侵さない', () => {
    for (const { name, view } of VIEWS) {
      const bad = glassParts()
        .map((p, i) => ({ i, p }))
        .filter(({ p }) => intrudesCenterWindow(p, view, CENTER_CLEAR_HALF));
      expect(bad.map(({ i, p }) => `${name} ${describePart(i, p, view)}`)).toEqual([]);
    }
  });

  it('ガラスは near 面より手前へ出ない（切られて宙に浮いた板に見えるのを防ぐ）', () => {
    for (const p of glassParts()) {
      expect(nearestDistance(p), `${p.mat} が near 面に近すぎる`).toBeGreaterThan(CAMERA_NEAR + 0.15);
    }
  });
});

describe('W3 ④ 視界を塞ぐ不透明な大面積が残っていない', () => {
  it('16:9 / FOV 70 で opaqueBlockers() が空', () => {
    const blockers = opaqueBlockers({ aspect: 16 / 9, fovDeg: 70 });
    expect(blockers.map((p) => p.mat)).toEqual([]);
  });

  it('ガラスを不透明へ戻したら検出できる判定になっている（テストが空振りしていない）', () => {
    const view: ViewSpec = { aspect: 16 / 9, fovDeg: 70 };
    // 天蓋・側壁は画面の 1/4 より遥かに広い。GLASS でなければ必ず blocker になる。
    for (const p of glassParts()) {
      expect(partNdcArea(p, view)).toBeGreaterThan(0.25);
      expect(opaqueBlockers(view, 0.25).includes(p)).toBe(false);
    }
    // 骨組みはいちばん大きいものでも閾値に届かない
    const frameMax = Math.max(
      ...cockpitParts().filter((p) => p.zone === 'frame').map((p) => partNdcArea(p, view)),
    );
    expect(frameMax).toBeLessThan(0.25);
  });

  it('計器盤は除外する（下側を覆うのが役目なので blocker にしない）', () => {
    const view: ViewSpec = { aspect: 16 / 9, fovDeg: 70 };
    // 閾値を極端に下げても dash は出てこない
    expect(opaqueBlockers(view, 0).some((p) => p.zone === 'dash')).toBe(false);
    // 閾値 0 なら骨組みは出る（除外の対象が dash とガラスだけであることの確認）
    expect(opaqueBlockers(view, 0).every((p) => p.zone === 'frame')).toBe(true);
  });
});

describe('W3 ⑤ 画面比と画角を変えても ①〜④ が成立する', () => {
  for (const { name, view } of VIEWS) {
    it(`${name}: ガラス 3枚・中央 60% 非侵入・near 面より奥・blocker なし`, () => {
      const glass = glassParts();
      expect(glass).toHaveLength(3);
      for (const p of glass) {
        expect(p.mat).toBe(GLASS);
        expect(intrudesCenterWindow(p, view, CENTER_CLEAR_HALF)).toBe(false);
        expect(nearestDistance(p)).toBeGreaterThan(CAMERA_NEAR + 0.15);
      }
      expect(opaqueBlockers(view).map((p) => p.mat)).toEqual([]);
    });
  }
});
