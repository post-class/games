import { Faction } from "./components";

/**
 * 敵対判定。
 * - Player と Ally は同陣営 (友軍・相互に撃たない/狙わない)。
 * - Enemy は Player/Ally と敵対。
 * - Neutral はどの陣営とも非敵対 (攻撃対象にならない)。
 */
export function isHostile(a: Faction, b: Faction): boolean {
  if (a === Faction.Neutral || b === Faction.Neutral) return false;
  const friendlyA = a === Faction.Player || a === Faction.Ally;
  const friendlyB = b === Faction.Player || b === Faction.Ally;
  if (friendlyA && friendlyB) return false;
  return a !== b;
}

/** 友軍かどうか (Player/Ally 同士)。 */
export function isFriendly(a: Faction, b: Faction): boolean {
  const fa = a === Faction.Player || a === Faction.Ally;
  const fb = b === Faction.Player || b === Faction.Ally;
  return fa && fb;
}
