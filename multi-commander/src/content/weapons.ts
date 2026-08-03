/** 武装のデータ定義。ここを増やせば武装が増える。 */

export interface GunDef {
  id: string;
  name: string;
  /** 1発のダメージ */
  damage: number;
  /** 弾速 (units/s) */
  speed: number;
  /** 1発あたりのエネルギー消費 */
  energyCost: number;
  /** 連射間隔 (秒) */
  refire: number;
  /** 弾の寿命 (秒) → 実効射程 = speed * life */
  life: number;
  color: number;
  /** トレーサーの長さ倍率 */
  tracer: number;
}

export const GUNS: Record<string, GunDef> = {
  laser: {
    id: 'laser',
    name: 'レーザー砲',
    damage: 5,
    speed: 1600,
    energyCost: 3,
    refire: 0.2,
    life: 2.4,
    color: 0xff4d4d,
    tracer: 1,
  },
  'mass-driver': {
    id: 'mass-driver',
    name: 'マスドライバー',
    damage: 9,
    speed: 1250,
    energyCost: 5,
    refire: 0.32,
    life: 2.6,
    color: 0xffd166,
    tracer: 0.8,
  },
  'neutron-gun': {
    id: 'neutron-gun',
    name: 'ニュートロンガン',
    damage: 14,
    speed: 1050,
    energyCost: 9,
    refire: 0.5,
    life: 2.6,
    color: 0x7bf1ff,
    tracer: 1.2,
  },
  'particle-cannon': {
    id: 'particle-cannon',
    name: 'パーティクルキャノン',
    damage: 7,
    speed: 1900,
    energyCost: 4,
    refire: 0.22,
    life: 2.2,
    color: 0xc78bff,
    tracer: 1.4,
  },
};

export type SeekerKind = 'none' | 'heat' | 'aspect';

export interface MissileDef {
  id: string;
  name: string;
  shortName: string;
  damage: number;
  /** 起爆半径 */
  blastRadius: number;
  speed: number;
  /** 最大旋回率 (rad/s) */
  turnRate: number;
  life: number;
  seeker: SeekerKind;
  /** ロックに必要な秒数 (none は 0) */
  lockTime: number;
  /** フレアに騙される確率の係数 */
  flareSusceptibility: number;
  color: number;
}

export const MISSILES: Record<string, MissileDef> = {
  dumbfire: {
    id: 'dumbfire',
    name: 'ダムファイア',
    shortName: 'DF',
    damage: 90,
    blastRadius: 30,
    speed: 700,
    turnRate: 0,
    life: 6,
    seeker: 'none',
    lockTime: 0,
    flareSusceptibility: 0,
    color: 0xffffff,
  },
  'heat-seeker': {
    id: 'heat-seeker',
    name: 'ヒートシーカー',
    shortName: 'HS',
    damage: 70,
    blastRadius: 26,
    speed: 620,
    turnRate: 1.5,
    life: 9,
    seeker: 'heat',
    lockTime: 1.1,
    flareSusceptibility: 1,
    color: 0xff9955,
  },
  'image-rec': {
    id: 'image-rec',
    name: 'イメージレコグニション',
    shortName: 'IR',
    damage: 75,
    blastRadius: 26,
    speed: 600,
    turnRate: 1.9,
    life: 11,
    seeker: 'aspect',
    lockTime: 2.2,
    flareSusceptibility: 0.15,
    color: 0x99ddff,
  },
  torpedo: {
    id: 'torpedo',
    name: '対艦魚雷',
    shortName: 'TP',
    damage: 1200,
    blastRadius: 70,
    speed: 380,
    turnRate: 0.7,
    life: 20,
    seeker: 'aspect',
    lockTime: 5,
    flareSusceptibility: 0,
    color: 0xffee88,
  },
};

export function gunDef(id: string): GunDef {
  const g = GUNS[id];
  if (!g) throw new Error(`unknown gun: ${id}`);
  return g;
}

export function missileDef(id: string): MissileDef {
  const m = MISSILES[id];
  if (!m) throw new Error(`unknown missile: ${id}`);
  return m;
}
