/**
 * 天気の演出（docs/02_ゲーム実装プラン/06_クライアント設計.md §2）
 *
 * 雨・霧・曇りを画面全体のエフェクトで表す。地形やアクターには触らない。
 *
 * 方針:
 * - 雨は `ParticleContainer` ではなく1枚の `Graphics` に線をまとめて描く
 *   （粒ごとにスプライトを持つより軽い。粒は300でも1回のdrawで済む）
 * - スマホは粒を1/3にする（docs §7 の対策）
 * - `prefers-reduced-motion` では動きを止める
 */
import { Container, Graphics } from 'pixi.js';
import type { Layers } from './stage.ts';

/** 雨粒の最大数（PC）。スマホは1/3 */
const RAIN_DROPS = 260;
/** 雨粒の落下速度（px/秒） */
const RAIN_SPEED = 900;
/** 霧の帯の枚数 */
const FOG_BANDS = 5;

interface Drop {
  x: number;
  y: number;
  len: number;
  speed: number;
}

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function isMobile(): boolean {
  return window.matchMedia('(pointer: coarse)').matches;
}

export class WeatherLayer {
  private root: Container;
  private rain: Graphics;
  private fog: Graphics;
  private drops: Drop[] = [];
  private weather = 'clear';
  /** 表示の強さ 0..1（天気が変わったときになめらかに切り替える） */
  private strength = 0;
  private goal = 0;
  private w = 0;
  private h = 0;
  private t = 0;
  private reduced = prefersReducedMotion();
  private maxDrops = isMobile() ? Math.round(RAIN_DROPS / 3) : RAIN_DROPS;

  // 注意: Node の type-stripping で動かすため parameter property は使えない
  constructor(layers: Pick<Layers, 'overlayRoot'>) {
    this.root = new Container({ label: 'weather' });
    this.root.eventMode = 'none';
    this.rain = new Graphics();
    this.fog = new Graphics();
    this.root.addChild(this.fog, this.rain);
    layers.overlayRoot.addChild(this.root);
  }

  setWeather(weather: string): void {
    this.weather = weather;
    this.goal = weather === 'rain' ? 1 : weather === 'fog' ? 1 : weather === 'cloudy' ? 0.35 : 0;
  }

  /** 画面サイズが変わったら粒を作り直す */
  private ensureDrops(w: number, h: number): void {
    if (this.drops.length === this.maxDrops && this.w === w && this.h === h) return;
    this.w = w;
    this.h = h;
    this.drops = [];
    for (let i = 0; i < this.maxDrops; i++) {
      // 決定論的にばらす（Math.random を使わない方針に合わせる）
      const a = (i * 2654435761) % 100000;
      const b = (i * 40503 + 12345) % 100000;
      this.drops.push({
        x: (a / 100000) * (w + 200) - 100,
        y: (b / 100000) * h,
        len: 10 + ((a >> 3) % 12),
        speed: RAIN_SPEED * (0.8 + ((b >> 5) % 40) / 100),
      });
    }
  }

  update(w: number, h: number, dtSec: number): void {
    this.ensureDrops(w, h);
    this.t += dtSec;

    // 強さをなめらかに寄せる（天気が変わった瞬間に土砂降りにならない）
    this.strength += (this.goal - this.strength) * Math.min(1, dtSec * 0.8);
    if (this.strength < 0.01 && this.goal === 0) {
      this.root.visible = false;
      return;
    }
    this.root.visible = true;

    this.drawRain(dtSec);
    this.drawFog(w, h);
  }

  private drawRain(dtSec: number): void {
    this.rain.clear();
    if (this.weather !== 'rain' || this.strength <= 0.02) return;

    const alpha = 0.35 * this.strength;
    // 斜めに降らせる（風の表現）。動きを止める設定のときは位置を更新しない
    const dy = this.reduced ? 0 : dtSec;
    for (const d of this.drops) {
      if (dy > 0) {
        d.y += d.speed * dy;
        d.x += d.speed * 0.25 * dy;
        if (d.y > this.h) {
          d.y = -d.len;
          d.x = (d.x + 137) % (this.w + 200) - 100;
        }
      }
      this.rain.moveTo(d.x, d.y).lineTo(d.x - d.len * 0.25, d.y + d.len);
    }
    this.rain.stroke({ width: 1.4, color: 0xdff3ff, alpha });
  }

  private drawFog(w: number, h: number): void {
    this.fog.clear();
    const fogStrength = this.weather === 'fog' ? this.strength : 0;
    if (fogStrength <= 0.02) return;

    // 横に流れる帯を重ねる（一様な白より「霧が出ている」感じが出る）
    for (let i = 0; i < FOG_BANDS; i++) {
      const bandH = h / FOG_BANDS;
      const y = i * bandH;
      const drift = this.reduced ? 0 : Math.sin(this.t * 0.12 + i) * 40;
      this.fog.rect(-60 + drift, y, w + 120, bandH * 1.1);
      this.fog.fill({ color: 0xffffff, alpha: 0.1 * fogStrength * (0.6 + (i % 2) * 0.4) });
    }
  }

  /** メトリクス表示用 */
  get dropCount(): number {
    return this.weather === 'rain' ? this.drops.length : 0;
  }
}
