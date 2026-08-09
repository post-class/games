/**
 * render/terrainTextures.ts — 地形の模様（M17 T-M17-02）
 *
 * ■ なぜ「1 マス 1 枚の絵」ではないのか
 * 盤面は 200×200 = 4 万マスある。1 マス 1 回の `drawImage` は、
 * キャッシュを焼くときでもチャンクあたり数千回になり、初回のカクつきになる。
 *
 * そこで **繰り返し模様（`CanvasPattern`）** にした。今の地形描画は
 * 「タイル種別ごとに菱形を積んで、種別単位で 1 回だけ `fill()`」なので、
 * `fillStyle` を色からパターンに替えるだけで**塗りの回数は変わらない**
 * （タイル種別 8 種 = 最大 8 回の fill）。速さを保ったまま質感が付く。
 *
 * ■ 色は捨てない
 * 生成した模様はそのまま貼ると明るく賑やかで、上に乗る兵と建物が読めなくなる。
 * 模様を敷いた上に **`TILE_COLORS` の色を薄く重ねて**、
 * 元の落ち着いた配色に寄せる（色は `05` の配色の取り決めそのもの）。
 *
 * ■ 無くても動く
 * 読み込みに失敗した種別は `null` のまま。呼び出し側は色で塗る。
 */

import { TILE_COLORS } from './palette';

/**
 * タイル種別 → 模様のファイル名。**`shared/types.ts` の `Tile` の並び**と
 * `TILE_COLORS` の並びに一致させる（ずれると地形の見た目が入れ替わる）。
 */
export const TERRAIN_TEXTURE_NAMES: readonly string[] = [
  'grass',
  'forest',
  'hill',
  'water',
  'shallow',
  'road',
  'rubble',
  'cliff',
];

/**
 * 模様の上に重ねる色の濃さ（0 = 模様そのまま、1 = 色だけ）。
 *
 * 実測でこの値を決めた: 0.42 では生成した模様の明度がそのまま出て、
 * `TILE_COLORS` の落ち着いた配色（`05` の取り決め）が崩れ、
 * 上に乗る兵と建物のシルエットが読みにくくなった。
 * 0.66 だと**配色は元のまま・粒だけ乗る**という狙いの見え方になる。
 */
export const TINT_ALPHA = 0.66;

/** 模様の URL。 */
export function terrainTextureUrl(tile: number): string | null {
  const name = TERRAIN_TEXTURE_NAMES[tile];
  return name === undefined ? null : `assets/terrain/${name}.webp`;
}

/** パターンを作れる面（`CanvasRenderingContext2D` が構造的に適合する）。 */
export interface PatternSource {
  createPattern(image: CanvasImageSource, repetition: string): CanvasPattern | null;
}

/**
 * 地形の模様一式。**読み込みは非同期で、間に合わなければ色で塗る**。
 *
 * ■ 画像を持ち、パターンは面ごとに作る
 * `CanvasPattern` は**作った context に紐づく**。地形は画面本体と、
 * キャッシュのチャンク面（複数枚）の両方に焼くので、1 個のパターンを
 * 共有すると環境によって無視される。
 * ここでは**画像を持って、面ごとにパターンを作って覚える**。
 * 面はプールで使い回されるので、作る回数はチャンク面の枚数ぶんで止まる。
 */
export class TerrainTextures {
  /** タイル種別 → 画像（未読み込み / 失敗は null）。 */
  private readonly images: (CanvasImageSource | null)[] = TERRAIN_TEXTURE_NAMES.map(() => null);
  /** 面 → タイル種別 → パターン。面が捨てられれば一緒に消える。 */
  private readonly perSource = new WeakMap<PatternSource, (CanvasPattern | null)[]>();
  private loaded = 0;

  /** 1 種類でも読めているか（呼び出し側の分岐用）。 */
  ready(): boolean {
    return this.loaded > 0;
  }

  /** 読めた種類数（デバッグ表示・テスト用）。 */
  loadedCount(): number {
    return this.loaded;
  }

  /** 画像を差し込む（読み込み側から呼ぶ）。範囲外の種別は無視する。 */
  setImage(tile: number, image: CanvasImageSource | null): void {
    if (tile < 0 || tile >= this.images.length) return;
    const before = this.images[tile];
    this.images[tile] = image;
    if (before === null && image !== null) this.loaded++;
    else if (before !== null && image === null) this.loaded--;
  }

  /**
   * その面でそのタイル種別を塗るパターン（無ければ null）。
   * 一度作ったら面ごとに覚える（毎フレーム作り直すと無駄）。
   */
  pattern(source: PatternSource | null, tile: number): CanvasPattern | null {
    if (source === null) return null;
    const img = this.images[tile] ?? null;
    if (img === null) return null;
    let cache = this.perSource.get(source);
    if (cache === undefined) {
      cache = TERRAIN_TEXTURE_NAMES.map(() => null);
      this.perSource.set(source, cache);
    }
    const hit = cache[tile];
    if (hit !== null && hit !== undefined) return hit;
    const pat = source.createPattern(img, 'repeat');
    cache[tile] = pat;
    return pat;
  }
}

/**
 * 塗りに使うもの（模様があれば模様、無ければ色）。
 *
 * 模様のときは「模様 → 色を薄く重ねる」の 2 段になるので、
 * 呼び出し側が 2 回塗れるように**両方**返す。
 */
export interface TerrainFill {
  /** 1 段目の塗り。 */
  readonly base: string | CanvasPattern;
  /** 2 段目に重ねる色（模様のときだけ。色で塗ったときは null）。 */
  readonly tint: string | null;
}

/**
 * そのタイル種別をどう塗るか決める。
 * `source` は塗る先の面（そこでパターンを作る）。
 */
export function terrainFill(
  textures: TerrainTextures | null,
  source: PatternSource | null,
  tile: number,
): TerrainFill {
  const color = TILE_COLORS[tile] ?? TILE_COLORS[0]!;
  const pat = textures?.pattern(source, tile) ?? null;
  if (pat === null) return { base: color, tint: null };
  return { base: pat, tint: color };
}

/**
 * 模様を読み込む。**失敗しても投げない**（模様が無くても遊べる）。
 * `source` は `createPattern` を持つ面（本番は 2D コンテキスト）。
 *
 * 戻り値は読めた種類数。
 */
export async function loadTerrainTextures(textures: TerrainTextures): Promise<number> {
  let ok = 0;
  for (let tile = 0; tile < TERRAIN_TEXTURE_NAMES.length; tile++) {
    const url = terrainTextureUrl(tile);
    if (url === null) continue;
    const img = await new Promise<HTMLImageElement | null>((resolve) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => resolve(null);
      el.src = url;
    });
    if (img === null) continue;
    textures.setImage(tile, img);
    ok++;
  }
  return ok;
}
