import type { Vector3, Quaternion, Object3D } from "three";
import type { EntityId } from "../ecs/Entity";

/** コンポーネント名の定数。文字列タイプミス防止のため必ずここを参照する。 */
export const Comp = {
  Transform: "Transform",
  RigidBody: "RigidBody",
  FlightModel: "FlightModel",
  ThrusterInput: "ThrusterInput",
  Health: "Health",
  WeaponMount: "WeaponMount",
  Targeting: "Targeting",
  AIController: "AIController",
  PlayerControlled: "PlayerControlled",
  Faction: "Faction",
  Renderable: "Renderable",
  Projectile: "Projectile",
  Missile: "Missile",
  Decoy: "Decoy",
  Lifetime: "Lifetime",
  Collider: "Collider",
  ShipInfo: "ShipInfo",
} as const;

/** 陣営。数値で持ち、敵味方判定は一致/不一致で行う。 */
export enum Faction {
  Player = 0,
  Ally = 1,
  Enemy = 2,
  Neutral = 3,
}

/** 位置・姿勢。prev* は描画補間用。 */
export interface Transform {
  position: Vector3;
  quaternion: Quaternion;
  prevPosition: Vector3;
  prevQuaternion: Quaternion;
}

/** 剛体。velocity はワールド系、angularVelocity は機体ローカル系(roll,pitch,yaw)。 */
export interface RigidBody {
  velocity: Vector3;
  angularVelocity: Vector3;
  mass: number;
  /** 主慣性モーメント対角成分 (roll, pitch, yaw)。 */
  inertia: Vector3;
}

/** 飛行モデルのパラメータと状態。 */
export interface FlightModel {
  maxLinearSpeed: number;
  afterburnerMaxSpeed: number;
  /** 各軸最大推力 (x=左右/sway, y=上下/heave, z=前後/surge)。 */
  linearThrust: Vector3;
  /** 各軸最大トルク (x=pitch, y=yaw, z=roll)。 */
  angularThrust: Vector3;
  linearDamping: number;
  angularDamping: number;
  flightAssist: boolean;
}

/** 操縦入力 (プレイヤー/AI共通)。各成分 -1..1。 */
export interface ThrusterInput {
  /** x=左右, y=上下, z=前後(+で前進)。 */
  linear: Vector3;
  /** x=pitch(+で機首上げ), y=yaw(+で右), z=roll(+で右ロール)。 */
  angular: Vector3;
  afterburner: boolean;
  firePrimary: boolean;
  fireMissile: boolean;
}

/** ダメージモデル。適用順は shield -> armor -> hull。 */
export interface Health {
  shield: number;
  shieldMax: number;
  shieldRegenRate: number;
  shieldRegenDelay: number;
  armor: number;
  armorMax: number;
  hull: number;
  hullMax: number;
  /** 最後に被弾したシミュレーション時刻 (秒)。 */
  lastHitTime: number;
  /** 最後にダメージを与えたエンティティ (撃墜のキル帰属に使う)。 */
  lastHitBy?: EntityId | null;
}

/** 武器搭載状態。エネルギー砲とミサイルを扱う。 */
export interface WeaponMount {
  /** 砲のクールダウン残り (秒)。 */
  gunCooldown: number;
  gunFireInterval: number;
  gunDamage: number;
  gunProjectileSpeed: number;
  gunRange: number;
  /** エネルギー (0..energyMax)。発射で消費、時間で回復。 */
  energy: number;
  energyMax: number;
  energyRegen: number;
  energyPerShot: number;
  /** 砲口ローカルオフセット (複数ハードポイント)。 */
  hardpoints: Vector3[];
  /** ミサイル残弾。 */
  missiles: number;
  missileCooldown: number;
  missileFireInterval: number;
  /** フレア(デコイ)残弾。 */
  flares: number;
  /** 搭載する砲の WeaponDef ID。 */
  gunId?: string;
  /** 搭載する副兵装 (ミサイル等) の WeaponDef ID リスト。 */
  secondaries?: string[];
  /** 現在選択中の副兵装インデックス (secondaries 内)。 */
  activeSecondary?: number;
  /** 副兵装ごとの残弾。 */
  secondaryAmmo?: Record<string, number>;
  /** 砲の弾色 (WeaponDef.color から)。 */
  gunColor?: number;
  /** 砲の弾の見た目種別。 */
  gunVisual?: string;
}

/** ターゲッティング状態。 */
export interface Targeting {
  target: EntityId | null;
  /** ロックオン進行度 0..1。1でロック完了。 */
  lockProgress: number;
  lockTime: number;
}

/** レンダリング対象。ECS Transform を Object3D に同期する。 */
export interface Renderable {
  object: Object3D;
}

/** 衝突用の境界球半径。 */
export interface Collider {
  radius: number;
}

/** 弾 (エネルギー砲)。 */
export interface Projectile {
  damage: number;
  /** 発射元エンティティ。自傷防止に使う。 */
  source: EntityId;
  sourceFaction: Faction;
}

/** 誘導ミサイル。 */
export interface Missile {
  damage: number;
  source: EntityId;
  sourceFaction: Faction;
  target: EntityId | null;
  turnRate: number;
  speed: number;
  /** シーカー種別。none=無誘導直進, heat=赤外線(後方有利), aspect=全周画像認識。 */
  seeker?: "none" | "heat" | "aspect";
  /** デコイ感受性 (0..1)。高いほどフレアに引きやすい。 */
  flareSensitivity?: number;
}

/** デコイ(フレア)。誘導ミサイルを引き剥がす対抗手段。 */
export interface Decoy {
  /** 射出元の陣営。ミサイルの sourceFaction と敵対する側を誘惑する。 */
  faction: Faction;
}

/** 自動消滅タイマー (秒)。0以下で破棄。 */
export interface Lifetime {
  remaining: number;
}

/** 表示名等のメタ情報。 */
export interface ShipInfo {
  displayName: string;
  shipId: string;
  /** エースパイロットか。キルフィード/ターゲットBoxの強調表示に使う。 */
  isAce?: boolean;
}
