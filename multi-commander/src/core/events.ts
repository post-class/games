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
  };
  /** シールドで受け止めた */
  shieldHit: { target: Entity; point: Vector3; amount: number; isPlayer: boolean };
  /** アーマーまたはハルに通った。層を分けることで命中の手応えを描き分ける */
  armorHit: {
    target: Entity;
    point: Vector3;
    amount: number;
    layer: 'armor' | 'hull';
    isPlayer: boolean;
  };
  /** 撃墜/破壊 */
  destroyed: { target: Entity; source?: Entity; killedByPlayer: boolean; reason?: DestructionReason };
  /** 爆発 (ミサイル起爆など) */
  explosion: { pos: Vector3; radius: number; kind: 'missile' | 'ship' | 'small' };
  /** ミサイルロック状態の変化 */
  lockChanged: { locked: boolean; target?: Entity };
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
