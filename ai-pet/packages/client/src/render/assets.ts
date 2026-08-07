/**
 * テクスチャの読み込み。
 *
 * 本番アセット（`/assets/game/`）を優先し、まだ生成できていないものは
 * プレースホルダ（`/assets/placeholder/`）で補う。
 * 生成が進むたびに game/ へファイルを足していけば、コードを触らずに絵が置き換わる。
 *
 * ファイル名の約束（docs 08章 §4）:
 *   tile_<terrain>.png / <prefix>_<dir>.png / obj_<type>.png
 */
import { Assets, Texture } from 'pixi.js';
import { TERRAINS, type Terrain } from '@ai-pet/shared';
import { DIRS, charPrefixes } from '../state/species.ts';
import type { TerrainTextures } from './tilemap.ts';
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

export async function loadTextures(): Promise<LoadedTextures> {
  const names: string[] = [];
  for (const t of TERRAINS) names.push(`tile_${t}.png`);
  for (const p of charPrefixes()) for (const d of DIRS) names.push(`${p}_${d}.png`);
  for (const o of OBJECT_TYPES) names.push(`obj_${o}.png`);

  // 並列に読む（1枚ずつ待つと数十枚で目に見えて遅い）
  const results = await Promise.all(names.map(async (n) => [n, await loadOne(n)] as const));

  const loaded = new Map<string, Texture>();
  let missing = 0;
  for (const [name, r] of results) {
    if (r.tex) loaded.set(name, r.tex);
    if (!r.fromGame) missing++;
  }

  const terrain = {} as TerrainTextures;
  for (const t of TERRAINS) {
    terrain[t as Terrain] = loaded.get(`tile_${t}.png`) ?? Texture.WHITE;
  }

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

  return {
    terrain,
    chars: new CharTextureSet(charEntries, Texture.WHITE),
    objects: new ObjectTextureSet(objEntries, Texture.EMPTY),
    missing,
  };
}
