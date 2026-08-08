/**
 * 演出（docs/02_ゲーム実装プラン/06_クライアント設計.md §2 の overlayRoot / tint）
 *
 * - `TimeTint`: 時間帯の色被せ
 * - `NightSky`: 星空と月（F-1）
 *
 * どちらもカメラ非依存なので overlayRoot に置く。
 * 星と月は「空」なのでカメラで動かさないほうが自然（歩いても星座が流れない）。
 */
import { Container, Graphics, Sprite, Texture } from 'pixi.js';
import type { Layers } from './stage.ts';

interface TintStyle {
  color: number;
  alpha: number;
}

/**
 * 時間帯の色被せ。
 *
 * F-1: 夜は `alpha 0.3` だと草地が20%暗くなるだけで「夜」に見えなかったので 0.5 まで上げた
 * （宣伝資料 `screen-ecosystem.png` の夜は濃紺）。夕も同じ理由で 0.16 → 0.26。
 * これ以上暗くするとキャラが読めなくなるので、明るさは `lights.ts` の加算光で補う。
 */
export const TOD_TINT: Record<string, TintStyle> = {
  morning: { color: 0xffd9a0, alpha: 0.1 },
  day: { color: 0xffffff, alpha: 0 },
  evening: { color: 0xff9a6a, alpha: 0.26 },
  night: { color: 0x24356e, alpha: 0.5 },
};

export class TimeTint {
  private readonly g: Graphics;
  private w = 0;
  private h = 0;
  private current: TintStyle = { color: 0xffffff, alpha: 0 };
  /** 目標値へゆっくり寄せる（時間帯が切り替わった瞬間に色が飛ばないように） */
  private goal: TintStyle = { color: 0xffffff, alpha: 0 };

  constructor(layers: Pick<Layers, 'overlayRoot'>) {
    this.g = new Graphics();
    this.g.eventMode = 'none';
    layers.overlayRoot.addChild(this.g);
  }

  setTimeOfDay(tod: string): void {
    this.goal = TOD_TINT[tod] ?? TOD_TINT['day'] ?? { color: 0xffffff, alpha: 0 };
  }

  update(w: number, h: number, dtSec: number): void {
    const k = Math.min(1, dtSec * 1.5);
    this.current = {
      color: this.goal.color,
      alpha: this.current.alpha + (this.goal.alpha - this.current.alpha) * k,
    };
    if (w !== this.w || h !== this.h) {
      this.w = w;
      this.h = h;
      this.g.clear();
      this.g.rect(0, 0, w, h).fill(0xffffff);
    }
    this.g.tint = this.current.color;
    this.g.alpha = this.current.alpha;
  }
}

// ==================== 星空と月（F-1） ====================

/** 星の数（PC）。スマホは1/3（weather.ts と同じ方針） */
const STAR_COUNT = 120;
/**
 * 月のテクスチャの一辺（px）。実際の月の玉はこの 0.52 倍くらい（残りは暈のぶん）。
 * 大きくすると「空の月」ではなく「地面に置かれた玉」に見えてしまうので小さめにしている。
 */
const MOON_PX = 60;
/** 月の満ち欠けの周期（島日）。8日で新月→満月→新月 */
export const MOON_CYCLE_DAYS = 8;

/** 時間帯ごとの星空の見え方 0..1。昼は 0（1枚も描かない） */
const SKY_STRENGTH: Record<string, number> = {
  morning: 0.08,
  day: 0,
  evening: 0.3,
  night: 1,
};

export function nightSkyStrength(tod: string): number {
  return SKY_STRENGTH[tod] ?? 0;
}

export interface StarDot {
  x: number;
  y: number;
  r: number;
  alpha: number;
  /** 明滅のグループ（0/1）。2枚のGraphicsに振り分けて交互に瞬かせる */
  group: number;
}

/**
 * 星の位置を決定論的に決める（`Math.random` を毎フレーム呼ばない方針）。
 * 上のほうを濃く、下へ向かって薄くする（真上見下ろしでも「空が覗いている」ように見せたい）。
 */
export function starPositions(count: number, w: number, h: number): StarDot[] {
  const out: StarDot[] = [];
  for (let i = 0; i < count; i++) {
    // weather.ts の粒と同じ流儀の擬似乱数（乗算ハッシュ）
    const a = (i * 2654435761) % 100000;
    const b = (i * 40503 + 12345) % 100000;
    const c = (i * 69069 + 1) % 100000;
    const ny = b / 100000;
    out.push({
      x: (a / 100000) * w,
      // ny を2乗して上側に寄せる
      y: ny * ny * h,
      r: 0.8 + ((c >> 4) % 12) / 10,
      // 下にある星は薄く（地面に星があるように見えないように）
      alpha: (0.45 + ((c >> 9) % 55) / 100) * (1 - ny * 0.55),
      group: i % 2,
    });
  }
  return out;
}

export interface MoonPhase {
  /** 光っている割合 0..1（0=新月 / 1=満月） */
  illum: number;
  /** 満ちていく側（右が光る）か */
  waxing: boolean;
}

/** 島日から月の満ち欠けを決める。1日目を新月の翌日にして、真っ暗な月が続かないようにする */
export function moonPhase(islandDay: number): MoonPhase {
  const p = (((islandDay % MOON_CYCLE_DAYS) + MOON_CYCLE_DAYS) % MOON_CYCLE_DAYS) / MOON_CYCLE_DAYS;
  return { illum: 1 - Math.abs(2 * p - 1), waxing: p < 0.5 };
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function isMobile(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;
}

/**
 * 月のテクスチャを作る。
 *
 * Graphics では「円から円を引く」が素直に書けないので、canvas の `destination-out` で欠けを抜く。
 * 満ち欠けが変わったときだけ作り直す（1日1回程度）。
 */
export function drawMoonCanvas(canvas: HTMLCanvasElement, size: number, phase: MoonPhase): void {
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, size, size);

  const cx = size / 2;
  const cy = size / 2;
  const r = size * 0.26;

  // 淡い暈（かさ）。月の周りがぼんやり光る
  const halo = ctx.createRadialGradient(cx, cy, r * 0.6, cx, cy, size * 0.5);
  halo.addColorStop(0, 'rgba(255, 249, 214, 0.34)');
  halo.addColorStop(1, 'rgba(255, 249, 214, 0)');
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, size, size);

  // 本体（スタイルガイドの灯り色 #ffcf7a を明るく寄せた色）
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = '#fff3c4';
  ctx.fill();

  // 欠けを抜く。同じ半径の円を 2r*illum ずらすと illum=1 で重ならない＝満月になる
  const d = 2 * r * phase.illum;
  if (d < 2 * r) {
    ctx.globalCompositeOperation = 'destination-out';
    ctx.beginPath();
    ctx.arc(cx + (phase.waxing ? -d : d), cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
  }
}

/**
 * 星空と月のオーバーレイ。
 *
 * 星は2枚の `Graphics` にまとめて描き（weather.ts と同じ「1枚にまとめる」方針）、
 * 明滅はコンテナの alpha を触るだけで済ませる。星ごとに alpha を動かすと毎フレーム再描画になるため。
 */
export class NightSky {
  private root: Container;
  private starsA: Graphics;
  private starsB: Graphics;
  private moon: Sprite | null = null;
  private moonCanvas: HTMLCanvasElement | null = null;
  private moonIllum = -1;
  private moonWaxing = true;
  private w = 0;
  private h = 0;
  private t = 0;
  private strength = 0;
  private goal = 0;
  private reduced = prefersReducedMotion();
  private count = isMobile() ? Math.round(STAR_COUNT / 3) : STAR_COUNT;

  // 注意: Node の type-stripping で動かすため parameter property は使えない
  constructor(layers: Pick<Layers, 'overlayRoot'>) {
    this.root = new Container({ label: 'nightSky' });
    this.root.eventMode = 'none';
    this.root.visible = false;
    this.starsA = new Graphics();
    this.starsB = new Graphics();
    this.root.addChild(this.starsA, this.starsB);
    layers.overlayRoot.addChild(this.root);
  }

  setTimeOfDay(tod: string): void {
    this.goal = nightSkyStrength(tod);
  }

  /** 島日から満ち欠けを更新する（値が変わったときだけテクスチャを作り直す） */
  setIslandDay(islandDay: number): void {
    const phase = moonPhase(islandDay);
    if (Math.abs(phase.illum - this.moonIllum) < 1e-6 && phase.waxing === this.moonWaxing) return;
    this.moonIllum = phase.illum;
    this.moonWaxing = phase.waxing;
    if (typeof document === 'undefined') return;
    if (!this.moonCanvas) this.moonCanvas = document.createElement('canvas');
    drawMoonCanvas(this.moonCanvas, MOON_PX * 2, phase);
    if (!this.moon) {
      this.moon = new Sprite(Texture.from(this.moonCanvas));
      this.moon.eventMode = 'none';
      this.moon.width = MOON_PX * 2;
      this.moon.height = MOON_PX * 2;
      this.root.addChild(this.moon);
    } else {
      // canvas の中身を差し替えたので、GPU 側のテクスチャを更新させる
      this.moon.texture.source.update();
    }
  }

  private rebuild(w: number, h: number): void {
    this.w = w;
    this.h = h;
    this.starsA.clear();
    this.starsB.clear();
    for (const s of starPositions(this.count, w, h)) {
      const g = s.group === 0 ? this.starsA : this.starsB;
      g.circle(s.x, s.y, s.r).fill({ color: 0xfff6d8, alpha: s.alpha });
    }
    if (this.moon) {
      // 宣伝資料 screen-ecosystem.png と同じ右上寄りに置く。ただし**そのまま右上だと
      // ミニマップに完全に隠れた**ので、ミニマップ（幅170px前後）の左どなりへずらす。
      // 上端で少し切れるようにするのがコツで、そうすると「画面の外へ続く空」に見える
      // （切らずに全部見せると地面に置かれた玉に見えてしまった）。
      const cx = w > 900 ? w - 300 : w * 0.5;
      this.moon.x = cx - MOON_PX;
      this.moon.y = -MOON_PX * 0.45;
    }
  }

  update(w: number, h: number, dtSec: number): void {
    // 時間帯の切り替えは TimeTint と同じ速さで寄せる（急に星が出ない）
    this.strength += (this.goal - this.strength) * Math.min(1, dtSec * 1.5);
    if (this.strength < 0.01 && this.goal === 0) {
      this.root.visible = false;
      return;
    }
    this.root.visible = true;
    if (w !== this.w || h !== this.h) this.rebuild(w, h);

    this.t += dtSec;
    // 明滅は prefers-reduced-motion で止める（明るさ自体は変えない）
    const tw = this.reduced ? 0 : 0.18;
    this.starsA.alpha = this.strength * (1 - tw + tw * (0.5 + 0.5 * Math.sin(this.t * 1.7)));
    this.starsB.alpha = this.strength * (1 - tw + tw * (0.5 + 0.5 * Math.sin(this.t * 2.3 + 2.1)));
    if (this.moon) this.moon.alpha = this.strength;
  }
}

// ==================== 季節の色調（F-4） ====================

/**
 * 季節ごとの色被せ。
 *
 * 宣伝資料は「実りの季節には食べものが増え、冬には巣にこもる」と謳っているが、
 * 実装は春夏秋冬でタイルの色も木の絵も変わらず、**4季節のキャプチャが見分けられなかった**。
 *
 * 木のアセットを4季節ぶん用意するのが本来だが、それは枚数が4倍になる。
 * まず色調だけで「別の季節に見える」ところまで持っていく（安く効く分）。
 * `alpha` は控えめにしてある。ここを上げると時間帯の演出（F-1）と喧嘩する。
 */
export const SEASON_TINT: Record<string, TintStyle> = {
  /** 春=やわらかい桃色（花の季節） */
  spring: { color: 0xffd9e2, alpha: 0.1 },
  /** 夏=濃い緑に寄せる（葉が茂る） */
  summer: { color: 0x9fd86a, alpha: 0.12 },
  /** 秋=黄橙（紅葉） */
  autumn: { color: 0xffb45a, alpha: 0.16 },
  /** 冬=白く冷たい（雪と枯れ） */
  winter: { color: 0xdcecff, alpha: 0.2 },
};

export function seasonTintFor(season: string): TintStyle {
  return SEASON_TINT[season] ?? { color: 0xffffff, alpha: 0 };
}

/**
 * 季節の色被せ。`TimeTint` と同じ仕組みだが**別のレイヤ**にしている。
 * 1枚にまとめると「夜の紺」と「秋の黄橙」を混ぜた色を作る必要があり、
 * どちらかを変えるともう一方が崩れる。
 */
export class SeasonTint {
  private readonly g: Graphics;
  private w = 0;
  private h = 0;
  private current: TintStyle = { color: 0xffffff, alpha: 0 };
  private goal: TintStyle = { color: 0xffffff, alpha: 0 };

  constructor(layers: Pick<Layers, 'overlayRoot'>) {
    this.g = new Graphics();
    this.g.eventMode = 'none';
    layers.overlayRoot.addChild(this.g);
  }

  setSeason(season: string): void {
    this.goal = seasonTintFor(season);
  }

  update(w: number, h: number, dtSec: number): void {
    // 季節の切り替わりは島日をまたぐので、時間帯よりさらにゆっくり寄せる
    const k = Math.min(1, dtSec * 0.5);
    this.current = {
      color: this.goal.color,
      alpha: this.current.alpha + (this.goal.alpha - this.current.alpha) * k,
    };
    if (w !== this.w || h !== this.h) {
      this.w = w;
      this.h = h;
      this.g.clear();
      this.g.rect(0, 0, w, h).fill(0xffffff);
    }
    this.g.tint = this.current.color;
    this.g.alpha = this.current.alpha;
  }
}
