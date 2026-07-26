import type { EntityId } from "./Entity";
import { MapComponentStore, type ComponentStore } from "./Component";

/**
 * ECS ワールド。エンティティの生成/破棄と、コンポーネントストアの管理・クエリを担う。
 * コンポーネントは名前(string)で登録・参照する。型付きアクセスは getStore<T>() で行う。
 */
export class World {
  private nextId: EntityId = 1;
  private readonly stores = new Map<string, MapComponentStore<unknown>>();
  private readonly alive = new Set<EntityId>();
  /** 破棄予約されたエンティティ。イテレーション中の破棄を安全にするため遅延削除する。 */
  private readonly pendingDestroy = new Set<EntityId>();

  createEntity(): EntityId {
    const id = this.nextId++;
    this.alive.add(id);
    return id;
  }

  isAlive(entity: EntityId): boolean {
    return this.alive.has(entity) && !this.pendingDestroy.has(entity);
  }

  /** 破棄を予約する。実際の削除は flushDestroyed() で行う。 */
  destroyEntity(entity: EntityId): void {
    if (this.alive.has(entity)) {
      this.pendingDestroy.add(entity);
    }
  }

  /** 予約された破棄を確定し、全ストアからコンポーネントを取り除く。 */
  flushDestroyed(): EntityId[] {
    if (this.pendingDestroy.size === 0) return [];
    const removed = [...this.pendingDestroy];
    for (const entity of removed) {
      for (const store of this.stores.values()) {
        store.remove(entity);
      }
      this.alive.delete(entity);
    }
    this.pendingDestroy.clear();
    return removed;
  }

  /** 名前付きストアを登録（未登録なら生成）して返す。 */
  registerStore<T>(name: string): MapComponentStore<T> {
    let store = this.stores.get(name);
    if (!store) {
      store = new MapComponentStore<unknown>(name);
      this.stores.set(name, store);
    }
    return store as MapComponentStore<T>;
  }

  /** 型付きストアを取得。未登録なら生成する。 */
  getStore<T>(name: string): MapComponentStore<T> {
    return this.registerStore<T>(name);
  }

  /** コンポーネント値を設定。 */
  add<T>(entity: EntityId, name: string, value: T): void {
    this.getStore<T>(name).set(entity, value);
  }

  /** コンポーネント値を取得（未登録は undefined）。 */
  get<T>(entity: EntityId, name: string): T | undefined {
    return this.getStore<T>(name).get(entity);
  }

  /** コンポーネント値を取得（未登録は例外）。 */
  getOrThrow<T>(entity: EntityId, name: string): T {
    return this.getStore<T>(name).getOrThrow(entity);
  }

  has(entity: EntityId, name: string): boolean {
    const store = this.stores.get(name);
    return store ? store.has(entity) : false;
  }

  /**
   * 指定した全コンポーネントを持つ生存エンティティの配列を返す。
   * 最小サイズのストアを起点に交差を取る。破棄予約済みは除外。
   */
  query(...names: string[]): EntityId[] {
    if (names.length === 0) return [];
    const involved: ComponentStore<unknown>[] = [];
    for (const name of names) {
      const store = this.stores.get(name);
      if (!store || store.size === 0) return [];
      involved.push(store);
    }
    involved.sort((a, b) => a.size - b.size);

    const [smallest, ...rest] = involved;
    const result: EntityId[] = [];
    for (const entity of smallest.entities()) {
      if (this.pendingDestroy.has(entity)) continue;
      let ok = true;
      for (const store of rest) {
        if (!store.has(entity)) {
          ok = false;
          break;
        }
      }
      if (ok) result.push(entity);
    }
    return result;
  }

  get entityCount(): number {
    return this.alive.size;
  }
}
