import { RepeatWrapping, SRGBColorSpace, TextureLoader, type Texture } from 'three';

/**
 * 生成画像のテクスチャ読み込み。
 *
 * 形状は手続き生成のままで、表面だけ生成画像に任せる。
 * `TextureLoader.load()` は Texture を即座に返し、画像が届いたら中身が入るので、
 * 呼び出し側は非同期を気にせずマテリアルに渡せる。
 *
 * 実体は `public/art/tex/` にあり、`.tmp/prep_art.py` で縮小・変換したもの。
 */

const loader = new TextureLoader();
const cache = new Map<string, Texture>();

export type PlanetTexId =
  | 'planet-gas-amber'
  | 'planet-gas-violet'
  | 'planet-rock'
  | 'planet-ice'
  | 'planet-lava'
  | 'planet-earthlike';

export type NebulaTexId = 'nebula-teal' | 'nebula-crimson' | 'nebula-violet' | 'nebula-dust';

export type RockTexId = 'rock-surface' | 'rock-metallic' | 'rock-ice';

export type TexId = PlanetTexId | NebulaTexId | RockTexId | 'sun-corona' | 'sun-flare';

/** 全惑星テクスチャ (ミッション定義から選ぶ) */
export const PLANET_TEXTURES: PlanetTexId[] = [
  'planet-gas-amber',
  'planet-gas-violet',
  'planet-rock',
  'planet-ice',
  'planet-lava',
  'planet-earthlike',
];

export const NEBULA_TEXTURES: NebulaTexId[] = [
  'nebula-teal',
  'nebula-crimson',
  'nebula-violet',
  'nebula-dust',
];

export const ROCK_TEXTURES: RockTexId[] = ['rock-surface', 'rock-metallic', 'rock-ice'];

export interface TexOptions {
  /** 繰り返して貼るか (タイル素材) */
  repeat?: number;
  /** 色として扱うか (法線・粗さマップなら false) */
  srgb?: boolean;
}

/** 名前からテクスチャを得る。同じ名前は使い回す */
export function texture(id: TexId | string, o: TexOptions = {}): Texture {
  const key = `${id}|${o.repeat ?? 1}`;
  let t = cache.get(key);
  if (t) return t;
  t = loader.load(`${import.meta.env.BASE_URL}art/tex/${id}.jpg`);
  if (o.srgb !== false) t.colorSpace = SRGBColorSpace;
  if (o.repeat && o.repeat !== 1) {
    t.wrapS = RepeatWrapping;
    t.wrapT = RepeatWrapping;
    t.repeat.set(o.repeat, o.repeat);
  }
  cache.set(key, t);
  return t;
}

/**
 * 透過が要るものは WebP で持つ (星雲・太陽・デカール)。
 * アルファ付き PNG は数百KB になるが、WebP なら見た目そのままで 1/5 以下に収まる。
 */
export function textureAlpha(id: TexId | string): Texture {
  const key = `a|${id}`;
  let t = cache.get(key);
  if (t) return t;
  t = loader.load(`${import.meta.env.BASE_URL}art/tex/${id}.webp`);
  t.colorSpace = SRGBColorSpace;
  cache.set(key, t);
  return t;
}

export function disposeTextureCache(): void {
  for (const t of cache.values()) t.dispose();
  cache.clear();
}
