/**
 * 十章キャンペーンのミッション集約。
 *
 * 章ごとのファイル（`ch01.ts`〜`ch10.ts`）をここでまとめ、
 * `MISSIONS`（`src/content/missions.ts`）へ登録できる形にする。
 * キーは `veil-ch01`〜`veil-ch10` で、`VEIL_CAMPAIGN` のノードidと一致する。
 */

import type { MissionDef } from '../../../mission/types';
import { VEIL_CH01 } from './ch01';
import { VEIL_CH02 } from './ch02';
import { VEIL_CH03 } from './ch03';
import { VEIL_CH04 } from './ch04';
import { VEIL_CH05 } from './ch05';
import { VEIL_CH06 } from './ch06';
import { VEIL_CH07 } from './ch07';
import { VEIL_CH08 } from './ch08';
import { VEIL_CH09 } from './ch09';
import { VEIL_CH10 } from './ch10';

/** 章順のミッション一覧 */
export const VEIL_MISSION_LIST: readonly MissionDef[] = [
  VEIL_CH01,
  VEIL_CH02,
  VEIL_CH03,
  VEIL_CH04,
  VEIL_CH05,
  VEIL_CH06,
  VEIL_CH07,
  VEIL_CH08,
  VEIL_CH09,
  VEIL_CH10,
];

/** id 引きのミッション表 */
export const VEIL_MISSIONS: Record<string, MissionDef> = Object.fromEntries(
  VEIL_MISSION_LIST.map((mission) => [mission.id, mission]),
);

export {
  VEIL_CH01,
  VEIL_CH02,
  VEIL_CH03,
  VEIL_CH04,
  VEIL_CH05,
  VEIL_CH06,
  VEIL_CH07,
  VEIL_CH08,
  VEIL_CH09,
  VEIL_CH10,
};
