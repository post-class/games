/**
 * render/placeholder.ts — スプライトの差し替え口とプレースホルダ図形（T-M5-02）
 *
 * ==========================================================================
 *  ★ここは「後で `public/assets/**` の WebP に差し替える」ための仮実装★
 * ==========================================================================
 *
 * アセット（M17: `T-M17-01`〜）がまだ無いので、ユニットは**陣営色の円 + 役割記号**、
 * 建物は**矩形**で描いている。絵が入ったら以下の手順で差し替える。
 *
 * ■ 差し替え手順
 *  1. `public/assets/units/<civ>.webp` / `public/assets/buildings/<civ>.webp` に
 *     アトラス（方向 8 × アニメ 4〜8 フレーム。手順書 §7.1）を置く。
 *  2. アトラスの矩形表（`{ id, dir, frame, sx, sy, sw, sh, ox, oy }`）を JSON で添える。
 *  3. このファイルと同じ階層に `atlasSprites.ts` を作り、
 *     `SpriteProvider` を実装した `AtlasSpriteProvider` を書く。
 *     `drawUnit` / `drawBuilding` の中身は `ctx.drawImage(atlas, ...)` 1 回だけにする
 *     （`drawImage` の呼び出し回数を増やさないのが 400 体 10ms の前提）。
 *  4. `Renderer` の生成箇所（`src/main.ts`）で
 *     `new PlaceholderSpriteProvider()` → `new AtlasSpriteProvider(...)` に替える。
 *     **`spriteLayer.ts` は 1 行も変えなくてよい**（それがこの interface の目的）。
 *  5. 読み込み中（`ready() === false`）はプレースホルダに落とす。
 *     `FallbackSpriteProvider` がその切り替えを担う。
 *
 * ■ 決定論について
 *  描画層なので `Math.random` / `Date.now` を使ってよい（手順書 §0.3 の禁止は sim のみ）。
 *  ただし**ここで作った値を Command に混ぜてはいけない**。
 */

import type { Ctx2D } from './ctx';

// --------------------------------------------------------------- 差し替え口

/** ユニット 1 体を描くのに必要な情報（sim の状態からレンダラが組み立てる）。 */
export interface UnitSpriteView {
  /** `units.json` の添字（`Entities.typeId`）。アトラスの引き当てキー。 */
  readonly typeId: number;
  /** 所有者 playerId（255 = 中立）。 */
  readonly owner: number;
  /** 陣営色（`palette.playerColor`）。 */
  readonly color: string;
  /** 画面上の半径 px（ズーム込み）。 */
  readonly radiusPx: number;
  /** 役割記号（プレースホルダ用。アトラス実装では無視してよい）。 */
  readonly glyph: string;
  /** 向き 0..7（0 = 南東。アトラスの列）。 */
  readonly dir: number;
  /** アニメフレーム 0..7（アトラスの行）。 */
  readonly frame: number;
}

/** 建物 1 棟を描くのに必要な情報。 */
export interface BuildingSpriteView {
  readonly typeId: number;
  readonly owner: number;
  readonly color: string;
  /** 画面上の幅・高さ px（ズーム込み）。 */
  readonly wPx: number;
  readonly hPx: number;
  readonly glyph: string;
  /** 建設中（0..1）。1 = 完成。 */
  readonly buildRatio: number;
}

/** 資源ノード（森・鉱脈・農地）1 個ぶん。 */
export interface ResourceSpriteView {
  readonly typeId: number;
  readonly color: string;
  readonly radiusPx: number;
  readonly glyph: string;
}

/**
 * スプライトの供給元。**描画レイヤはこの interface しか知らない。**
 * プレースホルダ図形 → WebP アトラスの差し替えは実装クラスの入れ替えだけで済む。
 */
export interface SpriteProvider {
  /** 実装の種類（デバッグ表示・テスト用）。 */
  readonly kind: string;
  /** アセットの読み込みが完了しているか。false の間は呼び出し側が代替を使う。 */
  ready(): boolean;
  /** (sx, sy) は**足元**の画面座標。 */
  drawUnit(ctx: Ctx2D, sx: number, sy: number, v: UnitSpriteView): void;
  /** (sx, sy) は建物の**接地中心**の画面座標。 */
  drawBuilding(ctx: Ctx2D, sx: number, sy: number, v: BuildingSpriteView): void;
  /** (sx, sy) は資源の足元。 */
  drawResource(ctx: Ctx2D, sx: number, sy: number, v: ResourceSpriteView): void;
}

// --------------------------------------------------------------- 役割記号

/**
 * 役割 index → 1 文字の記号（プレースホルダ）。
 * 並びは `defs.ROLE_IDS`（= `config.json` の `counterMatrix` のキー順）に依存させず、
 * ID 文字列で引く（データの並びが変わっても壊れないようにするため）。
 */
const ROLE_GLYPHS: Readonly<Record<string, string>> = {
  spear: '槍',
  sword: '剣',
  ranged: '弓',
  cavalry: '騎',
  camel: '駝',
  beast: '象',
  siege: '砲',
  gunpowder: '筒',
  ship: '船',
  villager: '民',
  support: '旗',
  building: '城',
};

/** 役割 ID → 記号。未知は '?'。 */
export function roleGlyph(role: string): string {
  return ROLE_GLYPHS[role] ?? '?';
}

// --------------------------------------------------------------- 仮実装

/**
 * 図形だけで描く仮のスプライト供給元。
 * ユニット = 陣営色の円 + 役割記号、建物 = 矩形、資源 = 小さな菱形。
 */
export class PlaceholderSpriteProvider implements SpriteProvider {
  readonly kind = 'placeholder';

  ready(): boolean {
    return true;
  }

  drawUnit(ctx: Ctx2D, sx: number, sy: number, v: UnitSpriteView): void {
    const r = v.radiusPx;
    // 影（接地感。アトラスに替えても残す想定）
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath();
    ctx.arc(sx, sy, r * 0.9, 0, Math.PI * 2);
    ctx.fill();
    // 本体
    ctx.fillStyle = v.color;
    ctx.beginPath();
    ctx.arc(sx, sy - r, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth = 1;
    ctx.stroke();
    // 役割記号（小さすぎるズームでは省く = 遠景の間引き）
    if (r >= 5) {
      ctx.fillStyle = '#12100c';
      ctx.font = `${Math.round(r * 1.4)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(v.glyph, sx, sy - r);
    }
  }

  drawBuilding(ctx: Ctx2D, sx: number, sy: number, v: BuildingSpriteView): void {
    const w = v.wPx;
    const h = v.hPx;
    const x = sx - w / 2;
    const y = sy - h;
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(x + 2, sy - h * 0.2, w, h * 0.2);
    ctx.fillStyle = v.color;
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = 'rgba(0,0,0,0.7)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x, y, w, h);
    // 建設中は下からせり上がる表現（体力バーが進捗を兼ねる仕様の視覚版。`05§9`）
    if (v.buildRatio < 1) {
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(x, y, w, h * (1 - v.buildRatio));
    }
    if (w >= 14) {
      ctx.fillStyle = '#12100c';
      ctx.font = `${Math.round(Math.min(w, h) * 0.5)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(v.glyph, sx, y + h / 2);
    }
  }

  drawResource(ctx: Ctx2D, sx: number, sy: number, v: ResourceSpriteView): void {
    const r = v.radiusPx;
    ctx.fillStyle = v.color;
    ctx.beginPath();
    ctx.moveTo(sx, sy - r * 2);
    ctx.lineTo(sx + r, sy - r);
    ctx.lineTo(sx, sy);
    ctx.lineTo(sx - r, sy - r);
    ctx.closePath();
    ctx.fill();
  }
}

/**
 * アトラスの読み込みが終わるまでプレースホルダに落とす包み。
 * `AtlasSpriteProvider` を書いたら `new FallbackSpriteProvider(atlas)` で挟むだけでよい。
 */
export class FallbackSpriteProvider implements SpriteProvider {
  readonly kind: string;
  private readonly fallback = new PlaceholderSpriteProvider();

  constructor(private readonly primary: SpriteProvider) {
    this.kind = `fallback(${primary.kind})`;
  }

  ready(): boolean {
    return true;
  }

  private pick(): SpriteProvider {
    return this.primary.ready() ? this.primary : this.fallback;
  }

  drawUnit(ctx: Ctx2D, sx: number, sy: number, v: UnitSpriteView): void {
    this.pick().drawUnit(ctx, sx, sy, v);
  }

  drawBuilding(ctx: Ctx2D, sx: number, sy: number, v: BuildingSpriteView): void {
    this.pick().drawBuilding(ctx, sx, sy, v);
  }

  drawResource(ctx: Ctx2D, sx: number, sy: number, v: ResourceSpriteView): void {
    this.pick().drawResource(ctx, sx, sy, v);
  }
}
