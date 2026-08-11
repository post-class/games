import { dynamicMissionDef } from './frontline';
import type { DynamicMissionKind, FrontlineSystemId } from './frontline';
import type { MissionDef } from '../mission/types';

/**
 * 本線の外周に置く常設任務。id と seed が固定なので攻略・リプレイ対象になる。
 *
 * 戦域は THE VEIL FRONT の5戦域へ振り直した（旧: McCaffrey / Gimle / Vega）。
 * id（`m7-` `m8-` `m9-` 接頭辞）と seed は攻略情報の安定のため変更しない。
 * 割り当ての根拠は、任務の性格を戦域の事実（世界観spec §05）へ合わせること:
 * - 静かな哨戒 → 巣脈群（通信障害で報告が来ない戦域）
 * - 補給線護衛・掃討 → オリオン港（連邦の補給・修理拠点）
 * - 捜索救難 → 静穏海（セレシオンの救難船団が回廊を維持）
 * - 強襲・拠点叩き → 深層採掘帯（採掘停止で資源が争点）
 * - 前線哨戒・最後の船団・拠点攻撃 → ヴェガ門（圧力「極高」の決戦線）
 */
export const EXTRA_MISSIONS: MissionDef[] = [
  ['m7-quiet-patrol', 'hive-veins', 'quiet'],
  ['m7-escort-run', 'orion-port', 'escort'],
  ['m7-raider-sweep', 'orion-port', 'patrol'],
  ['m8-rescue-line', 'quiet-sea', 'rescue'],
  ['m8-strike-window', 'deep-mining-belt', 'strike'],
  ['m8-supply-raid', 'deep-mining-belt', 'capital'],
  ['m9-frontier-patrol', 'vega-gate', 'patrol'],
  ['m9-last-convoy', 'vega-gate', 'escort'],
  ['m9-capital-attack', 'vega-gate', 'capital'],
].map(([id, system, kind], i) => {
  const ref = { id, system: system as FrontlineSystemId, kind: kind as DynamicMissionKind, seed: 8000 + i, returnNode: 'veil-ch01' };
  const base = dynamicMissionDef(ref);
  return { ...base, title: `外周作戦 ${i + 1} — ${base.title}` };
});
