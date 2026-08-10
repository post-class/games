/**
 * 目標の常時表示を3行に絞る (T2-⑧)。
 *
 * 7項目の目標と4本のタイマーを全部並べると、何を優先すべきか読めない。
 * 飛行中に常に出すのは
 *
 *   1. いま追うべき目標 (`focus`)
 *   2. 一番差し迫った制限時間 (`timer`)
 *   3. 直近に片付いた1件 (`recent`)
 *
 * の**最大3行だけ**にして、全目標は右 VDU の一覧 (`V`) へ移す。
 * ここは DOM を触らない純粋な組み立てなので、単体テストで行数と優先順位を固定できる。
 */

export interface ObjectiveView {
  text: string;
  state: 'active' | 'done' | 'failed';
  /**
   * 必須目標か。**省略時は必須として扱う**。
   *
   * 加点 (任意) 目標の表記は `MissionRunner.objectiveRewardPrefix()` が唯一の出所なので、
   * ここでは「必須か否か」だけを受け取り、記号と色の出し分けに使う。
   */
  required?: boolean;
  /** 制限時間の残り秒。指定があるものだけを `timer` 行の候補にする。 */
  timeLeftSec?: number;
}

/** 常時表示の1行。 */
export interface ObjectiveLine {
  role: 'focus' | 'timer' | 'recent';
  /** 目標文 (加点の前置を含む。ここで組み立て直さない) */
  text: string;
  state: 'active' | 'done' | 'failed';
  required: boolean;
  /** `timer` 行のときだけ入る残り秒 */
  timeLeftSec?: number;
  /** 同種の行が他に何件あるか (タイマーが4本あるときの「他3件」) */
  others?: number;
}

/** 常時表示の上限。3行を超えたら読めなくなるので、ここを唯一の上限にする。 */
export const OBJECTIVE_LINE_LIMIT = 3;

/** 状態の記号。達成 ✓ / 失敗 ✖ / 進行中 ▸ (既存の記号をそのまま踏襲する)。 */
export function objectiveMark(state: ObjectiveView['state']): string {
  return state === 'done' ? '✓' : state === 'failed' ? '✖' : '▸';
}

/** 残り時間の表記。分を超えるものは `m:ss` にして桁数を揃える。 */
export function formatTimeLeft(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const isRequired = (o: ObjectiveView): boolean => o.required !== false;

/**
 * 常時表示の3行を作る。
 *
 * @param objs `MissionRunner.objectiveViews()` の並び (順序は宣言順)
 * @param recent 直近に片付いた1件 (呼び側が状態遷移を覚えて渡す)
 */
export function buildObjectiveLines(
  objs: readonly ObjectiveView[],
  recent?: ObjectiveView,
): ObjectiveLine[] {
  const active = objs.filter((o) => o.state === 'active');
  const timers = active
    .filter((o) => o.timeLeftSec !== undefined)
    .sort((a, b) => (a.timeLeftSec ?? 0) - (b.timeLeftSec ?? 0));
  const timerTexts = new Set(timers.map((o) => o.text));

  // いま追うべき目標: 必須で、かつ「時間を待つだけ」ではないものを最優先にする。
  const focus =
    active.find((o) => isRequired(o) && !timerTexts.has(o.text)) ??
    active.find((o) => isRequired(o)) ??
    active.find((o) => !timerTexts.has(o.text)) ??
    active[0];

  const lines: ObjectiveLine[] = [];
  if (focus) {
    lines.push({
      role: 'focus',
      text: focus.text,
      state: focus.state,
      required: isRequired(focus),
    });
  }
  const timer = timers.find((o) => o !== focus) ?? timers[0];
  if (timer && timer !== focus) {
    lines.push({
      role: 'timer',
      text: timer.text,
      state: timer.state,
      required: isRequired(timer),
      timeLeftSec: timer.timeLeftSec,
      others: Math.max(0, timers.length - 1),
    });
  }
  if (recent) {
    lines.push({
      role: 'recent',
      text: recent.text,
      state: recent.state,
      required: isRequired(recent),
    });
  }
  return lines.slice(0, OBJECTIVE_LINE_LIMIT);
}
