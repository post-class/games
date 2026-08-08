/**
 * 海のアニメーション（B-4 / docs/03_宣伝用との乖離是正プラン/03_タスク詳細.md）
 *
 * 調査で最大の乖離のひとつが「海がベタ塗りで水面に見えない」だった
 * （`docs/03_宣伝用との乖離是正プラン/images/09_海岸（ベタ塗りの海）.png`）。
 * B-2 で波の帯が入ったタイルに差し替えたが、**静止しているので水に見えない**。
 * ここでは海岸線に沿って白波を寄せて引かせ、岸に明るい縁（浅瀬）を足す。
 *
 * 方針:
 * - `weather.ts` と同じく **1枚の `Graphics` に全部の線をまとめる**。
 *   タイルごとにスプライトを作ると海岸線ぶんで数百スプライトになり、毎フレームのコストになる
 * - 対象は「**水タイルのうち陸に隣接するもの**」だけ。沖まで動かすと画面全体がざわついて
 *   キャラクターが読めなくなる（宣伝資料 `hero.png` の水も、動いて見えるのは岸ぎわだけ）
 * - `stage.ts` の `decal` レイヤに置く。`ground`（焼いた地形）の上・`shadow` の下なので
 *   「地面の上・キャラの下」になる。worldRoot の子なのでカメラに自動で追従する
 * - 位置は**すべて決定論的**（`Math.random` / `Date.now` を使わない）。
 *   位相は「海岸線に沿ったワールドpx座標」から作るので、隣のタイルと線が繋がる
 * - `prefers-reduced-motion` では時間を進めない（波の形は残る）
 * - スマホは本数を1/3にする（`weather.ts` の `isMobile()` と同じ方針）
 * - 画面外は描かない（`camera.visibleRect()`）
 *
 * 地形は `TileMap` が private に持っているので、`WorldState.terrainAt()` から引く（読むだけ）。
 */
import { Container, Graphics } from 'pixi.js';
import { MAP_H, MAP_W, TERRAINS, TILE_PX } from '@ai-pet/shared';
import type { Layers } from './stage.ts';
import type { Camera } from './camera.ts';
import type { WorldState } from '../state/world.ts';

const TAU = Math.PI * 2;

/** `terrain` 配列に入っている水の index。TERRAINS の並びに追従させる（数値を直書きしない） */
export const WATER_INDEX = TERRAINS.indexOf('water');

/** 隣接ビット。`tilemap.ts` の EDGE_* と同じ並びにしてある（読む人が混乱しないように） */
export const SIDE_N = 1;
export const SIDE_E = 2;
export const SIDE_S = 4;
export const SIDE_W = 8;

/**
 * 1フレームで扱う海岸タイルの上限（PC）。スマホは1/3。
 *
 * 実際の海岸線は 1280×720 / zoom 1.0 の視界で 40〜70 タイルに収まる
 * （視界が 40×23 タイルなので、斜めに横切る海岸線でも最大それくらい）。
 * 200 は「島の内側に池が散っている」ような最悪ケースの安全弁。
 */
export const MAX_COAST_TILES = 200;

/** 1辺を何本の線分で折るか。3本（4点）で「ゆるく波打つ」に見える（2本だと折れ線が目立つ） */
export const WAVE_SEGMENTS = 3;

/** 寄せて引く周期（秒）。2〜3秒の指定の真ん中。2.6秒だと「ゆっくり呼吸する」感じになる */
export const WAVE_PERIOD_SEC = 2.6;

/** 波長（px）。3タイル。短いと細かく震えて水に見えない */
const WAVE_LEN_PX = TILE_PX * 3;
/** 岸から白波までの最短距離（px）。0にすると陸に食い込んで見える */
const CREST_INSET = 3;
/** 寄せ引きの振れ幅（px）。岸から CREST_INSET .. CREST_INSET+CREST_SWING を往復する */
const CREST_SWING = 5;
/** 波の形のゆらぎ（px）と、そのゆらぎの波長（px）。位相をずらして「同じ正弦波」に見せない */
const WOBBLE_PX = 1.5;
const WOBBLE_LEN_PX = TILE_PX * 1.15;

/** 浅瀬の帯（スタイルガイド §浅瀬 `#a9dcea`）。岸に沿った明るい縁 */
const SHALLOW_COLOR = 0xa9dcea;
const SHALLOW_ALPHA = 0.42;
const SHALLOW_WIDTH = 8;
/** 浅瀬は「地形の色」なので動かさない（動かすと岸の形が呼吸して酔う）。固定の食い込み量 */
const SHALLOW_INSET = 4;

/** 白波（手前の主線） */
const CREST_COLOR = 0xffffff;
const CREST_ALPHA = 0.6;
const CREST_WIDTH = 1.8;

/** 引いた波の細線。主線の半周期あと＝主線が引いたところに残る泡 */
const BACK_COLOR = 0xeaf9ff;
const BACK_ALPHA = 0.26;
const BACK_WIDTH = 1.1;
/** 細線は主線より少し沖側に出す（px） */
const BACK_EXTRA_INSET = 3.5;

export interface VisibleRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export type TerrainLookup = (x: number, y: number) => number;

/** 海岸タイル1枚（`mask` は陸に接している辺のビット和） */
export interface CoastTile {
  x: number;
  y: number;
  mask: number;
}

function isWater(t: number): boolean {
  return t === WATER_INDEX;
}

/**
 * そのタイルが「陸に隣接する水タイル」かを判定し、陸に接している辺のビット和を返す。
 * 水でない、または四方すべてが水なら 0。
 *
 * ⚠️ 未受信チャンクは `terrainAt()` が -1 を返す。これを陸とみなすと
 * **チャンクの境界に嘘の白波が1本入る**ので、「同じ地形（＝水）とみなす」側に寄せている
 * （AI_CODING.md §6 の未受信チャンクの方針と同じ）。
 */
export function landMaskAt(terrainAt: TerrainLookup, x: number, y: number): number {
  if (!isWater(terrainAt(x, y))) return 0;
  let mask = 0;
  // -1（未受信）は水扱いなので、`=== 陸` ではなく「水でも未受信でもない」で判定する
  const land = (t: number): boolean => t >= 0 && !isWater(t);
  if (land(terrainAt(x, y - 1))) mask |= SIDE_N;
  if (land(terrainAt(x + 1, y))) mask |= SIDE_E;
  if (land(terrainAt(x, y + 1))) mask |= SIDE_S;
  if (land(terrainAt(x - 1, y))) mask |= SIDE_W;
  return mask;
}

/**
 * 矩形の中の海岸タイルを `out` に (x, y, mask) の三つ組で詰め、**タイル数**を返す。
 *
 * 毎フレーム呼ぶので、配列を作り直さず呼び側の使い回しに書き込む形にしてある
 * （60タイル×3値のオブジェクト生成を120fpsで回すとGCが増える）。
 * 走査は行優先の固定順なので、`limit` で打ち切っても**同じ入力なら同じ結果**になる。
 */
export function collectCoastTiles(
  rect: VisibleRect,
  terrainAt: TerrainLookup,
  limit: number,
  out: number[],
): number {
  const x0 = Math.max(0, Math.floor(rect.x0));
  const y0 = Math.max(0, Math.floor(rect.y0));
  const x1 = Math.min(MAP_W - 1, Math.ceil(rect.x1));
  const y1 = Math.min(MAP_H - 1, Math.ceil(rect.y1));
  let n = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const mask = landMaskAt(terrainAt, x, y);
      if (mask === 0) continue;
      out[n * 3] = x;
      out[n * 3 + 1] = y;
      out[n * 3 + 2] = mask;
      n++;
      if (n >= limit) return n;
    }
  }
  return n;
}

/** `collectCoastTiles` の読みやすい版（テストと将来のデバッグ表示用） */
export function coastTilesIn(
  rect: VisibleRect,
  terrainAt: TerrainLookup,
  limit = MAX_COAST_TILES,
): CoastTile[] {
  const buf: number[] = [];
  const n = collectCoastTiles(rect, terrainAt, limit, buf);
  const tiles: CoastTile[] = [];
  for (let i = 0; i < n; i++) {
    tiles.push({ x: buf[i * 3] as number, y: buf[i * 3 + 1] as number, mask: buf[i * 3 + 2] as number });
  }
  return tiles;
}

/**
 * 岸から水側へどれだけ食い込んだ位置に白波を描くか（px）。
 *
 * `u` は**海岸線に沿ったワールドpx座標**（横向きの辺ならx、縦向きの辺ならy）。
 * タイル内のローカル座標ではなくワールド座標を使うのがミソで、
 * これで隣のタイルと線が段差なく繋がる（タイルごとの位相にすると境界で折れる）。
 *
 * `phase` は線の種類ごとのずらし（主線 0 / 引いた波 π）。
 */
export function foamOffset(u: number, tSec: number, phase = 0): number {
  // 時間で進み、u で戻る＝波が岸に沿って流れていく
  const swell = Math.sin((tSec / WAVE_PERIOD_SEC) * TAU - (u / WAVE_LEN_PX) * TAU + phase);
  const wobble = Math.sin((u / WOBBLE_LEN_PX) * TAU + phase * 1.7);
  // 0.5+0.5*swell にして常に正にする（負にすると陸へ食い込む）
  return CREST_INSET + CREST_SWING * (0.5 + 0.5 * swell) + WOBBLE_PX * wobble;
}

/**
 * 浅瀬の帯の食い込み量（px）。**時間を含めない**。
 * 岸の明るい縁は「地形の色」なので、動かすと岸の形そのものが呼吸して酔う。
 */
export function shallowOffset(u: number): number {
  return SHALLOW_INSET + WOBBLE_PX * Math.sin((u / WOBBLE_LEN_PX) * TAU);
}

/**
 * 経過時間を進める。`reduced` のときは進めない（波の形はそのまま残る）。
 * 純粋関数にしてあるのは「reduced で時間が止まる」をテストで固定したいため。
 */
export function advanceWaveTime(t: number, dtSec: number, reduced: boolean): number {
  if (reduced) return t;
  // 周期で折り返して数値を小さく保つ（何時間も開いていると sin の精度が落ちる）
  return (t + dtSec) % WAVE_PERIOD_SEC;
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function isMobile(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;
}

/**
 * 辺の向き。`along` は辺に沿った単位ベクトル、`inward` は水側（＝タイルの内側）への単位ベクトル。
 * `n/s` の辺は x に沿い、`e/w` の辺は y に沿う。
 */
interface SideGeom {
  bit: number;
  ax: number;
  ay: number;
  ix: number;
  iy: number;
  /** 辺の始点（タイル左上からのpxオフセット） */
  sx: number;
  sy: number;
  /** 位相に使う座標が x なら true（横向きの辺） */
  horizontal: boolean;
}

const SIDES: readonly SideGeom[] = [
  { bit: SIDE_N, ax: 1, ay: 0, ix: 0, iy: 1, sx: 0, sy: 0, horizontal: true },
  { bit: SIDE_S, ax: 1, ay: 0, ix: 0, iy: -1, sx: 0, sy: TILE_PX, horizontal: true },
  { bit: SIDE_W, ax: 0, ay: 1, ix: 1, iy: 0, sx: 0, sy: 0, horizontal: false },
  { bit: SIDE_E, ax: 0, ay: 1, ix: -1, iy: 0, sx: TILE_PX, sy: 0, horizontal: false },
];

export class WaveLayer {
  private root: Container;
  /** 浅瀬・白波・引いた波をすべてここに描く（stroke を3回呼ぶだけで描画は1オブジェクト） */
  private g: Graphics;
  private camera: Camera;
  private t = 0;
  private reduced = prefersReducedMotion();
  private maxTiles = isMobile() ? Math.round(MAX_COAST_TILES / 3) : MAX_COAST_TILES;
  private segments = isMobile() ? 2 : WAVE_SEGMENTS;
  /** 使い回すバッファ（毎フレームの配列生成を避ける） */
  private buf: number[] = [];
  private tileCount = 0;
  private lineCount = 0;

  // 注意: Node の type-stripping で動かすため parameter property は使えない
  constructor(layers: Pick<Layers, 'decal'>, camera: Camera) {
    this.camera = camera;
    this.root = new Container({ label: 'waves' });
    this.root.eventMode = 'none';
    this.g = new Graphics();
    this.root.addChild(this.g);
    layers.decal.addChild(this.root);
  }

  update(world: WorldState, dtSec: number): void {
    this.t = advanceWaveTime(this.t, dtSec, this.reduced);

    // 1タイルぶん余裕を持たせる（画面の縁で線が急に切れないように）
    const rect = this.camera.visibleRect(1);
    const n = collectCoastTiles(rect, (x, y) => world.terrainAt(x, y), this.maxTiles, this.buf);
    this.tileCount = n;
    this.lineCount = 0;

    this.g.clear();
    if (n === 0) {
      // 海が見えていないときは1本も描かない（島の内陸では丸ごと無コスト）
      this.root.visible = false;
      return;
    }
    this.root.visible = true;

    // 奥（浅瀬の帯）→ 引いた波 → 白波の順に重ねる
    const t = this.t;
    this.pass(n, (u) => shallowOffset(u));
    this.g.stroke({ width: SHALLOW_WIDTH, color: SHALLOW_COLOR, alpha: SHALLOW_ALPHA, cap: 'round' });
    this.pass(n, (u) => foamOffset(u, t, Math.PI) + BACK_EXTRA_INSET);
    this.g.stroke({ width: BACK_WIDTH, color: BACK_COLOR, alpha: BACK_ALPHA, cap: 'round' });
    this.pass(n, (u) => foamOffset(u, t));
    this.g.stroke({ width: CREST_WIDTH, color: CREST_COLOR, alpha: CREST_ALPHA, cap: 'round' });
  }

  /**
   * 海岸線に沿ったポリラインを path に積む（`stroke` は呼び側が1回だけ呼ぶ＝1パス1バッチ）。
   * `offsetOf` は「辺に沿ったワールドpx座標 → 水側への食い込み量(px)」。
   */
  private pass(tiles: number, offsetOf: (u: number) => number): void {
    const seg = this.segments;
    for (let i = 0; i < tiles; i++) {
      const tx = this.buf[i * 3] as number;
      const ty = this.buf[i * 3 + 1] as number;
      const mask = this.buf[i * 3 + 2] as number;
      const px = tx * TILE_PX;
      const py = ty * TILE_PX;
      for (const s of SIDES) {
        if ((mask & s.bit) === 0) continue;
        for (let k = 0; k <= seg; k++) {
          const along = (k / seg) * TILE_PX;
          const bx = px + s.sx + s.ax * along;
          const by = py + s.sy + s.ay * along;
          // 位相は「辺に沿ったワールドpx」から作る＝隣のタイルと繋がる
          const u = s.horizontal ? bx : by;
          const off = offsetOf(u);
          const x = bx + s.ix * off;
          const y = by + s.iy * off;
          if (k === 0) this.g.moveTo(x, y);
          else this.g.lineTo(x, y);
        }
        this.lineCount += seg;
      }
    }
  }

  /** デバッグ表示用: 拾った海岸タイル数 */
  get coastTiles(): number {
    return this.tileCount;
  }

  /** デバッグ表示用: 1フレームで描いた線分の総数（3パスぶんの合計） */
  get lineSegments(): number {
    return this.lineCount;
  }
}
