/**
 * 描画キャッシュが効いていることの検証（手順書 §7.1 / T-M18-02）。
 *
 * ■ なぜこのテストが必要か
 * 実測では 1440×900 / DPR 2 / 28 体で **45fps（描画 22.6ms = 地形 11.7 + 霧 10.9）**
 * だった。毎フレーム全画面をマス単位で塗り直していたためで、
 * 手順書 §7.1 が指定するオフスクリーンキャッシュを入れて **120fps / 0.3ms** になった。
 *
 * ブラウザでの ms は環境に左右されるのでテストでは測らない。代わりに
 * **「焼き直しの回数」** を見る。ここが 0 のままなら「キャッシュが効いている」ことの証拠で、
 * 誰かが不注意にキャッシュを無効化したらこのテストが落ちる。
 */

import { describe, expect, it } from 'vitest';
import { createWorld } from '@/sim/core/world';
import { generateMap, mapSizeForPlayers } from '@/sim/systems/mapgen';
import { TerrainCache } from '@/render/terrainCache';
import { FogCache } from '@/render/fogCache';
import { VisionBuffer } from '@/render/vision';
import type { Camera } from '@/render/iso';
import type { ImageDataLike, Surface, SurfaceCtx, SurfaceFactory } from '@/render/surface';
import type { Ctx2D } from '@/render/ctx';

/** 呼び出し回数だけ数える偽 2D コンテキスト（node には Canvas が無い）。 */
function fakeCtx(): Ctx2D & { calls: Record<string, number> } {
  const calls: Record<string, number> = {};
  const bump = (k: string) => {
    calls[k] = (calls[k] ?? 0) + 1;
  };
  const ctx = {
    calls,
    canvas: { width: 1440, height: 900 },
    save: () => bump('save'),
    restore: () => bump('restore'),
    beginPath: () => bump('beginPath'),
    closePath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    rect: () => {},
    fill: () => bump('fill'),
    fillRect: () => bump('fillRect'),
    stroke: () => bump('stroke'),
    strokeRect: () => {},
    clearRect: () => {},
    drawImage: () => bump('drawImage'),
    setTransform: () => {},
    transform: () => {},
    resetTransform: () => {},
    translate: () => {},
    scale: () => {},
    setLineDash: () => {},
    arc: () => {},
    fillText: () => {},
    measureText: () => ({ width: 0 }),
    createPattern: () => null,
    putImageData: () => bump('putImageData'),
    getImageData: () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
    createImageData: (w: number, h: number) => ({
      data: new Uint8ClampedArray(w * h * 4),
      width: w,
      height: h,
    }),
  } as unknown as Ctx2D & { calls: Record<string, number> };
  return ctx;
}

function makeWorld() {
  const side = mapSizeForPlayers('plain', 2);
  const w = createWorld({
    seed: 4321,
    playerCount: 2,
    mapWidthTiles: side,
    mapHeightTiles: side,
    entityCapacity: 1024,
  });
  generateMap(w, { mapType: 'plain' });
  return w;
}

function makeCam(w: ReturnType<typeof makeWorld>): Camera {
  return { cx: w.map.widthTiles / 2, cy: w.map.heightTiles / 2, zoom: 1, viewW: 1440, viewH: 900 };
}

/**
 * 偽のオフスクリーン面。
 *
 * node には `OffscreenCanvas` も `<canvas>` も無いので、既定の `createSurface` は
 * null を返し**キャッシュ層が丸ごと直接描画に落ちる**。それではキャッシュの挙動が
 * 何も検証できないので、`SurfaceFactory` を差し替えて「面はある」状態を作る。
 * 実際の画素は描かないが、キャッシュの判断（焼く / 貼る / 捨てる）はすべて通る。
 */
function fakeSurfaceFactory(): SurfaceFactory {
  return (wpx, hpx) => {
    const ctx = fakeCtx() as unknown as SurfaceCtx & { calls: Record<string, number> };
    (ctx as unknown as { createImageData: unknown }).createImageData = (
      w: number,
      h: number,
    ): ImageDataLike => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h });
    const surface: Surface = {
      image: {} as CanvasImageSource,
      ctx,
      width: Math.max(1, Math.ceil(wpx)),
      height: Math.max(1, Math.ceil(hpx)),
    };
    return surface;
  };
}

/** 画面倍率（DPR）。テストでは 1 に固定して結果を安定させる。 */
const scaleOne = () => 1;

describe('地形のオフスクリーンキャッシュ', () => {
  it('カメラが動かなければ 2 フレーム目以降は焼き直さない', () => {
    const w = makeWorld();
    const cam = makeCam(w);
    const cache = new TerrainCache(fakeSurfaceFactory(), scaleOne);
    const ctx = fakeCtx();

    const first = cache.draw(ctx, cam, w.map);
    expect(cache.isAvailable()).toBe(true);
    // 1 フレーム目はチャンクを焼く
    expect(first.built).toBeGreaterThan(0);
    expect(first.blits).toBeGreaterThan(0);

    const second = cache.draw(ctx, cam, w.map);
    // 2 フレーム目は貼るだけ（タイルを 1 枚も塗らない）
    expect(second.built).toBe(0);
    expect(second.tiles).toBe(0);
    expect(second.blits).toBeGreaterThan(0);
  });

  it('ズームを変えると焼き直す（見た目が変わるので当然）', () => {
    const w = makeWorld();
    const cam = makeCam(w);
    const cache = new TerrainCache(fakeSurfaceFactory(), scaleOne);
    const ctx = fakeCtx();
    cache.draw(ctx, cam, w.map);
    cam.zoom = 1.5;
    const after = cache.draw(ctx, cam, w.map);
    expect(after.built).toBeGreaterThan(0);
  });

  it('カメラを大きく動かすと新しいチャンクを焼く', () => {
    const w = makeWorld();
    const cam = makeCam(w);
    const cache = new TerrainCache(fakeSurfaceFactory(), scaleOne);
    const ctx = fakeCtx();
    cache.draw(ctx, cam, w.map);
    const stay = cache.draw(ctx, cam, w.map);
    expect(stay.built).toBe(0);
    cam.cx += 40;
    cam.cy += 40;
    const moved = cache.draw(ctx, cam, w.map);
    expect(moved.built).toBeGreaterThan(0);
  });

  it('Canvas が作れない環境ではマス塗りに落ちる（例外にしない）', () => {
    const w = makeWorld();
    const cam = makeCam(w);
    // 面を作れない factory を渡す
    const cache = new TerrainCache(() => null, scaleOne);
    const ctx = fakeCtx();
    const stats = cache.draw(ctx, cam, w.map);
    expect(cache.isAvailable()).toBe(false);
    // 直接描画に落ちているので「塗ったタイル」がある
    expect(stats.tiles).toBeGreaterThan(0);
  });
});

describe('霧のマスクキャッシュ', () => {
  it('視界が変わらなければ作り直さない', () => {
    const w = makeWorld();
    const cam = makeCam(w);
    const vision = VisionBuffer.forMap(w.map);
    vision.update(w, 0);
    const cache = new FogCache(fakeSurfaceFactory());
    const ctx = fakeCtx();

    const first = cache.draw(ctx, cam, vision);
    expect(first.rebuilds).toBe(1);
    expect(first.blits).toBe(1);

    // 視界を更新しないまま 2 回描く → 作り直さない
    const second = cache.draw(ctx, cam, vision);
    expect(second.rebuilds).toBe(0);
    expect(second.blits).toBe(1);
  });

  it('視界が更新されたら作り直す', () => {
    const w = makeWorld();
    const cam = makeCam(w);
    const vision = VisionBuffer.forMap(w.map);
    vision.update(w, 0);
    const cache = new FogCache(fakeSurfaceFactory());
    const ctx = fakeCtx();
    cache.draw(ctx, cam, vision);

    // 視界の更新は 5 tick ごと（config.vision.updateIntervalTicks）
    w.tick += 100;
    vision.update(w, 0);
    const after = cache.draw(ctx, cam, vision);
    expect(after.rebuilds).toBe(1);
  });
});
