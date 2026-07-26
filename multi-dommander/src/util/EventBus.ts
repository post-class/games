import type { EntityId } from "../ecs/Entity";
import type { Vector3 } from "three";

/** システム間の疎結合な通知に使うイベント定義。将来サウンド等の差し込み口にもなる。 */
export interface GameEvents {
  hit: { target: EntityId; source: EntityId; damage: number; position: Vector3 };
  destroyed: { entity: EntityId; position: Vector3; faction: number };
  weaponFired: { shooter: EntityId; position: Vector3; kind: "gun" | "missile" };
  lockAcquired: { shooter: EntityId; target: EntityId };
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
