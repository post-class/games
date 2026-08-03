import { Group, Quaternion, Vector3, type Object3D, type Scene } from 'three';
import { VISUAL_BASE_HALF_LENGTH } from '../content/ships';
import type { Entity } from '../world/entity';
import type { World } from '../world/world';
import { attachPlume, EnginePlume } from './EnginePlume';
import { createMissileMesh, createShipMesh, createTracerMesh } from './MeshFactory';

const _pos = new Vector3();
const _quat = new Quaternion();
/** これより近い弾は描かない (自機の砲口すぐの弾で視界が塞がるのを防ぐ) */
const NEAR_CLIP_SQ = 45 * 45;

/**
 * ロジック側の Entity を Three.js の Object3D に反映する。
 * ロジックは Three.js のシーングラフを一切知らない。
 */
export class RenderSync {
  private meshes = new Map<number, Object3D>();
  private plumes = new Map<number, EnginePlume>();
  private seen = new Set<number>();
  readonly root = new Group();
  /** コクピット視点では自機を描かない */
  hidePlayer = true;

  constructor(private scene: Scene) {
    this.scene.add(this.root);
  }

  private create(e: Entity): Object3D | undefined {
    if (e.kind === 'ship' && e.ship) {
      const def = e.ship.def;
      const obj = createShipMesh(def);
      // 噴射炎はメッシュと同じスケールで機体後方に付ける
      const plume = new EnginePlume(def, def.size / VISUAL_BASE_HALF_LENGTH[def.visual.kind]);
      attachPlume(obj, plume);
      this.plumes.set(e.id, plume);
      return obj;
    }
    if (e.kind === 'projectile' && e.projectile) {
      if (e.projectile.damage <= 0) return undefined; // フレアは VFX 側で描く
      return createTracerMesh(e.projectile.gun.color, e.projectile.gun.tracer);
    }
    if (e.kind === 'missile' && e.missile) return createMissileMesh(e.missile.def.color);
    return undefined;
  }

  sync(world: World, alpha: number, cameraPos?: Vector3, dt = 1 / 60): void {
    this.seen.clear();
    for (const e of world.entities) {
      if (!e.alive || e.kind === 'nav') continue;
      let obj = this.meshes.get(e.id);
      if (!obj) {
        const created = this.create(e);
        if (!created) continue;
        obj = created;
        this.meshes.set(e.id, obj);
        this.root.add(obj);
      }
      this.seen.add(e.id);

      _pos.copy(e.renderPrevPos).lerp(e.pos, alpha);
      _quat.copy(e.renderPrevQuat).slerp(e.quat, alpha);
      obj.position.copy(_pos);
      obj.quaternion.copy(_quat);
      this.plumes.get(e.id)?.update(e, dt);

      if (e.id === world.playerId) {
        obj.visible = !this.hidePlayer;
      } else if (e.kind === 'projectile' && cameraPos) {
        // 砲口直後の弾は画面いっぱいに映ってしまうので、少し離れるまで隠す
        obj.visible = _pos.distanceToSquared(cameraPos) > NEAR_CLIP_SQ;
      }
    }

    // 消えたエンティティのメッシュを外す
    for (const [id, obj] of this.meshes) {
      if (this.seen.has(id)) continue;
      this.root.remove(obj);
      this.meshes.delete(id);
      this.plumes.delete(id);
    }
  }

  clear(): void {
    for (const obj of this.meshes.values()) this.root.remove(obj);
    this.meshes.clear();
    this.plumes.clear();
  }

  meshOf(id: number): Object3D | undefined {
    return this.meshes.get(id);
  }
}
