import {
  Points,
  BufferGeometry,
  BufferAttribute,
  PointsMaterial,
  AdditiveBlending,
  Mesh,
  SphereGeometry,
  RingGeometry,
  BoxGeometry,
  MeshBasicMaterial,
  InstancedMesh,
  Vector3,
  Matrix4,
  Color,
  type Scene,
} from "three";
import type { VfxPool, VfxManager } from "../VfxManager";

/** 各プールスロットの状態。 */
interface PoolSlot {
  /** 経過時間 (秒)。ttlに達すると非アクティブ化。 */
  age: number;
  /** 寿命 (秒)。 */
  ttl: number;
  /** アクティブかどうか。 */
  active: boolean;
}

/** 閃光用スロット (位置・最大スケール追加)。 */
interface FlashSlot extends PoolSlot {
  position: Vector3;
  maxScale: number;
}

/** 衝撃波リング用スロット。 */
interface ShockwaveSlot extends PoolSlot {
  position: Vector3;
  maxScale: number;
}

/** デブリ用スロット (速度・角速度追加)。 */
interface DebrisSlot extends PoolSlot {
  position: Vector3;
  velocity: Vector3;
  scale: number;
}

/** Points用スロット (位置・速度)。 */
interface PointSlot extends PoolSlot {
  position: Vector3;
  velocity: Vector3;
}

// 一時変数 (GC回避用)。
const _tmpVec = new Vector3();
const _tmpMat = new Matrix4();
const _tmpColor = new Color();

// =============================================================================
// 爆発閃光 (explosion.flash)
// =============================================================================

interface FlashConfig {
  position: Vector3;
  scale: number;
}

/** 爆発閃光: 一瞬の加算発光球の拡大フェード。 */
class ExplosionFlashPool implements VfxPool<FlashConfig> {
  private readonly slots: FlashSlot[] = [];
  private readonly mesh: Mesh;
  private readonly material: MeshBasicMaterial;
  private readonly geometry: SphereGeometry;
  private head = 0;

  constructor(
    private readonly scene: Scene,
    private readonly capacity = 32,
  ) {
    this.geometry = new SphereGeometry(1, 12, 12);
    this.material = new MeshBasicMaterial({
      color: 0xffaa33,
      transparent: true,
      opacity: 1,
      blending: AdditiveBlending,
      depthWrite: false,
    });
    this.mesh = new Mesh(this.geometry, this.material);
    this.mesh.visible = false; // アクティブスロットがない時は非表示
    // 個別spawnで管理するため、Mesh自体は代表として1個だけscene追加。
    // 実際はslotごとに個別Mesh管理が必要だが、簡易のため多数spawn時はリングバッファで回す。
    // より正確にはInstancedMeshにすべきだが、閃光は同時多発が少ないためシンプル実装で妥協。
  }

  spawn(config: FlashConfig): void {
    const slot = this.slots[this.head];
    if (slot && slot.active) {
      // 既存スロット再利用
      slot.age = 0;
      slot.ttl = 0.15;
      slot.position.copy(config.position);
      slot.maxScale = config.scale * 60;
    } else {
      // 新規スロット
      const newSlot: FlashSlot = {
        age: 0,
        ttl: 0.15,
        active: true,
        position: config.position.clone(),
        maxScale: config.scale * 60,
      };
      // 容量上限チェック
      if (this.slots.length < this.capacity) {
        this.slots.push(newSlot);
        // 対応Mesh追加
        const mesh = new Mesh(this.geometry, this.material.clone());
        mesh.position.copy(newSlot.position);
        mesh.scale.setScalar(newSlot.maxScale * 0.2);
        this.scene.add(mesh);
        newSlot.active = true;
        (newSlot as any).mesh = mesh; // 拡張プロパティでMeshを保持
      } else {
        // リングバッファで最古を上書き
        this.slots[this.head] = newSlot;
        newSlot.active = true;
        const mesh = (this.slots[this.head] as any).mesh as Mesh | undefined;
        if (mesh) {
          mesh.position.copy(newSlot.position);
          mesh.scale.setScalar(newSlot.maxScale * 0.2);
          mesh.visible = true;
          (mesh.material as MeshBasicMaterial).opacity = 1;
        }
      }
    }
    this.head = (this.head + 1) % this.capacity;
  }

  update(dt: number): void {
    for (const slot of this.slots) {
      if (!slot.active) continue;
      slot.age += dt;
      const p = slot.age / slot.ttl;
      if (p >= 1) {
        slot.active = false;
        const mesh = (slot as any).mesh as Mesh | undefined;
        if (mesh) mesh.visible = false;
        continue;
      }
      const mesh = (slot as any).mesh as Mesh | undefined;
      if (!mesh) continue;
      const scale = slot.maxScale * (0.2 + 0.8 * Math.sqrt(p));
      mesh.scale.setScalar(scale);
      (mesh.material as MeshBasicMaterial).opacity = 1 - p;
    }
  }

  activeCount(): number {
    return this.slots.filter((s) => s.active).length;
  }

  reset(): void {
    for (const slot of this.slots) {
      slot.active = false;
      const mesh = (slot as any).mesh as Mesh | undefined;
      if (mesh) {
        mesh.visible = false;
        this.scene.remove(mesh);
        (mesh.material as MeshBasicMaterial).dispose();
      }
    }
    this.slots.length = 0;
    this.head = 0;
  }

  dispose(): void {
    this.reset();
    this.material.dispose();
    this.geometry.dispose();
  }
}

// =============================================================================
// 衝撃波リング (explosion.shockwave)
// =============================================================================

interface ShockwaveConfig {
  position: Vector3;
  scale: number;
}

/** 衝撃波リング: 拡大する加算リング。 */
class ExplosionShockwavePool implements VfxPool<ShockwaveConfig> {
  private readonly slots: ShockwaveSlot[] = [];
  private readonly geometry: RingGeometry;
  private readonly material: MeshBasicMaterial;
  private head = 0;

  constructor(
    private readonly scene: Scene,
    private readonly capacity = 16,
  ) {
    this.geometry = new RingGeometry(0.5, 1, 16);
    this.material = new MeshBasicMaterial({
      color: 0xffaa55,
      transparent: true,
      opacity: 0.8,
      blending: AdditiveBlending,
      depthWrite: false,
      side: 2, // DoubleSide
    });
  }

  spawn(config: ShockwaveConfig): void {
    const newSlot: ShockwaveSlot = {
      age: 0,
      ttl: 0.5,
      active: true,
      position: config.position.clone(),
      maxScale: config.scale * 120,
    };
    if (this.slots.length < this.capacity) {
      this.slots.push(newSlot);
      const mesh = new Mesh(this.geometry, this.material.clone());
      mesh.position.copy(newSlot.position);
      mesh.scale.setScalar(newSlot.maxScale * 0.1);
      this.scene.add(mesh);
      (newSlot as any).mesh = mesh;
    } else {
      const oldSlot = this.slots[this.head];
      oldSlot.age = 0;
      oldSlot.ttl = 0.5;
      oldSlot.active = true;
      oldSlot.position.copy(config.position);
      oldSlot.maxScale = config.scale * 120;
      const mesh = (oldSlot as any).mesh as Mesh | undefined;
      if (mesh) {
        mesh.position.copy(oldSlot.position);
        mesh.scale.setScalar(oldSlot.maxScale * 0.1);
        mesh.visible = true;
        (mesh.material as MeshBasicMaterial).opacity = 0.8;
      }
      this.head = (this.head + 1) % this.capacity;
    }
  }

  update(dt: number): void {
    for (const slot of this.slots) {
      if (!slot.active) continue;
      slot.age += dt;
      const p = slot.age / slot.ttl;
      if (p >= 1) {
        slot.active = false;
        const mesh = (slot as any).mesh as Mesh | undefined;
        if (mesh) mesh.visible = false;
        continue;
      }
      const mesh = (slot as any).mesh as Mesh | undefined;
      if (!mesh) continue;
      const scale = slot.maxScale * (0.1 + 0.9 * p);
      mesh.scale.setScalar(scale);
      (mesh.material as MeshBasicMaterial).opacity = 0.8 * (1 - p);
    }
  }

  activeCount(): number {
    return this.slots.filter((s) => s.active).length;
  }

  reset(): void {
    for (const slot of this.slots) {
      slot.active = false;
      const mesh = (slot as any).mesh as Mesh | undefined;
      if (mesh) {
        this.scene.remove(mesh);
        (mesh.material as MeshBasicMaterial).dispose();
      }
    }
    this.slots.length = 0;
    this.head = 0;
  }

  dispose(): void {
    this.reset();
    this.material.dispose();
    this.geometry.dispose();
  }
}

// =============================================================================
// デブリ (explosion.debris)
// =============================================================================

interface DebrisConfig {
  position: Vector3;
  count: number;
  scale: number;
  velocity?: Vector3; // 爆発時の親速度継承用
}

/** デブリ: InstancedMeshで低ポリBoxを放射状に飛散。 */
class ExplosionDebrisPool implements VfxPool<DebrisConfig> {
  private readonly slots: DebrisSlot[] = [];
  private readonly instancedMesh: InstancedMesh;
  private readonly material: MeshBasicMaterial;
  private readonly geometry: BoxGeometry;
  private head = 0;

  constructor(
    private readonly scene: Scene,
    private readonly capacity = 128,
  ) {
    this.geometry = new BoxGeometry(1, 1, 1);
    this.material = new MeshBasicMaterial({ color: 0x888888 });
    this.instancedMesh = new InstancedMesh(this.geometry, this.material, this.capacity);
    this.instancedMesh.instanceMatrix.setUsage(35048); // DYNAMIC_DRAW
    this.scene.add(this.instancedMesh);
    this.instancedMesh.count = 0;
  }

  spawn(config: DebrisConfig): void {
    const count = Math.min(config.count, this.capacity - this.activeCount());
    for (let i = 0; i < count; i++) {
      const slot: DebrisSlot = {
        age: 0,
        ttl: 1.5 + Math.random() * 0.5,
        active: true,
        position: config.position.clone(),
        velocity: new Vector3(
          (Math.random() - 0.5) * 400,
          (Math.random() - 0.5) * 400,
          (Math.random() - 0.5) * 400,
        ),
        scale: config.scale * (0.5 + Math.random() * 1.5),
      };
      // 親速度継承
      if (config.velocity) slot.velocity.add(config.velocity);
      if (this.slots.length < this.capacity) {
        this.slots.push(slot);
      } else {
        this.slots[this.head] = slot;
        this.head = (this.head + 1) % this.capacity;
      }
    }
  }

  update(dt: number): void {
    let activeIdx = 0;
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i];
      if (!slot.active) continue;
      slot.age += dt;
      if (slot.age >= slot.ttl) {
        slot.active = false;
        continue;
      }
      // 簡易物理: 減速 + 重力
      slot.velocity.multiplyScalar(0.98);
      slot.velocity.y -= 80 * dt;
      slot.position.addScaledVector(slot.velocity, dt);
      // インスタンス行列更新
      _tmpMat.identity();
      _tmpMat.makeTranslation(slot.position.x, slot.position.y, slot.position.z);
      _tmpMat.scale(_tmpVec.setScalar(slot.scale));
      this.instancedMesh.setMatrixAt(activeIdx, _tmpMat);
      activeIdx++;
    }
    this.instancedMesh.count = activeIdx;
    this.instancedMesh.instanceMatrix.needsUpdate = true;
  }

  activeCount(): number {
    return this.slots.filter((s) => s.active).length;
  }

  reset(): void {
    for (const slot of this.slots) slot.active = false;
    this.instancedMesh.count = 0;
    this.slots.length = 0;
    this.head = 0;
  }

  dispose(): void {
    this.reset();
    this.scene.remove(this.instancedMesh);
    this.material.dispose();
    this.geometry.dispose();
  }
}

// =============================================================================
// 煙 (explosion.smoke)
// =============================================================================

interface SmokeConfig {
  position: Vector3;
  count: number;
}

/** 煙: Points群を拡散上昇させてフェード。 */
class ExplosionSmokePool implements VfxPool<SmokeConfig> {
  private readonly slots: PointSlot[] = [];
  private readonly points: Points;
  private readonly geometry: BufferGeometry;
  private readonly material: PointsMaterial;
  private readonly posArray: Float32Array;
  private readonly colorArray: Float32Array;
  private head = 0;

  constructor(
    private readonly scene: Scene,
    private readonly capacity = 256,
  ) {
    this.posArray = new Float32Array(this.capacity * 3);
    this.colorArray = new Float32Array(this.capacity * 3);
    this.geometry = new BufferGeometry();
    this.geometry.setAttribute("position", new BufferAttribute(this.posArray, 3));
    this.geometry.setAttribute("color", new BufferAttribute(this.colorArray, 3));
    this.material = new PointsMaterial({
      size: 8,
      vertexColors: true,
      transparent: true,
      opacity: 0.4,
      depthWrite: false,
    });
    this.points = new Points(this.geometry, this.material);
    this.scene.add(this.points);
  }

  spawn(config: SmokeConfig): void {
    const count = Math.min(config.count, this.capacity - this.activeCount());
    for (let i = 0; i < count; i++) {
      const slot: PointSlot = {
        age: 0,
        ttl: 1.5 + Math.random() * 0.5,
        active: true,
        position: config.position.clone().add(
          _tmpVec.set((Math.random() - 0.5) * 20, (Math.random() - 0.5) * 20, (Math.random() - 0.5) * 20),
        ),
        velocity: new Vector3((Math.random() - 0.5) * 50, 50 + Math.random() * 50, (Math.random() - 0.5) * 50),
      };
      if (this.slots.length < this.capacity) {
        this.slots.push(slot);
      } else {
        this.slots[this.head] = slot;
        this.head = (this.head + 1) % this.capacity;
      }
    }
  }

  update(dt: number): void {
    let activeIdx = 0;
    for (const slot of this.slots) {
      if (!slot.active) continue;
      slot.age += dt;
      if (slot.age >= slot.ttl) {
        slot.active = false;
        continue;
      }
      slot.position.addScaledVector(slot.velocity, dt);
      slot.velocity.multiplyScalar(0.96);
      const p = slot.age / slot.ttl;
      const opacity = 0.4 * (1 - p);
      this.posArray[activeIdx * 3 + 0] = slot.position.x;
      this.posArray[activeIdx * 3 + 1] = slot.position.y;
      this.posArray[activeIdx * 3 + 2] = slot.position.z;
      this.colorArray[activeIdx * 3 + 0] = opacity;
      this.colorArray[activeIdx * 3 + 1] = opacity;
      this.colorArray[activeIdx * 3 + 2] = opacity;
      activeIdx++;
    }
    this.geometry.setDrawRange(0, activeIdx);
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.color.needsUpdate = true;
  }

  activeCount(): number {
    return this.slots.filter((s) => s.active).length;
  }

  reset(): void {
    for (const slot of this.slots) slot.active = false;
    this.geometry.setDrawRange(0, 0);
    this.slots.length = 0;
    this.head = 0;
  }

  dispose(): void {
    this.reset();
    this.scene.remove(this.points);
    this.material.dispose();
    this.geometry.dispose();
  }
}

// =============================================================================
// 火花 (explosion.sparks)
// =============================================================================

interface SparksConfig {
  position: Vector3;
  count: number;
}

/** 火花: 加算Pointsで短命の放射。 */
class ExplosionSparksPool implements VfxPool<SparksConfig> {
  private readonly slots: PointSlot[] = [];
  private readonly points: Points;
  private readonly geometry: BufferGeometry;
  private readonly material: PointsMaterial;
  private readonly posArray: Float32Array;
  private readonly colorArray: Float32Array;
  private head = 0;

  constructor(
    private readonly scene: Scene,
    private readonly capacity = 512,
  ) {
    this.posArray = new Float32Array(this.capacity * 3);
    this.colorArray = new Float32Array(this.capacity * 3);
    this.geometry = new BufferGeometry();
    this.geometry.setAttribute("position", new BufferAttribute(this.posArray, 3));
    this.geometry.setAttribute("color", new BufferAttribute(this.colorArray, 3));
    this.material = new PointsMaterial({
      size: 3,
      vertexColors: true,
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
    });
    this.points = new Points(this.geometry, this.material);
    this.scene.add(this.points);
  }

  spawn(config: SparksConfig): void {
    const count = Math.min(config.count, this.capacity - this.activeCount());
    for (let i = 0; i < count; i++) {
      const slot: PointSlot = {
        age: 0,
        ttl: 0.3 + Math.random() * 0.2,
        active: true,
        position: config.position.clone(),
        velocity: new Vector3(
          (Math.random() - 0.5) * 600,
          (Math.random() - 0.5) * 600,
          (Math.random() - 0.5) * 600,
        ),
      };
      if (this.slots.length < this.capacity) {
        this.slots.push(slot);
      } else {
        this.slots[this.head] = slot;
        this.head = (this.head + 1) % this.capacity;
      }
    }
  }

  update(dt: number): void {
    let activeIdx = 0;
    for (const slot of this.slots) {
      if (!slot.active) continue;
      slot.age += dt;
      if (slot.age >= slot.ttl) {
        slot.active = false;
        continue;
      }
      slot.position.addScaledVector(slot.velocity, dt);
      slot.velocity.multiplyScalar(0.94);
      const p = slot.age / slot.ttl;
      const brightness = 1 - p;
      this.posArray[activeIdx * 3 + 0] = slot.position.x;
      this.posArray[activeIdx * 3 + 1] = slot.position.y;
      this.posArray[activeIdx * 3 + 2] = slot.position.z;
      _tmpColor.setRGB(1 * brightness, 0.6 * brightness, 0.2 * brightness);
      this.colorArray[activeIdx * 3 + 0] = _tmpColor.r;
      this.colorArray[activeIdx * 3 + 1] = _tmpColor.g;
      this.colorArray[activeIdx * 3 + 2] = _tmpColor.b;
      activeIdx++;
    }
    this.geometry.setDrawRange(0, activeIdx);
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.color.needsUpdate = true;
  }

  activeCount(): number {
    return this.slots.filter((s) => s.active).length;
  }

  reset(): void {
    for (const slot of this.slots) slot.active = false;
    this.geometry.setDrawRange(0, 0);
    this.slots.length = 0;
    this.head = 0;
  }

  dispose(): void {
    this.reset();
    this.scene.remove(this.points);
    this.material.dispose();
    this.geometry.dispose();
  }
}

// =============================================================================
// マズルフラッシュ (muzzleFlash)
// =============================================================================

interface MuzzleFlashConfig {
  position: Vector3;
  direction: Vector3;
  kind: "gun" | "missile";
}

/** マズルフラッシュ: 発砲時の短命加算スプライト。 */
class MuzzleFlashPool implements VfxPool<MuzzleFlashConfig> {
  private readonly slots: FlashSlot[] = [];
  private readonly geometry: SphereGeometry;
  private readonly material: MeshBasicMaterial;
  private head = 0;

  constructor(
    private readonly scene: Scene,
    private readonly capacity = 32,
  ) {
    this.geometry = new SphereGeometry(1, 8, 8);
    this.material = new MeshBasicMaterial({
      color: 0xffdd66,
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
    });
  }

  spawn(config: MuzzleFlashConfig): void {
    const ttl = config.kind === "gun" ? 0.06 : 0.12;
    const scale = config.kind === "gun" ? 4 : 10;
    const newSlot: FlashSlot = {
      age: 0,
      ttl,
      active: true,
      position: config.position.clone(),
      maxScale: scale,
    };
    if (this.slots.length < this.capacity) {
      this.slots.push(newSlot);
      const mesh = new Mesh(this.geometry, this.material.clone());
      mesh.position.copy(newSlot.position);
      mesh.scale.setScalar(newSlot.maxScale);
      this.scene.add(mesh);
      (newSlot as any).mesh = mesh;
    } else {
      const oldSlot = this.slots[this.head];
      oldSlot.age = 0;
      oldSlot.ttl = ttl;
      oldSlot.active = true;
      oldSlot.position.copy(config.position);
      oldSlot.maxScale = scale;
      const mesh = (oldSlot as any).mesh as Mesh | undefined;
      if (mesh) {
        mesh.position.copy(oldSlot.position);
        mesh.scale.setScalar(oldSlot.maxScale);
        mesh.visible = true;
        (mesh.material as MeshBasicMaterial).opacity = 1;
      }
      this.head = (this.head + 1) % this.capacity;
    }
  }

  update(dt: number): void {
    for (const slot of this.slots) {
      if (!slot.active) continue;
      slot.age += dt;
      if (slot.age >= slot.ttl) {
        slot.active = false;
        const mesh = (slot as any).mesh as Mesh | undefined;
        if (mesh) mesh.visible = false;
        continue;
      }
      const mesh = (slot as any).mesh as Mesh | undefined;
      if (!mesh) continue;
      const p = slot.age / slot.ttl;
      (mesh.material as MeshBasicMaterial).opacity = 1 - p;
    }
  }

  activeCount(): number {
    return this.slots.filter((s) => s.active).length;
  }

  reset(): void {
    for (const slot of this.slots) {
      slot.active = false;
      const mesh = (slot as any).mesh as Mesh | undefined;
      if (mesh) {
        this.scene.remove(mesh);
        (mesh.material as MeshBasicMaterial).dispose();
      }
    }
    this.slots.length = 0;
    this.head = 0;
  }

  dispose(): void {
    this.reset();
    this.material.dispose();
    this.geometry.dispose();
  }
}

// =============================================================================
// トレイル (trail) — 弾/ミサイル軌跡
// =============================================================================

interface TrailConfig {
  position: Vector3;
  kind: "gun" | "missile";
}

/** トレイル: 各呼び出しでpositionに短命の加算点を置くリングバッファ方式。 */
class TrailPool implements VfxPool<TrailConfig> {
  private readonly slots: PointSlot[] = [];
  private readonly points: Points;
  private readonly geometry: BufferGeometry;
  private readonly material: PointsMaterial;
  private readonly posArray: Float32Array;
  private readonly colorArray: Float32Array;
  private head = 0;

  constructor(
    private readonly scene: Scene,
    private readonly capacity = 1024,
  ) {
    this.posArray = new Float32Array(this.capacity * 3);
    this.colorArray = new Float32Array(this.capacity * 3);
    this.geometry = new BufferGeometry();
    this.geometry.setAttribute("position", new BufferAttribute(this.posArray, 3));
    this.geometry.setAttribute("color", new BufferAttribute(this.colorArray, 3));
    this.material = new PointsMaterial({
      size: 4,
      vertexColors: true,
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
    });
    this.points = new Points(this.geometry, this.material);
    this.scene.add(this.points);
  }

  spawn(config: TrailConfig): void {
    const ttl = config.kind === "gun" ? 0.15 : 0.6;
    const slot: PointSlot = {
      age: 0,
      ttl,
      active: true,
      position: config.position.clone(),
      velocity: new Vector3(),
    };
    if (this.slots.length < this.capacity) {
      this.slots.push(slot);
    } else {
      this.slots[this.head] = slot;
      this.head = (this.head + 1) % this.capacity;
    }
  }

  update(dt: number): void {
    let activeIdx = 0;
    for (const slot of this.slots) {
      if (!slot.active) continue;
      slot.age += dt;
      if (slot.age >= slot.ttl) {
        slot.active = false;
        continue;
      }
      const p = slot.age / slot.ttl;
      const brightness = 1 - p;
      this.posArray[activeIdx * 3 + 0] = slot.position.x;
      this.posArray[activeIdx * 3 + 1] = slot.position.y;
      this.posArray[activeIdx * 3 + 2] = slot.position.z;
      // ミサイルは煙質(低輝度)、弾は光質(高輝度)
      const isGun = slot.ttl < 0.3; // gun判定簡易化
      if (isGun) {
        _tmpColor.setRGB(0.8 * brightness, 0.8 * brightness, 1 * brightness);
      } else {
        _tmpColor.setRGB(0.5 * brightness, 0.5 * brightness, 0.4 * brightness);
      }
      this.colorArray[activeIdx * 3 + 0] = _tmpColor.r;
      this.colorArray[activeIdx * 3 + 1] = _tmpColor.g;
      this.colorArray[activeIdx * 3 + 2] = _tmpColor.b;
      activeIdx++;
    }
    this.geometry.setDrawRange(0, activeIdx);
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.color.needsUpdate = true;
  }

  activeCount(): number {
    return this.slots.filter((s) => s.active).length;
  }

  reset(): void {
    for (const slot of this.slots) slot.active = false;
    this.geometry.setDrawRange(0, 0);
    this.slots.length = 0;
    this.head = 0;
  }

  dispose(): void {
    this.reset();
    this.scene.remove(this.points);
    this.material.dispose();
    this.geometry.dispose();
  }
}

// =============================================================================
// 登録関数
// =============================================================================

/**
 * 戦闘VFXプール群を VfxManager に一括登録する。
 * bootstrap時に1回だけ呼ぶ。
 */
export function registerCombatVfx(vfx: VfxManager): void {
  const scene = vfx.scene;
  vfx.register("explosion.flash", new ExplosionFlashPool(scene));
  vfx.register("explosion.shockwave", new ExplosionShockwavePool(scene));
  vfx.register("explosion.debris", new ExplosionDebrisPool(scene));
  vfx.register("explosion.smoke", new ExplosionSmokePool(scene));
  vfx.register("explosion.sparks", new ExplosionSparksPool(scene));
  vfx.register("muzzleFlash", new MuzzleFlashPool(scene));
  vfx.register("trail", new TrailPool(scene));
}
