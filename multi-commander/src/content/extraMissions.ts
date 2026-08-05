import { dynamicMissionDef } from './frontline';
import type { DynamicMissionKind, FrontlineSystemId } from './frontline';
import type { MissionDef } from '../mission/types';

/** 本線の外周に置く常設任務。id と seed が固定なので攻略・リプレイ対象になる。 */
export const EXTRA_MISSIONS: MissionDef[] = [
  ['m7-quiet-patrol', 'McCaffrey', 'quiet'],
  ['m7-escort-run', 'McCaffrey', 'escort'],
  ['m7-raider-sweep', 'McCaffrey', 'patrol'],
  ['m8-rescue-line', 'Gimle', 'rescue'],
  ['m8-strike-window', 'Gimle', 'strike'],
  ['m8-supply-raid', 'Gimle', 'capital'],
  ['m9-frontier-patrol', 'Vega', 'patrol'],
  ['m9-last-convoy', 'Vega', 'escort'],
  ['m9-capital-attack', 'Vega', 'capital'],
].map(([id, system, kind], i) => {
  const ref = { id, system: system as FrontlineSystemId, kind: kind as DynamicMissionKind, seed: 8000 + i, returnNode: 'm1-patrol' };
  const base = dynamicMissionDef(ref);
  return { ...base, title: `外周作戦 ${i + 1} — ${base.title}` };
});
