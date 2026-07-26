export type GamePhase = "Menu" | "Briefing" | "Playing" | "Debrief";

export type MissionResult = "success" | "failure" | null;

/** 実行時のゲーム状態。 */
export interface GameStateData {
  phase: GamePhase;
  /** 現在ミッションの結果 (Debrief時に参照)。 */
  result: MissionResult;
  resultText: string;
  kills: number;
  elapsed: number;
}

export function createGameState(): GameStateData {
  return { phase: "Menu", result: null, resultText: "", kills: 0, elapsed: 0 };
}
