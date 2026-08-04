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
import { PERSONALITIES } from '../content/pilots';
import { shipDef } from '../content/ships';
import { missileDef } from '../content/weapons';
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
  const alive = ctx.roster.pilots.filter((p) => p.status !== 'dead');
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
        `<div class="mc-bar-row">` +
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
    talks +
    `<div class="block"><h3>噂</h3><div>${escapeHtml(rumor())}</div>` +
    `<div>${escapeHtml(rumor())}</div></div>` +
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
          : p.status === 'wounded'
            ? `<span class="ng">負傷 (${p.benchedFor})</span>`
            : '<span class="ok">出撃可</span>';
      return (
        `<div class="mc-roster-row${p.status === 'dead' ? ' dead' : ''}">` +
        `<div>${portraitFace(def.id, def.portrait, { size: 52, dead: p.status === 'dead' })}</div>` +
        `<div class="mc-roster-main">` +
        `<div><b>${escapeHtml(def.callsign)}</b> <span class="dim">${escapeHtml(def.name)}</span></div>` +
        `<div class="dim">${PERSONALITIES[def.personality].label}　技量 ${(p.skill * 100) | 0}%　撃墜 ${p.kills}　出撃 ${p.sorties}</div>` +
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
      .join('')
  );
}

// ───────── 格納庫 (機体と僚機の選択) ─────────

export interface HangarSelection {
  shipId: string;
  gunId?: string;
  missiles?: Array<{ missileId: string; count: number }>;
  wingmanId?: string;
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

  return (
    `<div class="block"><h3>格納庫 / 飛行甲板</h3>` +
    `<div class="mc-board-head">` +
    artImg(artUrl('icon-hangar'), { height: 64, alt: '' }) +
    `<div class="dim">整備班: 「割り当ては ${escapeHtml(shipDef(missionShipId).name)} だ。` +
    `他のに乗りたいなら勝手にしろ、書類は俺が書く。」</div></div></div>` +
    `<div class="block"><h3>搭乗機</h3>` +
    `<div><b>${escapeHtml(def.name)}</b>` +
    `${sel.shipId === missionShipId ? ' <span class="dim">(割り当て)</span>' : ''}</div>` +
    `<div class="dim">最高速 ${def.maxSpeed} / 旋回 ${def.turn[0].toFixed(2)} / ` +
    `装甲 ${def.armor.front + def.armor.rear + def.armor.left + def.armor.right} / ` +
    `船体 ${def.hull} / 砲 ${def.guns.length} 門</div>` +
    `<div class="dim">副兵装: ${escapeHtml(missiles || 'なし')}</div></div>` +
    `<div class="block"><h3>僚機</h3>` +
    (wing
      ? `<div class="mc-bar-row"><div>${portraitFace(defOf(wing).id, defOf(wing).portrait, { size: 64 })}</div>` +
        `<div class="mc-bar-text"><div class="mc-bar-name">${escapeHtml(defOf(wing).callsign)} ` +
        `<span class="dim">${PERSONALITIES[defOf(wing).personality].label}・技量 ${(wing.skill * 100) | 0}%・撃墜 ${wing.kills}</span></div>` +
        `<div class="dim">${escapeHtml(defOf(wing).bio)}</div></div></div>`
      : `<div class="ng">出撃可能な僚機がいない。単独で出ることになる。</div>`) +
    `<div class="dim">出撃可能: ${avail.map((p) => escapeHtml(defOf(p).callsign)).join(' / ') || 'なし'}</div>` +
    `</div>`
  );
}
