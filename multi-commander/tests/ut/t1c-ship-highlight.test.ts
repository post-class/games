import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Mesh, type Object3D } from 'three';

/**
 * 縁光シェルと光点は Three.js のシーングラフに触るので、
 * 既定の node 環境で動かすために Canvas / Image の最小スタブを入れる。
 * 検証したいのは「どのオブジェクトが増えるか」「マテリアルが共有されるか」だけで、
 * 実際の描画結果は見ない。
 */
function fakeCanvas(): Record<string, unknown> {
  const ctx = {
    fillStyle: '',
    globalCompositeOperation: '',
    createRadialGradient: () => ({ addColorStop: () => undefined }),
    createLinearGradient: () => ({ addColorStop: () => undefined }),
    fillRect: () => undefined,
    clearRect: () => undefined,
    beginPath: () => undefined,
    arc: () => undefined,
    ellipse: () => undefined,
    fill: () => undefined,
  };
  return { width: 0, height: 0, getContext: () => ctx, style: {} };
}

/** TextureLoader が使う <img> の最小スタブ (画像は読み込まれないままでよい) */
function fakeImage(): Record<string, unknown> {
  return {
    style: {},
    src: '',
    crossOrigin: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
}

beforeAll(() => {
  vi.stubGlobal('document', {
    createElement: (tag: string) => (tag === 'canvas' ? fakeCanvas() : fakeImage()),
    createElementNS: (_ns: string, tag: string) => (tag === 'canvas' ? fakeCanvas() : fakeImage()),
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe('機体メッシュの縁光シェル', () => {
  it('船体のジオメトリを使い回した縁光シェルが 1 枚だけ増える', async () => {
    const { createShipMesh } = await import('../../src/render/MeshFactory');
    const { RIM_MESH_NAME } = await import('../../src/render/ShipVisibility');
    const { HORNET } = await import('../../src/content/ships');

    const obj = createShipMesh(HORNET);
    const rims: Mesh[] = [];
    obj.traverse((o: Object3D) => {
      if (o.name === RIM_MESH_NAME) rims.push(o as Mesh);
    });
    expect(rims).toHaveLength(1);

    // ジオメトリは船体のマージ済みメッシュと同一インスタンス (追加のメモリを取らない)
    const hulls: Mesh[] = [];
    obj.traverse((o: Object3D) => {
      if (o instanceof Mesh && o.name.startsWith('hull')) hulls.push(o);
    });
    expect(hulls.length).toBeGreaterThan(0);
    expect(hulls.some((h) => h.geometry === rims[0].geometry)).toBe(true);
  });

  it('同じ機体定義の 2 機はジオメトリとマテリアルを共有する', async () => {
    const { createShipMesh } = await import('../../src/render/MeshFactory');
    const { HORNET } = await import('../../src/content/ships');
    const a = createShipMesh(HORNET);
    const b = createShipMesh(HORNET);
    const meshesOf = (o: Object3D): Mesh[] => {
      const out: Mesh[] = [];
      o.traverse((c) => {
        if (c instanceof Mesh) out.push(c);
      });
      return out;
    };
    const ma = meshesOf(a);
    const mb = meshesOf(b);
    expect(ma.length).toBe(mb.length);
    for (let i = 0; i < ma.length; i++) {
      expect(ma[i].geometry).toBe(mb[i].geometry);
      expect(ma[i].material).toBe(mb[i].material);
    }
  });
});

describe('距離帯に応じた縁光と光点の切り替え', () => {
  it('距離帯ごとに共有マテリアルへ差し替え、光点は 3km 以上でだけ出る', async () => {
    const { createShipMesh } = await import('../../src/render/MeshFactory');
    const {
      attachVisibilityAids,
      updateVisibilityAids,
      rimMaterial,
      POINT_LIGHT_NAME,
    } = await import('../../src/render/ShipVisibility');
    const { pointSpriteScale, rimShellScale } = await import('../../src/render/Visibility');
    const { HORNET } = await import('../../src/content/ships');

    const obj = createShipMesh(HORNET);
    const aids = attachVisibilityAids(obj);
    expect(aids.rim).toBeDefined();
    expect(obj.getObjectByName(POINT_LIGHT_NAME)).toBe(aids.point);

    // 1km 以下: 塗装が読める帯。縁光は控えめ、光点なし
    expect(updateVisibilityAids(aids, 'hostile', 400)).toBe('detail');
    expect(aids.rim!.material).toBe(rimMaterial('hostile', 'detail'));
    expect(aids.rim!.scale.x).toBeCloseTo(rimShellScale(400), 6);
    expect(aids.point.visible).toBe(false);

    // 1〜3km: 影絵の帯
    expect(updateVisibilityAids(aids, 'hostile', 1622)).toBe('silhouette');
    expect(aids.rim!.material).toBe(rimMaterial('hostile', 'silhouette'));
    expect(aids.point.visible).toBe(false);

    // 3km 以上: 光点で存在を示す
    expect(updateVisibilityAids(aids, 'hostile', 5000)).toBe('point');
    expect(aids.point.visible).toBe(true);
    expect(aids.point.scale.x).toBeCloseTo(pointSpriteScale(5000), 6);

    // 味方は寒色の共有マテリアルへ切り替わる
    updateVisibilityAids(aids, 'friendly', 1500);
    expect(aids.rim!.material).toBe(rimMaterial('friendly', 'silhouette'));
  });

  it('2 機を扱ってもマテリアルは増えない (陣営色 × 距離帯の共有インスタンスのみ)', async () => {
    const { createShipMesh } = await import('../../src/render/MeshFactory');
    const { attachVisibilityAids, updateVisibilityAids } = await import(
      '../../src/render/ShipVisibility'
    );
    const { HORNET } = await import('../../src/content/ships');

    const a = attachVisibilityAids(createShipMesh(HORNET));
    const b = attachVisibilityAids(createShipMesh(HORNET));
    updateVisibilityAids(a, 'hostile', 1500);
    updateVisibilityAids(b, 'hostile', 1500);
    expect(a.rim!.material).toBe(b.rim!.material);

    updateVisibilityAids(a, 'hostile', 4000);
    updateVisibilityAids(b, 'hostile', 4000);
    expect(a.point.material).toBe(b.point.material);
  });
});
