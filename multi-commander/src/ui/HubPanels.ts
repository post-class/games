import { rankFor } from '../app/medals';
import { medalById } from '../app/medals';
import {
  availablePilots,
  defOf,
  fallen,
  killBoard,
  relationStage,
  rosterForDisplay,
  type PilotState,
  type RosterState,
} from '../app/roster';
import { barLine, rumor, type BarMood } from '../content/pilotDialogue';
import { factionLabel } from '../content/factions';
import { peopleOfFaction, VEIL_PEOPLE, type VeilPerson } from '../content/veil/people';
import { protagonistDisplayName } from './PilotSelectScene';
import { VEIL_FACTIONS, VEIL_THEATERS } from '../content/veil/world';
import { VEIL_CHAPTERS } from '../content/veil/chapters';
import { PERSONALITIES, PILOTS, type PortraitSpec } from '../content/pilots';
import { PLAYABLE_SHIPS, SHIPS, shipDef } from '../content/ships';
import { gunDef, missileDef } from '../content/weapons';
import { aceDef, type AceState } from '../content/aces';
import { frontlineSystemName, type FrontlineState } from '../content/frontline';
import type { SupplyState } from '../app/supplies';
import type { CampaignStatistics } from '../app/statistics';
import type { LastSortieCondition } from '../app/save';
import { artImg, artUrl, medalArt, rankArt } from './art';
import { portraitFace } from './Portrait';
import { escapeHtml } from './ScreenHost';

/**
 * 母艦ハブの各部屋の中身を組み立てる。
 *
 * ここは「ミッションと次のミッションの間」を作る部分。
 * 数値を並べるだけでなく、誰が生きていて誰が欠けたかが目に入るようにする。
 */

/**
 * 酒場の往復会話の表示データ。
 *
 * 実体は `src/app/barTalk.ts`（会話の進行を持つ側）が作る。
 * ここで同じ形を宣言しているのは、描画側（このファイル）が app 層の
 * 実装ファイルへ import 依存しないため。TypeScript の構造的部分型で
 * `src/app/barTalk.ts` の `BarTalkView` はそのまま代入できる。
 * **形を変えるときは両方を合わせること。**
 */
export interface BarTalkView {
  pilotId: string;
  turns: Array<{ speaker: 'pilot' | 'player'; text: string }>;
  /** 空配列なら会話終了 */
  replies: Array<{ id: string; label: string }>;
  /** `reason` は直前の出撃で関係に効いたことの1行（あれば出す） */
  relation: { label: string; step: number; max: number; reason?: string };
}

/** 章末選択で動く4状態（0..100）。`src/app/narrative.ts` の同名フィールドの写し。 */
export interface NarrativeGauges {
  /** 帰還者（名簿の人数ではなく指標） */
  returnees: number;
  routeTrust: number;
  commandTrust: number;
  aceOath: number;
}

export interface HubContext {
  roster: RosterState;
  totalKills: number;
  sorties: number;
  cleared: string[];
  medals: string[];
  chapter: number;
  totalChapters: number;
  aceStates?: AceState[];
  frontline?: FrontlineState;
  supplies?: SupplyState;
  statistics?: CampaignStatistics;
  /** 酒場で選択して会話している人物 */
  barPilotId?: string;
  /** 酒場の往復会話。無いときは従来の1行表示にする */
  barTalk?: BarTalkView;
  /** 戦況マップに重ねる4状態。無いときは「記録なし」を出す */
  narrative?: NarrativeGauges;
  lastSortie?: LastSortieCondition;
}

// ───────── ページ送り (艦内パネル共通) ─────────

/*
 * 艦内パネルは「下端で切れる」ことが問題だった（specs/02_改善案の詳細.md ⑩）。
 * CSS 側でパネルを空き高さいっぱいまで広げたうえで、それでも入らない量は
 * ここでページに分ける。`AI_CODING.md`「スクロールバーを廃止するなら
 * 情報が欠落しないように」に従い、**HTML には全件を出したまま**
 * 表示だけを切り替える（`ScreenHost` が `display` を付け外しする）。
 */

/** 絞り込みの選択肢。`value: ''` は「すべて」。 */
export interface PagerFilterOption {
  value: string;
  label: string;
}

export interface PagerFilterDef {
  /** 項目側の `data-f-<key>` と対応する鍵 */
  key: string;
  label: string;
  /** 切り替えキー (`KeyboardEvent.code`) */
  code: string;
  /** 表示するキー名 */
  keyLabel: string;
  /** 先頭は必ず「すべて」(value: '') */
  options: PagerFilterOption[];
}

export interface PagerEntry {
  html: string;
  /** 絞り込み用のタグ。1つの鍵に複数値を持てる（登場章など） */
  tags?: Record<string, string[]>;
}

export interface PagerSpec {
  /** 画面内で一意な id */
  id: string;
  /** 1ページに載せる件数 */
  pageSize: number;
  entries: PagerEntry[];
  filters?: PagerFilterDef[];
  /** 一覧の見出し */
  title?: string;
  /** 見出しの下に置く1行 */
  note?: string;
  /** 項目の並べ方 */
  layout?: 'list' | 'grid';
  /** 絞り込みで0件になったときの文 */
  emptyText?: string;
}

/**
 * ページ送りの操作キー。
 *
 * `settings.ts` の全割り当て（矢印・Q E W S A D T R Y C V F N X G M Z・Tab・
 * Space・Enter・Escape・Backquote・Backspace・[ ]）と、`Tutorial.ts` の `KeyB`、
 * `ScreenHost` の ▲▼/Enter/Esc のどれとも重ならないものを選ぶ。
 * 矢印 ← → は飛行のヨーに割り当て済みなので使わない。
 * ページャがある画面でだけ拾う（`tests/ut/t3a-*.test.ts` が衝突を固定する）。
 */
export const PAGER_KEYS = {
  /** 前のページ（`,` = `<`） */
  prev: 'Comma',
  /** 次のページ（`.` = `>`） */
  next: 'Period',
} as const;

/** 絞り込みの切り替えキー。J / K / L はどの既存操作にも割り当てが無い。 */
export const PAGER_FILTER_CODES = {
  faction: 'KeyJ',
  life: 'KeyK',
  chapter: 'KeyL',
} as const;

/** 項目のタグが絞り込み条件に合うか。値が未指定（''）の鍵は無条件で通す。 */
export function pagerEntryMatches(
  tags: Record<string, string[]> | undefined,
  filter: Record<string, string>,
): boolean {
  for (const [key, want] of Object.entries(filter)) {
    if (!want) continue;
    const has = tags?.[key] ?? [];
    if (!has.includes(want)) return false;
  }
  return true;
}

/** 総ページ数。0件でも1ページ（「該当なし」を出すため）。 */
export function pagerPageCount(visible: number, pageSize: number): number {
  if (pageSize <= 0) return 1;
  return Math.max(1, Math.ceil(visible / pageSize));
}

/** ページ番号（0始まり）を範囲内に収める。 */
export function pagerClampPage(page: number, pages: number): number {
  if (!Number.isFinite(page)) return 0;
  return Math.min(Math.max(0, Math.floor(page)), Math.max(0, pages - 1));
}

/** そのページに載る「絞り込み後の並び」の添字範囲。 */
export function pagerSlice<T>(visible: readonly T[], pageSize: number, page: number): T[] {
  const pages = pagerPageCount(visible.length, pageSize);
  const p = pagerClampPage(page, pages);
  return visible.slice(p * pageSize, p * pageSize + pageSize);
}

/** 状態表示。総数と件数を必ず出して「切り捨てていない」ことを示す。 */
export function pagerStatus(page: number, pages: number, shown: number, total: number): string {
  const range = shown === total ? `${total} 件` : `${shown} / ${total} 件`;
  return `${page + 1} / ${pages} ページ　${range}`;
}

/** 絞り込み結果（純粋関数。テストから直接呼ぶ） */
export function pagerVisible(entries: readonly PagerEntry[], filter: Record<string, string>): PagerEntry[] {
  return entries.filter((e) => pagerEntryMatches(e.tags, filter));
}

function tagAttr(tags: Record<string, string[]> | undefined): string {
  if (!tags) return '';
  return Object.entries(tags)
    .map(([k, v]) => ` data-f-${k}="${escapeHtml(v.join(' '))}"`)
    .join('');
}

/**
 * ページ送り付きの一覧を組む。
 *
 * 全件を HTML に出し、`ScreenHost` 側が `data-mc-pager` を見て表示を絞る。
 * JS が動かない場合でも全件が DOM に残るので、情報は欠落しない。
 */
export function pagerHtml(spec: PagerSpec): string {
  const total = spec.entries.length;
  const pages = pagerPageCount(total, spec.pageSize);
  const filters = spec.filters ?? [];
  const filterHtml = filters.length
    ? `<div class="mc-pager-filters">` +
      filters
        .map(
          (f) =>
            `<span class="mc-pager-filter" data-mc-pager-filter="${escapeHtml(f.key)}" ` +
            `data-mc-pager-code="${escapeHtml(f.code)}" ` +
            `data-mc-pager-options="${escapeHtml(JSON.stringify(f.options))}" ` +
            `title="${escapeHtml(f.keyLabel)} キーで切り替え">` +
            `<b>${escapeHtml(f.label)}</b><kbd>${escapeHtml(f.keyLabel)}</kbd>` +
            `<em data-mc-pager-filter-value>${escapeHtml(f.options[0]?.label ?? 'すべて')}</em></span>`,
        )
        .join('') +
      `</div>`
    : '';
  const keyHint =
    `<div class="mc-pager-keys dim">, / . でページ送り（◀ ▶ のクリックでも同じ）` +
    filters.map((f) => `　/　${escapeHtml(f.keyLabel)} で${escapeHtml(f.label)}を切り替え`).join('') +
    `</div>`;
  return (
    `<div class="block mc-pager" data-mc-pager="${escapeHtml(spec.id)}" ` +
    `data-page-size="${spec.pageSize}" data-total="${total}">` +
    (spec.title ? `<h3>${escapeHtml(spec.title)}</h3>` : '') +
    `<div class="mc-pager-bar">` +
    `<button type="button" class="mc-pager-btn" data-mc-pager-act="prev">◀</button>` +
    `<span class="mc-pager-status" data-mc-pager-status>${escapeHtml(pagerStatus(0, pages, total, total))}</span>` +
    `<button type="button" class="mc-pager-btn" data-mc-pager-act="next">▶</button>` +
    `</div>` +
    filterHtml +
    (spec.note ? `<div class="dim mc-pager-note">${escapeHtml(spec.note)}</div>` : '') +
    `<div class="mc-pager-items${spec.layout === 'grid' ? ' grid' : ''}">` +
    spec.entries
      .map((e) => `<div class="mc-pager-item"${tagAttr(e.tags)}>${e.html}</div>`)
      .join('') +
    `</div>` +
    `<div class="mc-pager-empty dim" data-mc-pager-empty hidden>${escapeHtml(spec.emptyText ?? '条件に合う項目がない。絞り込みを戻すと全件に戻る。')}</div>` +
    keyHint +
    `</div>`
  );
}

// ───────── 酒場 ─────────

/** 関係値から会話の色を決める */
function moodOf(p: PilotState, hasFallen: boolean): BarMood {
  if (hasFallen && Math.random() < 0.35) return 'mourning';
  if (p.bond > 0.35) return 'friendly';
  if (p.bond < -0.2) return 'cold';
  return 'neutral';
}

/**
 * 往復会話の中身。
 *
 * 話者ごとに行を分けて出す。返事の選択肢そのものは `ScreenHost` のメニュー項目
 * （`src/app/App.ts` が `→ …` で先頭に並べる）なので、ここでは二重に出さず
 * 「どこで選ぶか」だけを1行で示す。
 */
function barTalkBody(view: BarTalkView): string {
  const turns = view.turns
    .map(
      (t) =>
        `<div class="mc-bar-turn ${t.speaker}">` +
        `<span class="mc-bar-turn-who">${t.speaker === 'player' ? '自分' : '相手'}</span>` +
        `<span>${escapeHtml(t.text)}</span></div>`,
    )
    .join('');
  const reason = view.relation.reason
    ? `<div class="dim mc-bar-reason">${escapeHtml(view.relation.reason)}</div>`
    : '';
  const cue = view.replies.length
    ? `<div class="dim mc-bar-replies">返事は下の「→」の項目から選ぶ（${view.replies.length} 択）。</div>`
    : `<div class="dim mc-bar-replies">この話は終わった。</div>`;
  return `<div class="mc-bar-talk">${turns}${reason}${cue}</div>`;
}

/** 関係の段階をゲージで示す（`relationStage` の 5 段階）。 */
function relationGauge(step: number, max: number): string {
  const filled = Math.max(0, Math.min(max, step));
  return (
    `<span class="mc-bar-relation" aria-hidden="true">` +
    Array.from({ length: max }, (_, i) => `<i${i < filled ? ' class="on"' : ''}></i>`).join('') +
    `</span>`
  );
}

/**
 * パイロットの表示名を名鑑（`codexPersonEntry`）と同じ整形に揃える（T5-⑬）。
 *
 * `pilots.ts` の `name` は人物名簿の値そのままなので `桐谷 綾（キリタニ アヤ）` の
 * 読み括弧が付く。名鑑は `protagonistDisplayName()`（内部で `speakerName()`）を通して
 * 括弧を落としているのに、酒場・自室だけ生の `name` を出していた。
 *
 * **整形はここで再実装しない。** `protagonistDisplayName()` は人物の `id` と `name`
 * だけを見るので、名簿参照用の最小の形だけを渡す。`personId` が無い定義
 * （名簿外のパイロットを差し込まれた場合）は従来表記へフォールバックする。
 * コールサイン（`Sable` など）は別に出しているので、ここでは触らない。
 */
export function pilotDisplayName(def: { personId?: string; name: string }): string {
  if (!def.personId) return def.name;
  return protagonistDisplayName({ id: def.personId, name: def.name } as VeilPerson);
}

export function recRoomHtml(ctx: HubContext): string {
  const alive = ctx.roster.pilots.filter((p) => p.status === 'active' || p.status === 'wounded');
  const dead = fallen(ctx.roster);
  const fallenName = dead.length ? defOf(dead[dead.length - 1]).callsign : undefined;

  // 会話中の相手を先頭に置く（ページ送りしなくても開いた会話が見える）
  const ordered = ctx.barTalk?.pilotId
    ? [...alive].sort((a, b) => Number(b.id === ctx.barTalk!.pilotId) - Number(a.id === ctx.barTalk!.pilotId))
    : alive;

  const talkEntries: PagerEntry[] = ordered.map((p) => {
    const def = defOf(p);
    const mood = moodOf(p, !!fallenName);
    const line = barLine(def.personality, mood, fallenName);
    const status =
      p.status === 'wounded' ? `<span class="ng">負傷 (あと${p.benchedFor}回欠場)</span>` : '';
    const talking = ctx.barTalk?.pilotId === p.id ? ctx.barTalk : undefined;
    // 往復会話があるときはその中身を出し、無いときは従来の1行に落とす
    const body = talking
      ? barTalkBody(talking)
      : `<div>${escapeHtml(line)}</div>`;
    // 関係値は `relationStage` の5段階（旧3値表示だと常に「——」に見えた）
    const stage = talking?.relation ?? relationStage(p);
    const relation = `関係 ${escapeHtml(stage.label)} ${relationGauge(stage.step, stage.max)}`;
    return {
      html:
        `<div class="mc-bar-row${ctx.barPilotId === p.id ? ' selected' : ''}">` +
        `<div class="mc-bar-face">${portraitFace(def.id, def.portrait, { size: 72, expression: mood === 'friendly' ? 'grin' : mood === 'cold' ? 'grim' : 'talk' })}</div>` +
        `<div class="mc-bar-text">` +
        `<div class="mc-bar-name">${escapeHtml(def.callsign)} <span class="dim">${escapeHtml(pilotDisplayName(def))}・${PERSONALITIES[def.personality].label}・${relation}</span> ${status}</div>` +
        body +
        `</div></div>`,
      tags: { life: [p.status === 'wounded' ? 'wounded' : 'active'] },
    };
  });

  return (
    `<div class="block"><h3>酒場 / レクリエーション室</h3>` +
    `<div class="mc-board-head">` +
    artImg(artUrl('icon-bar'), { height: 64, alt: '' }) +
    `<span class="dim">出撃と出撃の合間。誰が何を考えているかは、ここでしか分からない。</span></div></div>` +
    (ctx.barPilotId && alive.some((p) => p.id === ctx.barPilotId)
      ? `<div class="block"><h3>会話中</h3><div class="dim">${escapeHtml(defOf(alive.find((p) => p.id === ctx.barPilotId)! ).callsign)} の話を聞いた。関係値は次の出撃へ持ち越される。</div></div>`
      : '') +
    pagerHtml({
      id: 'bar-talks',
      title: `隊員 — ${talkEntries.length} 名`,
      pageSize: 2,
      layout: 'list',
      entries: talkEntries,
      filters: [
        {
          key: 'life',
          label: '状態',
          code: PAGER_FILTER_CODES.life,
          keyLabel: 'K',
          options: [
            { value: '', label: 'すべて' },
            { value: 'active', label: '出撃可' },
            { value: 'wounded', label: '負傷' },
          ],
        },
      ],
      emptyText: '条件に合う隊員がいない。',
    }) +
    `<div class="block"><h3>噂</h3><div>${escapeHtml(rumor())}</div>` +
    `<div>${escapeHtml(rumor())}</div></div>` +
    ((ctx.aceStates ?? []).some((a) => a.escaped > 0 && a.status !== 'killed')
      ? `<div class="block"><h3>宿敵の噂</h3>${(ctx.aceStates ?? []).filter((a) => a.escaped > 0 && a.status !== 'killed').map((a) => {
          const ace = aceDef(a.id);
          return ace ? `<div class="ng">${escapeHtml(ace.callsign)} がまた現れた。${a.lastVictim ? `${escapeHtml(a.lastVictim)} の名を口にしている。` : ''}</div>` : '';
        }).join('')}</div>`
      : '') +
    (dead.length
      ? `<div class="block"><h3>空いた席</h3>` +
        dead
          .map(
            (p) =>
              `<div class="ng">${escapeHtml(defOf(p).callsign)} — ${escapeHtml(pilotDisplayName(defOf(p)))}` +
              `${p.diedIn ? `　（${escapeHtml(p.diedIn)}）` : ''}</div>`,
          )
          .join('') +
        `</div>`
      : '')
  );
}

// ───────── バラック (名簿・戦績) ─────────

export function barracksHtml(ctx: HubContext): string {
  const rank = rankFor(ctx.sorties, ctx.totalKills);
  const owned = ctx.medals
    .map((id) => medalById(id))
    .filter((m): m is NonNullable<typeof m> => !!m);

  const rosterEntries: PagerEntry[] = rosterForDisplay(ctx.roster)
    .map((p) => {
      const def = defOf(p);
      const st =
        p.status === 'dead'
          ? '<span class="ng">戦死</span>'
          : p.status === 'transferred'
            ? '<span class="dim">転属</span>'
          : p.status === 'wounded'
            ? `<span class="ng">負傷 (${p.benchedFor})</span>`
            : '<span class="ok">出撃可</span>';
      return {
        html:
          `<div class="mc-roster-row${p.status === 'dead' ? ' dead' : p.status === 'transferred' ? ' transferred' : ''}">` +
          `<div>${portraitFace(def.id, def.portrait, { size: 52, dead: p.status === 'dead' })}</div>` +
          `<div class="mc-roster-main">` +
          `<div><b>${escapeHtml(def.callsign)}</b> <span class="dim">${escapeHtml(pilotDisplayName(def))}</span></div>` +
          `<div class="dim">${PERSONALITIES[def.personality].label}　技量 ${(p.skill * 100) | 0}%　撃墜 ${p.kills}　出撃 ${p.sorties}　昇進 ${p.rank}` +
          `${p.transferredIn ? '　<span class="ok">転属</span>' : ''}</div>` +
          (p.status === 'dead' && p.diedIn
            ? `<div class="ng">${escapeHtml(p.diedIn)} で戦死</div>`
            : `<div class="dim">${escapeHtml(def.bio)}</div>`) +
          `</div><div>${st}</div></div>`,
        tags: { life: [p.status === 'dead' ? 'dead' : p.status === 'transferred' ? 'transferred' : 'alive'] },
      };
    });

  return (
    `<div class="block"><h3>自室 / 戦績</h3>` +
    `<div class="mc-rank-line">` +
    artImg(rankArt(rank.id), { className: 'mc-rank-pin', height: 34, alt: rank.label }) +
    `<span>階級 <b>${escapeHtml(rank.label)}</b>　通算撃墜 <b>${ctx.totalKills}</b>　出撃 <b>${ctx.sorties}</b> 回　` +
    `達成 ${ctx.cleared.length} 任務　第 ${ctx.chapter} 章 / ${ctx.totalChapters}</span></div></div>` +
    `<div class="block"><h3>勲章</h3>` +
    (owned.length
      ? `<div class="mc-medal-rack">` +
        owned
          .map(
            (m) =>
              `<div class="mc-medal-slot" title="${escapeHtml(m.label)} — ${escapeHtml(m.reason)}">` +
              artImg(medalArt(m.id), { height: 104, alt: m.label }) +
              `<span>${escapeHtml(m.label)}</span></div>`,
          )
          .join('') +
        `</div>`
      : '<div class="dim">まだ無い</div>') +
    `</div>` +
    pagerHtml({
      id: 'barracks-roster',
      title: `飛行隊名簿 — ${rosterEntries.length} 名`,
      pageSize: 4,
      layout: 'list',
      entries: rosterEntries,
      filters: [
        {
          key: 'life',
          label: '生死',
          code: PAGER_FILTER_CODES.life,
          keyLabel: 'K',
          options: [
            { value: '', label: 'すべて' },
            { value: 'alive', label: '在籍' },
            { value: 'dead', label: '戦死' },
            { value: 'transferred', label: '転属' },
          ],
        },
      ],
      emptyText: '条件に合う隊員がいない。',
    })
  );
}

// ───────── キルボード ─────────

export function killBoardHtml(ctx: HubContext): string {
  const rows = killBoard(ctx.roster, ctx.totalKills);
  const max = Math.max(1, rows[0]?.kills ?? 1);
  const aceRows = (ctx.aceStates ?? [])
    .map((state) => {
      const ace = aceDef(state.id);
      if (!ace) return '';
      const status = state.status === 'killed' ? '<span class="ok">撃墜</span>' : `<span class="ng">交戦中 / 離脱 ${state.escaped}</span>`;
      return `<div class="mc-kb-row ${state.status === 'killed' ? 'me' : ''}"><span class="mc-kb-rank">★</span>` +
        `<span class="mc-kb-name">${escapeHtml(ace.callsign)}　${status}</span>` +
        `<span class="mc-kb-bar"><span style="width:${Math.min(100, state.skill * 100).toFixed(1)}%"></span></span>` +
        `<span class="mc-kb-kills">${state.kills}</span></div>`;
    })
    .join('');
  return (
    `<div class="block"><h3>キルボード</h3>` +
    `<div class="mc-board-head">` +
    artImg(artUrl('patch-squadron'), { height: 64, alt: '' }) +
    `<span class="dim">飛行甲板の壁に貼られている板。順位は毎日書き換えられる。</span></div></div>` +
    pagerHtml({
      id: 'kill-board',
      title: `順位 — ${rows.length} 名`,
      pageSize: 10,
      layout: 'list',
      entries: rows.map((r, i) => {
        const w = (r.kills / max) * 100;
        const cls = r.isPlayer ? 'me' : r.status === 'dead' ? 'dead' : '';
        return {
          html:
            `<div class="mc-kb-row ${cls}">` +
            `<span class="mc-kb-rank">${i + 1}</span>` +
            `<span class="mc-kb-name">${escapeHtml(r.name)}${r.status === 'dead' ? ' †' : ''}</span>` +
            `<span class="mc-kb-bar"><span style="width:${w.toFixed(1)}%"></span></span>` +
            `<span class="mc-kb-kills">${r.kills}</span>` +
            `</div>`,
          tags: { life: [r.status === 'dead' ? 'dead' : 'alive'] },
        };
      }),
      filters: [
        {
          key: 'life',
          label: '生死',
          code: PAGER_FILTER_CODES.life,
          keyLabel: 'K',
          options: [
            { value: '', label: 'すべて' },
            { value: 'alive', label: '生存' },
            { value: 'dead', label: '戦死' },
          ],
        },
      ],
      emptyText: '条件に合う記録がない。',
    }) +
    `<div class="block"><h3>宿敵の記録</h3>${aceRows || '<span class="dim">まだ遭遇していない。</span>'}</div>`
  );
}

// ───────── 格納庫 (機体と僚機の選択) ─────────

export interface HangarSelection {
  shipId: string;
  gunId?: string;
  missiles?: Array<{ missileId: string; count: number }>;
  wingmanId?: string;
  wingmanSlot?: number;
}

export function hangarHtml(
  ctx: HubContext,
  sel: HangarSelection,
  missionShipId: string,
): string {
  const def = shipDef(sel.shipId);
  const missiles = (sel.missiles ?? def.missiles)
    .map((m) => `${missileDef(m.missileId).name} ×${m.count}`)
    .join(' / ');
  const wing = sel.wingmanId
    ? ctx.roster.pilots.find((p) => p.id === sel.wingmanId)
    : undefined;
  const avail = availablePilots(ctx.roster);
  const supplies = ctx.supplies;
  const supplyLine = supplies
    ? `<div class="dim">補給: フレア ${supplies.flares}　予備部品 ${supplies.spareParts}　` +
      `ミサイル ${Object.entries(supplies.missiles).map(([id, n]) => `${escapeHtml(missileDef(id).shortName)} ${n}`).join(' / ')}</div>`
    : '';
  const lastSortie = ctx.lastSortie
    ? `<div class="mc-hangar-last-sortie"><b>前回帰艦記録</b>　機体 ${escapeHtml(shipDef(ctx.lastSortie.shipId).name)} ` +
      `船体 ${Math.round(ctx.lastSortie.hullRatio * 100)}%　フレア ${ctx.lastSortie.flares}　` +
      `${ctx.lastSortie.escortLost ? '<span class="ng">護衛対象喪失</span>' : '<span class="ok">護衛維持</span>'}</div>`
    : '';

  const shipDefs = PLAYABLE_SHIPS.map((id) => shipDef(id));
  const maxSpeed = Math.max(...shipDefs.map((s) => s.maxSpeed));
  const maxTurn = Math.max(...shipDefs.map((s) => s.turn[0]));
  const maxArmor = Math.max(...shipDefs.map((s) => Object.values(s.armor).reduce((a, n) => a + n, 0)));
  const maxHull = Math.max(...shipDefs.map((s) => s.hull));
  const maxOrdnance = Math.max(...shipDefs.map((s) => s.missiles.reduce((a, m) => a + m.count, 0)));
  const metric = (label: string, value: number, max: number, text: string): string =>
    `<div class="mc-hangar-metric"><span>${label}</span><i><b style="width:${Math.max(8, (value / Math.max(1, max)) * 100).toFixed(1)}%"></b></i><em>${text}</em></div>`;
  const shipCards = shipDefs
    .map((s) => {
      const active = s.id === sel.shipId;
      const armor = Object.values(s.armor).reduce((a, n) => a + n, 0);
      const ordnance = s.missiles.reduce((a, m) => a + m.count, 0);
      return (
        `<article class="mc-hangar-ship${active ? ' active' : ''}" data-ship-id="${s.id}">` +
        `<div class="mc-hangar-ship-head"><span class="mc-hangar-code">${s.id.toUpperCase()}</span>` +
        `<strong>${escapeHtml(s.name)}</strong>${active ? '<b class="mc-hangar-selected">SELECTED</b>' : ''}</div>` +
        blueprintSvg(s) +
        `<div class="mc-hangar-role">${roleLabel(s.role)}　${s.id === missionShipId ? '<span>任務指定</span>' : ''}</div>` +
        `<div class="mc-hangar-metrics">` +
        metric('SPD', s.maxSpeed, maxSpeed, `${s.maxSpeed}`) +
        metric('TURN', s.turn[0], maxTurn, s.turn[0].toFixed(2)) +
        metric('ARM', armor, maxArmor, `${armor}`) +
        metric('HULL', s.hull, maxHull, `${s.hull}`) +
        metric('GUN', s.guns.length, 4, `${s.guns.length}`) +
        metric('ORD', ordnance, maxOrdnance, `${ordnance}`) +
        `</div>` +
        // 機体の性格の一言（`src/content/ships.ts` の `character`）。未設定の機体では何も出さない。
        shipCharacterHtml(s) +
        `</article>`
      );
    })
    .join('');
  const gunNames = sel.gunId
    ? gunDef(sel.gunId).name
    : [...new Set(def.guns.map((g) => gunDef(g.gunId).name))].join(' / ');
  const mission = shipDef(missionShipId);

  return (
    `<div class="mc-hangar-layout">` +
    `<div class="mc-hangar-intro"><div class="mc-board-head">` +
    artImg(artUrl('icon-hangar'), { height: 48, alt: '' }) +
    `<div><h3>格納庫 / 飛行甲板</h3><div class="dim">整備班: 「割り当ては ${escapeHtml(mission.name)}。` +
    `機体を選び、任務に合わせて loadout を決めろ。」</div></div></div></div>` +
    `<div class="mc-hangar-section-title">AIRFRAME COMPARISON <span>同じ基準で性能を比較</span></div>` +
    `<div class="mc-hangar-grid">${shipCards}</div>` +
    `<section class="mc-hangar-loadout"><div class="mc-hangar-loadout-head"><h3>出撃構成 / ${escapeHtml(def.name)}</h3>` +
    `<span class="${sel.shipId === missionShipId ? 'ok' : 'warn'}">${sel.shipId === missionShipId ? 'MISSION FIT' : 'FIELD CHOICE'}</span></div>` +
    `<div class="mc-hangar-loadout-grid"><div>` +
    `<div class="mc-hangar-loadout-row"><span>PRIMARY</span><b>${escapeHtml(gunNames || 'なし')}</b></div>` +
    `<div class="mc-hangar-loadout-row"><span>MISSILES</span><b>${escapeHtml(missiles || 'なし')}</b></div>` +
    `<div class="mc-hangar-loadout-row"><span>FLARES</span><b>${def.flares}</b></div>` +
    `</div><div class="mc-hangar-supply">${supplyLine}</div></div></section>` +
    lastSortie +
    `<div class="block"><h3>僚機</h3>` +
    (wing
      ? `<div class="mc-bar-row"><div>${portraitFace(defOf(wing).id, defOf(wing).portrait, { size: 64 })}</div>` +
        `<div class="mc-bar-text"><div class="mc-bar-name">${escapeHtml(defOf(wing).callsign)} ` +
        `<span class="dim">${sel.wingmanSlot ?? 2}番機・${PERSONALITIES[defOf(wing).personality].label}・技量 ${(wing.skill * 100) | 0}%・撃墜 ${wing.kills}・昇進 ${wing.rank}</span></div>` +
        `<div class="dim">${escapeHtml(defOf(wing).bio)}</div></div></div>`
      : `<div class="ng">出撃可能な僚機がいない。単独で出ることになる。</div>`) +
    `<div class="dim">出撃可能: ${avail.map((p) => escapeHtml(defOf(p).callsign)).join(' / ') || 'なし'}</div>` +
    `</div></div>`
  );
}

/**
 * 機体の性格の一言（`src/content/ships.ts` の `ShipDef.character`）。
 * 任意項目なので、未設定の機体では何も出さない。
 */
function shipCharacterHtml(s: ReturnType<typeof shipDef>): string {
  if (!s.character) return '';
  return `<div class="mc-hangar-character">${escapeHtml(s.character)}</div>`;
}

function roleLabel(role: string): string {
  return role === 'bomber' ? '爆撃 / 重装' : role === 'fighter' ? '制空 / 戦闘機' : role;
}

/* ───── 格納庫のブループリント図（T5-⑬） ─────
 *
 * 着手前は `def.visual.kind` の **3通りの固定パス**しか持っていなかった。
 * 選べる4機の kind は `hornet: arrow` / `scimitar: delta` / `raptor: twin-boom` /
 * `rapier: delta` なので、arrow は `else` の星形、scimitar と rapier は
 * **同じ delta のパス**になり、4機が「ほぼ同じ星形の影」に見えていた。
 *
 * ここでは形をすべて `src/content/ships.ts` の**実数値から導く**。
 * 図の寸法に表示専用の定数を持たせない（`AI_CODING.md`:
 * 「表示だけ変えて実挙動が変わらない状態を作らない」の逆で、**図が実データの写し**）。
 */

const bpClamp01 = (v: number): number => (v <= 0 ? 0 : v >= 1 ? 1 : v);
/** lo..hi を 0..1 へ。範囲外は潰す（艦艇など選べない定義でも図が破綻しない） */
const bpNorm = (v: number, lo: number, hi: number): number =>
  bpClamp01(((Number.isFinite(v) ? v : lo) - lo) / (hi - lo));
const bpLerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/**
 * ブループリント図の寸法。**すべて実数値から導出する**（テストが機械照合する）。
 *
 * | 図の寸法 | 出所（`ShipDef`） | 向き |
 * |---|---|---|
 * | `halfLen` 前後の半長 | `maxSpeed` | 速いほど長い |
 * | `halfWidth` 胴の半幅 | `armor` 合計と `hull` の平均 | 厚いほど太い |
 * | `wingHalf` 翼の張り出し | `turn[0]` | 旋回が速いほど短い |
 * | `scale` 図全体の拡縮 | `radius` | 大きい機体ほど大きい |
 * | `barrels` 砲身の位置 | `guns[].offset[0]` | 砲の数だけ生える |
 * | `pylons` パイロン数 | `missiles.length` | ミサイル種類数 |
 * | `engineR` 噴射口の半径 | `accel` | 加速が強いほど太い |
 */
export interface BlueprintGeometry {
  halfLen: number;
  halfWidth: number;
  wingHalf: number;
  scale: number;
  /** 砲身の x 位置（図の座標系）。要素数は `guns.length` と一致する */
  barrels: number[];
  /** パイロンの対の数。`missiles.length`（＝ミサイル種類数）と一致する */
  pylons: number;
  engineR: number;
}

export function blueprintGeometry(def: ReturnType<typeof shipDef>): BlueprintGeometry {
  const armorTotal = Object.values(def.armor).reduce((a, n) => a + n, 0);
  const bulk = (armorTotal + def.hull) / 2;
  const halfLen = bpLerp(26, 44, bpNorm(def.maxSpeed, 260, 470));
  const halfWidth = bpLerp(4.5, 13, bpNorm(bulk, 80, 320));
  // 旋回が速い機体は翼が短い（`turn[0]` が大きい＝よく曲がる）
  const wingHalf = bpLerp(30, 13, bpNorm(def.turn[0], 1.1, 2.0));
  const scale = bpLerp(0.82, 1.06, bpNorm(def.radius, 14, 26));
  const span = halfWidth + wingHalf;
  const barrels = def.guns.map((g) => {
    const x = g.offset[0] * 2.4;
    return Math.max(-span, Math.min(span, x));
  });
  return {
    halfLen,
    halfWidth,
    wingHalf,
    scale,
    barrels,
    pylons: def.missiles.length,
    engineR: bpLerp(1.6, 3.4, bpNorm(def.accel, 200, 360)),
  };
}

const n1 = (v: number): string => v.toFixed(1);

function blueprintSvg(def: ReturnType<typeof shipDef>): string {
  const hull = `#${def.visual.hull.toString(16).padStart(6, '0')}`;
  const accent = `#${def.visual.accent.toString(16).padStart(6, '0')}`;
  const engine = `#${def.visual.engine.toString(16).padStart(6, '0')}`;
  const g = blueprintGeometry(def);
  const L = g.halfLen;
  const W = g.halfWidth;
  const S = g.wingHalf;

  // 胴体。鼻先は -L、尾は +L*0.9。太さは装甲と船体から
  const body =
    `M 0 ${n1(-L)} ` +
    `C ${n1(W * 0.62)} ${n1(-L * 0.55)}, ${n1(W)} ${n1(-L * 0.1)}, ${n1(W * 0.86)} ${n1(L * 0.72)} ` +
    `L ${n1(W * 0.5)} ${n1(L * 0.9)} L ${n1(-W * 0.5)} ${n1(L * 0.9)} L ${n1(-W * 0.86)} ${n1(L * 0.72)} ` +
    `C ${n1(-W)} ${n1(-L * 0.1)}, ${n1(-W * 0.62)} ${n1(-L * 0.55)}, 0 ${n1(-L)} Z`;
  // 翼（左）。張り出しは旋回率から。右は scale(-1,1) の鏡像
  const wing =
    `M ${n1(-W * 0.85)} ${n1(-L * 0.12)} L ${n1(-(W + S))} ${n1(L * 0.42)} ` +
    `L ${n1(-(W + S) * 0.78)} ${n1(L * 0.62)} L ${n1(-W * 0.8)} ${n1(L * 0.5)} Z`;
  const wings =
    `<path class="mc-bp-wing" d="${wing}" fill="${hull}" stroke="${accent}" stroke-width="1.4"/>` +
    `<g transform="scale(-1 1)"><path class="mc-bp-wing" d="${wing}" fill="${hull}" stroke="${accent}" stroke-width="1.4"/></g>`;
  // 砲身。位置は `guns[].offset[0]` の写しなので、砲の数だけ生える
  const barrels = g.barrels
    .map(
      (x) =>
        `<line class="mc-bp-barrel" x1="${n1(x)}" y1="${n1(-L * 0.45)}" x2="${n1(x)}" y2="${n1(-L * 1.06)}" ` +
        `stroke="${accent}" stroke-width="1.6" stroke-linecap="round"/>`,
    )
    .join('');
  // パイロン。ミサイルの**種類数**だけ、翼の下に対で付く
  const pylons = Array.from({ length: g.pylons }, (_, i) => {
    const x = W + S * (0.3 + 0.2 * i);
    const y = L * 0.22;
    const one = (px: number): string =>
      `<rect x="${n1(px - 1.4)}" y="${n1(y)}" width="2.8" height="8.4" rx="1.2" fill="${accent}"/>`;
    return `<g class="mc-bp-pylon">${one(x)}${one(-x)}</g>`;
  }).join('');
  const nozzle =
    `<circle class="mc-bp-engine" cx="0" cy="${n1(L * 0.9)}" r="${n1(g.engineR)}" fill="${engine}"/>`;

  return (
    `<svg class="mc-hangar-blueprint" viewBox="0 0 100 104" role="img" ` +
    `aria-label="${escapeHtml(def.name)} 全幅${n1((W + S) * 2)} 全長${n1(L * 2)} 砲${g.barrels.length}門 パイロン${g.pylons}">` +
    `<g transform="translate(50 50) scale(${g.scale.toFixed(3)})">` +
    wings +
    `<path class="mc-bp-body" d="${body}" fill="${hull}" stroke="${accent}" stroke-width="1.8"/>` +
    barrels +
    pylons +
    nozzle +
    `<path class="mc-bp-grid" d="M 0 ${n1(-L)} L 0 ${n1(L * 0.9)} M ${n1(-(W + S))} ${n1(L * 0.42)} L ${n1(W + S)} ${n1(L * 0.42)}" ` +
    `stroke="rgba(224,255,239,0.5)" stroke-width="0.7" fill="none"/>` +
    `</g>` +
    `<text x="50" y="101" text-anchor="middle">BLUEPRINT</text></svg>`
  );
}

// ───────── 戦況マップ (星系図) ─────────

/*
 * 「戦況マップ」に地図を出す（specs/02_改善案の詳細.md ⑫）。
 *
 * 戦域名・所有勢力・事実・圧力は `src/content/veil/world.ts`（VEIL_THEATERS /
 * VEIL_FACTIONS）だけを出所にする。ここが持つのは**座標だけ**で、
 * 名前や戦域を新しく定義しない。章の並びは `veil/chapters.ts` から読む。
 */

/** 星系図の座標（表示レイアウトのみ。戦域そのものは world.ts が定義する） */
const THEATER_POS: Readonly<Record<string, { x: number; y: number }>> = {
  'orion-port': { x: 120, y: 200 },
  'notary-relay': { x: 420, y: 80 },
  'vega-gate': { x: 430, y: 215 },
  'ashcrown-corridor': { x: 820, y: 110 },
  'hive-veins': { x: 800, y: 255 },
  'lagrange-rift': { x: 520, y: 340 },
  'quiet-sea': { x: 190, y: 355 },
  'deep-mining-belt': { x: 720, y: 400 },
};

/** 圧力から戦域の状態を決める。表示語は `pressure` の値から一意に導く。 */
function theaterStateOf(pressure: string): { id: string; label: string; color: string } {
  switch (pressure) {
    case '極高':
      return { id: 'blockade', label: '封鎖・睨み合い', color: '#ff5d5d' };
    case '高':
      return { id: 'contested', label: '交戦中', color: '#ffb457' };
    case '中':
      return { id: 'truce', label: '停戦維持', color: '#7fe3b0' };
    default:
      return { id: 'unknown', label: '状態不明', color: '#9fb6c2' };
  }
}

/** 戦域の所有勢力の色。'shared'（共同設備）は勢力色を持たない。 */
function theaterOwnerColor(owner: string): string {
  if (owner === 'shared') return '#9fb6c2';
  return VEIL_FACTIONS.find((f) => f.id === owner)?.color ?? '#9fb6c2';
}

/** 4状態のうち、その場所に効くもの。要素は「戦域id → 状態」の対応。 */
const GAUGE_ANCHORS: ReadonlyArray<{
  theater: string;
  key: keyof NarrativeGauges;
  label: string;
  where: string;
  x: number;
  y: number;
}> = [
  // 軍令信用は司令部（連邦前進基地＝オリオン港）に効く
  { theater: 'orion-port', key: 'commandTrust', label: '軍令信用', where: '司令部', x: 20, y: 244 },
  // 帰還者は港の医療区画へ降りるので同じ港に置く
  { theater: 'orion-port', key: 'returnees', label: '帰還者', where: '港の医療区画', x: 20, y: 288 },
  // 航路信頼はセレシオン／オルド圏に効く
  { theater: 'quiet-sea', key: 'routeTrust', label: '航路信頼', where: 'セレシオン圏', x: 95, y: 402 },
  { theater: 'deep-mining-belt', key: 'routeTrust', label: '航路信頼', where: 'オルド圏', x: 630, y: 446 },
  // 敵エースの誓約はキルラシー圏に効く
  { theater: 'ashcrown-corridor', key: 'aceOath', label: '敵エースの誓約', where: 'キルラシー圏', x: 700, y: 150 },
];

/**
 * 動的作戦の戦況値。8戦域のうち5戦域にしか無いので、無い戦域は undefined を返す
 * （`FrontlineState.systems` は5戦域ぶんの Record なので型では表せない）。
 */
function dynamicSystem(
  state: FrontlineState | undefined,
  theaterId: string,
): { control: number; pressure: number; logistics: number } | undefined {
  if (!state) return undefined;
  return (state.systems as Partial<Record<string, { control: number; pressure: number; logistics: number }>>)[theaterId];
}

/** 章の順路。同じ戦域が続く区間は線を引かない（第7→8章、第9→10章）。 */
function chapterRoute(): Array<{ from: string; to: string; chapter: number }> {
  const out: Array<{ from: string; to: string; chapter: number }> = [];
  for (let i = 0; i < VEIL_CHAPTERS.length - 1; i++) {
    const a = VEIL_CHAPTERS[i];
    const b = VEIL_CHAPTERS[i + 1];
    if (a.theater === b.theater) continue;
    out.push({ from: a.theater, to: b.theater, chapter: b.chapter });
  }
  return out;
}

function gaugeBadgeSvg(label: string, where: string, value: number | undefined, x: number, y: number): string {
  const w = 200;
  const h = 40;
  const known = typeof value === 'number' && Number.isFinite(value);
  const pct = known ? Math.max(0, Math.min(100, value)) : 0;
  return (
    `<g class="mc-starmap-gauge" transform="translate(${x} ${y})">` +
    `<rect x="0" y="0" width="${w}" height="${h}" rx="4"/>` +
    `<text class="mc-starmap-gauge-label" x="7" y="15">${escapeHtml(label)}` +
    `<tspan class="mc-starmap-gauge-where" dx="6">${escapeHtml(where)}</tspan></text>` +
    `<text class="mc-starmap-gauge-value" x="${w - 7}" y="15" text-anchor="end">` +
    `${known ? `${Math.round(pct)}` : '記録なし'}</text>` +
    `<rect class="mc-starmap-gauge-track" x="7" y="24" width="${w - 14}" height="7" rx="3"/>` +
    (known
      ? `<rect class="mc-starmap-gauge-fill" x="7" y="24" width="${(((w - 14) * pct) / 100).toFixed(1)}" height="7" rx="3"/>`
      : '') +
    `</g>`
  );
}

/**
 * 8戦域の星系図。
 *
 * - 塗り色 = 所有勢力（`VEIL_FACTIONS.color`）
 * - 枠色   = 状態（封鎖・交戦・停戦・不明。`VEIL_THEATERS.pressure` から導く）
 * - 線     = 章の順路。通ってきた章は実線、これからの章は破線、現在地は強調
 * - 帯     = 4状態を、それが効く場所の上に置く
 */
export function starMapSvg(ctx: HubContext): string {
  const chapter = ctx.chapter;
  const routes = chapterRoute()
    .map((r) => {
      const a = THEATER_POS[r.from];
      const b = THEATER_POS[r.to];
      if (!a || !b) return '';
      const cls = r.chapter <= chapter ? 'past' : 'future';
      return `<line class="mc-starmap-route ${cls}" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"/>`;
    })
    .join('');

  const nodes = VEIL_THEATERS.map((t) => {
    const pos = THEATER_POS[t.id];
    if (!pos) return '';
    const state = theaterStateOf(t.pressure);
    const chapters = VEIL_CHAPTERS.filter((c) => c.theater === t.id).map((c) => c.chapter);
    const isCurrent = chapters.includes(chapter);
    const visited = chapters.some((c) => c < chapter);
    const control = dynamicSystem(ctx.frontline, t.id)?.control;
    const labelRight = pos.x < 620;
    return (
      `<g class="mc-starmap-node ${state.id}${isCurrent ? ' current' : ''}${visited ? ' visited' : ''}" ` +
      `data-theater="${escapeHtml(t.id)}">` +
      `<title>${escapeHtml(t.name)} — ${escapeHtml(veilFactionLabel(t.owner))} / ${escapeHtml(state.label)}（圧力 ${escapeHtml(t.pressure)}）</title>` +
      (isCurrent ? `<circle class="mc-starmap-here" cx="${pos.x}" cy="${pos.y}" r="26"/>` : '') +
      `<circle class="mc-starmap-disc" cx="${pos.x}" cy="${pos.y}" r="17" ` +
      `fill="${theaterOwnerColor(t.owner)}" stroke="${state.color}"/>` +
      (chapters.length
        ? `<text class="mc-starmap-chapters" x="${pos.x}" y="${pos.y + 4}" text-anchor="middle">${chapters.join('・')}</text>`
        : '') +
      `<text class="mc-starmap-name" x="${labelRight ? pos.x + 24 : pos.x - 24}" y="${pos.y - 2}" ` +
      `text-anchor="${labelRight ? 'start' : 'end'}">${escapeHtml(t.name)}</text>` +
      `<text class="mc-starmap-state" x="${labelRight ? pos.x + 24 : pos.x - 24}" y="${pos.y + 13}" ` +
      `text-anchor="${labelRight ? 'start' : 'end'}">${escapeHtml(state.label)}` +
      (typeof control === 'number' ? `　連邦支配 ${control.toFixed(0)}%` : '') +
      `</text>` +
      `</g>`
    );
  }).join('');

  const gauges = GAUGE_ANCHORS.map((a) =>
    gaugeBadgeSvg(a.label, a.where, ctx.narrative?.[a.key], a.x, a.y),
  ).join('');

  return (
    `<svg class="mc-starmap" viewBox="0 0 960 500" role="img" ` +
    `aria-label="ヴェガ宙域 星系図 — 全${VEIL_THEATERS.length}戦域と第${chapter}章の位置">` +
    routes +
    nodes +
    gauges +
    `</svg>`
  );
}

/** 星系図の凡例。色の意味を文字で必ず添える（色だけに情報を持たせない）。 */
function starMapLegend(): string {
  const owners = VEIL_FACTIONS.map(
    (f) =>
      `<span class="mc-starmap-key"><i style="background:${f.color}"></i>${escapeHtml(f.name)}</span>`,
  ).join('');
  const states = (['極高', '高', '中', '不明'] as const)
    .map((p) => {
      const s = theaterStateOf(p);
      return `<span class="mc-starmap-key"><i class="ring" style="border-color:${s.color}"></i>${escapeHtml(s.label)}（圧力 ${escapeHtml(p)}）</span>`;
    })
    .join('');
  return (
    `<div class="mc-starmap-legend">` +
    `<div><b>塗り＝所有勢力</b>${owners}` +
    `<span class="mc-starmap-key"><i style="background:#9fb6c2"></i>五者協定の共同設備</span></div>` +
    `<div><b>枠＝状態</b>${states}</div>` +
    `<div><b>線＝章の順路</b>` +
    `<span class="mc-starmap-key"><i class="line past"></i>通ってきた章</span>` +
    `<span class="mc-starmap-key"><i class="line future"></i>残りの章</span>` +
    `<span class="mc-starmap-key"><i class="ring here"></i>現在地</span></div>` +
    `</div>`
  );
}

export function frontlineHtml(ctx: HubContext): string {
  const state = ctx.frontline;
  const theaterEntries: PagerEntry[] = VEIL_THEATERS.map((t) => {
    const st = theaterStateOf(t.pressure);
    const chapters = VEIL_CHAPTERS.filter((c) => c.theater === t.id);
    const dyn = dynamicSystem(state, t.id);
    return {
      html:
        `<div class="mc-theater-row">` +
        `<div class="mc-theater-head"><b>${escapeHtml(t.name)}</b>` +
        `<span class="dim">${escapeHtml(veilFactionLabel(t.owner))}</span>` +
        `<span style="color:${st.color}">${escapeHtml(st.label)}（圧力 ${escapeHtml(t.pressure)}）</span></div>` +
        `<div class="dim">${escapeHtml(t.fact)}</div>` +
        (chapters.length
          ? `<div class="dim">第${chapters.map((c) => c.chapter).join('・')}章　` +
            escapeHtml(chapters.map((c) => c.shortTitle).join(' / ')) +
            `</div>`
          : `<div class="dim">章の舞台にはならない戦域。</div>`) +
        (dyn
          ? `<div class="dim">連邦支配 ${dyn.control.toFixed(0)}%　敵圧力 ${dyn.pressure.toFixed(0)}%　補給余力 ${dyn.logistics.toFixed(0)}%</div>` +
            `<div class="mc-kb-bar"><span style="width:${dyn.control.toFixed(1)}%"></span></div>`
          : '') +
        `</div>`,
      tags: {
        faction: [t.owner],
        chapter: chapters.map((c) => String(c.chapter)),
      },
    };
  });

  return (
    `<div class="block mc-starmap-block"><h3>戦況マップ — ヴェガ宙域 ${VEIL_THEATERS.length} 戦域</h3>` +
    `<div class="dim">第 ${ctx.chapter} 章 / ${ctx.totalChapters}　` +
    (state
      ? `動的作戦 ${state.operations} 回　最終作戦 ${escapeHtml(frontlineSystemName(state.lastSystem))}`
      : '動的作戦なし（章の順路のみ）') +
    `</div>` +
    starMapSvg(ctx) +
    starMapLegend() +
    `</div>` +
    pagerHtml({
      id: 'frontline-theaters',
      title: `戦域の状態 — ${theaterEntries.length} 箇所`,
      pageSize: 4,
      layout: 'grid',
      entries: theaterEntries,
      filters: [
        {
          key: 'faction',
          label: '勢力',
          code: PAGER_FILTER_CODES.faction,
          keyLabel: 'J',
          options: [
            { value: '', label: 'すべて' },
            ...VEIL_FACTIONS.map((f) => ({ value: f.id, label: f.name })),
            { value: 'shared', label: '共同設備' },
          ],
        },
        {
          key: 'chapter',
          label: '章',
          code: PAGER_FILTER_CODES.chapter,
          keyLabel: 'L',
          options: [
            { value: '', label: '全章' },
            ...VEIL_CHAPTERS.map((c) => ({ value: String(c.chapter), label: `第${c.chapter}章 ${c.shortTitle}` })),
          ],
        },
      ],
      emptyText: '条件に合う戦域がない。',
    })
  );
}

export function statisticsHtml(ctx: HubContext): string {
  const s = ctx.statistics;
  if (!s) return '<div class="dim">統計データなし</div>';
  const accuracy = s.shotsFired > 0 ? (s.hits / s.shotsFired) * 100 : 0;
  const campaignAttempts = s.campaignWins + s.campaignLosses;
  const campaignRate = campaignAttempts > 0 ? (s.campaignWins / campaignAttempts) * 100 : 0;
  const ships = Object.entries(s.shipsFlown).map(([id, n]) => `${escapeHtml(shipDef(id).name)} ${n}回`).join(' / ') || 'なし';
  return `<div class="block"><h3>飛行統計</h3><ul>` +
    `<li>勝利 ${s.missionsWon} / 敗北 ${s.missionsLost}</li>` +
    `<li>発射 ${s.shotsFired}　命中 ${s.hits}　命中率 ${accuracy.toFixed(1)}%</li>` +
    `<li>戦闘時間 ${(s.combatSeconds / 60).toFixed(1)} 分</li>` +
    `<li>最長僚機生存スコア ${(s.longestWingmanSurvival / 60).toFixed(1)} 分</li>` +
    `<li>Nav 到達 ${s.navsReached}　護衛成功 ${s.escortSuccesses} / ${s.escortAttempts}</li>` +
    `<li>救援成功 ${s.rescuedWingmen}　置き去り ${s.abandonedWingmen}</li>` +
    `<li>戦役分岐勝率 ${campaignRate.toFixed(1)}%　勝利 ${s.campaignWins} / 敗北 ${s.campaignLosses}</li>` +
    `<li>戦役勝利点 ${s.seriesScore}　前進 ${s.advanceCount}　撤退 ${s.retreatCount}</li></ul></div>` +
    `<div class="block"><h3>搭乗履歴</h3>${ships}</div>`;
}

/**
 * 名鑑（THE VEIL FRONT の資料閲覧）。
 *
 * 人物・機体・戦域を、実装データからそのまま生成する。
 * 設定資料のHTMLを複製しないので、データを直せば画面も直る。
 *
 * ページ分割にしている理由: 76名＋機体22種を1枚に出すと必ずスクロールが必要になり、
 * `AI_CODING.md` の「スクロールバーを廃止する場合は…情報が欠落しないようにする」に反する。
 * 情報を削らずに収めるため、勢力ごとにページを切る。
 */
export type CodexPage =
  | 'people-all'
  | 'people-confed'
  | 'people-kilrashi'
  | 'people-serecion'
  | 'people-ordo'
  | 'people-neurowm'
  | 'ships'
  | 'theaters';

export const CODEX_PAGES: ReadonlyArray<{ id: CodexPage; label: string }> = [
  { id: 'people-all', label: `人物 — 全${VEIL_PEOPLE.length}名（勢力で絞り込み）` },
  { id: 'people-confed', label: '人物 — 連邦' },
  { id: 'people-kilrashi', label: '人物 — キルラシー' },
  { id: 'people-serecion', label: '人物 — セレシオン' },
  { id: 'people-ordo', label: '人物 — オルド' },
  { id: 'people-neurowm', label: '人物 — ニューロウム' },
  { id: 'ships', label: '機体' },
  { id: 'theaters', label: '戦域' },
];

/**
 * 名鑑での勢力表示名。
 *
 * 資料表記（`kilrashi`）と実装id（`kilrathi`）の差があるので、
 * どちらで来ても `VEIL_FACTIONS` の表示名へ寄せる。'shared' は共同設備。
 */
function veilFactionLabel(id: string): string {
  if (id === 'shared') return '五者協定の共同設備';
  const key = id === 'kilrathi' ? 'kilrashi' : id;
  return VEIL_FACTIONS.find((f) => f.id === key)?.name ?? factionLabel(id as never);
}

/** 顔画像が無い人物のための SVG フォールバック指定（画像があれば使われない）。 */
const CODEX_FACE_SPEC: PortraitSpec = {
  skin: '#c8a487',
  hair: '#3b2f2a',
  hairStyle: 'short',
  eyes: 'normal',
};

/** 人物id → 登場する章番号。`veil/chapters.ts` の `cast` が出所。 */
function chaptersOfPerson(): Map<string, number[]> {
  const map = new Map<string, number[]>();
  for (const c of VEIL_CHAPTERS) {
    for (const member of c.cast) {
      if (!member.id) continue;
      const list = map.get(member.id) ?? [];
      list.push(c.chapter);
      map.set(member.id, list);
    }
  }
  return map;
}

/**
 * 人物の生死。飛行隊に出せる人物（`PILOTS` の `personId`）だけが生死を持つ。
 * 名簿（`RosterState`）が無いときは戦死判定ができないので 'squad' / 'other' だけになる。
 */
function personLifeTag(person: VeilPerson, roster?: RosterState): 'dead' | 'squad' | 'other' {
  const pilot = PILOTS.find((x) => x.personId === person.id);
  if (!pilot) return 'other';
  const state = roster?.pilots.find((p) => p.id === pilot.id);
  return state?.status === 'dead' ? 'dead' : 'squad';
}

function codexPersonEntry(p: VeilPerson, chapters: number[], life: string): PagerEntry {
  return {
    html:
      `<div class="mc-codex-entry${life === 'dead' ? ' dead' : ''}">` +
      `<div class="mc-codex-face">${portraitFace(p.id, CODEX_FACE_SPEC, { size: 56, dead: life === 'dead' })}</div>` +
      `<div class="mc-codex-text">` +
      // 表記は `speakerName()` 経由に揃える（T3-⑬）。`people.ts` の `name` は
      // `朝倉 澪（アサクラ ミオ）` と `Amina Okafor（アミナ・オカフォー）` が混在しており、
      // 生で並べると同じ一覧に英字と漢字が混ざる。整形はここで再実装しない。
      `<div><b>${escapeHtml(protagonistDisplayName(p))}</b> <span class="dim">“${escapeHtml(p.epithet)}”　${escapeHtml(p.grade)}級</span>` +
      (life === 'dead' ? '　<span class="ng">戦死</span>' : life === 'squad' ? '　<span class="ok">飛行隊</span>' : '') +
      `</div>` +
      `<div class="dim">${escapeHtml(veilFactionLabel(p.faction))} ／ ${escapeHtml(p.role)} ／ ${escapeHtml(p.sex)} ${escapeHtml(p.age)}` +
      `${p.isLeader ? '　<span class="ok">最高権力者</span>' : ''}` +
      `${p.protagonist ? '　<span class="ok">主人公候補</span>' : ''}</div>` +
      `<div class="dim">${escapeHtml(p.achievement)}</div>` +
      `<div class="dim">${chapters.length ? `登場 第${chapters.join('・')}章` : '章には登場しない'}</div>` +
      `</div></div>`,
    tags: {
      faction: [p.faction],
      life: [life],
      chapter: chapters.map(String),
    },
  };
}

const CODEX_LIFE_FILTER: PagerFilterDef = {
  key: 'life',
  label: '生死',
  code: PAGER_FILTER_CODES.life,
  keyLabel: 'K',
  options: [
    { value: '', label: 'すべて' },
    { value: 'squad', label: '飛行隊（生存）' },
    { value: 'dead', label: '戦死' },
    { value: 'other', label: '飛行隊外' },
  ],
};

function codexChapterFilter(): PagerFilterDef {
  return {
    key: 'chapter',
    label: '章',
    code: PAGER_FILTER_CODES.chapter,
    keyLabel: 'L',
    options: [
      { value: '', label: '全章' },
      ...VEIL_CHAPTERS.map((c) => ({ value: String(c.chapter), label: `第${c.chapter}章 ${c.shortTitle}` })),
    ],
  };
}

function codexFactionFilter(): PagerFilterDef {
  return {
    key: 'faction',
    label: '勢力',
    code: PAGER_FILTER_CODES.faction,
    keyLabel: 'J',
    options: [
      { value: '', label: 'すべて' },
      ...VEIL_FACTIONS.map((f) => ({ value: f.id, label: f.name })),
    ],
  };
}

/**
 * 名鑑の本体。
 *
 * `ctx` は省略できる（渡されないときは生死のうち「戦死」が付かないだけで、
 * 一覧・絞り込み・ページ送りはすべて機能する）。
 */
export function codexHtml(page: CodexPage, ctx?: HubContext): string {
  if (page === 'theaters') {
    return pagerHtml({
      id: 'codex-theaters',
      title: `戦域 — ヴェガ宙域 ${VEIL_THEATERS.length} 箇所`,
      pageSize: 4,
      layout: 'grid',
      entries: VEIL_THEATERS.map((t) => ({
        html:
          `<div class="mc-codex-text"><div><b>${escapeHtml(t.name)}</b>` +
          `<span class="dim">　${escapeHtml(veilFactionLabel(t.owner))}　圧力 ${escapeHtml(t.pressure)}</span></div>` +
          `<div class="dim">${escapeHtml(t.fact)}</div></div>`,
        tags: { faction: [t.owner] },
      })),
      filters: [
        {
          ...codexFactionFilter(),
          options: [...codexFactionFilter().options, { value: 'shared', label: '共同設備' }],
        },
      ],
      emptyText: '条件に合う戦域がない。',
    });
  }
  if (page === 'ships') {
    // 名鑑どおりに勢力で絞れるようにする。性能値は `SHIPS` の実値をそのまま出す
    const all = Object.values(SHIPS);
    return pagerHtml({
      id: 'codex-ships',
      title: `機体 — ${all.length} 種`,
      pageSize: 10,
      layout: 'grid',
      entries: all.map((s) => ({
        html:
          `<div class="mc-codex-text"><div><b>${escapeHtml(s.name)}</b>` +
          `<span class="dim">　${escapeHtml(factionLabel(s.faction))}</span></div>` +
          `<div class="dim">船体 ${s.hull}　最高速 ${s.maxSpeed}　機動 ${s.agility}</div>` +
          shipCharacterHtml(s) +
          `</div>`,
        tags: { faction: [s.faction === 'kilrathi' ? 'kilrashi' : s.faction] },
      })),
      filters: [codexFactionFilter()],
      emptyText: '条件に合う機体がない。',
    });
  }

  const chapterMap = chaptersOfPerson();
  const all = page === 'people-all';
  const factionId = all
    ? undefined
    : (page.replace('people-', '') as 'confed' | 'kilrashi' | 'serecion' | 'ordo' | 'neurowm');
  const people = all ? [...VEIL_PEOPLE] : peopleOfFaction(factionId!);
  const entries = people.map((p) =>
    codexPersonEntry(p, chapterMap.get(p.id) ?? [], personLifeTag(p, ctx?.roster)),
  );
  return pagerHtml({
    id: all ? 'codex-people-all' : `codex-${page}`,
    title: all
      ? `人物 — 全 ${people.length} 名`
      : `${veilFactionLabel(factionId!)} — ${people.length} 名`,
    note: 'すべての名前がページ送りで読める。件数は絞り込み後の数を出す。',
    pageSize: 8,
    layout: 'grid',
    entries,
    filters: [
      ...(all ? [codexFactionFilter()] : []),
      CODEX_LIFE_FILTER,
      codexChapterFilter(),
    ],
    emptyText: '条件に合う人物がいない。絞り込みを「すべて」に戻すと全員に戻る。',
  });
}
