/** 機体・艦艇のデータ定義。 */

export type Faction = 'confed' | 'kilrathi' | 'neutral';

export type ShipRole = 'fighter' | 'bomber' | 'transport' | 'capital';

export interface HardpointDef {
  gunId: string;
  /** 機体ローカル座標の砲口位置 */
  offset: [number, number, number];
}

export interface MissileLoadDef {
  missileId: string;
  count: number;
}

export interface VisualDef {
  /** 手続き生成の骨格タイプ */
  kind: 'arrow' | 'delta' | 'twin-boom' | 'bat' | 'brick' | 'hauler' | 'warship';
  hull: number;
  accent: number;
  engine: number;
  /** GLTF に差し替えたいときのみ指定 (未指定なら手続き生成) */
  gltf?: string;
}

export interface ShipDef {
  id: string;
  /** HUD 等に出す名前 */
  name: string;
  role: ShipRole;
  /** 当たり判定半径 */
  radius: number;
  /** メッシュのスケール基準 */
  size: number;

  /** 巡航最大速度 (units/s) */
  maxSpeed: number;
  /** アフターバーナー最大速度 */
  abSpeed: number;
  /** 加速度 (units/s^2) */
  accel: number;
  /** 最大角速度 (rad/s) pitch/yaw/roll */
  turn: [number, number, number];
  /** 角速度が指令値へ追従する速さ (大きいほどキビキビ) */
  agility: number;

  /**
   * 機体の癖 (乗り換えたときに手触りが変わるための値)。
   *
   * - drift: 速度ベクトルが機首方向へ追従する遅さ。0 で機首なりに素直、1 で流れる。
   *   重い機体を大きくすると「曲がっても機体が滑る」感じになる。
   * - turnSpeedPenalty: 最高速付近で失う旋回性能の割合。
   *   大きい機体ほど「曲がりたければ減速する」判断を強いられる。
   */
  handling: { drift: number; turnSpeedPenalty: number };

  hull: number;
  /** アーマー4象限 */
  armor: { front: number; rear: number; left: number; right: number };
  /** シールド前後と再生速度 (毎秒) */
  shield: { front: number; rear: number; regen: number };

  /** 砲エネルギー上限と再生 */
  energy: number;
  energyRegen: number;

  /** アフターバーナー燃料 (秒相当) */
  fuel: number;
  fuelBurn: number;

  guns: HardpointDef[];
  missiles: MissileLoadDef[];
  /** フレア搭載数 */
  flares: number;

  visual: VisualDef;

  /** 撃墜時のスコア表示用 */
  threat: number;

  /**
   * 砲口オフセットをワールド単位へ変換する係数。
   * scale() が size と visual.kind から自動で入れるので、定義側では書かない。
   */
  hardpointScale: number;
}

/**
 * 全機体に掛かるサイズ倍率。
 * 交戦距離 (300〜800) で敵機が視認・照準できる大きさになるよう調整した値。
 */
export const SHIP_SCALE = 1.5;

/**
 * 手続き生成メッシュを組む際の基準半長。
 * 各ビルダーはこの長さ前後で機体を組み、実際の大きさは size に合わせて拡縮する。
 * 砲口オフセットもこの空間で書かれているので、描画とロジックが同じ係数を共有する。
 */
export const VISUAL_BASE_HALF_LENGTH: Record<VisualDef['kind'], number> = {
  arrow: 7,
  delta: 8,
  'twin-boom': 8,
  bat: 7,
  brick: 9,
  hauler: 26,
  warship: 80,
};

const F = (
  o: Omit<Partial<ShipDef>, 'hardpointScale'> & Pick<ShipDef, 'id' | 'name'>,
): ShipDef => scale({
  role: 'fighter',
  radius: 12,
  size: 12,
  maxSpeed: 320,
  abSpeed: 620,
  accel: 260,
  turn: [1.5, 1.3, 2.6],
  agility: 7,
  handling: { drift: 0.3, turnSpeedPenalty: 0.25 },
  hull: 120,
  armor: { front: 40, rear: 30, left: 30, right: 30 },
  shield: { front: 45, rear: 45, regen: 6 },
  energy: 120,
  energyRegen: 78,
  fuel: 6,
  fuelBurn: 1,
  guns: [{ gunId: 'laser', offset: [-3.5, -0.4, -6] }, { gunId: 'laser', offset: [3.5, -0.4, -6] }],
  missiles: [{ missileId: 'dumbfire', count: 2 }],
  flares: 6,
  visual: { kind: 'arrow', hull: 0x6e7780, accent: 0x3f7cc0, engine: 0x66ccff },
  threat: 1,
  hardpointScale: 1,
  ...o,
});

function scale(def: ShipDef): ShipDef {
  const size = def.size * SHIP_SCALE;
  return {
    ...def,
    radius: def.radius * SHIP_SCALE,
    size,
    hardpointScale: size / VISUAL_BASE_HALF_LENGTH[def.visual.kind],
  };
}

// ───────── Terran Confederation ─────────

export const HORNET = F({
  id: 'hornet',
  name: 'F-54 ホーネット',
  radius: 10,
  size: 10,
  maxSpeed: 400,
  abSpeed: 800,
  accel: 320,
  turn: [1.9, 1.7, 3.4],
  agility: 9,
  handling: { drift: 0.12, turnSpeedPenalty: 0.1 },
  hull: 100,
  armor: { front: 25, rear: 25, left: 25, right: 25 },
  shield: { front: 42, rear: 42, regen: 7 },
  energy: 110,
  energyRegen: 75,
  fuel: 6,
  guns: [
    { gunId: 'laser', offset: [-3, -0.3, -5] },
    { gunId: 'laser', offset: [3, -0.3, -5] },
  ],
  missiles: [{ missileId: 'dumbfire', count: 2 }],
  visual: { kind: 'arrow', hull: 0x78808a, accent: 0x2f6fb5, engine: 0x77ddff },
  threat: 1,
});

export const SCIMITAR = F({
  id: 'scimitar',
  name: 'F-38 スミター',
  radius: 13,
  size: 13,
  maxSpeed: 300,
  abSpeed: 600,
  accel: 240,
  turn: [1.5, 1.35, 2.5],
  agility: 7,
  handling: { drift: 0.22, turnSpeedPenalty: 0.16 },
  hull: 180,
  armor: { front: 45, rear: 40, left: 40, right: 40 },
  shield: { front: 68, rear: 68, regen: 6 },
  energy: 130,
  energyRegen: 82,
  fuel: 7,
  guns: [
    { gunId: 'mass-driver', offset: [-4, -0.5, -6] },
    { gunId: 'mass-driver', offset: [4, -0.5, -6] },
  ],
  missiles: [{ missileId: 'dumbfire', count: 2 }, { missileId: 'heat-seeker', count: 1 }],
  visual: { kind: 'delta', hull: 0x6e767d, accent: 0x2e6f5e, engine: 0x88ffcc },
  threat: 1,
});

export const RAPTOR = F({
  id: 'raptor',
  name: 'F-44 ラプター',
  radius: 16,
  size: 16,
  maxSpeed: 280,
  abSpeed: 560,
  accel: 220,
  turn: [1.25, 1.1, 2.0],
  agility: 6,
  handling: { drift: 0.24, turnSpeedPenalty: 0.15 },
  hull: 300,
  armor: { front: 80, rear: 70, left: 70, right: 70 },
  shield: { front: 100, rear: 100, regen: 6.5 },
  energy: 170,
  energyRegen: 110,
  fuel: 8,
  guns: [
    { gunId: 'laser', offset: [-5, -0.5, -7] },
    { gunId: 'laser', offset: [5, -0.5, -7] },
    { gunId: 'neutron-gun', offset: [-2, 0.6, -7.5] },
    { gunId: 'neutron-gun', offset: [2, 0.6, -7.5] },
  ],
  missiles: [{ missileId: 'dumbfire', count: 3 }, { missileId: 'heat-seeker', count: 3 }],
  visual: { kind: 'twin-boom', hull: 0x656e77, accent: 0x8a5a2b, engine: 0xffaa66 },
  threat: 2,
});

export const RAPIER = F({
  id: 'rapier',
  name: 'F-44A ラピアー II',
  radius: 12,
  size: 12,
  maxSpeed: 450,
  abSpeed: 900,
  accel: 340,
  turn: [1.85, 1.7, 3.2],
  agility: 9,
  handling: { drift: 0.16, turnSpeedPenalty: 0.12 },
  hull: 160,
  armor: { front: 40, rear: 35, left: 35, right: 35 },
  shield: { front: 82, rear: 82, regen: 7 },
  energy: 150,
  energyRegen: 96,
  fuel: 8,
  guns: [
    { gunId: 'laser', offset: [-3.5, -0.4, -6] },
    { gunId: 'laser', offset: [3.5, -0.4, -6] },
    { gunId: 'mass-driver', offset: [-1.6, 0.5, -6.5] },
    { gunId: 'mass-driver', offset: [1.6, 0.5, -6.5] },
  ],
  missiles: [
    { missileId: 'dumbfire', count: 2 },
    { missileId: 'heat-seeker', count: 2 },
    { missileId: 'image-rec', count: 1 },
  ],
  visual: { kind: 'delta', hull: 0x7e8790, accent: 0x24507f, engine: 0x99e6ff },
  threat: 2,
});

export const DRAYMAN = F({
  id: 'drayman',
  name: 'ドレイマン級輸送艦',
  role: 'transport',
  radius: 52,
  size: 52,
  maxSpeed: 90,
  abSpeed: 90,
  accel: 30,
  turn: [0.16, 0.16, 0.2],
  agility: 1.5,
  handling: { drift: 0.8, turnSpeedPenalty: 0.6 },
  hull: 620,
  armor: { front: 110, rear: 110, left: 110, right: 110 },
  shield: { front: 150, rear: 150, regen: 4 },
  energy: 100,
  energyRegen: 10,
  fuel: 0,
  guns: [{ gunId: 'laser', offset: [0, 6, -20] }],
  missiles: [],
  flares: 0,
  visual: { kind: 'hauler', hull: 0x707069, accent: 0x4d5a68, engine: 0x88bbff },
  threat: 3,
});

export const TIGERS_CLAW = F({
  id: 'tigers-claw',
  name: 'TCS タイガーズ・クロー',
  role: 'capital',
  radius: 150,
  size: 150,
  maxSpeed: 60,
  abSpeed: 60,
  accel: 12,
  turn: [0.05, 0.05, 0.05],
  agility: 1,
  handling: { drift: 0.9, turnSpeedPenalty: 0.7 },
  hull: 6000,
  armor: { front: 800, rear: 800, left: 800, right: 800 },
  shield: { front: 700, rear: 700, regen: 10 },
  energy: 400,
  energyRegen: 40,
  fuel: 0,
  guns: [
    { gunId: 'neutron-gun', offset: [-30, 14, -60] },
    { gunId: 'neutron-gun', offset: [30, 14, -60] },
    { gunId: 'neutron-gun', offset: [0, -14, 40] },
  ],
  missiles: [],
  flares: 0,
  visual: { kind: 'warship', hull: 0x5b6167, accent: 0x2b3a4a, engine: 0x99ddff },
  threat: 10,
});

// ───────── Kilrathi Empire ─────────

export const SALTHI = F({
  id: 'salthi',
  name: 'サルシー',
  radius: 9,
  size: 9,
  maxSpeed: 420,
  abSpeed: 780,
  accel: 330,
  turn: [1.95, 1.8, 3.4],
  agility: 9,
  handling: { drift: 0.1, turnSpeedPenalty: 0.08 },
  hull: 70,
  armor: { front: 18, rear: 18, left: 18, right: 18 },
  shield: { front: 30, rear: 30, regen: 6 },
  energy: 90,
  energyRegen: 64,
  fuel: 5,
  guns: [{ gunId: 'laser', offset: [-2.5, 0, -5] }, { gunId: 'laser', offset: [2.5, 0, -5] }],
  missiles: [],
  flares: 2,
  visual: { kind: 'arrow', hull: 0x665738, accent: 0xb04a2a, engine: 0xff8844 },
  threat: 1,
});

export const DRALTHI = F({
  id: 'dralthi',
  name: 'ドラルシー',
  radius: 13,
  size: 13,
  maxSpeed: 330,
  abSpeed: 620,
  accel: 250,
  turn: [1.6, 1.45, 2.6],
  agility: 7.5,
  handling: { drift: 0.26, turnSpeedPenalty: 0.15 },
  hull: 130,
  armor: { front: 32, rear: 28, left: 28, right: 28 },
  shield: { front: 52, rear: 52, regen: 6 },
  energy: 110,
  energyRegen: 72,
  fuel: 6,
  guns: [
    { gunId: 'laser', offset: [-5, 0, -4] },
    { gunId: 'laser', offset: [5, 0, -4] },
  ],
  missiles: [{ missileId: 'dumbfire', count: 1 }],
  flares: 3,
  visual: { kind: 'bat', hull: 0x5a4c31, accent: 0xa8412c, engine: 0xff9955 },
  threat: 1,
});

export const KRANT = F({
  id: 'krant',
  name: 'クラント',
  radius: 14,
  size: 14,
  maxSpeed: 320,
  abSpeed: 600,
  accel: 250,
  turn: [1.5, 1.4, 2.5],
  agility: 7.5,
  handling: { drift: 0.22, turnSpeedPenalty: 0.16 },
  hull: 175,
  armor: { front: 45, rear: 38, left: 38, right: 38 },
  shield: { front: 65, rear: 65, regen: 6 },
  energy: 130,
  energyRegen: 80,
  fuel: 6,
  guns: [
    { gunId: 'mass-driver', offset: [-4.5, -0.4, -6] },
    { gunId: 'mass-driver', offset: [4.5, -0.4, -6] },
  ],
  missiles: [{ missileId: 'heat-seeker', count: 2 }],
  flares: 4,
  visual: { kind: 'twin-boom', hull: 0x4f442f, accent: 0x9c3b26, engine: 0xffa060 },
  threat: 2,
});

export const GRATHA = F({
  id: 'gratha',
  name: 'グラサ',
  radius: 17,
  size: 17,
  maxSpeed: 270,
  abSpeed: 520,
  accel: 210,
  turn: [1.2, 1.1, 1.9],
  agility: 6,
  handling: { drift: 0.3, turnSpeedPenalty: 0.2 },
  hull: 280,
  armor: { front: 65, rear: 55, left: 55, right: 55 },
  shield: { front: 95, rear: 95, regen: 5.5 },
  energy: 180,
  energyRegen: 106,
  fuel: 7,
  guns: [
    { gunId: 'neutron-gun', offset: [-5, -0.5, -7] },
    { gunId: 'neutron-gun', offset: [5, -0.5, -7] },
    { gunId: 'laser', offset: [0, 1.5, -8] },
  ],
  missiles: [{ missileId: 'heat-seeker', count: 3 }],
  flares: 4,
  visual: { kind: 'brick', hull: 0x4c412d, accent: 0x8f3520, engine: 0xff7744 },
  threat: 3,
});

export const JALTHI = F({
  id: 'jalthi',
  name: 'ジャルシー',
  radius: 16,
  size: 16,
  maxSpeed: 300,
  abSpeed: 560,
  accel: 230,
  turn: [1.15, 1.05, 1.8],
  agility: 5.5,
  handling: { drift: 0.32, turnSpeedPenalty: 0.22 },
  hull: 260,
  armor: { front: 60, rear: 50, left: 50, right: 50 },
  shield: { front: 82, rear: 82, regen: 5 },
  energy: 200,
  energyRegen: 116,
  fuel: 6,
  guns: [
    { gunId: 'laser', offset: [-6, -0.5, -6] },
    { gunId: 'laser', offset: [6, -0.5, -6] },
    { gunId: 'laser', offset: [-3, 1, -6.5] },
    { gunId: 'laser', offset: [3, 1, -6.5] },
    { gunId: 'neutron-gun', offset: [-1.5, -1.2, -7] },
    { gunId: 'neutron-gun', offset: [1.5, -1.2, -7] },
  ],
  missiles: [{ missileId: 'dumbfire', count: 2 }],
  flares: 3,
  visual: { kind: 'delta', hull: 0x4e422b, accent: 0xa03a1f, engine: 0xff8040 },
  threat: 4,
});

export const DORKIR = F({
  id: 'dorkir',
  name: 'ドーキア級輸送艦',
  role: 'transport',
  radius: 50,
  size: 50,
  maxSpeed: 85,
  abSpeed: 85,
  accel: 28,
  turn: [0.16, 0.16, 0.2],
  agility: 1.5,
  handling: { drift: 0.8, turnSpeedPenalty: 0.6 },
  hull: 430,
  armor: { front: 80, rear: 80, left: 80, right: 80 },
  shield: { front: 120, rear: 120, regen: 4 },
  energy: 120,
  energyRegen: 12,
  fuel: 0,
  guns: [
    { gunId: 'laser', offset: [-8, 5, -18] },
    { gunId: 'laser', offset: [8, 5, -18] },
  ],
  missiles: [],
  flares: 0,
  visual: { kind: 'hauler', hull: 0x5a4f36, accent: 0x59402c, engine: 0xffaa55 },
  threat: 3,
});

export const RALATHA = F({
  id: 'ralatha',
  name: 'ラーラサ級駆逐艦',
  role: 'capital',
  radius: 95,
  size: 95,
  maxSpeed: 70,
  abSpeed: 70,
  accel: 16,
  turn: [0.07, 0.07, 0.09],
  agility: 1,
  handling: { drift: 0.9, turnSpeedPenalty: 0.7 },
  hull: 2000,
  armor: { front: 320, rear: 320, left: 320, right: 320 },
  shield: { front: 420, rear: 420, regen: 8 },
  energy: 350,
  energyRegen: 36,
  fuel: 0,
  guns: [
    { gunId: 'neutron-gun', offset: [-12, 4, -40] },
    { gunId: 'neutron-gun', offset: [12, 4, -40] },
    { gunId: 'neutron-gun', offset: [-12, 4, -16] },
    { gunId: 'neutron-gun', offset: [12, 4, -16] },
    { gunId: 'neutron-gun', offset: [0, -10, 8] },
  ],
  missiles: [],
  flares: 0,
  visual: { kind: 'warship', hull: 0x443d2e, accent: 0x3a2d20, engine: 0xff9944 },
  threat: 8,
});

/**
 * 脱出ポッド。撃墜された乗員が乗っている。
 * 戦闘力は無く、接近して救助信号を受け取ることで回収したことにする。
 */
export const ESCAPE_POD = F({
  id: 'escape-pod',
  name: '脱出ポッド',
  role: 'transport',
  radius: 8,
  size: 8,
  maxSpeed: 12,
  abSpeed: 12,
  accel: 4,
  turn: [0.05, 0.05, 0.08],
  agility: 0.6,
  handling: { drift: 0.9, turnSpeedPenalty: 0.2 },
  hull: 30,
  armor: { front: 6, rear: 6, left: 6, right: 6 },
  shield: { front: 0, rear: 0, regen: 0 },
  energy: 10,
  energyRegen: 2,
  fuel: 0,
  guns: [],
  missiles: [],
  flares: 0,
  visual: { kind: 'brick', hull: 0xb7bcc4, accent: 0xd8a03a, engine: 0x88bbff },
  threat: 0,
});

/** 難民船。守るべき非戦闘目標。輸送艦より脆い */
export const REFUGEE_LINER = F({
  id: 'refugee-liner',
  name: '難民船',
  role: 'transport',
  radius: 46,
  size: 46,
  maxSpeed: 70,
  abSpeed: 70,
  accel: 20,
  turn: [0.12, 0.12, 0.16],
  agility: 1.2,
  handling: { drift: 0.85, turnSpeedPenalty: 0.6 },
  hull: 380,
  armor: { front: 50, rear: 50, left: 50, right: 50 },
  shield: { front: 80, rear: 80, regen: 3 },
  energy: 80,
  energyRegen: 8,
  fuel: 0,
  guns: [],
  missiles: [],
  flares: 0,
  visual: { kind: 'hauler', hull: 0x9aa2ab, accent: 0x3f6b8a, engine: 0x99ccff },
  threat: 1,
});

export const SHIPS: Record<string, ShipDef> = {
  hornet: HORNET,
  scimitar: SCIMITAR,
  raptor: RAPTOR,
  rapier: RAPIER,
  drayman: DRAYMAN,
  'tigers-claw': TIGERS_CLAW,
  salthi: SALTHI,
  dralthi: DRALTHI,
  krant: KRANT,
  gratha: GRATHA,
  jalthi: JALTHI,
  dorkir: DORKIR,
  ralatha: RALATHA,
  'escape-pod': ESCAPE_POD,
  'refugee-liner': REFUGEE_LINER,
};

export function shipDef(id: string): ShipDef {
  const s = SHIPS[id];
  if (!s) throw new Error(`unknown ship: ${id}`);
  return s;
}

/** プレイヤーが選べる機体 */
export const PLAYABLE_SHIPS = ['hornet', 'scimitar', 'raptor', 'rapier'] as const;
