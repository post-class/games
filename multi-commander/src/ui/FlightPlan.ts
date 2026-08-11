import type { MissionDef } from '../mission/types';
import { escapeHtml } from './ScreenHost';

/**
 * ブリーフィングの作戦図（本家 Wing Commander の MISSION FLIGHT PATH）。
 *
 * XZ 平面を上から見た図に、母艦・Nav・航路・危険空域・各 Nav で何が起きるかを
 * 重ねて描く。**表示する値はすべて `MissionDef` から作る**（別に数値を持たない）。
 * 台詞の進行に合わせて航路が引かれる演出は CSS 側（`.mc-navpath`）が担う。
 */

/** 図の大きさ（viewBox）。横長の枠に収める */
const W = 420;
const H = 260;
/** 図の余白。Nav 名が枠外へ出ないぶんを取る */
const PAD = 30;

/** その Nav で何が待っているか（作戦図に出す短い印） */
interface NavMark {
  /** 敵が湧く Nav */
  hostile: boolean;
  /** 救難・護衛・偵察の対象がいる Nav */
  roles: string[];
  /** 危険空域の種類 */
  hazards: string[];
  /** そこから計時が始まる制限時間（秒） */
  deadline?: number;
  /** 到達そのものが目標になっている Nav */
  waypoint: boolean;
}

const HAZARD_LABEL: Record<string, string> = {
  asteroids: '残骸帯',
  minefield: '機雷',
  'gravity-well': '重力井戸',
};

/**
 * Nav ごとの印を `MissionDef` から集める。
 * 敵・救難対象・危険空域・制限時間の出所はすべてミッション定義なので、
 * ブリーフィングの図と実際の戦場が食い違うことはない。
 */
function marksOf(def: MissionDef): NavMark[] {
  const marks: NavMark[] = def.navs.map(() => ({
    hostile: false,
    roles: [],
    hazards: [],
    waypoint: false,
  }));
  const at = (i: number | undefined): NavMark | undefined =>
    i !== undefined && i >= 0 && i < marks.length ? marks[i] : undefined;

  // 敵と、救難・護衛・偵察の対象。どのタグが何の役かは目標側から引く
  const roleOfTag = new Map<string, string>();
  for (const o of def.objectives) {
    const spec = o.spec;
    if (spec.kind === 'rescue') roleOfTag.set(spec.tag, '救難');
    else if (spec.kind === 'protect') roleOfTag.set(spec.tag, '護衛');
    else if (spec.kind === 'recon') roleOfTag.set(spec.tag, '偵察');
    else if (spec.kind === 'destroyTag') roleOfTag.set(spec.tag, '撃破');
    else if (spec.kind === 'reachNav') {
      const m = at(spec.navIndex);
      if (m) m.waypoint = true;
    } else if (spec.kind === 'timeLimit') {
      const m = at(spec.startAtNav);
      if (m) m.deadline = spec.seconds;
    }
  }

  for (const s of def.spawns) {
    const m = at(s.atNav);
    if (!m) continue;
    const role = s.tag ? roleOfTag.get(s.tag) : undefined;
    if (role && role !== '撃破') {
      if (!m.roles.includes(role)) m.roles.push(role);
    } else if (s.faction !== 'confed') {
      // 自軍機（護衛の増援など）は「敵」にしない
      m.hostile = true;
    }
  }

  for (const h of def.hazards ?? []) {
    const label = HAZARD_LABEL[h.kind] ?? h.kind;
    const targets = h.betweenNavs ? h.betweenNavs : h.atNav !== undefined ? [h.atNav] : [];
    for (const i of targets) {
      const m = at(i);
      if (m && !m.hazards.includes(label)) m.hazards.push(label);
    }
  }

  return marks;
}

/** 決定論の星屑。ミッション id から作るので、同じ任務では同じ星空になる */
function starField(seed: string): string {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const next = () => {
    h ^= h << 13;
    h ^= h >>> 17;
    h ^= h << 5;
    return ((h >>> 0) % 10000) / 10000;
  };
  const dots: string[] = [];
  for (let i = 0; i < 90; i++) {
    const x = (next() * W).toFixed(1);
    const y = (next() * H).toFixed(1);
    const r = (0.3 + next() * 0.8).toFixed(2);
    const o = (0.15 + next() * 0.45).toFixed(2);
    dots.push(`<circle cx="${x}" cy="${y}" r="${r}" fill="#cfe9dc" opacity="${o}"/>`);
  }
  return dots.join('');
}

/**
 * 作戦図の SVG。
 *
 * 図は「母艦 → Nav 1 → … → 帰投」の順路で、区間ごとに距離（km）を出す。
 * 座標は m 単位なので 1000 で割る。
 */
export function flightPlanSvg(def: MissionDef): string {
  const pts: Array<readonly [number, number, number]> = [
    [0, 0, 0],
    ...def.navs.map((n) => n.pos as readonly [number, number, number]),
  ];
  const marks = marksOf(def);

  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const [x, , z] of pts) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  // 縦横の縮尺を揃える（航路の形を崩さない）
  const span = Math.max(1, maxX - minX, maxZ - minZ);
  const scale = Math.min(W - PAD * 2, H - PAD * 2) / span;
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  const map = (x: number, z: number) =>
    [W / 2 + (x - cx) * scale, H / 2 + (z - cz) * scale] as const;

  const screen = pts.map(([x, , z]) => map(x, z));

  // ── 背景（星屑と方眼）
  const grid: string[] = [];
  for (let gx = 0; gx <= W; gx += 30) {
    grid.push(`<line x1="${gx}" y1="0" x2="${gx}" y2="${H}"/>`);
  }
  for (let gy = 0; gy <= H; gy += 30) {
    grid.push(`<line x1="0" y1="${gy}" x2="${W}" y2="${gy}"/>`);
  }

  // ── 危険空域（航路の帯・Nav の周り）
  const zones: string[] = [];
  for (const h of def.hazards ?? []) {
    const label = HAZARD_LABEL[h.kind] ?? h.kind;
    const r = Math.max(6, h.spread * scale);
    if (h.betweenNavs) {
      const [a, b] = h.betweenNavs;
      const pa = screen[a + 1] ?? screen[0];
      const pb = screen[b + 1] ?? screen[0];
      if (!pa || !pb) continue;
      zones.push(
        `<line class="mc-fp-belt" x1="${pa[0].toFixed(1)}" y1="${pa[1].toFixed(1)}" ` +
          `x2="${pb[0].toFixed(1)}" y2="${pb[1].toFixed(1)}" stroke-width="${(r * 0.9).toFixed(1)}"/>`,
      );
      const mx = (pa[0] + pb[0]) / 2;
      const my = (pa[1] + pb[1]) / 2;
      zones.push(
        `<text class="mc-fp-zone" x="${mx.toFixed(1)}" y="${(my - r * 0.55).toFixed(1)}">${escapeHtml(label)}</text>`,
      );
    } else {
      const p = screen[(h.atNav ?? -1) + 1] ?? screen[0];
      if (!p) continue;
      zones.push(
        `<circle class="mc-fp-zone-ring" cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="${r.toFixed(1)}"/>`,
      );
    }
  }

  // ── 航路と区間距離
  const path = screen
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p[0].toFixed(1)} ${p[1].toFixed(1)}`)
    .join(' ');
  const legs: string[] = [];
  for (let i = 1; i < pts.length; i++) {
    const [ax, , az] = pts[i - 1];
    const [bx, , bz] = pts[i];
    const km = Math.hypot(bx - ax, bz - az) / 1000;
    if (km < 0.5) continue;
    const a = screen[i - 1];
    const b = screen[i];
    const mx = (a[0] + b[0]) / 2;
    const my = (a[1] + b[1]) / 2;
    legs.push(
      `<text class="mc-fp-leg" x="${mx.toFixed(1)}" y="${(my - 3).toFixed(1)}">${km.toFixed(0)} km</text>`,
    );
  }

  // ── 母艦と Nav
  const nodes: string[] = [];
  screen.forEach((p, i) => {
    const [px, py] = p;
    if (i === 0) {
      // 母艦は艦のかたちで置く（Nav の丸と見分ける）
      nodes.push(
        `<g class="mc-fp-home" transform="translate(${px.toFixed(1)} ${py.toFixed(1)})">` +
          `<path d="M -7 -3 L 7 0 L -7 3 L -5 0 Z"/>` +
          `<circle r="9" class="mc-fp-home-ring"/>` +
          `</g>` +
          `<text class="mc-fp-name home" x="${(px - 12).toFixed(1)}" y="${(py + 16).toFixed(1)}">母艦</text>`,
      );
      return;
    }
    const nav = def.navs[i - 1];
    const mark = marks[i - 1];
    const last = i === screen.length - 1;
    // 到達判定半径。実際の判定値をそのまま図にする
    if (nav.arriveRadius) {
      nodes.push(
        `<circle class="mc-fp-arrive" cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" ` +
          `r="${Math.max(5, nav.arriveRadius * scale).toFixed(1)}"/>`,
      );
    }
    const cls = ['mc-fp-nav', mark.hostile ? 'hostile' : '', last ? 'home-leg' : '']
      .filter(Boolean)
      .join(' ');
    nodes.push(
      `<g class="${cls}" transform="translate(${px.toFixed(1)} ${py.toFixed(1)})">` +
        `<circle r="4.5"/>` +
        `<circle r="8" class="mc-fp-nav-halo"/>` +
        `<text class="mc-fp-index" y="2.6">${i}</text>` +
        `</g>`,
    );
    // 名前と印。図の中心より右にある Nav は左側へ出して枠外へ逃げないようにする
    const rightSide = px < W / 2;
    const tx = rightSide ? px + 12 : px - 12;
    const anchor = rightSide ? 'start' : 'end';
    const tags = [
      ...mark.roles,
      mark.hostile ? '敵' : '',
      ...mark.hazards,
      mark.deadline ? `${Math.round(mark.deadline / 60)}分` : '',
    ].filter(Boolean);
    nodes.push(
      `<text class="mc-fp-name" x="${tx.toFixed(1)}" y="${(py - 1).toFixed(1)}" text-anchor="${anchor}">` +
        `${escapeHtml(nav.name)}</text>` +
        (tags.length
          ? `<text class="mc-fp-tag" x="${tx.toFixed(1)}" y="${(py + 9).toFixed(1)}" text-anchor="${anchor}">` +
            `${escapeHtml(tags.join(' / '))}</text>`
          : ''),
    );
  });

  const totalKm =
    pts.reduce((sum, p, i) => {
      if (i === 0) return 0;
      const [ax, , az] = pts[i - 1];
      return sum + Math.hypot(p[0] - ax, p[2] - az);
    }, 0) / 1000;

  return (
    `<svg class="mc-flightplan" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">` +
    `<rect class="mc-fp-bg" x="0" y="0" width="${W}" height="${H}"/>` +
    starField(def.id) +
    `<g class="mc-fp-grid">${grid.join('')}</g>` +
    zones.join('') +
    `<path class="mc-navpath" d="${path}"/>` +
    legs.join('') +
    nodes.join('') +
    `<text class="mc-fp-caption" x="8" y="${H - 8}">MISSION FLIGHT PATH　総航程 ${totalKm.toFixed(0)} km　Nav ${def.navs.length}</text>` +
    `</svg>`
  );
}
