import {
  AdditiveBlending,
  CanvasTexture,
  Color,
  Group,
  Mesh,
  MeshBasicMaterial,
  NormalBlending,
  Scene,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  Vector3,
  type Texture,
} from 'three';
import { rng } from '../core/rng';
import { textureAlpha } from './textures';

function glowTexture(inner = 'rgba(255,255,255,1)', mid = 'rgba(255,220,150,0.55)'): CanvasTexture {
  const s = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const ctx = cv.getContext('2d')!;
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, inner);
  g.addColorStop(0.35, mid);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  return new CanvasTexture(cv);
}

function ringTexture(): CanvasTexture {
  const s = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const ctx = cv.getContext('2d')!;
  const g = ctx.createRadialGradient(s / 2, s / 2, s * 0.3, s / 2, s / 2, s / 2);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(0.75, 'rgba(255,200,140,0.8)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  return new CanvasTexture(cv);
}

interface SpriteFx {
  sprite: Sprite;
  life: number;
  maxLife: number;
  size0: number;
  size1: number;
  vel: Vector3;
  opacity0: number;
  spin: number;
}

interface BallFx {
  mesh: Mesh;
  life: number;
  maxLife: number;
  size0: number;
  size1: number;
  color0: Color;
  color1: Color;
}

/**
 * 使い捨てエフェクトのプール。
 * 生成/破棄を繰り返さず、非表示のオブジェクトを回して使う。
 */
export class VfxManager {
  readonly root = new Group();
  private glow: Texture;
  private spark: Texture;
  private smoke: Texture;
  private ring: Texture;
  /** 生成した火球テクスチャ (段階違い) */
  private fireball1: Texture;
  private fireball2: Texture;
  private fireball3: Texture;
  private plasmaBurst: Texture;

  private spritePool: Sprite[] = [];
  private activeSprites: SpriteFx[] = [];
  private ballPool: Mesh[] = [];
  private activeBalls: BallFx[] = [];

  private ballGeo = new SphereGeometry(1, 14, 10);

  constructor(scene: Scene) {
    scene.add(this.root);
    this.glow = glowTexture();
    this.spark = glowTexture('rgba(255,255,255,1)', 'rgba(160,230,255,0.6)');
    this.smoke = glowTexture('rgba(190,190,200,0.55)', 'rgba(120,120,130,0.25)');
    this.ring = ringTexture();
    this.fireball1 = textureAlpha('fireball-1');
    this.fireball2 = textureAlpha('fireball-2');
    this.fireball3 = textureAlpha('fireball-3');
    this.plasmaBurst = textureAlpha('fireball-plasma');
  }

  private takeSprite(tex: Texture, color: number, opacity: number, additive: boolean): Sprite {
    let s = this.spritePool.pop();
    if (!s) {
      s = new Sprite(new SpriteMaterial({ transparent: true, depthWrite: false }));
      this.root.add(s);
    }
    const mat = s.material as SpriteMaterial;
    mat.map = tex;
    mat.color.setHex(color);
    mat.opacity = opacity;
    mat.blending = additive ? AdditiveBlending : NormalBlending;
    mat.needsUpdate = true;
    s.visible = true;
    return s;
  }

  private takeBall(): Mesh {
    let m = this.ballPool.pop();
    if (!m) {
      m = new Mesh(
        this.ballGeo,
        new MeshBasicMaterial({ transparent: true, depthWrite: false, blending: AdditiveBlending }),
      );
      this.root.add(m);
    }
    m.visible = true;
    return m;
  }

  private pushSprite(
    tex: Texture,
    pos: Vector3,
    o: {
      color?: number;
      size0: number;
      size1: number;
      life: number;
      opacity?: number;
      vel?: Vector3;
      additive?: boolean;
      spin?: number;
    },
  ): void {
    const sprite = this.takeSprite(tex, o.color ?? 0xffffff, o.opacity ?? 1, o.additive !== false);
    sprite.position.copy(pos);
    sprite.scale.setScalar(o.size0);
    sprite.material.rotation = rng.range(0, Math.PI * 2);
    this.activeSprites.push({
      sprite,
      life: o.life,
      maxLife: o.life,
      size0: o.size0,
      size1: o.size1,
      vel: o.vel ? o.vel.clone() : new Vector3(),
      opacity0: o.opacity ?? 1,
      spin: o.spin ?? 0,
    });
  }

  private pushBall(pos: Vector3, o: { size0: number; size1: number; life: number; c0: number; c1: number }): void {
    const mesh = this.takeBall();
    mesh.position.copy(pos);
    mesh.scale.setScalar(o.size0);
    const mat = mesh.material as MeshBasicMaterial;
    mat.color.setHex(o.c0);
    mat.opacity = 1;
    this.activeBalls.push({
      mesh,
      life: o.life,
      maxLife: o.life,
      size0: o.size0,
      size1: o.size1,
      color0: new Color(o.c0),
      color1: new Color(o.c1),
    });
  }

  /** 砲口の閃光 */
  muzzleFlash(pos: Vector3, color: number): void {
    this.pushSprite(this.glow, pos, { color, size0: 5, size1: 11, life: 0.07, opacity: 0.95 });
  }

  /** シールドで弾かれた */
  shieldSpark(pos: Vector3, scale = 1): void {
    this.pushSprite(this.spark, pos, {
      color: 0x66ccff,
      size0: 7 * scale,
      size1: 20 * scale,
      life: 0.22,
      opacity: 0.9,
    });
    // 電気的な弾け。シールドと装甲の当たりを音以外でも区別させる
    this.pushSprite(this.plasmaBurst, pos, {
      color: 0xffffff,
      size0: 6 * scale,
      size1: 26 * scale,
      life: 0.2,
      opacity: 0.75,
      additive: true,
    });
  }

  /** 装甲/船体への被弾 */
  hitSpark(pos: Vector3, scale = 1): void {
    this.pushSprite(this.glow, pos, {
      color: 0xffc26a,
      size0: 5 * scale,
      size1: 15 * scale,
      life: 0.2,
      opacity: 1,
    });
    for (let i = 0; i < 4; i++) {
      this.pushSprite(this.spark, pos, {
        color: 0xffe0a0,
        size0: 2.5 * scale,
        size1: 0.5,
        life: rng.range(0.18, 0.4),
        opacity: 0.9,
        vel: new Vector3(rng.signed(60), rng.signed(60), rng.signed(60)),
      });
    }
  }

  /** ハルまで抜けた被弾。火花だけでなく、内部から噴く橙色の閃光を足す。 */
  hullHit(pos: Vector3, scale = 1): void {
    this.pushSprite(this.plasmaBurst, pos, {
      color: 0xff7440,
      size0: 7 * scale,
      size1: 24 * scale,
      life: 0.28,
      opacity: 0.9,
    });
    this.pushSprite(this.smoke, pos, {
      color: 0x30343a,
      size0: 3 * scale,
      size1: 15 * scale,
      life: 0.5,
      opacity: 0.5,
      additive: false,
      vel: new Vector3(rng.signed(12), rng.signed(12), rng.signed(12)),
    });
    this.hitSpark(pos, scale * 1.12);
  }

  /** ミサイルの飛行煙 */
  missileTrail(pos: Vector3, color: number): void {
    this.pushSprite(this.smoke, pos, {
      color: 0x99a0aa,
      size0: 3,
      size1: 16,
      life: 0.7,
      opacity: 0.35,
      additive: false,
    });
    this.pushSprite(this.glow, pos, { color, size0: 4, size1: 1, life: 0.12, opacity: 0.8 });
  }

  /** フレアの発光 */
  flareGlow(pos: Vector3): void {
    this.pushSprite(this.glow, pos, {
      color: 0xffcc66,
      size0: 12,
      size1: 4,
      life: 0.35,
      opacity: 1,
    });
  }

  /**
   * 損傷煙。機体の後方へ煙と火花を落とす。
   * severity 0..1 で濃さと火花の量が変わる。
   */
  damageSmoke(pos: Vector3, vel: Vector3, radius: number, severity: number): void {
    const s = Math.max(3, radius * 0.5);
    const drift = new Vector3(
      -vel.x * 0.25 + rng.signed(8),
      -vel.y * 0.25 + rng.signed(8),
      -vel.z * 0.25 + rng.signed(8),
    );
    this.pushSprite(this.smoke, pos, {
      color: 0x3b3f46,
      size0: s * 0.7,
      size1: s * (2.2 + severity * 2),
      life: 0.9 + severity * 0.8,
      opacity: 0.18 + severity * 0.3,
      vel: drift,
      additive: false,
    });
    if (rng.chance(0.35 + severity * 0.4)) {
      this.pushSprite(this.glow, pos, {
        color: 0xff9a4a,
        size0: s * 0.4,
        size1: s * 0.08,
        life: rng.range(0.2, 0.5),
        opacity: 0.6 + severity * 0.3,
        vel: drift,
      });
    }
  }

  /** 爆発。規模に応じて閃光・火球・破片・衝撃波リングを重ねる。 */
  explosion(pos: Vector3, radius: number, kind: 'missile' | 'ship' | 'small' = 'small'): void {
    const big = kind === 'ship';
    const s = Math.max(6, radius);

    // 芯の閃光
    this.pushSprite(this.glow, pos, {
      color: 0xffffff,
      size0: s * 0.4,
      size1: s * (big ? 1.9 : 1.4),
      life: big ? 0.16 : 0.11,
      opacity: 1,
    });
    // 火球。生成テクスチャを3段階で重ね、既存の球も裏に残して立体感を出す
    this.pushBall(pos, {
      size0: s * 0.25,
      size1: s * (big ? 1.15 : 0.85),
      life: big ? 0.6 : 0.35,
      c0: 0xffc266,
      c1: 0x4a0f00,
    });
    const stages: Array<[Texture, number, number, number]> = [
      [this.fireball1, 0.0, big ? 0.9 : 0.6, 1],
      [this.fireball2, 0.06, big ? 1.5 : 1.0, 0.95],
      [this.fireball3, 0.16, big ? 2.1 : 1.4, 0.8],
    ];
    for (const [map, delay, endScale, opacity] of stages) {
      this.pushSprite(map, pos, {
        color: 0xffffff,
        size0: s * (0.3 + endScale * 0.2),
        size1: s * endScale,
        life: (big ? 0.7 : 0.45) - delay,
        opacity,
        additive: true,
      });
    }
    // 衝撃波リング
    this.pushSprite(this.ring, pos, {
      color: 0xffa055,
      size0: s * 0.4,
      size1: s * (big ? 3.4 : 2.2),
      life: big ? 0.5 : 0.32,
      opacity: 0.6,
    });
    // 破片と煙
    const shards = big ? 18 : 8;
    for (let i = 0; i < shards; i++) {
      const sp = big ? rng.range(60, 220) : rng.range(40, 130);
      const dir = new Vector3(rng.signed(1), rng.signed(1), rng.signed(1)).normalize().multiplyScalar(sp);
      this.pushSprite(this.glow, pos, {
        color: 0xffb466,
        size0: s * 0.22,
        size1: s * 0.05,
        life: rng.range(0.4, big ? 1.4 : 0.8),
        opacity: 0.95,
        vel: dir,
      });
    }
    const puffs = big ? 10 : 4;
    for (let i = 0; i < puffs; i++) {
      const dir = new Vector3(rng.signed(1), rng.signed(1), rng.signed(1))
        .normalize()
        .multiplyScalar(rng.range(10, 50));
      this.pushSprite(this.smoke, pos, {
        color: 0x555a63,
        size0: s * 0.5,
        size1: s * 2,
        life: rng.range(0.8, 1.8),
        opacity: 0.4,
        vel: dir,
        additive: false,
      });
    }
  }

  update(dt: number): void {
    for (let i = this.activeSprites.length - 1; i >= 0; i--) {
      const fx = this.activeSprites[i];
      fx.life -= dt;
      if (fx.life <= 0) {
        fx.sprite.visible = false;
        this.spritePool.push(fx.sprite);
        this.activeSprites.splice(i, 1);
        continue;
      }
      const t = 1 - fx.life / fx.maxLife;
      fx.sprite.position.addScaledVector(fx.vel, dt);
      fx.sprite.scale.setScalar(fx.size0 + (fx.size1 - fx.size0) * t);
      (fx.sprite.material as SpriteMaterial).opacity = fx.opacity0 * (1 - t) * (1 - t);
      if (fx.spin) fx.sprite.material.rotation += fx.spin * dt;
    }

    for (let i = this.activeBalls.length - 1; i >= 0; i--) {
      const fx = this.activeBalls[i];
      fx.life -= dt;
      if (fx.life <= 0) {
        fx.mesh.visible = false;
        this.ballPool.push(fx.mesh);
        this.activeBalls.splice(i, 1);
        continue;
      }
      const t = 1 - fx.life / fx.maxLife;
      fx.mesh.scale.setScalar(fx.size0 + (fx.size1 - fx.size0) * Math.sqrt(t));
      const mat = fx.mesh.material as MeshBasicMaterial;
      mat.color.copy(fx.color0).lerp(fx.color1, Math.min(1, t * 1.6));
      mat.opacity = 0.9 * (1 - t) * (1 - t * 0.6);
    }
  }

  clear(): void {
    for (const fx of this.activeSprites) {
      fx.sprite.visible = false;
      this.spritePool.push(fx.sprite);
    }
    this.activeSprites.length = 0;
    for (const fx of this.activeBalls) {
      fx.mesh.visible = false;
      this.ballPool.push(fx.mesh);
    }
    this.activeBalls.length = 0;
  }
}
