import type { EntityId } from "../ecs/Entity";
import type { Vector3 } from "three";

/** システム間の疎結合な通知に使うイベント定義。サウンド・VFX・HUD 演出の差し込み口。 */
export interface GameEvents {
  hit: { target: EntityId; source: EntityId; damage: number; position: Vector3 };
  /** 撃墜。velocity=撃墜時の速度(デブリ飛散方向)、source=とどめを刺したエンティティ(不明ならnull)。 */
  destroyed: {
    entity: EntityId;
    position: Vector3;
    faction: number;
    velocity: Vector3;
    source: EntityId | null;
  };
  /** 発射。muzzlePosition=砲口実座標(マズルフラッシュ用)、direction=発射方向(正規化)。 */
  weaponFired: {
    shooter: EntityId;
    position: Vector3;
    muzzlePosition: Vector3;
    direction: Vector3;
    kind: "gun" | "missile";
  };
  lockAcquired: { shooter: EntityId; target: EntityId };
  /** シールドが被弾を吸収した瞬間 (シールドリップル演出用)。normal=着弾面の外向き法線。 */
  shieldHit: { entity: EntityId; position: Vector3; normal: Vector3 };
  /** カメラを揺らす要求 (被弾/至近爆発フィードバック用)。intensity=0..1。 */
  cameraShake: { intensity: number; duration: number };
}

type Handler<E> = (payload: E) => void;

/** 型付き最小イベントバス。 */
export class EventBus {
  private readonly handlers = new Map<keyof GameEvents, Set<Handler<unknown>>>();

  on<K extends keyof GameEvents>(type: K, handler: Handler<GameEvents[K]>): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler as Handler<unknown>);
    return () => set!.delete(handler as Handler<unknown>);
  }

  emit<K extends keyof GameEvents>(type: K, payload: GameEvents[K]): void {
    const set = this.handlers.get(type);
    if (!set) return;
    for (const handler of set) (handler as Handler<GameEvents[K]>)(payload);
  }
}
