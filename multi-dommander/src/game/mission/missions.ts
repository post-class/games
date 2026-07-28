import type { MissionDefinition } from "./MissionDefinition";

/**
 * ミッションデータ。ここを増やすだけで新ミッションを追加できる。
 * 座標系: +z 前方, +y 上, +x 右。
 */
export const MISSIONS: Record<string, MissionDefinition> = {
  // M1: 哨戒 — 全機撃墜。ウェーブ制で増援が来る。
  patrol: {
    id: "patrol",
    name: "哨戒任務 — Gimle 宙域",
    briefing: [
      "Gimle 宙域で Kilrathi の偵察部隊が確認された。",
      "全機撃墜し、宙域の安全を確保せよ。",
      "第2波の増援に注意すること。",
    ],
    playerShipId: "rapier",
    playerSpawn: [0, 0, 0],
    wingmen: [
      { shipId: "rapier", position: [-45, 0, -40], combatant: true },
    ],
    neutrals: [],
    navPoints: [],
    waves: [
      {
        trigger: { type: "start" },
        announce: "敵編隊を捕捉。交戦開始。",
        ships: [
          { shipId: "dralthi", position: [-120, 30, 700] },
          { shipId: "dralthi", position: [120, -20, 780] },
          { shipId: "dralthi", position: [0, 60, 820] },
        ],
      },
      {
        trigger: { type: "afterWave", wave: 0 },
        announce: "警告: 敵エース «Khajja» を確認！",
        ships: [
          {
            shipId: "dralthi",
            position: [-80, 20, 1000],
            ace: { name: "Khajja nar Ragitika", skill: 0.9, aggression: 0.85, healthMul: 1.5 },
          },
          { shipId: "dralthi", position: [90, -30, 1050] },
        ],
      },
    ],
    objectives: [{ id: "kill", label: "敵機を全滅させる", type: "destroyAll" }],
    successText: "宙域を制圧した。よくやった、パイロット。",
    failText: "機体を失った…",
  },

  // M2: 護衛 — 輸送艦を守りつつ襲撃を撃退。
  escort: {
    id: "escort",
    name: "護衛任務 — Drayman 輸送艦",
    briefing: [
      "Drayman 輸送艦を敵襲から護衛せよ。",
      "輸送艦が撃沈されれば任務失敗だ。",
      "全ての襲撃機を排除して輸送艦を守り抜け。",
    ],
    playerShipId: "rapier",
    playerSpawn: [40, 0, -60],
    neutrals: [
      { shipId: "transport", position: [0, 0, 0], tag: "convoy", combatant: false },
    ],
    wingmen: [{ shipId: "rapier", position: [60, 0, -50], combatant: true }],
    navPoints: [],
    waves: [
      {
        trigger: { type: "start" },
        announce: "襲撃機、複数接近中！",
        ships: [
          { shipId: "dralthi", position: [-300, 40, 900] },
          { shipId: "dralthi", position: [300, -30, 950] },
        ],
      },
      {
        trigger: { type: "time", seconds: 25 },
        announce: "第2波: 重戦闘機が輸送艦を狙っている！",
        ships: [
          { shipId: "gratha", position: [0, 80, 1100] },
          { shipId: "dralthi", position: [-260, -60, 1000] },
        ],
      },
    ],
    objectives: [
      { id: "protect", label: "輸送艦 Drayman を守る", type: "protect", tag: "convoy" },
      { id: "kill", label: "襲撃機を全滅させる", type: "destroyAll" },
    ],
    successText: "輸送艦は無事だ。護衛成功。",
    failText: "輸送艦を守れなかった…",
  },

  // M3: 強襲 — ナビポイントへ進出し、敵拠点部隊を撃破。
  strike: {
    id: "strike",
    name: "強襲任務 — 敵前哨の破壊",
    briefing: [
      "ナビポイント Alpha へ進出し、駐留する Kilrathi 部隊を撃破せよ。",
      "到達後、増援が展開する。全機撃墜せよ。",
    ],
    playerShipId: "rapier",
    playerSpawn: [0, 0, 0],
    wingmen: [{ shipId: "rapier", position: [-45, 0, -40], combatant: true }],
    neutrals: [],
    navPoints: [{ id: "alpha", label: "NAV ALPHA", position: [0, 0, 2600], radius: 260 }],
    waves: [
      {
        trigger: { type: "start" },
        ships: [
          {
            shipId: "gratha",
            position: [-150, 40, 2900],
            ace: { name: "Dakhath «Deathstroke»", skill: 0.97, aggression: 0.95, healthMul: 1.8 },
          },
          { shipId: "gratha", position: [150, -30, 2950] },
        ],
      },
      {
        trigger: { type: "afterWave", wave: 0 },
        announce: "敵増援が展開！",
        ships: [
          { shipId: "dralthi", position: [0, 90, 3050] },
          { shipId: "dralthi", position: [-260, -50, 2850] },
        ],
      },
    ],
    objectives: [
      { id: "nav", label: "NAV ALPHA へ進出", type: "reachNav", nav: "alpha" },
      { id: "kill", label: "敵前哨部隊を全滅", type: "destroyAll" },
    ],
    successText: "敵前哨を制圧した。帰投せよ。",
    failText: "任務失敗。",
  },

  // M4: 防衛 — 母艦を波状攻撃から守り抜く。
  defense: {
    id: "defense",
    name: "防衛戦 — TCS Victory",
    briefing: [
      "我が母艦 TCS Victory が Kilrathi の大規模攻撃を受けている。",
      "波状攻撃を撃退し、Victory を守り抜け。",
      "4波にわたる攻撃が予想される。持ちこたえろ。",
    ],
    playerShipId: "rapier",
    playerSpawn: [0, 0, -80],
    wingmen: [
      { shipId: "rapier", position: [-50, 0, -60], combatant: true },
      { shipId: "rapier", position: [50, 0, -60], combatant: true },
    ],
    neutrals: [
      { shipId: "transport", position: [0, 0, 200], tag: "victory", combatant: false },
    ],
    navPoints: [],
    waves: [
      {
        trigger: { type: "start" },
        announce: "第1波、接近中！",
        ships: [
          { shipId: "dralthi", position: [-200, 40, 1200] },
          { shipId: "dralthi", position: [200, -30, 1250] },
          { shipId: "dralthi", position: [0, 60, 1300] },
        ],
      },
      {
        trigger: { type: "time", seconds: 30 },
        announce: "第2波: 重戦闘機を含む編隊！",
        ships: [
          { shipId: "gratha", position: [-150, 20, 1400] },
          { shipId: "dralthi", position: [150, -40, 1350] },
          { shipId: "dralthi", position: [0, 80, 1500] },
        ],
      },
      {
        trigger: { type: "time", seconds: 60 },
        announce: "第3波: 左右から挟撃！",
        ships: [
          { shipId: "dralthi", position: [-400, 0, 800] },
          { shipId: "gratha", position: [400, 0, 800] },
          { shipId: "dralthi", position: [-350, 50, 900] },
        ],
      },
      {
        trigger: { type: "time", seconds: 90 },
        announce: "最終波: エース «Bhurak» 率いる精鋭部隊！",
        ships: [
          {
            shipId: "gratha",
            position: [0, 40, 1600],
            ace: { name: "Bhurak nar Caxki", skill: 0.95, aggression: 0.9, healthMul: 2.0 },
          },
          { shipId: "gratha", position: [-180, -20, 1550] },
          { shipId: "dralthi", position: [180, 60, 1650] },
          { shipId: "dralthi", position: [0, -60, 1700] },
        ],
      },
    ],
    objectives: [
      { id: "protect", label: "TCS Victory を守る", type: "protect", tag: "victory" },
      { id: "kill", label: "全攻撃波を撃退", type: "destroyAll" },
    ],
    successText: "Victory は健在だ。全攻撃波を撃退した。",
    failText: "Victory が…我々は敗北した。",
  },
};

/** ミッション表示順 (ブリーフィングの「X/Y」表示に使用)。 */
export const MISSION_ORDER = ["patrol", "escort", "strike", "defense"] as const;

/**
 * キャンペーン分岐グラフ。
 * 各ノードの success/failure で次のミッションIDを指定する。
 * - 文字列: そのミッションへ遷移
 * - "retry": 同ミッションを再挑戦
 * - null: キャンペーン終了 (success からなら完全クリア、failure からなら敗北終了)
 */
export interface CampaignNode {
  success: string | null;
  failure: string | "retry" | null;
}

export const CAMPAIGN: { start: string; nodes: Record<string, CampaignNode> } = {
  start: "patrol",
  nodes: {
    patrol: { success: "escort", failure: "retry" },
    escort: { success: "strike", failure: "retry" },
    strike: { success: "defense", failure: "retry" },
    defense: { success: null, failure: "retry" },
  },
};
