/**
 * 資源と設置物の描画（docs/02_ゲーム実装プラン/06_クライアント設計.md §2）
 *
 * アクターと同じ `entities` レイヤに置き、y座標で前後をソートする
 * （木の後ろに動物が回り込めるようにするため）。
 *
 * 木の実の木は在庫が0になると「枯れた見た目」にしたいが、
 * いまは実つき1枚しかないので、在庫0のときだけ少し暗くする。
 */
import { Container, Sprite, Texture } from 'pixi.js';
import { TILE_PX } from '@ai-pet/shared';
import type { Layers } from './stage.ts';
import type { Camera } from './camera.ts';
import type { PlaceableView, ResourceView, WorldState } from '../state/world.ts';

/** 資源・設置物のテクスチャ（`obj_<name>.png`） */
export class ObjectTextureSet {
  private map = new Map<string, Texture>();
  private fallback: Texture;

  constructor(entries: readonly [string, Texture][], fallback: Texture) {
    for (const [k, v] of entries) this.map.set(k, v);
    this.fallback = fallback;
  }

  get(name: string): Texture {
    return this.map.get(name) ?? this.fallback;
  }

  has(name: string): boolean {
    return this.map.has(name);
  }
}

/** 描画に使うスプライトの実体 */
interface Entry {
  sprite: Sprite;
  key: string;
}

/**
 * 種別ごとの描画サイズ（タイル単位）。木は大きく、花壇は小さく。
 * 接地影（`shadows.ts`）が同じ大きさの楕円を敷くので export している。
 */
export const OBJECT_SCALE: Record<string, number> = {
  berry_tree: 1.9,
  field: 1.3,
  fishing_spot: 1.0,
  water: 1.0,
  bench: 1.2,
  flowerbed: 1.0,
  lantern: 1.3,
  signboard: 1.2,
  well: 1.6,
  bridge: 1.0,
  // 共同建設の完成物と足場（G-1 / G-2）。島の名所なので大きく置く
  observatory: 2.4,
  scaffold: 2.2,
};

export class ObjectLayer {
  private container: Container;
  private textures: ObjectTextureSet;
  private camera: Camera;
  private sprites = new Map<number, Entry>();
  private drawnCount = 0;

  // 注意: Node の type-stripping で動かすため parameter property は使えない
  constructor(layers: Pick<Layers, 'entities'>, textures: ObjectTextureSet, camera: Camera) {
    this.container = layers.entities;
    this.textures = textures;
    this.camera = camera;
  }

  /** 毎フレーム、受信した資源・設置物に合わせてスプライトを整える */
  sync(world: WorldState): void {
    const seen = new Set<number>();
    const rect = this.camera.visibleRect(2);
    this.drawnCount = 0;

    for (const r of world.resources.values()) {
      // 水場と釣り場は地形で表現しているので描かない（点が散らばって見えてうるさい）
      if (r.type === 'water' || r.type === 'fishing_spot') continue;
      seen.add(r.id);
      this.place(r.id, `obj_${r.type}`, r, rect, r.amount <= 0 ? 0.65 : 1);
    }

    for (const p of world.placeables.values()) {
      seen.add(p.id);
      this.place(p.id, `obj_${p.type}`, p, rect, 1);
    }

    // 消えたものを片づける
    for (const [id, entry] of this.sprites) {
      if (seen.has(id)) continue;
      entry.sprite.destroy();
      this.sprites.delete(id);
    }
  }

  private place(
    id: number,
    key: string,
    view: ResourceView | PlaceableView,
    rect: { x0: number; y0: number; x1: number; y1: number },
    alpha: number,
  ): void {
    let entry = this.sprites.get(id);
    if (!entry || entry.key !== key) {
      if (entry) entry.sprite.destroy();
      const sprite = new Sprite(this.textures.get(key));
      sprite.anchor.set(0.5, 1); // 足元中央をアンカーにする（アクターと同じ）
      sprite.eventMode = 'none';
      this.container.addChild(sprite);
      entry = { sprite, key };
      this.sprites.set(id, entry);
    }

    const s = entry.sprite;
    const scale = OBJECT_SCALE[key.replace('obj_', '')] ?? 1;
    s.width = TILE_PX * scale;
    s.height = TILE_PX * scale;
    s.x = view.x * TILE_PX;
    // 足元をタイルの下端に合わせる
    s.y = (view.y + 0.5) * TILE_PX;
    s.alpha = alpha;
    // アクターと同じ規則でy順に並べる（木の後ろに回り込める）
    s.zIndex = Math.round(view.y * 100);

    // 画面外は描かない
    const visible = view.x >= rect.x0 && view.x <= rect.x1 && view.y >= rect.y0 && view.y <= rect.y1;
    s.renderable = visible;
    if (visible) this.drawnCount++;
  }

  /** デバッグ表示用 */
  get drawn(): number {
    return this.drawnCount;
  }
}
