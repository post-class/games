import { Quaternion, Vector3 } from 'three';
import { beforeEach, describe, expect, it } from 'vitest';
import { DIFFICULTIES } from '../../src/app/settings';
import { DeckSequence } from '../../src/app/DeckSequence';
import { missionDef } from '../../src/content/missions';
import { shipDef } from '../../src/content/ships';
import { reseed } from '../../src/core/rng';
import { LAUNCH_SPEED, LAUNCH_THROTTLE, MissionRunner } from '../../src/mission/MissionRunner';
import { setCombatOptions } from '../../src/sim/combat';
import { spawnShip, World } from '../../src/world/world';

// W1: 発艦の「実初速」を 10 kps にし、「速度設定」は従来の巡航値のまま保つ。
// 実速度と速度設定が別物であることを、spawn・出撃・カタパルト演出の3層で固定する。

beforeEach(() => {
  reseed(0xc0ffee);
  setCombatOptions({ playerDamageTaken: 1, playerDamageDealt: 1 });
});

/** ミッションを開始して自機を得る（mission.test.ts と同じ組み立て） */
function start(difficultyId: 'easy' | 'normal' | 'hard') {
  const def = missionDef('m1-patrol');
  const world = new World();
  const profile = DIFFICULTIES[difficultyId];
  setCombatOptions({
    playerDamageTaken: profile.playerDamageTaken,
    playerDamageDealt: profile.playerDamageDealt,
    playerSubsystemRate: profile.playerSubsystemRate,
  });
  const runner = new MissionRunner(
    world,
    def,
    { shipId: def.playerShipId, missiles: def.playerMissiles },
    profile,
  );
  runner.build();
  return { world, runner };
}

describe('spawnShip の throttle 指定', () => {
  // ① 実速度と速度設定を別に渡せる
  it('throttle を渡すと speed からの逆算をやめる', () => {
    const world = new World();
    const def = shipDef('hornet');
    const e = spawnShip(world, {
      def,
      faction: 'confed',
      pos: new Vector3(0, 0, 0),
      speed: LAUNCH_SPEED,
      throttle: 0.5,
    });
    expect(e.vel.length()).toBeCloseTo(LAUNCH_SPEED, 10);
    expect(e.input!.throttle).toBe(0.5);
    // 逆算していたら 10 / maxSpeed のごく小さな値になる
    expect(e.input!.throttle).not.toBeCloseTo(LAUNCH_SPEED / def.maxSpeed, 5);
  });

  // ② 従来の呼び出し（敵機・僚機・母艦など）は挙動が変わらない
  it('throttle 未指定なら speed / maxSpeed から逆算する', () => {
    const world = new World();
    const def = shipDef('hornet');
    const speed = def.maxSpeed * 0.4;
    const e = spawnShip(world, {
      def,
      faction: 'kilrathi',
      pos: new Vector3(0, 0, 0),
      speed,
    });
    expect(e.vel.length()).toBeCloseTo(speed, 6);
    expect(e.input!.throttle).toBeCloseTo(speed / def.maxSpeed, 10);
  });

  it('throttle は 0..1 にクランプされる', () => {
    const world = new World();
    const def = shipDef('hornet');
    const over = spawnShip(world, {
      def,
      faction: 'confed',
      pos: new Vector3(0, 0, 0),
      speed: LAUNCH_SPEED,
      throttle: 1.4,
    });
    const under = spawnShip(world, {
      def,
      faction: 'confed',
      pos: new Vector3(0, 0, 0),
      speed: LAUNCH_SPEED,
      throttle: -0.2,
    });
    expect(over.input!.throttle).toBe(1);
    expect(under.input!.throttle).toBe(0);
  });
});

describe('出撃時の自機の初速と速度設定', () => {
  // ③ 実速度はどの難易度でも LAUNCH_SPEED、速度設定は従来の巡航値
  it('実速度は難易度に依らず LAUNCH_SPEED', () => {
    for (const id of ['easy', 'normal', 'hard'] as const) {
      const { world } = start(id);
      expect(world.player!.vel.length()).toBeCloseTo(LAUNCH_SPEED, 6);
    }
  });

  it('速度設定は やさしい 50% / それ以外 LAUNCH_THROTTLE', () => {
    expect(start('easy').world.player!.input!.throttle).toBe(0.5);
    expect(start('normal').world.player!.input!.throttle).toBe(LAUNCH_THROTTLE);
    expect(start('hard').world.player!.input!.throttle).toBe(LAUNCH_THROTTLE);
  });

  it('速度設定は 0 にならない（発艦後に止まったままにならない）', () => {
    for (const id of ['easy', 'normal', 'hard'] as const) {
      expect(start(id).world.player!.input!.throttle).toBeGreaterThan(0);
    }
  });
});

describe('カタパルト射出', () => {
  // ④ 演出側の射出速度も同じ出所から作られている
  it('startLaunch 後の実速度が LAUNCH_SPEED', () => {
    const world = new World();
    const player = spawnShip(world, {
      def: shipDef('hornet'),
      faction: 'confed',
      pos: new Vector3(0, 0, 0),
      quat: new Quaternion(),
      speed: LAUNCH_SPEED,
      throttle: LAUNCH_THROTTLE,
    });
    world.playerId = player.id;

    new DeckSequence().startLaunch(world, player);

    expect(player.vel.length()).toBeCloseTo(LAUNCH_SPEED, 10);
    // 演出中は台本がスロットルを動かすので 0 から始まる
    expect(player.input!.throttle).toBe(0);
  });
});
