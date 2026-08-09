/**
 * T-M12-12: 結果画面（`05§13` の 7 項目）
 *
 * 完了条件「どのカードで勝ったかが出る」を数字で検証する。
 * DOM は触らず、`Result.ts` の純関数（勝敗の種類 / 順位 / 令ごとの成績 / グラフ）だけを見る。
 */

import { describe, expect, it } from 'vitest';
import type { CivId, PlayerId } from '@/shared/types';
import { ORDER_IDS } from '@/shared/types';
import { PLAYER_COLORS } from '@/render/palette';
import type { MatchStatsSnapshot, OrderPerf, PlayerStatsSnapshot } from '@/ui/stats';
import {
  VICTORY_KIND_MARK,
  VICTORY_KIND_NAME,
  bestOrderRow,
  civName,
  detectVictoryKind,
  graphModel,
  orderRows,
  rankRows,
} from '@/ui/screens/Result';

/** 令ごとの成績を全 14 件ぶん作る（指定したものだけ数字を入れる）。 */
function perOrder(overrides: Partial<Record<string, Partial<OrderPerf>>> = {}): OrderPerf[] {
  return ORDER_IDS.map((id, i) => ({
    order: i,
    orderId: id,
    kills: 0,
    losses: 0,
    buildingsDestroyed: 0,
    ticksActive: 0,
    issued: 0,
    ...(overrides[id] ?? {}),
  }));
}

function playerStats(p: PlayerId, o: Partial<PlayerStatsSnapshot> = {}): PlayerStatsSnapshot {
  return {
    player: p,
    gathered: [0, 0, 0, 0],
    kills: 0,
    losses: 0,
    buildingsDestroyed: 0,
    buildingsLost: 0,
    perOrder: perOrder(),
    orderLog: [],
    series: [],
    ...o,
  };
}

describe('Result: 勝敗の 3 通り（`03§10`）', () => {
  it('記念碑を守り切った → 碑の写し', () => {
    expect(
      detectVictoryKind({
        gameOver: true,
        winner: 0,
        winnerHeldMonument: true,
        anyLoserResigned: false,
      }),
    ).toBe('monument');
  });

  it('敗者が投了した → 服属（旗を巻いた図）', () => {
    const kind = detectVictoryKind({
      gameOver: true,
      winner: 0,
      winnerHeldMonument: false,
      anyLoserResigned: true,
    });
    expect(kind).toBe('submission');
    // `05§13-1`: 服属だけ紋章の記号が変わる
    expect(VICTORY_KIND_MARK.submission).not.toBe(VICTORY_KIND_MARK.conquest);
    expect(VICTORY_KIND_NAME.submission).toBe('服属');
  });

  it('それ以外 → 制圧', () => {
    expect(
      detectVictoryKind({
        gameOver: true,
        winner: 1,
        winnerHeldMonument: false,
        anyLoserResigned: false,
      }),
    ).toBe('conquest');
  });

  it('未決着・勝者なしは引き分け（滅亡という結末は無い）', () => {
    expect(
      detectVictoryKind({
        gameOver: false,
        winner: -1,
        winnerHeldMonument: false,
        anyLoserResigned: false,
      }),
    ).toBe('draw');
    expect(
      detectVictoryKind({
        gameOver: true,
        winner: -1,
        winnerHeldMonument: false,
        anyLoserResigned: false,
      }),
    ).toBe('draw');
  });

  it('碑の写しが投了より優先される（守り切った時点で決着している）', () => {
    expect(
      detectVictoryKind({
        gameOver: true,
        winner: 0,
        winnerHeldMonument: true,
        anyLoserResigned: true,
      }),
    ).toBe('monument');
  });
});

describe('Result: 順位（チーム戦はチーム単位）', () => {
  const civs: CivId[] = ['yamato', 'roma', 'tou', 'viking'];
  const mk = (id: number, team: number, defeated: boolean, resigned = false) => ({
    id: id as PlayerId,
    civ: civs[id]!,
    team,
    defeated,
    resigned,
  });

  it('勝ったチームが先頭に来て、同じチームは同じ順位になる', () => {
    const rows = rankRows({
      players: [mk(0, 0, false), mk(1, 1, true), mk(2, 0, false), mk(3, 1, true)],
      winner: 0 as PlayerId,
      stats: [0, 1, 2, 3].map((p) => playerStats(p as PlayerId)),
    });
    expect(rows.map((r) => r.player)).toEqual([0, 2, 1, 3]);
    expect(rows.map((r) => r.place)).toEqual([1, 1, 2, 2]);
    expect(rows[0]!.won).toBe(true);
    expect(rows[2]!.won).toBe(false);
  });

  it('陣営色は試合中と同じ（`render/palette` の値）', () => {
    const rows = rankRows({
      players: [mk(0, 0, false), mk(1, 1, true)],
      winner: 0 as PlayerId,
      stats: [playerStats(0 as PlayerId), playerStats(1 as PlayerId)],
    });
    expect(rows[0]!.color).toBe(PLAYER_COLORS[0]);
    expect(rows[1]!.color).toBe(PLAYER_COLORS[1]);
  });

  it('勝者がいないときは 生存者数 → 撃破数 → team 番号 の順（乱数を使わない）', () => {
    const rows = rankRows({
      players: [mk(0, 0, true), mk(1, 1, true), mk(2, 2, true)],
      winner: -1 as PlayerId,
      stats: [
        playerStats(0 as PlayerId, { kills: 1 }),
        playerStats(1 as PlayerId, { kills: 9 }),
        playerStats(2 as PlayerId, { kills: 9 }),
      ],
    });
    // 撃破 9 が 2 チーム。同点は team 番号の小さい方（P1）が先
    expect(rows.map((r) => r.player)).toEqual([1, 2, 0]);
  });

  it('投了した者に印が付く', () => {
    const rows = rankRows({
      players: [mk(0, 0, false), mk(1, 1, true, true)],
      winner: 0 as PlayerId,
      stats: [playerStats(0 as PlayerId), playerStats(1 as PlayerId)],
    });
    expect(rows.find((r) => r.player === 1)!.resigned).toBe(true);
  });
});

describe('Result: 令ごとの成績（どのカードで勝ったか）', () => {
  it('使った令だけを撃破の多い順に並べる', () => {
    const st = playerStats(0 as PlayerId, {
      perOrder: perOrder({
        charge: { kills: 12, issued: 3, ticksActive: 500 },
        hold: { kills: 2, issued: 1, ticksActive: 900 },
        raid: { kills: 0, issued: 1, ticksActive: 100 },
      }),
    });
    const rows = orderRows(st);
    expect(rows.map((r) => r.order)).toEqual([
      ORDER_IDS.indexOf('charge'),
      ORDER_IDS.indexOf('hold'),
      ORDER_IDS.indexOf('raid'),
    ]);
    // 出していない令は表に出さない（0 行で埋めない）
    expect(rows).toHaveLength(3);
  });

  it('最も成果を挙げた令が「どのカードで勝ったか」', () => {
    const st = playerStats(0 as PlayerId, {
      perOrder: perOrder({ charge: { kills: 4, issued: 1 }, siege: { kills: 9, issued: 1 } }),
    });
    expect(bestOrderRow(st)?.order).toBe(ORDER_IDS.indexOf('siege'));
  });

  it('撃破も建物破壊も 0 なら勝因にしない', () => {
    const st = playerStats(0 as PlayerId, {
      perOrder: perOrder({ build: { issued: 5, ticksActive: 3000 } }),
    });
    expect(bestOrderRow(st)).toBeNull();
  });

  it('固有令に印が付く（金の縁の対象。`05§7`）', () => {
    const st = playerStats(0 as PlayerId, {
      perOrder: perOrder({ jindate: { kills: 3, issued: 1 } }),
    });
    const row = orderRows(st).find((r) => r.order === ORDER_IDS.indexOf('jindate'));
    expect(row?.unique).toBe(true);
    const basic = playerStats(0 as PlayerId, {
      perOrder: perOrder({ charge: { kills: 1, issued: 1 } }),
    });
    expect(orderRows(basic)[0]!.unique).toBe(false);
  });
});

describe('Result: 資源推移グラフ', () => {
  const stats: MatchStatsSnapshot = {
    lastTick: 1000,
    ticks: [0, 250, 500, 750, 1000],
    hasGap: false,
    players: [
      playerStats(0 as PlayerId, { series: [0, 100, 200, 800, 900] }),
      playerStats(1 as PlayerId, { series: [0, 100, 200, 250, 300] }),
    ],
  };

  it('縦軸は全プレイヤー共通の最大値（差が見えるようにする）', () => {
    const g = graphModel(stats);
    expect(g.maxValue).toBe(900);
    expect(g.maxTick).toBe(1000);
    expect(g.lines).toHaveLength(2);
    expect(g.lines[0]!.points.split(' ')).toHaveLength(5);
  });

  it('「線が離れた瞬間」の tick が取れる（リプレイの頭出しに使う）', () => {
    const g = graphModel(stats);
    expect(g.divergenceTick).toBe(750);
  });

  it('標本が空でも壊れない', () => {
    const g = graphModel({ lastTick: 0, ticks: [], hasGap: false, players: [] });
    expect(g.lines).toHaveLength(0);
    expect(g.divergenceTick).toBe(-1);
  });
});

describe('Result: 文明名', () => {
  it('文明 ID から日本語名が引ける', () => {
    expect(civName('yamato')).not.toBe('yamato');
    expect(civName(null)).toBe('—');
  });
});
