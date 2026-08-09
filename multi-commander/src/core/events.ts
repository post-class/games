import type { Vector3 } from 'three';
import type { DestructionReason } from './destruction';
import type { Entity } from '../world/entity';

/** ゲーム内で飛び交うイベント。描画・音・HUD はここを購読して疎結合に反応する。 */
export interface GameEvents {
  /** 砲/ミサイル発射 */
  weaponFired: {
    shooter: Entity;
    muzzle: Vector3;
    direction: Vector3;
    weaponKind: 'gun' | 'missile';
    weaponId: string;
    isPlayer: boolean;
    /** 同一 ID の描画・音声を選ぶための軽量な分類情報 */
    profile?: string;
    recoil?: number;
    /** パルスキャノンなど、1回の発射で生成された弾数 */
    shotCount?: number;
  };
  /** シールドで受け止めた */
  shieldHit: {
    target: Entity;
    point: Vector3;
    amount: number;
    isPlayer: boolean;
    weaponId?: string;
    damageType?: 'gun' | 'missile' | 'collision' | 'hazard';
    distance?: number;
    hitFace?: 'front' | 'rear' | 'left' | 'right';
    critical?: boolean;
  };
  /** アーマーまたはハルに通った。層を分けることで命中の手応えを描き分ける */
  armorHit: {
    target: Entity;
    point: Vector3;
    amount: number;
    layer: 'armor' | 'hull';
    isPlayer: boolean;
    weaponId?: string;
    damageType?: 'gun' | 'missile' | 'collision' | 'hazard';
    distance?: number;
    hitFace?: 'front' | 'rear' | 'left' | 'right';
    critical?: boolean;
  };
  /**
   * 兵装が機体に命中した (1回の命中につき1件)。
   *
   * `shieldHit` / `armorHit` はダメージの層ごとに複数回飛ぶうえ、`isPlayer` が
   * 「撃たれたのが自機か」を意味するため、「誰が誰に当てたか」を数えられない。
   * 誤射判定のように命中回数と撃った側が必要な処理はこのイベントを使う。
   * 衝突・機雷などの兵装以外のダメージでは発生しない。
   */
  weaponHit: {
    target: Entity;
    /** 撃った機体 (すでに失われている場合は undefined) */
    shooter?: Entity;
    /** 自機が撃った弾か */
    fromPlayer: boolean;
    weaponKind: 'gun' | 'missile';
    weaponId?: string;
  };
  /** 撃墜/破壊 */
  destroyed: { target: Entity; source?: Entity; killedByPlayer: boolean; reason?: DestructionReason };
  /** 爆発 (ミサイル起爆など) */
  explosion: {
    pos: Vector3;
    radius: number;
    kind: 'missile' | 'ship' | 'small';
    weaponId?: string;
    detonation?: string;
    affectedCount?: number;
  };
  /** ミサイルロック状態の変化 */
  lockChanged: {
    locked: boolean;
    target?: Entity;
    progress?: number;
    missileId?: string;
    reason?: 'target-lost' | 'out-of-cone' | 'out-of-range' | 'complete';
  };
  /** 入力に対して武器が撃てなかった理由。HUD と音声の共通入口。 */
  weaponDenied: {
    shooter: Entity;
    weaponKind: 'gun' | 'missile';
    weaponId?: string;
    reason: 'energy' | 'damaged' | 'no-ammo' | 'no-lock' | 'invalid-target' | 'cooldown';
    isPlayer: boolean;
  };
  /** 自機がロックされた */
  incomingLock: { active: boolean };
  /** 無線通信 (HUD にテキスト表示) */
  radio: { speaker: string; text: string; tone?: 'friendly' | 'enemy' | 'command' };
  /** 画面中央のアナウンス */
  announce: { text: string; kind?: 'info' | 'warn' | 'good' | 'bad'; durationMs?: number };
  /** 無線の声が鳴っている間 (口の動きに使う) */
  radioVoice: { speaker: string; seconds: number };
  /** ミッション目標の更新 */
  objectivesChanged: Record<string, never>;
  /** Nav 到達 */
  navReached: { index: number; name: string };
  /** オートパイロット開始/終了 */
  autopilot: { active: boolean; reason?: string };
  /** カメラを揺らす */
  cameraShake: { strength: number; durationMs?: number };
  /** 自機が脱出した */
  ejected: { entity: Entity };
  /** 僚機が命令を無視して飛び出した */
  wingmanDisobeyed: { entity: Entity };
  /** 僚機が窮地で助けを求めた */
  wingmanInTrouble: { entity: Entity };
  /** 部位が損傷した */
  subsystemDamaged: {
    entity: Entity;
    id: string;
    label: string;
    state: 'damaged' | 'dead';
    isPlayer: boolean;
  };
  /** ミッション終了 */
  missionEnded: { outcome: 'win' | 'loss' };
}

type Handler<T> = (payload: T) => void;

export class EventBus {
  private handlers = new Map<string, Set<Handler<never>>>();

  on<K extends keyof GameEvents>(type: K, handler: Handler<GameEvents[K]>): () => void {
    let set = this.handlers.get(type as string);
    if (!set) {
      set = new Set();
      this.handlers.set(type as string, set);
    }
    set.add(handler as Handler<never>);
    return () => set!.delete(handler as Handler<never>);
  }

  emit<K extends keyof GameEvents>(type: K, payload: GameEvents[K]): void {
    const set = this.handlers.get(type as string);
    if (!set) return;
    for (const h of set) (h as Handler<GameEvents[K]>)(payload);
  }

  /** ミッション切り替え時など、購読を一括で捨てたいとき */
  clear(): void {
    this.handlers.clear();
  }
}

export const bus = new EventBus();
