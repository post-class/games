/**
 * ui/hud/missionPanel.ts — キャンペーンの目標とヒント（M16 の HUD 側）
 *
 * ■ なぜ要るのか
 * ミッション定義には `hints`（何をすればよいか）と `victory`（勝利条件）が入っているが、
 * **画面に出していなければ定義した意味がない**。第 1 章は `06§13` の練習メニューなので、
 * 「いま何を求められているか」が読めないとそもそも遊べない。
 *
 * ■ 置き方
 * 対戦画面の上に重なるオーバーレイ（他のパネルと同じ扱い）。
 * **試合は止まらない**（`05§1`）。左上の資源帯とぶつからない位置に置く。
 *
 * ■ 目標の文を作り直さない
 * 条件の日本語化は章選択画面（`Campaign.ts` の `conditionText`）が既に持っている。
 * 同じ条件が 2 か所で違う言い方になると「別のことを要求されている」と読めるので、
 * **同じ関数を使う**。
 *
 * ■ 層
 * ui 層。sim は読むだけ。`MissionRun` から**受け取った値を表示するだけ**で、
 * 判定はしない（判定は `campaign/runner.ts`）。
 */

import '@/styles/mission.css';

import type { Mission } from '@/campaign';
import type { MissionHint, ObjectiveProgress } from '@/campaign';
import { conditionText } from '@/ui/screens/Campaign';
import { TICK_RATE } from '@/sim';

/** 残り tick を「あと n 秒」にする。0 なら空文字（継続条件でないものは何も出さない）。 */
export function remainingText(remainingTicks: number): string {
  if (remainingTicks <= 0) return '';
  const sec = Math.ceil(remainingTicks / TICK_RATE);
  return `あと ${sec} 秒`;
}

/** 目標 1 行の表示（テスト対象の純関数）。 */
export interface ObjectiveLine {
  readonly text: string;
  readonly met: boolean;
  /** 継続条件の残り（無ければ空文字）。 */
  readonly remaining: string;
}

/** 進捗 → 表示行。**満たした目標も消さない**（何が残っているかは対比で分かる）。 */
export function objectiveLines(
  mission: Mission,
  progress: readonly ObjectiveProgress[],
): ObjectiveLine[] {
  return progress.map((p) => ({
    text: conditionText(mission, p.condition),
    met: p.met,
    remaining: remainingText(p.remainingTicks),
  }));
}

/**
 * 出すヒントを選ぶ。**いちばん新しい 1 件だけ**。
 *
 * 全部並べると画面が埋まるし、古い指示が残っていると
 * 「今どれに従えばよいか」が分からなくなる。
 */
export function latestHint(hints: readonly MissionHint[]): MissionHint | null {
  if (hints.length === 0) return null;
  // `hints()` は発生順。同 tick に複数出たら最後のものを採る。
  return hints[hints.length - 1] ?? null;
}

/** ミッション HUD。 */
export class MissionPanel {
  private readonly root: HTMLElement;
  private readonly title: HTMLElement;
  private readonly hint: HTMLElement;
  private readonly list: HTMLElement;
  /** 前回描いた内容（同じなら DOM を触らない）。 */
  private lastKey = '';

  constructor(
    overlay: HTMLElement,
    private readonly mission: Mission,
  ) {
    this.root = document.createElement('div');
    this.root.className = 'mt-mission';
    this.title = document.createElement('div');
    this.title.className = 'mt-mission-title';
    this.title.textContent = mission.title;
    this.hint = document.createElement('div');
    this.hint.className = 'mt-mission-hint';
    this.list = document.createElement('ul');
    this.list.className = 'mt-mission-objs';
    this.root.append(this.title, this.hint, this.list);
    overlay.appendChild(this.root);
  }

  /** 毎フレーム呼ぶ。中身が変わっていなければ何もしない。 */
  update(progress: readonly ObjectiveProgress[], hints: readonly MissionHint[]): void {
    const lines = objectiveLines(this.mission, progress);
    const hintNow = latestHint(hints);
    const key = `${hintNow?.tick ?? -1}|${lines.map((l) => `${l.met ? 1 : 0}${l.remaining}`).join(',')}`;
    if (key === this.lastKey) return;
    this.lastKey = key;

    this.hint.textContent = hintNow?.text ?? '';
    this.hint.hidden = hintNow === null;

    this.list.textContent = '';
    for (const l of lines) {
      const li = document.createElement('li');
      li.className = `mt-mission-obj${l.met ? ' is-met' : ''}`;
      const mark = document.createElement('span');
      mark.className = 'mt-mission-mark';
      // 色だけに頼らない（`06§12` の色以外の手がかり）
      mark.textContent = l.met ? '✔' : '・';
      const text = document.createElement('span');
      text.textContent = l.text;
      li.append(mark, text);
      if (l.remaining !== '') {
        const rest = document.createElement('span');
        rest.className = 'mt-mission-rest';
        rest.textContent = l.remaining;
        li.appendChild(rest);
      }
      this.list.appendChild(li);
    }
  }

  destroy(): void {
    this.root.remove();
  }
}
