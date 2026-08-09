/**
 * render/surface.ts — オフスクリーン描画面の薄い抽象（T-M18-02 の土台）
 *
 * 地形キャッシュ（`terrainCache.ts`）と霧キャッシュ（`fogCache.ts`）は
 * どちらも「別のキャンバスに描いてから 1 回 `drawImage` で貼る」形にする。
 * その「別のキャンバス」をここで 1 か所にまとめる理由:
 *
 *  1. `OffscreenCanvas` が無い環境（古い Safari）では `document.createElement('canvas')`
 *     に落とす。呼び出し側にこの分岐を書かせない。
 *  2. **どちらも無い環境（Vitest の node）では `null` を返す**。
 *     キャッシュ層は null を受けたら「キャッシュなしの直接描画」に落ちるので、
 *     DOM の無い単体テストでも同じコードが動く（描画呼び出し回数を数えられる）。
 *  3. テストは `SurfaceFactory` を差し替えて偽の面を注入できる。
 *     これで「カメラが動かなければ地形を描き直さない」ことを DOM 無しで検証できる。
 *
 * sim には触らない。DOM/Web API に触るのはこのファイルと `Renderer` だけ。
 */

import type { Ctx2D } from './ctx';

/**
 * `ImageData` の最小形（本番の `ImageData` が構造的に適合する）。
 * 霧のキャッシュは 1 マス = 1 px の RGBA を直接書くのでこれだけ要る。
 */
export interface ImageDataLike {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
}

/** オフスクリーン面の 2D コンテキスト。`Ctx2D` に画素直書きを足したもの。 */
export interface SurfaceCtx extends Ctx2D {
  createImageData(width: number, height: number): ImageDataLike;
  putImageData(data: ImageDataLike, dx: number, dy: number): void;
}

/** オフスクリーンの描画面 1 枚。 */
export interface Surface {
  /** `drawImage` のコピー元。 */
  readonly image: CanvasImageSource;
  readonly ctx: SurfaceCtx;
  /** 実ピクセルの大きさ（CSS px ではない）。 */
  readonly width: number;
  readonly height: number;
}

/** 面を 1 枚作る。作れなければ null（呼び出し側は直接描画に落ちる）。 */
export type SurfaceFactory = (widthPx: number, heightPx: number) => Surface | null;

/**
 * 既定の面の作り方: `OffscreenCanvas` → `<canvas>` → null。
 *
 * `willReadFrequently` は付けない。地形キャッシュは GPU 側に置いたまま
 * `drawImage` でコピーしたいので、CPU 側へ引き戻す指定は逆効果になる。
 */
export const createSurface: SurfaceFactory = (widthPx, heightPx) => {
  const w = Math.max(1, Math.ceil(widthPx));
  const h = Math.max(1, Math.ceil(heightPx));

  if (typeof OffscreenCanvas === 'function') {
    const c = new OffscreenCanvas(w, h);
    const ctx = c.getContext('2d');
    if (ctx === null) return null;
    return { image: c, ctx: ctx as unknown as SurfaceCtx, width: w, height: h };
  }
  if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    if (ctx === null) return null;
    return { image: c, ctx: ctx as unknown as SurfaceCtx, width: w, height: h };
  }
  return null;
};

/**
 * 実ピクセル倍率（`devicePixelRatio`）。
 *
 * **2 で打ち止めにする**。DPR 3 の端末で地形キャッシュを DPR 3 で持つと
 * 面積が 2.25 倍（= VRAM も 2.25 倍）になるのに、平面色の菱形では差が見えない。
 * `main.ts` は本体キャンバスには本来の DPR を使うので、ここで上限を掛けるのは
 * キャッシュの解像度だけ（貼るときに CSS px へ引き伸ばす）。
 */
export function devicePixelScale(): number {
  const g = globalThis as { devicePixelRatio?: number };
  const d = g.devicePixelRatio;
  if (typeof d !== 'number' || !(d > 0)) return 1;
  return Math.min(2, d);
}
