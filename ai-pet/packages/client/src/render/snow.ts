/**
 * 冬の雪の地面（F-4）
 *
 * 木を雪の絵に差し替えても**地面が緑のまま**だと冬に見えなかった
 * （`SeasonTint` の白かぶせは alpha 0.2 で、4季節を並べても冬だけ弱かった）。
 * 「冬=雪と枯れ木」を満たすには地面に雪が乗っている必要がある。
 *
 * 方針:
 * - **タイルを塗らない。円を重ねて1回だけ塗る。** タイル単位で四角く塗ると
 *   32pxの格子が見えて「壁紙」になる（B-1 のタイルバリエーションで踏んだのと同じ失敗）。
 *   円を少し大きめに・中心をずらして重ね、**1つの path にまとめて1回 `fill`** すれば、
 *   重なっても濃くならず（同じ塗り1回なので）、有機的な雪原になる
 * - 水には積もらせない（海が白くなると岸が読めない）
 * - 位置と大きさは**すべて決定論**（`Math.random` 禁止・AI_CODING.md §3）
 * - **動かない**ので、見えているタイルの整数範囲が変わったときだけ描き直す
 *   （毎フレーム 900 個の円を積み直すのは無駄）
 * - `decal` レイヤ（`ground` の上・`shadow` の下）に置くので、雪はキャラの下に入る
 *
 * 地形は `TileMap` が private に持っているので `WorldState.terrainAt()` から引く（`waves.ts` と同じ）。
 */
import { Container, Graphics } from 'pixi.js';
import { MAP_H, MAP_W, TILE_PX } from '@ai-pet/shared';
import type { Layers } from './stage.ts';
import type { Camera } from './camera.ts';
import type { WorldState } from '../state/world.ts';
import { WATER_INDEX } from './waves.ts';

/**
 * 雪の色と濃さ。
 *
 * ⚠️ **半透明にしてはいけない（実測）。** `alpha 0.82` で試したら
 * **円の輪郭が全部見えて「石けんの泡」になった**。1つの path にまとめて `fill` を1回にしても、
 * Pixi は図形ごとに三角形へ分けるので**重なった部分は2回塗られる**（濃さが変わって縁が出る）。
 * 重ねて有機的な形を作る方式と半透明は両立しないので、不透明にして色でやわらかさを出す。
 * 下の地形は「雪が乗らないタイル」（`BARE_RATIO`）の隙間から見せる。
 */
export const SNOW_COLOR = 0xf3f8fb;
export const SNOW_ALPHA = 1;

/**
 * 雪が乗らない「地面が出ている」場所の割合。0 にすると一面まっ白で地形が読めなくなる。
 *
 * ⚠️ 見え方で2回作り直している（実測）:
 *   0.20 / 1タイル単位 … 抜けが**星形のトゲ**になって32pxの格子に並び、模様に見えた
 *   0.09 / 1タイル単位 … 緑の**紙吹雪**が散っているように見えた
 * どちらも「抜けの形＝まわりの円のすき間」が小さすぎるのが原因だったので、
 * **2×2タイルのブロック単位**で抜くようにした。抜けが1つ64px角になり、
 * 「雪の下から草地がのぞいている」に見える。
 */
export const BARE_RATIO = 0.12;

/** 抜けをまとめる単位（タイル）。1 にすると穴が小さすぎてトゲや紙吹雪に見える */
export const BARE_BLOCK = 2;

/** 円の半径（タイル単位）。0.5 より大きくして隣と重ねる＝格子を消す */
const R_MIN = 0.72;
const R_MAX = 0.95;
/** 中心のずらし幅（タイル単位）。大きいと縞に見えるので控えめに */
const JITTER = 0.22;

/** 1回の積み直しで扱うタイルの上限（安全弁）。1280×720/zoom1 の視界は 40×23=920 タイル */
export const MAX_SNOW_TILES = 1600;

/** 座標から 0..1 を作る（`objects.ts` の `treeHash01` と同じ作り。種だけ変えてある） */
function snowHash01(x: number, y: number, salt: number): number {
  let n = Math.imul(x + 0x1f83 + salt * 0x2545, 0x85ebca6b) ^ Math.imul(y + 0x5bd1, 0xc2b2ae35);
  n = Math.imul(n ^ (n >>> 15), 0x27d4eb2f);
  return ((n ^ (n >>> 13)) >>> 0) / 0x100000000;
}

/** そのタイルに雪が乗るか。抜けは `BARE_BLOCK` 単位のブロックで決める */
export function hasSnowAt(x: number, y: number): boolean {
  const bx = Math.floor(x / BARE_BLOCK);
  const by = Math.floor(y / BARE_BLOCK);
  return snowHash01(bx, by, 0) >= BARE_RATIO;
}

/** 雪の塊1つ（タイル単位。描画側で px に直す） */
export interface SnowBlob {
  cx: number;
  cy: number;
  r: number;
}

/** そのタイルの雪の塊。乗らないタイルは null */
export function snowBlobAt(x: number, y: number): SnowBlob | null {
  if (!hasSnowAt(x, y)) return null;
  const jx = (snowHash01(x, y, 1) - 0.5) * 2 * JITTER;
  const jy = (snowHash01(x, y, 2) - 0.5) * 2 * JITTER;
  const r = R_MIN + snowHash01(x, y, 3) * (R_MAX - R_MIN);
  return { cx: x + 0.5 + jx, cy: y + 0.5 + jy, r };
}

/** 冬だけ雪を出す */
export function isSnowSeason(season: string): boolean {
  return season === 'winter';
}

export class SnowGround {
  private readonly root: Container;
  private readonly g: Graphics;
  private readonly camera: Camera;
  private snowing = false;
  /** 前回積み直したときの「整数タイル範囲＋雪の有無」。同じなら何もしない */
  private key = '';
  private blobCount = 0;

  // 注意: Node の type-stripping で動かすため parameter property は使えない
  constructor(layers: Pick<Layers, 'decal'>, camera: Camera) {
    this.camera = camera;
    this.root = new Container({ label: 'snow' });
    this.root.eventMode = 'none';
    this.g = new Graphics();
    this.root.addChild(this.g);
    layers.decal.addChild(this.root);
  }

  setSeason(season: string): void {
    this.snowing = isSnowSeason(season);
  }

  update(world: WorldState): void {
    if (!this.snowing) {
      if (this.key !== '') {
        this.g.clear();
        this.key = '';
        this.blobCount = 0;
      }
      this.root.visible = false;
      return;
    }
    this.root.visible = true;

    // 1タイル余裕を持たせる（画面の縁で雪が急に切れないように）
    const rect = this.camera.visibleRect(1);
    const x0 = Math.max(0, Math.floor(rect.x0));
    const y0 = Math.max(0, Math.floor(rect.y0));
    const x1 = Math.min(MAP_W - 1, Math.ceil(rect.x1));
    const y1 = Math.min(MAP_H - 1, Math.ceil(rect.y1));
    // 未受信チャンクが届くと地形が変わるので、受信数も鍵に入れる
    const key = `${x0},${y0},${x1},${y1},${world.loadedChunks.size}`;
    if (key === this.key) return;
    this.key = key;

    this.g.clear();
    let n = 0;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const t = world.terrainAt(x, y);
        // 水には積もらせない。未受信（-1）も避ける（あとで水だと分かることがある）
        if (t < 0 || t === WATER_INDEX) continue;
        const b = snowBlobAt(x, y);
        if (!b) continue;
        this.g.circle(b.cx * TILE_PX, b.cy * TILE_PX, b.r * TILE_PX);
        n++;
        if (n >= MAX_SNOW_TILES) break;
      }
      if (n >= MAX_SNOW_TILES) break;
    }
    this.blobCount = n;
    // 塗りは最後に1回だけ（描画は1バッチ）
    if (n > 0) this.g.fill({ color: SNOW_COLOR, alpha: SNOW_ALPHA });
  }

  /** デバッグ表示用: いま積んでいる雪の塊の数 */
  get blobs(): number {
    return this.blobCount;
  }

  destroy(): void {
    this.root.destroy({ children: true });
  }
}
