/**
 * render/atlas.ts — 1 枚のアトラス画像からスプライトを描く `SpriteProvider`
 *
 * ■ なぜアトラス 1 枚なのか
 * アセットは 159 枚ある。個別に fetch すると初回表示で 159 往復かかる。
 * `tools/assets/build.py pack` が 1 枚の WebP と `manifest.json` にまとめるので、
 * ここは**画像 1 枚と JSON 1 個**を読むだけで済む。
 *
 * ■ 読み込み中の扱い
 * `ready()` が false の間は呼び出し側（`FallbackSpriteProvider`）が
 * プレースホルダ図形に落とす。**待たない**。読み込めなかった場合も同じ扱いなので、
 * アセットが 1 枚も無い状態でもゲームは動く（`placeholder.ts` の設計どおり）。
 *
 * ■ 陣営色の付け方
 * 建物とユニットの絵は無染色で作ってある。所有者を見分ける必要があるので、
 * **絵をそのまま描いた上に陣営色の縁取りと足元の印**を足す。
 * 絵の内部を色で塗り替える（合成モードで乗算する）方法は、
 * 1 体ごとにオフスクリーンを作る必要があって重いので採らない。
 *
 * ■ 決定論とは無関係
 * 描画層なので試合結果には影響しない。ここで何をしても hash は変わらない。
 */

import type { Ctx2D } from './ctx';
import { unitDef, buildingDef } from '@/sim/core/defs';
import { resourceNodeDef } from '@/sim/core/gather';
import type {
  BuildingSpriteView,
  ResourceSpriteView,
  SpriteProvider,
  UnitSpriteView,
} from './placeholder';

/** アトラス内の 1 枚の位置。`manifest.json` の `frames` の値。 */
export interface AtlasFrame {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** `public/assets/manifest.json` の形。 */
export interface AtlasManifest {
  readonly version: number;
  readonly image: string;
  readonly size: { readonly w: number; readonly h: number };
  readonly frames: Readonly<Record<string, AtlasFrame>>;
}

/** 描画に使える画像（`HTMLImageElement` / `ImageBitmap` のどちらでもよい）。 */
export type AtlasImage = CanvasImageSource & { readonly width: number; readonly height: number };

/** manifest の形を検証する。壊れていたら理由付きで投げる（黙って絵無しにしない）。 */
export function parseManifest(raw: unknown): AtlasManifest {
  if (typeof raw !== 'object' || raw === null) throw new Error('manifest.json が object でない');
  const m = raw as Record<string, unknown>;
  if (m['version'] !== 1) throw new Error(`manifest の version が未対応: ${String(m['version'])}`);
  if (typeof m['image'] !== 'string') throw new Error('manifest に image が無い');
  const size = m['size'] as Record<string, unknown> | undefined;
  if (size === undefined || typeof size['w'] !== 'number' || typeof size['h'] !== 'number') {
    throw new Error('manifest に size が無い');
  }
  const framesRaw = m['frames'];
  if (typeof framesRaw !== 'object' || framesRaw === null) throw new Error('manifest に frames が無い');
  const frames: Record<string, AtlasFrame> = {};
  for (const [key, v] of Object.entries(framesRaw as Record<string, unknown>)) {
    const f = v as Record<string, unknown>;
    for (const k of ['x', 'y', 'w', 'h']) {
      if (typeof f[k] !== 'number') throw new Error(`frames.${key}.${k} が数値でない`);
    }
    frames[key] = { x: f['x'] as number, y: f['y'] as number, w: f['w'] as number, h: f['h'] as number };
  }
  return {
    version: 1,
    image: m['image'],
    size: { w: size['w'], h: size['h'] },
    frames,
  };
}

/**
 * `units.json` の `sprite`（"units/villager.webp"）→ manifest のキー（"units/villager"）。
 * 空文字（`sprite` 未指定）なら null を返し、呼び出し側がプレースホルダに落とす。
 */
export function spriteKeyOf(sprite: string): string | null {
  if (sprite === '') return null;
  const dot = sprite.lastIndexOf('.');
  return dot < 0 ? sprite : sprite.slice(0, dot);
}

/** 建物は `sprite` を持たないので id から引く（`buildings/town_center`）。 */
export function buildingKeyOf(id: string): string {
  return `buildings/${id}`;
}

/** 資源ノードも id から引く。 */
export function resourceKeyOf(id: string): string {
  return `resources/${id}`;
}

export class AtlasSpriteProvider implements SpriteProvider {
  readonly kind = 'atlas';

  private image: AtlasImage | null = null;
  private manifest: AtlasManifest | null = null;
  /** 引き当てに失敗したキー（1 回だけ警告するため）。 */
  private readonly missing = new Set<string>();

  /** 読み込み済みの image と manifest を渡す（読み込み自体は `loadAtlas` が行う）。 */
  constructor(image?: AtlasImage, manifest?: AtlasManifest) {
    if (image !== undefined && manifest !== undefined) {
      this.image = image;
      this.manifest = manifest;
    }
  }

  adopt(image: AtlasImage, manifest: AtlasManifest): void {
    this.image = image;
    this.manifest = manifest;
  }

  ready(): boolean {
    return this.image !== null && this.manifest !== null;
  }

  /** 引き当てに失敗したキーの一覧（デバッグ表示用）。 */
  missingKeys(): readonly string[] {
    return Array.from(this.missing).sort();
  }

  private frame(key: string | null): AtlasFrame | null {
    if (key === null || this.manifest === null) return null;
    const f = this.manifest.frames[key];
    if (f === undefined) {
      this.missing.add(key);
      return null;
    }
    return f;
  }

  /**
   * アトラスの 1 枚を「足元 (sx, sy) に高さ h px で」描く。
   * 絵の縦横比は保つ（潰すとシルエットが読めなくなる）。
   */
  private blit(ctx: Ctx2D, f: AtlasFrame, sx: number, sy: number, hPx: number): void {
    const img = this.image;
    if (img === null) return;
    const scale = hPx / f.h;
    const w = f.w * scale;
    ctx.drawImage(img, f.x, f.y, f.w, f.h, sx - w / 2, sy - hPx, w, hPx);
  }

  drawUnit(ctx: Ctx2D, sx: number, sy: number, v: UnitSpriteView): void {
    const f = this.frame(spriteKeyOf(unitDef(v.typeId).sprite));
    if (f === null) {
      // 絵が無いユニットだけ図形で描く（全体が消えるより 1 体だけ丸のほうがよい）
      ctx.fillStyle = v.color;
      ctx.beginPath();
      ctx.arc(sx, sy - v.radiusPx, v.radiusPx, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    // 接地の影。絵には影を焼いていないので描画側で足す。
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath();
    ctx.ellipse(sx, sy, v.radiusPx * 0.9, v.radiusPx * 0.4, 0, 0, Math.PI * 2);
    ctx.fill();
    // 陣営色の足元リング（絵は無染色なので、これが所有者の唯一の手がかり）
    ctx.strokeStyle = v.color;
    ctx.lineWidth = Math.max(1, v.radiusPx * 0.22);
    ctx.beginPath();
    ctx.ellipse(sx, sy, v.radiusPx * 0.9, v.radiusPx * 0.4, 0, 0, Math.PI * 2);
    ctx.stroke();
    // 本体。絵の高さは半径の 3 倍ぶん（頭身がだいたい合う倍率）。
    this.blit(ctx, f, sx, sy, v.radiusPx * UNIT_HEIGHT_MUL);
    // 向きは左右反転で表す（8 方向ぶんの絵は持たない。`ISSUES.md` に記録）。
    // 反転はここでは行わない ―― ctx.scale で 1 体ずつ反転すると状態の出し入れが増えて重い。
  }

  drawBuilding(ctx: Ctx2D, sx: number, sy: number, v: BuildingSpriteView): void {
    const f = this.frame(buildingKeyOf(buildingDef(v.typeId).id));
    if (f === null) {
      ctx.fillStyle = v.color;
      ctx.fillRect(sx - v.wPx / 2, sy - v.hPx, v.wPx, v.hPx);
      return;
    }
    this.blit(ctx, f, sx, sy, v.hPx);
    // 建設中は上から暗幕をかける（`05§9` の「体力バーが進捗を兼ねる」の視覚版）
    if (v.buildRatio < 1) {
      const hidden = v.hPx * (1 - v.buildRatio);
      ctx.fillStyle = 'rgba(20,18,14,0.55)';
      ctx.fillRect(sx - v.wPx / 2, sy - v.hPx, v.wPx, hidden);
    }
    // 陣営色は接地の縁だけに出す（建物の絵を塗り替えない）
    ctx.strokeStyle = v.color;
    ctx.lineWidth = Math.max(1, v.wPx * 0.04);
    ctx.beginPath();
    ctx.ellipse(sx, sy, v.wPx * 0.45, v.wPx * 0.2, 0, 0, Math.PI * 2);
    ctx.stroke();
  }

  drawResource(ctx: Ctx2D, sx: number, sy: number, v: ResourceSpriteView): void {
    const f = this.frame(resourceKeyOf(resourceNodeDef(v.typeId).id));
    if (f === null) {
      // 資源ノードの絵はまだ作っていない（地形と一緒に描くほうが自然なので保留）。
      ctx.fillStyle = v.color;
      ctx.beginPath();
      ctx.moveTo(sx, sy - v.radiusPx * 2);
      ctx.lineTo(sx + v.radiusPx, sy - v.radiusPx);
      ctx.lineTo(sx, sy);
      ctx.lineTo(sx - v.radiusPx, sy - v.radiusPx);
      ctx.closePath();
      ctx.fill();
      return;
    }
    this.blit(ctx, f, sx, sy, v.radiusPx * 2.4);
  }
}

/** ユニットの絵の高さ ÷ 当たり半径。見た目が合う倍率（描画だけなので数値をここに置く）。 */
const UNIT_HEIGHT_MUL = 3.2;

/**
 * アトラスを読み込む。**失敗しても投げない**（絵が無くても遊べるのが前提）。
 * 戻り値は差し替え済みかどうか。
 */
export async function loadAtlas(
  provider: AtlasSpriteProvider,
  baseUrl = 'assets/',
): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}manifest.json`);
    if (!res.ok) return false;
    const manifest = parseManifest(await res.json());
    const img = await new Promise<HTMLImageElement | null>((resolve) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => resolve(null);
      el.src = `${baseUrl}${manifest.image}`;
    });
    if (img === null) return false;
    provider.adopt(img as AtlasImage, manifest);
    return true;
  } catch {
    // 開発中はアセットが無いのが普通。静かにプレースホルダのままにする。
    return false;
  }
}
