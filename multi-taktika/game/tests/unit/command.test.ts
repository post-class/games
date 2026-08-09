/**
 * T-M2-08: Command の型と適用の枠（実装手順書 §6.11）
 *
 * 検証: **全 Command 型が JSON シリアライズ往復で同値**であること。
 * Command はリプレイ（.mtr）と通信（WebSocket）に載るので、
 * 関数・クラスインスタンス・undefined・Map/Set が混ざったら即座に破綻する。
 *
 * 網羅性は `Record<CommandType, Command>` の型で保証している。
 * `Command` に新しい型を足すとこのテーブルで型エラーになる。
 */

import { describe, expect, it } from 'vitest';
import { COMMAND_TYPES, applyCommands, type Command, type CommandType } from '@/sim/command';
import { fx, fxFromInt } from '@/sim/core/fx';
import { createWorld } from '@/sim/core/world';

/** 全 Command 型の代表値。キーが Command['t'] を網羅していないと型エラーになる。 */
const SAMPLES: { readonly [K in CommandType]: Extract<Command, { t: K }> } = {
  setOrder: { t: 'setOrder', p: 0, front: 3, order: 'charge', tier: 'upper' },
  produce: { t: 'produce', p: 1, building: 0x00010005, unit: 'y-ashigaru', count: 5 },
  cancelQueue: { t: 'cancelQueue', p: 2, building: 0x00020007, index: 2 },
  placeBuilding: {
    t: 'placeBuilding',
    p: 3,
    type: 'barracks',
    x: fxFromInt(40),
    y: fx(52.5),
    villagers: [1, 2, 3],
  },
  placeWallLine: {
    t: 'placeWallLine',
    p: 4,
    type: 'stone_wall',
    x0: fxFromInt(10),
    y0: fxFromInt(10),
    x1: fxFromInt(20),
    y1: fxFromInt(10),
  },
  moveUnits: {
    t: 'moveUnits',
    p: 5,
    units: [10, 11, 12],
    x: fxFromInt(77),
    y: fxFromInt(88),
    queued: true,
  },
  attackTarget: { t: 'attackTarget', p: 6, units: [20, 21], target: 0x00030001 },
  gather: { t: 'gather', p: 7, units: [30], target: 0x00040002 },
  releaseManual: { t: 'releaseManual', p: 0, units: [] },
  research: { t: 'research', p: 1, building: 0x00050003, tech: 'uchiba' },
  advanceAge: { t: 'advanceAge', p: 2, building: 0x00060004 },
  marketTrade: { t: 'marketTrade', p: 3, sell: 'wood', buy: 'gold', amount: 100 },
  tribute: { t: 'tribute', p: 4, to: 5, resource: 'food', amount: 250 },
  setRally: { t: 'setRally', p: 5, building: 0x00070005, x: fxFromInt(12), y: fxFromInt(13) },
  // 大天幕を畳んで動かす（モンゴル。令の発信点が動く）
  foldStructure: {
    t: 'foldStructure',
    p: 1,
    building: 0x00090006,
    x: fxFromInt(40),
    y: fxFromInt(41),
  },
  resign: { t: 'resign', p: 6 },
};

const ALL: readonly Command[] = COMMAND_TYPES.map((t) => SAMPLES[t]);

describe('T-M2-08: 全 Command 型が JSON 往復で同値', () => {
  it('COMMAND_TYPES が Command の判別子を全件・重複なしで持つ', () => {
    const keys = Object.keys(SAMPLES).sort();
    expect([...COMMAND_TYPES].sort()).toEqual(keys);
    expect(new Set(COMMAND_TYPES).size).toBe(COMMAND_TYPES.length);
    // 15 種（手順書 §6.11）+ foldStructure（大天幕を畳む。M10 で追加）
    expect(COMMAND_TYPES.length).toBe(16);
  });

  it('各 Command が JSON.parse(JSON.stringify(c)) と深く等しい', () => {
    for (const c of ALL) {
      const round = JSON.parse(JSON.stringify(c)) as Command;
      expect(round, `${c.t} の往復`).toEqual(c);
      expect(round.t).toBe(c.t);
    }
  });

  it('配列ごと往復しても順序と内容が保たれる', () => {
    const round = JSON.parse(JSON.stringify(ALL)) as Command[];
    expect(round).toEqual(ALL);
    expect(round.map((c) => c.t)).toEqual([...COMMAND_TYPES]);
  });

  it('平坦な値のみで構成されている（関数・undefined・入れ子オブジェクトを含まない）', () => {
    for (const c of ALL) {
      for (const [k, v] of Object.entries(c)) {
        const kind = typeof v;
        if (Array.isArray(v)) {
          // 配列は EntityId（数値）の並びだけ許す
          for (const el of v as unknown[]) {
            expect(typeof el, `${c.t}.${k} の要素`).toBe('number');
            expect(Number.isInteger(el as number)).toBe(true);
          }
          continue;
        }
        expect(['number', 'string', 'boolean'], `${c.t}.${k} は ${kind}`).toContain(kind);
      }
    }
  });

  it('数値フィールドはすべて整数（Fx は実数 × 256 の整数）', () => {
    for (const c of ALL) {
      for (const [k, v] of Object.entries(c)) {
        if (typeof v === 'number') {
          expect(Number.isInteger(v), `${c.t}.${k} = ${v}`).toBe(true);
        }
      }
    }
  });
});

describe('applyCommands の枠', () => {
  it('全 Command を流しても例外を投げず、状態を壊さない（中身は各 M で実装）', () => {
    const w = createWorld({
      seed: 1,
      playerCount: 8,
      mapWidthTiles: 200,
      mapHeightTiles: 200,
      entityCapacity: 64,
    });
    expect(() => applyCommands(w, ALL)).not.toThrow();
    expect(w.tick).toBe(0);
    expect(w.entities.count).toBe(0);
  });

  it('存在しないプレイヤーの入力は黙って無視する（例外にしない）', () => {
    const w = createWorld({ seed: 1, playerCount: 2, mapWidthTiles: 200, mapHeightTiles: 200 });
    expect(() => applyCommands(w, [{ t: 'resign', p: 7 }, { t: 'resign', p: -1 }])).not.toThrow();
    expect(w.players[0]!.resigned).toBe(false);
  });

  it('敗北済みプレイヤーの入力も無視する', () => {
    const w = createWorld({ seed: 1, playerCount: 2, mapWidthTiles: 200, mapHeightTiles: 200 });
    w.players[1]!.defeated = true;
    expect(() => applyCommands(w, [SAMPLES.resign])).not.toThrow();
  });

  it('空配列でも安全', () => {
    const w = createWorld({ seed: 1, playerCount: 1, mapWidthTiles: 200, mapHeightTiles: 200 });
    expect(() => applyCommands(w, [])).not.toThrow();
  });
});
