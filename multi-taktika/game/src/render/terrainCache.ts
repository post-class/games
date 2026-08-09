/**
 * render/terrainCache.ts — 地形のオフスクリーンキャッシュ（手順書 §7.1 / T-M18-02）
 *
 * ■ 何が問題だったか
 *   毎フレーム、可視範囲の菱形（1440×900 で 3025 マス）を 8 本の巨大パスに積んで塗っていた。
 *   実測 **11.7ms**（1 フレームの描画予算 10ms の全部を地形 1 枚で食う）。
 *
 * ■ どう直したか: 画面空間を 256 CSS px のチャンクに切ってキャッシュする
 *   「ビューポート + 余白」を 1 枚のキャッシュにする素直な方法もあるが、
 *   カメラが余白を超えるたびに**全面（ビューポート 1 枚ぶん以上）を焼き直す**ので
 *   スクロール中に 10ms 超のひっかかりが周期的に出る。
 *   そこで**ワールド画面座標に固定した 256px 格子**でチャンクに切る:
 *
 *     - 毎フレームやること = 画面を覆う 35 枚前後のチャンクを `drawImage` で貼るだけ
 *     - 焼き直すのは「新しく画面に入ったチャンク」だけ（1 枚 ≒ 90 マス ≒ 0.2ms）
 *     - カメラが止まっていれば **焼き直し 0 枚**（= 地形 0ms 近辺）
 *
 *   チャンクの原点はワールド画面 px の 256 の倍数に固定してあるので、
 *   カメラが動いてもチャンクの中身は変わらない（= 使い回せる）。
 *
 * ■ 継ぎ目が出ない理由
 *   チャンクをまたぐ菱形は**両方のチャンクで丸ごと描く**（面の端で自然に切れる）。
 *   隣り合うチャンクのローカル座標の差はちょうど 256 CSS px = 整数デバイス px なので、
 *   同じ菱形が両側で 1 px もずれずにラスタライズされる。
 *   貼るときの原点も**まとめて 1 回だけデバイス px に丸める**（チャンクごとに丸めない）。
 *   これで隙間も二重線も出ない。
 *
 * ■ 焼き直しの判定（= 地形の変更検出）
 *   1. ズームが変わった / 実ピクセル倍率が変わった → 全部捨てる（格子の意味が変わる）
 *   2. チャンクが未生成 → 焼く
 *   3. **そのチャンクが使うタイル矩形の FNV-1a ハッシュが変わった → 焼く**
 *
 *   3 が「地形が変わった（壁を壊して跡地になった等）」の検出。
 *   `map.tiles` 全体（最大 400×400 = 16 万バイト）を毎フレーム見るのではなく、
 *   **画面に映っているチャンクの範囲だけ**（合計 1 万バイト未満 ≒ 数 µs）を見る。
 *
 *   ● 取りこぼす場合とその影響
 *     - **画面外のチャンクの地形が変わった場合**は、そのフレームでは気付かない。
 *       ただしそのチャンクが画面に入った時点でハッシュを取り直すので、
 *       **画面に映る瞬間には必ず正しい**。見えない場所の古い絵が見えることはない。
 *     - ハッシュ衝突（32bit, 1/4×10⁹）で 1 チャンクが古いまま残る可能性がある。
 *       影響は「跡地の色が更新されないマスが残る」だけで、当たり判定・視界・
 *       通行可否はすべて sim 側の値を見るのでゲーム進行には影響しない。
 *       次にそのチャンクが捨てられて焼き直されれば直る。
 *     - `map.passable`（建物による封鎖）は見ていない。**地形の絵はタイル種別だけで
 *       決まる**（建物・壁は `spriteLayer` が別に描く）ので、見る必要がない。
 *
 * ■ オフスクリーンが無い環境
 *   `SurfaceFactory` が null を返したら（Vitest の node 環境）
 *   従来どおり `drawTerrainTiles` で直接描く。呼び出し側は何も変わらない。
 *
 * sim は読むだけ（手順書 §3.1）。
 */

import { hasTerrain } from '@/sim/core/terrain';
import type { MapState } from '@/sim/core/world';
import type { Ctx2D } from './ctx';
import {
  type Camera,
  type TileBounds,
  tileBoundsForScreenRect,
  tileToWorld,
  worldToTile,
} from './iso';
import { type Surface, type SurfaceFactory, createSurface, devicePixelScale } from './surface';
import { type TerrainStats, drawTerrainTiles, emptyTerrainStats, hashTileRect } from './terrainLayer';

/**
 * チャンク 1 辺の CSS px。
 *
 * 大きすぎると 1 枚の焼き直しが重く（= スクロール中のひっかかり）、
 * 小さすぎるとチャンクをまたぐ菱形の二重描きが増える。
 * 256 なら 1 枚 ≒ 64 マス（境界の菱形を含めて約 90 マス）で、
 * 1440×900 の画面を 7×5 = 35 枚で覆える。
 */
export const CHUNK_CSS_PX = 256;

/** キャッシュしておくチャンク数の余裕（画面を覆う枚数 + これ）。 */
const CHUNK_SLACK = 8;

interface Chunk {
  surface: Surface;
  /** このチャンクが使うタイル矩形（ズームが同じ間は不変なので持っておく）。 */
  bounds: TileBounds;
  /** `hashTileRect(map, bounds)` の値。 */
  hash: number;
  /** LRU 用。最後に画面に出たフレーム番号。 */
  usedAt: number;
  /** 中身が有効か（面の確保に失敗した場合 false）。 */
  ready: boolean;
}

/** 地形キャッシュ。`Renderer` が 1 つ持つ。 */
export class TerrainCache {
  private readonly factory: SurfaceFactory;
  private readonly scaleOf: () => number;
  private readonly chunks = new Map<string, Chunk>();
  /** 使い回すための空き面（チャンクを捨てても面は捨てない）。 */
  private readonly pool: Surface[] = [];
  private zoom = -1;
  private scale = -1;
  private frame = 0;
  /** 面が 1 枚も作れなかった（= キャッシュ不可の環境）。 */
  private unavailable = false;

  constructor(factory: SurfaceFactory = createSurface, scaleOf: () => number = devicePixelScale) {
    this.factory = factory;
    this.scaleOf = scaleOf;
  }

  /** キャッシュが使えるか（テストと報告用）。false なら直接描画に落ちている。 */
  isAvailable(): boolean {
    return !this.unavailable;
  }

  /** 今保持しているチャンク数（テスト用）。 */
  chunkCount(): number {
    return this.chunks.size;
  }

  /** すべて捨てる（ズーム変更・画面倍率変更時）。面はプールへ返す。 */
  private dropAll(): void {
    for (const c of this.chunks.values()) this.pool.push(c.surface);
    this.chunks.clear();
  }

  /**
   * 地形を描く。毎フレーム 1 回呼ぶ。
   *
   * @returns 塗ったタイル数 / fill 回数 / 貼った回数 / 焼き直した枚数
   */
  draw(ctx: Ctx2D, cam: Camera, map: MapState): TerrainStats {
    if (!hasTerrain(map)) return emptyTerrainStats();
    if (this.unavailable) return drawTerrainTiles(ctx, cam, map);

    const scale = this.scaleOf();
    if (cam.zoom !== this.zoom || scale !== this.scale) {
      this.dropAll();
      this.zoom = cam.zoom;
      this.scale = scale;
    }
    this.frame++;

    const stats = emptyTerrainStats();
    const camW = tileToWorld(cam.cx, cam.cy, cam.zoom);
    // 画面左上・右下のワールド画面 px
    const wx0 = camW.sx - cam.viewW / 2;
    const wy0 = camW.sy - cam.viewH / 2;
    const k0 = Math.floor(wx0 / CHUNK_CSS_PX);
    const k1 = Math.floor((wx0 + cam.viewW) / CHUNK_CSS_PX);
    const l0 = Math.floor(wy0 / CHUNK_CSS_PX);
    const l1 = Math.floor((wy0 + cam.viewH) / CHUNK_CSS_PX);

    // 貼る基準位置。**ここで 1 回だけデバイス px に丸める**（継ぎ目対策）。
    const baseX = Math.round((cam.viewW / 2 - camW.sx) * scale) / scale;
    const baseY = Math.round((cam.viewH / 2 - camW.sy) * scale) / scale;

    const need = (k1 - k0 + 1) * (l1 - l0 + 1);
    const limit = need + CHUNK_SLACK;

    ctx.imageSmoothingEnabled = false;
    for (let l = l0; l <= l1; l++) {
      for (let k = k0; k <= k1; k++) {
        const chunk = this.acquire(k, l, map, cam.zoom, scale, stats);
        if (chunk === null) {
          // 面が作れない → 以降は直接描画（この 1 フレームは代替で埋める）
          return drawTerrainTiles(ctx, cam, map);
        }
        if (!chunk.ready) continue;
        ctx.drawImage(
          chunk.surface.image,
          baseX + k * CHUNK_CSS_PX,
          baseY + l * CHUNK_CSS_PX,
          CHUNK_CSS_PX,
          CHUNK_CSS_PX,
        );
        stats.blits++;
      }
    }
    this.evict(limit);
    return stats;
  }

  /** チャンクを取り出す（無ければ焼く / 地形が変わっていれば焼き直す）。 */
  private acquire(
    k: number,
    l: number,
    map: MapState,
    zoom: number,
    scale: number,
    stats: TerrainStats,
  ): Chunk | null {
    const key = `${k},${l}`;
    let chunk = this.chunks.get(key);
    if (chunk === undefined) {
      const surface = this.take(scale);
      if (surface === null) {
        this.unavailable = true;
        return null;
      }
      chunk = {
        surface,
        bounds: chunkTileBounds(k, l, map, zoom),
        hash: -1,
        usedAt: this.frame,
        ready: false,
      };
      this.chunks.set(key, chunk);
    }
    chunk.usedAt = this.frame;
    const hash = hashTileRect(map, chunk.bounds);
    if (chunk.ready && chunk.hash === hash) return chunk;

    this.bake(chunk, k, l, map, zoom, scale, stats);
    chunk.hash = hash;
    chunk.ready = true;
    stats.built++;
    return chunk;
  }

  /** チャンク 1 枚を焼く。 */
  private bake(
    chunk: Chunk,
    k: number,
    l: number,
    map: MapState,
    zoom: number,
    scale: number,
    stats: TerrainStats,
  ): void {
    const sctx = chunk.surface.ctx;
    sctx.setTransform(scale, 0, 0, scale, 0, 0);
    sctx.clearRect(0, 0, CHUNK_CSS_PX, CHUNK_CSS_PX);
    const cam = chunkCamera(k, l, zoom);
    const s = drawTerrainTiles(sctx, cam, map, chunk.bounds);
    stats.tiles += s.tiles;
    stats.fills += s.fills;
  }

  /** 面を確保する（プール優先）。 */
  private take(scale: number): Surface | null {
    const px = Math.round(CHUNK_CSS_PX * scale);
    const reuse = this.pool.pop();
    if (reuse !== undefined && reuse.width === px && reuse.height === px) return reuse;
    return this.factory(px, px);
  }

  /** 上限を超えた分を、最後に使われたのが古い順に捨てる。 */
  private evict(limit: number): void {
    if (this.chunks.size <= limit) return;
    const entries = [...this.chunks.entries()].sort((a, b) => a[1].usedAt - b[1].usedAt);
    let over = this.chunks.size - limit;
    for (const [key, chunk] of entries) {
      if (over <= 0) break;
      if (chunk.usedAt === this.frame) continue; // 今フレーム使ったものは残す
      this.chunks.delete(key);
      this.pool.push(chunk.surface);
      over--;
    }
  }
}

/**
 * チャンク (k, l) を描くための擬似カメラ。
 * `tileToScreen(cam, x, y)` がチャンクローカルの CSS px を返すように中心を逆算する。
 */
export function chunkCamera(k: number, l: number, zoom: number): Camera {
  const t = worldToTile(
    k * CHUNK_CSS_PX + CHUNK_CSS_PX / 2,
    l * CHUNK_CSS_PX + CHUNK_CSS_PX / 2,
    zoom,
  );
  return { cx: t.x, cy: t.y, zoom, viewW: CHUNK_CSS_PX, viewH: CHUNK_CSS_PX };
}

/** チャンク (k, l) に重なるタイル矩形。 */
export function chunkTileBounds(k: number, l: number, map: MapState, zoom: number): TileBounds {
  const cam = chunkCamera(k, l, zoom);
  return tileBoundsForScreenRect(
    cam,
    map.widthTiles,
    map.heightTiles,
    0,
    0,
    CHUNK_CSS_PX,
    CHUNK_CSS_PX,
    1,
  );
}
