/** 自機の撃墜をプレイテスト記録へ分類するための理由。 */
export type DestructionReason =
  | 'enemy-gun'
  | 'enemy-missile'
  | 'friendly-gun'
  | 'friendly-missile'
  | 'collision'
  | 'rock'
  | 'mine'
  | 'unknown';

/** destroyEntity に渡す、シミュレーション上の破壊要因。 */
export type DestructionCause = 'gun' | 'missile' | 'collision' | 'rock' | 'mine' | 'unknown';

export function classifyDestruction(
  cause: DestructionCause,
  sourceFaction?: string,
  targetFaction?: string,
): DestructionReason {
  if (cause === 'gun') return sourceFaction === targetFaction ? 'friendly-gun' : 'enemy-gun';
  if (cause === 'missile') return sourceFaction === targetFaction ? 'friendly-missile' : 'enemy-missile';
  if (cause === 'collision') return 'collision';
  if (cause === 'rock') return 'rock';
  if (cause === 'mine') return 'mine';
  return 'unknown';
}
