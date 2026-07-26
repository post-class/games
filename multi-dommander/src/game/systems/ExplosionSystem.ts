import {
  Mesh,
  SphereGeometry,
  MeshBasicMaterial,
  AdditiveBlending,
  type Scene,
  type Vector3,
} from "three";
import type { System } from "../../ecs/System";
import type { World } from "../../ecs/World";
import type { EventBus } from "../../util/EventBus";

interface Effect {
  mesh: Mesh;
  age: number;
  ttl: number;
  maxScale: number;
  material: MeshBasicMaterial;
}

const explosionGeo = new SphereGeometry(1, 12, 12);

/**
 * 撃墜・被弾イベントを購読し、膨張して消える発光球エフェクトを生成・アニメーションする。
 * ECS外の純粋な視覚要素として管理する (可変レート更新)。
 */
export class ExplosionSystem implements System {
  readonly name = "ExplosionSystem";
  private readonly effects: Effect[] = [];

  constructor(
    private readonly scene: Scene,
    events: EventBus,
  ) {
    events.on("destroyed", (e) => this.spawn(e.position, 60, 0xffaa33, 1.1));
    events.on("hit", (e) => this.spawn(e.position, 10, 0x66ccff, 0.35));
  }

  private spawn(position: Vector3, size: number, color: number, ttl: number): void {
    const material = new MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 1,
      blending: AdditiveBlending,
      depthWrite: false,
    });
    const mesh = new Mesh(explosionGeo, material);
    mesh.position.copy(position);
    mesh.scale.setScalar(size * 0.2);
    this.scene.add(mesh);
    this.effects.push({ mesh, age: 0, ttl, maxScale: size, material });
  }

  update(_world: World, dt: number): void {
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const fx = this.effects[i];
      fx.age += dt;
      const p = fx.age / fx.ttl;
      if (p >= 1) {
        this.scene.remove(fx.mesh);
        fx.material.dispose();
        this.effects.splice(i, 1);
        continue;
      }
      // イージングで急膨張してフェードアウト。
      const scale = fx.maxScale * (0.2 + 0.8 * Math.sqrt(p));
      fx.mesh.scale.setScalar(scale);
      fx.material.opacity = 1 - p;
    }
  }
}
