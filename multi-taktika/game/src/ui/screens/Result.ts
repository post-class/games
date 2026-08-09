/**
 * ui/screens/Result.ts — 結果画面（T-M12-12。`05§13` の 7 項目）
 *
 * `05§13` の 7 項目:
 *   1 勝敗の紋章（勝った文明の紋章に月桂。**服属なら旗を巻いた図**）
 *   2 順位（チーム戦ではチーム単位）
 *   3 陣営色と紋章（試合中と同じ色。戦域の色と突き合わせられる）
 *   4 内政の内訳（採集した 4 資源の積み上げバー。緑が長いほど内政偏重）
 *   5 戦闘の内訳（撃破・損失・建物破壊 + **令ごとの成績** = どのカードで勝ったか）
 *   6 資源推移グラフ（**線が離れた瞬間**の時刻がリプレイの頭出しに使える）
 *   7 次へ（リプレイを見る / 再戦する / キャンペーンの次の話へ）
 *
 * ■ 勝敗は 3 通り（`03§10`）。**この世界に滅亡はない**ので、キャンペーンでは
 *   負けても次の話に続く（7 の「次の話へ」は負けても押せる）。
 *
 * ■ 数字は `ui/stats.ts`（観測）から取る。**sim には統計が無い**（そこに足すと
 *   状態ハッシュの対象になり、数え方を直すたびに過去の golden が無効になる）。
 *
 * ■ この画面は World を**読むだけ**（手順書 §3.1）。
 *   DOM を組む部分と、数字を組み立てる部分（純関数）を分けてある。
 *   純関数だけをテストするので jsdom は要らない。
 */

import '@/styles/result.css';

import { RESOURCE_COUNT, RESOURCE_IDS, type CivId, type PlayerId } from '@/shared/types';
import { CIV_DEFS, ORDER_DEFS } from '@/sim/core/defs';
import { monumentRemainingTicks } from '@/sim/systems/victory';
import type { World } from '@/sim/core/world';
import {
  PLAYER_COLORS,
  RESOURCE_COLORS,
  RESOURCE_GLYPHS,
  playerColor,
  resourceColor,
  resourceGlyph,
} from '@/render/palette';
import {
  divergenceSampleIndex,
  seriesPolyline,
  stackedSegments,
  tickToClock,
  type GraphBox,
  type MatchStatsSnapshot,
  type PlayerStatsSnapshot,
} from '../stats';
import { el, button, type Screen, type ScreenNav, type ScreenParams } from './router';

// ---------------------------------------------------------------------------
// 1. 勝敗の種類（`03§10` の 3 通り）
// ---------------------------------------------------------------------------

/** 勝敗の決まり方。**滅亡は無い**（`03§10` / `02`）。 */
export type VictoryKind = 'conquest' | 'monument' | 'submission' | 'draw';

/** 勝敗の種類 → 表示名。 */
export const VICTORY_KIND_NAME: Readonly<Record<VictoryKind, string>> = {
  conquest: '制圧',
  monument: '碑の写し',
  submission: '服属',
  draw: '引き分け',
};

/**
 * 勝敗の紋章に添える記号。
 *
 * `05§13-1`「勝った文明の紋章に月桂。**服属で終わった場合は旗を巻いた図**に変わります」。
 * アセット（M17）が入るまでは文字で表す。差し替え時はここだけ直せばよい。
 */
export const VICTORY_KIND_MARK: Readonly<Record<VictoryKind, string>> = {
  conquest: '🏆',
  monument: '🏆',
  submission: '🏳',
  draw: '—',
};

/** `detectVictoryKind` の入力（World から読める事実だけ）。 */
export interface VictoryFacts {
  /** 決着したか。 */
  readonly gameOver: boolean;
  /** 勝者 playerId（-1 = 引き分け / 未決着）。 */
  readonly winner: PlayerId;
  /** 勝者の記念碑が守り切られたか（`monumentRemainingTicks(w, winner) === 0`）。 */
  readonly winnerHeldMonument: boolean;
  /** 敗者の中に投了した者がいるか。 */
  readonly anyLoserResigned: boolean;
}

/**
 * 勝敗の種類を決める。
 *
 * 優先順は `03§10` の並びではなく「観測できる強さ」の順:
 *   1. 記念碑を守り切った  → 碑の写し（victory システムがこれで決着させた）
 *   2. 敗者が投了した      → 服属（旗を巻いた図）
 *   3. それ以外            → 制圧（町の中心の全喪失 / 忠誠度 0）
 */
export function detectVictoryKind(f: VictoryFacts): VictoryKind {
  if (!f.gameOver || f.winner < 0) return 'draw';
  if (f.winnerHeldMonument) return 'monument';
  if (f.anyLoserResigned) return 'submission';
  return 'conquest';
}

// ---------------------------------------------------------------------------
// 2. 順位（チーム戦はチーム単位）
// ---------------------------------------------------------------------------

/** 順位表の 1 行（プレイヤー単位。`team` で束ねて表示する）。 */
export interface RankRow {
  readonly place: number;
  readonly player: PlayerId;
  readonly team: number;
  readonly civ: CivId;
  readonly color: string;
  readonly won: boolean;
  readonly resigned: boolean;
  readonly kills: number;
  readonly losses: number;
  /** 採集量の合計（4 資源）。同点のときの並べ替えに使う。 */
  readonly gatheredTotal: number;
}

/** `rankRows` の入力（World を直接渡さずテストしやすくする）。 */
export interface RankInput {
  readonly players: readonly {
    readonly id: PlayerId;
    readonly civ: CivId;
    readonly team: number;
    readonly defeated: boolean;
    readonly resigned: boolean;
  }[];
  readonly winner: PlayerId;
  readonly stats: readonly PlayerStatsSnapshot[];
}

/**
 * 順位を作る（`05§13-2`「チーム戦ではチーム単位で並びます」）。
 *
 * 並べ方:
 *   1. **勝ったチームが先頭**（チーム単位。同じチームは連続して並ぶ）
 *   2. 次に、チーム内の生存者（`defeated` でない者）が多いチーム
 *   3. 次に、チームの撃破数の合計が多い順
 *   4. 最後に team 番号の小さい順（**同点を乱数で決めない**）
 * `place` は**チーム単位の順位**なので、同じチームの行は同じ番号になる。
 */
export function rankRows(inp: RankInput): RankRow[] {
  const statOf = (p: PlayerId): PlayerStatsSnapshot | undefined =>
    inp.stats.find((s) => s.player === p);

  // チームごとに集計する（`Map` の反復順に依存しないよう、team 番号昇順の配列で持つ）。
  const teams: number[] = [];
  for (const pl of inp.players) if (!teams.includes(pl.team)) teams.push(pl.team);
  teams.sort((a, b) => a - b);

  const winnerTeam =
    inp.winner >= 0 ? (inp.players.find((p) => p.id === inp.winner)?.team ?? -1) : -1;

  const summary = teams.map((team) => {
    const members = inp.players.filter((p) => p.team === team);
    let alive = 0;
    let kills = 0;
    for (const m of members) {
      if (!m.defeated) alive++;
      kills += statOf(m.id)?.kills ?? 0;
    }
    return { team, alive, kills, isWinner: team === winnerTeam };
  });

  summary.sort((a, b) => {
    if (a.isWinner !== b.isWinner) return a.isWinner ? -1 : 1;
    if (a.alive !== b.alive) return b.alive - a.alive;
    if (a.kills !== b.kills) return b.kills - a.kills;
    return a.team - b.team;
  });

  const out: RankRow[] = [];
  summary.forEach((s, i) => {
    const members = inp.players.filter((p) => p.team === s.team).sort((a, b) => a.id - b.id);
    for (const m of members) {
      const st = statOf(m.id);
      const gatheredTotal = (st?.gathered ?? []).reduce((a, b) => a + b, 0);
      out.push({
        place: i + 1,
        player: m.id,
        team: m.team,
        civ: m.civ,
        color: playerColor(m.id),
        won: s.isWinner,
        resigned: m.resigned,
        kills: st?.kills ?? 0,
        losses: st?.losses ?? 0,
        gatheredTotal,
      });
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// 5. 令ごとの成績（どのカードで勝ったか）
// ---------------------------------------------------------------------------

/** 表に出す令の行。 */
export interface OrderRow {
  readonly order: number;
  readonly name: string
  readonly kills: number;
  readonly losses: number;
  readonly buildingsDestroyed: number;
  readonly ticksActive: number;
  readonly issued: number;
  /** 固有令か（`05§7`「固有令は金の縁」と同じ扱い）。 */
  readonly unique: boolean;
}

/**
 * 令ごとの成績の行（**使った令だけ**を、撃破の多い順に）。
 *
 * 全 14 枚を常に並べると「使っていない令の 0 行」で表が埋まって
 * 「どのカードで勝ったか」が読めなくなるので、1 度でも出した令に絞る。
 */
export function orderRows(st: PlayerStatsSnapshot): OrderRow[] {
  const rows: OrderRow[] = [];
  for (const p of st.perOrder) {
    if (p.issued === 0 && p.ticksActive === 0 && p.kills === 0) continue;
    const def = ORDER_DEFS[p.order];
    rows.push({
      order: p.order,
      name: def?.name ?? p.orderId,
      kills: p.kills,
      losses: p.losses,
      buildingsDestroyed: p.buildingsDestroyed,
      ticksActive: p.ticksActive,
      issued: p.issued,
      unique: def?.civ !== null && def?.civ !== undefined,
    });
  }
  // 撃破 → 建物破壊 → 効いていた時間 → 令の並び順（固定順）でタイブレーク。
  rows.sort((a, b) => {
    if (a.kills !== b.kills) return b.kills - a.kills;
    if (a.buildingsDestroyed !== b.buildingsDestroyed)
      return b.buildingsDestroyed - a.buildingsDestroyed;
    if (a.ticksActive !== b.ticksActive) return b.ticksActive - a.ticksActive;
    return a.order - b.order;
  });
  return rows;
}

/**
 * 「どのカードで勝ったか」= 最も成果を挙げた令（無ければ null）。
 * `orderRows` の先頭だが、**撃破も建物破壊も 0 の令は勝因にしない**。
 */
export function bestOrderRow(st: PlayerStatsSnapshot): OrderRow | null {
  const rows = orderRows(st);
  const top = rows[0];
  if (top === undefined) return null;
  if (top.kills === 0 && top.buildingsDestroyed === 0) return null;
  return top;
}

// ---------------------------------------------------------------------------
// 6. 資源推移グラフの下ごしらえ
// ---------------------------------------------------------------------------

/** グラフに出す 1 本の線。 */
export interface GraphLine {
  readonly player: PlayerId;
  readonly color: string;
  readonly points: string;
}

/** グラフ全体。 */
export interface GraphModel {
  readonly box: GraphBox;
  readonly lines: readonly GraphLine[];
  readonly maxValue: number;
  readonly maxTick: number;
  /** 「線が離れた瞬間」の tick（-1 = 見つからない）。リプレイの頭出しに渡す。 */
  readonly divergenceTick: number;
}

/** 既定のグラフ枠（SVG の viewBox。CSS で幅 100% に伸ばす）。 */
export const DEFAULT_GRAPH_BOX: GraphBox = { width: 960, height: 220, padX: 8, padY: 10 };

/**
 * 資源推移グラフを組む（`05§13-6`）。
 *
 * 縦軸は**全プレイヤー共通の最大値**にする（プレイヤーごとに正規化すると
 * 「線が離れた」が見えなくなり、この項目の目的が消える）。
 */
export function graphModel(stats: MatchStatsSnapshot, box: GraphBox = DEFAULT_GRAPH_BOX): GraphModel {
  const ticks = stats.ticks;
  let maxValue = 0;
  for (const p of stats.players) for (const v of p.series) if (v > maxValue) maxValue = v;
  const maxTick = ticks.length > 0 ? ticks[ticks.length - 1]! : 0;

  const lines = stats.players.map((p) => ({
    player: p.player,
    color: playerColor(p.player),
    points: seriesPolyline(p.series, ticks, maxValue, maxTick, box),
  }));

  const di = divergenceSampleIndex(stats.players.map((p) => p.series));
  const divergenceTick = di >= 0 ? (ticks[di] ?? -1) : -1;
  return { box, lines, maxValue, maxTick, divergenceTick };
}

// ---------------------------------------------------------------------------
// 画面のモデル（World + 統計 → 表示に必要な値だけ）
// ---------------------------------------------------------------------------

/** 結果画面が表示するものすべて（DOM を作る前の段階）。 */
export interface ResultModel {
  readonly kind: VictoryKind;
  readonly winner: PlayerId;
  readonly winnerCiv: CivId | null;
  readonly rows: readonly RankRow[];
  readonly stats: MatchStatsSnapshot;
  readonly graph: GraphModel;
  /** 統計が不完全か（`MatchStats.sample` の呼び忘れ）。 */
  readonly statsIncomplete: boolean;
  /** 試合の長さ（`mm:ss`）。 */
  readonly clock: string;
}

/**
 * World（読み取り専用）と統計から画面モデルを作る。
 * `monumentRemainingTicks` は `victory.ts` の公開クエリ（UI 用）。
 */
export function buildResultModel(w: World, stats: MatchStatsSnapshot): ResultModel {
  const winner = w.winner;
  const anyLoserResigned = w.players.some((p) => p.resigned && p.id !== winner);
  const winnerHeldMonument = winner >= 0 && monumentRemainingTicks(w, winner) === 0;
  const kind = detectVictoryKind({
    gameOver: w.gameOver,
    winner,
    winnerHeldMonument,
    anyLoserResigned,
  });
  const rows = rankRows({
    players: w.players.map((p) => ({
      id: p.id,
      civ: p.civ,
      team: w.teams[p.id] ?? p.id,
      defeated: p.defeated,
      resigned: p.resigned,
    })),
    winner,
    stats: stats.players,
  });
  return {
    kind,
    winner,
    winnerCiv: winner >= 0 ? (w.players[winner]?.civ ?? null) : null,
    rows,
    stats,
    graph: graphModel(stats),
    statsIncomplete: stats.hasGap,
    clock: tickToClock(w.tick),
  };
}

/** 文明 ID → 表示名（未知はそのまま返す）。 */
export function civName(id: CivId | null): string {
  if (id === null) return '—';
  return CIV_DEFS.find((c) => c.id === id)?.name ?? id;
}

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

const SVG_NS = 'http://www.w3.org/2000/svg';

function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number>,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

/** 1. 勝敗の紋章。 */
function crestCard(m: ResultModel): HTMLElement {
  const card = el('div', 'mt-card mt-result-crest');
  card.appendChild(el('div', 'mt-crest-mark', VICTORY_KIND_MARK[m.kind]));
  card.appendChild(el('div', 'mt-crest-civ', civName(m.winnerCiv)));
  card.appendChild(el('div', 'mt-crest-kind', `${VICTORY_KIND_NAME[m.kind]}で決着`));
  card.appendChild(el('div', 'mt-dim', `試合時間 ${m.clock}`));
  if (m.kind === 'submission') {
    // 服属は滅亡ではない（`03§10` / `02`）。ここを書かないと「負け = 終わり」に見える。
    card.appendChild(el('div', 'mt-dim', '旗を巻いた降伏。滅亡ではない'));
  }
  return card;
}

/** 2 + 3. 順位と陣営色。 */
function rankCard(m: ResultModel): HTMLElement {
  const card = el('div', 'mt-card mt-result-rank');
  card.appendChild(el('div', 'mt-card-title', '順位（チーム戦はチーム単位）'));
  let prevPlace = -1;
  for (const r of m.rows) {
    const row = el('div', 'mt-rank-row');
    // 同じチームの 2 人目以降は順位番号を空にする（チーム単位であることを形で示す）
    row.appendChild(el('span', 'mt-rank-place', r.place === prevPlace ? '' : `${r.place} 位`));
    prevPlace = r.place;
    const sw = el('span', 'mt-side-swatch');
    sw.style.background = r.color;
    sw.title = `陣営色（試合中と同じ）`;
    row.appendChild(sw);
    const name = el('span', 'mt-rank-name', `${civName(r.civ)}（P${r.player + 1}）`);
    if (r.resigned) name.appendChild(el('span', 'mt-dim', ' 服属'));
    row.appendChild(name);
    row.appendChild(el('span', 'mt-num', `撃破 ${r.kills}`));
    row.appendChild(el('span', 'mt-num mt-dim', `損失 ${r.losses}`));
    card.appendChild(row);
  }
  return card;
}

/** 4. 内政の内訳（積み上げバー）。 */
function economyCard(m: ResultModel): HTMLElement {
  const card = el('div', 'mt-card');
  card.appendChild(el('div', 'mt-card-title', '内政の内訳（採集した 4 資源）'));

  // バーの合計幅は px ではなく「相対値」で持つ（固定幅にしない規約）。
  // 最大の採集量を 100% として、各プレイヤーのバー長を比で決める。
  let maxTotal = 1;
  for (const p of m.stats.players) {
    const t = p.gathered.reduce((a, b) => a + b, 0);
    if (t > maxTotal) maxTotal = t;
  }

  for (const r of m.rows) {
    const st = m.stats.players.find((s) => s.player === r.player);
    const gathered = st?.gathered ?? new Array<number>(RESOURCE_COUNT).fill(0);
    const total = gathered.reduce((a, b) => a + b, 0);
    const row = el('div', 'mt-eco-row');
    row.appendChild(el('span', 'mt-rank-name', `${civName(r.civ)}（P${r.player + 1}）`));

    const track = el('div', 'mt-stack');
    // 区間の比率は 100 分率で出し、外枠の幅を最大採集量に対する比にする。
    const segs = stackedSegments([...gathered], 100);
    const holder = el('div');
    holder.style.width = `${Math.round((total / maxTotal) * 100)}%`;
    holder.style.display = 'flex';
    holder.style.height = '100%';
    for (let i = 0; i < segs.length; i++) {
      const seg = el('div', 'mt-stack-seg');
      seg.style.width = `${segs[i]}%`;
      seg.style.background = resourceColor(i);
      seg.title = `${RESOURCE_GLYPHS[i] ?? ''} ${gathered[i] ?? 0}`;
      holder.appendChild(seg);
    }
    track.appendChild(holder);
    row.appendChild(track);
    row.appendChild(el('span', 'mt-num', `${total}`));
    card.appendChild(row);
  }

  const legend = el('div', 'mt-legend');
  for (let i = 0; i < RESOURCE_COUNT; i++) {
    const item = el('span', 'mt-legend-item');
    const sw = el('span', 'mt-legend-swatch');
    sw.style.background = RESOURCE_COLORS[i] ?? '#fff';
    item.appendChild(sw);
    item.appendChild(el('span', undefined, `${resourceGlyph(i)} ${RESOURCE_IDS[i] ?? ''}`));
    legend.appendChild(item);
  }
  card.appendChild(legend);
  card.appendChild(
    el('div', 'mt-graph-note', '緑（食料）が長いほど内政偏重、短いほど早い攻め。'),
  );
  return card;
}

/** 5. 戦闘の内訳 + 令ごとの成績。 */
function battleCard(m: ResultModel): HTMLElement {
  const card = el('div', 'mt-card');
  card.appendChild(el('div', 'mt-card-title', '戦闘の内訳と令ごとの成績'));

  const table = el('table', 'mt-battle-table');
  const head = el('tr');
  for (const h of ['対象', '撃破', '損失', '建物破壊']) head.appendChild(el('th', undefined, h));
  table.appendChild(head);

  for (const r of m.rows) {
    const st = m.stats.players.find((s) => s.player === r.player);
    if (st === undefined) continue;
    const tr = el('tr');
    const label = el('td');
    const sw = el('span', 'mt-side-swatch');
    sw.style.background = r.color;
    sw.style.display = 'inline-block';
    sw.style.marginRight = '6px';
    label.appendChild(sw);
    label.appendChild(el('span', undefined, `${civName(r.civ)}（P${r.player + 1}）`));
    tr.appendChild(label);
    tr.appendChild(el('td', undefined, `${st.kills}`));
    tr.appendChild(el('td', undefined, `${st.losses}`));
    tr.appendChild(el('td', undefined, `${st.buildingsDestroyed}`));
    table.appendChild(tr);

    // 令ごとの内訳（この行の下に続けて出す）。「どのカードで勝ったか」を金の縁で示す。
    const best = bestOrderRow(st);
    for (const o of orderRows(st)) {
      const otr = el('tr');
      if (best !== null && best.order === o.order) otr.className = 'mt-order-best';
      const oname = el('td', 'mt-dim');
      oname.textContent = `\u3000└ ${o.name}${o.unique ? '（固有）' : ''}`;
      otr.appendChild(oname);
      otr.appendChild(el('td', 'mt-dim', `${o.kills}`));
      otr.appendChild(el('td', 'mt-dim', `${o.losses}`));
      otr.appendChild(el('td', 'mt-dim', `${o.buildingsDestroyed}`));
      table.appendChild(otr);
    }
  }
  card.appendChild(table);
  card.appendChild(
    el('div', 'mt-graph-note', '金の縁が「そのプレイヤーがどのカードで勝ったか」。'),
  );
  return card;
}

/** 6. 資源推移グラフ。 */
function graphCard(m: ResultModel, onSeek: (tick: number) => void): HTMLElement {
  const card = el('div', 'mt-card');
  card.appendChild(el('div', 'mt-card-title', '資源推移（累計採集量）'));
  const g = m.graph;
  const root = svg('svg', {
    class: 'mt-graph',
    viewBox: `0 0 ${g.box.width} ${g.box.height}`,
    preserveAspectRatio: 'none',
    role: 'img',
  });
  // 目盛り（横 4 本）。色に頼らず「量が伸びている」ことを線で示す。
  for (let i = 1; i < 4; i++) {
    const y = g.box.padY + ((g.box.height - g.box.padY * 2) * i) / 4;
    root.appendChild(
      svg('line', {
        x1: g.box.padX,
        y1: y,
        x2: g.box.width - g.box.padX,
        y2: y,
        stroke: 'rgba(255,255,255,0.10)',
        'stroke-width': 1,
      }),
    );
  }
  // 「線が離れた瞬間」の縦線
  if (g.divergenceTick >= 0 && g.maxTick > 0) {
    const x = g.box.padX + (g.divergenceTick / g.maxTick) * (g.box.width - g.box.padX * 2);
    root.appendChild(
      svg('line', {
        x1: x,
        y1: g.box.padY,
        x2: x,
        y2: g.box.height - g.box.padY,
        stroke: '#e0b34a',
        'stroke-width': 2,
        'stroke-dasharray': '4 4',
      }),
    );
  }
  for (const line of g.lines) {
    if (line.points === '') continue;
    root.appendChild(
      svg('polyline', {
        points: line.points,
        fill: 'none',
        stroke: line.color,
        'stroke-width': 2,
      }),
    );
  }
  card.appendChild(root);

  if (g.divergenceTick >= 0) {
    const note = el('div', 'mt-graph-note');
    note.appendChild(
      el('span', undefined, `線が離れた瞬間: ${tickToClock(g.divergenceTick)}\u3000`),
    );
    note.appendChild(
      button('mt-btn', 'この時刻からリプレイ', () => onSeek(g.divergenceTick)),
    );
    card.appendChild(note);
  } else {
    card.appendChild(el('div', 'mt-graph-note', '差が開いた瞬間は見つからなかった。'));
  }
  return card;
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

/** 結果画面に渡す引数。 */
export interface ResultParams {
  /** 決着した World（**読むだけ**）。 */
  readonly world?: World;
  /** `MatchStats.snapshot()`。 */
  readonly stats?: MatchStatsSnapshot;
  /** キャンペーンの試合か（「次の話へ」を出すか）。 */
  readonly campaign?: boolean;
  /** リプレイ画面に渡す引数（`replay` 画面は M15）。 */
  readonly replayParams?: ScreenParams;
}

/** `ScreenParams` から `ResultParams` を取り出す（型は実行時に確かめる）。 */
function readParams(params: ScreenParams): ResultParams {
  const p = params as ResultParams;
  return {
    ...(p.world !== undefined ? { world: p.world } : {}),
    ...(p.stats !== undefined ? { stats: p.stats } : {}),
    ...(p.campaign !== undefined ? { campaign: p.campaign } : {}),
    ...(p.replayParams !== undefined ? { replayParams: p.replayParams } : {}),
  };
}

export const resultScreen: Screen = {
  mount(root: HTMLElement, nav: ScreenNav, params: ScreenParams): void {
    const p = readParams(params);
    const screen = el('div', 'mt-screen');

    const head = el('div', 'mt-screen-head');
    head.appendChild(el('span', 'mt-screen-title', '結果'));
    head.appendChild(el('span', 'mt-screen-sub', '勝敗は 制圧・碑の写し・服属 の 3 通り'));
    screen.appendChild(head);

    const body = el('div', 'mt-screen-body');
    screen.appendChild(body);

    if (p.world === undefined || p.stats === undefined) {
      // 直接この画面に来た場合（開発中の遷移確認など）。黙って空にしない。
      body.appendChild(
        el('div', 'mt-card', '結果を表示するには試合の World と統計が必要です（params.world / params.stats）。'),
      );
    } else {
      const m = buildResultModel(p.world, p.stats);
      if (m.statsIncomplete) {
        body.appendChild(
          el('div', 'mt-card mt-dim', '※ 統計の観測に抜けがあります（毎 tick のサンプリングが飛びました）。数字は目安です。'),
        );
      }
      const top = el('div', 'mt-result-top');
      top.appendChild(crestCard(m));
      top.appendChild(rankCard(m));
      body.appendChild(top);

      const cols = el('div', 'mt-result-cols');
      cols.appendChild(economyCard(m));
      cols.appendChild(battleCard(m));
      body.appendChild(cols);

      body.appendChild(
        graphCard(m, (tick) => {
          // 頭出しの tick を渡す（`replay` 画面は M15。未登録ならルータが警告を出す）。
          nav.go('replay', { ...(p.replayParams ?? {}), tick });
        }),
      );
    }

    // 7. 次へ
    const foot = el('div', 'mt-screen-foot');
    foot.appendChild(
      button('mt-btn is-primary', 'リプレイを見る', () => {
        nav.go('replay', { ...(p.replayParams ?? {}), tick: 0 });
      }),
    );
    foot.appendChild(button('mt-btn', '再戦する', () => nav.go('matchSetup')));
    if (p.campaign === true) {
      // **負けても次の話に続く**（`03§10` / `02`。この世界に滅亡はない）。
      foot.appendChild(button('mt-btn', 'キャンペーンの次の話へ', () => nav.go('campaign')));
    }
    foot.appendChild(button('mt-btn', 'タイトルへ', () => nav.go('title')));
    screen.appendChild(foot);

    root.appendChild(screen);
  },
};

/** 陣営色の一覧（テストと目視確認で「試合中と同じ色」を突き合わせるため公開）。 */
export const RESULT_SIDE_COLORS = PLAYER_COLORS;
