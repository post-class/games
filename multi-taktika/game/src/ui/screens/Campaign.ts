/**
 * ui/screens/Campaign.ts — キャンペーン章選択画面（`T-M16-05` / `05§5`）
 *
 * `05§5` の 7 項目:
 *  1. 達成した章 ―― メダルが暗い金。**分岐した側のルートも記録として残る**
 *  2. 現在の章 ―― 明るく光るメダル。章 = 時代（黎明 → 青銅 → 鉄器 → 帝国）
 *  3. 未開放の章 ―― 前の章のミッションを 1 つ以上クリアすると開く
 *  4. 進路 ―― 点線。分岐に入ると二股に分かれ、負けた側の道も描かれる
 *  5. 碑の島 ―― 章が進むごとに碑の解読部分が増える
 *  6. ミッション一覧 ―― 5 枚のプレート。未挑戦・クリア・分岐後の再挑戦が分かる
 *  7. 出撃 ―― 封蝋のボタン。押すと対戦画面に入る
 *
 * ■ 設計の要点
 *  - **ミッション固有の分岐をこのファイルに書かない**（第 1 章の設計をそのまま守る）。
 *    章・話・勝利条件・ヒントはすべて `@/campaign`（= `src/data/campaign/*.json`）から引く。
 *    JSON を足せば画面が追従する。
 *  - **数値リテラルを書かない**。章の数・話の数・tick 数はすべて定義側の値。
 *    見た目の寸法は `src/styles/campaign.css` に置く。
 *  - **`Date.now()` を使わない**。履歴に残るのは決着した tick だけ（`02` / `progress.ts`）。
 *  - 反復は index 昇順（`campaignChapters()` / `mainMissionsOfChapter()` は既に並んでいる）。
 *  - 判定と文言の組み立ては **DOM を触らない純関数**に分けてある（テストは
 *    `tests/unit/ui.campaign.test.ts` がそこだけを見る）。
 *  - **試合の起動はこの画面の責務ではない**。`nav.go('match', { missionId })` まで。
 *    `main.ts` 側で `params.missionId` を受けて `createMissionRun` を回す。
 */

import '@/styles/screens.css';
import '@/styles/campaign.css';

import {
  campaignChapters,
  clearProgress,
  firstMissionOfChapter,
  isMissionUnlocked,
  loadProgress,
  mainMissionsOfChapter,
  missionById,
  missionsOfChapter,
  vassalRecords,
} from '@/campaign';
import type { CampaignProgress, CampaignRecord, ChapterInfo, Mission, MissionCondition } from '@/campaign';
import { AGE_IDS } from '@/shared/types';
import type { Age } from '@/shared/types';
import { buildingDefById, civDefById, orderDefById, unitDefById } from '@/sim/core/defs';
import { loadGameData } from '@/data/load';
import { el, button, type Screen, type ScreenNav, type ScreenParams } from './router';
import { emblemEl } from './CivSelect';

// ---------------------------------------------------------------------------
// 純関数（DOM を触らない。テスト対象）
// ---------------------------------------------------------------------------

/** 章 1 つの状態（`05§5-1`〜`05§5-3`）。 */
export type ChapterState = 'locked' | 'current' | 'cleared';

/** ミッション 1 枚の状態（`05§5-6`）。 */
export type MissionState = 'locked' | 'open' | 'current' | 'cleared';

/** 章のメダル 1 枚に出す情報。 */
export interface ChapterView {
  readonly info: ChapterInfo;
  readonly state: ChapterState;
  /** 碑の解読が進んだ数 = その章でクリアした本線の話数（`05§5-5`）。 */
  readonly decoded: number;
  /** 章の本線の話数。 */
  readonly total: number;
}

/** ミッションプレート 1 枚に出す情報。 */
export interface MissionView {
  readonly mission: Mission;
  readonly state: MissionState;
  /** 服属ルートに入った記録があるか（`05§5-4` の二股の点線）。 */
  readonly branched: boolean;
  /** 分岐先の服属ルート（無ければ null）。 */
  readonly vassal: Mission | null;
}

/**
 * その章が開いているか（`05§5-3`「前の章のミッションを 1 つ以上クリアすると開く」）。
 *
 * 最初の章は常に開いている。**章番号を直接書かない**（`_config.json` の
 * `chapters` の先頭を最初の章として扱う）ので、章を足しても増やしても動く。
 */
export function isChapterUnlocked(progress: CampaignProgress, chapter: number): boolean {
  const chapters = campaignChapters();
  const at = chapters.findIndex((c) => c.chapter === chapter);
  if (at < 0) return false;
  if (at === 0) return true; // 先頭の章（添字 0）は最初から開いている
  const prev = chapters[at - 1]!;
  for (const m of missionsOfChapter(prev.chapter)) {
    if (progress.cleared.includes(m.id)) return true;
  }
  return false;
}

/** その章の状態。全話クリアなら `cleared`、開いていれば `current`。 */
export function chapterState(progress: CampaignProgress, chapter: number): ChapterState {
  if (!isChapterUnlocked(progress, chapter)) return 'locked';
  const main = mainMissionsOfChapter(chapter);
  if (main.length > 0 && main.every((m) => progress.cleared.includes(m.id))) return 'cleared';
  return 'current';
}

/**
 * ミッション 1 話の状態。
 *
 * 章が開いていれば**その章の第 1 話は必ず遊べる**（`05§5-3` と噛み合わせるため。
 * `isMissionUnlocked` は「到達した記録」だけを見るので、章をまたいだ最初の 1 話は
 * ここで開けてやる必要がある）。
 */
export function missionState(progress: CampaignProgress, mission: Mission): MissionState {
  if (progress.cleared.includes(mission.id)) return 'cleared';
  if (progress.current === mission.id) return 'current';
  if (isMissionUnlocked(progress, mission.id)) return 'open';
  const first = firstMissionOfChapter(mission.chapter);
  if (first !== null && first.id === mission.id && isChapterUnlocked(progress, mission.chapter)) {
    return 'open';
  }
  return 'locked';
}

/** 章のメダルに出す情報（未開放の章は含めない）。 */
export function chapterViews(progress: CampaignProgress): ChapterView[] {
  const out: ChapterView[] = [];
  for (const info of campaignChapters()) {
    const state = chapterState(progress, info.chapter);
    if (state === 'locked') continue; // **未解放の章は並べない**
    const main = mainMissionsOfChapter(info.chapter);
    out.push({
      info,
      state,
      decoded: main.filter((m) => progress.cleared.includes(m.id)).length,
      total: main.length,
    });
  }
  return out;
}

/** 並べなかった（まだ開いていない）章の数。 */
export function hiddenChapterCount(progress: CampaignProgress): number {
  return campaignChapters().filter((c) => chapterState(progress, c.chapter) === 'locked').length;
}

/** 章の中のミッションプレート（本線の話数昇順）。 */
export function missionViews(progress: CampaignProgress, chapter: number): MissionView[] {
  const out: MissionView[] = [];
  const vassals = missionsOfChapter(chapter).filter((m) => m.route === 'vassal');
  for (const mission of mainMissionsOfChapter(chapter)) {
    const vassal = vassals.find((v) => v.index === mission.index) ?? null;
    // 服属ルートに「到達した」時点で二股を描く（`isMissionUnlocked` は
    // 現在地・クリア済み・履歴のいずれかに出てくれば true。負けて分岐した直後も含む）。
    const branched = vassal !== null && isMissionUnlocked(progress, vassal.id);
    out.push({ mission, state: missionState(progress, mission), branched, vassal });
  }
  return out;
}

/** 「はじめる」で遊ぶミッション（現在地が同じ章ならそれ、無ければ選んだ話）。 */
export function playableId(progress: CampaignProgress, mission: Mission): string | null {
  const state = missionState(progress, mission);
  if (state === 'locked') return null;
  // 服属ルートに居るなら本線ではなくそちらを遊ぶ（`02` の「立場の悪いルート」）。
  const cur = progress.current === null ? null : missionById(progress.current);
  if (cur !== null && cur.chapter === mission.chapter && cur.index === mission.index) return cur.id;
  return mission.id;
}

// ---------------------------------------------------------------- 文言

/** 時代 ID → 表示名（`config.json` の ages）。 */
export function ageLabel(age: Age): string {
  const list = loadGameData().config['ages'];
  if (Array.isArray(list)) {
    const rec = list[AGE_IDS.indexOf(age)];
    if (rec !== null && typeof rec === 'object' && 'name' in rec) {
      return String((rec as Record<string, unknown>)['name']);
    }
  }
  return age;
}

/** ミッションの状態 → 1 語（プレートのアイコン脇に出す）。 */
export function missionStateLabel(state: MissionState): string {
  switch (state) {
    case 'cleared':
      return 'クリア';
    case 'current':
      return '現在地';
    case 'open':
      return '挑戦できる';
    default:
      return 'まだ開かれていない';
  }
}

/** 章の状態 → 1 語。 */
export function chapterStateLabel(state: ChapterState): string {
  switch (state) {
    case 'cleared':
      return '達成';
    case 'current':
      return '進行中';
    default:
      return 'まだ開かれていない';
  }
}

function resourceName(id: string): string {
  const rec = loadGameData().resources[id];
  if (rec !== null && typeof rec === 'object' && 'name' in rec) {
    return String((rec as Record<string, unknown>)['name']);
  }
  return id;
}

function unitName(id: string | null): string {
  if (id === null) return '兵';
  try {
    return unitDefById(id).name;
  } catch {
    return id;
  }
}

function buildingName(id: string): string {
  try {
    return buildingDefById(id).name;
  } catch {
    return id;
  }
}

function orderName(id: string): string {
  try {
    return orderDefById(id).name;
  } catch {
    return id;
  }
}

/** そのプレイヤーの呼び名（自分か、相手の文明名）。 */
function playerLabel(m: Mission, player: number): string {
  if (player === m.setup.player) return '自軍';
  const civ = m.setup.civs[player];
  if (civ === undefined) return '相手';
  try {
    return civDefById(civ).name;
  } catch {
    return '相手';
  }
}

/** tick → 「○分○秒」（秒への換算率は `config.json` の tickRate から引く）。 */
export function tickText(tick: number): string {
  const rate = tickRate();
  if (rate <= 0) return `${tick} tick`;
  const sec = Math.round(tick / rate);
  const min = Math.floor(sec / SEC_PER_MIN);
  const rest = sec - min * SEC_PER_MIN;
  return min > 0 ? `${min}分${rest}秒` : `${rest}秒`;
}

/** 1 分の秒数（暦の単位。バランス値ではない）。 */
const SEC_PER_MIN = 60;

function tickRate(): number {
  const v = loadGameData().config['tickRate'];
  return typeof v === 'number' && v > 0 ? v : 0;
}

/**
 * 勝利条件 / 敗北条件 1 件を日本語 1 行にする（`05§5-6` の「目標が読める」）。
 *
 * ここに**ミッション ID の分岐は無い**。条件の型に対する switch だけ。
 */
export function conditionText(m: Mission, c: MissionCondition): string {
  switch (c.type) {
    case 'destroyAllTownCenters':
      return `${playerLabel(m, c.target)}の町の中心をすべて落とす`;
    case 'surviveTicks':
      return `${tickText(c.ticks)}保たせる`;
    case 'gatherResource':
      return `${playerLabel(m, c.player)}が${resourceName(c.resource)}を累計 ${c.amount} 集める`;
    case 'holdFrontsWithOrder':
      return `${orderName(c.order)}の戦域を ${c.count} 本、${tickText(c.ticks)}保つ`;
    case 'unitCountAtLeast':
      return `${playerLabel(m, c.player)}の${unitName(c.unit)}を ${c.count} 体以上にする`;
    case 'unitCountAtMost':
      return `${playerLabel(m, c.player)}の${unitName(c.unit)}を ${c.count} 体以下にする`;
    case 'buildingCountAtLeast':
      return `${playerLabel(m, c.player)}の${buildingName(c.building)}を ${c.count} 棟以上にする`;
    case 'buildingCountAtMost':
      return `${playerLabel(m, c.player)}の${buildingName(c.building)}を ${c.count} 棟以下にする`;
    case 'loyaltyAtMostPercent':
      return `${playerLabel(m, c.player)}の忠誠度が ${c.percent}% 以下になる`;
    default:
      return '';
  }
}

/** ミッションの見出し（「第二章 第 3 話「河口の関」」）。 */
export function missionHeading(mission: Mission): string {
  const info = campaignChapters().find((c) => c.chapter === mission.chapter);
  const chapterTitle = info === undefined ? `第 ${mission.chapter} 章` : info.title;
  const route = mission.route === 'vassal' ? '（服属ルート）' : '';
  return `${chapterTitle} 第 ${mission.index} 話「${mission.title}」${route}`;
}

/**
 * 服属ルートの履歴 1 件を 1 行にする（`05§5-1`「分岐した側のルートも記録として残る」/
 * `02`「この世界に滅亡はない」）。
 */
export function vassalRecordText(r: CampaignRecord): string {
  const m = missionById(r.mission);
  const where = m === null ? r.mission : missionHeading(m);
  const what = r.outcome === 'victory' ? '旗を戻して本線に復帰した' : '旗を巻いたまま次の年へ進んだ';
  return `${where} ― ${what}（${tickText(r.tick)}）`;
}

/** 服属の記録（新しいものが先。無ければ空配列）。 */
export function vassalLines(progress: CampaignProgress): string[] {
  const rows = vassalRecords(progress);
  const out: string[] = [];
  for (let i = rows.length - 1; i >= 0; i--) out.push(vassalRecordText(rows[i]!));
  return out;
}

/** ヘッダに出す 1 行（今どこに居るか）。 */
export function progressSummary(progress: CampaignProgress): string {
  const cur = progress.current === null ? null : missionById(progress.current);
  const vassal = vassalRecords(progress).length;
  const tail = vassal > 0 ? ` / 服属の記録 ${vassal} 件` : '';
  if (cur === null) {
    return `全 ${campaignChapters().length} 章。まだ始めていません${tail}`;
  }
  return `次は ${missionHeading(cur)}${tail}`;
}

// ---------------------------------------------------------------------------
// 画面
// ---------------------------------------------------------------------------

/** `params.chapter` の読み取り（無ければ現在地の章）。 */
function initialChapter(progress: CampaignProgress, params: ScreenParams): number {
  const raw = params['chapter'];
  if (typeof raw === 'number' && Number.isInteger(raw) && isChapterUnlocked(progress, raw)) {
    return raw;
  }
  const cur = progress.current === null ? null : missionById(progress.current);
  if (cur !== null && isChapterUnlocked(progress, cur.chapter)) return cur.chapter;
  const views = chapterViews(progress);
  const last = views[views.length - 1];
  return last === undefined ? campaignChapters()[0]!.chapter : last.info.chapter;
}

/** キャンペーン章選択画面。`{ chapter?: number }` を受ける。 */
export const campaignScreen: Screen = {
  mount(root: HTMLElement, nav: ScreenNav, params: ScreenParams): void {
    let progress = loadProgress();
    let chapter = initialChapter(progress, params);
    let picked: Mission | null = null;

    const scr = el('div', 'mt-scr mt-scr-cmp');

    // ---- ヘッダ（規約: 最小限。見出し 1 行 + 状況 1 行）----
    const head = el('header', 'mt-scr-head');
    head.appendChild(el('h1', 'mt-scr-title', 'キャンペーン'));
    const sub = el('p', 'mt-scr-sub', progressSummary(progress));
    head.appendChild(sub);
    scr.appendChild(head);

    const body = el('div', 'mt-scr-body mt-cmp-body');
    scr.appendChild(body);

    /** 左: 章のメダルと 5 枚のプレート。 */
    const left = el('div', 'mt-cmp-left');
    body.appendChild(left);
    /** 右: 選んだ話の説明（brief / 目標 / ヒント / 記録）。 */
    const right = el('div', 'mt-cmp-right');
    body.appendChild(right);

    // ---- 下端の操作（`05§5-7` 出撃）----
    const foot = el('footer', 'mt-scr-foot');
    foot.appendChild(button('mt-btn', 'タイトルへ', () => nav.go('title')));
    const start = button('mt-btn mt-btn-primary mt-cmp-seal', 'はじめる', () => {
      if (picked === null) return;
      const id = playableId(progress, picked);
      if (id === null) return;
      // **試合の組み立てはこの画面の責務ではない**（`main.ts` が `missionId` を受ける）。
      nav.go('match', { missionId: id });
    });
    foot.appendChild(start);

    // ---- セーブの消去（消す前に確認を取る）----
    const wipe = el('div', 'mt-cmp-wipe');
    const askWipe = button('mt-btn mt-cmp-wipe-ask', '記録を消す', () => {
      wipe.classList.add('is-asking');
    });
    const doWipe = button('mt-btn mt-cmp-wipe-yes', '消して最初から', () => {
      clearProgress();
      progress = loadProgress();
      chapter = campaignChapters()[0]!.chapter;
      picked = null;
      wipe.classList.remove('is-asking');
      render();
    });
    const noWipe = button('mt-btn', 'やめる', () => {
      wipe.classList.remove('is-asking');
    });
    const warn = el('span', 'mt-cmp-wipe-warn', '進行と分岐履歴が消えます。戻せません。');
    wipe.appendChild(askWipe);
    wipe.appendChild(warn);
    wipe.appendChild(doWipe);
    wipe.appendChild(noWipe);
    foot.appendChild(wipe);
    scr.appendChild(foot);

    /** 章とプレートを描き直す。 */
    function render(): void {
      sub.textContent = progressSummary(progress);
      left.textContent = '';
      right.textContent = '';

      // ---- 1,2,5 章のメダル（時代順）----
      const medals = el('div', 'mt-cmp-medals');
      for (const v of chapterViews(progress)) {
        const cell = button(`mt-cmp-medal is-${v.state}`, '', () => {
          chapter = v.info.chapter;
          picked = null;
          render();
        });
        cell.textContent = '';
        cell.classList.toggle('is-selected', v.info.chapter === chapter);
        cell.setAttribute('aria-pressed', v.info.chapter === chapter ? 'true' : 'false');
        cell.appendChild(el('span', 'mt-cmp-medal-title', v.info.title));
        cell.appendChild(
          el('span', 'mt-cmp-medal-age', `${ageLabel(v.info.age)} / ${chapterStateLabel(v.state)}`),
        );
        // 5 碑の解読（章が進むごとに読めた段が増える）。棒ではなく段の粒で出す。
        const stone = el('span', 'mt-cmp-stone');
        stone.title = `碑の解読 ${v.decoded} / ${v.total}`;
        for (let i = 0; i < v.total; i++) {
          stone.appendChild(el('i', i < v.decoded ? 'mt-cmp-stone-on' : 'mt-cmp-stone-off'));
        }
        cell.appendChild(stone);
        medals.appendChild(cell);
      }
      left.appendChild(medals);

      const hidden = hiddenChapterCount(progress);
      if (hidden > 0) {
        left.appendChild(
          el(
            'p',
            'mt-cmp-hidden',
            `この先 ${hidden} 章は、いまの章の話を 1 つクリアすると開きます。`,
          ),
        );
      }

      const info = campaignChapters().find((c) => c.chapter === chapter);
      if (info !== undefined) {
        left.appendChild(el('p', 'mt-cmp-sub', info.subtitle));
      }

      // ---- 4,6 進路（点線）とミッションプレート ----
      const road = el('div', 'mt-cmp-road');
      for (const v of missionViews(progress, chapter)) {
        const lane = el('div', 'mt-cmp-lane');
        const plate = button(`mt-cmp-plate is-${v.state}`, '', () => {
          picked = v.mission;
          render();
        });
        plate.textContent = '';
        plate.disabled = v.state === 'locked';
        plate.classList.toggle('is-picked', picked !== null && picked.index === v.mission.index);
        plate.appendChild(el('span', 'mt-cmp-plate-no', `第 ${v.mission.index} 話`));
        plate.appendChild(el('span', 'mt-cmp-plate-title', v.mission.title));
        plate.appendChild(el('span', 'mt-cmp-plate-state', missionStateLabel(v.state)));
        lane.appendChild(plate);
        // 分岐に入った話は二股の点線を描く（`05§5-4`）。
        if (v.branched && v.vassal !== null) {
          const br = el('span', 'mt-cmp-branch');
          br.appendChild(el('i', 'mt-cmp-branch-line'));
          br.appendChild(el('span', 'mt-cmp-branch-text', `服属ルート「${v.vassal.title}」を通った`));
          lane.appendChild(br);
        }
        road.appendChild(lane);
      }
      left.appendChild(road);

      // ---- 服属の記録（`05§5-1`）----
      const lines = vassalLines(progress);
      const rec = el('section', 'mt-cmp-records');
      rec.appendChild(el('h2', 'mt-scr-h', '服属の記録'));
      if (lines.length === 0) {
        rec.appendChild(
          el(
            'p',
            'mt-cmp-records-empty',
            'まだ旗を巻いたことはありません。負けても滅びはしません ― 服属した立場から続きます。',
          ),
        );
      } else {
        const ul = el('ul', 'mt-cmp-records-list');
        for (const line of lines) ul.appendChild(el('li', 'mt-cmp-records-item', line));
        rec.appendChild(ul);
      }
      left.appendChild(rec);

      // ---- 右: 選んだ話の説明 ----
      right.appendChild(buildDetail(progress, picked));
      start.disabled = picked === null || playableId(progress, picked) === null;
      start.classList.toggle('is-off', start.disabled);
    }

    render();
    root.appendChild(scr);
  },
};

/** 右側（brief / 目標 / 敗北条件 / ヒント / 直近の記録）。 */
function buildDetail(progress: CampaignProgress, picked: Mission | null): HTMLElement {
  const wrap = el('div', 'mt-cmp-detail');
  if (picked === null) {
    wrap.appendChild(
      el('p', 'mt-cmp-detail-empty', '左の 5 枚から話を選ぶと、状況と目標が読めます。'),
    );
    return wrap;
  }
  // 服属ルートに居るならそちらの文面を読ませる（立場が違うと状況説明も変わる）。
  const id = playableId(progress, picked);
  const m = id === null ? picked : (missionById(id) ?? picked);

  const title = el('div', 'mt-cmp-detail-head');
  const civ = m.setup.civs[m.setup.player];
  if (civ !== undefined) title.appendChild(emblemEl(civ));
  const names = el('div', 'mt-cmp-detail-names');
  names.appendChild(el('h2', 'mt-cmp-detail-title', m.title));
  names.appendChild(el('p', 'mt-cmp-detail-where', missionHeading(m)));
  names.appendChild(
    el('p', 'mt-cmp-detail-age', `開始時代: ${ageLabel(m.setup.startAge)} / 地形: ${mapLabel(m.setup.map)}`),
  );
  title.appendChild(names);
  wrap.appendChild(title);

  wrap.appendChild(el('p', 'mt-cmp-brief', m.brief));

  wrap.appendChild(list('目標（すべて満たす）', m.victory.map((c) => conditionText(m, c))));
  if (m.defeat.length > 0) {
    wrap.appendChild(list('負ける条件（どれか 1 つ）', m.defeat.map((c) => conditionText(m, c))));
  }
  wrap.appendChild(list('心得', [...m.hints]));

  // 直近の記録（勝った / 負けた）。
  const last = lastOf(progress, m.id);
  const foot = el('p', 'mt-cmp-detail-last');
  foot.textContent =
    last === null
      ? 'この話の記録はまだありません。'
      : `直近: ${last.outcome === 'victory' ? '勝った' : '旗を巻いた'}（${tickText(last.tick)}）`;
  wrap.appendChild(foot);

  // 負けたときの行き先を先に見せる（`02`「この世界に滅亡はない」を画面でも伝える）。
  const onDefeat = m.onDefeat === null ? null : missionById(m.onDefeat);
  if (onDefeat !== null) {
    wrap.appendChild(
      el(
        'p',
        'mt-cmp-detail-branch',
        `負けても終わりません。旗を巻いたまま「${onDefeat.title}」へ進みます。`,
      ),
    );
  }
  return wrap;
}

/** そのミッションの最後の記録（`lastRecordOf` を使わずに済む場面が無いので薄く包む）。 */
function lastOf(progress: CampaignProgress, missionId: string): CampaignRecord | null {
  for (let i = progress.history.length - 1; i >= 0; i--) {
    const r = progress.history[i]!;
    if (r.mission === missionId) return r;
  }
  return null;
}

/** マップ型の表示名（`maps.json`）。 */
export function mapLabel(mapType: string): string {
  const rec = loadGameData().maps[mapType];
  if (rec !== null && typeof rec === 'object' && 'name' in rec) {
    return String((rec as Record<string, unknown>)['name']);
  }
  return mapType;
}

/** 見出し + 箇条書き。 */
function list(heading: string, rows: readonly string[]): HTMLElement {
  const box = el('section', 'mt-cmp-list');
  box.appendChild(el('h3', 'mt-scr-h', heading));
  const ul = el('ul', 'mt-cmp-list-ul');
  for (const row of rows) ul.appendChild(el('li', 'mt-cmp-list-li', row));
  box.appendChild(ul);
  return box;
}
