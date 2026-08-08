/**
 * 地形描画（docs/02_ゲーム実装プラン/06_クライアント設計.md §2）
 *
 * 128×128タイル＝16384スプライトを毎フレーム描くのは無駄なので、
 * **チャンク（16×16タイル）単位で RenderTexture に一度焼き、Sprite 1枚として置く**。
 * 焼成は「タイル画像を並べて renderer.render() で1枚にする」方式。
 *
 * 未受信チャンクは何も置かない（背景色のまま）。
 *
 * === 見た目の作り（B-1 / B-2 / G-4） ===
 * - B-1: 同じ絵の繰り返しが目に付かないよう、地形ごとに4枚のバリエーションを持てるようにした。
 *   どれを使うかは**タイルの絶対座標のハッシュ**で決める（`Math.random` は使わない＝
 *   同じseedなら同じ島の模様になる。M1の完了条件）
 * - B-2: 境界を45度の階段に見せないため、遷移タイル（autotile）を焼成時に上書きする。
 *   焼いてしまえばランタイムのコストは増えない
 * - G-4: 荒廃度は焼成時の `sprite.tint` で表現する（タイル画像を増やさずに済む）
 */
import { Container, RenderTexture, Sprite, type Renderer, type Texture } from 'pixi.js';
import { CHUNK, TILE_PX, TERRAINS, type Terrain } from '@ai-pet/shared';
import type { Layers } from './stage.ts';

/** 1地形あたりのバリエーション枚数（`tile_<terrain>_<0..3>.png`） */
export const TILE_VARIANTS = 4;

/**
 * 遷移タイルの隣接ビット（上下左右の4bit）。`edge_<from>_<to>_<mask>.png` の mask に対応。
 * 角の4bitまで入れると1境界256枚になるので、まずは4方向だけで作る（16枚/境界）。
 */
export const EDGE_N = 1;
export const EDGE_E = 2;
export const EDGE_S = 4;
export const EDGE_W = 8;
/** mask の最大値（0は「隣接なし＝描くものが無い」ので実素材は 1..15 の15枚） */
export const EDGE_MASK_MAX = 15;

/**
 * 遷移を入れる境界。
 *
 * 向きの約束: **`from` のタイルの上に、`to` 側が寄ってくる縁を描く**。
 * 例）`edge_sand_water_*` は砂タイルの上に波打ち際を描く。
 * 片方向だけで足りるのは、境界の絵が「どちらかの側に1枚重なれば繋がって見える」ため。
 */
export interface EdgePair {
  from: Terrain;
  to: Terrain;
}

export const EDGE_PAIRS: readonly EdgePair[] = [
  { from: 'grass', to: 'sand' },
  { from: 'sand', to: 'water' },
  { from: 'grass', to: 'forest' },
  { from: 'plaza', to: 'grass' },
  // B-6: 実機で一番階段が目立つのはここだった。
  // 広場の外周と島の道は `dirt` なので、上の4境界だけでは広場のまわりに遷移が入らない。
  { from: 'grass', to: 'dirt' },
  { from: 'plaza', to: 'dirt' },
];

/** 遷移タイルのテクスチャを引くキー（アセット名から拡張子を取ったもの） */
export function edgeKey(from: Terrain, to: Terrain, mask: number): string {
  return `edge_${from}_${to}_${mask}`;
}

/** 地形テクスチャ一式 */
export interface TerrainTextures {
  /** `tile_<terrain>.png`。バリエーションが無い地形はこれだけで描く */
  base: Record<Terrain, Texture>;
  /** `tile_<terrain>_<n>.png`。無い地形は空配列（= base に落ちる） */
  variants: Record<Terrain, readonly Texture[]>;
  /** `edge_<from>_<to>_<mask>.png`。キーは edgeKey()。無ければ遷移を描かない */
  edges: ReadonlyMap<string, Texture>;
  /** `decal_<name>.png`。キーは装飾名。無ければ装飾を描かない（B-3） */
  decals: ReadonlyMap<string, Texture>;
}

// ==================== 装飾デカール（B-3） ====================

/**
 * 地面の装飾。
 *
 * 調査で一番効いていた乖離が「**画面の大半が無地の緑**」だった
 * （`docs/03_宣伝用との乖離是正プラン/images/08_無地の平原.png`）。
 * 宣伝資料は同じ面積に草の房・小花・小石が詰まっている。
 *
 * 実装方針:
 * - **チャンクの焼成に1パス足すだけ**にする。専用レイヤにスプライトを並べると
 *   128×128タイルぶんの装飾で数千スプライトになり、毎フレームのコストになる。
 *   焼き込めば受信時の1回で済み、`ground` に入るので接地影より下に来る（順序も正しい）
 * - 置くかどうか・どれを置くか・どこに寄せるかは**すべて座標のハッシュ**で決める（決定論）
 * - 歩行判定には影響させない（見た目だけ。サーバは何も知らない）
 */
export interface DecalSet {
  /** この地形に置く装飾の名前（`decal_<name>.png`） */
  names: readonly string[];
  /** 1タイルに装飾が乗る確率 0..1 */
  density: number;
}

export const DECAL_SETS: Partial<Record<Terrain, DecalSet>> = {
  // 草地はいちばん面積が広いので密に置く
  grass: { names: ['grass_tuft', 'flower_white', 'flower_yellow', 'flower_pink', 'pebble'], density: 0.34 },
  // 森は木の下なので落ち葉ときのこ
  forest: { names: ['leaf', 'mushroom', 'grass_tuft'], density: 0.3 },
  // 土は踏み固められた場所。小石だけ疎に
  dirt: { names: ['pebble'], density: 0.1 },
  // 砂浜は貝と小石を疎に
  sand: { names: ['pebble', 'shell'], density: 0.12 },
  // 広場は掃除されている場所なので置かない（水面も置かない）
};

/** 装飾の描画サイズ（タイルに対する割合）。1タイルに収まる大きさにする */
const DECAL_PX = Math.round(TILE_PX * 0.5);

/**
 * このタイルに置く装飾を決める。置かないなら null。
 *
 * `offX/offY` はタイル内の寄せ（0..1）。中央に固定すると格子状に見えるのでずらす。
 */
export function decalAt(
  terrain: Terrain,
  tx: number,
  ty: number,
  sets: Partial<Record<Terrain, DecalSet>> = DECAL_SETS,
): { name: string; offX: number; offY: number } | null {
  const set = sets[terrain];
  if (!set || set.names.length === 0 || set.density <= 0) return null;
  const h = hash2(tx, ty, 0x9e3);
  // 下位16bitで「置くか」、上位で「どれを・どこに」を決める（同じハッシュを使い回す）
  if ((h & 0xffff) / 0x10000 >= set.density) return null;
  const name = set.names[(h >>> 16) % set.names.length] as string;
  const h2 = hash2(tx, ty, 0x1f7);
  return {
    name,
    // 端に寄りすぎると隣のタイルと重なって見えるので 0.2〜0.8 に収める
    offX: 0.2 + ((h2 & 0xff) / 0xff) * 0.6,
    offY: 0.2 + (((h2 >>> 8) & 0xff) / 0xff) * 0.6,
  };
}

/**
 * 座標から決定論的に整数を作る（splitmix風の撹拌）。
 *
 * `shared/rng.ts` の `hashSeed` は文字列を取るので、タイルごとに `${x},${y}` を組むと
 * 1チャンクの焼成で256本の文字列を捨てることになる。ここは整数だけで済ませる。
 */
function hash2(x: number, y: number, salt: number): number {
  let n = Math.imul(x | 0, 0x27d4eb2f) ^ Math.imul(y | 0, 0x85ebca6b) ^ Math.imul(salt + 1, 0xc2b2ae35);
  n = Math.imul(n ^ (n >>> 15), 0x2545f491);
  return (n ^ (n >>> 13)) >>> 0;
}

/**
 * タイル座標からバリエーション番号を選ぶ（0..count-1）。
 * 絶対座標で決めるので、チャンクの継ぎ目でも模様が破綻しない。
 */
export function tileVariant(tx: number, ty: number, count: number): number {
  if (count <= 1) return 0;
  return hash2(tx, ty, 0x5b1) % count;
}

/**
 * 荒廃度の tint を**掛けない**地形。
 *
 * `water` は資源として「飲まれる」たびに荒廃度が上がる（`resource.ts` の `decayAversion` が
 * 「同じ水場に群がりすぎない」ために使っている正しい挙動）。
 * だが荒廃度を可視化した途端、**湖面と海が茶色く濁って見えた**（実測で水場20タイルの
 * 荒廃度 p50=99）。荒廃は「踏み荒らされた地面」の表現なので、水面には意味がない。
 *
 * シミュレーション側の挙動は変えず、**描画だけ除外する**のが副作用が少ない
 * （`resource.ts` で addDecay をやめると動物が水場に群がる挙動が変わってしまう）。
 */
const NO_DECAY_TINT: ReadonlySet<Terrain> = new Set<Terrain>(['water']);

/** 荒廃度が最大のときの色（枯れた土の茶） */
const DECAY_COLOR = 0xa8926e;
/**
 * 荒廃度の上限。サーバの `RESOURCE.maxDecay` と同値だが、ここは見た目の話なので独立に持つ
 * （バランス調整で上限が動いたらこの値を合わせる）。
 */
const MAX_DECAY = 100;

/** 荒廃度（0..100）から tint を作る。0=そのまま(0xffffff) / 100=DECAY_COLOR */
export function decayTint(decay: number): number {
  const t = Math.max(0, Math.min(1, decay / MAX_DECAY));
  if (t <= 0) return 0xffffff;
  const ch = (shift: number): number => {
    const to = (DECAY_COLOR >> shift) & 0xff;
    return Math.round(0xff + (to - 0xff) * t);
  };
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}

/**
 * 遷移タイルのマスクを計算する。
 *
 * `sample(dx, dy)` は隣タイルの地形を返す。**未受信チャンク・地図外は「自分と同じ地形」を返す**
 * 約束にしてある（ビットが立たない＝境界線が出ない）。隣が来たときに焼き直せば線は現れるので、
 * 「線が後から出る」ほうが「タイルに穴が空く」より安全という判断。
 */
export function edgeMask(sample: (dx: number, dy: number) => Terrain | undefined, to: Terrain): number {
  let m = 0;
  if (sample(0, -1) === to) m |= EDGE_N;
  if (sample(1, 0) === to) m |= EDGE_E;
  if (sample(0, 1) === to) m |= EDGE_S;
  if (sample(-1, 0) === to) m |= EDGE_W;
  return m;
}

interface ChunkEntry {
  cx: number;
  cy: number;
  sprite: Sprite;
  rt: RenderTexture;
  /** 焼成に使ったタイル配列（invalidateで再焼成するため保持） */
  tiles: number[];
  /** 荒廃度（0..100 / タイルごと）。null なら荒廃なしとして焼く */
  decay: number[] | null;
}

export class TileMap {
  private readonly renderer: Renderer;
  private readonly parent: Container;
  private readonly textures: TerrainTextures;
  private readonly chunks = new Map<number, ChunkEntry>();
  /** 焼成用の使い回しコンテナ（毎回作るとGCが増える） */
  private readonly bakeRoot = new Container();
  private readonly bakeSprites: Sprite[] = [];
  /**
   * 装飾デカール用の焼成コンテナ（B-3）。
   * タイルと違って大きさもタイル内の位置も1枚ごとに変わるので、
   * `bakeSprites` を流用せず別に持つ（流用すると毎回 x/y/width を戻す必要がある）。
   */
  private readonly decalRoot = new Container();
  private readonly decalSprites: Sprite[] = [];
  private readonly chunksX: number;

  constructor(renderer: Renderer, layers: Pick<Layers, 'ground'>, textures: TerrainTextures, chunksX = 8) {
    this.renderer = renderer;
    this.parent = layers.ground;
    this.textures = textures;
    this.chunksX = chunksX;
    // 16×16=256枚のスプライトを最初に用意して使い回す
    for (let i = 0; i < CHUNK * CHUNK; i++) {
      const s = new Sprite();
      s.width = TILE_PX;
      s.height = TILE_PX;
      s.x = (i % CHUNK) * TILE_PX;
      s.y = Math.floor(i / CHUNK) * TILE_PX;
      this.bakeSprites.push(s);
      this.bakeRoot.addChild(s);

      const d = new Sprite();
      d.anchor.set(0.5);
      d.width = DECAL_PX;
      d.height = DECAL_PX;
      this.decalSprites.push(d);
      this.decalRoot.addChild(d);
    }
  }

  private key(cx: number, cy: number): number {
    return cy * this.chunksX + cx;
  }

  has(cx: number, cy: number): boolean {
    return this.chunks.has(this.key(cx, cy));
  }

  /**
   * チャンクの地形を適用（新規なら焼成してSpriteを置き、既存なら再焼成）。
   * terrainIndices は CHUNK*CHUNK の行優先配列。
   */
  applyChunk(cx: number, cy: number, terrainIndices: number[]): void {
    if (terrainIndices.length !== CHUNK * CHUNK) {
      throw new Error(`TileMap.applyChunk: 期待長 ${CHUNK * CHUNK} に対し ${terrainIndices.length}`);
    }
    const k = this.key(cx, cy);
    let entry = this.chunks.get(k);
    if (!entry) {
      const rt = RenderTexture.create({
        width: CHUNK * TILE_PX,
        height: CHUNK * TILE_PX,
        antialias: false,
      });
      rt.source.scaleMode = 'nearest';
      const sprite = new Sprite(rt);
      sprite.x = cx * CHUNK * TILE_PX;
      sprite.y = cy * CHUNK * TILE_PX;
      this.parent.addChild(sprite);
      entry = { cx, cy, sprite, rt, tiles: terrainIndices.slice(), decay: null };
      this.chunks.set(k, entry);
    } else {
      entry.tiles = terrainIndices.slice();
    }
    this.bake(entry);
    // 端の遷移タイルは隣チャンクの地形に依存するので、隣も焼き直す（B-2）
    this.invalidateNeighbors(cx, cy);
  }

  /**
   * 荒廃度を設定して見た目を変える（G-4）。
   * 荒廃度が変わったチャンクだけ呼ぶ運用（1島時間に1回程度）。
   */
  setChunkDecay(cx: number, cy: number, decay: number[]): void {
    const entry = this.chunks.get(this.key(cx, cy));
    if (!entry) return;
    if (decay.length !== CHUNK * CHUNK) {
      throw new Error(`TileMap.setChunkDecay: 期待長 ${CHUNK * CHUNK} に対し ${decay.length}`);
    }
    entry.decay = decay.slice();
    this.invalidate(cx, cy);
  }

  /** 保持しているタイル配列から再焼成する */
  invalidate(cx: number, cy: number): void {
    const entry = this.chunks.get(this.key(cx, cy));
    if (!entry) return;
    this.bake(entry);
  }

  /** 上下左右の受信済みチャンクを焼き直す（再帰しないよう bake ではなく自分で回す） */
  private invalidateNeighbors(cx: number, cy: number): void {
    for (const [dx, dy] of [
      [0, -1],
      [1, 0],
      [0, 1],
      [-1, 0],
    ] as const) {
      const entry = this.chunks.get(this.key(cx + dx, cy + dy));
      if (!entry) continue;
      // key() は cx が範囲外だと別チャンクに衝突するので座標で照合する
      if (entry.cx !== cx + dx || entry.cy !== cy + dy) continue;
      this.bake(entry);
    }
  }

  /**
   * 絶対タイル座標の地形。未受信チャンク・地図外は undefined。
   * `key()` は cx が範囲外だと隣の行のチャンクに衝突するので、先に範囲を弾く。
   */
  private terrainAtGlobal(gx: number, gy: number): Terrain | undefined {
    if (gx < 0 || gy < 0) return undefined;
    const cx = Math.floor(gx / CHUNK);
    const cy = Math.floor(gy / CHUNK);
    if (cx >= this.chunksX) return undefined;
    const entry = this.chunks.get(this.key(cx, cy));
    if (!entry || entry.cx !== cx || entry.cy !== cy) return undefined;
    const idx = (gy - cy * CHUNK) * CHUNK + (gx - cx * CHUNK);
    return TERRAINS[entry.tiles[idx] as number];
  }

  /** 座標から決定論的にバリエーションを選ぶ。無い地形は base に落ちる */
  private tileTexture(terrain: Terrain, gx: number, gy: number): Texture {
    const vs = this.textures.variants[terrain] ?? [];
    if (vs.length === 0) return this.textures.base[terrain];
    return vs[tileVariant(gx, gy, vs.length)] as Texture;
  }

  /** タイル画像を並べて1枚のテクスチャに焼く */
  private bake(entry: ChunkEntry): void {
    const decay = entry.decay;
    for (let i = 0; i < this.bakeSprites.length; i++) {
      const s = this.bakeSprites[i] as Sprite;
      const idx = entry.tiles[i] as number;
      const terrain = TERRAINS[idx];
      if (terrain === undefined) {
        s.visible = false;
        continue;
      }
      s.visible = true;
      s.texture = this.tileTexture(terrain, entry.cx * CHUNK + (i % CHUNK), entry.cy * CHUNK + Math.floor(i / CHUNK));
      s.width = TILE_PX;
      s.height = TILE_PX;
      s.tint = decay && !NO_DECAY_TINT.has(terrain) ? decayTint(decay[i] as number) : 0xffffff;
    }
    this.renderer.render({ container: this.bakeRoot, target: entry.rt, clear: true });
    // 遷移タイルは境界ごとに1パス重ねる（clear:false）。
    // 1タイルが複数の境界に当たる（草が砂と森の両方に接する）ことがあるので分ける。
    for (const pair of EDGE_PAIRS) this.bakeEdgePass(entry, pair);
    // 装飾は最後に1パス（遷移の上に乗せる。縁の草が生えているように見せたい）
    this.bakeDecalPass(entry);
  }

  /**
   * 装飾デカールを1パス重ねる（B-3）。該当が無ければ render を呼ばない。
   *
   * 荒廃度の tint は掛けない。荒れた土に花が咲いているのはおかしいが、
   * **荒れたら装飾を消す**のは荒廃度が変わるたびに焼き直す必要があって高い。
   * 荒廃タイルは全体の1%未満なので、いまは見逃す判断にしている。
   */
  private bakeDecalPass(entry: ChunkEntry): void {
    if (this.textures.decals.size === 0) return;
    let any = false;
    for (let i = 0; i < this.decalSprites.length; i++) {
      const s = this.decalSprites[i] as Sprite;
      s.visible = false;
      const terrain = TERRAINS[entry.tiles[i] as number];
      if (terrain === undefined) continue;
      const lx = i % CHUNK;
      const ly = Math.floor(i / CHUNK);
      const pick = decalAt(terrain, entry.cx * CHUNK + lx, entry.cy * CHUNK + ly);
      if (!pick) continue;
      const tex = this.textures.decals.get(pick.name);
      if (!tex) continue;
      s.visible = true;
      s.texture = tex;
      s.width = DECAL_PX;
      s.height = DECAL_PX;
      s.x = (lx + pick.offX) * TILE_PX;
      s.y = (ly + pick.offY) * TILE_PX;
      any = true;
    }
    if (any) this.renderer.render({ container: this.decalRoot, target: entry.rt, clear: false });
  }

  /** 1境界ぶんの遷移タイルを上書き描画する。該当が無ければ render を呼ばない */
  private bakeEdgePass(entry: ChunkEntry, pair: EdgePair): void {
    const decay = entry.decay;
    let any = false;
    for (let i = 0; i < this.bakeSprites.length; i++) {
      const s = this.bakeSprites[i] as Sprite;
      s.visible = false;
      const terrain = TERRAINS[entry.tiles[i] as number];
      if (terrain !== pair.from) continue;
      const gx = entry.cx * CHUNK + (i % CHUNK);
      const gy = entry.cy * CHUNK + Math.floor(i / CHUNK);
      const mask = edgeMask((dx, dy) => this.terrainAtGlobal(gx + dx, gy + dy) ?? terrain, pair.to);
      if (mask === 0) continue;
      const tex = this.textures.edges.get(edgeKey(pair.from, pair.to, mask));
      if (!tex) continue;
      s.visible = true;
      s.texture = tex;
      s.width = TILE_PX;
      s.height = TILE_PX;
      s.tint = decay && !NO_DECAY_TINT.has(terrain) ? decayTint(decay[i] as number) : 0xffffff;
      any = true;
    }
    if (any) this.renderer.render({ container: this.bakeRoot, target: entry.rt, clear: false });
  }

  /** 受信済みチャンク数（デバッグ表示用） */
  get count(): number {
    return this.chunks.size;
  }

  destroy(): void {
    for (const entry of this.chunks.values()) {
      entry.sprite.destroy();
      entry.rt.destroy(true);
    }
    this.chunks.clear();
    this.bakeRoot.destroy({ children: true });
    this.decalRoot.destroy({ children: true });
  }
}
