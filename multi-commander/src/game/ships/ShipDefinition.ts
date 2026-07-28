export type Vec3Tuple = [number, number, number];

export interface VisualDefinition {
  kind: "primitive" | "gltf";
  primitive?: {
    bodyColor: number;
    accentColor: number;
    /** 機体スケール (幅, 高さ, 全長)。 */
    scale: Vec3Tuple;
    shape: "wedge" | "interceptor" | "heavy";
    engineGlow: number;
  };
  gltf?: { url: string };
}

export interface ShipFlightDef {
  maxLinearSpeed: number;
  afterburnerMaxSpeed: number;
  linearThrust: Vec3Tuple;
  angularThrust: Vec3Tuple;
  linearDamping: number;
  angularDamping: number;
}

export interface ShipHealthDef {
  shieldMax: number;
  shieldRegenRate: number;
  shieldRegenDelay: number;
  armorMax: number;
  hullMax: number;
}

export interface ShipWeaponDef {
  gunFireInterval: number;
  gunDamage: number;
  gunProjectileSpeed: number;
  gunRange: number;
  energyMax: number;
  energyRegen: number;
  energyPerShot: number;
  missiles: number;
  missileFireInterval: number;
}

/** データ駆動の機体定義。ここを増やすだけで新機体を追加できる。 */
export interface ShipDefinition {
  id: string;
  displayName: string;
  mass: number;
  inertia: Vec3Tuple;
  /** 衝突球半径。 */
  radius: number;
  /** 武器ハードポイントのローカル座標。 */
  hardpoints: Vec3Tuple[];
  flight: ShipFlightDef;
  health: ShipHealthDef;
  weapon: ShipWeaponDef;
  visual: VisualDefinition;
}
