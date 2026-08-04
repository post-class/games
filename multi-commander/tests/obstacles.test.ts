import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { shipDef } from '../src/content/ships';
import { missionDef } from '../src/content/missions';
import { DIFFICULTIES } from '../src/app/settings';
import { MissionRunner } from '../src/mission/MissionRunner';
import {
  resolveObstacleCollisions,
  resolveObstacleHits,
  updateObstacles,
} from '../src/sim/obstacles';
import { canAutopilot } from '../src/sim/nav';
import {
  spawnMine,
  spawnProjectile,
  spawnRock,
  spawnShip,
  World,
} from '../src/world/world';

const DT = 1 / 60;

function newWorld() {
  return new World();
}

/**
 * 指定 Nav までワープで順に到達させ、その Nav 紐付けのグループを出現させる。
 * Nav 到達判定は順番に進むので、手前の Nav を飛ばせない。
 *
 * 到達を確認したら**すぐに離れてから**残りの時間を進める。
 * Nav の上に留まったままだと、そこに湧いた救助目標を距離判定で
 * 勝手に回収してしまい、湧いた数の検査が不定になる。
 */
function reachNav(world: World, runner: MissionRunner, index: number) {
  for (let i = 0; i <= index; i++) {
    const nav = world.entities.find((e) => e.kind === 'nav' && e.nav?.index === i);
    if (!nav) throw new Error(`nav ${i} not found`);
    world.player!.pos.copy(nav.pos);
    for (let t = 0; t < 60 * 4 && !nav.nav!.reached; t++) runner.update(DT);
    if (!nav.nav!.reached) throw new Error(`nav ${i} に到達できなかった`);
    // 離れてから、遅延つきのグループが湧くのを待つ
    world.player!.pos.copy(nav.pos).add(new Vector3(0, 0, 9000));
    for (let t = 0; t < 60 * 8; t++) runner.update(DT);
  }
}

function player(world: World, pos = new Vector3()) {
  const e = spawnShip(world, { def: shipDef('rapier'), faction: 'confed', pos, speed: 0 });
  world.playerId = e.id;
  return e;
}

describe('小惑星', () => {
  it('漂流し、自転する', () => {
    const world = newWorld();
    const rock = spawnRock(world, {
      pos: new Vector3(0, 0, 0),
      radius: 40,
      vel: new Vector3(0, 0, -60),
    });
    const q0 = rock.quat.clone();
    for (let i = 0; i < 60; i++) updateObstacles(world, DT);
    expect(rock.pos.z).toBeLessThan(-50);
    // 自転しているので姿勢が変わっている
    expect(rock.quat.angleTo(q0)).toBeGreaterThan(0.001);
  });

  it('弾を受けると削れ、耐久が尽きると壊れる', () => {
    const world = newWorld();
    const p = player(world);
    const rock = spawnRock(world, { pos: new Vector3(0, 0, -300), radius: 20 });
    const before = rock.rock!.hull;

    for (let i = 0; i < 40 && rock.alive; i++) {
      const proj = spawnProjectile(world, {
        gunId: 'mass-driver',
        pos: new Vector3(0, 0, -260),
        dir: new Vector3(0, 0, -1),
        ownerId: p.id,
        ownerFaction: p.faction,
        fromPlayer: true,
      });
      proj.prevPos.set(0, 0, -260);
      proj.pos.set(0, 0, -320);
      resolveObstacleHits(world);
      world.compact();
    }
    expect(rock.rock!.hull).toBeLessThan(before);
    expect(rock.alive).toBe(false);
  });

  it('大きい岩は壊れると破片に分裂する', () => {
    const world = newWorld();
    const p = player(world);
    const rock = spawnRock(world, { pos: new Vector3(0, 0, -300), radius: 60 });
    rock.rock!.hull = 1;
    const proj = spawnProjectile(world, {
      gunId: 'mass-driver',
      pos: new Vector3(0, 0, -200),
      dir: new Vector3(0, 0, -1),
      ownerId: p.id,
      ownerFaction: p.faction,
      fromPlayer: true,
    });
    proj.prevPos.set(0, 0, -200);
    proj.pos.set(0, 0, -400);
    resolveObstacleHits(world);
    world.compact();
    expect(rock.alive).toBe(false);
    expect(world.count('rock')).toBe(3);
  });

  it('接触すると損傷し、離散的な衝撃として扱われる', () => {
    const world = newWorld();
    const p = player(world);
    p.vel.set(0, 0, -300);
    const rock = spawnRock(world, { pos: new Vector3(0, 0, -10), radius: 40 });
    void rock;
    const shield0 = p.ship!.shield.front + p.ship!.shield.rear;
    resolveObstacleCollisions(world);
    const afterFirst = p.ship!.shield.front + p.ship!.shield.rear + p.ship!.hull;
    expect(shield0 + p.ship!.def.hull).toBeGreaterThan(afterFirst);
    // クールダウン中は続けて呼んでも追加ダメージが入らない
    const snapshot = afterFirst;
    resolveObstacleCollisions(world);
    expect(p.ship!.shield.front + p.ship!.shield.rear + p.ship!.hull).toBe(snapshot);
  });
});

describe('機雷', () => {
  it('敷設側の陣営には反応しない', () => {
    const world = newWorld();
    const e = spawnShip(world, {
      def: shipDef('rapier'),
      faction: 'confed',
      pos: new Vector3(0, 0, 0),
      speed: 0,
    });
    world.playerId = e.id;
    const mine = spawnMine(world, { pos: new Vector3(0, 0, -50), ownerFaction: 'confed' });
    for (let i = 0; i < 30; i++) updateObstacles(world, DT);
    expect(mine.mine!.armed).toBe(false);
    expect(mine.alive).toBe(true);
  });

  it('敵が接近すると起爆し、範囲内に損害を与える', () => {
    const world = newWorld();
    const enemy = spawnShip(world, {
      def: shipDef('dralthi'),
      faction: 'kilrathi',
      pos: new Vector3(0, 0, -50),
      speed: 0,
    });
    const mine = spawnMine(world, { pos: new Vector3(0, 0, 0), ownerFaction: 'confed' });
    const total0 = enemy.ship!.shield.front + enemy.ship!.shield.rear + enemy.ship!.hull;

    updateObstacles(world, DT);
    expect(mine.mine!.armed).toBe(true);
    // 信管の時間が経つと起爆する
    for (let i = 0; i < 120 && mine.alive; i++) updateObstacles(world, DT);
    world.compact();
    expect(mine.alive).toBe(false);
    const total1 = enemy.ship!.shield.front + enemy.ship!.shield.rear + enemy.ship!.hull;
    expect(total1).toBeLessThan(total0);
  });
});

describe('障害物とオートパイロット', () => {
  it('障害物の中では自動航行できない', () => {
    const world = newWorld();
    // Nav が必要なので、ミッションを組んでから岩を置く
    const def = missionDef('m1-patrol');
    const runner = new MissionRunner(
      world,
      def,
      { shipId: 'hornet' },
      DIFFICULTIES.normal,
    );
    runner.build();
    const me = world.player!;
    expect(canAutopilot(world, me).ok).toBe(true);
    spawnRock(world, { pos: me.pos.clone().add(new Vector3(0, 0, -500)), radius: 40 });
    const check = canAutopilot(world, me);
    expect(check.ok).toBe(false);
    expect(check.reason).toContain('小惑星');
    runner.dispose();
  });
});

describe('新しい目標種別', () => {
  it('救助: ポッドに接近すると回収される', () => {
    const world = newWorld();
    const def = missionDef('m3b-sar');
    const runner = new MissionRunner(world, def, { shipId: 'scimitar' }, DIFFICULTIES.easy);
    runner.build();
    // ポッドは NAV 1 到達時に配置される
    reachNav(world, runner, 0);
    const pods = world.entities.filter((e) => e.alive && e.tag === 'pods');
    expect(pods.length).toBe(3);

    const me = world.player!;
    for (const pod of pods) {
      me.pos.copy(pod.pos);
      runner.update(DT);
    }
    const rescue = runner.objectiveViews().find((o) => o.text.includes('脱出ポッド'));
    expect(rescue?.state).toBe('done');
    runner.dispose();
  });

  it('偵察: 対象を正面に捉え続けると達成する', () => {
    const world = newWorld();
    const def = missionDef('m2b-recon');
    const runner = new MissionRunner(world, def, { shipId: 'hornet' }, DIFFICULTIES.easy);
    runner.build();
    reachNav(world, runner, 1);
    const target = world.entities.find((e) => e.alive && e.tag === 'target');
    expect(target).toBeTruthy();

    const me = world.player!;
    // 対象の 600 手前に置き、機首を向ける
    const dir = new Vector3(0, 0, -1);
    me.pos.copy(target!.pos).add(new Vector3(0, 0, 600));
    me.quat.setFromUnitVectors(dir, target!.pos.clone().sub(me.pos).normalize());
    for (let i = 0; i < 60 * 6; i++) {
      me.pos.copy(target!.pos).add(new Vector3(0, 0, 600));
      me.quat.setFromUnitVectors(dir, target!.pos.clone().sub(me.pos).normalize());
      runner.update(DT);
    }
    const photo = runner.objectiveViews().find((o) => o.text.includes('撮影'));
    expect(photo?.state).toBe('done');
    runner.dispose();
  });

  it('制限時間: 超過すると失敗になる', () => {
    const world = newWorld();
    const def = missionDef('m5b-intercept');
    const runner = new MissionRunner(world, def, { shipId: 'rapier' }, DIFFICULTIES.easy);
    runner.build();
    // 4分ぶん進める
    for (let i = 0; i < 60 * 245 && runner.state === 'running'; i++) runner.update(DT);
    expect(runner.state).toBe('loss');
    runner.dispose();
  });
});
