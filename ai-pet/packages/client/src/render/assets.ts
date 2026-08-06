/**
 * テクスチャの読み込み。
 *
 * 本番アセットは `assets/atlas/*.json`（docs 08章）になる予定だが、
 * それが出来るまでは `tools/placeholder.ts` が吐く1枚PNG群を読む。
 * 差し替え時に触るのはこのファイルだけで済むようにしておく。
 */
import { Assets, Texture } from 'pixi.js';
import { TERRAINS, type Terrain } from '@ai-pet/shared';
import { DIRS, charPrefixes } from '../state/species.ts';
import type { TerrainTextures } from './tilemap.ts';
import { CharTextureSet } from './sprites.ts';

const BASE = '/assets/placeholder';

export interface LoadedTextures {
  terrain: TerrainTextures;
  chars: CharTextureSet;
}

/** ドット絵をぼかさない */
function nearest(tex: Texture): Texture {
  tex.source.scaleMode = 'nearest';
  return tex;
}

export async function loadTextures(): Promise<LoadedTextures> {
  const urls: string[] = [];
  for (const t of TERRAINS) urls.push(`${BASE}/tile_${t}.png`);
  for (const p of charPrefixes()) for (const d of DIRS) urls.push(`${BASE}/${p}_${d}.png`);

  const loaded = (await Assets.load(urls)) as Record<string, Texture>;

  const terrain = {} as TerrainTextures;
  for (const t of TERRAINS) {
    const tex = loaded[`${BASE}/tile_${t}.png`];
    terrain[t as Terrain] = tex ? nearest(tex) : Texture.WHITE;
  }

  const entries: [string, Texture][] = [];
  for (const p of charPrefixes()) {
    for (const d of DIRS) {
      const tex = loaded[`${BASE}/${p}_${d}.png`];
      if (tex) entries.push([`${p}_${d}`, nearest(tex)]);
    }
  }
  return { terrain, chars: new CharTextureSet(entries, Texture.WHITE) };
}
