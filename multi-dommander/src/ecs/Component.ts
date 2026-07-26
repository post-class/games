import type { EntityId } from "./Entity";

/** コンポーネントストアのインターフェース。初期実装は Map ベース。 */
export interface ComponentStore<T> {
  readonly name: string;
  has(entity: EntityId): boolean;
  get(entity: EntityId): T | undefined;
  set(entity: EntityId, value: T): void;
  remove(entity: EntityId): void;
  entities(): Iterable<EntityId>;
  readonly size: number;
}

/** Map ベースの汎用コンポーネントストア。エンティティ数が少ない前提で十分。 */
export class MapComponentStore<T> implements ComponentStore<T> {
  private readonly data = new Map<EntityId, T>();

  constructor(public readonly name: string) {}

  has(entity: EntityId): boolean {
    return this.data.has(entity);
  }

  get(entity: EntityId): T | undefined {
    return this.data.get(entity);
  }

  /** 未登録なら例外。存在が保証される文脈で使う糖衣。 */
  getOrThrow(entity: EntityId): T {
    const v = this.data.get(entity);
    if (v === undefined) {
      throw new Error(`Component "${this.name}" not found on entity ${entity}`);
    }
    return v;
  }

  set(entity: EntityId, value: T): void {
    this.data.set(entity, value);
  }

  remove(entity: EntityId): void {
    this.data.delete(entity);
  }

  entities(): Iterable<EntityId> {
    return this.data.keys();
  }

  get size(): number {
    return this.data.size;
  }
}
