import { beforeEach, describe, expect, it } from 'vitest';
import { DIFFICULTIES } from '../../src/app/settings';
import { MAX_RELAYS, newNarrative, normalizeNarrative, recordRelaysHeld, relaysHeld } from '../../src/app/narrative';
import { isHostile, resetFactionStances } from '../../src/content/factions';
import { missionDef } from '../../src/content/missions';
import { TEST_PATROL } from './fixtures/missions';
import { reseed } from '../../src/core/rng';
import { MissionRunner } from '../../src/mission/MissionRunner';
import type { MissionDef } from '../../src/mission/types';
import { setCombatOptions } from '../../src/sim/combat';
import { simulateStep } from '../../src/sim/step';
import { World } from '../../src/world/world';

const DT = 1 / 60;

beforeEach(() => {
  reseed(0x51ee9e);
  setCombatOptions({ playerDamageTaken: 1, playerDamageDealt: 1 });
  resetFactionStances();
});

function start(def: MissionDef) {
  const world = new World();
  const profile = DIFFICULTIES.normal;
  const runner = new MissionRunner(world, def, { shipId: def.playerShipId }, profile);
  runner.build();
  return { world, runner };
}

function run(world: World, runner: MissionRunner, seconds: number): void {
  const steps = Math.max(1, Math.round(seconds / DT));
  for (let i = 0; i < steps; i++) {
    simulateStep(world, DT, { flightMode: 'wc', ai: { maxAttackersOnPlayer: 2 } });
    runner.update(DT);
    if (runner.state !== 'running') return;
  }
}

describe('第8章 停戦の一分間', () => {
  const def = missionDef('veil-ch08');

  it('通信灯台は3基あり、1基以上を60秒維持する目標になっている', () => {
    const beacons = def.spawns.filter((s) => s.tag === 'beacon');
    expect(beacons.reduce((n, s) => n + s.count, 0)).toBe(3);

    const hold = def.objectives.find((o) => o.spec.kind === 'holdTag');
    expect(hold).toBeDefined();
    expect(hold!.required).toBe(true);
    expect(hold!.spec).toEqual({ kind: 'holdTag', tag: 'beacon', seconds: 60, min: 1 });
  });

  it('灯台は本来の陣営（ニューロウム）で置かれ、この章だけ非敵対に組み替えられる', () => {
    // 連邦陣営に偽装して置くと HUD の勢力色まで嘘になるので、関係の側を変える設計。
    for (const s of def.spawns.filter((x) => x.tag === 'beacon')) {
      expect(s.faction).toBe('neurowm');
    }
    expect(def.factionStances).toEqual([{ a: 'confed', b: 'neurowm', stance: 'neutral' }]);
  });

  it('出撃中は連邦とニューロウムが非敵対になり、終了で必ず既定へ戻る', () => {
    expect(isHostile('confed', 'neurowm')).toBe(true);

    const { runner } = start(def);
    expect(isHostile('confed', 'neurowm')).toBe(false);

    runner.dispose();
    // リセット漏れは既存11ミッションの敵対関係を壊すので、ここが最重要の回帰点。
    expect(isHostile('confed', 'neurowm')).toBe(true);
  });

  it('宣言を持たないミッションでも dispose で既定へ戻る（漏れ止めが無条件である保証）', () => {
    const plain = TEST_PATROL;
    expect(plain.factionStances).toBeUndefined();
    const { runner } = start(plain);
    runner.dispose();
    expect(isHostile('confed', 'neurowm')).toBe(true);
    expect(isHostile('confed', 'kilrathi')).toBe(true);
  });

  it('灯台の残存数が結果に載る', () => {
    const { world, runner } = start(def);
    run(world, runner, 1);
    const survivors = runner.summary().tagSurvivors['beacon'];
    expect(survivors).toEqual({ alive: 3, total: 3 });
    runner.dispose();
  });
});

describe('残した回線数の記録', () => {
  it('0..3 にクランプして保持する', () => {
    const n = newNarrative();
    expect(relaysHeld(n)).toBeUndefined();

    recordRelaysHeld(n, 2);
    expect(relaysHeld(n)).toBe(2);

    recordRelaysHeld(n, 9);
    expect(relaysHeld(n)).toBe(MAX_RELAYS);

    recordRelaysHeld(n, -4);
    expect(relaysHeld(n)).toBe(0);
  });

  it('保存データの不正値・欠落から復帰する', () => {
    expect(relaysHeld(normalizeNarrative({ relaysHeld: 2 }))).toBe(2);
    expect(relaysHeld(normalizeNarrative({ relaysHeld: 99 }))).toBe(MAX_RELAYS);
    expect(relaysHeld(normalizeNarrative({ relaysHeld: 'three' }))).toBe(0);
    // 第8章に到達していないセーブはキーを持たない（旧セーブの形を変えない）
    expect(normalizeNarrative({}).relaysHeld).toBeUndefined();
  });
});

describe('第10章 門前の帰還', () => {
  const def = missionDef('veil-ch10');

  it('旗艦戦の段階を持つ', () => {
    expect(def.capitalStages?.length ?? 0).toBeGreaterThan(0);
  });

  it('デブリーフに撃墜数の集計を出さない', () => {
    const text = def.debriefWin.join('');
    expect(text).not.toMatch(/撃墜/);
    expect(text).not.toMatch(/\d+\s*機/);
  });

  it('共同作戦の関係を宣言し、終了で既定へ戻る', () => {
    const { runner } = start(def);
    expect(isHostile('confed', 'neurowm')).toBe(false);
    // 急進派の旗艦は帝国陣営のまま敵として残る（陣営単位では誓約派と分けられないため）
    expect(isHostile('confed', 'kilrathi')).toBe(true);
    runner.dispose();
    expect(isHostile('confed', 'neurowm')).toBe(true);
  });
});
