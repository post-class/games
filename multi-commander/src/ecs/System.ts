import type { World } from "./World";

/**
 * システム。固定タイムステップ系(fixed)と可変レート系(variable)で共通のインターフェース。
 * alpha は可変系でのみ意味を持つ補間係数(0..1)。
 */
export interface System {
  readonly name: string;
  update(world: World, dt: number, alpha: number): void;
}

/**
 * システムを登録順に実行するスケジューラ。
 * fixed 系は固定dtで、variable 系は可変dtで実行する。
 */
export class SystemScheduler {
  private readonly fixedSystems: System[] = [];
  private readonly variableSystems: System[] = [];

  addFixed(system: System): this {
    this.fixedSystems.push(system);
    return this;
  }

  addVariable(system: System): this {
    this.variableSystems.push(system);
    return this;
  }

  runFixed(world: World, dt: number): void {
    for (const system of this.fixedSystems) {
      system.update(world, dt, 1);
    }
    // 固定ステップ末尾でエンティティ破棄を確定する。
    world.flushDestroyed();
  }

  runVariable(world: World, dt: number, alpha: number): void {
    for (const system of this.variableSystems) {
      system.update(world, dt, alpha);
    }
  }
}
