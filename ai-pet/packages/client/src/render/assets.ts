/**
 * テクスチャの読み込み。
 *
 * 本番アセット（`/assets/game/`）を優先し、まだ生成できていないものは
 * プレースホルダ（`/assets/placeholder/`）で補う。
 * 生成が進むたびに game/ へファイルを足していけば、コードを触らずに絵が置き換わる。
 *
 * ファイル名の約束（docs 08章 §4）:
 *   tile_<terrain>.png / <prefix>_<dir>.png / obj_<type>.png
 *
 * 追加分（B-1 / B-2）:
 *   tile_<terrain>_<0..3>.png       バリエーション。**無いものは tile_<terrain>.png に落ちる**
 *   edge_<from>_<to>_<mask>.png     遷移タイル（mask=1..15）。無ければ遷移を描かない
 * どちらも「無くても動く」扱いなので、生成が済んだものから順に置いていける。
 */
import { Assets, Texture } from 'pixi.js';
import { TERRAINS, type Terrain } from '@ai-pet/shared';
import { DIRS, charPrefixes } from '../state/species.ts';
import { EDGE_MASK_MAX, EDGE_PAIRS, TILE_VARIANTS, edgeKey, type TerrainTextures } from './tilemap.ts';
import { CharTextureSet } from './sprites.ts';
import { ObjectTextureSet } from './objects.ts';

const GAME = '/assets/game';
const PLACEHOLDER = '/assets/placeholder';

/** 資源・設置物の種別（サーバの型に対応） */
const OBJECT_TYPES = [
  'berry_tree',
  'field',
  'bench',
  'flowerbed',
  'lantern',
  'signboard',
  'well',
  'bridge',
] as const;

export interface LoadedTextures {
  terrain: TerrainTextures;
  chars: CharTextureSet;
  objects: ObjectTextureSet;
  /** 本番アセットが無くてプレースホルダで代用した数（デバッグ表示用） */
  missing: number;
  /** 任意アセット（バリエーション・遷移タイル）のうち実際に見つかった数 */
  optional: number;
}

/** ドット絵をぼかさない */
function nearest(tex: Texture): Texture {
  tex.source.scaleMode = 'nearest';
  return tex;
}

/**
 * 1枚読む。本番アセットが無ければプレースホルダに落ちる。
 *
 * `Assets.load` は404で例外を投げるので1枚ずつ受け止める。
 * まとめて読むほうが速いが、「無い1枚のせいで全部落ちる」ほうが痛い。
 */
async function loadOne(name: string): Promise<{ tex: Texture | null; fromGame: boolean }> {
  try {
    const tex = (await Assets.load(`${GAME}/${name}`)) as Texture;
    return { tex: nearest(tex), fromGame: true };
  } catch {
    try {
      const tex = (await Assets.load(`${PLACEHOLDER}/${name}`)) as Texture;
      return { tex: nearest(tex), fromGame: false };
    } catch {
      return { tex: null, fromGame: false };
    }
  }
}

/**
 * 地形バリエーションのアセット名（B-1）。**必須ではない**。
 * 1枚も無ければ従来どおり `tile_<terrain>.png` だけで描く。
 */
export function terrainVariantNames(): string[] {
  const out: string[] = [];
  for (const t of TERRAINS) for (let v = 0; v < TILE_VARIANTS; v++) out.push(`tile_${t}_${v}.png`);
  return out;
}

/**
 * 遷移タイルのアセット名（B-2）。**必須ではない**。
 * mask=0 は「隣接なし＝描くものが無い」なので作らない（1境界15枚）。
 */
export function edgeTileNames(): string[] {
  const out: string[] = [];
  for (const p of EDGE_PAIRS) {
    for (let m = 1; m <= EDGE_MASK_MAX; m++) out.push(`${edgeKey(p.from, p.to, m)}.png`);
  }
  return out;
}

export async function loadTextures(): Promise<LoadedTextures> {
  const names: string[] = [];
  for (const t of TERRAINS) names.push(`tile_${t}.png`);
  for (const p of charPrefixes()) for (const d of DIRS) names.push(`${p}_${d}.png`);
  for (const o of OBJECT_TYPES) names.push(`obj_${o}.png`);

  // 任意アセットは「無いのが普通」なので missing に数えない（デバッグ表示が無意味に膨らむ）
  const optionalNames = [...terrainVariantNames(), ...edgeTileNames()];

  // 並列に読む（1枚ずつ待つと数十枚で目に見えて遅い）
  const results = await Promise.all(
    [...names, ...optionalNames].map(async (n) => [n, await loadOne(n)] as const),
  );

  const required = new Set(names);
  const loaded = new Map<string, Texture>();
  const fromGame = new Set<string>();
  let missing = 0;
  let optional = 0;
  for (const [name, r] of results) {
    if (r.tex) loaded.set(name, r.tex);
    if (r.tex && r.fromGame) fromGame.add(name);
    if (required.has(name)) {
      if (!r.fromGame) missing++;
    } else if (r.tex) {
      optional++;
    }
  }

  const base = {} as Record<Terrain, Texture>;
  const variants = {} as Record<Terrain, Texture[]>;
  for (const t of TERRAINS) {
    const baseName = `tile_${t}.png`;
    base[t as Terrain] = loaded.get(baseName) ?? Texture.WHITE;
    // バリエーションは**基本タイルと同じ出所のものだけ**採用する。
    // 本番の tile_grass.png が仕上がっているのに、プレースホルダの tile_grass_0..3.png が
    // 全タイルを上書きしてしまう（＝絵が退化する）のを防ぐため。
    const baseFromGame = fromGame.has(baseName);
    const vs: Texture[] = [];
    for (let v = 0; v < TILE_VARIANTS; v++) {
      const name = `tile_${t}_${v}.png`;
      const tex = loaded.get(name);
      if (tex && fromGame.has(name) === baseFromGame) vs.push(tex);
    }
    variants[t as Terrain] = vs;
  }

  // 遷移タイルは出所を問わず採用する（本番の基本タイルにプレースホルダの縁が乗ってもよい。
  // 「境界が45度の階段に見える」ほうが目立つので、多少の色ずれは許容する）
  const edges = new Map<string, Texture>();
  for (const p of EDGE_PAIRS) {
    for (let m = 1; m <= EDGE_MASK_MAX; m++) {
      const key = edgeKey(p.from, p.to, m);
      const tex = loaded.get(`${key}.png`);
      if (tex) edges.set(key, tex);
    }
  }
  const terrain: TerrainTextures = { base, variants, edges };

  const charEntries: [string, Texture][] = [];
  for (const p of charPrefixes()) {
    for (const d of DIRS) {
      const tex = loaded.get(`${p}_${d}.png`);
      if (tex) charEntries.push([`${p}_${d}`, tex]);
    }
  }

  const objEntries: [string, Texture][] = [];
  for (const o of OBJECT_TYPES) {
    const tex = loaded.get(`obj_${o}.png`);
    if (tex) objEntries.push([`obj_${o}`, tex]);
  }

  if (missing > 0) console.log(`[assets] プレースホルダで代用: ${missing}枚`);
  console.log(`[assets] バリエーション・遷移タイル: ${optional}/${optionalNames.length}枚`);

  return {
    terrain,
    chars: new CharTextureSet(charEntries, Texture.WHITE),
    objects: new ObjectTextureSet(objEntries, Texture.EMPTY),
    missing,
    optional,
  };
}
