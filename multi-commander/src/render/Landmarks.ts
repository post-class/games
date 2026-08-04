import {
  AdditiveBlending,
  BackSide,
  BoxGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PointLight,
  Sprite,
  SpriteMaterial,
  SphereGeometry,
  TorusGeometry,
  type Scene,
} from 'three';
import { Rng } from '../core/rng';
import { texture, textureAlpha, type PlanetTexId } from './textures';

/**
 * 戦域に置く巨大構造物。
 *
 * 遠景 (Skybox) はカメラに追従するので、どれだけ飛んでも近づかない。
 * それだけだと「宇宙の広さ」が伝わらないので、実座標に巨大な物体を置いて
 * 飛ぶほど見え方が変わる対象を作る。当たり判定は持たない (航路から外して置く)。
 */

export type LandmarkKind = 'gas-giant' | 'jump-gate' | 'station' | 'derelict' | 'sun';

export interface LandmarkDef {
  kind: LandmarkKind;
  /** ワールド座標 */
  pos: [number, number, number];
  /** 基準サイズ (半径相当) */
  scale: number;
  color?: number;
  /** 表面に貼る生成テクスチャ (gas-giant のみ) */
  texture?: PlanetTexId;
}

const SPH = new SphereGeometry(1, 40, 28);
const BOX = new BoxGeometry(1, 1, 1);
const CYL = new CylinderGeometry(1, 1, 1, 24, 1, true);
const RING = new TorusGeometry(1, 0.08, 12, 48);

function build(def: LandmarkDef): Object3D {
  const g = new Group();
  const rng = new Rng(Math.abs(Math.floor(def.pos[0] + def.pos[2])) + 7);

  switch (def.kind) {
    case 'gas-giant': {
      // 表面は生成した equirectangular テクスチャ。
      // 円筒を重ねて縞を作っていた頃は塗り絵に見えていた
      const map = def.texture ?? 'planet-gas-amber';
      g.add(
        new Mesh(
          SPH,
          new MeshStandardMaterial({
            map: texture(map),
            roughness: 1,
            metalness: 0,
          }),
        ),
      );
      // 大気の縁 (リムライト風)
      const halo = new Mesh(
        SPH,
        new MeshBasicMaterial({
          color: 0x9fc4ff,
          transparent: true,
          opacity: 0.16,
          side: BackSide,
          blending: AdditiveBlending,
          depthWrite: false,
        }),
      );
      halo.scale.setScalar(1.06);
      g.add(halo);
      break;
    }
    case 'sun': {
      const color = def.color ?? 0xfff0c0;
      const core = new Mesh(SPH, new MeshBasicMaterial({ color }));
      g.add(core);
      // コロナのスプライトを重ねて、ただの白球に見えないようにする
      const corona = new Sprite(
        new SpriteMaterial({
          map: textureAlpha('sun-corona'),
          blending: AdditiveBlending,
          transparent: true,
          depthWrite: false,
          opacity: 0.85,
        }),
      );
      corona.scale.setScalar(4.2);
      g.add(corona);
      for (let i = 1; i <= 3; i++) {
        const glow = new Mesh(
          SPH,
          new MeshBasicMaterial({
            color,
            transparent: true,
            opacity: 0.14 / i,
            blending: AdditiveBlending,
            depthWrite: false,
          }),
        );
        glow.scale.setScalar(1 + i * 0.35);
        g.add(glow);
      }
      g.add(new PointLight(color, 3, def.scale * 40));
      break;
    }
    case 'jump-gate': {
      const metal = new MeshStandardMaterial({ color: 0x6d757e, roughness: 0.45, metalness: 0.85 });
      const ring = new Mesh(RING, metal);
      ring.rotation.x = Math.PI / 2;
      g.add(ring);
      // 支柱
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        const strut = new Mesh(BOX, metal);
        strut.position.set(Math.cos(a), 0, Math.sin(a));
        strut.scale.set(0.1, 0.32, 0.1);
        g.add(strut);
      }
      // ゲート内側の光膜
      const film = new Mesh(
        new SphereGeometry(0.96, 24, 16),
        new MeshBasicMaterial({
          color: 0x5fa8ff,
          transparent: true,
          opacity: 0.14,
          blending: AdditiveBlending,
          depthWrite: false,
        }),
      );
      film.scale.set(1, 0.06, 1);
      g.add(film);
      g.add(new PointLight(0x6fb0ff, 2.2, def.scale * 12));
      break;
    }
    case 'station': {
      const metal = new MeshStandardMaterial({ color: 0x8a8f96, roughness: 0.5, metalness: 0.7 });
      const dark = new MeshStandardMaterial({ color: 0x353a40, roughness: 0.8, metalness: 0.4 });
      const hub = new Mesh(CYL, metal);
      hub.scale.set(0.34, 1.5, 0.34);
      g.add(hub);
      // 居住リング
      for (const y of [-0.5, 0.5]) {
        const ring = new Mesh(RING, metal);
        ring.rotation.x = Math.PI / 2;
        ring.position.y = y;
        g.add(ring);
        for (let i = 0; i < 4; i++) {
          const a = (i / 4) * Math.PI * 2;
          const spoke = new Mesh(BOX, dark);
          spoke.position.set(Math.cos(a) * 0.5, y, Math.sin(a) * 0.5);
          spoke.scale.set(1, 0.07, 0.07);
          spoke.rotation.y = -a;
          g.add(spoke);
        }
      }
      // ドッキングアーム
      for (let i = 0; i < 3; i++) {
        const arm = new Mesh(BOX, dark);
        arm.position.set(0, -1.2 + i * 0.3, 0.7);
        arm.scale.set(0.5, 0.1, 0.6);
        g.add(arm);
      }
      g.add(new PointLight(0xffd9a0, 1.4, def.scale * 8));
      break;
    }
    case 'derelict': {
      const burnt = new MeshStandardMaterial({ color: 0x4a4640, roughness: 0.95, metalness: 0.3 });
      // 折れた船体。2つのブロックを角度をつけて置く
      const fore = new Mesh(BOX, burnt);
      fore.scale.set(0.5, 0.4, 2.0);
      fore.position.set(0, 0, -0.9);
      g.add(fore);
      const aft = new Mesh(BOX, burnt);
      aft.scale.set(0.6, 0.5, 1.6);
      aft.position.set(0.18, -0.1, 0.9);
      aft.rotation.set(0.1, 0.22, 0.14);
      g.add(aft);
      // 散らばった破片
      for (let i = 0; i < 12; i++) {
        const d = new Mesh(BOX, burnt);
        d.position.set(rng.range(-1.6, 1.6), rng.range(-0.8, 0.8), rng.range(-2.4, 2.4));
        d.scale.setScalar(rng.range(0.04, 0.16));
        d.rotation.set(rng.range(0, 3), rng.range(0, 3), rng.range(0, 3));
        g.add(d);
      }
      break;
    }
  }

  g.position.set(...def.pos);
  g.scale.setScalar(def.scale);
  g.rotation.set(rng.range(0, 0.4), rng.range(0, Math.PI * 2), rng.range(-0.2, 0.2));
  return g;
}

export class Landmarks {
  private root = new Group();

  constructor(private scene: Scene) {
    this.scene.add(this.root);
  }

  set(defs: LandmarkDef[] | undefined): void {
    this.clear();
    for (const d of defs ?? []) this.root.add(build(d));
  }

  clear(): void {
    for (const c of [...this.root.children]) {
      this.root.remove(c);
      c.traverse((o) => {
        const m = o as Mesh;
        if (m.isMesh) (m.material as { dispose?: () => void }).dispose?.();
      });
    }
  }
}
