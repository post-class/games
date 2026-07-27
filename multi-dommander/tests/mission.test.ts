import { describe, it, expect } from "vitest";
import { Scene } from "three";
import { World } from "../src/ecs/World";
import { MissionManager } from "../src/game/mission/MissionManager";
import { MISSIONS } from "../src/game/mission/missions";
import { Comp, Faction } from "../src/game/components";
import type { Transform } from "../src/game/components";

function enemies(w: World): number[] {
  return w.query(Comp.Faction, Comp.Health).filter((e) => w.get<Faction>(e, Comp.Faction) === Faction.Enemy);
}
function killAll(w: World, ids: number[]) {
  ids.forEach((e) => w.destroyEntity(e));
  w.flushDestroyed();
}

describe("MissionManager: 目標評価", () => {
  it("patrol: 全ウェーブ出現前は destroyAll 未完了、全滅で成功", () => {
    const w = new World();
    const m = new MissionManager(w, new Scene());
    m.load(MISSIONS.patrol, 0);
    // 第1波 (2機) が出現。
    expect(enemies(w).length).toBe(2);
    // 第1波を全滅させても、まだ第2波が控えるので成功しない。
    killAll(w, enemies(w));
    m.update(1 / 60, 0.1);
    expect(m.outcome).toBe("active");
    // 第2波 (1機) が出現。
    expect(enemies(w).length).toBe(1);
    // 第2波も全滅で成功。
    killAll(w, enemies(w));
    m.update(1 / 60, 0.2);
    expect(m.outcome).toBe("success");
  });

  it("escort: 護衛対象(輸送艦)が破壊されると失敗", () => {
    const w = new World();
    const m = new MissionManager(w, new Scene());
    m.load(MISSIONS.escort, 0);
    // 護衛対象の輸送艦を特定して破壊する (僚機も Ally なので shipId で判別)。
    const transport = w
      .query(Comp.Faction, Comp.Health, Comp.ShipInfo)
      .find(
        (e) =>
          w.get<Faction>(e, Comp.Faction) === Faction.Ally &&
          w.get<{ shipId: string }>(e, Comp.ShipInfo)?.shipId === "transport",
      );
    expect(transport).toBeDefined();
    killAll(w, [transport!]);
    m.update(1 / 60, 0.1);
    expect(m.outcome).toBe("failure");
  });

  it("strike: ナビ到達で reachNav 完了、全滅で成功", () => {
    const w = new World();
    const m = new MissionManager(w, new Scene());
    m.load(MISSIONS.strike, 0);
    const player = m.getPlayer()!;
    // プレイヤーをナビ Alpha (0,0,2600) へ移動。
    const pt = w.getOrThrow<Transform>(player, Comp.Transform);
    pt.position.set(0, 0, 2600);
    // 敵を全滅させ、ナビ到達も満たす。
    // まず両ウェーブを出現させるため段階的にクリア。
    killAll(w, enemies(w)); // wave0
    m.update(1 / 60, 0.1); // wave1 出現
    killAll(w, enemies(w)); // wave1
    m.update(1 / 60, 0.2);
    expect(m.outcome).toBe("success");
  });

  it("プレイヤー消滅で失敗", () => {
    const w = new World();
    const m = new MissionManager(w, new Scene());
    m.load(MISSIONS.patrol, 0);
    w.destroyEntity(m.getPlayer()!);
    w.flushDestroyed();
    m.update(1 / 60, 0.1);
    expect(m.outcome).toBe("failure");
  });
});
