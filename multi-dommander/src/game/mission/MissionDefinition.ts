import type { Vec3Tuple } from "../ships/ShipDefinition";

/** 敵1機のスポーン指定。 */
export interface ShipSpawn {
  shipId: string;
  position: Vec3Tuple;
  /** Y軸回転(ラジアン)。省略時はプレイヤー方向を向く。 */
  facingYaw?: number;
}

/** ウェーブ出現トリガー。 */
export type WaveTrigger =
  | { type: "start" }
  | { type: "afterWave"; wave: number } // 指定ウェーブ全滅後
  | { type: "time"; seconds: number }; // ミッション開始からの経過秒

/** 敵ウェーブ。 */
export interface WaveDefinition {
  trigger: WaveTrigger;
  ships: ShipSpawn[];
  /** 出現時のアナウンス (HUD ログ)。 */
  announce?: string;
}

/** 護衛/守備対象や中立艦のスポーン。 */
export interface AllySpawn {
  shipId: string;
  position: Vec3Tuple;
  facingYaw?: number;
  /** 護衛対象としてマークするID (protect目標から参照)。 */
  tag?: string;
  /** 僚機として戦闘AIを付けるか (段階C)。false=中立/被護衛。 */
  combatant: boolean;
}

/** ナビゲーションポイント。 */
export interface NavPoint {
  id: string;
  label: string;
  position: Vec3Tuple;
  radius: number;
}

/** ミッション目標。 */
export type ObjectiveDefinition =
  | { id: string; label: string; type: "destroyAll"; optional?: boolean }
  | { id: string; label: string; type: "protect"; tag: string; optional?: boolean }
  | { id: string; label: string; type: "reachNav"; nav: string; optional?: boolean }
  | { id: string; label: string; type: "survive"; seconds: number; optional?: boolean };

/** ミッション定義 (データ駆動)。 */
export interface MissionDefinition {
  id: string;
  name: string;
  /** ブリーフィング文 (段階B)。 */
  briefing: string[];
  playerShipId: string;
  playerSpawn: Vec3Tuple;
  playerFacingYaw?: number;
  wingmen: AllySpawn[];
  neutrals: AllySpawn[];
  navPoints: NavPoint[];
  waves: WaveDefinition[];
  objectives: ObjectiveDefinition[];
  successText: string;
  failText: string;
}
