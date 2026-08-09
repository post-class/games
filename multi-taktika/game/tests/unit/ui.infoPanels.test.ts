/**
 * T-M12-13: 情報パネル群（`06§8` の全項目）
 *
 * 検証すること:
 *  - `L` 相手の人口と時代が**推定値**（見えている範囲からしか数えない。`07§7`）
 *  - `G` 残量の集計（未探索の埋蔵量は出さない）
 *  - `N` **あと何が足りないかだけ**（満たしている条件は返さない）
 *  - `Y` 令の履歴が「出した → 届いた」の形
 *  - `Alt` 他の入力と組み合わせたら情報表示は出ない / トグル設定なら長押し不要
 *  - カーソルの説明: 何に強いか（役割）/ 暗いボタンの理由 3 種
 *
 * DOM は触らない（純関数だけ）。
 */

import { describe, expect, it } from 'vitest';
import { EntityKind, RESOURCE_IDS, type PlayerId } from '@/shared/types';
import { entityIndex, spawnEntity } from '@/sim/core/entity';
import { fx, fxFromInt } from '@/sim/core/fx';
import { buildingDefById, unitDefById, unitIndex } from '@/sim/core/defs';
import { PROGRESS_DONE, markModifiersDirty } from '@/sim/core/effects';
import { RESOURCE_NODE_DEFS, resourceNodeIndex } from '@/sim/core/gather';
import { createWorld, frontIndex, type World } from '@/sim/core/world';
import { VisionBuffer, VisionState } from '@/render/vision';
import { DisabledReason } from '@/ui/hud/commandGrid';
import {
  INFO_PANELS,
  ageAdvanceInfo,
  ageName,
  disabledReasonDetail,
  orderHistoryLines,
  panelForKey,
  remainingColor,
  resourceNodeViews,
  resourceRemainingRows,
  roleName,
  scoreRows,
  shouldShowAltInfo,
  unitMatchup,
} from '@/ui/hud/infoPanels';
import type { MatchStatsSnapshot } from '@/ui/stats';

const MAP = 60;

function makeWorld(playerCount = 2): World {
  const w = createWorld({
    seed: 3,
    playerCount,
    mapWidthTiles: MAP,
    mapHeightTiles: MAP,
    entityCapacity: 256,
  });
  w.map.tiles = new Uint8Array(MAP * MAP);
  w.map.passable = new Uint8Array(MAP * MAP).fill(1);
  w.map.elevation = new Uint8Array(MAP * MAP);
  return w;
}

function putUnit(w: World, owner: number, tx: number, ty: number, id = 'clubman'): number {
  const d = unitDefById(id);
  return entityIndex(
    spawnEntity(w.entities, {
      kind: EntityKind.Unit,
      owner,
      typeId: d.index,
      x: fxFromInt(tx),
      y: fxFromInt(ty),
      hpMax: d.hp,
    }),
  );
}

function putBuilding(w: World, id: string, owner: number, tx: number, ty: number): number {
  const d = buildingDefById(id);
  const i = entityIndex(
    spawnEntity(w.entities, {
      kind: EntityKind.Building,
      owner,
      typeId: d.index,
      x: fxFromInt(tx),
      y: fxFromInt(ty),
      hpMax: d.hp,
    }),
  );
  w.entities.buildProgress[i] = PROGRESS_DONE;
  markModifiersDirty(w, owner);
  return i;
}

function putNode(w: World, nodeId: string, tx: number, ty: number, amount: number): number {
  const t = resourceNodeIndex(nodeId);
  const i = entityIndex(
    spawnEntity(w.entities, {
      kind: EntityKind.Resource,
      owner: 255,
      typeId: t,
      x: fxFromInt(tx),
      y: fxFromInt(ty),
      hpMax: fx(1),
    }),
  );
  w.entities.amount[i] = fx(amount);
  return i;
}

/** 全面を可視にした視界。 */
function fullVision(w: World): VisionBuffer {
  const v = VisionBuffer.forMap(w.map);
  v.state.fill(VisionState.Visible);
  return v;
}

/** 全面を未探索にした視界。 */
function blindVision(w: World): VisionBuffer {
  return VisionBuffer.forMap(w.map);
}

describe('infoPanels: パネルとキー', () => {
  it('`06§8` の 4 パネルが L / G / N / Y に対応する', () => {
    expect(INFO_PANELS.map((p) => p.key)).toEqual(['L', 'G', 'N', 'Y']);
    expect(panelForKey('l')).toBe('score');
    expect(panelForKey('G')).toBe('resources');
    expect(panelForKey('n')).toBe('age');
    expect(panelForKey('y')).toBe('orders');
    expect(panelForKey('Q')).toBeNull();
  });
});

describe('infoPanels: `Alt` の情報表示', () => {
  it('長押し設定: `Alt` 単独なら出る', () => {
    expect(
      shouldShowAltInfo({ altDown: true, otherInputActive: false, toggleMode: false, toggled: false }),
    ).toBe(true);
  });

  it('長押し設定: 他の入力と組み合わせたら出ない（修飾キーとして働く。`06§8`）', () => {
    expect(
      shouldShowAltInfo({ altDown: true, otherInputActive: true, toggleMode: false, toggled: false }),
    ).toBe(false);
  });

  it('トグル設定: 押していなくても出る（長押しが不要になる。`06§12`）', () => {
    expect(
      shouldShowAltInfo({ altDown: false, otherInputActive: true, toggleMode: true, toggled: true }),
    ).toBe(true);
    expect(
      shouldShowAltInfo({ altDown: true, otherInputActive: false, toggleMode: true, toggled: false }),
    ).toBe(false);
  });
});

describe('infoPanels: `L` 戦績（相手は推定値）', () => {
  it('自分は実数、相手は推定値の印が付く', () => {
    const w = makeWorld(2);
    w.players[0]!.pop = 12;
    w.players[0]!.popCap = 20;
    const rows = scoreRows(w, 0 as PlayerId, fullVision(w));
    expect(rows[0]!.estimated).toBe(false);
    expect(rows[0]!.pop).toBe(12);
    expect(rows[1]!.estimated).toBe(true);
  });

  it('見えていない敵の兵は人口に数えない（`07§7`）', () => {
    const w = makeWorld(2);
    putUnit(w, 1, 30, 30);
    putUnit(w, 1, 31, 30);
    const seen = scoreRows(w, 0 as PlayerId, fullVision(w))[1]!;
    const unseen = scoreRows(w, 0 as PlayerId, blindVision(w))[1]!;
    expect(seen.pop).toBeGreaterThan(0);
    expect(unseen.pop).toBe(0);
  });

  it('敵の時代は見えた建物・兵から推定する', () => {
    const w = makeWorld(2);
    w.players[1]!.age = 3; // 実際は帝国の世
    putBuilding(w, 'town_center', 1, 20, 20); // 黎明の世の建物しか見えていない
    const rows = scoreRows(w, 0 as PlayerId, fullVision(w));
    expect(rows[1]!.age).toBe(buildingDefById('town_center').age);
    expect(rows[1]!.age).toBeLessThan(3);
  });

  it('視界が null（観戦・リプレイ）なら推定ではなく実数', () => {
    const w = makeWorld(2);
    w.players[1]!.pop = 7;
    const rows = scoreRows(w, 0 as PlayerId, null);
    expect(rows[1]!.estimated).toBe(false);
  });

  it('立っている戦域の数を数える', () => {
    const w = makeWorld(2);
    w.fronts[frontIndex(0 as PlayerId, 1)]!.active = true;
    w.fronts[frontIndex(0 as PlayerId, 3)]!.active = true;
    expect(scoreRows(w, 0 as PlayerId, null)[0]!.fronts).toBe(2);
  });

  it('時代名が 4 つ揃っている', () => {
    expect([0, 1, 2, 3].map(ageName)).toEqual(['黎明の世', '青銅の世', '鉄器の世', '帝国の世']);
  });
});

describe('infoPanels: `N` 時代進化の条件', () => {
  it('足りないものだけを返す（満たしている条件は返さない）', () => {
    const w = makeWorld(1);
    const info = ageAdvanceInfo(w, 0 as PlayerId);
    expect(info.nextAge).toBe(1);
    // 開始直後は資源も建物も足りない
    expect(info.missing.length).toBeGreaterThan(0);
    expect(info.missing.some((m) => m.kind === 'resource')).toBe(true);
    expect(info.missing.some((m) => m.kind === 'buildings')).toBe(true);
  });

  it('資源を満たすとその行が消える（あと何が足りないかだけ）', () => {
    const w = makeWorld(1);
    for (let r = 0; r < RESOURCE_IDS.length; r++) w.players[0]!.resources[r] = fx(99999);
    const info = ageAdvanceInfo(w, 0 as PlayerId);
    expect(info.missing.some((m) => m.kind === 'resource')).toBe(false);
    expect(info.missing.some((m) => m.kind === 'buildings')).toBe(true);
  });

  it('全部満たすと空（= いま進化できる）', () => {
    const w = makeWorld(1);
    for (let r = 0; r < RESOURCE_IDS.length; r++) w.players[0]!.resources[r] = fx(99999);
    putBuilding(w, 'town_center', 0, 10, 10);
    putBuilding(w, 'house', 0, 14, 10);
    const info = ageAdvanceInfo(w, 0 as PlayerId);
    expect(info.missing).toEqual([]);
  });

  it('最終時代では nextAge が -1', () => {
    const w = makeWorld(1);
    w.players[0]!.age = 3;
    expect(ageAdvanceInfo(w, 0 as PlayerId).nextAge).toBe(-1);
  });
});

describe('infoPanels: `G` 資源の残量', () => {
  it('残量の比が取れる（枯れかけが分かる）', () => {
    const w = makeWorld(1);
    const def = RESOURCE_NODE_DEFS[resourceNodeIndex('forest')]!;
    const full = Math.round(def.deposit / 256);
    putNode(w, 'forest', 10, 10, full);
    putNode(w, 'forest', 12, 10, Math.round(full / 4));
    const views = resourceNodeViews(w, fullVision(w));
    expect(views).toHaveLength(2);
    expect(views[0]!.ratio).toBeCloseTo(1, 2);
    expect(views[1]!.ratio).toBeLessThan(0.4);
  });

  it('未探索の場所の埋蔵量は出さない（`07§7`）', () => {
    const w = makeWorld(1);
    putNode(w, 'forest', 10, 10, 50);
    expect(resourceNodeViews(w, blindVision(w))).toHaveLength(0);
    expect(resourceNodeViews(w, null)).toHaveLength(1);
  });

  it('資源ごとに集計して常に 4 行返す', () => {
    const w = makeWorld(1);
    putNode(w, 'forest', 10, 10, 60);
    putNode(w, 'forest', 11, 10, 40);
    const rows = resourceRemainingRows(resourceNodeViews(w, null));
    expect(rows).toHaveLength(4);
    const wood = rows[RESOURCE_IDS.indexOf('wood')]!;
    expect(wood.nodes).toBe(2);
    expect(wood.remaining).toBe(100);
  });

  it('残量の色は資源色をもとにした rgba（色を新しく作らない）', () => {
    expect(remainingColor(0, 1)).toMatch(/^rgba\(\d+,\d+,\d+,[\d.]+\)$/);
    // 枯れかけの方が薄い
    const a = Number(/,([\d.]+)\)$/.exec(remainingColor(0, 1))![1]!);
    const b = Number(/,([\d.]+)\)$/.exec(remainingColor(0, 0))![1]!);
    expect(a).toBeGreaterThan(b);
  });
});

describe('infoPanels: `Y` 令の履歴', () => {
  const stats: MatchStatsSnapshot = {
    lastTick: 1000,
    ticks: [],
    hasGap: false,
    players: [
      {
        player: 0 as PlayerId,
        gathered: [0, 0, 0, 0],
        kills: 0,
        losses: 0,
        buildingsDestroyed: 0,
        buildingsLost: 0,
        perOrder: [],
        series: [],
        orderLog: [
          { slot: 1, order: 0, orderId: 'charge', tier: 'upper', issuedTick: 250, deliveredTick: 300 },
          { slot: 3, order: 2, orderId: 'hold', tier: 'upper', issuedTick: 800, deliveredTick: -1 },
        ],
      },
    ],
  };

  it('新しいものが先で、出した時刻と届いた時刻の両方が出る', () => {
    const lines = orderHistoryLines(stats, 0 as PlayerId);
    expect(lines).toHaveLength(2);
    expect(lines[0]!.slot).toBe(3);
    expect(lines[1]!.text).toContain('出した');
    expect(lines[1]!.text).toContain('届いた');
  });

  it('届いていない令は「未着」と出る（遅延を隠さない）', () => {
    expect(orderHistoryLines(stats, 0 as PlayerId)[0]!.text).toContain('未着');
  });

  it('戦域の識別は色 + 形 + 番号（`06§12`）', () => {
    const l = orderHistoryLines(stats, 0 as PlayerId)[0]!;
    expect(l.slotColor).toMatch(/^#/);
    expect(l.slotShape.length).toBeGreaterThan(0);
    expect(l.slot).toBe(3);
  });

  it('統計が無ければ空', () => {
    expect(orderHistoryLines(null, 0 as PlayerId)).toEqual([]);
  });
});

describe('infoPanels: カーソルの説明', () => {
  it('「この兵は何に強いか」が役割で出る', () => {
    const m = unitMatchup(unitIndex('clubman'));
    expect(m.name.length).toBeGreaterThan(0);
    expect(m.role.length).toBeGreaterThan(0);
    expect(m.stats).toContain('体');
    // 相性表に載っている役割は必ず何かしら出る
    expect(m.strongAgainst.length + m.weakAgainst.length).toBeGreaterThan(0);
    expect(m.summary).toContain('強い');
  });

  it('役割名が日本語で出る', () => {
    expect(roleName('cavalry')).toBe('騎兵');
    expect(roleName('unknown_role')).toBe('unknown_role');
  });

  it('暗いボタンの理由は 3 種（`05§15`）', () => {
    expect(disabledReasonDetail(DisabledReason.Age)).toContain('時代');
    expect(disabledReasonDetail(DisabledReason.Civ)).toContain('文明');
    expect(disabledReasonDetail(DisabledReason.Resource)).toContain('資源');
    expect(disabledReasonDetail(DisabledReason.None)).toBe('');
  });

  it('資源不足のときは足りない資源だけを名指しする', () => {
    const s = disabledReasonDetail(DisabledReason.Resource, [1, 2]);
    expect(s).toContain('木');
    expect(s).toContain('石');
    expect(s).not.toContain('金');
  });
});
