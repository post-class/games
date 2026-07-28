import { describe, it, expect } from "vitest";
import { World } from "../src/ecs/World";

describe("World: ECSコア", () => {
  it("エンティティ生成とコンポーネント付与・取得", () => {
    const w = new World();
    const e = w.createEntity();
    w.add(e, "Pos", { x: 1 });
    expect(w.get<{ x: number }>(e, "Pos")?.x).toBe(1);
    expect(w.has(e, "Pos")).toBe(true);
    expect(w.has(e, "Vel")).toBe(false);
  });

  it("query は指定した全コンポーネントを持つエンティティのみ返す", () => {
    const w = new World();
    const a = w.createEntity();
    const b = w.createEntity();
    w.add(a, "A", 1);
    w.add(a, "B", 1);
    w.add(b, "A", 1);
    expect(w.query("A").sort()).toEqual([a, b].sort());
    expect(w.query("A", "B")).toEqual([a]);
  });

  it("destroyEntity は flush まで遅延し、query から即座に除外される", () => {
    const w = new World();
    const e = w.createEntity();
    w.add(e, "A", 1);
    w.destroyEntity(e);
    // flush 前でも query からは除外。
    expect(w.query("A")).toEqual([]);
    expect(w.isAlive(e)).toBe(false);
    const removed = w.flushDestroyed();
    expect(removed).toEqual([e]);
    expect(w.has(e, "A")).toBe(false);
  });
});
