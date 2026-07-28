export type WeaponClass = "gun" | "missile";
export type SeekerKind = "none" | "heat" | "aspect";
export type ProjectileVisual = "tracer" | "bolt" | "plasma" | "missile";

export interface WeaponDef {
  id: string;
  displayName: string;
  cls: WeaponClass;
  damage: number;
  projectileSpeed: number;
  range: number;
  fireInterval: number;
  energyPerShot?: number;
  ammoMax?: number;
  seeker?: SeekerKind;
  turnRate?: number;
  lockRequired?: boolean;
  projectileVisual: ProjectileVisual;
  color?: number;
}

export const WEAPON_DEFS: Record<string, WeaponDef> = {
  "laser": {
    id: "laser",
    displayName: "Laser Cannon",
    cls: "gun",
    damage: 10,
    projectileSpeed: 1400,
    range: 1800,
    fireInterval: 0.12,
    energyPerShot: 6,
    projectileVisual: "tracer",
    color: 0x66ffcc,
  },
  "mass-driver": {
    id: "mass-driver",
    displayName: "Mass Driver",
    cls: "gun",
    damage: 16,
    projectileSpeed: 1600,
    range: 2200,
    fireInterval: 0.22,
    energyPerShot: 10,
    projectileVisual: "bolt",
    color: 0xffdd44,
  },
  "neutron-gun": {
    id: "neutron-gun",
    displayName: "Neutron Gun",
    cls: "gun",
    damage: 22,
    projectileSpeed: 1100,
    range: 1400,
    fireInterval: 0.30,
    energyPerShot: 14,
    projectileVisual: "plasma",
    color: 0x33ff66,
  },
  "particle-cannon": {
    id: "particle-cannon",
    displayName: "Particle Cannon",
    cls: "gun",
    damage: 18,
    projectileSpeed: 1800,
    range: 2400,
    fireInterval: 0.25,
    energyPerShot: 12,
    projectileVisual: "bolt",
    color: 0xaa66ff,
  },
  "kilrathi-laser": {
    id: "kilrathi-laser",
    displayName: "Kilrathi Laser",
    cls: "gun",
    damage: 8,
    projectileSpeed: 1300,
    range: 1500,
    fireInterval: 0.16,
    energyPerShot: 6,
    projectileVisual: "tracer",
    color: 0xff5533,
  },
  "kilrathi-heavy": {
    id: "kilrathi-heavy",
    displayName: "Kilrathi Heavy Laser",
    cls: "gun",
    damage: 14,
    projectileSpeed: 1250,
    range: 1700,
    fireInterval: 0.20,
    energyPerShot: 9,
    projectileVisual: "bolt",
    color: 0xff3300,
  },
  "dumbfire": {
    id: "dumbfire",
    displayName: "Dumb-Fire",
    cls: "missile",
    damage: 30,
    projectileSpeed: 450,
    range: 2000,
    fireInterval: 0.8,
    ammoMax: 4,
    seeker: "none",
    turnRate: 0,
    lockRequired: false,
    projectileVisual: "missile",
  },
  "heat-seeker": {
    id: "heat-seeker",
    displayName: "Heat Seeker",
    cls: "missile",
    damage: 35,
    projectileSpeed: 320,
    range: 3000,
    fireInterval: 1.2,
    ammoMax: 6,
    seeker: "heat",
    turnRate: 2.2,
    lockRequired: true,
    projectileVisual: "missile",
  },
  "image-rec": {
    id: "image-rec",
    displayName: "Image Rec.",
    cls: "missile",
    damage: 45,
    projectileSpeed: 280,
    range: 4000,
    fireInterval: 1.8,
    ammoMax: 4,
    seeker: "aspect",
    turnRate: 1.8,
    lockRequired: true,
    projectileVisual: "missile",
  },
  "friend-or-foe": {
    id: "friend-or-foe",
    displayName: "Friend-or-Foe",
    cls: "missile",
    damage: 28,
    projectileSpeed: 380,
    range: 2500,
    fireInterval: 1.0,
    ammoMax: 8,
    seeker: "heat",
    turnRate: 2.8,
    lockRequired: false,
    projectileVisual: "missile",
  },
};

export function getWeaponDef(id: string): WeaponDef {
  const def = WEAPON_DEFS[id];
  if (!def) throw new Error(`Unknown weapon: ${id}`);
  return def;
}
