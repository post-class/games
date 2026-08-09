/**
 * T-M14-06: デシンク検出の表示（`07§12` / 手順書 §4.5）
 *
 * vitest の environment は `node`（jsdom なし）なので、**DOM を触らない部分だけ**を試す。
 * `DesyncOverlay` の見た目の確認は親（人間）が実機で行う。
 *
 * 見るべきこと:
 *  1. 出すのは「**どの tick で / 誰と誰が / どんな値が違ったか**」の 3 点
 *  2. **「どちらが正しい」を作らない**（多数派を勝ちにしない）
 *  3. ハッシュは `formatHash` の 16 進 8 桁で見せる（桁のずれを目で追える）
 */

import { describe, expect, it } from 'vitest';
import { formatHash } from '@/sim';
import { describeDesync, isRealDesync } from '@/ui/hud/desync';

describe('describeDesync', () => {
  it('どの tick で / 誰と誰が / どんな値が違ったかを並べる', () => {
    const view = describeDesync(
      { tick: 250, hashes: { 1: 0x0badf00d, 0: 0x12345678 } },
      { localPlayerId: 0, names: { 0: 'ヤマト', 1: 'モンゴル' } },
    );
    expect(view.tick).toBe(250);
    expect(view.atSeconds).toBe(10); // 250 tick = 10 秒（`HASH_CHECK_INTERVAL_TICKS`）
    // playerId 昇順（受信した順に依存しない）
    expect(view.rows.map((r) => r.playerId)).toEqual([0, 1]);
    expect(view.rows.map((r) => r.name)).toEqual(['ヤマト', 'モンゴル']);
    expect(view.rows.map((r) => r.hash)).toEqual([formatHash(0x12345678), formatHash(0x0badf00d)]);
    expect(view.rows[0]!.isLocal).toBe(true);
    expect(view.rows[1]!.isLocal).toBe(false);
  });

  it('名前が無ければ P0 / P1 で出す', () => {
    const view = describeDesync({ tick: 500, hashes: { 0: 1, 1: 2 } });
    expect(view.rows.map((r) => r.name)).toEqual(['P0', 'P1']);
    expect(view.rows.every((r) => r.isLocal === false)).toBe(true);
  });

  it('値ごとに陣営を並べるだけで、正しい側を決めない', () => {
    const view = describeDesync({ tick: 750, hashes: { 0: 0xaa, 1: 0xaa, 2: 0xbb } });
    // 2 対 1 でも「多数派が正しい」とは書かない
    expect(view.groups).toEqual([
      { hash: formatHash(0xaa), playerIds: [0, 1] },
      { hash: formatHash(0xbb), playerIds: [2] },
    ]);
    const all = [view.title, ...view.lines].join(' ');
    expect(all).toContain('どちらの端末が正しいかは分かりません');
    expect(all).toContain('試合を停止');
    // 「勝ち」「正解」「あなたが正しい」のような判定を作っていない
    expect(all).not.toMatch(/正しいのは|勝ち|あなたが正しい/);
  });

  it('陣営の並びは 16 進文字列の昇順で固定（Map の挿入順に依らない）', () => {
    const a = describeDesync({ tick: 250, hashes: { 0: 0xff, 1: 0x11 } });
    const b = describeDesync({ tick: 250, hashes: { 1: 0x11, 0: 0xff } });
    expect(a.groups).toEqual(b.groups);
    expect(a.groups.map((g) => g.hash)).toEqual([formatHash(0x11), formatHash(0xff)]);
  });

  it('本文に tick と秒数が入る（どこでずれたかが分かる）', () => {
    const view = describeDesync({ tick: 45_000, hashes: { 0: 1, 1: 2 } });
    expect(view.lines[0]).toContain('tick 45000');
    expect(view.lines[0]).toContain('1800 秒');
  });
});

describe('isRealDesync', () => {
  it('値が食い違っていれば true', () => {
    expect(isRealDesync({ tick: 250, hashes: { 0: 1, 1: 2 } })).toBe(true);
  });

  it('全員一致・1 人だけなら false（通知の誤り）', () => {
    expect(isRealDesync({ tick: 250, hashes: { 0: 7, 1: 7, 2: 7 } })).toBe(false);
    expect(isRealDesync({ tick: 250, hashes: { 0: 7 } })).toBe(false);
    expect(isRealDesync({ tick: 250, hashes: {} })).toBe(false);
  });
});
