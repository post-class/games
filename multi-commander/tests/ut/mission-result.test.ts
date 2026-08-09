import { Vector3 } from 'three';
import { beforeEach, describe, expect, it } from 'vitest';
import { DIFFICULTIES } from '../../src/app/settings';
import { bus } from '../../src/core/events';
import { reseed } from '../../src/core/rng';
import { MissionRunner } from '../../src/mission/MissionRunner';
import type { MissionDef } from '../../src/mission/types';
import { destroyEntity, setCombatOptions } from '../../src/sim/combat';
import { simulateStep } from '../../src/sim/step';
import type { Entity } from '../../src/world/entity';
import { World } from '../../src/world/world';

const DT = 1 / 60;

beforeEach(() => {
  reseed(0x5eed);
  setCombatOptions({ playerDamageTaken: 1, playerDamageDealt: 1 });
});

/** 物語用の集計だけを見る最小ミッション */
function baseDef(overrides: Partial<MissionDef>): MissionDef {
  return {
    id: 'ut-result',
    title: '集計テスト',
    system: 'テスト星系',
    briefing: ['集計の検証'],
    briefingSpeaker: '管制',
    navs: [{ name: 'NAV 1', pos: [0, 0, -4000] }],
    spawns: [],
    objectives: [
      { id: 'nav', text: 'NAV 1 到達', required: true, spec: { kind: 'reachNav', navIndex: 0 } },
    ],
    playerShipId: 'hornet',
    debriefWin: ['帰投'],
    debriefLoss: ['損失'],
    ...overrides,
  };
}

function start(def: MissionDef) {
  const world = new World();
  const profile = DIFFICULTIES.normal;
  setCombatOptions({
    playerDamageTaken: profile.playerDamageTaken,
    playerDamageDealt: profile.playerDamageDealt,
    playerSubsystemRate: profile.playerSubsystemRate,
  });
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

function destroy(world: World, runner: MissionRunner, e: Entity): void {
  destroyEntity(world, e);
  world.compact();
  runner.update(DT);
}

describe('出撃結果の物語用集計 (T4-2)', () => {
  it('回収数と敵側の救難を分けて数える', () => {
    const def = baseDef({
      spawns: [
        { shipId: 'escape-pod', count: 1, faction: 'neutral', tag: 'pods', offset: [0, 0, -3000] },
        { shipId: 'escape-pod', count: 1, faction: 'kilrathi', tag: 'pods', offset: [600, 0, -3000] },
      ],
      objectives: [
        { id: 'sar', text: '救難', required: true, spec: { kind: 'rescue', tag: 'pods' } },
      ],
    });
    const { world, runner } = start(def);
    run(world, runner, 0.2);
    expect(runner.summary().rescued).toBe(0);

    // 対象へ順に接近して回収する
    for (const tag of ['pods']) {
      for (const target of world.entities.filter((e) => e.tag === tag && e.alive)) {
        world.player!.pos.copy(target.pos);
        runner.update(DT);
      }
    }
    const s = runner.summary();
    expect(s.rescued).toBe(2);
    expect(s.enemyRescued).toBe(1);
    expect(runner.state).toBe('win');
  });

  it('中立・非敵対の艦の喪失だけを民間損害に数える', () => {
    const def = baseDef({
      spawns: [
        { shipId: 'refugee-liner', count: 1, faction: 'neutral', tag: 'civ', offset: [0, 0, -3000] },
        { shipId: 'sc03-arc', count: 1, faction: 'serecion', tag: 'neu', offset: [900, 0, -3000] },
        { shipId: 'ke04-mirage', count: 1, faction: 'kilrathi', tag: 'foe', offset: [1800, 0, -3000] },
      ],
    });
    const { world, runner } = start(def);
    run(world, runner, 0.3);
    expect(runner.summary().civilianLosses).toBe(0);

    destroy(world, runner, world.entities.find((e) => e.tag === 'civ')!);
    expect(runner.summary().civilianLosses).toBe(1);
    destroy(world, runner, world.entities.find((e) => e.tag === 'neu')!);
    expect(runner.summary().civilianLosses).toBe(2);
    // 敵の撃墜は民間損害ではない
    destroy(world, runner, world.entities.find((e) => e.tag === 'foe')!);
    expect(runner.summary().civilianLosses).toBe(2);
  });

  it('誤射数と発砲数を集計する (weaponsSafe と同じ値を使う)', () => {
    const def = baseDef({
      spawns: [
        { shipId: 'refugee-liner', count: 1, faction: 'neutral', tag: 'civ', offset: [0, 0, -3000] },
      ],
    });
    const { world, runner } = start(def);
    run(world, runner, 0.3);
    const civ = world.entities.find((e) => e.tag === 'civ')!;
    for (let i = 0; i < 3; i++) {
      bus.emit('weaponFired', {
        shooter: world.player!,
        muzzle: new Vector3(),
        direction: new Vector3(0, 0, -1),
        weaponKind: 'gun',
        weaponId: 'test-gun',
        isPlayer: true,
      });
    }
    bus.emit('weaponHit', { target: civ, fromPlayer: true, weaponKind: 'gun', weaponId: 'test-gun' });
    bus.emit('weaponHit', { target: civ, fromPlayer: true, weaponKind: 'gun', weaponId: 'test-gun' });
    runner.update(DT);
    const s = runner.summary();
    expect(s.shotsFired).toBe(3);
    expect(s.friendlyFireHits).toBe(2);
  });

  it('僚機の生還と喪失を人数で返す', () => {
    const def = baseDef({ wingman: { shipId: 'hornet', pilot: 'Sable', skill: 0.6 } });
    const alive = start(def);
    run(alive.world, alive.runner, 0.3);
    expect(alive.runner.summary().wingmenSurvived).toBe(1);
    expect(alive.runner.summary().wingmenLost).toBe(0);

    const lost = start(def);
    run(lost.world, lost.runner, 0.3);
    const wing = lost.world.entities.find((e) => e.ship?.pilot === 'Sable')!;
    destroy(lost.world, lost.runner, wing);
    const s = lost.runner.summary();
    expect(s.wingmenLost).toBe(1);
    expect(s.wingmenSurvived).toBe(0);
    // 自陣営の損失は民間損害に数えない
    expect(s.civilianLosses).toBe(0);

    const solo = start(baseDef({}));
    run(solo.world, solo.runner, 0.3);
    expect(solo.runner.summary().wingmenSurvived).toBe(0);
  });

  it('objectivesFailed には破られた制約と未達成の勝利条件が入る', () => {
    const def = baseDef({
      spawns: [
        { shipId: 'refugee-liner', count: 1, faction: 'neutral', tag: 'civ', offset: [0, 0, -3000] },
        { shipId: 'ke04-mirage', count: 1, faction: 'kilrathi', tag: 'foe', offset: [1800, 0, -3000] },
      ],
      objectives: [
        { id: 'p', text: '避難船を守る', required: true, spec: { kind: 'protect', tag: 'civ' } },
        { id: 'ff', text: '誤射をしない', required: true, spec: { kind: 'noFriendlyFire' } },
        { id: 'kill', text: '敵を掃討', required: true, spec: { kind: 'destroyTag', tag: 'foe' } },
      ],
    });
    const { world, runner } = start(def);
    run(world, runner, 0.3);
    const civ = world.entities.find((e) => e.tag === 'civ')!;
    bus.emit('weaponHit', { target: civ, fromPlayer: true, weaponKind: 'gun' });
    runner.update(DT);
    expect(runner.state).toBe('loss');
    const failed = runner.summary().objectivesFailed;
    // 破られた制約と、達成できなかった勝利条件だけが残る
    expect(failed).toContain('ff');
    expect(failed).toContain('kill');
    // 成立し続けている制約は未達成扱いにしない
    expect(failed).not.toContain('p');
  });

  it('既存フィールドの意味は変わらない (撃墜数だけでは物語用の値が動かない)', () => {
    const def = baseDef({
      spawns: [
        { shipId: 'ke04-mirage', count: 1, faction: 'kilrathi', tag: 'foe', offset: [0, 0, -3000] },
      ],
    });
    const { world, runner } = start(def);
    run(world, runner, 0.3);
    const foe = world.entities.find((e) => e.tag === 'foe')!;
    destroyEntity(world, foe, world.player, 'gun');
    world.compact();
    runner.update(DT);
    const s = runner.summary();
    expect(s.kills).toBe(1);
    expect(s.rescued).toBe(0);
    expect(s.civilianLosses).toBe(0);
    expect(s.friendlyFireHits).toBe(0);
    expect(s.enemyRescued).toBe(0);
  });
});
