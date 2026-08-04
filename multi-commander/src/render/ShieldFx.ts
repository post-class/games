import {
  AdditiveBlending,
  CanvasTexture,
  CircleGeometry,
  Mesh,
  MeshBasicMaterial,
  Quaternion,
  SphereGeometry,
  Vector3,
  type Scene,
  type Texture,
} from 'three';

/**
 * シールドの被弾表現。
 *
 * 火花だけだと「何に当たったのか」が分からない。
 * 機体を包む殻が一瞬光り、当たった面に波紋が出ることで
 * 「シールドが受け止めた」と即座に読めるようにする。
 *
 * 装甲・船体への命中 (`Vfx.hitSpark`) とは見た目を明確に分けるのが目的。
 */

const FORWARD = new Vector3(0, 0, 1);
const _dir = new Vector3();
const _q = new Quaternion();

/** 同時に出せる殻の数 */
const SHELL_POOL = 6;
/** 同時に出せる波紋の数 */
const RIPPLE_POOL = 10;

/** 六角格子のテクスチャ。シールドが「張られている面」に見せるため */
function latticeTexture(): Texture {
  const size = 256;
  const cv = document.createElement('canvas');
  cv.width = size;
  cv.height = size;
  const g = cv.getContext('2d')!;
  g.clearRect(0, 0, size, size);
  g.strokeStyle = 'rgba(150, 225, 255, 0.85)';
  g.lineWidth = 2;
  // 六角形を敷き詰める
  const r = 20;
  const h = Math.sqrt(3) * r;
  for (let row = -1; row * h * 0.5 < size + h; row++) {
    for (let col = -1; col * r * 1.5 < size + r; col++) {
      const cx = col * r * 1.5;
      const cy = row * h * 0.5 + (col % 2 ? h * 0.25 : 0);
      g.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = (Math.PI / 3) * i;
        const x = cx + Math.cos(a) * r;
        const y = cy + Math.sin(a) * r;
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.closePath();
      g.stroke();
    }
  }
  return new CanvasTexture(cv);
}

/** 縁が濃く中心が薄い円。波紋に使う */
function rippleTexture(): Texture {
  const size = 128;
  const cv = document.createElement('canvas');
  cv.width = size;
  cv.height = size;
  const g = cv.getContext('2d')!;
  const grad = g.createRadialGradient(size / 2, size / 2, size * 0.1, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(190, 240, 255, 0.15)');
  grad.addColorStop(0.62, 'rgba(140, 220, 255, 0.75)');
  grad.addColorStop(0.86, 'rgba(120, 200, 255, 0.35)');
  grad.addColorStop(1, 'rgba(120, 200, 255, 0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return new CanvasTexture(cv);
}

interface Item {
  mesh: Mesh;
  life: number;
  maxLife: number;
  scale0: number;
  scale1: number;
  opacity: number;
}

export class ShieldFx {
  private shells: Item[] = [];
  private ripples: Item[] = [];

  constructor(scene: Scene) {
    const shellGeo = new SphereGeometry(1, 24, 16);
    const lattice = latticeTexture();
    for (let i = 0; i < SHELL_POOL; i++) {
      const mesh = new Mesh(
        shellGeo,
        new MeshBasicMaterial({
          map: lattice,
          color: 0x7fd8ff,
          transparent: true,
          opacity: 0,
          blending: AdditiveBlending,
          depthWrite: false,
        }),
      );
      mesh.visible = false;
      mesh.frustumCulled = false;
      scene.add(mesh);
      this.shells.push({ mesh, life: 0, maxLife: 1, scale0: 1, scale1: 1, opacity: 0 });
    }

    const rippleGeo = new CircleGeometry(1, 20);
    const ripple = rippleTexture();
    for (let i = 0; i < RIPPLE_POOL; i++) {
      const mesh = new Mesh(
        rippleGeo,
        new MeshBasicMaterial({
          map: ripple,
          transparent: true,
          opacity: 0,
          blending: AdditiveBlending,
          depthWrite: false,
        }),
      );
      mesh.visible = false;
      mesh.frustumCulled = false;
      scene.add(mesh);
      this.ripples.push({ mesh, life: 0, maxLife: 1, scale0: 1, scale1: 1, opacity: 0 });
    }
  }

  private take(pool: Item[]): Item {
    // 空きが無ければ最も古いものを奪う
    let best = pool[0];
    for (const it of pool) {
      if (it.life <= 0) return it;
      if (it.life < best.life) best = it;
    }
    return best;
  }

  /**
   * シールドが受け止めたときの表示。
   * @param center 機体の中心
   * @param point 命中点
   * @param radius 機体の当たり判定半径
   * @param strength 0..1。受けたダメージの大きさ
   */
  hit(center: Vector3, point: Vector3, radius: number, strength: number): void {
    const s = Math.max(0.15, Math.min(1, strength));

    // 殻: 機体全体が一瞬光る
    const shell = this.take(this.shells);
    shell.mesh.position.copy(center);
    shell.mesh.visible = true;
    shell.life = 0.26 + s * 0.12;
    shell.maxLife = shell.life;
    shell.scale0 = radius * 1.12;
    shell.scale1 = radius * (1.2 + s * 0.1);
    shell.opacity = 0.11 + s * 0.19;

    // 波紋: 当たった面に貼り付き、外向きに広がる
    const ripple = this.take(this.ripples);
    _dir.copy(point).sub(center);
    if (_dir.lengthSq() < 1e-6) _dir.set(0, 0, -1);
    _dir.normalize();
    ripple.mesh.position.copy(center).addScaledVector(_dir, radius * 1.14);
    _q.setFromUnitVectors(FORWARD, _dir);
    ripple.mesh.quaternion.copy(_q);
    ripple.mesh.visible = true;
    ripple.life = 0.34;
    ripple.maxLife = ripple.life;
    ripple.scale0 = radius * 0.25;
    ripple.scale1 = radius * (0.9 + s * 0.5);
    ripple.opacity = 0.4 + s * 0.35;
  }

  update(dt: number): void {
    for (const pool of [this.shells, this.ripples]) {
      for (const it of pool) {
        if (it.life <= 0) continue;
        it.life -= dt;
        if (it.life <= 0) {
          it.mesh.visible = false;
          (it.mesh.material as MeshBasicMaterial).opacity = 0;
          continue;
        }
        const t = 1 - it.life / it.maxLife;
        const scale = it.scale0 + (it.scale1 - it.scale0) * t;
        it.mesh.scale.setScalar(scale);
        // 立ち上がりは速く、消えるときは滑らかに
        const fade = t < 0.18 ? t / 0.18 : 1 - (t - 0.18) / 0.82;
        (it.mesh.material as MeshBasicMaterial).opacity = it.opacity * Math.max(0, fade);
      }
    }
  }

  clear(): void {
    for (const pool of [this.shells, this.ripples]) {
      for (const it of pool) {
        it.life = 0;
        it.mesh.visible = false;
      }
    }
  }
}
