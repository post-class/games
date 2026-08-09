/** 機体・艦艇のデータ定義。 */

/**
 * 陣営id。五勢力（世界観_歴史仕様 §03）＋ 民間・救難などの `neutral`。
 *
 * キルラシーは既存実装どおり `kilrathi`（th）を id として維持する。
 * 資料表記 `kilrashi`（sh）との差異は `veil/world.ts` の `FACTION_ID_MAP` で吸収する。
 * 敵対関係は `content/factions.ts` の関係テーブルで定義する。
 */
export type Faction = 'confed' | 'kilrathi' | 'serecion' | 'ordo' | 'neurowm' | 'neutral';

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
  /**
   * 陣営ごとの造形の癖。
   * kilrathi は爪・牙・肋のモチーフを足し、赤い単眼を付ける。
   * 骨格が同じでも「誓約と血統を掲げる帝国（獣人）の機体」と
   * 分かるようにするための指定。
   */
  style?: 'kilrathi';
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
  /**
   * この機体を配備している勢力（機体名鑑の所属）。
   *
   * 実際の敵味方は出撃・ウェーブ定義側の `faction` で決まるため、この値は
   * 機体データの所属を示すメタ情報として扱う（同じ機体を別勢力が運用する
   * 場面を作れるようにしておく）。名鑑との照合とテストの拠り所にする。
   */
  faction: Faction;
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
  faction: 'confed',
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

// ───────── Kilrathi Empire（キルラシー帝国 / 誓約と血統の軍事帝国・獣人） ─────────
//
// 機体名鑑（機体_機体名鑑.html）の KF01〜KF06 へ差し替えた（P0-4 の決定 = 差し替え）。
// 性能値は既存のバランス検証済みの数値をそのまま引き継ぎ、id と表示名だけを
// 新名鑑へ合わせている。役割（追撃／電子戦／指揮迎撃／重装ガンシップ／急降下／雷撃）
// が既存機の手触りと一致する組み合わせを選んだ。
//
// 旧id（salthi / dralthi / krant / gratha / jalthi / dorkir / ralatha）は
// `SHIP_ID_ALIASES` で新idへ解決されるため、旧セーブと既存ミッションは壊れない。

/** KE04 ミラージュ（電子戦機・軽量／静粛巡航）。旧 `salthi`。 */
export const MIRAGE = F({
  id: 'ke04-mirage',
  name: 'KE04 ミラージュ',
  faction: 'kilrathi',
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
  visual: { kind: 'arrow', style: 'kilrathi', hull: 0x665738, accent: 0xb04a2a, engine: 0xff8844 },
  threat: 1,
});

/** KF03 グレイハウル（追撃戦闘機・最高速／高旋回）。旧 `dralthi`。第5章の決闘機。 */
export const GREYHAUL = F({
  id: 'kf03-greyhaul',
  name: 'KF03 グレイハウル',
  faction: 'kilrathi',
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
  visual: { kind: 'bat', style: 'kilrathi', hull: 0x5a4c31, accent: 0xa8412c, engine: 0xff9955 },
  threat: 1,
});

/** KF01 レオンファング（指揮迎撃機・正面加速特化）。旧 `krant`。 */
export const LEONFANG = F({
  id: 'kf01-leonfang',
  name: 'KF01 レオンファング',
  faction: 'kilrathi',
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
  visual: { kind: 'twin-boom', style: 'kilrathi', hull: 0x4f442f, accent: 0x9c3b26, engine: 0xffa060 },
  threat: 2,
});

/** KB02 バスティオン（重装ガンシップ・低速／高推力）。旧 `gratha`。 */
export const BASTION = F({
  id: 'kb02-bastion',
  name: 'KB02 バスティオン',
  faction: 'kilrathi',
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
  visual: { kind: 'brick', style: 'kilrathi', hull: 0x4c412d, accent: 0x8f3520, engine: 0xff7744 },
  threat: 3,
});

/** KF06 タロン（急降下攻撃機・超高速）。旧 `jalthi`。 */
export const TALON = F({
  id: 'kf06-talon',
  name: 'KF06 タロン',
  faction: 'kilrathi',
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
  visual: { kind: 'delta', style: 'kilrathi', hull: 0x4e422b, accent: 0xa03a1f, engine: 0xff8040 },
  threat: 4,
});

/**
 * KB05 ボアブレイカー（雷撃爆撃機・対艦）。旧 `dorkir`。
 * 名鑑では 2名乗りの雷撃機だが、既存実装では封鎖線側の大型機として使われている。
 * 性能値は旧 `dorkir` を維持し、`role` も `transport`（大型・低速）のままにしている。
 */
export const BOARBREAKER = F({
  id: 'kb05-boarbreaker',
  name: 'KB05 ボアブレイカー',
  faction: 'kilrathi',
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
  visual: { kind: 'hauler', style: 'kilrathi', hull: 0x5a4f36, accent: 0x59402c, engine: 0xffaa55 },
  threat: 3,
});

/**
 * 帝国駆逐艦。旧 `ralatha`。
 *
 * 機体名鑑の帝国6機（KF01〜KF06）は戦闘機・ガンシップ級のみで、
 * 駆逐艦に対応する機体が存在しない。名鑑に無い機体へ勝手に KF 番号を
 * 与えると正典と矛盾するため、ここだけは汎用名 `kilrashi-destroyer` /
 * 「帝国駆逐艦」とした。名鑑側に艦艇が追加された時点で差し替える。
 */
export const KILRASHI_DESTROYER = F({
  id: 'kilrashi-destroyer',
  name: '帝国駆逐艦',
  faction: 'kilrathi',
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
  visual: { kind: 'warship', style: 'kilrathi', hull: 0x443d2e, accent: 0x3a2d20, engine: 0xff9944 },
  threat: 8,
});

// ───────── 非人類三勢力（章に登場する機体のみ） ─────────
//
// 追加範囲は P0-2（A案）の決定どおり、十章に実際に登場する機体に限る。
// 名鑑（機体_機体名鑑.html）の記述は定性的なので、次の規則で数値へ落とした。
// 表示（HUD・格納庫・ブリーフィング）と実挙動は同じ ShipDef から生成されるため、
// ここが唯一の出所になる。
//
// 【速度】名鑑の機動欄の語 → 既存機のレンジへ写像する。
//   超高速/最高速 = 420〜450（ラピアー450・サルシー相当420）
//   高速 = 400〜440、中速 = 90〜160（艦艇）／300〜340（戦闘機）
//   低速 = 60〜90（ドレイマン90・タイガーズ・クロー60）
// 【装甲・船体】名鑑の材質欄 → 軽量/薄装甲 = 戦闘機の下限（船体60〜80）、
//   可撓/軽量外皮 = 中位（140前後）、高密度/積層/セラミック = 上限側。
//   艦艇はドレイマン620・ラーラサ2000・タイガーズ・クロー6000 を上下限の目安にする。
// 【シールド】名鑑の「スピードバリア」の持続秒数を **再生速度** に写像する。
//   秒数が長い機体（護衛・救難）ほど盾が立ち直り、短い機体（偵察・追撃）は薄い。
//   目安: 1.0〜1.5秒 → regen 4.5〜5 / 3〜5秒 → regen 6〜8 / 9〜10.5秒 → regen 12〜14。
// 【兵装】名鑑の兵装名 → 既存 12 種のうち性格が最も近いものを割り当てる
//   （非人類兵装12種のゲーム実装は今回の非対象。名鑑にも「未接続」と明記）。
//   収束/分光/精密 = particle-cannon、パルス砲列 = pulse-cannon、
//   低出力・非殺傷 = laser、重い単発（重力アンカー杭）= ion-lance。

/**
 * SC03 アーク（セレシオン・護衛空母）。第3章・第10章。
 * 名鑑: 調律パルス砲 / 修復ナノミスト・迎撃艇12機 / 有機セラミック船殻 /
 * 低速・長距離漂泊 / 9.0秒・船団共鳴壁 / 18個体。
 * 数値化: 護衛空母なのでタイガーズ・クロー(6000)とラーラサ(2000)の間、船体2600。
 * バリア9.0秒＝長い → シールド再生12（人類艦の10より上）。武装は砲列ではなく
 * 「調律」の1組だけにして、攻撃艦ではないことを数値で示す。
 */
export const ARC = F({
  id: 'sc03-arc',
  name: 'SC03 アーク',
  faction: 'serecion',
  role: 'capital',
  radius: 110,
  size: 110,
  maxSpeed: 70,
  abSpeed: 70,
  accel: 14,
  turn: [0.06, 0.06, 0.07],
  agility: 1,
  handling: { drift: 0.9, turnSpeedPenalty: 0.7 },
  hull: 2600,
  armor: { front: 400, rear: 400, left: 400, right: 400 },
  shield: { front: 520, rear: 520, regen: 12 },
  energy: 320,
  energyRegen: 34,
  fuel: 0,
  guns: [
    { gunId: 'pulse-cannon', offset: [-16, 6, -44] },
    { gunId: 'pulse-cannon', offset: [16, 6, -44] },
  ],
  missiles: [],
  flares: 0,
  visual: { kind: 'warship', hull: 0x6f8d84, accent: 0x2f7d63, engine: 0x7fe3b0 },
  threat: 8,
});

/**
 * SH06 ハルシオン（セレシオン・避難輸送護衛艦）。第3章。
 * 名鑑: 低出力防護砲 / 妨害フレア群・救難ポッド / 多孔質緩衝船殻 /
 * 中速・横移動防護 / 10.5秒・琥珀防護膜 / 14個体。
 * 数値化: 「最初の被弾を引き受ける」船なのでドレイマン(620)より硬い船体700。
 * バリア10.5秒＝名鑑の最長 → シールド再生14（全機体で最大）。
 * 「妨害フレア群」は搭載フレア14（守る側の装備として最多）。
 */
export const HALCYON = F({
  id: 'sh06-halcyon',
  name: 'SH06 ハルシオン',
  faction: 'serecion',
  role: 'transport',
  radius: 50,
  size: 50,
  maxSpeed: 110,
  abSpeed: 110,
  accel: 34,
  turn: [0.18, 0.18, 0.22],
  agility: 1.8,
  handling: { drift: 0.75, turnSpeedPenalty: 0.55 },
  hull: 700,
  armor: { front: 100, rear: 100, left: 100, right: 100 },
  shield: { front: 190, rear: 190, regen: 14 },
  energy: 120,
  energyRegen: 14,
  fuel: 0,
  guns: [
    { gunId: 'laser', offset: [-6, 5, -18] },
    { gunId: 'laser', offset: [6, 5, -18] },
  ],
  missiles: [],
  flares: 14,
  visual: { kind: 'hauler', hull: 0x93b3a6, accent: 0xd8b25a, engine: 0x9ff0c6 },
  threat: 3,
});

/**
 * SM04 ミストステップ（セレシオン・霧相偵察機）。第3章。
 * 名鑑: 静電パルス針 / 索敵霧散布 / 薄膜結晶外皮 / 高速・不規則機動 /
 * 1.0秒・霧化回避幕 / 1個体。
 * 数値化: 薄膜外皮＝戦闘機の下限側（船体75・装甲16。サルシー相当70/18の隣）。
 * バリア1.0秒＝名鑑の最短 → シールド再生4.5（盾に頼らず避ける機体）。
 * 「不規則機動」は agility 9.5 と drift 0.08 で表す。武装は針＝軽い1門のみ。
 */
export const MISTSTEP = F({
  id: 'sm04-miststep',
  name: 'SM04 ミストステップ',
  faction: 'serecion',
  radius: 9,
  size: 9,
  maxSpeed: 430,
  abSpeed: 820,
  accel: 340,
  turn: [2.0, 1.85, 3.5],
  agility: 9.5,
  handling: { drift: 0.08, turnSpeedPenalty: 0.08 },
  hull: 75,
  armor: { front: 16, rear: 16, left: 16, right: 16 },
  shield: { front: 34, rear: 34, regen: 4.5 },
  energy: 95,
  energyRegen: 68,
  fuel: 6,
  guns: [{ gunId: 'particle-cannon', offset: [0, -0.3, -5] }],
  missiles: [],
  flares: 8,
  visual: { kind: 'arrow', hull: 0x8fb6ab, accent: 0x39a37c, engine: 0x8ff0c0 },
  threat: 1,
});

/**
 * OE06 アイアンルート（オルド・重力輸送タグ）。第4章・第10章。
 * 名鑑: 重力アンカー杭 / 作業用パルスカッター / 高密度鉱物船殻 /
 * 低速・超高トルク牽引 / 5.0秒・局所重力盾 / 1核。
 * 数値化: 「高密度鉱物船殻」＝輸送級で最も硬い → 船体820・装甲150
 * （ドレイマン620/110の上）。低速だが超高トルク牽引なので、最高速は低く
 * （70）加速も低い一方、agility 2.2 と turnSpeedPenalty 0.45 で
 * 「重いのに向きは変えられる」牽引機の癖を出す。
 * バリア5.0秒 → シールド再生7。
 * 主兵装の重力アンカー杭は、既存兵装で最も重く遅い ion-lance に割り当てた。
 */
export const IRONROOT = F({
  id: 'oe06-ironroot',
  name: 'OE06 アイアンルート',
  faction: 'ordo',
  role: 'transport',
  radius: 48,
  size: 48,
  maxSpeed: 70,
  abSpeed: 70,
  accel: 26,
  turn: [0.2, 0.2, 0.24],
  agility: 2.2,
  handling: { drift: 0.7, turnSpeedPenalty: 0.45 },
  hull: 820,
  armor: { front: 150, rear: 150, left: 150, right: 150 },
  shield: { front: 130, rear: 130, regen: 7 },
  energy: 160,
  energyRegen: 18,
  fuel: 0,
  guns: [
    { gunId: 'ion-lance', offset: [0, 4, -20] },
    { gunId: 'pulse-cannon', offset: [0, -4, -16] },
  ],
  missiles: [],
  flares: 4,
  visual: { kind: 'hauler', hull: 0x8a7a52, accent: 0xd9b977, engine: 0xffcc77 },
  threat: 4,
});

/**
 * OF02 スパー（オルド・水棲迎撃機）。第4章。
 * 名鑑: 水圧収束砲 / 流体デコイ / 真珠質可撓装甲 / 高速・流体旋回 /
 * 1.7秒・潮流偏向幕 / 1核。
 * 数値化: 可撓装甲＝中位（船体140・装甲34。グレイハウル130/32 の隣）。
 * バリア1.7秒 → シールド再生6。「流体旋回」は drift 0.06（機首なりに素直）と
 * turn の高さで表す。「水圧収束砲」は収束＝高初速の particle-cannon×2。
 * 「流体デコイ」はフレア8。
 */
export const SPAR = F({
  id: 'of02-spar',
  name: 'OF02 スパー',
  faction: 'ordo',
  radius: 12,
  size: 12,
  maxSpeed: 410,
  abSpeed: 780,
  accel: 320,
  turn: [1.9, 1.75, 3.3],
  agility: 8.5,
  handling: { drift: 0.06, turnSpeedPenalty: 0.1 },
  hull: 140,
  armor: { front: 34, rear: 30, left: 30, right: 30 },
  shield: { front: 50, rear: 50, regen: 6 },
  energy: 130,
  energyRegen: 84,
  fuel: 7,
  guns: [
    { gunId: 'particle-cannon', offset: [-3.2, -0.4, -6] },
    { gunId: 'particle-cannon', offset: [3.2, -0.4, -6] },
  ],
  missiles: [],
  flares: 8,
  visual: { kind: 'delta', hull: 0x9b8f6c, accent: 0xd9b977, engine: 0xffdd99 },
  threat: 2,
});

/**
 * NC01 プロトコル（ニューロウム・統治空母）。第6章・第10章。
 * 名鑑: 高精度パルス砲列 / 指令ドローン群・艦載機24機 / 白磁セラミック・可換装甲 /
 * 中速・全方位姿勢制御 / 4.5秒・多層通信防壁 / 無人。
 * 数値化: 艦載機24機＝タイガーズ・クロー(艦載機運用・6000)に次ぐ規模 → 船体4200。
 * 「可換装甲」は装甲600とシールド再生9（4.5秒バリア相当）で表す。
 * 「中速・全方位姿勢制御」なので母艦としては速く（95）旋回も人類母艦の倍にした。
 * 「高精度パルス砲列」は pulse-cannon×4（砲列＝門数で表す）。
 */
export const PROTOCOL = F({
  id: 'nc01-protocol',
  name: 'NC01 プロトコル',
  faction: 'neurowm',
  role: 'capital',
  radius: 130,
  size: 130,
  maxSpeed: 95,
  abSpeed: 95,
  accel: 20,
  turn: [0.1, 0.1, 0.12],
  agility: 1.4,
  handling: { drift: 0.85, turnSpeedPenalty: 0.6 },
  hull: 4200,
  armor: { front: 600, rear: 600, left: 600, right: 600 },
  shield: { front: 560, rear: 560, regen: 9 },
  energy: 380,
  energyRegen: 42,
  fuel: 0,
  guns: [
    { gunId: 'pulse-cannon', offset: [-24, 10, -52] },
    { gunId: 'pulse-cannon', offset: [24, 10, -52] },
    { gunId: 'pulse-cannon', offset: [-24, -10, 30] },
    { gunId: 'pulse-cannon', offset: [24, -10, 30] },
  ],
  missiles: [],
  flares: 0,
  visual: { kind: 'warship', hull: 0xd6d2e0, accent: 0x8f74c4, engine: 0xc9a6ff },
  threat: 9,
});

/**
 * NN04 スカイ（ニューロウム・通信中継艦）。第6章・第8章。
 * 名鑑: 干渉パルス砲 / 中継マイクロ衛星 / サテン銀合金・可変外皮 /
 * 中速・長時間滞空 / 3.3秒・通信遮断壁 / 無人。
 * 数値化: 中継艦＝戦闘艦ではないのでドレイマン(620)より柔らかい船体560。
 * バリア3.3秒 → シールド再生6。「長時間滞空」は燃料枠を持たない艦なので
 * エネルギー再生を高め（22）に取り、砲を撃ち続けられる形で表した。
 */
export const SKY = F({
  id: 'nn04-sky',
  name: 'NN04 スカイ',
  faction: 'neurowm',
  role: 'transport',
  radius: 44,
  size: 44,
  maxSpeed: 105,
  abSpeed: 105,
  accel: 32,
  turn: [0.18, 0.18, 0.22],
  agility: 1.8,
  handling: { drift: 0.78, turnSpeedPenalty: 0.55 },
  hull: 560,
  armor: { front: 90, rear: 90, left: 90, right: 90 },
  shield: { front: 140, rear: 140, regen: 6 },
  energy: 150,
  energyRegen: 22,
  fuel: 0,
  guns: [
    { gunId: 'pulse-cannon', offset: [-5, 5, -16] },
    { gunId: 'pulse-cannon', offset: [5, 5, -16] },
  ],
  missiles: [],
  flares: 4,
  visual: { kind: 'hauler', hull: 0xc3c0cc, accent: 0x7d63b0, engine: 0xc9a6ff },
  threat: 3,
});

/**
 * NR03 マンディブル（ニューロウム・偵察ドローン戦闘機）。第6章のドローン飽和。
 * 名鑑: 精密カービン砲 / 地形標識プローブ / グラファイト骨格・薄装甲 /
 * 高速・多軸跳躍航行 / 1.1秒・反射低減膜 / 無人。
 * 数値化: 数で押す使い捨てドローンなので全機体で最も脆い（船体60・装甲14）。
 * バリア1.1秒 → シールド再生4.5。無人＝生存を優先しないためフレア0。
 * 「多軸跳躍航行」は turn と agility を最大級に、drift をほぼ0にして表す。
 * 「精密カービン砲」は単装の実体弾 mass-driver×1。
 */
export const MANDIBLE = F({
  id: 'nr03-mandible',
  name: 'NR03 マンディブル',
  faction: 'neurowm',
  radius: 8,
  size: 8,
  maxSpeed: 440,
  abSpeed: 800,
  accel: 350,
  turn: [2.1, 1.95, 3.6],
  agility: 10,
  handling: { drift: 0.04, turnSpeedPenalty: 0.06 },
  hull: 60,
  armor: { front: 14, rear: 14, left: 14, right: 14 },
  shield: { front: 26, rear: 26, regen: 4.5 },
  energy: 85,
  energyRegen: 62,
  fuel: 5,
  guns: [{ gunId: 'mass-driver', offset: [0, -0.2, -4.5] }],
  missiles: [],
  flares: 0,
  visual: { kind: 'bat', hull: 0x9c99a6, accent: 0x6f5aa0, engine: 0xb894ff },
  threat: 1,
});

/**
 * NM02 マーシー（ニューロウム・救護シャトル）。第6章・第8章。
 * 名鑑: 非殺傷ショック砲 / 医療ドローン・救護カプセル / 軽量医療シェル・隔離層 /
 * 中速・精密浮遊 / 5.5秒・救護カプセル壁 / 無人。
 * 数値化: 小型シャトルなので難民船(380)より小さく脱出ポッド(30)より硬い船体220。
 * バリア5.5秒＝救護カプセル壁 → シールド再生8（護衛級に近い）。
 * 「非殺傷ショック砲」は最も弱い laser×1。攻撃目的で出て来ない機体として、
 * 火力よりシールド再生が高いという逆転を数値に残している。
 */
export const MERCY = F({
  id: 'nm02-mercy',
  name: 'NM02 マーシー',
  faction: 'neurowm',
  role: 'transport',
  radius: 20,
  size: 20,
  maxSpeed: 150,
  abSpeed: 150,
  accel: 60,
  turn: [0.4, 0.4, 0.5],
  agility: 3,
  handling: { drift: 0.5, turnSpeedPenalty: 0.35 },
  hull: 220,
  armor: { front: 40, rear: 40, left: 40, right: 40 },
  shield: { front: 110, rear: 110, regen: 8 },
  energy: 100,
  energyRegen: 20,
  fuel: 0,
  guns: [{ gunId: 'laser', offset: [0, -1, -7] }],
  missiles: [],
  flares: 6,
  visual: { kind: 'brick', hull: 0xe2dfe8, accent: 0x7d63b0, engine: 0xc9a6ff },
  threat: 1,
});

/**
 * 脱出ポッド。撃墜された乗員が乗っている。
 * 戦闘力は無く、接近して救助信号を受け取ることで回収したことにする。
 */
export const ESCAPE_POD = F({
  id: 'escape-pod',
  name: '脱出ポッド',
  faction: 'neutral',
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
  faction: 'neutral',
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
  'kf01-leonfang': LEONFANG,
  'kb02-bastion': BASTION,
  'kf03-greyhaul': GREYHAUL,
  'ke04-mirage': MIRAGE,
  'kb05-boarbreaker': BOARBREAKER,
  'kf06-talon': TALON,
  'kilrashi-destroyer': KILRASHI_DESTROYER,
  'sc03-arc': ARC,
  'sh06-halcyon': HALCYON,
  'sm04-miststep': MISTSTEP,
  'oe06-ironroot': IRONROOT,
  'of02-spar': SPAR,
  'nc01-protocol': PROTOCOL,
  'nn04-sky': SKY,
  'nr03-mandible': MANDIBLE,
  'nm02-mercy': MERCY,
  'escape-pod': ESCAPE_POD,
  'refugee-liner': REFUGEE_LINER,
};

/**
 * 旧機体id → 新機体id のエイリアス表（後方互換）。
 *
 * 帝国機を KF01〜KF06 の新名鑑へ差し替えた際、機体idは
 * `missions.ts` / `frontline.ts` / `extraMissions.ts` / `aces.ts` / 各テストなど
 * 多数の箇所から**文字列で**参照されていた。すべてを同時に書き換えると
 * 並行作業とぶつかり、既存セーブ（`shipsFlown` の集計キー、最後の出撃記録など）も
 * 壊れるため、解決だけをここで吸収する。
 *
 * 参照は `shipDef()` を必ず通るので（`src` 内の全呼び出しを確認済み）、
 * 旧idのままでも新しい定義が返る。
 *
 * TODO(追随タスク): 下記の旧id参照を新idへ書き換えたうえで、この表を削除できる。
 *   - `src/content/missions.ts`（既存11ミッションのウェーブ定義）
 *   - `src/content/frontline.ts`（動的作戦の編成テーブル）
 *   - `src/content/extraMissions.ts`（追加ミッション）
 *   - `src/content/aces.ts`（エースの搭乗機）
 *   - `tests/ut/{ai,combat,easy-weapons,missile-aim,mission,obstacles,replay,weapon-expansion,weapon-upgrade}.test.ts`
 *   書き換え後も旧セーブ互換が必要なので、表を消すのはセーブ移行を入れてからにする。
 */
export const SHIP_ID_ALIASES: Readonly<Record<string, string>> = {
  krant: 'kf01-leonfang',
  gratha: 'kb02-bastion',
  dralthi: 'kf03-greyhaul',
  salthi: 'ke04-mirage',
  dorkir: 'kb05-boarbreaker',
  jalthi: 'kf06-talon',
  ralatha: 'kilrashi-destroyer',
};

/** 機体idを正規化する（旧idは新idへ読み替える）。 */
export function resolveShipId(id: string): string {
  return SHIPS[id] ? id : (SHIP_ID_ALIASES[id] ?? id);
}

export function shipDef(id: string): ShipDef {
  const s = SHIPS[resolveShipId(id)];
  if (!s) throw new Error(`unknown ship: ${id}`);
  return s;
}

/** プレイヤーが選べる機体 */
export const PLAYABLE_SHIPS = ['hornet', 'scimitar', 'raptor', 'rapier'] as const;
