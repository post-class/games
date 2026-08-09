/**
 * campaign/progress.ts — キャンペーンのセーブ（T-M16-06）
 *
 * 完了条件は「**進行と分岐履歴が残る / ブラウザを閉じても続きから遊べる**」こと。
 *
 * ---- 壊れても止まらないこと（重要）----
 *  - 保存できない環境（プライベートモード、`localStorage` が無い実行環境、容量超過）でも
 *    **例外を投げない**。`saveProgress` は false を返すだけで、ゲームは続く。
 *  - 壊れた JSON / 想定外の形は**黙って捨てて既定値**で始める。
 *  - `version` が合わないセーブは**黙って読まない**（`_config.json` の `save.version`）。
 *    「読めるところだけ移行する」方式にすると、古い分岐履歴が中途半端に残って
 *    章選択画面の表示が壊れる。合わなければ捨てる方が予測できる。
 *
 * ---- 何を残すか ----
 *  - `current`: 次に遊ぶミッション（null = 章の最初から）
 *  - `cleared`: 勝ってクリアしたミッション ID
 *  - `history`: **分岐履歴**（どのミッションを勝った / 負けた、そのときどのルートに居たか）。
 *    服属ルートを通ったことが記録に残るのは T-M16-03 / T-M16-05 の完了条件。
 *
 * `localStorage` を直接触るのはこのファイルだけ（差し替え可能にしてテストできるようにする）。
 */

import { SAVE_MAX_HISTORY, SAVE_STORAGE_KEY, SAVE_VERSION, missionById } from './mission';
import type { MissionRoute } from './mission';

/** 決着の記録（`running` は記録しない）。 */
export type RecordedOutcome = 'victory' | 'defeat';

/** 分岐履歴の 1 件。 */
export interface CampaignRecord {
  readonly mission: string;
  readonly outcome: RecordedOutcome;
  /** そのミッションのルート（`vassal` = 服属ルートを通った記録）。 */
  readonly route: MissionRoute;
  /** 決着した tick（`Date.now()` は使わない。リプレイと同じ時間軸で残す）。 */
  readonly tick: number;
}

/** セーブの中身。 */
export interface CampaignProgress {
  readonly version: number;
  /** 次に遊ぶミッション（null = まだ始めていない / 章を終えた）。 */
  readonly current: string | null;
  readonly cleared: readonly string[];
  readonly history: readonly CampaignRecord[];
}

/** 読み書きに使う入れ物（テストではダミーを渡す）。 */
export interface ProgressStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

// ---------------------------------------------------------------------------
// 既定値
// ---------------------------------------------------------------------------

/** 何も無い状態（読めなかったときもこれ）。 */
export function emptyProgress(): CampaignProgress {
  return { version: SAVE_VERSION, current: null, cleared: [], history: [] };
}

// ---------------------------------------------------------------------------
// 保存先
// ---------------------------------------------------------------------------

/**
 * 既定の保存先（`localStorage`）。無い環境では null。
 * アクセスそのものが例外になる環境（一部のブラウザのプライベートモード）があるので
 * try / catch で包む。
 */
function defaultStorage(): ProgressStorage | null {
  try {
    const ls = (globalThis as { localStorage?: ProgressStorage }).localStorage;
    return ls ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 読み書き
// ---------------------------------------------------------------------------

/**
 * セーブを読む。**絶対に例外を投げない。**
 * 読めない / 壊れている / バージョン違いのときは `emptyProgress()`。
 */
export function loadProgress(storage: ProgressStorage | null = defaultStorage()): CampaignProgress {
  if (storage === null) return emptyProgress();
  let raw: string | null = null;
  try {
    raw = storage.getItem(SAVE_STORAGE_KEY);
  } catch {
    return emptyProgress();
  }
  if (raw === null || raw === '') return emptyProgress();

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyProgress(); // 壊れた JSON は黙って捨てる
  }
  return sanitize(parsed);
}

/**
 * セーブを書く。書けなかったら false（例外は投げない）。
 */
export function saveProgress(
  progress: CampaignProgress,
  storage: ProgressStorage | null = defaultStorage(),
): boolean {
  if (storage === null) return false;
  try {
    storage.setItem(SAVE_STORAGE_KEY, JSON.stringify(normalize(progress)));
    return true;
  } catch {
    return false; // 容量超過・書き込み禁止でもゲームは続ける
  }
}

/** セーブを消す（「はじめから」）。失敗しても例外にしない。 */
export function clearProgress(storage: ProgressStorage | null = defaultStorage()): void {
  if (storage === null) return;
  try {
    storage.removeItem(SAVE_STORAGE_KEY);
  } catch {
    /* 消せなくても続行する */
  }
}

// ---------------------------------------------------------------------------
// 進行
// ---------------------------------------------------------------------------

/**
 * ミッションの決着を進行に反映する（**純粋関数**。保存は呼び出し側が `saveProgress` で行う）。
 *
 * - 勝ったら `cleared` に足して `onVictory` へ
 * - **負けても `onDefeat` へ進む**（`02` の服属。ゲームオーバーにしない）
 * - どちらも履歴に残る（分岐履歴）
 *
 * 未知のミッション ID は何もしない（古いセーブや壊れた入力で落とさない）。
 */
export function recordOutcome(
  progress: CampaignProgress,
  missionId: string,
  outcome: RecordedOutcome,
  tick: number,
): CampaignProgress {
  const m = missionById(missionId);
  if (m === null) return progress;

  const next = outcome === 'victory' ? m.onVictory : m.onDefeat;
  const cleared =
    outcome === 'victory' && !progress.cleared.includes(missionId)
      ? [...progress.cleared, missionId]
      : [...progress.cleared];
  const record: CampaignRecord = {
    mission: missionId,
    outcome,
    route: m.route,
    tick: Number.isInteger(tick) && tick >= 0 ? tick : 0,
  };
  const history = [...progress.history, record];
  // 履歴は増え続けるので上限を持たせる（古いものから落とす）。
  const trimmed = history.length > SAVE_MAX_HISTORY ? history.slice(-SAVE_MAX_HISTORY) : history;

  return { version: SAVE_VERSION, current: next, cleared, history: trimmed };
}

/** 次に遊ぶミッション ID（無ければ null）。 */
export function currentMissionId(progress: CampaignProgress): string | null {
  return progress.current;
}

/** そのミッションを遊べるか（クリア済み / 現在地 / 章の最初）。 */
export function isMissionUnlocked(progress: CampaignProgress, missionId: string): boolean {
  if (progress.current === missionId) return true;
  if (progress.cleared.includes(missionId)) return true;
  // 一度でも「その話に到達した」記録があれば開いている（負けて分岐した先も含む）。
  for (let i = 0; i < progress.history.length; i++) {
    if (progress.history[i]!.mission === missionId) return true;
  }
  return false;
}

/** 服属ルートを通った記録（章選択画面の「分岐した側のルートも記録に残る」）。 */
export function vassalRecords(progress: CampaignProgress): readonly CampaignRecord[] {
  return progress.history.filter((r) => r.route === 'vassal');
}

/** そのミッションの最後の記録（無ければ null）。 */
export function lastRecordOf(progress: CampaignProgress, missionId: string): CampaignRecord | null {
  for (let i = progress.history.length - 1; i >= 0; i--) {
    const r = progress.history[i]!;
    if (r.mission === missionId) return r;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 正規化 / 検証
// ---------------------------------------------------------------------------

function normalize(p: CampaignProgress): CampaignProgress {
  return {
    version: SAVE_VERSION,
    current: p.current,
    cleared: [...p.cleared],
    history: [...p.history],
  };
}

/**
 * 読み込んだ値を検証して `CampaignProgress` にする。
 * **1 か所でも想定外なら既定値**（部分的に壊れたセーブを引き継がない）。
 */
function sanitize(v: unknown): CampaignProgress {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return emptyProgress();
  const rec = v as Record<string, unknown>;
  if (rec['version'] !== SAVE_VERSION) return emptyProgress(); // バージョン違いは黙って読まない

  const current = rec['current'];
  if (current !== null && typeof current !== 'string') return emptyProgress();

  const clearedRaw = rec['cleared'];
  if (!Array.isArray(clearedRaw)) return emptyProgress();
  const cleared: string[] = [];
  for (let i = 0; i < clearedRaw.length; i++) {
    const id = clearedRaw[i];
    if (typeof id !== 'string') return emptyProgress();
    // 定義が消えた（JSON を作り直した）ミッションは捨てる。
    if (missionById(id) === null) continue;
    if (!cleared.includes(id)) cleared.push(id);
  }

  const historyRaw = rec['history'];
  if (!Array.isArray(historyRaw)) return emptyProgress();
  const history: CampaignRecord[] = [];
  for (let i = 0; i < historyRaw.length; i++) {
    const r = historyRaw[i];
    if (typeof r !== 'object' || r === null || Array.isArray(r)) return emptyProgress();
    const rr = r as Record<string, unknown>;
    const mission = rr['mission'];
    const outcome = rr['outcome'];
    const route = rr['route'];
    const tick = rr['tick'];
    if (typeof mission !== 'string') return emptyProgress();
    if (outcome !== 'victory' && outcome !== 'defeat') return emptyProgress();
    if (route !== 'main' && route !== 'vassal') return emptyProgress();
    if (typeof tick !== 'number' || !Number.isInteger(tick) || tick < 0) return emptyProgress();
    if (missionById(mission) === null) continue;
    history.push({ mission, outcome, route, tick });
  }

  // `current` が定義から消えていたら「まだ始めていない」に落とす。
  const cur = typeof current === 'string' && missionById(current) !== null ? current : null;
  return { version: SAVE_VERSION, current: cur, cleared, history };
}
