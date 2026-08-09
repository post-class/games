import { rankFor } from '../app/medals';
import { medalById } from '../app/medals';
import {
  availablePilots,
  defOf,
  fallen,
  killBoard,
  rosterForDisplay,
  type PilotState,
  type RosterState,
} from '../app/roster';
import { barLine, rumor, type BarMood } from '../content/pilotDialogue';
import { factionLabel } from '../content/factions';
import { peopleOfFaction } from '../content/veil/people';
import { VEIL_FACTIONS, VEIL_THEATERS } from '../content/veil/world';
import { PERSONALITIES } from '../content/pilots';
import { PLAYABLE_SHIPS, SHIPS, shipDef } from '../content/ships';
import { gunDef, missileDef } from '../content/weapons';
import { aceDef, type AceState } from '../content/aces';
import { frontlineSystemName, type FrontlineState, type FrontlineSystemId } from '../content/frontline';
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
  lastSortie?: LastSortieCondition;
}

// ───────── 酒場 ─────────

/** 関係値から会話の色を決める */
function moodOf(p: PilotState, hasFallen: boolean): BarMood {
  if (hasFallen && Math.random() < 0.35) return 'mourning';
  if (p.bond > 0.35) return 'friendly';
  if (p.bond < -0.2) return 'cold';
  return 'neutral';
}

export function recRoomHtml(ctx: HubContext): string {
  const alive = ctx.roster.pilots.filter((p) => p.status === 'active' || p.status === 'wounded');
  const dead = fallen(ctx.roster);
  const fallenName = dead.length ? defOf(dead[dead.length - 1]).callsign : undefined;

  const talks = alive
    .map((p) => {
      const def = defOf(p);
      const mood = moodOf(p, !!fallenName);
      const line = barLine(def.personality, mood, fallenName);
      const bondLabel =
        p.bond > 0.35 ? '信頼' : p.bond < -0.2 ? '不信' : '——';
      const status =
        p.status === 'wounded' ? `<span class="ng">負傷 (あと${p.benchedFor}回欠場)</span>` : '';
      return (
        `<div class="mc-bar-row${ctx.barPilotId === p.id ? ' selected' : ''}">` +
        `<div class="mc-bar-face">${portraitFace(def.id, def.portrait, { size: 72, expression: mood === 'friendly' ? 'grin' : mood === 'cold' ? 'grim' : 'talk' })}</div>` +
        `<div class="mc-bar-text">` +
        `<div class="mc-bar-name">${escapeHtml(def.callsign)} <span class="dim">${escapeHtml(def.name)}・${PERSONALITIES[def.personality].label}・関係 ${bondLabel}</span> ${status}</div>` +
        `<div>${escapeHtml(line)}</div>` +
        `</div></div>`
      );
    })
    .join('');

  return (
    `<div class="block"><h3>酒場 / レクリエーション室</h3>` +
    `<div class="mc-board-head">` +
    artImg(artUrl('icon-bar'), { height: 64, alt: '' }) +
    `<span class="dim">出撃と出撃の合間。誰が何を考えているかは、ここでしか分からない。</span></div></div>` +
    (ctx.barPilotId && alive.some((p) => p.id === ctx.barPilotId)
      ? `<div class="block"><h3>会話中</h3><div class="dim">${escapeHtml(defOf(alive.find((p) => p.id === ctx.barPilotId)! ).callsign)} の話を聞いた。関係値は次の出撃へ持ち越される。</div></div>`
      : '') +
    talks +
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
              `<div class="ng">${escapeHtml(defOf(p).callsign)} — ${escapeHtml(defOf(p).name)}` +
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

  const rows = rosterForDisplay(ctx.roster)
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
      return (
        `<div class="mc-roster-row${p.status === 'dead' ? ' dead' : p.status === 'transferred' ? ' transferred' : ''}">` +
        `<div>${portraitFace(def.id, def.portrait, { size: 52, dead: p.status === 'dead' })}</div>` +
        `<div class="mc-roster-main">` +
        `<div><b>${escapeHtml(def.callsign)}</b> <span class="dim">${escapeHtml(def.name)}</span></div>` +
        `<div class="dim">${PERSONALITIES[def.personality].label}　技量 ${(p.skill * 100) | 0}%　撃墜 ${p.kills}　出撃 ${p.sorties}　昇進 ${p.rank}` +
        `${p.transferredIn ? '　<span class="ok">転属</span>' : ''}</div>` +
        (p.status === 'dead' && p.diedIn
          ? `<div class="ng">${escapeHtml(p.diedIn)} で戦死</div>`
          : `<div class="dim">${escapeHtml(def.bio)}</div>`) +
        `</div><div>${st}</div></div>`
      );
    })
    .join('');

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
    `<div class="block"><h3>飛行隊名簿</h3>${rows}</div>`
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
    rows
      .map((r, i) => {
        const w = (r.kills / max) * 100;
        const cls = r.isPlayer ? 'me' : r.status === 'dead' ? 'dead' : '';
        return (
          `<div class="mc-kb-row ${cls}">` +
          `<span class="mc-kb-rank">${i + 1}</span>` +
          `<span class="mc-kb-name">${escapeHtml(r.name)}${r.status === 'dead' ? ' †' : ''}</span>` +
          `<span class="mc-kb-bar"><span style="width:${w.toFixed(1)}%"></span></span>` +
          `<span class="mc-kb-kills">${r.kills}</span>` +
          `</div>`
        );
      })
      .join('') +
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
        `</div></article>`
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

function roleLabel(role: string): string {
  return role === 'bomber' ? '爆撃 / 重装' : role === 'fighter' ? '制空 / 戦闘機' : role;
}

function blueprintSvg(def: ReturnType<typeof shipDef>): string {
  const hull = `#${def.visual.hull.toString(16).padStart(6, '0')}`;
  const accent = `#${def.visual.accent.toString(16).padStart(6, '0')}`;
  const path =
    def.visual.kind === 'delta'
      ? 'M 14 53 L 48 12 L 66 42 L 100 24 L 86 56 L 100 88 L 66 70 L 48 96 Z'
      : def.visual.kind === 'twin-boom'
        ? 'M 16 28 L 42 40 L 48 12 L 54 40 L 84 28 L 75 55 L 88 88 L 55 70 L 48 96 L 41 70 L 12 88 L 25 55 Z'
        : 'M 48 8 L 61 42 L 94 72 L 58 63 L 48 94 L 38 63 L 2 72 L 35 42 Z';
  return `<svg class="mc-hangar-blueprint" viewBox="0 0 100 104" role="img" aria-label="${escapeHtml(def.name)} silhouette">` +
    `<path d="${path}" fill="${hull}" stroke="${accent}" stroke-width="2"/>` +
    `<path d="M48 18 L48 86 M24 58 L72 58" stroke="rgba(224,255,239,0.68)" stroke-width="1" fill="none"/>` +
    `<circle cx="48" cy="48" r="3" fill="${accent}"/><text x="50" y="101" text-anchor="middle">BLUEPRINT</text></svg>`;
}

export function frontlineHtml(ctx: HubContext): string {
  const state = ctx.frontline;
  if (!state) return '<div class="dim">戦況データなし</div>';
  const rows = (Object.entries(state.systems) as Array<[FrontlineSystemId, { control: number; pressure: number; logistics: number }]>).map(([id, s]) =>
    `<div class="block"><h3>${escapeHtml(frontlineSystemName(id))}</h3>` +
    `<div class="dim">連邦支配 ${s.control.toFixed(0)}%　敵圧力 ${s.pressure.toFixed(0)}%　補給余力 ${s.logistics.toFixed(0)}%</div>` +
    `<div class="mc-kb-bar"><span style="width:${s.control.toFixed(1)}%"></span></div></div>`,
  ).join('');
  return `<div class="block"><h3>戦況マップ</h3><div class="dim">作戦回数 ${state.operations}　最終作戦 ${escapeHtml(frontlineSystemName(state.lastSystem))}</div></div>${rows}`;
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
export type CodexPage = 'people-confed' | 'people-kilrashi' | 'people-serecion' | 'people-ordo' | 'people-neurowm' | 'ships' | 'theaters';

export const CODEX_PAGES: ReadonlyArray<{ id: CodexPage; label: string }> = [
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

export function codexHtml(page: CodexPage): string {
  if (page === 'theaters') {
    const rows = VEIL_THEATERS.map(
      (t) =>
        `<li><b>${escapeHtml(t.name)}</b>` +
        `<span class="dim">　${escapeHtml(veilFactionLabel(t.owner))}　圧力 ${escapeHtml(t.pressure)}</span>` +
        `<div class="dim">${escapeHtml(t.fact)}</div></li>`,
    ).join('');
    return `<div class="block"><h3>戦域 — ヴェガ宙域</h3><ul>${rows}</ul></div>`;
  }
  if (page === 'ships') {
    // 名鑑どおりに勢力ごとへ分ける。性能値は `shipDef` の実値をそのまま出す
    const groups = (['confed', 'kilrathi', 'serecion', 'ordo', 'neurowm'] as const).map((faction) => {
      const list = Object.values(SHIPS).filter((s) => s.faction === faction);
      if (list.length === 0) return '';
      const rows = list
        .map(
          (s) =>
            `<li><b>${escapeHtml(s.name)}</b>` +
            `<span class="dim">　船体 ${s.hull}　最高速 ${s.maxSpeed}　機動 ${s.agility}</span></li>`,
        )
        .join('');
      return `<div class="block"><h3>${escapeHtml(factionLabel(faction))}</h3><ul>${rows}</ul></div>`;
    });
    return groups.join('');
  }
  const factionId = page.replace('people-', '') as 'confed' | 'kilrashi' | 'serecion' | 'ordo' | 'neurowm';
  const people = peopleOfFaction(factionId);
  const rows = people
    .map(
      (p) =>
        `<li><b>${escapeHtml(p.name)}</b>` +
        `<span class="dim">　“${escapeHtml(p.epithet)}”　${escapeHtml(p.grade)}級</span>` +
        `<div class="dim">${escapeHtml(p.role)} ／ ${escapeHtml(p.sex)} ${escapeHtml(p.age)}` +
        `${p.isLeader ? '　<span class="ok">最高権力者</span>' : ''}` +
        `${p.protagonist ? '　<span class="ok">主人公候補</span>' : ''}</div>` +
        `<div class="dim">${escapeHtml(p.achievement)}</div></li>`,
    )
    .join('');
  return `<div class="block"><h3>${escapeHtml(veilFactionLabel(factionId))} — ${people.length} 名</h3><ul>${rows}</ul></div>`;
}
