import { Quaternion, Vector3 } from 'three';
import { beforeEach, describe, expect, it } from 'vitest';
import { DIFFICULTIES } from '../../src/app/settings';
import { reseed } from '../../src/core/rng';
import { missionDef } from '../../src/content/missions';
import { shipDef } from '../../src/content/ships';
import { VEIL_CH04 } from '../../src/content/veil/missions/ch04';
import { VEIL_CH05 } from '../../src/content/veil/missions/ch05';
import { MissionRunner } from '../../src/mission/MissionRunner';
import type { MissionDef } from '../../src/mission/types';
import {
  breakDuel,
  configureDuel,
  duelActive,
  duelState,
  newAi,
  resetDuel,
} from '../../src/sim/ai';
import { updateFlight } from '../../src/sim/flight';
import {
  addGravityWell,
  gravityMassFactor,
  gravityWellState,
  resetGravityWells,
  tickGravityWells,
  updateObstacles,
} from '../../src/sim/obstacles';
import { simulateStep } from '../../src/sim/step';
import { spawnMissile, spawnShip, World } from '../../src/world/world';

const DT = 1 / 60;

beforeEach(() => {
  reseed(0x5eed);
  resetGravityWells();
  resetDuel();
});

function start(def: MissionDef) {
  const world = new World();
  const runner = new MissionRunner(world, def, { shipId: def.playerShipId }, DIFFICULTIES.normal);
  runner.build();
  return { world, runner };
}

// ───────── 第4章: 重力井戸 (T6-4) ─────────

describe('第4章 重力井戸の宣言', () => {
  it('ミッション定義に gravity-well が1つあり、周期は数秒 / 引きは正の値', () => {
    const wells = (VEIL_CH04.hazards ?? []).filter((h) => h.kind === 'gravity-well');
    expect(wells.length).toBe(1);
    const g = wells[0].gravity!;
    expect(g.cycle).toBeGreaterThan(2);
    expect(g.cycle).toBeLessThanOrEqual(12);
    expect(g.swing).toBeGreaterThan(0);
    expect(g.pull).toBeGreaterThan(0);
    // 影響半径は spread として読む
    expect(wells[0].spread).toBeGreaterThan(1000);
  });

  it('出撃すると井戸が登録され、宣言の無いミッションでは登録されない', () => {
    const { runner } = start(VEIL_CH04);
    expect(gravityWellState().wells.length).toBe(1);
    void runner;

    // 別のミッションを開くと必ず捨てられる (前の作戦の重力が残らない)
    start(missionDef('m1-patrol'));
    expect(gravityWellState().wells.length).toBe(0);
  });
});

describe('重力井戸の実効質量', () => {
  it('宣言が無ければ実効質量倍率は常に 1 (既定挙動)', () => {
    for (const p of [new Vector3(), new Vector3(1000, 0, -2000), new Vector3(-500, 200, 800)]) {
      expect(gravityMassFactor(p)).toBe(1);
    }
  });

  it('井戸の中では数秒周期で重くなったり軽くなったりする', () => {
    const center = new Vector3(0, 0, -1000);
    addGravityWell({ pos: center, radius: 4000, cycle: 8, swing: 0.45, pull: 0 });
    const world = new World();

    let min = Infinity;
    let max = -Infinity;
    // 1周期 (8秒) を回して振れ幅を見る
    for (let i = 0; i < 8 / DT; i++) {
      tickGravityWells(world, DT);
      const f = gravityMassFactor(center);
      min = Math.min(min, f);
      max = Math.max(max, f);
    }
    expect(max).toBeGreaterThan(1.3);
    expect(min).toBeLessThan(0.7);
  });

  it('影響半径の外では実効質量が変わらない', () => {
    addGravityWell({ pos: new Vector3(), radius: 4000, cycle: 8, swing: 0.45, pull: 0 });
    const world = new World();
    for (let i = 0; i < 120; i++) {
      tickGravityWells(world, DT);
      expect(gravityMassFactor(new Vector3(0, 0, -9000))).toBe(1);
    }
  });

  it('井戸の中では自機の機動が変わり、井戸が無ければ従来どおり飛ぶ', () => {
    /** 同じ操作入力で1秒飛ばし、到達位置と機首の向きを返す */
    const fly = (): { pos: Vector3; quat: Quaternion } => {
      const world = new World();
      const e = spawnShip(world, {
        def: shipDef('scimitar'),
        faction: 'confed',
        pos: new Vector3(0, 0, 0),
        quat: new Quaternion(),
        speed: 0,
      });
      e.input!.throttle = 1;
      e.input!.pitch = 1;
      for (let i = 0; i < 120; i++) {
        tickGravityWells(world, DT);
        updateFlight(e, DT, 'wc');
      }
      return { pos: e.pos.clone(), quat: e.quat.clone() };
    };

    const plain = fly();

    resetGravityWells();
    addGravityWell({ pos: new Vector3(), radius: 6000, cycle: 8, swing: 0.45, pull: 0 });
    const inWell = fly();

    // 加速の効きと旋回の効きの両方が変わる
    expect(inWell.pos.distanceTo(plain.pos)).toBeGreaterThan(20);
    expect(Math.abs(inWell.quat.angleTo(plain.quat))).toBeGreaterThan(0.02);

    // 井戸を捨てれば完全に元の飛び方へ戻る (回帰)
    resetGravityWells();
    const again = fly();
    expect(again.pos.distanceTo(plain.pos)).toBe(0);
    expect(again.quat.angleTo(plain.quat)).toBe(0);
  });

  it('第4章を開いた直後でも、井戸の外にいる限り機動は従来どおり', () => {
    const { world } = start(VEIL_CH04);
    const player = world.player!;
    // アンカーは NAV 2 の周辺。出撃地点 (原点) は井戸の外
    expect(gravityMassFactor(player.pos)).toBe(1);
  });
});

describe('重力井戸とミサイルの弾道', () => {
  /** 井戸の横を通り過ぎるミサイルを撃ち、飛翔方向の変化を測る */
  const launch = (): { world: World; missile: ReturnType<typeof spawnMissile> } => {
    const world = new World();
    const missile = spawnMissile(world, {
      missileId: 'heat-seeker',
      pos: new Vector3(0, 0, 0),
      dir: new Vector3(0, 0, -1),
      ownerId: 1,
      ownerFaction: 'confed',
      fromPlayer: true,
    });
    return { world, missile };
  };

  it('井戸が無ければミサイルは真っ直ぐ飛ぶ (既定挙動)', () => {
    const { world, missile } = launch();
    const dir0 = missile.vel.clone().normalize();
    for (let i = 0; i < 180; i++) {
      tickGravityWells(world, DT);
      missile.pos.addScaledVector(missile.vel, DT);
    }
    expect(missile.vel.clone().normalize().dot(dir0)).toBeCloseTo(1, 6);
    expect(Math.abs(missile.pos.x)).toBeLessThan(1e-6);
  });

  it('井戸の中を通るミサイルは弧を描いて井戸の側へ曲がる', () => {
    // 進路の横 (X+ 側) に井戸を置く。ミサイルは -Z へ飛ぶ
    addGravityWell({
      pos: new Vector3(800, 0, -1800),
      radius: 4200,
      cycle: 8,
      swing: 0,
      pull: 150,
    });
    const { world, missile } = launch();
    const dir0 = missile.vel.clone().normalize();
    for (let i = 0; i < 180; i++) {
      tickGravityWells(world, DT);
      missile.pos.addScaledVector(missile.vel, DT);
    }
    // 井戸の側へ引かれている
    expect(missile.pos.x).toBeGreaterThan(50);
    // 飛翔方向そのものが曲がっている (真っ直ぐではない)
    const turned = Math.acos(Math.min(1, missile.vel.clone().normalize().dot(dir0)));
    expect(turned).toBeGreaterThan(0.05);
  });

  it('井戸のすぐ横を低速で通れば、弾道は井戸を回り込むように大きく曲がる', () => {
    addGravityWell({
      pos: new Vector3(600, 0, -1500),
      radius: 4000,
      cycle: 8,
      swing: 0,
      pull: 400,
    });
    const { world, missile } = launch();
    const dir0 = missile.vel.clone().normalize();
    let maxTurn = 0;
    for (let i = 0; i < 600; i++) {
      tickGravityWells(world, DT);
      missile.pos.addScaledVector(missile.vel, DT);
      maxTurn = Math.max(
        maxTurn,
        Math.acos(Math.max(-1, Math.min(1, missile.vel.clone().normalize().dot(dir0)))),
      );
    }
    // 45度以上曲がる = 「弧を描いて戻ってくる」挙動
    expect(maxTurn).toBeGreaterThan(Math.PI / 4);
  });
});

describe('移動する残骸帯', () => {
  /** 岩の平均速度 (帯全体が流れているかを見る) */
  const meanRockVel = (world: World): Vector3 => {
    const rocks = world.entities.filter((e) => e.kind === 'rock');
    const sum = new Vector3();
    for (const r of rocks) sum.add(r.vel);
    return rocks.length ? sum.divideScalar(rocks.length) : sum;
  };

  it('第4章の残骸帯は drift を宣言していて、帯全体が同じ方向へ流れる', () => {
    const drifting = (VEIL_CH04.hazards ?? []).filter((h) => h.drift);
    expect(drifting.length).toBeGreaterThan(0);
    for (const h of drifting) {
      expect(h.kind).toBe('asteroids');
      expect(h.drift!.speed).toBeGreaterThan(20);
    }

    const { world } = start(VEIL_CH04);
    // 個々の漂流 (±8 m/s) では説明できない共通の流れがある
    expect(meanRockVel(world).length()).toBeGreaterThan(20);
  });

  it('帯は時間とともに位置がずれる', () => {
    const { world } = start(VEIL_CH04);
    const rock = world.entities.find((e) => e.kind === 'rock')!;
    const before = rock.pos.clone();
    for (let i = 0; i < 300; i++) updateObstacles(world, DT);
    // 5秒で 100m 以上ずれる (帯を抜ける航路が往路と復路で変わる)
    expect(rock.pos.distanceTo(before)).toBeGreaterThan(100);
  });

  it('drift を宣言していない既存ミッションの小惑星帯は静的なまま (回帰)', () => {
    for (const id of ['m1-patrol', 'm3-strike']) {
      const def = missionDef(id);
      for (const h of def.hazards ?? []) expect(h.drift).toBeUndefined();
      const { world } = start(def);
      if (world.entities.some((e) => e.kind === 'rock')) {
        // 共通の流れは無い (個々の微速な漂流だけ)
        expect(meanRockVel(world).length()).toBeLessThan(8);
      }
    }
    // 第5章の灰も静的
    const { world } = start(VEIL_CH05);
    expect(meanRockVel(world).length()).toBeLessThan(8);
  });
});

// ───────── 第5章: 決闘規約 (T6-5) ─────────

/** 自機とラギティカだけの決闘空域を作る */
function duelScene(opts: { playerHullRatio?: number } = {}) {
  const world = new World();
  const facing = new Quaternion().setFromUnitVectors(new Vector3(0, 0, -1), new Vector3(0, 0, -1));
  const player = spawnShip(world, {
    def: shipDef('rapier'),
    faction: 'confed',
    pos: new Vector3(0, 0, 0),
    quat: facing,
    speed: 200,
    label: '自機',
  });
  world.playerId = player.id;
  const ace = spawnShip(world, {
    def: shipDef('kf03-greyhaul'),
    faction: 'kilrathi',
    pos: new Vector3(0, 0, -1200),
    quat: new Quaternion().setFromUnitVectors(new Vector3(0, 0, -1), new Vector3(0, 0, 1)),
    speed: 200,
    pilot: 'ラギティカ',
    ace: true,
    ai: newAi(0.9),
  });
  if (opts.playerHullRatio !== undefined) {
    player.ship!.hull = player.ship!.def.hull * opts.playerHullRatio;
  }
  configureDuel({
    duellistId: ace.id,
    opponentId: player.id,
    spareHullRatio: 0.4,
    measureRange: 900,
  });
  return { world, player, ace };
}

/** N ステップ回して、エースが引き金を引いた回数と距離の統計を返す */
function runDuel(
  scene: { world: World; player: ReturnType<typeof spawnShip>; ace: ReturnType<typeof spawnShip> },
  steps: number,
) {
  let shots = 0;
  let minDistance = Infinity;
  let maxDistance = 0;
  for (let i = 0; i < steps; i++) {
    simulateStep(scene.world, DT, { flightMode: 'wc', ai: {} });
    if (!scene.ace.alive || !scene.player.alive) break;
    if (scene.ace.input!.firePrimary) shots += 1;
    const d = scene.ace.pos.distanceTo(scene.player.pos);
    minDistance = Math.min(minDistance, d);
    maxDistance = Math.max(maxDistance, d);
    // 削り切られないよう自機のハルは維持する (測るのは狙い方だけ)
    scene.player.ship!.hull = Math.max(scene.player.ship!.hull, 1);
  }
  return { shots, minDistance, maxDistance };
}

describe('第5章 決闘規約の宣言', () => {
  it('ラギティカに決闘規約が宣言されている (撃墜を狙わない閾値と測る距離)', () => {
    const aceGroup = VEIL_CH05.spawns.find((g) => g.ace?.duel);
    expect(aceGroup).toBeDefined();
    const d = aceGroup!.ace!.duel!;
    expect(d.spareHullRatio).toBeGreaterThan(0);
    expect(d.measureRange).toBeGreaterThan(0);
    expect(d.crippleAfter).toBeGreaterThan(0);
    // 技量の上書きは決闘規約に含まれない (難易度に触らない)
    expect(Object.keys(d)).not.toContain('skill');
  });

  it('急進派の群だけが誓約を破る側として立っている', () => {
    const breakers = VEIL_CH05.spawns.filter((g) => g.breaksOath);
    expect(breakers.length).toBe(2);
    for (const g of breakers) expect(g.tag).toBe('radical');
    // 決闘の当事者は誓約を破らない
    expect(VEIL_CH05.spawns.find((g) => g.ace?.duel)!.breaksOath).toBeUndefined();
  });

  it('帝国艦隊は1隻も置かない (誓約中の沈黙の近似) / 陣営関係は組み替えない', () => {
    for (const g of VEIL_CH05.spawns) {
      expect(shipDef(g.shipId).role).not.toBe('capital');
    }
    // 同じ kilrathi の中に誓約派と急進派が同居するので、陣営単位では書けない
    expect(VEIL_CH05.factionStances).toBeUndefined();
  });

  it('救出目標は「戦闘不能になってから接近」で、任意目標のまま', () => {
    const o = VEIL_CH05.objectives.find((x) => x.spec.kind === 'rescue');
    expect(o).toBeDefined();
    expect(o!.required).toBe(false);
    const spec = o!.spec as { kind: 'rescue'; disabledOnly?: boolean; radius?: number };
    expect(spec.disabledOnly).toBe(true);
  });
});

describe('決闘モードのラギティカ', () => {
  it('宣言が無ければ決闘モードは成立しない (既定)', () => {
    expect(duelActive()).toBe(false);
    expect(duelState().rules).toBeUndefined();
  });

  it('相手のハルが閾値を下回っていれば引き金を引かない (致命打を避ける)', () => {
    const scene = duelScene({ playerHullRatio: 0.2 });
    const { shots } = runDuel(scene, 1200);
    expect(shots).toBe(0);
    expect(scene.player.alive).toBe(true);
  });

  it('相手が無傷なら撃つ (撃たないのは「削り切る手前」だけ)', () => {
    const scene = duelScene();
    const { shots } = runDuel(scene, 1800);
    expect(shots).toBeGreaterThan(0);
  });

  it('距離を測る = 相手から離れも詰めもせず追随する', () => {
    const scene = duelScene();
    const { minDistance, maxDistance } = runDuel(scene, 1200);
    // 体当たりも見失いもしない範囲に収まる
    expect(minDistance).toBeGreaterThan(60);
    expect(maxDistance).toBeLessThan(9000);
  });

  it('ミサイルは使わない (決闘は機動で測る)', () => {
    const scene = duelScene();
    for (let i = 0; i < 1800; i++) {
      simulateStep(scene.world, DT, { flightMode: 'wc', ai: {} });
      scene.player.ship!.hull = scene.player.ship!.def.hull;
      expect(scene.world.entities.some((e) => e.alive && e.kind === 'missile')).toBe(false);
    }
  });

  it('急進派が現れると決闘は解除され、同じ陣営でも急進派へ機首を向ける', () => {
    const scene = duelScene();
    const radical = spawnShip(scene.world, {
      def: shipDef('kf01-leonfang'),
      faction: 'kilrathi',
      pos: new Vector3(1500, 0, -1500),
      speed: 200,
      ai: newAi(0.7),
    });
    expect(duelActive()).toBe(true);
    breakDuel([radical.id]);
    expect(duelActive()).toBe(false);
    expect(duelState().broken).toBe(true);

    let firedAtRadical = 0;
    for (let i = 0; i < 1200 && radical.alive && scene.ace.alive; i++) {
      simulateStep(scene.world, DT, { flightMode: 'wc', ai: {} });
      scene.player.ship!.hull = scene.player.ship!.def.hull;
      if (scene.ace.ai!.targetId === radical.id && scene.ace.input!.firePrimary) firedAtRadical += 1;
    }
    // 決闘の相手 (自機) ではなく、誓約を破った同陣営の機体を狙う
    expect(scene.ace.ai!.targetId).toBe(radical.id);
    expect(firedAtRadical).toBeGreaterThan(0);
  });
});

describe('第5章の進行 (誓約が破れ、片翼を失い、救出できる)', () => {
  /** Nav を順に踏ませて、指定秒まで進める */
  function advance(seconds: number) {
    const { world, runner } = start(VEIL_CH05);
    const player = world.player!;
    const navPos = (index: number) =>
      world.entities.find((e) => e.kind === 'nav' && e.nav?.index === index)!.pos.clone();
    // NAV 1 → NAV 2 (決闘空域) の順に到達させる
    player.pos.copy(navPos(0));
    runner.update(0.5);
    player.pos.copy(navPos(1));
    for (let t = 0; t < seconds; t += 0.5) runner.update(0.5);
    return { world, runner, player };
  }

  const ragitika = (world: World) =>
    world.entities.find((e) => e.alive && e.ship?.ace && e.faction === 'kilrathi');

  it('決闘の当事者が出現した時点で決闘規約が成立する', () => {
    const { world } = advance(10);
    const ace = ragitika(world);
    expect(ace).toBeDefined();
    expect(duelActive()).toBe(true);
    expect(duelState().rules!.duellistId).toBe(ace!.id);
    expect(duelState().rules!.opponentId).toBe(world.playerId);
  });

  it('急進派の出現で誓約が破れる', () => {
    const { runner } = advance(80);
    expect(runner.oathBroken).toBe(false);
    expect(duelActive()).toBe(true);

    const { runner: later } = advance(110);
    expect(later.oathBroken).toBe(true);
    expect(duelActive()).toBe(false);
    expect(duelState().breakerIds.size).toBeGreaterThan(0);
  });

  it('片翼を失っても脱出ポッドを出さない (救うには接近が必要)', () => {
    const { world, runner } = advance(150);
    expect(runner.duellistCrippled).toBe(true);
    const ace = ragitika(world)!;
    expect(runner.disabledShips.has(ace.id)).toBe(true);

    // 機動と武装を失って漂う
    expect(ace.ai!.passive).toBe(true);
    expect(ace.ship!.missiles.length).toBe(0);
    expect(ace.ship!.hull).toBeLessThan(ace.ship!.def.hull * 0.3);

    // 脱出信号は出さない: ポッド化もせず、脱出ポッドも湧かない
    expect(ace.ship!.ejected).toBeFalsy();
    expect(ace.faction).toBe('kilrathi');
    expect(world.entities.some((e) => e.alive && e.label === '脱出ポッド')).toBe(false);
    expect(
      world.entities.some((e) => e.alive && e.ship?.def.id === 'escape-pod'),
    ).toBe(false);
  });

  it('片翼を失う前に接近しても回収にはならない', () => {
    const { world, runner } = advance(20);
    const ace = ragitika(world)!;
    const player = world.player!;
    player.pos.copy(ace.pos);
    runner.update(0.5);
    expect(runner.summary().enemyRescued).toBe(0);
    expect(ace.alive).toBe(true);
  });

  it('片翼を失った相手に接近すると救出でき、結果に載る', () => {
    const { world, runner } = advance(150);
    const ace = ragitika(world)!;
    const player = world.player!;
    expect(runner.summary().enemyRescued).toBe(0);

    player.pos.copy(ace.pos);
    runner.update(0.5);

    expect(runner.summary().enemyRescued).toBe(1);
    expect(runner.summary().rescued).toBe(1);
    // 回収した対象は戦域から外れる
    expect(world.byId(ace.id)).toBeUndefined();
  });
});

// ───────── 既存ミッションの回帰 ─────────

describe('既存ミッションの回帰', () => {
  it('決闘規約も重力井戸も持ち越されない', () => {
    // 決闘の宣言が残っている状態で別のミッションを開いても持ち越されない
    configureDuel({ duellistId: 11, opponentId: 12 });
    expect(duelState().rules).toBeDefined();
    start(missionDef('m5-ace'));
    expect(duelState().rules).toBeUndefined();
    expect(duelActive()).toBe(false);

    start(VEIL_CH04);
    expect(gravityWellState().wells.length).toBe(1);
    start(missionDef('m5-ace'));
    expect(gravityWellState().wells.length).toBe(0);
  });

  it('m1-patrol は従来どおり飛べる (実効質量倍率が常に 1)', () => {
    const { world } = start(missionDef('m1-patrol'));
    const player = world.player!;
    player.input!.throttle = 1;
    for (let i = 0; i < 600; i++) {
      simulateStep(world, DT, { flightMode: 'wc', ai: { maxAttackersOnPlayer: 2 } });
      expect(gravityMassFactor(player.pos)).toBe(1);
    }
    expect(player.vel.length()).toBeGreaterThan(0);
  });

  it('決闘の宣言が無い敵機は、相手が半壊していても撃つ (AI の既定挙動)', () => {
    // duelScene と同じ配置だが決闘規約を宣言しない。
    // 「撃墜を狙わない」のは決闘の宣言があるときだけであることの回帰。
    const scene = duelScene({ playerHullRatio: 0.2 });
    resetDuel();
    expect(duelActive()).toBe(false);

    let shots = 0;
    for (let i = 0; i < 1800; i++) {
      simulateStep(scene.world, DT, { flightMode: 'wc', ai: {} });
      scene.player.ship!.hull = scene.player.ship!.def.hull * 0.2;
      if (scene.ace.input!.firePrimary) shots += 1;
    }
    expect(shots).toBeGreaterThan(0);
  });

  it('m5-ace はエースを従来どおり出せる (決闘モードに入らない)', () => {
    const { world, runner } = start(missionDef('m5-ace'));
    const player = world.player!;
    for (let i = 0; i < 600; i++) {
      simulateStep(world, DT, { flightMode: 'wc', ai: { maxAttackersOnPlayer: 4 } });
      runner.update(DT);
      player.ship!.hull = player.ship!.def.hull;
    }
    expect(duelActive()).toBe(false);
    expect(duelState().rules).toBeUndefined();
    expect(runner.state).toBe('running');
  });

  it('m5-ace ではミサイルも従来どおり使われる (弾道の曲げは掛からない)', () => {
    const { world } = start(missionDef('m5-ace'));
    const missile = spawnMissile(world, {
      missileId: 'heat-seeker',
      pos: new Vector3(0, 0, 0),
      dir: new Vector3(0, 0, -1),
      ownerId: world.playerId,
      ownerFaction: 'confed',
      fromPlayer: true,
    });
    const dir0 = missile.vel.clone().normalize();
    for (let i = 0; i < 120; i++) {
      tickGravityWells(world, DT);
      missile.pos.addScaledVector(missile.vel, DT);
    }
    expect(missile.vel.clone().normalize().dot(dir0)).toBeCloseTo(1, 6);
  });
});
