import { Group, Quaternion, Vector3, type Object3D, type Scene } from 'three';
import { isHostile } from '../content/factions';
import { VISUAL_BASE_HALF_LENGTH } from '../content/ships';
import type { Entity } from '../world/entity';
import type { World } from '../world/world';
import { BattleDamage } from './BattleDamage';
import { attachDecals } from './Decals';
import { attachPlume, EnginePlume } from './EnginePlume';
import {
  createMineMesh,
  createMissileMesh,
  createRockMesh,
  createShipMesh,
  createTracerMesh,
  createTurretMesh,
  requestShipVisual,
  type ShipVisualRequest,
} from './MeshFactory';
import {
  attachVisibilityAids,
  updateVisibilityAids,
  type FactionTone,
  type VisibilityAids,
} from './ShipVisibility';
import { plumeVisibilityBoost } from './Visibility';

const _pos = new Vector3();
const _quat = new Quaternion();
const _aim = new Vector3();
const _forward = new Vector3();
/** 砲塔が的を見失ったときに向く方向 (艦の外側前方) */
const _rest = new Vector3();
/**
 * これより近い弾は描かない (自機の砲口すぐの弾で視界が塞がるのを防ぐ)。
 * 「自分の弾がどこへ飛んだか」を最優先にするため、
 * 砲身の長さぶんだけ隠したらすぐ見えるところまで詰める。
 */
const NEAR_CLIP_SQ = 18 * 18;
/** 性能予算。近い敵を優先し、遠い敵の描画だけを落とす。シミュレーションは継続する。 */
const MAX_RENDERED_HOSTILES = 24;

/**
 * ロジック側の Entity を Three.js の Object3D に反映する。
 * ロジックは Three.js のシーングラフを一切知らない。
 */
export class RenderSync {
  private meshes = new Map<number, Object3D>();
  private plumes = new Map<number, EnginePlume>();
  /** 艦艇の砲塔 (的を追って回る)。entity id ごとに複数 */
  private turrets = new Map<number, Object3D[]>();
  /** 船体に残る焼け跡 */
  private damage = new Map<number, BattleDamage>();
  /** GLTF 差し替え中のリクエスト。エンティティ消滅時に必ず無効化する */
  private shipVisuals = new Map<number, ShipVisualRequest>();
  /** 縁光シェルと遠距離の光点 (距離帯ごとに強度を切り替える) */
  private aids = new Map<number, VisibilityAids>();
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
      // 艦艇の砲塔は的を追うので、テンプレートではなく実体に付ける
      if (def.role === 'capital') this.attachTurrets(obj, e);
      // デカールと焼け跡はテンプレート共有できないので実体に貼る
      attachDecals(obj, e);
      this.damage.set(e.id, new BattleDamage(obj, e));
      // 縁光と光点。マテリアルは共有インスタンスなので実体ごとの生成は起きない
      this.aids.set(e.id, attachVisibilityAids(obj));
      return obj;
    }
    if (e.kind === 'projectile' && e.projectile) {
      if (e.projectile.damage <= 0) return undefined; // フレアは VFX 側で描く
      return createTracerMesh(e.projectile.gun.color, e.projectile.gun.tracer, e.projectile.gun);
    }
    if (e.kind === 'missile' && e.missile) return createMissileMesh(e.missile.def);
    if (e.kind === 'rock' && e.rock) {
      const obj = createRockMesh(e.rock.variant);
      // テンプレートは半径 0.5 の球基準なので、当たり判定半径に合わせる
      obj.scale.setScalar(e.radius * 2);
      return obj;
    }
    if (e.kind === 'mine') {
      const obj = createMineMesh();
      obj.scale.setScalar(e.radius * 2);
      return obj;
    }
    return undefined;
  }

  /** 砲塔を砲門の位置に生やす。位置はメッシュと同じ倍率で換算する */
  private attachTurrets(obj: Object3D, e: Entity): void {
    const def = e.ship!.def;
    const list: Object3D[] = [];
    for (const hp of def.guns) {
      const t = createTurretMesh(def.visual);
      t.position.set(
        hp.offset[0] * def.hardpointScale,
        hp.offset[1] * def.hardpointScale,
        hp.offset[2] * def.hardpointScale,
      );
      // 遠目にも「砲塔が付いている」と分かる大きさにする
      t.scale.setScalar(def.hardpointScale * 1.5);
      obj.add(t);
      list.push(t);
    }
    this.turrets.set(e.id, list);
  }

  /**
   * 砲塔を的の方へ向ける。
   * 「艦が生きて反応している」ことが遠目にも分かるので、巨大さの表現に効く。
   */
  private aimTurrets(world: World, e: Entity, list: Object3D[]): void {
    // 狙う相手: 砲塔の射程内で最も近い敵
    let target: Entity | undefined;
    let best = Infinity;
    for (const t of world.entities) {
      if (!t.alive || t.kind !== 'ship' || t.id === e.id) continue;
      if (!isHostile(e.faction, t.faction)) continue;
      const d = t.pos.distanceToSquared(e.pos);
      if (d < best) {
        best = d;
        target = t;
      }
    }
    for (let i = 0; i < list.length; i++) {
      const turret = list[i];
      if (target) {
        _aim.copy(target.pos);
      } else {
        // 待機時は舷側の外へ向けて、揃った向きで止める
        _rest.set(i % 2 === 0 ? -1 : 1, 0.12, -0.35).normalize();
        _aim.copy(_rest).applyQuaternion(e.quat).multiplyScalar(400).add(e.pos);
      }
      turret.lookAt(_aim);
    }
  }

  /**
   * 縁光の色。敵=暖色 (赤)、味方=寒色 (青)、それ以外=白。
   * 敵が連邦機に乗っていても「敵」として読めるよう、機体定義ではなく実体の陣営で決める。
   */
  private toneFor(player: Entity | undefined, e: Entity): FactionTone {
    if (!player) return 'neutral';
    if (isHostile(player.faction, e.faction)) return 'hostile';
    if (e.faction === player.faction) return 'friendly';
    return 'neutral';
  }

  sync(world: World, alpha: number, cameraPos?: Vector3, dt = 1 / 60): void {
    this.seen.clear();
    const player = world.player;
    let renderedHostiles = 0;
    for (const e of world.entities) {
      if (!e.alive || e.kind === 'nav') continue;
      if (player && e.kind === 'ship' && isHostile(player.faction, e.faction)) {
        const far = e.pos.distanceToSquared(player.pos) > 10000 * 10000;
        if (far && renderedHostiles >= MAX_RENDERED_HOSTILES) continue;
        renderedHostiles += 1;
      }
      let obj = this.meshes.get(e.id);
      if (!obj) {
        const created = this.create(e);
        if (!created) continue;
        obj = created;
        this.meshes.set(e.id, obj);
        this.root.add(obj);
        if (e.kind === 'ship' && e.ship) {
          const visual = requestShipVisual(e.ship.def, obj);
          if (visual.state !== 'procedural') this.shipVisuals.set(e.id, visual);
        }
      }
      this.seen.add(e.id);

      _pos.copy(e.renderPrevPos).lerp(e.pos, alpha);
      _quat.copy(e.renderPrevQuat).slerp(e.quat, alpha);
      obj.position.copy(_pos);
      obj.quaternion.copy(_quat);
      if (e.kind === 'ship' && e.ship?.gunRecoil?.length) {
        const recoil = Math.max(0, ...e.ship.gunRecoil);
        if (recoil > 0) {
          _forward.set(0, 0, -1).applyQuaternion(_quat);
          obj.position.addScaledVector(_forward, -recoil);
        }
      }
      // ── 距離帯ごとの見せ方 (縁光・光点・エンジン光) ──
      let plumeBoost = 1;
      if (e.kind === 'ship' && e.id !== world.playerId) {
        const eye = cameraPos ?? player?.pos;
        const distance = eye ? _pos.distanceTo(eye) : 0;
        const aids = this.aids.get(e.id);
        if (aids) updateVisibilityAids(aids, this.toneFor(player, e), distance, e.radius);
        plumeBoost = plumeVisibilityBoost(distance);
      }
      const plume = this.plumes.get(e.id);
      if (plume) {
        plume.visibilityBoost = plumeBoost;
        plume.update(e, dt);
      }
      const turrets = this.turrets.get(e.id);
      if (turrets) this.aimTurrets(world, e, turrets);
      this.damage.get(e.id)?.update(e, world.time);

      if (e.id === world.playerId) {
        obj.visible = !this.hidePlayer;
      } else if (e.kind === 'projectile' && cameraPos) {
        // 砲口直後の弾は画面いっぱいに映ってしまうので、少し離れるまで隠す
        obj.visible = _pos.distanceToSquared(cameraPos) > NEAR_CLIP_SQ;
      } else if (e.kind === 'mine') {
        // 起爆シーケンスに入ったら警告灯を速く点滅させる
        const lamp = obj.getObjectByName('lamp');
        if (lamp) {
          const hz = e.mine!.armed ? 9 : 1.2;
          lamp.visible = Math.sin(world.time * hz * Math.PI * 2) > -0.2;
        }
      }
    }

    // 消えたエンティティのメッシュを外す
    for (const [id, obj] of this.meshes) {
      if (this.seen.has(id)) continue;
      this.root.remove(obj);
      this.meshes.delete(id);
      this.shipVisuals.get(id)?.cancel();
      this.shipVisuals.delete(id);
      this.plumes.delete(id);
      this.turrets.delete(id);
      this.aids.delete(id);
      this.damage.get(id)?.dispose();
      this.damage.delete(id);
    }
  }

  clear(): void {
    for (const request of this.shipVisuals.values()) request.cancel();
    this.shipVisuals.clear();
    for (const obj of this.meshes.values()) this.root.remove(obj);
    this.meshes.clear();
    this.plumes.clear();
    this.turrets.clear();
    this.aids.clear();
    for (const d of this.damage.values()) d.dispose();
    this.damage.clear();
  }

  meshOf(id: number): Object3D | undefined {
    return this.meshes.get(id);
  }
}
