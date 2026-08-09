import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CAMERA_NEAR,
  CENTER_CLEAR_HALF,
  COCKPIT_OPENING,
  DASH_TOP_NDC,
  cockpitParts,
  intrudesCenterWindow,
  nearestDistance,
  partNdcBounds,
  viewCompensation,
  type ViewSpec,
} from '../../src/render/Cockpit';
import { DEFAULT_SETTINGS, loadSettings, resetSettings, settings } from '../../src/app/settings';

/** 検証する画面比。1280×720 と 1366×768 を基準に、4:3 と 21:9 も見る。 */
const VIEWS: Array<{ name: string; view: ViewSpec }> = [
  { name: '1280x720', view: { aspect: 1280 / 720, fovDeg: 70 } },
  { name: '1366x768', view: { aspect: 1366 / 768, fovDeg: 70 } },
  { name: '4:3', view: { aspect: 4 / 3, fovDeg: 70 } },
  { name: '21:9', view: { aspect: 21 / 9, fovDeg: 70 } },
];

describe('コクピット構造物の構図', () => {
  it('開口部は中央60%の矩形より外に取ってある', () => {
    expect(COCKPIT_OPENING.side).toBeGreaterThan(CENTER_CLEAR_HALF);
    expect(COCKPIT_OPENING.top).toBeGreaterThan(CENTER_CLEAR_HALF);
    // 下端 (計器盤の上端) は DOM 計器盤に合わせるので、中央 30% の外に抜ければよい
    expect(COCKPIT_OPENING.bottom).toBeLessThan(-CENTER_CLEAR_HALF / 2);
  });

  const describePart = (i: number, p: { mat: string }, view: ViewSpec) => {
    const b = partNdcBounds(p as never, view);
    return `#${i} ${p.mat} x[${b.minX.toFixed(2)},${b.maxX.toFixed(2)}] y[${b.minY.toFixed(2)},${b.maxY.toFixed(2)}]`;
  };

  for (const { name, view } of VIEWS) {
    it(`${name}: 枠 (天蓋・柱・側壁) は画面中央60%の矩形に入り込まない`, () => {
      const bad = cockpitParts()
        .map((p, i) => ({ i, p }))
        .filter(({ p }) => p.zone === 'frame' && intrudesCenterWindow(p, view, CENTER_CLEAR_HALF));
      expect(bad.map(({ i, p }) => describePart(i, p, view))).toEqual([]);
    });

    it(`${name}: 計器盤は DOM 計器盤の上端より上へ出ない`, () => {
      const bad = cockpitParts()
        .map((p, i) => ({ i, p, b: partNdcBounds(p, view) }))
        .filter(({ p, b }) => p.zone === 'dash' && b.maxY > DASH_TOP_NDC);
      expect(bad.map(({ i, p }) => describePart(i, p, view))).toEqual([]);
    });

    it(`${name}: どの部品も画面中央30%の矩形には絶対に入らない`, () => {
      const bad = cockpitParts()
        .map((p, i) => ({ i, p }))
        .filter(({ p }) => intrudesCenterWindow(p, view, CENTER_CLEAR_HALF / 2));
      expect(bad.map(({ i, p }) => describePart(i, p, view))).toEqual([]);
    });
  }

  it('画角が広がっても (アフターバーナー時の FOV 86 / 16:9) 中央60%の枠は抜けている', () => {
    // FOV が広がると内装は画面中央側へ寄る。基準の 16:9 では最大画角でも枠は侵入しない。
    const view: ViewSpec = { aspect: 16 / 9, fovDeg: 86 };
    for (const p of cockpitParts()) {
      if (p.zone !== 'frame') continue;
      expect(intrudesCenterWindow(p, view), `${p.mat} が中央へ侵入`).toBe(false);
    }
  });

  it('near 面 (0.5) を跨ぐ部品がない — 切られて宙に浮いた棒に見えるのを防ぐ', () => {
    for (const p of cockpitParts()) {
      expect(nearestDistance(p), `${p.mat} が near 面に近すぎる`).toBeGreaterThan(CAMERA_NEAR + 0.15);
    }
  });

  it('マテリアルは決めた種類だけを使う (発光ラインを足さない / ドローコールを増やさない)', () => {
    const used = [...new Set(cockpitParts().map((p) => p.mat))].sort();
    expect(used).toEqual(
      [
        'frame',
        'frameDark',
        'lampA',
        'lampG',
        'lampR',
        'panel',
        'panelArt',
        'panelWear',
        'rivet',
        'screen',
      ].sort(),
    );
    // 光源を無視して原色で光る縁のラインは、開口部の下端に明るい緑の横線として
    // 出てしまったので廃止した。復活させない。
    expect(used).not.toContain('edge');
  });

  it('柱と側壁は無地の板にならないよう帯・リブ・リベットを持つ', () => {
    const view = VIEWS[0].view;
    // 柱の帯の上に載るリベット (画面の左右端寄り)
    const rivets = cockpitParts()
      .filter((p) => p.mat === 'rivet')
      .map((p) => partNdcBounds(p, view));
    expect(rivets.filter((b) => Math.abs(b.minX) > CENTER_CLEAR_HALF).length).toBeGreaterThanOrEqual(16);
    // 側壁のリブ (画面端まで抜けていく明るい桁)
    const ribs = cockpitParts()
      .filter((p) => p.mat === 'frame')
      .map((p) => partNdcBounds(p, view))
      .filter((b) => b.minX > CENTER_CLEAR_HALF && b.maxY - b.minY > 0.8);
    expect(ribs.length).toBeGreaterThanOrEqual(3);
  });

  it('横長画面と広い画角では内装を引き伸ばして構図を保つ', () => {
    expect(viewCompensation({ aspect: 16 / 9, fovDeg: 70 })).toEqual({ sx: 1, sy: 1 });
    // 21:9 は横だけ広げる
    const wide = viewCompensation({ aspect: 21 / 9, fovDeg: 70 });
    expect(wide.sx).toBeCloseTo((21 / 9) / (16 / 9), 5);
    expect(wide.sy).toBe(1);
    // 4:3 は補正しない (枠が外へ逃げて視界が広がる方向なので)
    expect(viewCompensation({ aspect: 4 / 3, fovDeg: 70 })).toEqual({ sx: 1, sy: 1 });
    // 画角が広がったら縦横とも広げる
    const kick = viewCompensation({ aspect: 16 / 9, fovDeg: 86 });
    expect(kick.sy).toBeGreaterThan(1.2);
    expect(kick.sx).toBeCloseTo(kick.sy, 5);
  });

  it('四隅は実際に構造物で塞がれている (黒帯ではなく枠で締める)', () => {
    const view = VIEWS[0].view;
    const bounds = cockpitParts().map((p) => partNdcBounds(p, view));
    // 上: 画面上端まで届く天蓋がある
    expect(bounds.some((b) => b.maxY >= 1 && b.minY < COCKPIT_OPENING.top + 0.12)).toBe(true);
    // 左右: 画面端まで届く側壁がある
    expect(bounds.some((b) => b.maxX >= 1 && b.minX < COCKPIT_OPENING.side + 0.12)).toBe(true);
    expect(bounds.some((b) => b.minX <= -1 && b.maxX > -COCKPIT_OPENING.side - 0.12)).toBe(true);
    // 下: 画面下端まで届く計器盤がある
    expect(bounds.some((b) => b.minY <= -1 && b.maxY > COCKPIT_OPENING.bottom - 0.12)).toBe(true);
  });
});

describe('コクピット表示の既定値', () => {
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

  it('既定でコクピットを表示する', () => {
    expect(DEFAULT_SETTINGS.cockpitDecorations).toBe(true);
    expect(settings.cockpitDecorations).toBe(true);
  });

  it('旧セーブ (版なし) の false は既定の true へ移行する', () => {
    storage.set(
      'multi-commander.settings.v1',
      JSON.stringify({ cockpitDecorations: false, volumeMusic: 0.2 }),
    );

    loadSettings();

    expect(settings.cockpitDecorations).toBe(true);
    // 移行はコクピットだけ。他の設定は保存値を保つ
    expect(settings.volumeMusic).toBe(0.2);
  });

  it('移行後に自分で OFF にした設定は次回も OFF のまま', () => {
    storage.set(
      'multi-commander.settings.v1',
      JSON.stringify({ cockpitDecorations: false, settingsVersion: 2 }),
    );

    loadSettings();

    expect(settings.cockpitDecorations).toBe(false);
  });
});
