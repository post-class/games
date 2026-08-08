/**
 * 資源と設置物の描画（docs/02_ゲーム実装プラン/06_クライアント設計.md §2）
 *
 * アクターと同じ `entities` レイヤに置き、y座標で前後をソートする
 * （木の後ろに動物が回り込めるようにするため）。
 *
 * 木の実の木は4状態の絵（B-5）を持つ。以前は1枚しか無かったので
 * 在庫0のときに `alpha 0.65` で暗くしていたが、
 * **暗いだけでは「実が無いのか枯れたのか」が分からない**（並ぶと同じ絵の反復にも見えた）。
 * 絵で区別できるようになったので暗くするのはやめた。
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

  /**
   * 候補を順に見て、**最初に持っているもの**の名前を返す。1つも無ければ最後の候補。
   *
   * 状態差分アセット（`obj_berry_tree_full.png` など）は「まだ生成されていない」ことが
   * 普通なので、呼び出し側が毎回 `has` を書かなくて済むようにここに寄せた。
   * 最後の候補は必ず基本アセット（`obj_berry_tree`）にしておくこと。
   */
  resolve(...names: readonly string[]): string {
    for (const n of names) if (this.map.has(n)) return n;
    return (names[names.length - 1] ?? '') as string;
  }
}

/** 木の実の木の見た目（B-5）。`obj_berry_tree_<state>.png` に対応する */
export type BerryTreeState = 'full' | 'empty' | 'young' | 'dead';

/**
 * 木の「個体差」の抽選。座標から決定論的に作る（`Math.random` 禁止・AI_CODING.md §3）。
 * サーバから種別が来ないので、クライアントだけで完結させている（帯域も増えない）。
 */
function treeHash01(x: number, y: number): number {
  // 木はタイル中心（x.5）に置かれるので、まず整数タイルへ落としてから混ぜる
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  let n = Math.imul(ix + 0x7f4a, 0x85ebca6b) ^ Math.imul(iy + 0x2c1b, 0xc2b2ae35);
  n = Math.imul(n ^ (n >>> 15), 0x2545f491);
  return ((n ^ (n >>> 13)) >>> 0) / 0x100000000;
}

/**
 * 若木・枯れ木にする割合。
 *
 * 森の木がぜんぶ同じ大木だと反復に見える（B-5 の動機）ので、
 * 一部を若木・枯れ木にして粗密を作る。
 * 合わせて2割ほど。3割にすると「実のなる木を探しても見つからない島」に見えた
 * （在庫で絵が変わるのは残りの8割だけなので、ここを増やすと情報量が減る）。
 */
const YOUNG_RATIO = 0.13;
const DEAD_RATIO = 0.07;

/**
 * 木の実の木の状態を決める。
 *
 * 優先順:
 *   1. `max <= 0` は枯死（実る上限が無い木）。いまの worldgen は作らないが、
 *      将来「枯れた木の資源」を置いても絵が付くようにしておく
 *   2. 座標ハッシュで選ばれた若木・枯れ木は**在庫では絵を変えない**。
 *      同じ木が若木↔大木に化けると「別の木に置き換わった」ように見えるため。
 *      若木・枯れ木は実を付けないものとして扱う（実の有無は残り8割の木で読める）
 *   3. 在庫0なら実なし、あれば実つき
 */
export function berryTreeState(amount: number, max: number, x: number, y: number): BerryTreeState {
  if (max <= 0) return 'dead';
  const h = treeHash01(x, y);
  if (h < YOUNG_RATIO) return 'young';
  if (h < YOUNG_RATIO + DEAD_RATIO) return 'dead';
  return amount <= 0 ? 'empty' : 'full';
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
  // 木の実の木の状態差分（B-5）。実つき・実なしは同じ大木なので基本と同寸、
  // 若木は小さく、枯れ木は葉が無いぶん少し低い。
  // ⚠️ 接地影（`shadows.ts`）は状態を知らず `berry_tree` の 1.9 を使うので、
  // 若木の影は絵より少し大きい。影の側は触れないので値を離しすぎないでおく
  berry_tree_full: 1.9,
  berry_tree_empty: 1.9,
  berry_tree_young: 1.35,
  berry_tree_dead: 1.7,
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
  // 島の生成時に置く「暮らしの痕跡」（C-1 / C-2）。
  // 家と風車は 2×2 タイルの footprint（歩行不可）に合わせて 2.2〜2.8 で置く。
  // 柵は1タイル=1枚なので継ぎ目が出ないよう 1.0 のまま
  house_a: 2.2,
  house_b: 2.2,
  house_c: 2.2,
  windmill: 2.8,
  fountain: 1.5,
  fence_h: 1.0,
  fence_v: 1.0,
  // 動物が作る巣（C-3）。1タイルに収まる小さな寝床で、
  // 上に丸まった動物（48px）が乗る前提なので動物より小さくする。
  // 1.0 だと動物がすっぽり隠れて「巣で寝ている」に見えない
  nest: 0.9,
  // 島に散らす小オブジェクト（C-4）。
  // 焚き火は夜の広場の主役なので少し大きく（`lights.ts` の campfire 光が半径4.6で乗る）、
  // 岩・切り株・茂みは「地面の飾り」なので1タイルに収める。
  // 1.4 以上にすると草地が茂みで埋まって動物が見えなくなった
  campfire: 1.3,
  rock: 1.0,
  stump: 0.9,
  bush: 1.15,
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
