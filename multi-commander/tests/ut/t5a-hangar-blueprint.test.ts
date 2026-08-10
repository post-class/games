import { describe, expect, it } from 'vitest';
import {
  barracksHtml,
  blueprintGeometry,
  hangarHtml,
  killBoardHtml,
  pilotDisplayName,
  recRoomHtml,
  type HubContext,
} from '../../src/ui/HubPanels';
import { protagonistDisplayName } from '../../src/ui/PilotSelectScene';
import { newRoster } from '../../src/app/roster';
import { veilPerson } from '../../src/content/veil/people';
import { PILOTS } from '../../src/content/pilots';
import { PLAYABLE_SHIPS, SHIPS, shipDef } from '../../src/content/ships';

/**
 * T5-⑬ 格納庫のシルエットの描き分け／パイロット表記の統一。
 *
 * 検証の軸は3つ。
 * 1. 選べる4機の図が**互いに異なる**こと
 * 2. 図の寸法が `src/content/ships.ts` の**実数値と同じ順序**になっていること
 *    （図が実データの写しであること。表示専用の定数で形を作っていない）
 * 3. パイロット名から**読みの括弧が消えている**こと
 */

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

const playable = PLAYABLE_SHIPS.map((id) => shipDef(id));

/** 格納庫の HTML から、機体ごとのブループリント図の主パスを取り出す */
function bodyPaths(html: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const card of html.matchAll(/data-ship-id="([^"]+)"([\s\S]*?)<\/article>/g)) {
    const body = /<path class="mc-bp-body" d="([^"]+)"/.exec(card[2]);
    expect(body, `${card[1]} に胴体のパスがある`).toBeTruthy();
    out.set(card[1], body![1]);
  }
  return out;
}

function countOf(svgOrHtml: string, re: RegExp): number {
  return [...svgOrHtml.matchAll(re)].length;
}

/** 1機ぶんのカードの中身 */
function cardOf(html: string, shipId: string): string {
  const m = new RegExp(`data-ship-id="${shipId}"([\\s\\S]*?)</article>`).exec(html);
  expect(m, `${shipId} のカードがある`).toBeTruthy();
  return m![1];
}

describe('格納庫のブループリント図が4機で描き分けられている', () => {
  const html = hangarHtml(hubCtx(), { shipId: 'hornet' }, 'hornet');

  it('選べる4機ぶんのカードが出る', () => {
    expect([...bodyPaths(html).keys()].sort()).toEqual([...PLAYABLE_SHIPS].sort());
  });

  it('4機の胴体のパスが互いに異なる', () => {
    const paths = [...bodyPaths(html).values()];
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('翼のパスも4機で互いに異なる', () => {
    const wings = PLAYABLE_SHIPS.map((id) => {
      const m = /<path class="mc-bp-wing" d="([^"]+)"/.exec(cardOf(html, id));
      return m?.[1] ?? '';
    });
    expect(new Set(wings).size).toBe(wings.length);
  });

  it('着手前の固定パス（3通りの星形・デルタ）が残っていない', () => {
    // 旧実装は visual.kind ごとの固定文字列だった。hornet=arrow / scimitar=delta /
    // raptor=twin-boom / rapier=delta なので delta 2機が同じ形になっていた。
    expect(html).not.toContain('M 48 8 L 61 42');
    expect(html).not.toContain('M 14 53 L 48 12');
    expect(html).not.toContain('M 16 28 L 42 40');
  });
});

describe('図の寸法が実数値の写しになっている', () => {
  it('速い機体のほうが前後に長い', () => {
    const bySpeed = [...playable].sort((a, b) => a.maxSpeed - b.maxSpeed);
    for (let i = 1; i < bySpeed.length; i++) {
      expect(blueprintGeometry(bySpeed[i]).halfLen).toBeGreaterThan(
        blueprintGeometry(bySpeed[i - 1]).halfLen,
      );
    }
  });

  it('装甲と船体が厚い機体のほうが胴が太い', () => {
    const bulk = (s: (typeof playable)[number]): number =>
      Object.values(s.armor).reduce((a, n) => a + n, 0) + s.hull;
    const byBulk = [...playable].sort((a, b) => bulk(a) - bulk(b));
    for (let i = 1; i < byBulk.length; i++) {
      expect(blueprintGeometry(byBulk[i]).halfWidth).toBeGreaterThan(
        blueprintGeometry(byBulk[i - 1]).halfWidth,
      );
    }
    // 最厚（ラプター）と最薄（ホーネット）で、はっきり差が付く
    expect(blueprintGeometry(shipDef('raptor')).halfWidth).toBeGreaterThan(
      blueprintGeometry(shipDef('hornet')).halfWidth * 2,
    );
  });

  it('旋回が速い機体のほうが翼が短い', () => {
    const byTurn = [...playable].sort((a, b) => a.turn[0] - b.turn[0]);
    for (let i = 1; i < byTurn.length; i++) {
      expect(blueprintGeometry(byTurn[i]).wingHalf).toBeLessThan(
        blueprintGeometry(byTurn[i - 1]).wingHalf,
      );
    }
  });

  it('当たり判定半径が大きい機体のほうが図も大きい', () => {
    const byRadius = [...playable].sort((a, b) => a.radius - b.radius);
    for (let i = 1; i < byRadius.length; i++) {
      expect(blueprintGeometry(byRadius[i]).scale).toBeGreaterThan(
        blueprintGeometry(byRadius[i - 1]).scale,
      );
    }
  });

  it('砲身の数が guns の数と一致し、位置は offset の写しになっている', () => {
    const html = hangarHtml(hubCtx(), { shipId: 'hornet' }, 'hornet');
    for (const s of playable) {
      const geo = blueprintGeometry(s);
      expect(geo.barrels).toHaveLength(s.guns.length);
      // 砲身の x は offset[0] に比例する（左右の並び順が実データと同じ）
      const order = (xs: number[]): number[] =>
        xs.map((_, i) => i).sort((a, b) => xs[a] - xs[b]);
      expect(order(geo.barrels)).toEqual(order(s.guns.map((g) => g.offset[0])));
      expect(countOf(cardOf(html, s.id), /class="mc-bp-barrel"/g)).toBe(s.guns.length);
    }
    // 4門のラプター／ラピアーと2門のホーネット／スミターで実際に差がある
    expect(blueprintGeometry(shipDef('raptor')).barrels).toHaveLength(4);
    expect(blueprintGeometry(shipDef('hornet')).barrels).toHaveLength(2);
  });

  it('パイロンの数がミサイルの種類数と一致する', () => {
    const html = hangarHtml(hubCtx(), { shipId: 'hornet' }, 'hornet');
    for (const s of playable) {
      expect(blueprintGeometry(s).pylons).toBe(s.missiles.length);
      expect(countOf(cardOf(html, s.id), /class="mc-bp-pylon"/g)).toBe(s.missiles.length);
    }
    // ホーネット1種 / スミターとラプター2種 / ラピアー3種
    expect(blueprintGeometry(shipDef('hornet')).pylons).toBe(1);
    expect(blueprintGeometry(shipDef('rapier')).pylons).toBe(3);
  });
});

describe('選べない定義を渡しても壊れない', () => {
  it('全機体（艦艇・輸送艦・敵機を含む）で例外にならず、寸法が有限で正の値になる', () => {
    for (const s of Object.values(SHIPS)) {
      const geo = blueprintGeometry(s);
      for (const [k, v] of Object.entries({
        halfLen: geo.halfLen,
        halfWidth: geo.halfWidth,
        wingHalf: geo.wingHalf,
        scale: geo.scale,
        engineR: geo.engineR,
      })) {
        expect(Number.isFinite(v), `${s.id}.${k}`).toBe(true);
        expect(v, `${s.id}.${k}`).toBeGreaterThan(0);
      }
      expect(geo.barrels.every((x) => Number.isFinite(x)), s.id).toBe(true);
      expect(geo.pylons, s.id).toBeGreaterThanOrEqual(0);
    }
  });

  it('艦艇でも砲身が図の外へ出ない（viewBox 0..100 に収まる）', () => {
    for (const s of Object.values(SHIPS)) {
      const geo = blueprintGeometry(s);
      const half = (geo.halfWidth + geo.wingHalf) * geo.scale;
      expect(50 - half, s.id).toBeGreaterThanOrEqual(0);
      expect(50 + half, s.id).toBeLessThanOrEqual(100);
      for (const x of geo.barrels) {
        expect(Math.abs(x) * geo.scale, s.id).toBeLessThanOrEqual(50);
      }
    }
  });
});

describe('パイロット表記が名鑑と揃っている', () => {
  /** `桐谷 綾（キリタニ アヤ）` のような読みの括弧 */
  const READING = /（[ぁ-んァ-ヶー・　\sA-Za-z]+）/;

  it('酒場・自室・キルボードに読みの括弧が出ない', () => {
    const ctx = hubCtx();
    for (const [label, html] of [
      ['酒場', recRoomHtml(ctx)],
      ['自室', barracksHtml(ctx)],
      ['キルボード', killBoardHtml(ctx)],
    ] as const) {
      expect(READING.test(html), `${label}: ${READING.exec(html)?.[0] ?? ''}`).toBe(false);
    }
  });

  it('酒場に整形後の名前とコールサインの両方が出る（コールサインは消さない）', () => {
    const ctx = hubCtx();
    const html = recRoomHtml(ctx);
    const sable = PILOTS.find((p) => p.id === 'sable')!;
    // `pilots.ts` の生の値は読み括弧つき。整形後だけが画面に出る
    expect(sable.name).toMatch(READING);
    expect(html).toContain(sable.name.replace(READING, ''));
    expect(html).not.toContain(sable.name);
    expect(html).toContain(sable.callsign);
  });

  it('自室の名簿でも同じ整形が使われる', () => {
    const ctx = hubCtx();
    const html = barracksHtml(ctx);
    // 名簿に載るのは在籍している隊員だけ（`PILOTS` 8名のうち初期配属の5名）
    const listed = ctx.roster.pilots.map((p) => PILOTS.find((x) => x.id === p.id)!);
    expect(listed.length).toBeGreaterThan(0);
    for (const p of listed) {
      expect(html).toContain(p.name.replace(READING, ''));
      expect(html).not.toContain(p.name);
    }
  });

  it('名鑑（protagonistDisplayName）と同じ結果になる', () => {
    for (const p of PILOTS) {
      expect(pilotDisplayName(p)).toBe(protagonistDisplayName(veilPerson(p.personId)));
    }
  });

  it('personId が無い／名簿に無い定義は従来表記へフォールバックする', () => {
    expect(pilotDisplayName({ name: '名無し（ナナシ）' })).toBe('名無し（ナナシ）');
    expect(pilotDisplayName({ personId: '', name: '名無し（ナナシ）' })).toBe('名無し（ナナシ）');
    expect(pilotDisplayName({ personId: 'no-such-person', name: '名無し（ナナシ）' })).toBe(
      '名無し（ナナシ）',
    );
  });

  it('戦死者の「空いた席」も整形される', () => {
    const roster = newRoster();
    roster.pilots[0].status = 'dead';
    roster.pilots[0].diedIn = '第3章';
    const html = recRoomHtml(hubCtx({ roster }));
    expect(html).toContain('空いた席');
    expect(READING.test(html)).toBe(false);
  });
});
