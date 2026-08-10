import { describe, expect, it } from 'vitest';
import {
  CODEX_PAGES,
  PAGER_FILTER_CODES,
  PAGER_KEYS,
  barracksHtml,
  codexHtml,
  frontlineHtml,
  killBoardHtml,
  pagerClampPage,
  pagerEntryMatches,
  pagerPageCount,
  pagerSlice,
  pagerStatus,
  recRoomHtml,
  starMapSvg,
  statisticsHtml,
  type HubContext,
} from '../../src/ui/HubPanels';
import { newRoster } from '../../src/app/roster';
import { VEIL_PEOPLE, peopleOfFaction } from '../../src/content/veil/people';
import { VEIL_FACTIONS, VEIL_THEATERS } from '../../src/content/veil/world';
import { VEIL_CHAPTERS } from '../../src/content/veil/chapters';
import { DEFAULT_KEY_BINDINGS } from '../../src/app/settings';
import { protagonistDisplayName } from '../../src/ui/PilotSelectScene';

/**
 * T3-⑩ 艦内パネルの「切れ」／T3-⑫ 戦況マップの地図化。
 *
 * 検証の軸は2つ。
 * 1. 一覧が**切り捨てられていない**こと（HTML に出た項目数 = 元データの件数）
 * 2. ページ送りと絞り込みで**全件に到達できる**こと（総数とページ数の整合）
 */

/** `pagerHtml` が出した項目を、`ScreenHost` と同じ規則でタグへ戻す */
interface ParsedItem {
  tags: Record<string, string[]>;
}

interface ParsedPager {
  id: string;
  pageSize: number;
  items: ParsedItem[];
  filters: Array<{ key: string; code: string; options: Array<{ value: string; label: string }> }>;
}

function unescapeHtml(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function parsePagers(html: string): ParsedPager[] {
  const out: ParsedPager[] = [];
  // ページャの開始タグごとに、次の開始タグまでを1つぶんとして切る
  const heads = [...html.matchAll(/<div class="block mc-pager" data-mc-pager="([^"]+)" data-page-size="(\d+)" data-total="(\d+)">/g)];
  heads.forEach((head, i) => {
    const start = head.index ?? 0;
    const end = i + 1 < heads.length ? (heads[i + 1].index ?? html.length) : html.length;
    const chunk = html.slice(start, end);
    const items = [...chunk.matchAll(/<div class="mc-pager-item"((?: data-f-[a-z]+="[^"]*")*)>/g)].map((m) => {
      const tags: Record<string, string[]> = {};
      for (const attr of (m[1] ?? '').matchAll(/data-f-([a-z]+)="([^"]*)"/g)) {
        tags[attr[1]] = unescapeHtml(attr[2]).split(/\s+/).filter(Boolean);
      }
      return { tags };
    });
    const filters = [...chunk.matchAll(
      /data-mc-pager-filter="([^"]+)" data-mc-pager-code="([^"]+)" data-mc-pager-options="([^"]*)"/g,
    )].map((m) => ({
      key: m[1],
      code: m[2],
      options: JSON.parse(unescapeHtml(m[3])) as Array<{ value: string; label: string }>,
    }));
    out.push({ id: head[1], pageSize: Number(head[2]), items, filters });
  });
  return out;
}

function pagerById(html: string, id: string): ParsedPager {
  const found = parsePagers(html).find((p) => p.id === id);
  expect(found, `ページャ ${id} が出ていない`).toBeDefined();
  return found!;
}

/** ページを1枚ずつ送って集めた添字。到達できた項目の全体。 */
function reachableIndices(pager: ParsedPager, filter: Record<string, string> = {}): number[] {
  const visible = pager.items
    .map((it, i) => ({ it, i }))
    .filter(({ it }) => pagerEntryMatches(it.tags, filter))
    .map(({ i }) => i);
  const pages = pagerPageCount(visible.length, pager.pageSize);
  const seen: number[] = [];
  for (let page = 0; page < pages; page++) {
    seen.push(...pagerSlice(visible, pager.pageSize, page));
  }
  return seen;
}

function hubCtx(over: Partial<HubContext> = {}): HubContext {
  return {
    roster: newRoster(),
    totalKills: 12,
    sorties: 4,
    cleared: ['veil-ch01'],
    medals: [],
    chapter: 3,
    totalChapters: 10,
    ...over,
  };
}

describe('ページ送りの純関数', () => {
  it('0件でも1ページ、端数は切り上げる', () => {
    expect(pagerPageCount(0, 8)).toBe(1);
    expect(pagerPageCount(8, 8)).toBe(1);
    expect(pagerPageCount(9, 8)).toBe(2);
    expect(pagerPageCount(36, 8)).toBe(5);
  });

  it('ページ番号は範囲内に収める', () => {
    expect(pagerClampPage(-3, 5)).toBe(0);
    expect(pagerClampPage(9, 5)).toBe(4);
    expect(pagerClampPage(2, 5)).toBe(2);
  });

  it('全ページを合わせると元の並びに戻る（重複も欠落もない）', () => {
    const src = Array.from({ length: 36 }, (_, i) => i);
    const pages = pagerPageCount(src.length, 8);
    const joined = Array.from({ length: pages }, (_, p) => pagerSlice(src, 8, p)).flat();
    expect(joined).toEqual(src);
  });

  it('状態表示に総件数を必ず含める', () => {
    expect(pagerStatus(0, 5, 36, 36)).toBe('1 / 5 ページ　36 件');
    expect(pagerStatus(1, 2, 12, 36)).toBe('2 / 2 ページ　12 / 36 件');
  });

  it('絞り込みは未指定の鍵を無条件に通す', () => {
    const tags = { faction: ['confed'], chapter: ['1', '9'] };
    expect(pagerEntryMatches(tags, {})).toBe(true);
    expect(pagerEntryMatches(tags, { faction: '' })).toBe(true);
    expect(pagerEntryMatches(tags, { faction: 'confed' })).toBe(true);
    expect(pagerEntryMatches(tags, { faction: 'ordo' })).toBe(false);
    expect(pagerEntryMatches(tags, { chapter: '9' })).toBe(true);
    expect(pagerEntryMatches(tags, { chapter: '2' })).toBe(false);
    expect(pagerEntryMatches(undefined, { faction: 'confed' })).toBe(false);
  });
});

describe('操作キーの衝突', () => {
  it('ページ送りと絞り込みのキーは飛行操作の割り当てと重ならない', () => {
    const bound = new Set<string>(Object.values(DEFAULT_KEY_BINDINGS));
    // Tutorial.ts の「次へ」と ScreenHost の ▲▼/決定/戻る
    ['KeyB', 'ArrowUp', 'ArrowDown', 'KeyW', 'KeyS', 'Enter', 'NumpadEnter', 'Space', 'Escape'].forEach((c) =>
      bound.add(c),
    );
    for (const code of [PAGER_KEYS.prev, PAGER_KEYS.next, ...Object.values(PAGER_FILTER_CODES)]) {
      expect(bound.has(code), `${code} が既存操作と衝突している`).toBe(false);
    }
  });
});

describe('名鑑 — 全員に到達できる', () => {
  it('連邦36名が1枚の HTML に全員出ており、ページ送りで全員に到達できる', () => {
    const people = peopleOfFaction('confed');
    expect(people).toHaveLength(36);
    const html = codexHtml('people-confed', hubCtx());
    // 見出しの人数と、実際に出た項目数が一致する（「36名」と書いて3名しか無い状態を防ぐ）
    expect(html).toContain(`— ${people.length} 名`);
    const pager = pagerById(html, 'codex-people-confed');
    expect(pager.items).toHaveLength(people.length);
    // 全員の名前が HTML に含まれる
    // 表記は `speakerName()` 経由に統一したので、生の `p.name`
    // （`朝倉 澪（アサクラ ミオ）` 形式）ではなく表示名で確認する。
    // ここで整形を書き直すと出所が増えるので、画面と同じ関数を通す。
    for (const p of people) expect(html).toContain(protagonistDisplayName(p));
    // ページ送りで全員に到達する
    const reached = reachableIndices(pager);
    expect(reached).toHaveLength(people.length);
    expect(new Set(reached).size).toBe(people.length);
    expect(pagerPageCount(people.length, pager.pageSize)).toBe(Math.ceil(36 / pager.pageSize));
  });

  it('全76名ページでも件数とページ数が整合する', () => {
    const html = codexHtml('people-all', hubCtx());
    const pager = pagerById(html, 'codex-people-all');
    expect(pager.items).toHaveLength(VEIL_PEOPLE.length);
    expect(reachableIndices(pager)).toHaveLength(VEIL_PEOPLE.length);
  });

  it('顔画像を出す（生成済みの顔をそのまま使う）', () => {
    const html = codexHtml('people-confed', hubCtx());
    expect(html).toContain('mc-codex-face');
    // 顔は art/tex/face-<人物id>-<表情>.jpg を参照する（新規生成はしない）
    expect(html).toMatch(/art\/tex\/face-confed-01-neutral\.jpg/);
  });

  it('勢力・生死・章の絞り込みが効く', () => {
    const all = pagerById(codexHtml('people-all', hubCtx()), 'codex-people-all');
    expect(all.filters.map((f) => f.key)).toEqual(['faction', 'life', 'chapter']);

    // 勢力
    for (const f of VEIL_FACTIONS) {
      const want = VEIL_PEOPLE.filter((p) => p.faction === f.id).length;
      expect(reachableIndices(all, { faction: f.id })).toHaveLength(want);
    }
    // 章（第1章の cast のうち、人物idを持つ者の数）
    const ch1 = new Set(VEIL_CHAPTERS[0].cast.filter((c) => c.id).map((c) => c.id));
    expect(reachableIndices(all, { chapter: '1' })).toHaveLength(ch1.size);
    // 生死: 飛行隊に出せる人物だけが 'squad'
    const squad = reachableIndices(all, { life: 'squad' });
    expect(squad.length).toBeGreaterThan(0);
    expect(squad.length).toBeLessThan(VEIL_PEOPLE.length);
    // 絞り込みの合計は全件（すべての項目がどれかの生死区分に入る）
    const dead = reachableIndices(all, { life: 'dead' }).length;
    const other = reachableIndices(all, { life: 'other' }).length;
    expect(squad.length + dead + other).toBe(VEIL_PEOPLE.length);
  });

  it('戦死した隊員は名鑑でも戦死として絞り込める', () => {
    const roster = newRoster();
    roster.pilots[0].status = 'dead';
    const html = codexHtml('people-confed', hubCtx({ roster }));
    const pager = pagerById(html, 'codex-people-confed');
    expect(reachableIndices(pager, { life: 'dead' })).toHaveLength(1);
    expect(html).toContain('戦死');
  });

  it('機体と戦域のページも全件を出す', () => {
    const ships = pagerById(codexHtml('ships'), 'codex-ships');
    expect(ships.items.length).toBeGreaterThan(20);
    expect(reachableIndices(ships)).toHaveLength(ships.items.length);
    const theaters = pagerById(codexHtml('theaters'), 'codex-theaters');
    expect(theaters.items).toHaveLength(VEIL_THEATERS.length);
    expect(reachableIndices(theaters)).toHaveLength(VEIL_THEATERS.length);
  });

  it('名鑑のページ一覧に全76名ページが含まれる', () => {
    expect(CODEX_PAGES.map((p) => p.id)).toContain('people-all');
  });
});

describe('艦内パネル — 一覧が切り捨てられていない', () => {
  it('酒場は生存隊員を全員出す', () => {
    const ctx = hubCtx();
    const alive = ctx.roster.pilots.filter((p) => p.status === 'active' || p.status === 'wounded');
    const pager = pagerById(recRoomHtml(ctx), 'bar-talks');
    expect(pager.items).toHaveLength(alive.length);
    expect(reachableIndices(pager)).toHaveLength(alive.length);
  });

  it('自室の名簿は表示対象を全員出す', () => {
    const ctx = hubCtx();
    const pager = pagerById(barracksHtml(ctx), 'barracks-roster');
    expect(pager.items).toHaveLength(ctx.roster.pilots.length);
    expect(reachableIndices(pager)).toHaveLength(ctx.roster.pilots.length);
  });

  it('キルボードはプレイヤーを含む全行を出す', () => {
    const ctx = hubCtx();
    const pager = pagerById(killBoardHtml(ctx), 'kill-board');
    // 名簿の人数＋プレイヤー1名
    expect(pager.items).toHaveLength(ctx.roster.pilots.length + 1);
    expect(reachableIndices(pager)).toHaveLength(pager.items.length);
  });

  it('統計は一覧を持たないので全項目がそのまま出る', () => {
    const html = statisticsHtml(hubCtx({
      statistics: {
        missionsWon: 2,
        missionsLost: 1,
        shotsFired: 100,
        hits: 40,
        combatSeconds: 600,
        longestWingmanSurvival: 300,
        navsReached: 3,
        escortSuccesses: 1,
        escortAttempts: 2,
        rescuedWingmen: 1,
        abandonedWingmen: 0,
        campaignWins: 1,
        campaignLosses: 0,
        seriesScore: 5,
        advanceCount: 1,
        retreatCount: 0,
        shipsFlown: { hornet: 3 },
      } as unknown as NonNullable<HubContext['statistics']>,
    }));
    expect(html).toContain('飛行統計');
    expect(html).toContain('搭乗履歴');
  });
});

/** ページャの項目1件ぶんの HTML を、出た順に切り出す */
function itemChunks(html: string): string[] {
  const marks = [...html.matchAll(/<div class="mc-pager-item"[^>]*>/g)];
  return marks.map((m, i) => {
    const start = m.index ?? 0;
    const end = i + 1 < marks.length ? (marks[i + 1].index ?? html.length) : html.length;
    return html.slice(start, end);
  });
}

describe('酒場の描画 — 往復会話と関係値', () => {
  it('barTalk が無いときは従来の1行表示にフォールバックする', () => {
    const html = recRoomHtml(hubCtx());
    expect(html).not.toContain('mc-bar-talk');
    expect(html).toContain('mc-bar-row');
  });

  it('barTalk があると往復のやりとりを描き、返事はメニュー側に任せる', () => {
    const ctx = hubCtx();
    const pilot = ctx.roster.pilots[0];
    const html = recRoomHtml({
      ...ctx,
      barPilotId: pilot.id,
      barTalk: {
        pilotId: pilot.id,
        turns: [
          { speaker: 'pilot', text: '手紙が来ました。' },
          { speaker: 'player', text: 'それはよかった。' },
          { speaker: 'pilot', text: '次も後ろは任せます。' },
        ],
        replies: [
          { id: 'a', label: '任せろ' },
          { id: 'b', label: '無理はするな' },
        ],
        relation: { label: '信頼', step: 3, max: 4, reason: '直前の出撃: 救援要請に応えた' },
      },
    });
    expect(html).toContain('mc-bar-talk');
    expect(html).toContain('手紙が来ました。');
    expect(html).toContain('それはよかった。');
    expect(html).toContain('次も後ろは任せます。');
    // 話者が区別できる
    expect(html).toContain('mc-bar-turn pilot');
    expect(html).toContain('mc-bar-turn player');
    // 返事はメニュー側なので本文にボタンを作らない
    expect(html).not.toContain('mc-bar-reply"');
    expect(html).toContain('返事は下の「→」の項目から選ぶ（2 択）。');
    // 関係の段階と理由
    expect(html).toContain('関係 信頼');
    expect(html).toContain('直前の出撃: 救援要請に応えた');
    // その相手の行のゲージは 4 目盛りのうち 3 が点灯している
    const row = itemChunks(html).find((c) => c.includes('mc-bar-talk'))!;
    expect([...row.matchAll(/<i class="on"><\/i>/g)]).toHaveLength(3);
    expect([...row.matchAll(/<i(?: class="on")?><\/i>/g)]).toHaveLength(4);
  });

  it('会話が終わっていれば「終わった」と出す', () => {
    const ctx = hubCtx();
    const pilot = ctx.roster.pilots[0];
    const html = recRoomHtml({
      ...ctx,
      barPilotId: pilot.id,
      barTalk: {
        pilotId: pilot.id,
        turns: [{ speaker: 'pilot', text: 'また明日。' }],
        replies: [],
        relation: { label: '顔見知り', step: 2, max: 4 },
      },
    });
    expect(html).toContain('この話は終わった。');
  });

  it('会話中の相手は一覧の先頭に来る（ページ送りせずに読める）', () => {
    const ctx = hubCtx();
    const last = ctx.roster.pilots.filter((p) => p.status === 'active' || p.status === 'wounded').at(-1)!;
    const html = recRoomHtml({
      ...ctx,
      barPilotId: last.id,
      barTalk: {
        pilotId: last.id,
        turns: [{ speaker: 'pilot', text: '先頭に来るはず。' }],
        replies: [],
        relation: { label: '初対面', step: 1, max: 4 },
      },
    });
    const chunks = itemChunks(html);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]).toContain('先頭に来るはず。');
  });

  it('関係値は relationStage の5段階を使う（常に「——」にならない）', () => {
    const html = recRoomHtml(hubCtx());
    expect(html).not.toContain('関係 ——');
    expect(html).toMatch(/関係 (不信|初対面|顔見知り|信頼|盟友)/);
  });
});

describe('戦況マップ — 星系図', () => {
  const ctx = hubCtx({
    narrative: { returnees: 62, routeTrust: 48, commandTrust: 71, aceOath: 35 },
  });

  it('8戦域すべてが SVG に含まれ、名前は world.ts 由来である', () => {
    const svg = starMapSvg(ctx);
    expect(svg).toContain('<svg');
    expect(VEIL_THEATERS).toHaveLength(8);
    for (const t of VEIL_THEATERS) {
      expect(svg, `${t.id} が星系図に無い`).toContain(`data-theater="${t.id}"`);
      expect(svg, `${t.name} が星系図に無い`).toContain(t.name);
    }
    // 座標を持たない戦域を作っていない（= 8個ぶんのノードが出ている）
    expect([...svg.matchAll(/class="mc-starmap-node/g)]).toHaveLength(VEIL_THEATERS.length);
  });

  it('戦域名は world.ts の表記だけを使う（独自の名前を作らない）', () => {
    const svg = starMapSvg(ctx);
    const names = [...svg.matchAll(/class="mc-starmap-name"[^>]*>([^<]+)</g)].map((m) => m[1]);
    expect(names.sort()).toEqual(VEIL_THEATERS.map((t) => t.name).sort());
  });

  it('状態を色で表す（所有勢力の色と圧力の色）', () => {
    const svg = starMapSvg(ctx);
    // 所有勢力の色は VEIL_FACTIONS.color をそのまま使う
    for (const f of VEIL_FACTIONS) {
      if (!VEIL_THEATERS.some((t) => t.owner === f.id)) continue;
      expect(svg).toContain(`fill="${f.color}"`);
    }
    // 圧力『極高』のヴェガ門は封鎖色（赤）で囲む
    expect(svg).toContain('stroke="#ff5d5d"');
  });

  it('通ってきた章は実線、残りの章は破線で結ぶ', () => {
    const svg = starMapSvg(hubCtx({ chapter: 5 }));
    const past = [...svg.matchAll(/mc-starmap-route past/g)].length;
    const future = [...svg.matchAll(/mc-starmap-route future/g)].length;
    expect(past).toBeGreaterThan(0);
    expect(future).toBeGreaterThan(0);
    // 第1章では通過区間がまだ無い
    expect([...starMapSvg(hubCtx({ chapter: 1 })).matchAll(/mc-starmap-route past/g)]).toHaveLength(0);
  });

  it('現在地を強調する', () => {
    const svg = starMapSvg(hubCtx({ chapter: 5 }));
    expect(svg).toContain('mc-starmap-here');
    // 第5章の舞台（灰冠回廊）に現在地が付く
    const current = VEIL_CHAPTERS.find((c) => c.chapter === 5)!.theater;
    expect(svg).toMatch(new RegExp(`mc-starmap-node[^"]*current"[^>]*data-theater="${current}"`));
  });

  it('4状態を、それが効く場所の上に置く', () => {
    const svg = starMapSvg(ctx);
    for (const label of ['軍令信用', '帰還者', '航路信頼', '敵エースの誓約']) {
      expect(svg, `${label} が地図に無い`).toContain(label);
    }
    // 効く場所の注記
    expect(svg).toContain('司令部');
    expect(svg).toContain('セレシオン圏');
    expect(svg).toContain('オルド圏');
    expect(svg).toContain('キルラシー圏');
    // 値は narrative から取る
    expect(svg).toContain('>71<');
  });

  it('4状態が無いときは「記録なし」を出す（数字を捏造しない）', () => {
    const svg = starMapSvg(hubCtx());
    expect(svg).toContain('記録なし');
    expect(svg).not.toContain('mc-starmap-gauge-fill');
  });

  it('戦域一覧は8戦域すべてを出し、勢力と章で絞り込める', () => {
    const html = frontlineHtml(ctx);
    const pager = pagerById(html, 'frontline-theaters');
    expect(pager.items).toHaveLength(VEIL_THEATERS.length);
    expect(reachableIndices(pager)).toHaveLength(VEIL_THEATERS.length);
    expect(pager.filters.map((f) => f.key)).toEqual(['faction', 'chapter']);
    // 勢力で絞ると world.ts の owner と一致する数になる
    for (const f of VEIL_FACTIONS) {
      const want = VEIL_THEATERS.filter((t) => t.owner === f.id).length;
      expect(reachableIndices(pager, { faction: f.id })).toHaveLength(want);
    }
    expect(reachableIndices(pager, { faction: 'shared' })).toHaveLength(
      VEIL_THEATERS.filter((t) => t.owner === 'shared').length,
    );
    // 第5章の舞台は1箇所
    expect(reachableIndices(pager, { chapter: '5' })).toHaveLength(1);
  });

  it('凡例で色の意味を文字でも示す', () => {
    const html = frontlineHtml(ctx);
    expect(html).toContain('塗り＝所有勢力');
    expect(html).toContain('枠＝状態');
    expect(html).toContain('線＝章の順路');
  });
});
