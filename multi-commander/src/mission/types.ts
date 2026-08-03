import type { Faction } from '../content/ships';
import type { LandmarkDef } from '../render/Landmarks';
import type { SkyboxOptions } from '../render/Starfield';

export type Tone = 'friendly' | 'enemy' | 'command';

export interface RadioLineDef {
  speaker: string;
  text: string;
  tone?: Tone;
  /** 直前の台詞からの遅延 (秒) */
  after?: number;
}

/** 目標の判定内容 */
export type ObjectiveSpec =
  | { kind: 'destroyAll' }
  | { kind: 'destroyTag'; tag: string }
  | { kind: 'protect'; tag: string }
  | { kind: 'reachNav'; navIndex: number }
  | { kind: 'survive'; seconds: number }
  /** タグの付いた対象すべてに接近して回収する (捜索救助) */
  | { kind: 'rescue'; tag: string; radius?: number }
  /**
   * 偵察。対象を照準に収めたまま近距離を保つ。
   * 「撮影」なので撃つ必要はないが、逃げられると撮り直しになる。
   */
  | { kind: 'recon'; tag: string; seconds?: number; range?: number; coneDeg?: number }
  /** 制限時間。超過すると失敗する (時間制限つき防衛や強襲に使う) */
  | { kind: 'timeLimit'; seconds: number };

export interface ObjectiveDef {
  id: string;
  text: string;
  /** 失敗するとミッション失敗になるか */
  required: boolean;
  spec: ObjectiveSpec;
}

export interface SpawnGroupDef {
  shipId: string;
  count: number;
  faction: Faction;
  /** この Nav に到達したら出現 (省略時は開始時) */
  atNav?: number;
  /** 出現条件を満たしてからの遅延 (秒) */
  delay?: number;
  /** Nav 位置からのオフセット */
  offset?: [number, number, number];
  /** 機体をばらけさせる幅 */
  spread?: number;
  /** 技量 (省略時は難易度から) */
  skill?: number;
  /** エース機として1機だけ強化する */
  ace?: { pilot: string; skillBonus?: number; shipId?: string };
  /** ミッション目標から参照するタグ */
  tag?: string;
  /** 味方機を編隊で飛ばすときのリーダー (player なら自機) */
  followPlayer?: boolean;
  /** 出現時の無線 */
  radio?: RadioLineDef[];
  /** 初速 */
  speed?: number;
  /** 護衛対象など、指定 Nav 方向へ巡航させる */
  cruiseToNav?: number;
}

/**
 * 戦域に置く障害物のかたまり。
 * 「何も無い宇宙」を避け、Nav ごとに場所の性格を持たせるために使う。
 */
export interface HazardDef {
  kind: 'asteroids' | 'minefield';
  /** 中心となる Nav (省略時は原点)。betweenNavs があればそちらが優先 */
  atNav?: number;
  /** 2つの Nav を結ぶ航路上にばらまく (帯・封鎖線を作る) */
  betweenNavs?: [number, number];
  /** 中心からのオフセット */
  offset?: [number, number, number];
  /** 個数 */
  count: number;
  /** ばらまく半径 */
  spread: number;
  /** 岩の半径の範囲 (asteroids のみ) */
  rockRadius?: [number, number];
  /** 機雷の所属 (この陣営は起爆させない。minefield のみ、既定 kilrathi) */
  faction?: Faction;
}

export interface NavDef {
  name: string;
  pos: [number, number, number];
  /** 到達判定半径 */
  arriveRadius?: number;
  /** 到達時の無線 */
  onArrive?: RadioLineDef[];
}

export interface MissionDef {
  id: string;
  title: string;
  /** 星系名 (ブリーフィングに出す) */
  system: string;
  /** ブリーフィングの本文 (段落ごと) */
  briefing: string[];
  /** ブリーフィングを読み上げる人物 */
  briefingSpeaker: string;
  navs: NavDef[];
  spawns: SpawnGroupDef[];
  /** 小惑星帯・機雷原など */
  hazards?: HazardDef[];
  /** 巨大構造物 (描画のみ。当たり判定は持たない) */
  landmarks?: LandmarkDef[];
  objectives: ObjectiveDef[];
  /** 既定の搭乗機 */
  playerShipId: string;
  /** 機体の既定副兵装を上書きする (魚雷を積ませる等) */
  playerMissiles?: Array<{ missileId: string; count: number }>;
  wingman?: { shipId: string; pilot: string; skill: number };
  skybox?: SkyboxOptions;
  /** 開始時の無線 */
  openingRadio?: RadioLineDef[];
  debriefWin: string[];
  debriefLoss: string[];
}

/** ロードアウト (格納庫の選択画面から渡す) */
export interface Loadout {
  shipId: string;
  gunId?: string;
  missiles?: Array<{ missileId: string; count: number }>;
  /**
   * 同行する僚機。
   * 名簿から選ばれた人物の情報をそのまま渡す (未指定なら単独出撃)。
   */
  wingman?: {
    pilotId: string;
    callsign: string;
    shipId: string;
    skill: number;
    personality: { obedience: number; aggression: number; caution: number; grit: number };
  };
}
