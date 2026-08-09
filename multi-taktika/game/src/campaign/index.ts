/**
 * campaign/index.ts — キャンペーン層の唯一の入口（M16）
 *
 * 章選択画面（`ui/screens/Campaign.ts`。**別担当**）と `main.ts` はここから見えるものだけを使う。
 * ここに実装は置かない（結線と再エクスポートだけ）。
 *
 * 使い方（章選択画面 → ミッション開始 → 決着 → 分岐 → 保存）:
 * ```ts
 * const progress = loadProgress();
 * const id = progress.current ?? firstMissionOfChapter(1)?.id;
 * const mission = missionById(id);
 * const run = createMissionRun(mission);          // World が組み上がる
 * // 毎 tick: run.step(playerCommands) → outcome / hints / objectives
 * const next = recordOutcome(progress, mission.id, 'defeat', run.world.tick);
 * saveProgress(next);                              // 負けても next.current は服属ルートを指す
 * ```
 */

export type {
  ChapterInfo,
  Mission,
  MissionAction,
  MissionBuildingPlacement,
  MissionCondition,
  MissionEvent,
  MissionRoute,
  MissionSetup,
  MissionTrigger,
  MissionUnitPlacement,
  Placement,
  UnitGroup,
} from './mission';
export {
  MISSIONS,
  MISSION_ACTION_TYPES,
  MISSION_CONDITION_TYPES,
  SAVE_STORAGE_KEY,
  SAVE_VERSION,
  campaignChapters,
  firstMissionOfChapter,
  mainMissionsOfChapter,
  missionById,
  missionsOfChapter,
  parseMission,
} from './mission';

export type { MissionHint, MissionOutcome, MissionRun, MissionStepResult, ObjectiveProgress } from './runner';
export { createMissionRun } from './runner';

export type { CampaignProgress, CampaignRecord, ProgressStorage, RecordedOutcome } from './progress';
export {
  clearProgress,
  currentMissionId,
  emptyProgress,
  isMissionUnlocked,
  lastRecordOf,
  loadProgress,
  recordOutcome,
  saveProgress,
  vassalRecords,
} from './progress';
