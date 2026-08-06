/** 武装のデータ定義。ここを増やせば武装が増える。 */

export type GunFireMode = 'beam' | 'slug' | 'plasma' | 'particle';
export type GunMuzzleShape = 'needle' | 'heavy' | 'ring' | 'scatter';
export type WeaponAudioProfile = 'laser' | 'mass' | 'neutron' | 'particle';

export interface GunPresentation {
  fireMode: GunFireMode;
  muzzleShape: GunMuzzleShape;
  audioProfile: WeaponAudioProfile;
  /** 砲口閃光の最大輝度。加算合成で照準を白飛びさせない。 */
  maxBrightness: number;
  /** 発射時の機体後退量 (world units)。 */
  recoil: number;
  /** シールドに対する実効倍率。装甲/ハルへの基礎ダメージは変えない。 */
  shieldMultiplier: number;
  /** HUD に表示する短い用途説明。 */
  description: string;
  rangeLabel: '近距離' | '中距離' | '遠距離';
}

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
  presentation: GunPresentation;
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
    presentation: {
      fireMode: 'beam',
      muzzleShape: 'needle',
      audioProfile: 'laser',
      maxBrightness: 0.72,
      recoil: 0.035,
      shieldMultiplier: 0.9,
      description: '高速・低消費。近距離の連続射撃向け',
      rangeLabel: '近距離',
    },
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
    presentation: {
      fireMode: 'slug',
      muzzleShape: 'heavy',
      audioProfile: 'mass',
      maxBrightness: 0.62,
      recoil: 0.16,
      shieldMultiplier: 1,
      description: '重弾と強い反動。装甲目標を一発ずつ削る',
      rangeLabel: '中距離',
    },
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
    presentation: {
      fireMode: 'plasma',
      muzzleShape: 'ring',
      audioProfile: 'neutron',
      maxBrightness: 0.58,
      recoil: 0.11,
      shieldMultiplier: 1.45,
      description: '遅く太い弾。シールドを優先して崩す',
      rangeLabel: '中距離',
    },
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
    presentation: {
      fireMode: 'particle',
      muzzleShape: 'scatter',
      audioProfile: 'particle',
      maxBrightness: 0.66,
      recoil: 0.055,
      shieldMultiplier: 1.05,
      description: '高速連射と粒子の散開。回避中の追撃に強い',
      rangeLabel: '遠距離',
    },
  },
};

export type SeekerKind = 'none' | 'heat' | 'aspect';
export type MissileTrailKind = 'smoke' | 'ion' | 'spark' | 'heavy-smoke';
export type MissileDetonationKind = 'small-warhead' | 'heat-burst' | 'aspect-burst' | 'torpedo';
export type MissileTargetRole = 'any' | 'fighter' | 'capital';

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
  /** 発射後に誘導/近接信管が有効になるまでの秒数 */
  armTime: number;
  trail: MissileTrailKind;
  detonation: MissileDetonationKind;
  targetRole: MissileTargetRole;
  /** HUD とロック警告で使う短い用途説明 */
  description: string;
  audioProfile: 'dumbfire' | 'heat' | 'aspect' | 'torpedo';
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
    armTime: 0.22,
    trail: 'smoke',
    detonation: 'small-warhead',
    targetRole: 'any',
    description: '即時発射・無誘導。読み合いで近距離を取る',
    audioProfile: 'dumbfire',
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
    armTime: 0.3,
    trail: 'ion',
    detonation: 'heat-burst',
    targetRole: 'fighter',
    description: '熱源を追尾。フレアに弱いが短いロックで撃てる',
    audioProfile: 'heat',
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
    armTime: 0.4,
    trail: 'spark',
    detonation: 'aspect-burst',
    targetRole: 'any',
    description: '長めのロックと強い誘導。フレア耐性が高い',
    audioProfile: 'aspect',
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
    armTime: 0.8,
    trail: 'heavy-smoke',
    detonation: 'torpedo',
    targetRole: 'capital',
    description: '大型目標用。長いロックと低速を補う大爆発',
    audioProfile: 'torpedo',
  },
};

export function gunDef(id: string): GunDef {
  const g = GUNS[id];
  if (!g) throw new Error(`unknown gun: ${id}`);
  return g;
}

/** 古いセーブ/外部定義を受ける描画・音声側の安全な入口。 */
export function gunPresentation(gun: GunDef): GunPresentation {
  return gun.presentation ?? {
    fireMode: 'beam',
    muzzleShape: 'needle',
    audioProfile: 'laser',
    maxBrightness: 0.7,
    recoil: 0,
    shieldMultiplier: 1,
    description: '標準主砲',
    rangeLabel: '中距離',
  };
}

export function missileDef(id: string): MissileDef {
  const m = MISSILES[id];
  if (!m) throw new Error(`unknown missile: ${id}`);
  return m;
}

/** 未設定の拡張項目を持つ既存定義でも安全に扱う。 */
export function missilePresentation(missile: MissileDef): Pick<
  MissileDef,
  'armTime' | 'trail' | 'detonation' | 'targetRole' | 'description' | 'audioProfile'
> {
  return {
    armTime: missile.armTime ?? 0.25,
    trail: missile.trail ?? 'smoke',
    detonation: missile.detonation ?? 'small-warhead',
    targetRole: missile.targetRole ?? 'any',
    description: missile.description ?? '副兵装',
    audioProfile: missile.audioProfile ?? 'dumbfire',
  };
}
