import { Vector3 } from 'three';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DIFFICULTIES } from '../../src/app/settings';
import { bus } from '../../src/core/events';
import { reseed } from '../../src/core/rng';
import { missionDef } from '../../src/content/missions';
import { shipDef } from '../../src/content/ships';
import { VEIL_CH06 } from '../../src/content/veil/missions/ch06';
import { VEIL_CH09 } from '../../src/content/veil/missions/ch09';
import { MissionRunner } from '../../src/mission/MissionRunner';
import type { Loadout, MissionDef, NavDef, RadioLineDef } from '../../src/mission/types';
import {
  MAX_SWARM_LEVEL,
  LOSSES_PER_SWARM_LEVEL,
  configureSwarmLearning,
  recordSwarmLoss,
  resetSwarmLearning,
  swarmLearningLevel,
  swarmProfile,
  updateAi,
} from '../../src/sim/ai';
import {
  commsDelaySeconds,
  configureCommsDelay,
  isPositionDelayed,
  recordCommsPositions,
  reportedLeadPoint,
  reportedPosition,
  reportedVelocity,
  resetCommsDelay,
} from '../../src/sim/comms';
import { ittsPoint, primaryGunSpeed } from '../../src/sim/targeting';
import { spawnShip, World } from '../../src/world/world';

const DT = 1 / 60;

beforeEach(() => {
  reseed(0x9a1e);
  resetCommsDelay();
  resetSwarmLearning();
});

afterEach(() => {
  resetCommsDelay();
  resetSwarmLearning();
});

function start(def: MissionDef, loadout?: Partial<Loadout>) {
  const world = new World();
  const runner = new MissionRunner(
    world,
    def,
    { shipId: def.playerShipId, ...loadout },
    DIFFICULTIES.normal,
  );
  runner.build();
  return { world, runner };
}

/** 味方1機だけの最小ワールド (自機 + 僚機) */
function commsWorld() {
  const world = new World();
  const player = spawnShip(world, {
    def: shipDef('rapier'),
    faction: 'confed',
    pos: new Vector3(0, 0, 0),
    label: '自機',
  });
  world.playerId = player.id;
  const wing = spawnShip(world, {
    def: shipDef('scimitar'),
    faction: 'confed',
    pos: new Vector3(0, 0, -1000),
    label: '僚機',
  });
  wing.vel.set(0, 0, -100);
  const foe = spawnShip(world, {
    def: shipDef('nr03-mandible'),
    faction: 'neurowm',
    pos: new Vector3(0, 0, -2000),
    label: '敵',
  });
  foe.vel.set(0, 0, -100);
  return { world, player, wing, foe };
}

/**
 * 味方機を等速で動かしながら時間を進める。
 * `recordCommsPositions` の時計はミッション経過秒なので、ここでも同じ形で回す。
 */
function advance(
  world: World,
  movers: Array<{ pos: Vector3; vel: Vector3 }>,
  seconds: number,
  from = 0,
): number {
  let t = from;
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) {
    t += DT;
    for (const m of movers) m.pos.addScaledVector(m.vel, DT);
    recordCommsPositions(world, t);
  }
  return t;
}

// ───────── 第6章: 通信妨害 (T6-6) ─────────

describe('第6章 通信妨害による味方位置の3秒遅延', () => {
  it('ミッション定義が3秒の遅延を宣言している', () => {
    expect(VEIL_CH06.commsDelay?.friendlySeconds).toBe(3);
  });

  it('build() で遅延が有効になり、dispose() で既定へ戻る', () => {
    expect(commsDelaySeconds()).toBe(0);
    const { runner } = start(VEIL_CH06);
    expect(commsDelaySeconds()).toBe(3);
    expect(runner.commsDelayActive).toBe(true);
    runner.dispose();
    expect(commsDelaySeconds()).toBe(0);
  });

  it('味方の報告位置は3秒前の位置になる', () => {
    configureCommsDelay({ friendlySeconds: 3 });
    const { world, wing } = commsWorld();
    advance(world, [wing], 6);

    expect(isPositionDelayed(wing)).toBe(true);
    const reported = reportedPosition(wing, new Vector3());
    // 6秒で 600 進んだので実位置は -1600、報告位置は3秒前の -1300 付近
    expect(wing.pos.z).toBeCloseTo(-1600, 0);
    expect(reported.z).toBeGreaterThan(-1340);
    expect(reported.z).toBeLessThan(-1260);
    // 報告位置は実位置から「3秒分の距離」だけ遅れている
    expect(reported.distanceTo(wing.pos)).toBeGreaterThan(250);
    expect(reported.distanceTo(wing.pos)).toBeLessThan(350);
  });

  it('遅延を宣言しなければ味方位置も実位置のまま (回帰)', () => {
    const { world, wing } = commsWorld();
    advance(world, [wing], 6);
    expect(commsDelaySeconds()).toBe(0);
    expect(isPositionDelayed(wing)).toBe(false);
    expect(reportedPosition(wing, new Vector3()).z).toBeCloseTo(wing.pos.z, 5);
    expect(reportedVelocity(wing, new Vector3()).z).toBeCloseTo(wing.vel.z, 5);
  });

  it('敵の位置は遅延しない (妨害されているのは味方同士の通信)', () => {
    configureCommsDelay({ friendlySeconds: 3 });
    const { world, wing, foe } = commsWorld();
    advance(world, [wing, foe], 6);

    expect(isPositionDelayed(foe)).toBe(false);
    expect(reportedPosition(foe, new Vector3()).z).toBeCloseTo(foe.pos.z, 5);
    // 味方だけがずれている
    expect(isPositionDelayed(wing)).toBe(true);
  });

  it('自機の位置は遅延しない (自分の位置は自分が知っている)', () => {
    configureCommsDelay({ friendlySeconds: 3 });
    const { world, player, wing } = commsWorld();
    player.vel.set(0, 0, -100);
    advance(world, [player, wing], 6);
    expect(isPositionDelayed(player)).toBe(false);
    expect(reportedPosition(player, new Vector3()).z).toBeCloseTo(player.pos.z, 5);
  });

  it('照準支援 (ITTS) も遅延した位置と速度から計算される', () => {
    configureCommsDelay({ friendlySeconds: 3 });
    const { world, player, wing, foe } = commsWorld();
    advance(world, [wing, foe], 6);

    const gunSpeed = primaryGunSpeed(player, 1);
    const delayedLead = reportedLeadPoint(player, wing, gunSpeed, new Vector3());
    const trueLead = ittsPoint(player, wing, new Vector3(), 1);
    // 味方の射点は「3秒前の位置」から作られるので、実位置由来の射点とずれる
    expect(delayedLead.distanceTo(trueLead)).toBeGreaterThan(250);

    // 敵は遅延しないので、従来の ittsPoint と完全に一致する
    const foeLead = reportedLeadPoint(player, foe, gunSpeed, new Vector3());
    const foeTrue = ittsPoint(player, foe, new Vector3(), 1);
    expect(foeLead.distanceTo(foeTrue)).toBeCloseTo(0, 6);
  });

  it('遅延なしでは照準支援が従来の ittsPoint と一致する (回帰)', () => {
    const { world, player, wing } = commsWorld();
    advance(world, [wing], 4);
    const lead = reportedLeadPoint(player, wing, primaryGunSpeed(player, 1), new Vector3());
    const itts = ittsPoint(player, wing, new Vector3(), 1);
    expect(lead.distanceTo(itts)).toBeCloseTo(0, 6);
  });

  it('出撃直後 (3秒未満) は最も古い記録=発艦位置を報告する', () => {
    configureCommsDelay({ friendlySeconds: 3 });
    const { world, wing } = commsWorld();
    const startZ = wing.pos.z;
    advance(world, [wing], 1);
    // 最初に刻んだ標本 (1フレーム分だけ進んだ位置) が報告される
    expect(Math.abs(reportedPosition(wing, new Vector3()).z - startZ)).toBeLessThan(5);
  });

  it('遅延中であることが無線と目標の note の二経路で伝わる', () => {
    // (1) 無線: 定義側に「3秒」を明言する台詞がある
    const lines: RadioLineDef[] = [
      ...(VEIL_CH06.openingRadio ?? []),
      ...VEIL_CH06.navs.flatMap((n: NavDef) => n.onArrive ?? []),
    ];
    expect(lines.some((l) => l.text.includes('3秒'))).toBe(true);

    // (2) 目標の note: 到達目標の行に遅延秒数が出る
    const { runner } = start(VEIL_CH06);
    runner.update(DT);
    const views = runner.objectiveViews();
    expect(views.some((v) => v.text.includes('味方位置 3秒遅延'))).toBe(true);
    runner.dispose();
  });

  it('遅延を宣言しないミッションの目標 note には遅延が出ない (回帰)', () => {
    const { runner } = start(missionDef('m1-patrol'));
    runner.update(DT);
    expect(runner.commsDelayActive).toBe(false);
    for (const v of runner.objectiveViews()) {
      expect(v.text).not.toContain('遅延');
    }
    runner.dispose();
  });
});

// ───────── 第6章: 学習するドローン (T6-6) ─────────

describe('第6章 学習する群体', () => {
  it('ミッション定義がニューロウムの学習を宣言している', () => {
    expect(VEIL_CH06.swarmLearning?.faction).toBe('neurowm');
  });

  it('撃墜数に応じて段階が上がり、上限で止まる', () => {
    configureSwarmLearning({ faction: 'neurowm' });
    expect(swarmLearningLevel()).toBe(0);
    for (let i = 0; i < LOSSES_PER_SWARM_LEVEL; i++) recordSwarmLoss('neurowm');
    expect(swarmLearningLevel()).toBe(1);
    for (let i = 0; i < LOSSES_PER_SWARM_LEVEL * 2; i++) recordSwarmLoss('neurowm');
    expect(swarmLearningLevel()).toBe(3);
    // 100機失っても上限を超えない
    for (let i = 0; i < 100; i++) recordSwarmLoss('neurowm');
    expect(swarmLearningLevel()).toBe(MAX_SWARM_LEVEL);
    const profile = swarmProfile('neurowm');
    expect(profile.attackerBonus).toBe(MAX_SWARM_LEVEL);
    expect(profile.maneuverCooldownScale).toBeGreaterThan(0.6);
  });

  it('宣言した陣営以外の撃墜は学習に数えない', () => {
    configureSwarmLearning({ faction: 'neurowm' });
    for (let i = 0; i < 20; i++) recordSwarmLoss('kilrathi');
    expect(swarmLearningLevel()).toBe(0);
    expect(swarmProfile('kilrathi').level).toBe(0);
  });

  it('学習しても難易度パラメータ (HP・攻撃力・弾速・技量) は変わらない', () => {
    const world = new World();
    const player = spawnShip(world, {
      def: shipDef('rapier'),
      faction: 'confed',
      pos: new Vector3(0, 0, 0),
    });
    world.playerId = player.id;
    const drone = spawnShip(world, {
      def: shipDef('nr03-mandible'),
      faction: 'neurowm',
      pos: new Vector3(0, 0, -1200),
      ai: { mode: 'idle', skill: 0.5, timer: 0, maneuverTimer: 0, maneuverSign: 1, maneuverCooldown: 0, morale: 1, fireHold: 0, missileCooldown: 3, engagedFor: 0 },
    });
    const before = {
      hull: drone.ship!.hull,
      defHull: drone.ship!.def.hull,
      armor: { ...drone.ship!.def.armor },
      shield: { ...drone.ship!.def.shield },
      guns: drone.ship!.def.guns.map((g) => g.gunId),
      speedScale: drone.ship!.speedScale,
      maxSpeed: drone.ship!.def.maxSpeed,
      skill: drone.ai!.skill,
    };

    configureSwarmLearning({ faction: 'neurowm' });
    for (let i = 0; i < 40; i++) recordSwarmLoss('neurowm');
    for (let i = 0; i < 120; i++) updateAi(world, DT);

    expect(swarmLearningLevel()).toBe(MAX_SWARM_LEVEL);
    expect(drone.ship!.hull).toBe(before.hull);
    expect(drone.ship!.def.hull).toBe(before.defHull);
    expect(drone.ship!.def.armor).toEqual(before.armor);
    expect(drone.ship!.def.shield).toEqual(before.shield);
    expect(drone.ship!.def.guns.map((g) => g.gunId)).toEqual(before.guns);
    expect(drone.ship!.speedScale).toBe(before.speedScale);
    expect(drone.ship!.def.maxSpeed).toBe(before.maxSpeed);
    // 命中補正の出所である技量も変わらない
    expect(drone.ai!.skill).toBe(before.skill);
    // 学習プロファイルは振る舞いの項目しか持たない
    expect(Object.keys(swarmProfile('neurowm')).sort()).toEqual(
      ['attackerBonus', 'lateralSpread', 'level', 'maneuverCooldownScale', 'pursueRangeScale'],
    );
  });

  it('宣言のないミッションでは AI の挙動が変わらない (回帰)', () => {
    // 学習を宣言せずに撃墜を記録しても、プロファイルは既定のまま
    for (let i = 0; i < 30; i++) recordSwarmLoss('neurowm');
    expect(swarmLearningLevel()).toBe(0);
    const p = swarmProfile('neurowm');
    expect(p).toEqual({
      level: 0,
      attackerBonus: 0,
      lateralSpread: 0,
      maneuverCooldownScale: 1,
      pursueRangeScale: 1,
    });

    // 既存ミッションを build しても学習は無効
    const { runner } = start(missionDef('m3-strike'));
    runner.update(DT);
    expect(swarmLearningLevel()).toBe(0);
    runner.dispose();
  });

  it('MissionRunner がドローンの撃墜を学習として積む', () => {
    const { world, runner } = start(VEIL_CH06);
    // ch06 のドローンは Nav 到達で出てくるので、ここでは1機置いて撃墜通知だけを流す
    const drone = spawnShip(world, {
      def: shipDef('nr03-mandible'),
      faction: 'neurowm',
      pos: new Vector3(0, 0, -3000),
    });
    for (let i = 0; i < LOSSES_PER_SWARM_LEVEL; i++) {
      bus.emit('destroyed', { target: drone, killedByPlayer: true });
    }
    expect(swarmLearningLevel()).toBe(1);
    runner.dispose();
  });
});

// ───────── 第9章: 位相迷路 (T6-9) ─────────

/** 反射 Nav の宣言だけを取り出す */
function reflections(def: MissionDef): Array<{ index: number; penalty: number }> {
  return def.navs
    .map((n, index) => ({ index, penalty: n.reflection?.penaltySeconds ?? 0 }))
    .filter((n) => n.penalty > 0);
}

/** Nav を順に巡ったときの巡航所要秒 (発艦点から) */
function cruiseSeconds(def: MissionDef, indices: number[]): number {
  const speed = shipDef(def.playerShipId).maxSpeed;
  let from = new Vector3(0, 0, 0);
  let total = 0;
  for (const i of indices) {
    const to = new Vector3(...def.navs[i].pos);
    total += from.distanceTo(to) / speed;
    from = to;
  }
  return total;
}

describe('第9章 位相迷路の反射経路', () => {
  it('各層の反射 Nav にだけ帰投窓のペナルティが入っている', () => {
    const list = reflections(VEIL_CH09);
    // 層1の2つ (index 0,1) と層2の2つ (index 3,4)
    expect(list.map((r) => r.index)).toEqual([0, 1, 3, 4]);
    // 必須目標が指す Nav は反射ではない
    const required = VEIL_CH09.objectives
      .filter((o) => o.required && o.spec.kind === 'reachNav')
      .map((o) => (o.spec as { navIndex: number }).navIndex);
    for (const idx of required) {
      expect(VEIL_CH09.navs[idx].reflection).toBeUndefined();
    }
  });

  it('反射 Nav は航路チェーンから外れており、実経路の Nav が次の目的地になる', () => {
    const { world, runner } = start(VEIL_CH09);
    const navs = world.entities.filter((e) => e.kind === 'nav');
    expect(navs.find((e) => e.nav!.index === 0)!.nav!.reached).toBe(true);
    expect(navs.find((e) => e.nav!.index === 1)!.nav!.reached).toBe(true);
    expect(navs.find((e) => e.nav!.index === 2)!.nav!.reached).toBe(false);
    // 誘導は実経路 (NAV 3 = index 2) を指す
    expect(runner.currentNav?.nav?.index).toBe(2);
    // 見せかけの到達済みは航路点の到達数に数えない
    expect(runner.summary().navsReached).toBe(0);
    runner.dispose();
  });

  it('反射 Nav を踏むと帰投窓が縮み、踏まなければ縮まない', () => {
    const { world, runner } = start(VEIL_CH09);
    runner.update(DT);
    const windowLine = () =>
      runner.objectiveViews().find((v) => v.text.includes('帰投窓'))!.text;
    const before = windowLine();
    expect(runner.returnWindowPenalty).toBe(0);
    expect(before).toContain('残り 540s');

    // 実経路 (index 2) の方向へ進んでも縮まない
    world.player!.pos.set(...VEIL_CH09.navs[2].pos);
    runner.update(DT);
    expect(runner.returnWindowPenalty).toBe(0);

    // 反射 (index 0) を踏むと 90 秒引かれる
    world.player!.pos.set(...VEIL_CH09.navs[0].pos);
    runner.update(DT);
    expect(runner.reflectionsStepped).toBe(1);
    expect(runner.returnWindowPenalty).toBe(90);
    expect(windowLine()).toContain('反射 1 回');
    expect(windowLine()).toContain('−90s');

    // 同じ反射を二度踏んでも二重に引かない
    runner.update(DT);
    expect(runner.returnWindowPenalty).toBe(90);
    runner.dispose();
  });

  it('反射を全部踏むと帰投窓が実経路の所要時間に足りなくなる', () => {
    const limit = VEIL_CH09.objectives.find((o) => o.spec.kind === 'timeLimit');
    const seconds = (limit!.spec as { seconds: number }).seconds;
    const penalty = reflections(VEIL_CH09).reduce((a, r) => a + r.penalty, 0);
    // 実経路: NAV3(2) → NAV6(5) → NAV7(6) → NAV8(7)
    const realPath = cruiseSeconds(VEIL_CH09, [2, 5, 6, 7]);

    // 実経路だけを踏めば、読み取り (recon 6秒) を足しても余裕がある
    expect(realPath + 6).toBeLessThan(seconds * 0.6);
    // 反射を4つとも踏むと、残る窓では巡航で戻り切れない
    expect(seconds - penalty).toBeLessThan(realPath);
  });

  it('反射経路のペナルティは経過時間そのものを進めない (無線と recon の時計は不変)', () => {
    const { world, runner } = start(VEIL_CH09);
    runner.update(DT);
    const elapsedBefore = runner.elapsed;
    world.player!.pos.set(...VEIL_CH09.navs[0].pos);
    runner.update(DT);
    expect(runner.elapsed).toBeCloseTo(elapsedBefore + DT, 6);
    expect(runner.returnWindowPenalty).toBe(90);
    runner.dispose();
  });

  it('踏むほど幻影の僚機が増える', () => {
    const { world, runner } = start(VEIL_CH09);
    const decoys = () =>
      world.entities.filter((e) => e.alive && e.kind === 'ship' && e.tag === 'decoy').length;
    runner.update(DT);
    expect(decoys()).toBe(0);

    // 反射を1つ踏むと第1群が出る (delay 3秒)
    world.player!.pos.set(...VEIL_CH09.navs[0].pos);
    for (let i = 0; i < 60 * 5; i++) runner.update(DT);
    const after1 = decoys();
    expect(after1).toBeGreaterThan(0);

    // 2つ目を踏むと群が増える
    world.player!.pos.set(...VEIL_CH09.navs[1].pos);
    for (let i = 0; i < 60 * 6; i++) runner.update(DT);
    expect(decoys()).toBeGreaterThan(after1);
    runner.dispose();
  });

  it('反射を宣言しないミッションでは帰投窓が従来どおり (回帰)', () => {
    const { world, runner } = start(missionDef('m1-patrol'));
    for (let i = 0; i < 60; i++) runner.update(DT);
    expect(runner.returnWindowPenalty).toBe(0);
    expect(runner.reflectionsStepped).toBe(0);
    for (const v of runner.objectiveViews()) expect(v.text).not.toContain('反射');
    expect(world.entities.filter((e) => e.kind === 'nav' && e.nav?.reached).length).toBe(0);
    runner.dispose();
  });
});

describe('第9章 過去章の無線を実際の選択から再生する', () => {
  /** ミッション開始から一定時間ぶん回して、流れた無線を集める */
  function radioAfter(loadout: Partial<Loadout>, navIndex: number): string[] {
    const messages: string[] = [];
    const off = bus.on('radio', (m) => messages.push(m.text));
    const { world, runner } = start(VEIL_CH09, loadout);
    world.player!.pos.set(...VEIL_CH09.navs[navIndex].pos);
    for (let i = 0; i < 60 * 14; i++) runner.update(DT);
    off();
    runner.dispose();
    return messages;
  }

  it('救難を選んだ無線は「告発」として返る', () => {
    const texts = radioAfter({ choices: { 'veil-ch01': 'rescue' } }, 0).join('\n');
    expect(texts).toContain('あなたは私たちを拾った');
    expect(texts).not.toContain('追ってくれてよかった');
  });

  it('追撃を選んだ無線は「謝罪」として返る', () => {
    const texts = radioAfter({ choices: { 'veil-ch01': 'pursue' } }, 0).join('\n');
    expect(texts).toContain('すまなかった');
    expect(texts).not.toContain('あなたは私たちを拾った');
  });

  it('記録が無い出撃では、どちらの意味にも転ぶ既定台詞が出る', () => {
    const texts = radioAfter({ choices: {} }, 0).join('\n');
    expect(texts).toContain('どちらの意味にも転びます');
    expect(texts).not.toContain('あなたは私たちを拾った');
    expect(texts).not.toContain('すまなかった');
  });

  it('第5章・第8章の選択も同じ形で差し替わる', () => {
    const victory = radioAfter({ choices: { 'veil-ch05': 'victory' } }, 1).join('\n');
    expect(victory).toContain('どの記録にも残らなかった');
    const saved = radioAfter({ choices: { 'veil-ch05': 'save-ace' } }, 1).join('\n');
    expect(saved).toContain('悪かったと思っている');

    const guard = radioAfter({ choices: { 'veil-ch08': 'guard-fleet' } }, 4).join('\n');
    expect(guard).toContain('誰にも拾われなかった');
    const rescue = radioAfter({ choices: { 'veil-ch08': 'rescue-enemy' } }, 4).join('\n');
    expect(rescue).toContain('自力で耐えた');
  });

  it('条件を書いていない無線は従来どおり必ず流れる (回帰)', () => {
    const messages: string[] = [];
    const off = bus.on('radio', (m) => messages.push(m.text));
    const { runner } = start(missionDef('m1-patrol'));
    for (let i = 0; i < 60 * 12; i++) runner.update(DT);
    off();
    runner.dispose();
    const opening = missionDef('m1-patrol').openingRadio ?? [];
    expect(opening.length).toBeGreaterThan(0);
    for (const line of opening) expect(messages).toContain(line.text);
  });
});
