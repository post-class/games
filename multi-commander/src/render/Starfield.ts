import {
  AdditiveBlending,
  BackSide,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Points,
  PointsMaterial,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  Vector3,
  type Camera,
} from 'three';
import { Rng } from '../core/rng';
import { texture, textureAlpha, type NebulaTexId, type PlanetTexId } from './textures';

const SKY_RADIUS = 9000;
/**
 * 星雲に掛ける減彩のティント。
 * 乗算されるので、鮮やかな青緑がそのまま画面を占めるのを防ぎつつ、
 * 星雲そのものは消さない。
 */
const NEBULA_TINT = 0xb9c6cc;

// ───────── 星 ─────────

function starLayer(count: number, size: number, seed: number, bright: number): Points {
  const rng = new Rng(seed);
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const c = new Color();
  for (let i = 0; i < count; i++) {
    // 球面上に一様分布
    const u = rng.next() * 2 - 1;
    const t = rng.next() * Math.PI * 2;
    const r = Math.sqrt(1 - u * u);
    pos[i * 3] = r * Math.cos(t) * SKY_RADIUS;
    pos[i * 3 + 1] = u * SKY_RADIUS;
    pos[i * 3 + 2] = r * Math.sin(t) * SKY_RADIUS;

    // 恒星の色温度をばらす。少数だけ強く色付いた星を混ぜる
    const vivid = rng.chance(0.12);
    const h = vivid ? rng.pick([0.02, 0.09, 0.55, 0.62]) : 0.55 + rng.signed(0.1);
    const s = vivid ? rng.range(0.45, 0.8) : rng.range(0, 0.28);
    const l = bright * rng.range(0.4, 1);
    c.setHSL(h, s, l);
    col[i * 3] = c.r;
    col[i * 3 + 1] = c.g;
    col[i * 3 + 2] = c.b;
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(pos, 3));
  geo.setAttribute('color', new BufferAttribute(col, 3));
  const mat = new PointsMaterial({
    size,
    sizeAttenuation: false,
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    map: dotTexture(),
    alphaTest: 0.02,
  });
  const p = new Points(geo, mat);
  p.frustumCulled = false;
  return p;
}

let dotTex: CanvasTexture | undefined;
/** 星を四角い点ではなく丸く見せるための小さなテクスチャ */
function dotTexture(): CanvasTexture {
  if (dotTex) return dotTex;
  const s = 32;
  const cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const ctx = cv.getContext('2d')!;
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.4, 'rgba(255,255,255,0.75)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  dotTex = new CanvasTexture(cv);
  return dotTex;
}

// ───────── 星雲 ─────────

/** 値ノイズを重ねた雲のテクスチャ。層を重ねる前提で薄く作る。 */
function nebulaTexture(seed: number, hue: number, octaves = 4): CanvasTexture {
  const size = 512;
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d')!;
  const rng = new Rng(seed);
  ctx.clearRect(0, 0, size, size);

  // 大小のブロブを重ねて雲状の濃淡を作る
  for (let o = 0; o < octaves; o++) {
    const count = 6 + o * 10;
    const scale = 0.42 / (o + 1);
    for (let i = 0; i < count; i++) {
      const x = rng.range(0.15, 0.85) * size;
      const y = rng.range(0.15, 0.85) * size;
      const r = rng.range(scale * 0.4, scale) * size;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      const c = new Color().setHSL(
        hue + rng.signed(0.09),
        rng.range(0.3, 0.62),
        rng.range(0.24, 0.5),
      );
      const a = 0.055 + 0.05 / (o + 1);
      g.addColorStop(0, `rgba(${(c.r * 255) | 0},${(c.g * 255) | 0},${(c.b * 255) | 0},${a})`);
      g.addColorStop(0.55, `rgba(${(c.r * 255) | 0},${(c.g * 255) | 0},${(c.b * 255) | 0},${a * 0.35})`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, size, size);
    }
  }

  // 星雲の中に埋まった若い星をいくつか
  for (let i = 0; i < 40; i++) {
    const x = rng.range(0.2, 0.8) * size;
    const y = rng.range(0.2, 0.8) * size;
    const r = rng.range(0.6, 2.2);
    ctx.fillStyle = `rgba(255,255,255,${rng.range(0.25, 0.8)})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // スプライトの矩形の縁が空に出ないよう、外周を円形にフェードさせる
  ctx.globalCompositeOperation = 'destination-in';
  const mask = ctx.createRadialGradient(size / 2, size / 2, size * 0.08, size / 2, size / 2, size * 0.5);
  mask.addColorStop(0, 'rgba(0,0,0,1)');
  mask.addColorStop(0.6, 'rgba(0,0,0,0.7)');
  mask.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = mask;
  ctx.fillRect(0, 0, size, size);
  ctx.globalCompositeOperation = 'source-over';

  const tex = new CanvasTexture(cv);
  tex.needsUpdate = true;
  return tex;
}

/** 惑星表面のテクスチャ (帯状の模様 + 極冠) */
function planetTexture(seed: number, base: number): CanvasTexture {
  const w = 512;
  const h = 256;
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d')!;
  const rng = new Rng(seed);
  const c = new Color(base);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);

  ctx.fillStyle = `#${c.getHexString()}`;
  ctx.fillRect(0, 0, w, h);

  // 緯度ごとの帯
  for (let i = 0; i < 26; i++) {
    const y = rng.range(0, h);
    const bandH = rng.range(3, 22);
    const cc = new Color().setHSL(
      hsl.h + rng.signed(0.05),
      Math.min(1, hsl.s * rng.range(0.6, 1.4)),
      Math.min(1, hsl.l * rng.range(0.55, 1.5)),
    );
    ctx.fillStyle = `rgba(${(cc.r * 255) | 0},${(cc.g * 255) | 0},${(cc.b * 255) | 0},0.5)`;
    ctx.fillRect(0, y, w, bandH);
  }
  // 渦のような塊
  for (let i = 0; i < 40; i++) {
    const x = rng.range(0, w);
    const y = rng.range(h * 0.15, h * 0.85);
    const r = rng.range(4, 26);
    const cc = new Color().setHSL(hsl.h + rng.signed(0.06), hsl.s, Math.min(1, hsl.l * rng.range(0.5, 1.7)));
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(${(cc.r * 255) | 0},${(cc.g * 255) | 0},${(cc.b * 255) | 0},0.55)`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(x, y, r * rng.range(1.2, 2.6), r * 0.6, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  // 極冠
  const cap = ctx.createLinearGradient(0, 0, 0, h * 0.13);
  cap.addColorStop(0, 'rgba(235,245,255,0.75)');
  cap.addColorStop(1, 'rgba(235,245,255,0)');
  ctx.fillStyle = cap;
  ctx.fillRect(0, 0, w, h * 0.13);
  const cap2 = ctx.createLinearGradient(0, h, 0, h * 0.87);
  cap2.addColorStop(0, 'rgba(235,245,255,0.7)');
  cap2.addColorStop(1, 'rgba(235,245,255,0)');
  ctx.fillStyle = cap2;
  ctx.fillRect(0, h * 0.87, w, h * 0.13);

  return new CanvasTexture(cv);
}

export interface SkyboxOptions {
  /** 星雲の色相 (生成テクスチャを使わないときの塗り色) */
  nebulaHue?: number;
  /** 惑星を出すか */
  planet?: boolean;
  planetColor?: number;
  /** 惑星の表面に貼る生成テクスチャ。未指定なら Canvas 生成にフォールバック */
  planetTexture?: PlanetTexId;
  /** 星雲に使う生成テクスチャ (複数指定すると散らして置く) */
  nebulae?: NebulaTexId[];
  /** 太陽の色 */
  sunColor?: number;
  seed?: number;
}

/**
 * カメラに追従する遠景。
 * 星3層 + 多層の星雲 + 表面模様と大気を持つ惑星 + 太陽 + 遠方の小天体。
 * 常にカメラ位置へ移動するので、どれだけ飛んでも近づかない。
 */
export class Skybox {
  readonly group = new Group();
  private sunDir = new Vector3(0.4, 0.35, -0.85).normalize();

  constructor(opts: SkyboxOptions = {}) {
    const seed = opts.seed ?? 12345;
    const rng = new Rng(seed ^ 0x5bf03635);

    // ── 深宇宙の地色 (完全な黒より、わずかに色が乗っている方が奥行きが出る) ──
    const backdrop = new Mesh(
      new SphereGeometry(SKY_RADIUS * 1.02, 24, 16),
      new MeshBasicMaterial({ color: 0x05070c, side: BackSide, depthWrite: false }),
    );
    this.group.add(backdrop);

    // ── 星 ──
    this.group.add(starLayer(2200, 2.0, seed, 0.62));
    this.group.add(starLayer(4200, 1.3, seed + 977, 0.38));
    this.group.add(starLayer(6000, 0.85, seed + 4231, 0.24));

    // ── 星雲 (大きな層 + それに重なる細かい層) ──
    // 生成テクスチャが指定されていればそれを使う。無ければ Canvas 生成にフォールバックする
    const hue = opts.nebulaHue ?? 0.62;
    const nebIds = opts.nebulae;
    for (let i = 0; i < 6; i++) {
      const big = i < 3;
      const map = nebIds?.length
        ? textureAlpha(nebIds[i % nebIds.length])
        : nebulaTexture(seed + i * 31, hue + rng.signed(0.07), big ? 3 : 5);
      const spr = new Sprite(
        new SpriteMaterial({
          map,
          blending: AdditiveBlending,
          depthWrite: false,
          depthTest: false,
          transparent: true,
          // 生成テクスチャは元から濃いので薄めに乗せる。
          // 星雲が主役になって敵機と照準の可読性を奪っていたため、
          // 層の数と作り込みは保ったまま濃度と彩度だけを落としている。
          opacity: nebIds?.length ? (big ? 0.12 : 0.06) : big ? 0.17 : 0.1,
          color: NEBULA_TINT,
        }),
      );
      const dir = new Vector3(rng.signed(1), rng.signed(0.7), rng.signed(1)).normalize();
      spr.position.copy(dir).multiplyScalar(SKY_RADIUS * 0.88);
      spr.scale.setScalar(SKY_RADIUS * (big ? rng.range(1.0, 1.5) : rng.range(0.4, 0.8)));
      spr.material.rotation = rng.range(0, Math.PI * 2);
      this.group.add(spr);
    }

    // ── 惑星 ──
    if (opts.planet !== false) {
      const planetColor = opts.planetColor ?? 0x16324f;
      // 惑星は「そこにある」ことが伝われば十分。画面を占領しない大きさに抑える
      const pr = SKY_RADIUS * 0.052;
      const planet = new Mesh(
        new SphereGeometry(pr, 48, 32),
        new MeshStandardMaterial({
          map: opts.planetTexture
            ? texture(opts.planetTexture)
            : planetTexture(seed + 7, planetColor),
          roughness: 1,
          metalness: 0,
        }),
      );
      const planetPos = new Vector3(-0.55, -0.3, -0.8).normalize().multiplyScalar(SKY_RADIUS * 0.72);
      planet.position.copy(planetPos);
      planet.rotation.z = 0.22;
      this.group.add(planet);

      // 大気: 内側から外側へ薄くなる2枚重ね
      for (const [scale, opacity] of [
        [1.03, 0.16],
        [1.1, 0.07],
      ] as Array<[number, number]>) {
        const halo = new Mesh(
          new SphereGeometry(pr * scale, 32, 22),
          new MeshBasicMaterial({
            color: brighten(planetColor),
            transparent: true,
            opacity,
            blending: AdditiveBlending,
            depthWrite: false,
            side: BackSide,
          }),
        );
        halo.position.copy(planetPos);
        this.group.add(halo);
      }

      // 環 (半分の確率で)
      if (rng.chance(0.45)) {
        const ring = new Mesh(
          new SphereGeometry(pr * 1.9, 40, 2),
          new MeshBasicMaterial({
            color: 0x9fb2c8,
            transparent: true,
            opacity: 0.16,
            blending: AdditiveBlending,
            depthWrite: false,
            side: BackSide,
          }),
        );
        ring.position.copy(planetPos);
        ring.scale.set(1, 0.03, 1);
        ring.rotation.set(0.4, 0, 0.3);
        this.group.add(ring);
      }

      // 衛星
      const moon = new Mesh(
        new SphereGeometry(pr * 0.22, 20, 14),
        new MeshStandardMaterial({ color: 0x6b6f77, roughness: 1, metalness: 0 }),
      );
      moon.position
        .copy(planetPos)
        .add(new Vector3(pr * 1.9, pr * 1.1, pr * 0.4));
      this.group.add(moon);
    }

    // ── 太陽 ──
    // 目標テキストや敵機と視線を奪い合っていたので、芯・コロナ・フレアの
    // すべてを小さく・薄くする。太陽の存在と光の向きは残す。
    const sun = new Mesh(
      new SphereGeometry(SKY_RADIUS * 0.019, 24, 16),
      new MeshBasicMaterial({ color: opts.sunColor ?? 0xfff2d0 }),
    );
    sun.position.copy(this.sunDir).multiplyScalar(SKY_RADIUS * 0.8);
    this.group.add(sun);
    // コロナ。生成テクスチャで芯と streamers を描き、外側に Canvas の滲みを重ねる
    const coronaLayers: Array<[number, number, boolean]> = [
      [0.22, 0.55, true],
      [0.45, 0.2, false],
      [0.85, 0.09, false],
    ];
    for (const [scale, opacity, generated] of coronaLayers) {
      const glow = new Sprite(
        new SpriteMaterial({
          map: generated ? textureAlpha('sun-corona') : sunGlowTexture(),
          blending: AdditiveBlending,
          depthWrite: false,
          depthTest: false,
          transparent: true,
          opacity,
          color: generated ? 0xffffff : (opts.sunColor ?? 0xfff2d0),
        }),
      );
      glow.position.copy(sun.position);
      glow.scale.setScalar(SKY_RADIUS * scale);
      this.group.add(glow);
    }
    // 横に伸びるレンズフレア (太陽が視界に入っているという情報になる)
    const flare = new Sprite(
      new SpriteMaterial({
        map: textureAlpha('sun-flare'),
        blending: AdditiveBlending,
        depthWrite: false,
        depthTest: false,
        transparent: true,
        opacity: 0.24,
      }),
    );
    flare.position.copy(sun.position);
    flare.scale.set(SKY_RADIUS * 1.05, SKY_RADIUS * 0.34, 1);
    this.group.add(flare);

    // ── 遠方の小天体 (視差のない岩塊。宇宙が空虚に見えないように) ──
    const rockMat = new MeshStandardMaterial({ color: 0x4a4740, roughness: 1, metalness: 0.1, flatShading: true });
    for (let i = 0; i < 14; i++) {
      const rock = new Mesh(new SphereGeometry(SKY_RADIUS * rng.range(0.0012, 0.004), 7, 5), rockMat);
      const dir = new Vector3(rng.signed(1), rng.signed(0.5), rng.signed(1)).normalize();
      rock.position.copy(dir).multiplyScalar(SKY_RADIUS * rng.range(0.45, 0.7));
      rock.scale.set(rng.range(0.7, 1.4), rng.range(0.6, 1.2), rng.range(0.8, 1.6));
      this.group.add(rock);
    }

    this.group.renderOrder = -1;
    for (const c of this.group.children) c.frustumCulled = false;
  }

  get sunDirection(): Vector3 {
    return this.sunDir;
  }

  update(camera: Camera): void {
    this.group.position.copy(camera.position);
  }
}

let sunTex: CanvasTexture | undefined;
function sunGlowTexture(): CanvasTexture {
  if (sunTex) return sunTex;
  const s = 256;
  const cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const ctx = cv.getContext('2d')!;
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.12, 'rgba(255,246,220,0.75)');
  g.addColorStop(0.35, 'rgba(255,220,150,0.22)');
  g.addColorStop(1, 'rgba(255,200,120,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  sunTex = new CanvasTexture(cv);
  return sunTex;
}

function brighten(color: number): number {
  const c = new Color(color);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  c.setHSL(hsl.h, Math.min(1, hsl.s * 1.2), Math.min(1, hsl.l * 2.6 + 0.18));
  return c.getHex();
}
