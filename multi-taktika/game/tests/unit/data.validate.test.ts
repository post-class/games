import { describe, it, expect } from 'vitest';
import {
  DataValidationError,
  Issues,
  expectCost,
  expectCount,
  expectEnum,
  expectIdSet,
  expectInt,
  expectNoUnknownKeys,
  expectRange,
  expectRecord,
  expectRef,
  expectRefArray,
  forEachEntry,
} from '../../src/data/validate.js';

const RES = new Set(['food', 'wood', 'stone', 'gold']);

describe('T-M1-02 バリデータ基盤', () => {
  it('問題がなければ throwIfAny は何もしない', () => {
    const iss = new Issues('units.json');
    expect(iss.count).toBe(0);
    expect(() => iss.throwIfAny()).not.toThrow();
  });

  it('問題を全部集めてから 1 度に投げる（1 件目で止めない）', () => {
    const iss = new Issues('units.json');
    iss.add('a.hp', 'は数値である必要があります');
    iss.add('b.hp', 'は数値である必要があります');
    expect(iss.count).toBe(2);
    try {
      iss.throwIfAny();
      expect.unreachable('例外が投げられるべき');
    } catch (e) {
      expect(e).toBeInstanceOf(DataValidationError);
      const err = e as DataValidationError;
      expect(err.issues).toHaveLength(2);
      // メッセージにデータ上のパスが必ず入っていること
      expect(err.message).toContain('units.json:a.hp');
      expect(err.message).toContain('units.json:b.hp');
    }
  });

  it('型不一致を検出し、実際の型を報告する', () => {
    const iss = new Issues('t.json');
    expect(expectRecord(iss, 'x', [])).toBeNull();
    expect(expectInt(iss, 'y', 1.5)).toBeNull();
    expect(iss.all()[0]).toContain('実際: array');
    expect(iss.all()[1]).toContain('は整数である必要があります');
  });

  it('範囲外・列挙外を検出する', () => {
    const iss = new Issues('t.json');
    expect(expectRange(iss, 'ratio', 1.4, 0, 1)).toBeNull();
    expect(expectEnum(iss, 'age', 'showa', ['reimei', 'seido'])).toBeNull();
    expect(expectEnum(iss, 'age', 'seido', ['reimei', 'seido'])).toBe('seido');
    expect(iss.count).toBe(2);
  });

  it('参照先が存在しない ID を検出する（外部キー制約）', () => {
    const iss = new Issues('civs.json');
    const known = new Set(['y-bushi', 'r-legion']);
    expect(expectRef(iss, 'yamato.eliteUnit', 'y-bushi', known, 'units.json')).toBe('y-bushi');
    expect(expectRef(iss, 'yamato.eliteUnit', 'y-samurai', known, 'units.json')).toBeNull();
    expect(iss.all()[0]).toContain('"y-samurai" は units.json に存在しません');

    expect(expectRefArray(iss, 'p', ['y-bushi', 'nope'], known, 'units.json')).toEqual(['y-bushi']);
  });

  it('コスト表は資源 ID だけを許し、負値を弾く', () => {
    const iss = new Issues('units.json');
    expect(expectCost(iss, 'v.cost', { food: 50, wood: 20 }, RES)).toEqual({ food: 50, wood: 20 });
    expect(iss.count).toBe(0);

    expectCost(iss, 'x.cost', { mithril: 10, food: -1 }, RES);
    expect(iss.all()[0]).toContain('は資源 ID ではありません');
    expect(iss.all()[1]).toContain('は 0 以上である必要があります');
  });

  it('未知のキー（綴り間違い）を検出し、_meta は許可する', () => {
    const iss = new Issues('units.json');
    expectNoUnknownKeys(iss, 'v', { name: 'x', hpp: 1, _meta: {} }, ['name', 'hp']);
    expect(iss.count).toBe(1);
    expect(iss.all()[0]).toContain('units.json:v.hpp');
  });

  it('件数と ID 集合の不足・余剰を別々に報告する', () => {
    const iss = new Issues('units.json');
    expectCount(iss, '', 93, 94, 'ユニット総数');
    expect(iss.all()[0]).toContain('94 件である必要があります（実際: 93 件）');

    const iss2 = new Issues('units.json');
    expectIdSet(iss2, '', ['a', 'x'], ['a', 'b']);
    expect(iss2.all()[0]).toContain('不足している ID: b');
    expect(iss2.all()[1]).toContain('余分な ID: x');
  });

  it('forEachEntry は _meta を読み飛ばし、ID 一覧を返す', () => {
    const iss = new Issues('units.json');
    const seen: string[] = [];
    const ids = forEachEntry(iss, '', { _meta: { note: 'x' }, a: { hp: 1 }, b: { hp: 2 } }, (id) => {
      seen.push(id);
    });
    expect(ids).toEqual(['a', 'b']);
    expect(seen).toEqual(['a', 'b']);
    expect(iss.count).toBe(0);
  });
});
