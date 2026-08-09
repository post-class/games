import { Vector3 } from 'three';
import { beforeEach, describe, expect, it } from 'vitest';
import { DIFFICULTIES } from '../../src/app/settings';
import {
  advance,
  CAMPAIGN,
  CAMPAIGN_START,
  DEFEAT,
  isTerminal,
  VICTORY,
} from '../../src/content/campaign';
import { MISSIONS, missionDef } from '../../src/content/missions';
import { reseed } from '../../src/core/rng';
import { bus } from '../../src/core/events';
import { MissionRunner } from '../../src/mission/MissionRunner';
import type { MissionDef } from '../../src/mission/types';
import { newAi } from '../../src/sim/ai';
import { destroyEntity, setCombatOptions } from '../../src/sim/combat';
import { simulateStep } from '../../src/sim/step';
import { newSubsystems } from '../../src/sim/subsystems';
import { World } from '../../src/world/world';

const DT = 1 / 60;

beforeEach(() => {
  reseed(0xc0ffee);
  setCombatOptions({ playerDamageTaken: 1, playerDamageDealt: 1 });
});

function start(def: MissionDef, difficultyId: 'easy' | 'normal' | 'hard' = 'normal') {
  const world = new World();
  const profile = DIFFICULTIES[difficultyId];
  // ダメージ倍率はグローバル設定なので、難易度に合わせて揃えておく
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

/** 指定秒だけ進める */
function run(world: World, runner: MissionRunner, seconds: number, maxAttackers = 2): void {
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) {
    simulateStep(world, DT, { flightMode: 'wc', ai: { maxAttackersOnPlayer: maxAttackers } });
    runner.update(DT);
    if (runner.state !== 'running') return;
  }
}

/** 自機を指定 Nav へ瞬間移動させる (オートパイロット相当) */
function jumpToNav(world: World, index: number, def: MissionDef): void {
  const player = world.player!;
  player.pos.set(...def.navs[index].pos);
  player.prevPos.copy(player.pos);
  player.renderPrevPos.copy(player.pos);
}

/**
 * Nav は順番に踏む必要がある (nextNav が最小の未到達 index を返す)。
 * index までを順に到達させる。
 */
function reachNav(world: World, runner: MissionRunner, def: MissionDef, index: number): void {
  for (let i = 0; i <= index; i++) {
    jumpToNav(world, i, def);
    run(world, runner, 0.2);
    if (runner.state !== 'running') return;
  }
}

describe('ミッションデータの整合性', () => {
  it('全ミッションの Nav 参照と タグ参照が壊れていない', () => {
    for (const def of Object.values(MISSIONS)) {
      expect(def.navs.length).toBeGreaterThan(0);
      const tags = new Set(def.spawns.map((s) => s.tag).filter(Boolean) as string[]);
      for (const o of def.objectives) {
        if (o.spec.kind === 'reachNav') {
          expect(o.spec.navIndex, `${def.id}/${o.id}`).toBeLessThan(def.navs.length);
          expect(o.spec.navIndex).toBeGreaterThanOrEqual(0);
        }
        if (o.spec.kind === 'protect' || o.spec.kind === 'destroyTag') {
          expect(tags.has(o.spec.tag), `${def.id}/${o.id} のタグ ${o.spec.tag}`).toBe(true);
        }
      }
      for (const s of def.spawns) {
        if (s.atNav !== undefined) expect(s.atNav).toBeLessThan(def.navs.length);
        if (s.cruiseToNav !== undefined) expect(s.cruiseToNav).toBeLessThan(def.navs.length);
      }
      // 必須目標が1つ以上ある
      expect(def.objectives.some((o) => o.required)).toBe(true);
      expect(def.briefing.length).toBeGreaterThan(0);
      expect(def.debriefWin.length).toBeGreaterThan(0);
      expect(def.debriefLoss.length).toBeGreaterThan(0);
    }
  });

  it('ミッションの機体 id は実在する', () => {
    for (const def of Object.values(MISSIONS)) {
      expect(() => missionDef(def.id)).not.toThrow();
    }
  });
});

describe('キャンペーン分岐', () => {
  it('全ノードの遷移先が存在する', () => {
    for (const [id, node] of Object.entries(CAMPAIGN)) {
      expect(MISSIONS[node.missionId], `${id} のミッション`).toBeDefined();
      for (const next of [node.onWin, node.onLoss]) {
        if (!isTerminal(next)) expect(CAMPAIGN[next], `${id} → ${next}`).toBeDefined();
      }
    }
  });

  it('勝ち続けると VICTORY に到達する', () => {
    let node = CAMPAIGN_START;
    const seen: string[] = [];
    for (let i = 0; i < 20 && !isTerminal(node); i++) {
      seen.push(node);
      node = advance(node, 'win');
    }
    expect(node).toBe(VICTORY);
    expect(seen).toHaveLength(9);
  });

  it('負け続けると DEFEAT に到達する', () => {
    let node = CAMPAIGN_START;
    for (let i = 0; i < 20 && !isTerminal(node); i++) node = advance(node, 'loss');
    expect(node).toBe(DEFEAT);
  });

  it('敗北ルートで勝てば本線に合流する', () => {
    const l1 = advance('m1-patrol', 'loss');
    expect(l1).toBe('l1-retreat');
    expect(advance(l1, 'win')).toBe('m2b-recon');
    const l2 = advance('m4-defend', 'loss');
    expect(advance(l2, 'win')).toBe('m5-ace');
  });
});

describe('目標評価', () => {
  it('自機が失われると失敗になる', () => {
    const def = missionDef('m1-patrol');
    const { world, runner } = start(def);
    const player = world.player!;
    destroyEntity(world, player);
    world.compact();
    runner.update(DT);
    expect(runner.state).toBe('loss');
  });

  it('護衛対象が破壊されると失敗になる', () => {
    const def = missionDef('m2-escort');
    const { world, runner } = start(def);
    // Nav 0 到達で輸送艦が出る
    reachNav(world, runner, def, 0);
    run(world, runner, 1);
    const convoy = world.entities.find((e) => e.tag === 'convoy');
    expect(convoy).toBeDefined();
    destroyEntity(world, convoy!);
    world.compact();
    runner.update(DT);
    expect(runner.state).toBe('loss');
  });

  it('destroyTag は対象を全部壊すと達成になる', () => {
    const def = missionDef('m3-strike');
    const { world, runner } = start(def);
    reachNav(world, runner, def, 1);
    run(world, runner, 1);
    const supplies = world.entities.filter((e) => e.tag === 'supply');
    expect(supplies.length).toBe(2);
    for (const s of supplies) destroyEntity(world, s);
    world.compact();
    runner.update(DT);
    const view = runner.objectiveViews().find((v) => v.text.includes('ドーキア'));
    expect(view?.state).toBe('done');
  });

  it('survive は指定時間の経過で達成になる', () => {
    const def: MissionDef = {
      ...missionDef('l1-retreat'),
      spawns: [],
      objectives: [
        { id: 's', text: '3 秒耐える', required: true, spec: { kind: 'survive', seconds: 3 } },
      ],
    };
    const { world, runner } = start(def);
    run(world, runner, 2);
    expect(runner.state).toBe('running');
    run(world, runner, 2);
    expect(runner.state).toBe('win');
  });

  it('reachNav は到達で達成、未到達なら続行', () => {
    const def: MissionDef = {
      ...missionDef('m1-patrol'),
      spawns: [],
      objectives: [
        { id: 'n', text: 'NAV 1 到達', required: true, spec: { kind: 'reachNav', navIndex: 0 } },
      ],
    };
    const { world, runner } = start(def);
    run(world, runner, 1);
    expect(runner.state).toBe('running');
    jumpToNav(world, 0, def);
    run(world, runner, 0.2);
    expect(runner.state).toBe('win');
  });

  it('destroyAll は未出現のウェーブが残っている間は達成にならない', () => {
    const def = missionDef('m1-patrol');
    const { world, runner } = start(def);
    // 開始直後は敵ゼロだが、まだ Nav 未到達でウェーブが残っている
    run(world, runner, 1);
    const clear = runner.objectiveViews().find((v) => v.text.includes('全機撃破'));
    expect(clear?.state).toBe('active');
    expect(runner.state).toBe('running');
  });

  it('旗艦強襲は砲塔→エンジン→魚雷の順で進む', () => {
    const base = missionDef('m6-flagship');
    const flagshipSpawn = base.spawns.find((s) => s.tag === 'flagship')!;
    const def: MissionDef = {
      ...base,
      spawns: [{ ...flagshipSpawn, delay: 0 }],
      objectives: base.objectives.filter((o) => o.id !== 'escort'),
    };
    const { world, runner } = start(def);
    reachNav(world, runner, def, 1);
    run(world, runner, 0.5);

    const flagship = world.entities.find((e) => e.tag === 'flagship');
    expect(flagship?.ship).toBeDefined();
    flagship!.ship!.subsystems = newSubsystems();
    expect(runner.capitalStageIndex).toBe(0);

    // 砲塔を落とすまでは、エンジンが損傷しても段階は進まない
    flagship!.ship!.subsystems.turret = 'damaged';
    flagship!.ship!.subsystems.engine = 'damaged';
    run(world, runner, 0.1);
    expect(runner.capitalStageIndex).toBe(0);

    flagship!.ship!.subsystems.turret = 'dead';
    run(world, runner, 0.1);
    expect(runner.capitalStageIndex).toBe(1);

    // エンジン停止前は魚雷発射イベントだけでは最終段階へ行けない
    flagship!.ship!.subsystems.engine = 'damaged';
    bus.emit('weaponFired', {
      shooter: world.player!,
      muzzle: new Vector3(),
      direction: new Vector3(0, 0, -1),
      weaponKind: 'missile',
      weaponId: 'torpedo',
      isPlayer: true,
    });
    run(world, runner, 0.1);
    expect(runner.capitalStageIndex).toBe(1);

    flagship!.ship!.subsystems.engine = 'dead';
    run(world, runner, 0.1);
    expect(runner.capitalStageIndex).toBe(2);

    world.player!.ship!.lockedId = flagship!.id;
    bus.emit('weaponFired', {
      shooter: world.player!,
      muzzle: new Vector3(),
      direction: new Vector3(0, 0, -1),
      weaponKind: 'missile',
      weaponId: 'torpedo',
      isPlayer: true,
    });
    run(world, runner, 0.1);
    expect(runner.capitalStageIndex).toBe(3);

    destroyEntity(world, flagship!, world.player);
    world.compact();
    runner.update(DT);
    expect(runner.objectiveViews().find((v) => v.text.includes('カクタグ'))?.state).toBe('done');
  });
});

describe('ウェーブ投入', () => {
  it('Nav 到達で紐付いた敵グループが出現する', () => {
    const def = missionDef('m1-patrol');
    const { world, runner } = start(def);
    expect(world.entities.filter((e) => e.faction === 'kilrathi')).toHaveLength(0);
    reachNav(world, runner, def, 1);
    // delay 2 + 難易度のウェーブ遅延
    run(world, runner, 3 + DIFFICULTIES.normal.waveDelayBonus);
    expect(world.entities.filter((e) => e.faction === 'kilrathi').length).toBeGreaterThan(0);
  });

  it('エース指定のグループには ace フラグ付きの1機が含まれる', () => {
    const def = missionDef('m4-defend');
    const { world, runner } = start(def);
    // エースの波 (150 秒後) まで自機と護衛対象を落とされないようにする
    for (const e of world.entities) {
      if (e.ship) {
        e.ship.hull = 1e7;
        e.ship.armor = { front: 1e7, rear: 1e7, left: 1e7, right: 1e7 };
      }
    }
    run(world, runner, 160 + DIFFICULTIES.normal.waveDelayBonus);
    const aces = world.entities.filter((e) => e.ship?.ace);
    expect(aces.length).toBeGreaterThanOrEqual(1);
    expect(aces[0].ship!.pilot).toContain('Bhurak');
  });

  it('輸送艦は passive で、プレイヤーを攻撃しない', () => {
    const def = missionDef('m2-escort');
    const { world, runner } = start(def);
    reachNav(world, runner, def, 0);
    run(world, runner, 1);
    const convoy = world.entities.find((e) => e.tag === 'convoy')!;
    expect(convoy.ai?.passive).toBe(true);
    expect(convoy.ai?.cruiseTo).toBeDefined();
  });
});

describe('逃走した敵の扱い', () => {
  it('遠くまで逃げた敵は戦域から外れ、destroyAll が成立しうる', () => {
    const def: MissionDef = {
      ...missionDef('m1-patrol'),
      navs: [{ name: 'NAV 1', pos: [0, 0, -1000] }],
      spawns: [
        { shipId: 'ke04-mirage', count: 1, faction: 'kilrathi', atNav: 0, delay: 0, offset: [0, 0, -500] },
      ],
      objectives: [
        { id: 'clear', text: '撃破', required: true, spec: { kind: 'destroyAll' } },
      ],
    };
    const { world, runner } = start(def);
    reachNav(world, runner, def, 0);
    run(world, runner, 1);
    const enemy = world.entities.find((e) => e.faction === 'kilrathi');
    expect(enemy).toBeDefined();
    // 士気を折って遠方へ飛ばす
    enemy!.ship!.hull = enemy!.ship!.def.hull * 0.1;
    enemy!.ai!.morale = 0;
    enemy!.ai!.mode = 'flee';
    // 戦域外へ、自機から離れる方向に飛んでいる状態にする
    enemy!.pos.set(0, 0, -60000);
    enemy!.vel.set(0, 0, -400);
    run(world, runner, 0.1);
    expect(runner.state).toBe('win');
    expect(runner.summary().routed).toBe(1);
  });
});

describe('難易度の効き方', () => {
  it('やさしいでは出撃時に初速が入る', () => {
    const def = missionDef('m1-patrol');
    const easy = start(def, 'easy');
    const normal = start(def, 'normal');
    expect(easy.world.player!.vel.length()).toBeGreaterThan(0);
    expect(normal.world.player!.vel.length()).toBe(0);
  });

  it('やさしいではウェーブの投入が遅い', () => {
    const def = missionDef('m1-patrol');
    const easy = start(def, 'easy');
    const hard = start(def, 'hard');
    reachNav(easy.world, easy.runner, def, 1);
    reachNav(hard.world, hard.runner, def, 1);
    run(easy.world, easy.runner, 4);
    run(hard.world, hard.runner, 4);
    expect(hard.world.entities.filter((e) => e.faction === 'kilrathi').length).toBeGreaterThan(0);
    expect(easy.world.entities.filter((e) => e.faction === 'kilrathi').length).toBe(0);
  });
});

describe('ミッション通しプレイ (AI が自機を操縦)', () => {
  it('AI 操縦の自機でも哨戒ミッションを達成できる', () => {
    const def = missionDef('m1-patrol');
    const { world, runner } = start(def, 'easy');
    const player = world.player!;
    // 自機に高技量 AI を載せて自動で戦わせる
    player.ai = newAi(0.95);
    const maxAttackers = DIFFICULTIES.easy.maxAttackers;

    // Nav を順に踏み、そのつど出てきた敵を掃討する
    for (let navIndex = 0; navIndex < def.navs.length; navIndex++) {
      if (runner.state !== 'running') break;
      jumpToNav(world, navIndex, def);
      run(world, runner, 1 + DIFFICULTIES.easy.waveDelayBonus + 3, maxAttackers);
      // 出てきた敵を片付けるまで戦う (最大 240 秒)
      for (let t = 0; t < 240 && runner.state === 'running'; t++) {
        run(world, runner, 1, maxAttackers);
        if (world.entities.filter((e) => e.faction === 'kilrathi').length === 0) break;
      }
    }
    expect(runner.state).toBe('win');
    expect(world.player).toBeDefined();
  });
});
