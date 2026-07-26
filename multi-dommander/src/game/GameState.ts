export type GamePhase = "Playing" | "Victory" | "GameOver";

/** 実行時のゲーム状態。 */
export interface GameStateData {
  phase: GamePhase;
  kills: number;
  elapsed: number;
}

export function createGameState(): GameStateData {
  return { phase: "Playing", kills: 0, elapsed: 0 };
}
