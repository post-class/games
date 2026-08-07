/**
 * 夜の光源（F-2 / docs/03_宣伝用との乖離是正プラン/03_タスク詳細.md）
 *
 * 宣伝資料 `screen-ecosystem.png` の夜は、焚き火とランタンが「光の玉」になっていて
 * その周りだけ明るい。F-1 で夜を濃くする（`TOD_TINT.night` を 0.5）ぶんの明るさを
 * ここで取り戻すので、**F-1 と F-2 はセット**で成立する。
 *
 * 方針:
 * - `stage.ts` の `light` レイヤ（`entities` の上・`weather` の下）に加算ブレンドで描く。
 *   worldRoot の中なのでカメラに追従する（＝ワールド座標で置ける）
 * - 光の玉は **1枚の放射グラデーションのテクスチャ**を使い回す。
 *   Graphics で円を重ねると縁が硬くなるし、毎フレーム再描画になる
 * - **夜と夕だけ有効**。昼はレイヤごと `visible = false` にして1枚も描かない
 * - 明滅は `prefers-reduced-motion` で止める（光の強さ自体は変えない）
 * - 対象のオブジェクト（焚き火・家・天文台）はまだ実装が無いので、
 *   **無くても落ちない**（未知の種類は光らせないだけ）
 */
import { Container, Sprite, Texture } from 'pixi.js';
import { TILE_PX } from '@ai-pet/shared';
import type { Layers } from './stage.ts';
import type { Camera } from './camera.ts';
import type { WorldState } from '../state/world.ts';

/** 光源テクスチャの一辺（px）。実表示は spec.radius に合わせて拡縮する */
const GLOW_TEX_PX = 256;

export interface LightSpec {
  /** 光の届く半径（タイル単位） */
  radius: number;
  /** 光の色 */
  color: number;
  /** 加算の強さ 0..1 */
  intensity: number;
  /** 明滅の振れ幅 0..1（0なら明滅しない） */
  flicker: number;
  /** 明滅の速さ（rad/秒） */
  flickerSpeed: number;
  /** 光の中心を足元からどれだけ上へずらすか（タイル単位） */
  lift: number;
}

/**
 * 種類ごとの光り方。
 * 焚き火は大きく揺れ、ランタンは小さく静か、窓は揺れない、天文台は青白い（望遠鏡の灯り）。
 *
 * ⚠️ `intensity` は控えめにしてある。加算ブレンドなので、**明るい地面（広場のクリーム色）の上や
 * 光源が2つ重なったところで白飛びする**（実機で広場のランタンが白い塊になった）。
 * 暗い草地で「ちゃんと光って見える」下限を探した結果がこの値。
 */
const LIGHT_SPECS: Record<string, LightSpec> = {
  lantern: { radius: 3.2, color: 0xffcf7a, intensity: 0.5, flicker: 0.07, flickerSpeed: 3.1, lift: 0.55 },
  campfire: { radius: 4.6, color: 0xffb45a, intensity: 0.62, flicker: 0.16, flickerSpeed: 6.7, lift: 0.4 },
  observatory: { radius: 3.8, color: 0xbfd4ff, intensity: 0.4, flicker: 0.04, flickerSpeed: 1.3, lift: 1.2 },
};

/** 家の窓。`obj_house_a` などの種類がまだ決まっていないので接頭辞で拾う */
const HOUSE_WINDOW: LightSpec = {
  radius: 2.8,
  color: 0xffdf9a,
  intensity: 0.42,
  flicker: 0,
  flickerSpeed: 0,
  lift: 0.7,
};

/**
 * 種類名から光り方を引く。未知の種類は `null`（＝光らせない）。
 * `house_*` は接頭辞でまとめて拾う（アセットが増えても書き換え不要にしたい）。
 */
export function lightSpecFor(type: string): LightSpec | null {
  if (type.startsWith('house')) return HOUSE_WINDOW;
  return LIGHT_SPECS[type] ?? null;
}

/** 時間帯ごとの光の強さ 0..1。昼は 0 */
const TOD_LIGHT: Record<string, number> = {
  morning: 0.12,
  day: 0,
  evening: 0.45,
  night: 1,
};

export function lightStrengthFor(tod: string): number {
  return TOD_LIGHT[tod] ?? 0;
}

/**
 * 明滅の係数。`reduced` のときは 1 を返す（動きだけ止め、明るさは変えない）。
 * `seed` で光源ごとに位相をずらす（全部が同じ拍で揺れると人工的に見える）。
 */
export function flickerFactor(spec: LightSpec, seed: number, t: number, reduced: boolean): number {
  if (reduced || spec.flicker <= 0) return 1;
  const phase = (seed % 97) * 0.6457;
  return 1 - spec.flicker + spec.flicker * (0.5 + 0.5 * Math.sin(t * spec.flickerSpeed + phase));
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * 加算光の玉テクスチャ。中心を白く飛ばし、外へ向かって二段で落とす
 * （一次関数のグラデーションだと「まん丸のシール」に見えてしまう）。
 */
export function drawGlowCanvas(canvas: HTMLCanvasElement, size: number): void {
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const c = size / 2;
  const g = ctx.createRadialGradient(c, c, 0, c, c, c);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.12, 'rgba(255,255,255,0.92)');
  g.addColorStop(0.3, 'rgba(255,255,255,0.5)');
  g.addColorStop(0.6, 'rgba(255,255,255,0.16)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
}

let glowTexture: Texture | null = null;

function getGlowTexture(): Texture {
  if (glowTexture) return glowTexture;
  if (typeof document === 'undefined') return Texture.EMPTY;
  const canvas = document.createElement('canvas');
  drawGlowCanvas(canvas, GLOW_TEX_PX);
  glowTexture = Texture.from(canvas);
  return glowTexture;
}

/** 光源の位置（設置物・建設物のどちらからも作れる最小の形） */
export interface LightSource {
  id: number;
  type: string;
  x: number;
  y: number;
}

interface Entry {
  sprite: Sprite;
  spec: LightSpec;
}

export class LightLayer {
  private root: Container;
  private camera: Camera;
  private sprites = new Map<number, Entry>();
  /** 天文台などの共同建設。完成したものだけ光らせる */
  private constructions: readonly { i: number; ty: string; x: number; y: number; done: boolean }[] = [];
  private strength = 0;
  private goal = 0;
  private t = 0;
  private reduced = prefersReducedMotion();
  private drawnCount = 0;

  // 注意: Node の type-stripping で動かすため parameter property は使えない
  constructor(layers: Pick<Layers, 'light'>, camera: Camera) {
    this.root = new Container({ label: 'lights' });
    this.root.eventMode = 'none';
    this.root.visible = false;
    this.camera = camera;
    layers.light.addChild(this.root);
  }

  setTimeOfDay(tod: string): void {
    this.goal = lightStrengthFor(tod);
  }

  setConstructions(items: readonly { i: number; ty: string; x: number; y: number; done: boolean }[]): void {
    this.constructions = items;
  }

  update(world: WorldState, dtSec: number): void {
    // TimeTint と同じ速さで寄せる（夕から夜へ移るときに光がぬるっと点く）
    this.strength += (this.goal - this.strength) * Math.min(1, dtSec * 1.5);
    if (this.strength < 0.01 && this.goal === 0) {
      // 昼は1枚も描かない。スプライトは残すが renderable を落としてコストを消す
      this.root.visible = false;
      this.drawnCount = 0;
      return;
    }
    this.root.visible = true;
    this.t += dtSec;
    this.drawnCount = 0;

    const rect = this.camera.visibleRect(6);
    const seen = new Set<number>();

    for (const p of world.placeables.values()) {
      if (this.place(p.id, p.type, p.x, p.y, rect)) seen.add(p.id);
    }
    // 資源にも将来 campfire 相当が来るかもしれないので同じ規則で拾う（今は該当なし）
    for (const r of world.resources.values()) {
      if (this.place(r.id, r.type, r.x, r.y, rect)) seen.add(r.id);
    }
    for (const c of this.constructions) {
      if (!c.done) continue;
      if (this.place(c.i, c.ty, c.x, c.y, rect)) seen.add(c.i);
    }

    for (const [id, entry] of this.sprites) {
      if (seen.has(id)) continue;
      entry.sprite.destroy();
      this.sprites.delete(id);
    }
  }

  /** 光源を1つ整える。光らない種類なら false（＝スプライトを作らない） */
  private place(
    id: number,
    type: string,
    x: number,
    y: number,
    rect: { x0: number; y0: number; x1: number; y1: number },
  ): boolean {
    const spec = lightSpecFor(type);
    if (!spec) return false;

    let entry = this.sprites.get(id);
    if (!entry || entry.spec !== spec) {
      if (entry) entry.sprite.destroy();
      const sprite = new Sprite(getGlowTexture());
      sprite.anchor.set(0.5);
      sprite.eventMode = 'none';
      // 加算ブレンド。暗い夜に足すぶんだけ明るくなる
      sprite.blendMode = 'add';
      this.root.addChild(sprite);
      entry = { sprite, spec };
      this.sprites.set(id, entry);
    }

    const s = entry.sprite;
    const d = spec.radius * 2 * TILE_PX;
    s.width = d;
    s.height = d;
    s.x = x * TILE_PX;
    s.y = (y + 0.5 - spec.lift) * TILE_PX;
    s.tint = spec.color;
    s.alpha = spec.intensity * this.strength * flickerFactor(spec, id, this.t, this.reduced);

    // 画面外は描かない（半径ぶん余裕を持たせてあるので、縁で急に消えない）
    const visible =
      x >= rect.x0 - spec.radius &&
      x <= rect.x1 + spec.radius &&
      y >= rect.y0 - spec.radius &&
      y <= rect.y1 + spec.radius;
    s.renderable = visible;
    if (visible) this.drawnCount++;
    return true;
  }

  /** デバッグ表示用 */
  get drawn(): number {
    return this.drawnCount;
  }
}
