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
import {
  CHAR_PX,
  PLAYER_SPEED,
  TILE_PX,
  type ActorKind,
  type AnimName,
  type EntityId,
  type Facing,
  type Vec2,
} from '@ai-pet/shared';
import { interpolatedPos, type ActorView, type WorldState } from '../state/world.ts';
import { normalizePlayerSpecies } from '../state/species.ts';
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

/**
 * 同じ場所に何体から「重なっている」とみなすか（D-7）。
 *
 * 調査で、広場の北西に10体以上が重なって**茶色い塊**になっていた
 * （`docs/03_宣伝用との乖離是正プラン/images/03_ズーム15_動物の団子.png`）。
 * 群れること自体はシミュレーションの正しい挙動なので、**サーバの座標は変えず**、
 * 描画だけ扇状にずらして「何体いるか読める」ようにする。
 */
const CROWD_THRESHOLD = 3;
/** ずらす最大量（タイル）。大きくすると当たり判定と見た目がずれるので控えめに */
const CROWD_SPREAD_TILES = 0.42;

/**
 * 重なり具合から描画のずらし量を出す。
 *
 * `index` はそのタイルにいる何体目か、`total` はそのタイルの総数。
 * 1体目は動かさず（群れの中心を保つ）、2体目以降を円周上に並べる。
 */
export function crowdOffset(index: number, total: number): { dx: number; dy: number } {
  if (total < CROWD_THRESHOLD || index === 0) return { dx: 0, dy: 0 };
  // golden angle で散らすと、総数が増えても均等に広がる（同じ角度に溜まらない）
  const angle = index * 2.39996;
  const r = CROWD_SPREAD_TILES * Math.sqrt(index / total);
  return { dx: Math.cos(angle) * r, dy: Math.sin(angle) * r * 0.6 };
}
/**
 * スプライトのアンカー（足元の影の中心。placeholderの絵と一致させる）。
 * 接地影（`shadows.ts`）が同じ位置に楕円を描くので export している。
 */
export const ANCHOR_Y = 43 / CHAR_PX;

/**
 * いのししの表示倍率（D-6 のハック）。
 *
 * いまの `critter_boar_{n,s,e}` は絵が横長なので、48px枠に収めると高さが他の動物の6割ほどになり、
 * 「ひとまわり大きい」という設定が見た目に出ない。枠ごと大きくして補っている。
 *
 * ⚠️ **絵を正方寸りに作り直したら、この値を `1.0` にすること**（それがハックの撤去になる）。
 * 絵より先に 1.0 にすると、いのししが他の動物と同じ大きさに見えて設定が消えるので順番を守る。
 */
export const BOAR_SCALE = 1.3;

/**
 * 種ごとの表示倍率。
 * `shadows.ts` が接地影の大きさを合わせるために import しているので、名前を変えないこと。
 */
export const SPECIES_SCALE: Record<string, number> = {
  boar: BOAR_SCALE,
};

/** 睡眠ポーズのアセットが無いときの代用（従来の見た目）。半透明にして「寝ている」を示す */
export const SLEEP_ALPHA = 0.75;

/**
 * アクター1体の見た目（テクスチャキーと不透明度）を決める（D-3）。
 *
 * `sync()` は Pixi と camera が要るのでテストから引きにくい。
 * 「睡眠ポーズがあれば差し替え、無ければ従来どおり半透明」という**分岐だけ**を純粋関数に切り出した。
 */
export function charLook(
  kind: ActorKind,
  species: string,
  facing: Facing,
  anim: AnimName,
  hasSleepTexture: boolean,
): { texKey: string; alpha: number; sleepPose: boolean } {
  const prefix = CharTextureSet.prefixOf(kind, species);
  const sleeping = anim === 'sleep';
  // 丸まった絵は向きを持たない（どの方向から見ても同じ塊なので `_sleep` 1枚で足りる）
  if (sleeping && hasSleepTexture) return { texKey: `${prefix}_sleep`, alpha: 1, sleepPose: true };
  return { texKey: `${prefix}_${facing}`, alpha: sleeping ? SLEEP_ALPHA : 1, sleepPose: false };
}

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

  /**
   * `player_b` / `pet_mofi` / `critter_rabbit` のような prefix を作る。
   *
   * プレイヤーは `species` に4色の識別子（`a`..`d`）が入って届く（D-5）。
   * 4色化より前のプレイヤーは空文字なので `a` に正規化する（旧DBのプレイヤーを壊さない）。
   */
  static prefixOf(kind: ActorKind, species: string): string {
    if (kind === 'player') return `player_${normalizePlayerSpecies(species)}`;
    return `${kind}_${species}`;
  }

  get(kind: ActorKind, species: string, facing: Facing): Texture {
    const key = `${CharTextureSet.prefixOf(kind, species)}_${facing}`;
    return this.map.get(key) ?? this.map.get(`${CharTextureSet.prefixOf(kind, species)}_s`) ?? this.fallback;
  }

  /** 睡眠ポーズ（`<kind>_<species>_sleep`）を持っているか（D-3） */
  hasSleep(kind: ActorKind, species: string): boolean {
    return this.map.has(`${CharTextureSet.prefixOf(kind, species)}_sleep`);
  }

  /** 睡眠ポーズのテクスチャ。無ければ null（呼び側は立ち絵＋半透明に落ちる） */
  getSleep(kind: ActorKind, species: string): Texture | null {
    return this.map.get(`${CharTextureSet.prefixOf(kind, species)}_sleep`) ?? null;
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

    // 同じタイルに何体いるかを先に数える（D-7 の扇状オフセット用）。
    // キーはタイル座標。自分と自分のペットは数に入れる（群れに混ざるので同じ扱いでよい）
    const crowd = new Map<number, number>();
    const crowdIndex = new Map<EntityId, number>();
    for (const view of state.actors.values()) {
      const key = (Math.round(view.y) << 8) | (Math.round(view.x) & 0xff);
      const n = crowd.get(key) ?? 0;
      crowdIndex.set(view.id, n);
      crowd.set(key, n + 1);
    }

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
      // 団子を扇状にほぐす（D-7）。自分は動かさない（操作している位置がずれると気持ち悪い）
      const key = (Math.round(view.y) << 8) | (Math.round(view.x) & 0xff);
      const off = isSelf
        ? { dx: 0, dy: 0 }
        : crowdOffset(crowdIndex.get(view.id) ?? 0, crowd.get(key) ?? 1);
      sprite.x = (pos.x + off.dx) * TILE_PX;
      sprite.y = (pos.y + off.dy) * TILE_PX + bob;
      // 深度はずらした後の y で決める（前後関係もほぐれた並びに合わせる）
      sprite.zIndex = Math.round((pos.y + off.dy) * 100);

      // 睡眠ポーズ（D-3）。アセットが無い種は従来どおり立ち絵＋半透明で寝ている扱いになる
      const look = charLook(
        view.kind,
        view.species,
        facing,
        view.anim,
        this.textures.hasSleep(view.kind, view.species),
      );
      sprite.alpha = look.alpha;
      if (entry.texKey !== look.texKey) {
        sprite.texture = look.sleepPose
          ? (this.textures.getSleep(view.kind, view.species) as Texture)
          : this.textures.get(view.kind, view.species, facing);
        entry.texKey = look.texKey;
        // Pixi はテクスチャを差し替えると scale から表示寸法を決め直すので、
        // 睡眠ポーズの絵が48px枠でなくても崩れないよう毎回入れ直す（切替時だけなので安い）
        this.applySize(sprite, view.species);
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

  /** 表示寸法を種ごとの倍率で入れる（いのししの D-6 ハックが効くのはここ） */
  private applySize(sprite: Sprite, species: string): void {
    const scale = SPECIES_SCALE[species ?? ''] ?? 1;
    sprite.width = CHAR_PX * scale;
    sprite.height = CHAR_PX * scale;
  }

  private ensure(view: ActorView, facing: Facing): Entry {
    const found = this.entries.get(view.id);
    if (found) return found;
    const tex = this.textures.get(view.kind, view.species, facing);
    const sprite = new Sprite(tex);
    sprite.anchor.set(0.5, ANCHOR_Y);
    this.applySize(sprite, view.species);
    sprite.label = `actor:${view.id}`;
    this.parent.addChild(sprite);
    // 生成直後は立ち絵。睡眠ポーズへの差し替えは sync() が同フレーム中に行う
    const entry: Entry = { sprite, texKey: `${CharTextureSet.prefixOf(view.kind, view.species)}_${facing}` };
    this.entries.set(view.id, entry);
    return entry;
  }

  destroy(): void {
    for (const entry of this.entries.values()) entry.sprite.destroy();
    this.entries.clear();
  }
}
