import { describe, it, expect } from "vitest";
import { MISSIONS, CAMPAIGN, MISSION_ORDER } from "../src/game/mission/missions";

describe("キャンペーングラフの整合性", () => {
  it("開始ミッションが存在する", () => {
    expect(MISSIONS[CAMPAIGN.start]).toBeDefined();
  });

  it("全ノードの遷移先が有効 (実在ミッション / retry / null)", () => {
    for (const [id, node] of Object.entries(CAMPAIGN.nodes)) {
      expect(MISSIONS[id], `node ${id} の元ミッションが存在`).toBeDefined();
      for (const target of [node.success, node.failure]) {
        if (target === null || target === "retry") continue;
        expect(MISSIONS[target], `${id} の遷移先 ${target} が存在`).toBeDefined();
      }
    }
  });

  it("success をたどると最終的に null (クリア) に到達する", () => {
    let cur: string | null = CAMPAIGN.start;
    const visited = new Set<string>();
    let steps = 0;
    while (cur !== null && steps < 100) {
      expect(visited.has(cur), `success 経路にループなし: ${cur}`).toBe(false);
      visited.add(cur);
      cur = CAMPAIGN.nodes[cur].success;
      steps++;
    }
    expect(cur).toBeNull();
  });

  it("MISSION_ORDER の全ミッションが定義済み", () => {
    for (const id of MISSION_ORDER) expect(MISSIONS[id]).toBeDefined();
  });
});
