/**
 * render/fogCache.ts — 霧のマスク画像（手順書 §7.2「視界バッファをぼかしたマスクを乗算」）
 *
 * ■ 何が問題だったか
 *   毎フレーム、可視範囲の全マスを 2 パス（未探索 / 既知）で菱形として塗っていた。
 *   実測 **10.9ms**。地形と合わせて 22.6ms → 45fps。
 *
 * ■ どう直したか: 1 マス = 1 px の小さな画像を 1 回だけ引き伸ばす
 *   霧は 1 マスにつき 3 状態（未探索 / 既知 / 可視）しか持たない。
 *   ならば**マップと同じ大きさの画素配列**（400×400 でも 16 万 px = 640KB）に
 *   RGBA を書き、それを菱形変換で引き伸ばして `drawImage` 1 回で重ねればよい。
 *
 *     未探索 → 黒 α=255（地形も見えない）
 *     既知   → 黒 α=140（= FOG_KNOWN_ALPHA 0.55）
 *     可視   → α=0
 *
 *   タイル (tx, ty) の菱形は、タイル空間の単位正方形 [tx,tx+1]×[ty,ty+1] の像そのもの
 *   （`tileToWorld` は線形写像）。つまり**画像の 1 px が 1 マスの菱形にちょうど対応する**。
 *   よって `transform` に菱形変換の行列をそのまま渡し、画像を「1 px = 1 単位」で貼れる。
 *
 *   `imageSmoothingEnabled = true` にすると引き伸ばしの補間がそのまま
 *   手順書 §7.2 の「ぼかしたマスク」になる（別途ブラーを掛ける必要がない）。
 *
 * ■ 作り直すのはいつか
 *   視界は `config.vision.updateIntervalTicks`（= 5 tick）ごとにしか変わらない。
 *   `VisionBuffer.updatedAtTick()` が前回と同じなら**画素は 1 つも書き換えない**。
 *   つまりカメラを動かしても霧の再構築は起きず、毎フレームは `drawImage` 1 回だけ。
 *
 * ■ 規則を壊していないこと（`07§7` / 手順書 §7.2）
 *   ここで描くのは「マスの 3 状態」だけ。既知のマスに何があるかは一切見ない。
 *   「既知は最後に見た地形と建物の形だけが見える」は、
 *   地形（キャッシュ済みの絵）→ 覚えている建物の形（`fogLayer.drawRememberedBuildings`）
 *   → **このマスク**の順に重ねることで従来どおり成立する。
 *   ぼかしの影響でマスクの境界が ±0.5 マスにじむが、にじむのは**暗さだけ**で、
 *   敵ユニットの描画可否は `spriteLayer` が `vision.isVisible` をマス単位で見て決める
 *   （= 情報が漏れるのは「地形の暗さ」だけ。囮・視界の仕様には影響しない）。
 *
 * sim は読むだけ（手順書 §3.1）。
 */

import type { Ctx2D } from './ctx';
import { TILE_H, TILE_W, type Camera, tileToScreen } from './iso';
import { FOG_KNOWN_ALPHA } from './palette';
import {
  type ImageDataLike,
  type Surface,
  type SurfaceFactory,
  createSurface,
} from './surface';
import { VisionState } from './vision';

/** 霧の描画実績（テストとデバッグ表示用）。 */
export interface FogCacheStats {
  /** マスクを貼った回数（キャッシュが効いていれば 1）。 */
  blits: number;
  /** マスク画像を作り直した回数（0 = 視界が変わっていない）。 */
  rebuilds: number;
  /** 作り直したときに書いた画素数（= マス数）。 */
  pixels: number;
}

/** 空の実績。 */
export function emptyFogCacheStats(): FogCacheStats {
  return { blits: 0, rebuilds: 0, pixels: 0 };
}

/** `drawFogMask` が読む視界（`VisionBuffer` が構造的に適合する）。 */
export interface FogSource {
  readonly widthTiles: number;
  readonly heightTiles: number;
  /** 生の 3 状態配列（`VisionState`）。長さ = widthTiles × heightTiles。 */
  readonly state: Uint8Array;
  /** 全開放中か（観戦・リプレイ）。true なら霧を描かない。 */
  isRevealed(): boolean;
  /** 最後に視界を更新した tick（-1 = まだ）。これが変わったときだけ作り直す。 */
  updatedAtTick(): number;
}

/** 既知に重ねる黒の α（0..255）。 */
const KNOWN_ALPHA_255 = Math.round(FOG_KNOWN_ALPHA * 255);

export class FogCache {
  private readonly factory: SurfaceFactory;
  private surface: Surface | null = null;
  private image: ImageDataLike | null = null;
  /** 画素を u32 で書くためのビュー（リトルエンディアン前提を避けるため作らない）。 */
  private width = 0;
  private height = 0;
  private builtAtTick = -2;
  private builtRevealed = false;
  private unavailable = false;

  constructor(factory: SurfaceFactory = createSurface) {
    this.factory = factory;
  }

  /** マスクが使えるか（false なら呼び出し側は従来のマス塗りに落ちる）。 */
  isAvailable(): boolean {
    return !this.unavailable;
  }

  /** 最後にマスクを作った tick（テスト用）。 */
  builtTick(): number {
    return this.builtAtTick;
  }

  /**
   * 霧を 1 回の `drawImage` で重ねる。
   *
   * @returns 貼った回数と作り直した回数。**`blits` が 0 のときは何も描けていない**
   *          （= 呼び出し側が代替の描画をする必要がある）。
   */
  draw(ctx: Ctx2D, cam: Camera, vision: FogSource): FogCacheStats {
    const stats = emptyFogCacheStats();
    if (this.unavailable) return stats;
    if (vision.isRevealed()) {
      // 全開放中は霧なし。次に霧へ戻ったときに必ず作り直す。
      this.builtRevealed = true;
      this.builtAtTick = -2;
      stats.blits = 1; // 「描くものが無い」= 代替描画も不要
      return stats;
    }

    const w = vision.widthTiles;
    const h = vision.heightTiles;
    if (w <= 0 || h <= 0) {
      stats.blits = 1;
      return stats;
    }
    if (this.surface === null || this.width !== w || this.height !== h) {
      const surface = this.factory(w, h);
      if (surface === null) {
        this.unavailable = true;
        return stats;
      }
      this.surface = surface;
      this.image = surface.ctx.createImageData(w, h);
      this.width = w;
      this.height = h;
      this.builtAtTick = -2;
    }

    const tick = vision.updatedAtTick();
    if (this.builtAtTick !== tick || this.builtRevealed) {
      stats.pixels = this.rebuild(vision);
      stats.rebuilds = 1;
      this.builtAtTick = tick;
      this.builtRevealed = false;
    }

    // マスクを菱形に引き伸ばして 1 回で重ねる。
    // タイル空間 (x, y) → 画面 px の線形部分:
    //   sx = (x - y) * TW*z/2,  sy = (x + y) * TH*z/2
    // canvas の transform(a,b,c,d,e,f) は x' = a*x + c*y + e / y' = b*x + d*y + f。
    const a = (TILE_W * cam.zoom) / 2;
    const d = (TILE_H * cam.zoom) / 2;
    const origin = tileToScreen(cam, 0, 0);
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.transform(a, d, -a, d, origin.sx, origin.sy);
    ctx.drawImage(this.surface.image, 0, 0, w, h);
    ctx.restore();
    stats.blits = 1;
    return stats;
  }

  /** マスク画像を作り直す。@returns 書いた画素数 */
  private rebuild(vision: FogSource): number {
    const img = this.image;
    const surface = this.surface;
    if (img === null || surface === null) return 0;
    const px = img.data;
    const st = vision.state;
    const n = this.width * this.height;
    for (let i = 0; i < n; i++) {
      const o = i << 2;
      // 色は黒固定。α だけを 3 状態で切り替える。
      px[o] = 0;
      px[o + 1] = 0;
      px[o + 2] = 0;
      const s = st[i];
      px[o + 3] =
        s === VisionState.Visible ? 0 : s === VisionState.Known ? KNOWN_ALPHA_255 : 255;
    }
    surface.ctx.putImageData(img, 0, 0);
    return n;
  }
}
