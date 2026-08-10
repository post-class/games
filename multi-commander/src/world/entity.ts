import { Quaternion, Vector3 } from 'three';
import type { Faction, ShipDef } from '../content/ships';
import type { GunDef, MissileDef, SeekerKind } from '../content/weapons';
import type { SubsystemMap } from '../sim/subsystems';

export type EntityKind = 'ship' | 'projectile' | 'missile' | 'flare' | 'nav' | 'rock' | 'mine';

/** 操縦指令。プレイヤー・AI・僚機すべてがこれを生成し、飛行モデルは区別しない。 */
export interface ThrusterInput {
  /** -1..1 (+ = 機首上げ) */
  pitch: number;
  /** -1..1 (+ = 右旋回) */
  yaw: number;
  /** -1..1 (+ = 右ロール) */
  roll: number;
  /** 0..1 の速度設定 (目標速度の割合。レバー式で保持される) */
  throttle: number;
  afterburner: boolean;
  firePrimary: boolean;
  /** 副兵装の発射要求 (1フレームだけ true) */
  fireSecondary: boolean;
}

export function newInput(): ThrusterInput {
  return {
    pitch: 0,
    yaw: 0,
    roll: 0,
    throttle: 0,
    afterburner: false,
    firePrimary: false,
    fireSecondary: false,
  };
}

export type ArmorFace = 'front' | 'rear' | 'left' | 'right';
export type ShieldFace = 'front' | 'rear';

export interface MissileSlot {
  missileId: string;
  count: number;
}

export interface ShipRuntime {
  def: ShipDef;
  /** 飛行モデルに適用する最高速倍率。通常は 1 (難易度の敵速度補正などに使う)。 */
  speedScale: number;
  hull: number;
  armor: Record<ArmorFace, number>;
  shield: Record<ShieldFace, number>;
  energy: number;
  fuel: number;
  /** アフターバーナー燃料の上限 (難易度倍率を掛けた実際の値) */
  fuelMax: number;
  /** 被弾後、シールド再生が止まる残り秒数 */
  shieldDelay: number;
  /**
   * 接触ダメージの再判定までの残り秒数。
   * 60Hz で毎フレーム衝突ダメージが入ると、擦っただけで即死してしまうため、
   * 接触は離散的な衝撃として扱う。
   */
  collisionCooldown: number;
  /** 砲口ごとの再装填残時間 */
  gunCooldown: number[];
  /** 発射直後の砲口ごとの反動残量。描画だけが参照し、セーブには依存しない。 */
  gunRecoil: number[];
  /** 発射不可通知の間引きタイマー */
  weaponDeniedCooldown: number;
  missiles: MissileSlot[];
  activeMissile: number;
  flares: number;
  flareCooldown: number;

  /** 現在ターゲットの entity id */
  targetId?: number;
  /** ミサイルロックの進捗 0..1 */
  lockProgress: number;
  /** ロック完了しているターゲット id */
  lockedId?: number;
  /**
   * 手動ロック (設定「ミサイルロック: 手動」) で L を押してロックを開始したか。
   * 自動ロック時は参照されない。ターゲット変更・副兵装切替・発射・脱出で false へ戻す。
   */
  lockArmed: boolean;

  /** 自機に向かっているミサイル (警告用) */
  incomingMissileId?: number;
  /** 自分をロックしている敵がいるか */
  lockedByEnemy: boolean;

  /** 表示用パイロット名 */
  pilot?: string;
  /** エース敵 (HUD で強調) */
  ace?: boolean;
  /** 撃墜数 (デブリーフ用) */
  kills: number;

  /** 爆発済みフラグ (二重処理防止) */
  dying?: boolean;
  /** 脱出済み (ポッド状態) */
  ejected?: boolean;

  /** 部位ごとの損傷状態 (戦闘機のみ。未初期化なら全て正常) */
  subsystems?: SubsystemMap;
}

export interface ProjectileRuntime {
  gun: GunDef;
  damage: number;
  life: number;
  ownerId: number;
  ownerFaction: Faction;
  fromPlayer: boolean;
  /** シールドにだけ適用する武器固有倍率 */
  shieldMultiplier: number;
  /** アーマーに適用する武器固有倍率 */
  armorMultiplier: number;
  /** 描画/音声が同じ武器プロファイルを参照するための生成時刻 */
  age: number;
  /** 発射時の難易度による実効命中半径倍率 */
  hitRadiusScale: number;
}

export interface MissileRuntime {
  def: MissileDef;
  seeker: SeekerKind;
  life: number;
  ownerId: number;
  ownerFaction: Faction;
  fromPlayer: boolean;
  targetId?: number;
  /** 発射直後は誘導しない (自機に当たらないように) */
  armTime: number;
  /** 飛翔時間。航跡の間引きと音の距離減衰に使う。 */
  age: number;
  /** デコイに吸着した場合の対象 */
  decoyId?: number;
  /** 発射時のプレイヤー補正。敵ミサイルはすべて 1。 */
  speedScale: number;
  triggerScale: number;
  blastScale: number;
}

/** 小惑星。撃てば壊れ、ぶつかれば痛い障害物 */
export interface RockRuntime {
  /** 残り耐久 */
  hull: number;
  /** 見た目のバリエーション (0..3) */
  variant: number;
  /** 自転速度 (rad/s) */
  spin: Vector3;
}

/** 機雷。接近すると起爆する */
export interface MineRuntime {
  /** 起爆する距離 */
  triggerRadius: number;
  /** 爆発の威力 */
  damage: number;
  /** 爆発の影響半径 */
  blastRadius: number;
  /** 起爆までの遅延 (接近を検知してから) */
  fuse: number;
  /** 起爆シーケンスに入ったか */
  armed: boolean;
  /** この陣営は起爆させない (敷設側) */
  ownerFaction: Faction;
  hull: number;
}

export interface NavRuntime {
  index: number;
  name: string;
  /** 到達判定半径 */
  arriveRadius: number;
  reached: boolean;
}

export interface Entity {
  id: number;
  alive: boolean;
  kind: EntityKind;
  faction: Faction;

  /** ワールド位置 */
  pos: Vector3;
  /** 直前フレームの位置 (スイープ判定用) */
  prevPos: Vector3;
  /** ワールド速度 */
  vel: Vector3;
  /** 姿勢 */
  quat: Quaternion;
  /** ローカル角速度 (rad/s) */
  angVel: Vector3;
  /** 当たり判定半径 */
  radius: number;

  /** 描画補間用の1ステップ前の姿勢・位置 */
  renderPrevPos: Vector3;
  renderPrevQuat: Quaternion;

  input?: ThrusterInput;
  ship?: ShipRuntime;
  projectile?: ProjectileRuntime;
  missile?: MissileRuntime;
  nav?: NavRuntime;
  rock?: RockRuntime;
  mine?: MineRuntime;
  ai?: AiRuntime;

  /** HUD 表示名 */
  label?: string;
  /** ミッション側で参照するタグ (護衛対象など) */
  tag?: string;
  /** 描画側が持つメッシュとの対応キー */
  meshId?: number;
}

export type AiMode = 'idle' | 'pursue' | 'attack' | 'evade' | 'flee' | 'escort' | 'strafe';

export interface AiRuntime {
  mode: AiMode;
  /** 0..1。命中精度・反応速度・回避判断に影響 */
  skill: number;
  /** 攻撃対象 */
  targetId?: number;
  /** 状態タイマー */
  timer: number;
  /** 回避機動の種類と残り時間 */
  maneuver?: 'break' | 'jink' | 'roll' | 'extend';
  maneuverTimer: number;
  maneuverSign: number;
  /** 次の回避機動に入れるまでの待ち時間 (回避しかしない状態を防ぐ) */
  maneuverCooldown: number;
  /** 士気。低いと離脱する */
  morale: number;
  /** 護衛/追従対象 */
  leaderId?: number;
  /** 僚機オーダー */
  order?: WingmanOrder;
  /** 射撃を控える猶予 (連続射撃を散らす) */
  fireHold: number;
  /** ミサイル発射のクールダウン */
  missileCooldown: number;
  /** 交戦開始からの経過 (初弾を遅らせる) */
  engagedFor: number;
  /**
   * 性格。飛び方に効く。
   * obedience が低いと編隊指令を無視し、aggression が高いと深追いする。
   */
  personality?: {
    obedience: number;
    aggression: number;
    caution: number;
    grit: number;
  };
  /** 命令を無視している間の残り時間 (無鉄砲なパイロットが勝手に動く) */
  disobeyTimer?: number;
  /** 攻撃せず、指定地点へ巡航するだけの機体 (輸送艦など) */
  passive?: boolean;
  /** 巡航目標 (ワールド座標) */
  cruiseTo?: Vector3;
}

export type WingmanOrder = 'form' | 'attack-my-target' | 'break-and-attack' | 'help-me';
