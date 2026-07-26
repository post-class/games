import type { System } from "../../ecs/System";
import type { World } from "../../ecs/World";
import type { EntityId } from "../../ecs/Entity";
import { Comp, Faction } from "../components";
import type { GameStateData } from "../GameState";
import type { EventBus } from "../../util/EventBus";

/**
 * 勝敗条件の評価。
 * - 敵陣営が全滅 -> Victory
 * - プレイヤー機が消滅 -> GameOver
 * 撃墜数のカウントも行う。
 */
export class GameRuleSystem implements System {
  readonly name = "GameRuleSystem";
  private ended = false;

  constructor(
    private readonly state: GameStateData,
    private readonly getPlayer: () => EntityId | null,
    events: EventBus,
    private readonly onEnd: (phase: "Victory" | "GameOver") => void,
  ) {
    events.on("destroyed", (e) => {
      if (e.faction === Faction.Enemy) this.state.kills += 1;
    });
  }

  update(world: World, dt: number): void {
    if (this.ended) return;
    this.state.elapsed += dt;

    const player = this.getPlayer();
    if (player === null || !world.isAlive(player)) {
      this.finish("GameOver");
      return;
    }

    const enemies = world
      .query(Comp.Faction, Comp.Health)
      .filter((e) => world.get<Faction>(e, Comp.Faction) === Faction.Enemy);
    if (enemies.length === 0) {
      this.finish("Victory");
    }
  }

  private finish(phase: "Victory" | "GameOver"): void {
    this.ended = true;
    this.state.phase = phase;
    this.onEnd(phase);
  }
}
