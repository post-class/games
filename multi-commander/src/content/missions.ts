import type { MissionDef } from '../mission/types';
import { EXTRA_MISSIONS } from './extraMissions';
import { VEIL_MISSIONS } from './veil/missions';

/**
 * ミッション定義の登録簿。
 *
 * 実際の定義は THE VEIL FRONT の十章（`./veil/missions`）と外周作戦
 * （`./extraMissions`）が持ち、ここはそれらを id で引けるように束ねるだけ。
 * 以前ここに直接置いていた旧11ミッション（`m1-patrol` 〜 `l2-last-stand`）は、
 * 戦役を THE VEIL FRONT だけにしたときに削除した。
 */

export const MISSIONS: Record<string, MissionDef> = {
  ...Object.fromEntries(EXTRA_MISSIONS.map((m) => [m.id, m])),
  // 本編。十章キャンペーン THE VEIL FRONT
  ...VEIL_MISSIONS,
};

export const MISSION_COUNT = Object.keys(MISSIONS).length;

export function missionDef(id: string): MissionDef {
  const m = MISSIONS[id];
  if (!m) throw new Error(`unknown mission: ${id}`);
  return m;
}
