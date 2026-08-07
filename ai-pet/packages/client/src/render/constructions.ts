/**
 * 共同建設の見た目（G-1 / docs/03_宣伝用との乖離是正プラン/03_タスク詳細.md）
 *
 * サーバは橋・井戸・天文台の予定地を3つ持っていて `contribute` も動くのに、
 * **クライアントが何も描いていなかった**（`objects.ts` は資源と設置物しか見ていない）。
 * その結果、島を歩いていても「ここが作れる場所」だと分からず、
 * 宣伝資料の「共同作業：橋づくりなど、みんなで少しずつ進める建設」が体験できなかった。
 *
 * ここでやること:
 * - 未完成の予定地に**足場**（`obj_scaffold`）を描く
 * - 足場の上に**進捗バー**を出す（0〜100%）。1枚の Graphics にまとめて描く
 * - 完成したものは描かない（完成物は設置物・地形として `objects.ts` / `tilemap.ts` が描く）
 */
import { Container, Graphics, Sprite } from 'pixi.js';
import { TILE_PX } from '@ai-pet/shared';
import type { ConstructionWire } from '@ai-pet/shared';
import type { Layers } from './stage.ts';
import type { Camera } from './camera.ts';
import type { ObjectTextureSet } from './objects.ts';

/** 足場の描画サイズ（タイル単位）。予定地が分かる程度に大きく */
const SCAFFOLD_SCALE = 2.2;
/** 進捗バーの幅・高さ（px） */
const BAR_W = 40;
const BAR_H = 6;
/** 足場の上端からバーをどれだけ浮かせるか（px） */
const BAR_LIFT = 10;
/** 画面外判定のマージン（タイル） */
const CULL_MARGIN = 3;

/** 進捗バーの色。0%は薄く、進むほど濃い緑へ寄せる */
export const BAR_BG = 0xfffdf3;
export const BAR_BORDER = 0x4a3b2a;
export const BAR_LOW = 0xffb9a3;
export const BAR_HIGH = 0xbfe06a;

/** 進捗 0..100 からバーの色を選ぶ（半分を境に桃→緑） */
export function barColor(progress: number): number {
  return progress >= 50 ? BAR_HIGH : BAR_LOW;
}

interface Entry {
  sprite: Sprite;
}

export class ConstructionLayer {
  private readonly container: Container;
  private readonly bars: Graphics;
  private readonly textures: ObjectTextureSet;
  private readonly camera: Camera;
  private readonly sprites = new Map<number, Entry>();
  private items: readonly ConstructionWire[] = [];
  private drawnCount = 0;

  // 注意: Node の type-stripping で動かすため parameter property は使えない
  constructor(layers: Pick<Layers, 'entities' | 'light'>, textures: ObjectTextureSet, camera: Camera) {
    this.container = layers.entities;
    this.textures = textures;
    this.camera = camera;
    // バーは「常に手前」に出したいので、y順ソートされる entities ではなく light 層に置く
    // （light は entities の上・weather の下。加算ではないので色はそのまま出る）
    this.bars = new Graphics();
    this.bars.eventMode = 'none';
    layers.light.addChild(this.bars);
  }

  /** サーバから来た一覧を差し替える（`constructions` メッセージのたび） */
  setItems(items: readonly ConstructionWire[]): void {
    this.items = items;
  }

  update(): void {
    const rect = this.camera.visibleRect(CULL_MARGIN);
    this.bars.clear();
    this.drawnCount = 0;
    const seen = new Set<number>();

    for (const c of this.items) {
      if (c.done) continue; // 完成物は objects.ts / tilemap.ts が描く
      seen.add(c.i);

      let entry = this.sprites.get(c.i);
      if (!entry) {
        const sprite = new Sprite(this.textures.get('obj_scaffold'));
        sprite.anchor.set(0.5, 1); // 足元中央（objects.ts と同じ規則）
        sprite.eventMode = 'none';
        sprite.label = `construction:${c.i}`;
        this.container.addChild(sprite);
        entry = { sprite };
        this.sprites.set(c.i, entry);
      }

      const s = entry.sprite;
      s.width = TILE_PX * SCAFFOLD_SCALE;
      s.height = TILE_PX * SCAFFOLD_SCALE;
      s.x = c.x * TILE_PX;
      s.y = (c.y + 0.5) * TILE_PX;
      s.zIndex = Math.round(c.y * 100);

      const visible = c.x >= rect.x0 && c.x <= rect.x1 && c.y >= rect.y0 && c.y <= rect.y1;
      s.renderable = visible;
      if (!visible) continue;
      this.drawnCount++;

      // 進捗バー。ワールド座標のまま描く（light 層は worldRoot の中なのでカメラに追従する）
      const top = s.y - TILE_PX * SCAFFOLD_SCALE - BAR_LIFT;
      const left = s.x - BAR_W / 2;
      this.bars.rect(left - 1, top - 1, BAR_W + 2, BAR_H + 2).fill({ color: BAR_BORDER });
      this.bars.rect(left, top, BAR_W, BAR_H).fill({ color: BAR_BG });
      const w = (BAR_W * Math.max(0, Math.min(100, c.p))) / 100;
      if (w > 0) this.bars.rect(left, top, w, BAR_H).fill({ color: barColor(c.p) });
    }

    // 完成した・消えた予定地の足場を片づける
    for (const [id, entry] of this.sprites) {
      if (seen.has(id)) continue;
      entry.sprite.destroy();
      this.sprites.delete(id);
    }
  }

  /** デバッグ表示用 */
  get drawn(): number {
    return this.drawnCount;
  }

  destroy(): void {
    for (const entry of this.sprites.values()) entry.sprite.destroy();
    this.sprites.clear();
    this.bars.destroy();
  }
}
