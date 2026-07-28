import type { System } from "../../ecs/System";
import type { World } from "../../ecs/World";
import { Faction } from "../components";
import type { MissionManager } from "../mission/MissionManager";
import type { GameStateData } from "../GameState";
import type { EventBus } from "../../util/EventBus";

/**
 * ミッションの進行を駆動する (固定dt)。
 * MissionManager を更新し、勝敗が決したら GameState を Debrief へ遷移させる。
 * 撃墜数のカウントも行う。
 */
export class MissionSystem implements System {
  readonly name = "MissionSystem";

  constructor(
    private readonly mission: MissionManager,
    private readonly state: GameStateData,
    events: EventBus,
    private readonly getSimTime: () => number,
    private readonly onMissionEnd: (result: "success" | "failure") => void,
  ) {
    events.on("destroyed", (e) => {
      if (e.faction === Faction.Enemy) this.state.kills += 1;
    });
  }

  update(_world: World, dt: number): void {
    if (this.state.phase !== "Playing") return;
    this.state.elapsed += dt;
    this.mission.update(dt, this.getSimTime());

    if (this.mission.outcome !== "active") {
      const result = this.mission.outcome;
      const def = this.mission.getMission();
      this.state.result = result;
      this.state.resultText =
        result === "success" ? (def?.successText ?? "任務完了") : (def?.failText ?? "任務失敗");
      this.state.phase = "Debrief";
      this.onMissionEnd(result);
    }
  }
}
