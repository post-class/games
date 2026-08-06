/**
 * アクター描画（docs/02_ゲーム実装プラン/06_クライアント設計.md §2 / 05章 §6）
 *
 * - `ActorView` と Pixi Sprite を対応付ける
 * - 位置は補間バッファから `now - 150ms` の時点を線形補間して描く
 * - 深度ソートは `zIndex = Math.round(y * 100)`
 * - 自分のアバターだけクライアント予測（入力で即動かし、サーバ値と0.5タイル以上ズレたら0.2秒で補正）
 * - 画面外は `renderable = false` で culling
 */
import { Container, Sprite, type Texture } from 'pixi.js';
import { CHAR_PX, PLAYER_SPEED, TILE_PX, type ActorKind, type EntityId, type Facing, type Vec2 } from '@ai-pet/shared';
import { interpolatedPos, type ActorView, type WorldState } from '../state/world.ts';
import type { Camera } from './camera.ts';
import type { Layers } from './stage.ts';

/** 予測位置とサーバ値のズレがこれ以上なら補正を始める（タイル） */
export const RECONCILE_THRESHOLD = 0.5;
/** 補正にかける時間（秒） */
export const RECONCILE_DURATION = 0.2;
/** これ以上ズレたら（テレポート・弾かれ）補間せず即座に合わせる */
export const RECONCILE_SNAP = 3;
/** 画面外判定のマージン（タイル） */
const CULL_MARGIN = 2;
/** スプライトのアンカー（足元の影の中心。placeholderの絵と一致させる） */
const ANCHOR_Y = 43 / CHAR_PX;

/**
 * 種別＋種＋向き からテクスチャを引く。
 * アセット名は docs 08章の命名規則（`{category}_{name}_{dir}`）に合わせる。
 */
export class CharTextureSet {
  private readonly map = new Map<string, Texture>();
  private readonly fallback: Texture;

  constructor(entries: Iterable<readonly [string, Texture]>, fallback: Texture) {
    for (const [k, v] of entries) this.map.set(k, v);
    this.fallback = fallback;
  }

  /** `player_a` / `pet_mofi` / `critter_rabbit` のような prefix を作る */
  static prefixOf(kind: ActorKind, species: string): string {
    if (kind === 'player') return 'player_a';
    return `${kind}_${species}`;
  }

  get(kind: ActorKind, species: string, facing: Facing): Texture {
    const key = `${CharTextureSet.prefixOf(kind, species)}_${facing}`;
    return this.map.get(key) ?? this.map.get(`${CharTextureSet.prefixOf(kind, species)}_s`) ?? this.fallback;
  }
}

interface Entry {
  sprite: Sprite;
  /** 最後に適用したテクスチャキー（差分のみ切替） */
  texKey: string;
}

export class ActorLayer {
  private readonly parent: Container;
  private readonly textures: CharTextureSet;
  private readonly camera: Camera;
  private readonly entries = new Map<EntityId, Entry>();

  /** 自アバターの予測位置（world / タイル単位）。未設定なら予測しない */
  selfPos: Vec2 | null = null;
  private selfFacing: Facing = 's';
  private selfMoving = false;
  /** 補正の残り時間と補正ベクトル */
  private corrLeft = 0;
  private corrVx = 0;
  private corrVy = 0;

  /** 描画したスプライト数（デバッグ表示用） */
  drawn = 0;

  constructor(layers: Pick<Layers, 'entities'>, textures: CharTextureSet, camera: Camera) {
    this.parent = layers.entities;
    this.textures = textures;
    this.camera = camera;
  }

  /** 自アバターの初期位置を入れる（welcome / snapshot 直後） */
  setSelf(pos: Vec2): void {
    this.selfPos = { x: pos.x, y: pos.y };
    this.corrLeft = 0;
  }

  get selfFacingDir(): Facing {
    return this.selfFacing;
  }

  /**
   * 入力による即時移動（クライアント予測）。
   * `canStand` を渡すと水などに入らないよう軸ごとに押し戻す。
   */
  predictSelf(dx: number, dy: number, dtSec: number, canStand?: (p: Vec2) => boolean): void {
    const p = this.selfPos;
    if (!p) return;
    const len = Math.hypot(dx, dy);
    this.selfMoving = len > 0.001;
    if (!this.selfMoving) return;
    const nx = dx / len;
    const ny = dy / len;
    const step = PLAYER_SPEED * dtSec;
    const tryX = { x: p.x + nx * step, y: p.y };
    if (!canStand || canStand(tryX)) p.x = tryX.x;
    const tryY = { x: p.x, y: p.y + ny * step };
    if (!canStand || canStand(tryY)) p.y = tryY.y;
    // 向きは移動量の大きい軸で決める
    if (Math.abs(nx) > Math.abs(ny)) this.selfFacing = nx > 0 ? 'e' : 'w';
    else this.selfFacing = ny > 0 ? 's' : 'n';
  }

  /** 予測を使わない（サーバ主導に戻す）ときに呼ぶ */
  clearPrediction(): void {
    this.selfPos = null;
    this.corrLeft = 0;
  }

  /**
   * 毎フレームの同期。
   * nowMs は performance.now()、dtSec は前フレームからの経過秒。
   */
  sync(state: WorldState, nowMs: number, dtSec: number): void {
    const rect = this.camera.visibleRect(CULL_MARGIN);
    this.drawn = 0;

    // 消えたアクターのスプライトを片付ける
    for (const [id, entry] of this.entries) {
      if (!state.actors.has(id)) {
        entry.sprite.destroy();
        this.entries.delete(id);
      }
    }

    for (const view of state.actors.values()) {
      const isSelf = state.selfId !== null && view.id === state.selfId;
      const serverPos = interpolatedPos(view, nowMs);
      let pos = serverPos;
      let facing = view.facing;

      if (isSelf && this.selfPos) {
        // 補正の基準は「最後に受信した値」。補間位置（150ms遅れ）と比べると
        // 移動中は常に遅れぶんだけズレてしまい、引き戻しが起きる。
        this.reconcile({ x: view.x, y: view.y }, dtSec);
        pos = this.selfPos;
        if (this.selfMoving) facing = this.selfFacing;
      }

      const entry = this.ensure(view, facing);
      const sprite = entry.sprite;

      const visible = pos.x >= rect.x0 && pos.x <= rect.x1 && pos.y >= rect.y0 && pos.y <= rect.y1;
      sprite.renderable = visible;
      if (!visible) continue;
      this.drawn++;

      // 歩行中の上下の跳ね（演出のみ。placeholderにコマがないため簡易表現）
      const bob = view.anim === 'walk' || (isSelf && this.selfMoving) ? Math.sin(nowMs / 90 + view.id) * 1.5 : 0;
      sprite.x = pos.x * TILE_PX;
      sprite.y = pos.y * TILE_PX + bob;
      sprite.alpha = view.anim === 'sleep' ? 0.75 : 1;
      sprite.zIndex = Math.round(pos.y * 100);

      const texKey = `${CharTextureSet.prefixOf(view.kind, view.species)}_${facing}`;
      if (entry.texKey !== texKey) {
        sprite.texture = this.textures.get(view.kind, view.species, facing);
        entry.texKey = texKey;
      }
    }
  }

  /**
   * サーバ値とのズレが閾値を超えたら 0.2秒で寄せる（docs 05章 §6）。
   * 入力中は「移動指示がサーバへ届くまでの遅れ」で必ずズレるため補正しない。
   * 代わりに、極端にズレたとき（弾かれ・テレポート）は即座に合わせる。
   */
  private reconcile(serverPos: Vec2, dtSec: number): void {
    const p = this.selfPos;
    if (!p) return;
    if (Math.hypot(serverPos.x - p.x, serverPos.y - p.y) >= RECONCILE_SNAP) {
      p.x = serverPos.x;
      p.y = serverPos.y;
      this.corrLeft = 0;
      return;
    }
    if (this.corrLeft > 0) {
      const step = Math.min(dtSec, this.corrLeft);
      p.x += this.corrVx * step;
      p.y += this.corrVy * step;
      this.corrLeft -= step;
      if (this.corrLeft <= 0) {
        this.corrVx = 0;
        this.corrVy = 0;
      }
      return;
    }
    if (this.selfMoving) return;
    const dx = serverPos.x - p.x;
    const dy = serverPos.y - p.y;
    if (Math.hypot(dx, dy) >= RECONCILE_THRESHOLD) {
      this.corrLeft = RECONCILE_DURATION;
      this.corrVx = dx / RECONCILE_DURATION;
      this.corrVy = dy / RECONCILE_DURATION;
    }
  }

  private ensure(view: ActorView, facing: Facing): Entry {
    const found = this.entries.get(view.id);
    if (found) return found;
    const tex = this.textures.get(view.kind, view.species, facing);
    const sprite = new Sprite(tex);
    sprite.anchor.set(0.5, ANCHOR_Y);
    sprite.width = CHAR_PX;
    sprite.height = CHAR_PX;
    sprite.label = `actor:${view.id}`;
    this.parent.addChild(sprite);
    const entry: Entry = { sprite, texKey: `${CharTextureSet.prefixOf(view.kind, view.species)}_${facing}` };
    this.entries.set(view.id, entry);
    return entry;
  }

  destroy(): void {
    for (const entry of this.entries.values()) entry.sprite.destroy();
    this.entries.clear();
  }
}
