/**
 * render/Renderer.ts — レイヤの束ね（手順書 §7.1 のレイヤ順）
 *
 *   地形 → 覚えている建物の形 → 霧 → 建物・ユニット（Y ソート）→ 投射物
 *   → 戦域の輪 → 選択の範囲矩形
 *
 * DOM に触るのはこのクラスと `ui` 層だけ。各レイヤは `Ctx2D` を受けるだけの純関数 /
 * クラスなので、DOM の無い環境でも単体テストできる（`tests/unit/render.*.test.ts`）。
 *
 * sim は読むだけ（手順書 §3.1）。状態を書き換えない。
 */

import type { PlayerId } from '@/shared/types';
import type { World } from '@/sim/core/world';
import type { Ctx2D } from './ctx';
import { drawFog, drawRememberedBuildings } from './fogLayer';
import { FogCache } from './fogCache';
import { TerrainCache } from './terrainCache';
import { drawFronts } from './frontLayer';
import { MotionBuffer } from './interp';
import type { Camera } from './iso';
import { GOLD } from './palette';
import { PlaceholderSpriteProvider, type SpriteProvider } from './placeholder';
import { SpriteLayer, type SpriteStats } from './spriteLayer';
import { clearField, emptyTerrainStats, type TerrainStats } from './terrainLayer';
import { VisionBuffer } from './vision';

/** 画面に出す範囲選択の矩形（画面座標 px）。 */
export interface DragRect {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

/** 1 フレームの実績。デバッグ表示と性能テストに使う。 */
export interface RenderStats {
  terrain: TerrainStats;
  sprites: SpriteStats;
  /** 描画にかかった時間（ms）。予算は 10ms（手順書 §7.1）。 */
  ms: number;
  /**
   * レイヤ別の内訳（ms）。
   * 「描画が遅い」ときにどのレイヤを直すかを当てずっぽうにしないために取る。
   */
  layers: {
    clear: number;
    terrain: number;
    remembered: number;
    fog: number;
    sprites: number;
    fronts: number;
  };
}

/** `Renderer.draw` の引数。 */
export interface DrawInput {
  readonly world: World;
  readonly viewer: PlayerId;
  /** tick 間補間の係数（acc / 40）。 */
  readonly alpha: number;
  readonly selected: ReadonlySet<number> | null;
  readonly dragRect: DragRect | null;
}

export class Renderer {
  readonly cam: Camera;
  readonly motion: MotionBuffer;
  readonly vision: VisionBuffer;
  readonly sprites: SpriteProvider;
  private readonly spriteLayer: SpriteLayer;
  private readonly ctx: Ctx2D;
  /**
   * 地形のオフスクリーンキャッシュ（手順書 §7.1）。
   * カメラが動かなければ焼き直さず、毎フレームは `drawImage` だけで済む。
   */
  private readonly terrainCache = new TerrainCache();
  /**
   * 霧のマスクキャッシュ。1 マス = 1 px の小さな画像に塗って拡大して重ねる。
   * 視界は 5 tick ごとしか変わらないので、変わったときだけ作り直す。
   */
  private readonly fogCache = new FogCache();
  /** 直近フレームの実績（HUD のデバッグ行が読む）。 */
  last: RenderStats = {
    terrain: emptyTerrainStats(),
    sprites: { sorted: 0, drawn: 0, culled: 0 },
    ms: 0,
    layers: { clear: 0, terrain: 0, remembered: 0, fog: 0, sprites: 0, fronts: 0 },
  };

  constructor(ctx: Ctx2D, world: World, sprites: SpriteProvider = new PlaceholderSpriteProvider()) {
    this.ctx = ctx;
    this.sprites = sprites;
    this.motion = new MotionBuffer(world.entities.capacity);
    this.vision = VisionBuffer.forMap(world.map);
    this.spriteLayer = new SpriteLayer(world.entities.capacity);
    this.cam = {
      cx: world.map.widthTiles / 2,
      cy: world.map.heightTiles / 2,
      zoom: 1,
      viewW: 1280,
      viewH: 720,
    };
  }

  /** ビューポートの px サイズを設定する。 */
  resize(viewW: number, viewH: number): void {
    this.cam.viewW = viewW;
    this.cam.viewH = viewH;
  }

  /** `stepWorld` の**直前**に呼ぶ（tick 間補間の退避。T-M5-03）。 */
  beforeStep(world: World): void {
    this.motion.capture(world);
  }

  /** 視界を必要なら更新する（5 tick ごと。T-M5-05）。 */
  updateVision(world: World, viewer: PlayerId): boolean {
    if (!this.vision.shouldUpdate(world.tick)) return false;
    this.vision.update(world, viewer);
    return true;
  }

  /** 1 フレーム描く。 */
  draw(inp: DrawInput, nowMs: number): RenderStats {
    // **計測の起点は「描画に入った瞬間」**。
    // rAF から渡される `nowMs` はフレームの開始時刻なので、それを起点にすると
    // カメラ更新・stepWorld（最大 5 tick）・視界更新まで含んだ時間を
    // 「描画」として表示してしまう（実際にそうなっていた）。
    // `nowMs` は点滅の位相など「時刻」が必要な描画にだけ使う。
    const t0 = now();
    const ctx = this.ctx;
    const { world: w, viewer } = inp;

    const layers = { clear: 0, terrain: 0, remembered: 0, fog: 0, sprites: 0, fronts: 0 };
    let tl = t0;

    clearField(ctx, this.cam);
    layers.clear = elapsed(tl);
    tl = now();
    const terrain = this.terrainCache.draw(ctx, this.cam, w.map);
    layers.terrain = elapsed(tl);
    tl = now();
    drawRememberedBuildings(ctx, this.cam, w.map, this.vision);
    layers.remembered = elapsed(tl);
    tl = now();
    // キャッシュで貼れなければ（OffscreenCanvas が無い環境など）マス塗りに落ちる。
    const fogStats = this.fogCache.draw(ctx, this.cam, this.vision);
    if (fogStats.blits === 0) drawFog(ctx, this.cam, w.map, this.vision);
    layers.fog = elapsed(tl);
    tl = now();
    const sprites = this.spriteLayer.draw(ctx, {
      world: w,
      cam: this.cam,
      viewer,
      alpha: inp.alpha,
      motion: this.motion,
      sprites: this.sprites,
      vision: this.vision,
      selected: inp.selected,
    });
    layers.sprites = elapsed(tl);
    tl = now();
    drawFronts(ctx, this.cam, w, viewer, nowMs);
    if (inp.dragRect !== null) drawDragRect(ctx, inp.dragRect);
    layers.fronts = elapsed(tl);

    this.last = { terrain, sprites, ms: elapsed(t0), layers };
    return this.last;
  }
}

/** 範囲選択の矩形（`06§2` の左ドラッグ）。 */
export function drawDragRect(ctx: Ctx2D, r: DragRect): void {
  const x = Math.min(r.x0, r.x1);
  const y = Math.min(r.y0, r.y1);
  const w = Math.abs(r.x1 - r.x0);
  const h = Math.abs(r.y1 - r.y0);
  ctx.strokeStyle = GOLD;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 3]);
  ctx.strokeRect(x, y, w, h);
  ctx.setLineDash([]);
}

/** 現在時刻（ms）。`performance` が無い環境（テスト）では 0。 */
function now(): number {
  if (typeof performance === 'undefined') return 0;
  return performance.now();
}

/** 経過 ms。`performance` が無い環境（テスト）では 0 を返す。 */
function elapsed(t0: number): number {
  if (typeof performance === 'undefined') return 0;
  return performance.now() - t0;
}
