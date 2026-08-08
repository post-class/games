/**
 * 右下の丸いアクションボタン3つ（E-2）の「押せる／押せない」判定。
 *
 * ここで守りたいのは**サーバと同じ基準で押せなくすること**。
 * クライアントが甘い値を持てば「押せたのに『遠くて手がとどきません』が返る」ことになり、
 * 厳しい値を持てば「サーバは受けるのに押せない」ことになる。
 * しきい値はペット1.2（`petAction.ts` の ACT_RANGE）／資源2（`interact.ts` の INTERACT_RANGE）。
 */
import { describe, expect, it } from 'vitest';
import {
  INTERACT_COOLDOWN_MS,
  PET_REACH,
  RESOURCE_REACH,
  actionTitle,
  pickPetTarget,
  pickResourceTarget,
  resolveAction,
  type ResourceLike,
} from '../../packages/client/src/ui/actionButtons.ts';

const SELF = { x: 10, y: 10 };

function res(over: Partial<ResourceLike> & { id: number }): ResourceLike {
  return { type: 'berry_tree', x: 10, y: 10, amount: 3, ...over };
}

describe('E-2 撫でる対象', () => {
  it('しきい値はサーバと同じ1.2タイル', () => {
    expect(PET_REACH).toBe(1.2);
  });

  it('範囲内なら entityId を返す', () => {
    expect(pickPetTarget(SELF, { id: 7, x: 11, y: 10 })).toBe(7);
  });

  it('境界（ちょうど1.2）は届く扱い（サーバが `<=` で判定しているため）', () => {
    expect(pickPetTarget(SELF, { id: 7, x: 11.2, y: 10 })).toBe(7);
  });

  it('範囲外は null', () => {
    expect(pickPetTarget(SELF, { id: 7, x: 11.3, y: 10 })).toBeNull();
  });

  it('ペットが居なければ null（タマゴ選択中）', () => {
    expect(pickPetTarget(SELF, null)).toBeNull();
  });
});

describe('E-2 資源の対象', () => {
  it('しきい値はサーバと同じ2タイル', () => {
    expect(RESOURCE_REACH).toBe(2);
  });

  it('範囲内でいちばん近いものを選ぶ', () => {
    const target = pickResourceTarget('harvest', SELF, [
      res({ id: 1, x: 11.5, y: 10 }),
      res({ id: 2, x: 10.5, y: 10 }),
    ]);
    expect(target?.id).toBe(2);
  });

  it('2タイルより遠いものは選ばない', () => {
    expect(pickResourceTarget('harvest', SELF, [res({ id: 1, x: 12.1, y: 10 })])).toBeNull();
    expect(pickResourceTarget('harvest', SELF, [res({ id: 1, x: 12, y: 10 })])?.id).toBe(1);
  });

  it('在庫0の資源は収穫の対象にしない', () => {
    expect(pickResourceTarget('harvest', SELF, [res({ id: 1, amount: 0 })])).toBeNull();
  });

  it('在庫が1未満（採りかけ）も収穫の対象にしない（サーバ MIN_HARVESTABLE と同じ）', () => {
    expect(pickResourceTarget('harvest', SELF, [res({ id: 1, amount: 0.6 })])).toBeNull();
  });

  it('水場は収穫できない（サーバ HARVESTABLE に無い）', () => {
    expect(pickResourceTarget('harvest', SELF, [res({ id: 1, type: 'water' })])).toBeNull();
  });

  it('釣り場は収穫できるが水やりはできない', () => {
    const spot = [res({ id: 1, type: 'fishing_spot' })];
    expect(pickResourceTarget('harvest', SELF, spot)?.id).toBe(1);
    expect(pickResourceTarget('water', SELF, spot)).toBeNull();
  });

  it('空の畑は水やりの対象になる（在庫が無くても水はやれる）', () => {
    const field = [res({ id: 1, type: 'field', amount: 0 })];
    expect(pickResourceTarget('water', SELF, field)?.id).toBe(1);
    expect(pickResourceTarget('harvest', SELF, field)).toBeNull();
  });

  it('手前の空の畑が、奥の収穫できる木を隠さない', () => {
    // 「いちばん近い資源を1つ選んでから行動を決める」作りだと収穫が押せなくなる
    const target = pickResourceTarget('harvest', SELF, [
      res({ id: 1, type: 'field', amount: 0, x: 10.2, y: 10 }),
      res({ id: 2, type: 'berry_tree', amount: 4, x: 11.5, y: 10 }),
    ]);
    expect(target?.id).toBe(2);
  });
});

describe('E-2 ボタンの状態', () => {
  const none = { pet: null, resource: null };

  it('ペットが範囲外なら撫でるは押せない', () => {
    const s = resolveAction('pet', none);
    expect(s.enabled).toBe(false);
    expect(s.reason).toBe('no_target');
  });

  it('ペットが範囲内なら押せて、対象IDが入る', () => {
    const s = resolveAction('pet', { pet: 42, resource: null });
    expect(s.enabled).toBe(true);
    expect(s.targetId).toBe(42);
  });

  it('資源が無ければ水やり・収穫は押せない', () => {
    expect(resolveAction('water', none).enabled).toBe(false);
    expect(resolveAction('harvest', none).enabled).toBe(false);
  });

  it('在庫0の資源では収穫が「空」で押せない（水やりは押せる）', () => {
    const targets = { pet: null, resource: { id: 5, amount: 0, type: 'field' } };
    const h = resolveAction('harvest', targets);
    expect(h.enabled).toBe(false);
    expect(h.reason).toBe('empty');
    expect(resolveAction('water', targets).enabled).toBe(true);
  });

  it('種類が分かっていれば、水やりできない資源では押せない', () => {
    const s = resolveAction('water', { pet: null, resource: { id: 5, amount: 3, type: 'fishing_spot' } });
    expect(s.enabled).toBe(false);
    expect(s.reason).toBe('no_target');
  });

  it('種類が分からない対象でも壊れない（簡易な deps 実装を許す）', () => {
    const s = resolveAction('harvest', { pet: null, resource: { id: 5, amount: 3 } });
    expect(s.enabled).toBe(true);
  });

  it('クールダウン中は押せない（サーバの rate 警告を積もらせない）', () => {
    const targets = { pet: null, resource: { id: 5, amount: 3, type: 'berry_tree' } };
    const s = resolveAction('harvest', targets, { nowMs: 500, cooldownUntilMs: 1000 });
    expect(s.enabled).toBe(false);
    expect(s.reason).toBe('cooldown');
    expect(resolveAction('harvest', targets, { nowMs: 1000, cooldownUntilMs: 1000 }).enabled).toBe(true);
  });

  it('クールダウンは撫でるには掛からない（なつき度は上限で止まるだけ）', () => {
    const s = resolveAction('pet', { pet: 42, resource: null }, { nowMs: 0, cooldownUntilMs: 9999 });
    expect(s.enabled).toBe(true);
  });

  it('クールダウンはサーバの1秒（TICK_HZ=4tick）と同じ', () => {
    expect(INTERACT_COOLDOWN_MS).toBe(1000);
  });
});

describe('E-2 ツールチップ', () => {
  it('押せない理由が日本語で出る（押す前に分かるのがE-2の主眼）', () => {
    expect(actionTitle(resolveAction('pet', { pet: null, resource: null }))).toContain('近づいて');
    expect(actionTitle(resolveAction('harvest', { pet: null, resource: { id: 1, amount: 0, type: 'field' } })))
      .toContain('採れるもの');
    expect(actionTitle(resolveAction('pet', { pet: 3, resource: null }))).toBe('なでる');
  });
});
