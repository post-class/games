import { Vector3 } from 'three';
import { beforeEach, describe, expect, it } from 'vitest';
import { DIFFICULTIES } from '../../src/app/settings';
import { bus } from '../../src/core/events';
import { reseed } from '../../src/core/rng';
import { MissionRunner } from '../../src/mission/MissionRunner';
import type { MissionDef, ObjectiveDef } from '../../src/mission/types';
import { destroyEntity, setCombatOptions } from '../../src/sim/combat';
import { simulateStep } from '../../src/sim/step';
import type { Entity } from '../../src/world/entity';
import { World } from '../../src/world/world';

const DT = 1 / 60;

beforeEach(() => {
  reseed(0xc0ffee);
  setCombatOptions({ playerDamageTaken: 1, playerDamageDealt: 1 });
});

/**
 * 目標判定だけを見るための最小ミッション。
 * 既存のキャンペーンデータに依存させないので、章データが変わっても
 * このテストは「判定そのもの」を検証し続ける。
 */
function baseDef(overrides: Partial<MissionDef>): MissionDef {
  return {
    id: 'ut-objectives',
    title: '判定テスト',
    system: 'テスト星系',
    briefing: ['判定の検証'],
    briefingSpeaker: '管制',
    navs: [
      { name: 'NAV 1', pos: [0, 0, -4000] },
      { name: 'NAV 2', pos: [0, 0, -8000] },
    ],
    spawns: [],
    objectives: [],
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

function jumpToNav(world: World, index: number, def: MissionDef): void {
  const player = world.player!;
  player.pos.set(...def.navs[index].pos);
  player.prevPos.copy(player.pos);
  player.renderPrevPos.copy(player.pos);
}

function destroy(world: World, runner: MissionRunner, e: Entity): void {
  destroyEntity(world, e);
  world.compact();
  runner.update(DT);
}

function viewOf(runner: MissionRunner, index: number) {
  return runner.objectiveViews()[index];
}

/** 自機の射撃が命中したことにする (combat.ts が命中1件ごとに流すイベント) */
function playerHit(target: Entity, fromPlayer = true): void {
  bus.emit('weaponHit', { target, fromPlayer, weaponKind: 'gun', weaponId: 'test-gun' });
}

/** 自機が引き金を引いたことにする */
function playerFire(world: World): void {
  bus.emit('weaponFired', {
    shooter: world.player!,
    muzzle: new Vector3(),
    direction: new Vector3(0, 0, -1),
    weaponKind: 'gun',
    weaponId: 'test-gun',
    isPlayer: true,
  });
}

const NAV0: ObjectiveDef = {
  id: 'nav',
  text: 'NAV 1 到達',
  required: true,
  spec: { kind: 'reachNav', navIndex: 0 },
};

describe('noFriendlyFire (誤射禁止)', () => {
  const def = baseDef({
    spawns: [
      { shipId: 'refugee-liner', count: 1, faction: 'neutral', tag: 'civ', offset: [0, 0, -5000] },
      { shipId: 'ke04-mirage', count: 1, faction: 'kilrathi', tag: 'foe', offset: [3000, 0, -5000] },
    ],
    objectives: [
      { id: 'ff', text: '誤射をしない', required: true, spec: { kind: 'noFriendlyFire' } },
      NAV0,
    ],
  });

  it('誤射が0なら成立し続け、他の必須目標だけで勝てる', () => {
    const { world, runner } = start(def);
    run(world, runner, 0.5);
    expect(viewOf(runner, 0).state).toBe('active');
    expect(viewOf(runner, 0).text).toContain('誤射 0');
    jumpToNav(world, 0, def);
    run(world, runner, 0.2);
    expect(runner.state).toBe('win');
  });

  it('味方・非敵対に1発当てた時点で失敗する', () => {
    const { world, runner } = start(def);
    run(world, runner, 0.5);
    const civ = world.entities.find((e) => e.tag === 'civ')!;
    playerHit(civ);
    runner.update(DT);
    expect(viewOf(runner, 0).state).toBe('failed');
    expect(runner.state).toBe('loss');
    expect(runner.summary().friendlyFireHits).toBe(1);
  });

  it('敵への命中と、自機以外の射撃は誤射に数えない', () => {
    const { world, runner } = start(def);
    run(world, runner, 0.5);
    const foe = world.entities.find((e) => e.tag === 'foe')!;
    const civ = world.entities.find((e) => e.tag === 'civ')!;
    playerHit(foe);
    playerHit(civ, false);
    runner.update(DT);
    expect(runner.summary().friendlyFireHits).toBe(0);
    expect(viewOf(runner, 0).state).toBe('active');
    expect(runner.state).toBe('running');
  });
});

describe('weaponsSafe (発砲禁止)', () => {
  const def = baseDef({
    objectives: [
      { id: 'safe', text: '発砲しない', required: true, spec: { kind: 'weaponsSafe' } },
      { id: 'hold', text: '1 秒耐える', required: true, spec: { kind: 'survive', seconds: 1 } },
    ],
  });

  it('1発も撃たなければ達成扱いのまま勝てる', () => {
    const { world, runner } = start(def);
    run(world, runner, 1.2);
    expect(runner.state).toBe('win');
    expect(runner.summary().shotsFired).toBe(0);
  });

  it('1発撃った時点で失敗する (命中の有無を問わない)', () => {
    const { world, runner } = start(def);
    run(world, runner, 0.3);
    playerFire(world);
    runner.update(DT);
    expect(viewOf(runner, 0).state).toBe('failed');
    expect(runner.state).toBe('loss');
    expect(runner.summary().shotsFired).toBe(1);
  });
});

describe('protectCount (N隻以上の生存)', () => {
  const def = baseDef({
    spawns: [
      { shipId: 'escape-pod', count: 4, faction: 'neutral', tag: 'evac', offset: [0, 0, -5000], spread: 400 },
    ],
    objectives: [
      { id: 'evac', text: '3 隻以上を守る', required: true, spec: { kind: 'protectCount', tag: 'evac', min: 3 } },
      NAV0,
    ],
  });

  it('min 以上生存していれば成立し、進捗を表示する', () => {
    const { world, runner } = start(def);
    run(world, runner, 0.5);
    expect(viewOf(runner, 0).text).toContain('4/4 生存');
    const pods = world.entities.filter((e) => e.tag === 'evac');
    destroy(world, runner, pods[0]);
    expect(viewOf(runner, 0).state).toBe('active');
    expect(viewOf(runner, 0).text).toContain('3/4 生存');
    jumpToNav(world, 0, def);
    run(world, runner, 0.2);
    expect(runner.state).toBe('win');
  });

  it('min を下回った時点で失敗する', () => {
    const { world, runner } = start(def);
    run(world, runner, 0.5);
    const pods = world.entities.filter((e) => e.tag === 'evac');
    destroy(world, runner, pods[0]);
    destroy(world, runner, pods[1]);
    expect(viewOf(runner, 0).state).toBe('failed');
    expect(runner.state).toBe('loss');
  });
});

describe('holdTag (対象を維持したまま指定秒数)', () => {
  const def = baseDef({
    spawns: [
      { shipId: 'refugee-liner', count: 2, faction: 'neutral', tag: 'beacon', offset: [0, 0, -5000], spread: 500 },
    ],
    objectives: [
      {
        id: 'beacon',
        text: '灯台を維持する',
        required: true,
        spec: { kind: 'holdTag', tag: 'beacon', seconds: 1, min: 2 },
      },
    ],
  });

  it('min を維持したまま seconds 経過で達成になる', () => {
    const { world, runner } = start(def);
    run(world, runner, 0.5);
    expect(runner.state).toBe('running');
    expect(viewOf(runner, 0).text).toContain('残り');
    run(world, runner, 0.7);
    expect(runner.state).toBe('win');
  });

  it('途中で min を下回ると失敗する', () => {
    const { world, runner } = start(def);
    run(world, runner, 0.3);
    const beacons = world.entities.filter((e) => e.tag === 'beacon');
    destroy(world, runner, beacons[0]);
    expect(viewOf(runner, 0).state).toBe('failed');
    expect(runner.state).toBe('loss');
  });
});

describe('既存の目標種別の回帰', () => {
  it('destroyAll は敵がいなければ達成になる', () => {
    const def = baseDef({
      objectives: [{ id: 'clear', text: '掃討', required: true, spec: { kind: 'destroyAll' } }],
    });
    const { world, runner } = start(def);
    run(world, runner, 0.2);
    expect(runner.state).toBe('win');
  });

  it('destroyTag はタグ対象を全滅させると達成になる', () => {
    const def = baseDef({
      spawns: [
        { shipId: 'ke04-mirage', count: 2, faction: 'kilrathi', tag: 'supply', offset: [0, 0, -6000] },
      ],
      objectives: [
        { id: 'supply', text: '補給を潰す', required: true, spec: { kind: 'destroyTag', tag: 'supply' } },
      ],
    });
    const { world, runner } = start(def);
    run(world, runner, 0.5);
    expect(viewOf(runner, 0).state).toBe('active');
    for (const e of world.entities.filter((x) => x.tag === 'supply')) destroyEntity(world, e);
    world.compact();
    runner.update(DT);
    expect(viewOf(runner, 0).state).toBe('done');
    expect(runner.state).toBe('win');
  });

  it('protect は全滅で失敗し、生存中は勝利を妨げない', () => {
    const def = baseDef({
      spawns: [
        { shipId: 'drayman', count: 1, faction: 'confed', tag: 'convoy', offset: [0, 0, -6000] },
      ],
      objectives: [
        { id: 'convoy', text: '輸送艦を守る', required: true, spec: { kind: 'protect', tag: 'convoy' } },
        NAV0,
      ],
    });
    const ok = start(def);
    run(ok.world, ok.runner, 0.3);
    jumpToNav(ok.world, 0, def);
    run(ok.world, ok.runner, 0.2);
    expect(ok.runner.state).toBe('win');

    const bad = start(def);
    run(bad.world, bad.runner, 0.3);
    destroy(bad.world, bad.runner, bad.world.entities.find((e) => e.tag === 'convoy')!);
    expect(viewOf(bad.runner, 0).state).toBe('failed');
    expect(bad.runner.state).toBe('loss');
  });

  it('reachNav は到達で達成、未到達なら続行', () => {
    const def = baseDef({ objectives: [NAV0] });
    const { world, runner } = start(def);
    run(world, runner, 0.5);
    expect(runner.state).toBe('running');
    jumpToNav(world, 0, def);
    run(world, runner, 0.2);
    expect(runner.state).toBe('win');
  });

  it('survive は指定時間の経過で達成になる', () => {
    const def = baseDef({
      objectives: [{ id: 's', text: '1 秒耐える', required: true, spec: { kind: 'survive', seconds: 1 } }],
    });
    const { world, runner } = start(def);
    run(world, runner, 0.5);
    expect(runner.state).toBe('running');
    run(world, runner, 0.7);
    expect(runner.state).toBe('win');
  });

  it('timeLimit は超過で失敗する', () => {
    const def = baseDef({
      objectives: [
        { id: 'limit', text: '時間内に', required: true, spec: { kind: 'timeLimit', seconds: 1 } },
        { id: 's', text: '5 秒耐える', required: true, spec: { kind: 'survive', seconds: 5 } },
      ],
    });
    const { world, runner } = start(def);
    run(world, runner, 0.5);
    expect(viewOf(runner, 0).text).toContain('残り');
    expect(runner.state).toBe('running');
    run(world, runner, 0.8);
    expect(viewOf(runner, 0).state).toBe('failed');
    expect(runner.state).toBe('loss');
  });
});

describe('勝敗判定における制約の扱い', () => {
  it('required な制約は active のままでも勝利条件に数えない', () => {
    const def = baseDef({
      spawns: [
        { shipId: 'escape-pod', count: 2, faction: 'neutral', tag: 'evac', offset: [0, 0, -5000], spread: 300 },
      ],
      objectives: [
        { id: 'p', text: '避難船を守る', required: true, spec: { kind: 'protect', tag: 'evac' } },
        { id: 'pc', text: '2 隻以上', required: true, spec: { kind: 'protectCount', tag: 'evac', min: 2 } },
        { id: 'lim', text: '10 分以内', required: true, spec: { kind: 'timeLimit', seconds: 600 } },
        { id: 'ff', text: '誤射をしない', required: true, spec: { kind: 'noFriendlyFire' } },
        { id: 'safe', text: '発砲しない', required: true, spec: { kind: 'weaponsSafe' } },
        NAV0,
      ],
    });
    const { world, runner } = start(def);
    run(world, runner, 0.3);
    jumpToNav(world, 0, def);
    run(world, runner, 0.2);
    expect(runner.state).toBe('win');
    // 制約はいずれも active のまま (破られていない)
    expect(runner.objectiveViews().slice(0, 5).every((v) => v.state === 'active')).toBe(true);
  });

  it('holdTag は達成する目標なので、完了しないうちは勝利にならない', () => {
    const def = baseDef({
      spawns: [
        { shipId: 'refugee-liner', count: 1, faction: 'neutral', tag: 'beacon', offset: [0, 0, -5000] },
      ],
      objectives: [
        { id: 'h', text: '灯台を維持', required: true, spec: { kind: 'holdTag', tag: 'beacon', seconds: 5 } },
        NAV0,
      ],
    });
    const { world, runner } = start(def);
    jumpToNav(world, 0, def);
    run(world, runner, 0.5);
    expect(viewOf(runner, 1).state).toBe('done');
    expect(runner.state).toBe('running');
  });
});
