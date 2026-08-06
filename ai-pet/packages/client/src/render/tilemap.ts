/**
 * 地形描画（docs/02_ゲーム実装プラン/06_クライアント設計.md §2）
 *
 * 128×128タイル＝16384スプライトを毎フレーム描くのは無駄なので、
 * **チャンク（16×16タイル）単位で RenderTexture に一度焼き、Sprite 1枚として置く**。
 * 焼成は「タイル画像を並べて renderer.render() で1枚にする」方式。
 *
 * 未受信チャンクは何も置かない（背景色のまま）。
 */
import { Container, RenderTexture, Sprite, type Renderer, type Texture } from 'pixi.js';
import { CHUNK, TILE_PX, TERRAINS, type Terrain } from '@ai-pet/shared';
import type { Layers } from './stage.ts';

/** 地形テクスチャ（TERRAINSのindexで引ける形にしておく） */
export type TerrainTextures = Record<Terrain, Texture>;

interface ChunkEntry {
  sprite: Sprite;
  rt: RenderTexture;
  /** 焼成に使ったタイル配列（invalidateで再焼成するため保持） */
  tiles: number[];
  /** 荒廃度（0..100 / タイルごと）。M3で使う */
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
      entry = { sprite, rt, tiles: terrainIndices.slice(), decay: null };
      this.chunks.set(k, entry);
    } else {
      entry.tiles = terrainIndices.slice();
    }
    this.bake(entry);
  }

  /**
   * 荒廃度を設定して見た目を変える（フックのみ）。
   * TODO(M3): 荒廃度に応じてタイルを枯れ色へ寄せる。
   *   実装案 = 焼成時に sprite.tint を decay から作った茶系へ補間する（0=そのまま, 100=#a8926e）。
   *   荒廃度が変わったチャンクだけ invalidate() を呼ぶ運用にする（1島時間に1回程度）。
   */
  setChunkDecay(cx: number, cy: number, decay: number[]): void {
    const entry = this.chunks.get(this.key(cx, cy));
    if (!entry) return;
    entry.decay = decay;
    this.invalidate(cx, cy);
  }

  /** 保持しているタイル配列から再焼成する */
  invalidate(cx: number, cy: number): void {
    const entry = this.chunks.get(this.key(cx, cy));
    if (!entry) return;
    this.bake(entry);
  }

  /** タイル画像を並べて1枚のテクスチャに焼く */
  private bake(entry: ChunkEntry): void {
    for (let i = 0; i < this.bakeSprites.length; i++) {
      const s = this.bakeSprites[i] as Sprite;
      const idx = entry.tiles[i] as number;
      const terrain = TERRAINS[idx];
      if (terrain === undefined) {
        s.visible = false;
        continue;
      }
      const tex = this.textures[terrain];
      s.visible = true;
      s.texture = tex;
      s.width = TILE_PX;
      s.height = TILE_PX;
      // TODO(M3): entry.decay[i] から tint を計算する
      s.tint = 0xffffff;
    }
    this.renderer.render({ container: this.bakeRoot, target: entry.rt, clear: true });
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
  }
}
