import type { ShipDefinition } from "./ShipDefinition";

/**
 * 初期の機体データ。
 * 座標系: +z が前方(機首)、+y が上、+x が右。速度は「ゲーム単位/秒」。
 */
export const SHIP_DEFS: Record<string, ShipDefinition> = {
  // プレイヤー機: バランス型インターセプター。
  rapier: {
    id: "rapier",
    displayName: "Rapier II",
    mass: 14,
    inertia: [10, 12, 8],
    radius: 10,
    hardpoints: [
      [-4, -0.5, 6],
      [4, -0.5, 6],
    ],
    flight: {
      maxLinearSpeed: 220,
      afterburnerMaxSpeed: 460,
      linearThrust: [180, 180, 420],
      angularThrust: [26, 22, 34],
      linearDamping: 0.9,
      angularDamping: 3.2,
    },
    health: {
      shieldMax: 100,
      shieldRegenRate: 12,
      shieldRegenDelay: 4,
      armorMax: 60,
      hullMax: 80,
    },
    weapon: {
      gunFireInterval: 0.12,
      gunDamage: 10,
      gunProjectileSpeed: 1400,
      gunRange: 1800,
      energyMax: 100,
      energyRegen: 26,
      energyPerShot: 6,
      missiles: 6,
      missileFireInterval: 1.2,
    },
    visual: {
      kind: "primitive",
      primitive: {
        bodyColor: 0x8fa9c8,
        accentColor: 0x3fd0ff,
        scale: [9, 3, 14],
        shape: "interceptor",
        engineGlow: 0x66ccff,
      },
    },
  },

  // プレイヤー機: 重戦闘機。Rapier II より低速だが硬く火力も高い。
  scimitar: {
    id: "scimitar",
    displayName: "Scimitar",
    mass: 18,
    inertia: [14, 16, 11],
    radius: 12,
    hardpoints: [
      [-5, -1, 7],
      [5, -1, 7],
    ],
    flight: {
      maxLinearSpeed: 180,
      afterburnerMaxSpeed: 380,
      linearThrust: [140, 140, 360],
      angularThrust: [20, 17, 26],
      linearDamping: 0.9,
      angularDamping: 2.8,
    },
    health: {
      shieldMax: 140,
      shieldRegenRate: 10,
      shieldRegenDelay: 4,
      armorMax: 100,
      hullMax: 120,
    },
    weapon: {
      gunFireInterval: 0.14,
      gunDamage: 12,
      gunProjectileSpeed: 1350,
      gunRange: 1900,
      energyMax: 120,
      energyRegen: 22,
      energyPerShot: 7,
      missiles: 8,
      missileFireInterval: 1.0,
    },
    visual: {
      kind: "primitive",
      primitive: {
        bodyColor: 0x6a7f8a,
        accentColor: 0x44ddff,
        scale: [11, 4, 16],
        shape: "heavy",
        engineGlow: 0x44ccff,
      },
    },
  },

  // 敵機: 軽量で機敏な Kilrathi 系戦闘機。
  dralthi: {
    id: "dralthi",
    displayName: "Dralthi",
    mass: 11,
    inertia: [8, 9, 7],
    radius: 10,
    hardpoints: [
      [-5, 0, 4],
      [5, 0, 4],
    ],
    flight: {
      maxLinearSpeed: 210,
      afterburnerMaxSpeed: 420,
      linearThrust: [150, 150, 360],
      angularThrust: [24, 20, 30],
      linearDamping: 0.9,
      angularDamping: 3.0,
    },
    health: {
      shieldMax: 70,
      shieldRegenRate: 8,
      shieldRegenDelay: 5,
      armorMax: 40,
      hullMax: 55,
    },
    weapon: {
      gunFireInterval: 0.16,
      gunDamage: 8,
      gunProjectileSpeed: 1300,
      gunRange: 1500,
      energyMax: 80,
      energyRegen: 18,
      energyPerShot: 6,
      missiles: 2,
      missileFireInterval: 2.5,
    },
    visual: {
      kind: "primitive",
      primitive: {
        bodyColor: 0xb05a3a,
        accentColor: 0xffb020,
        scale: [13, 3, 10],
        shape: "wedge",
        engineGlow: 0xff7020,
      },
    },
  },

  // 味方輸送艦: 大きく鈍重で護衛対象。低機動・高耐久。
  transport: {
    id: "transport",
    displayName: "Drayman 輸送艦",
    mass: 200,
    inertia: [400, 400, 300],
    radius: 22,
    hardpoints: [[0, -4, 20]],
    flight: {
      maxLinearSpeed: 60,
      afterburnerMaxSpeed: 90,
      linearThrust: [200, 200, 600],
      angularThrust: [40, 40, 50],
      linearDamping: 0.9,
      angularDamping: 2.0,
    },
    health: {
      shieldMax: 200,
      shieldRegenRate: 6,
      shieldRegenDelay: 6,
      armorMax: 200,
      hullMax: 300,
    },
    weapon: {
      gunFireInterval: 0.5,
      gunDamage: 6,
      gunProjectileSpeed: 1000,
      gunRange: 1200,
      energyMax: 60,
      energyRegen: 10,
      energyPerShot: 6,
      missiles: 0,
      missileFireInterval: 5,
    },
    visual: {
      kind: "primitive",
      primitive: {
        bodyColor: 0x8a8f9a,
        accentColor: 0x66ccff,
        scale: [16, 12, 48],
        shape: "heavy",
        engineGlow: 0x66ccff,
      },
    },
  },

  // 敵重戦闘機: 硬いが鈍い。
  gratha: {
    id: "gratha",
    displayName: "Gratha",
    mass: 20,
    inertia: [16, 18, 14],
    radius: 13,
    hardpoints: [
      [-6, -1, 5],
      [6, -1, 5],
    ],
    flight: {
      maxLinearSpeed: 180,
      afterburnerMaxSpeed: 340,
      linearThrust: [140, 140, 320],
      angularThrust: [18, 15, 22],
      linearDamping: 0.9,
      angularDamping: 2.6,
    },
    health: {
      shieldMax: 110,
      shieldRegenRate: 10,
      shieldRegenDelay: 5,
      armorMax: 80,
      hullMax: 120,
    },
    weapon: {
      gunFireInterval: 0.2,
      gunDamage: 14,
      gunProjectileSpeed: 1250,
      gunRange: 1700,
      energyMax: 100,
      energyRegen: 16,
      energyPerShot: 9,
      missiles: 4,
      missileFireInterval: 2.0,
    },
    visual: {
      kind: "primitive",
      primitive: {
        bodyColor: 0x6a5a48,
        accentColor: 0xff5030,
        scale: [12, 5, 13],
        shape: "heavy",
        engineGlow: 0xff5020,
      },
    },
  },
};
