import { Vector3 } from 'three';
import { beforeEach, describe, expect, it } from 'vitest';
import { DIFFICULTIES } from '../../src/app/settings';
import {
  advance,
  campaignGraph,
  campaignStart,
  DEFEAT,
  isTerminal,
  VICTORY,
} from '../../src/content/campaign';
import { MISSIONS, missionDef } from '../../src/content/missions';
import {
  TEST_DEFEND,
  TEST_ESCORT,
  TEST_FLAGSHIP,
  TEST_PATROL,
  TEST_STRIKE,
} from './fixtures/missions';
import { reseed } from '../../src/core/rng';
import { bus } from '../../src/core/events';
import {
  LAUNCH_SPEED,
  LAUNCH_THROTTLE,
  MissionRunner,
} from '../../src/mission/MissionRunner';
import type { MissionDef } from '../../src/mission/types';
import { newAi } from '../../src/sim/ai';
import { destroyEntity, setCombatOptions } from '../../src/sim/combat';
import { simulateStep } from '../../src/sim/step';
import { aimAssistStrength } from '../../src/app/settings';
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

/**
 * 指定秒だけ進める。
 *
 * `player` を渡すと、**本番ループ (`app/game.ts`) と同じ**難易度補正
 * （主砲の弾速・当たり半径）と照準アシストを掛ける。
 * 省略すると素の条件で進む（既存テストの前提を変えないため既定は省略のまま）。
 *
 * この引数を用意した理由: 通しプレイのテストが本番と違う条件で回っていて、
 * 「AI 操縦で完走できる」という主張が実機の条件を反映していなかった。
 */
function run(
  world: World,
  runner: MissionRunner,
  seconds: number,
  maxAttackers = 2,
  player?: { difficulty: (typeof DIFFICULTIES)[keyof typeof DIFFICULTIES]; aimAssist: boolean },
): void {
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) {
    simulateStep(world, DT, {
      flightMode: 'wc',
      ai: { maxAttackersOnPlayer: maxAttackers },
      ...(player
        ? {
            playerWeaponModifiers: player.difficulty,
            aimAssist: aimAssistStrength(player.aimAssist, player.difficulty.strongAimHelp),
          }
        : {}),
    });
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
    const graph = campaignGraph();
    for (const [id, node] of Object.entries(graph)) {
      expect(MISSIONS[node.missionId], `${id} のミッション`).toBeDefined();
      for (const next of [node.onWin, node.onLoss]) {
        if (!isTerminal(next)) expect(graph[next], `${id} → ${next}`).toBeDefined();
      }
    }
  });

  it('勝ち続けると VICTORY に到達する', () => {
    let node = campaignStart();
    const seen: string[] = [];
    for (let i = 0; i < 20 && !isTerminal(node); i++) {
      seen.push(node);
      node = advance(node, 'win');
    }
    expect(node).toBe(VICTORY);
    expect(seen).toHaveLength(10);
  });

  it('負け続けても章は進み、最後に DEFEAT へ落ちる', () => {
    let node = campaignStart();
    const seen: string[] = [];
    for (let i = 0; i < 20 && !isTerminal(node); i++) {
      seen.push(node);
      node = advance(node, 'loss');
    }
    // 敗北ルートへ分岐せず、そのまま次章へ進む（第10章の敗北だけが DEFEAT）
    expect(seen).toHaveLength(10);
    expect(node).toBe(DEFEAT);
  });
});

describe('目標評価', () => {
  it('自機が失われると失敗になる', () => {
    const def = TEST_PATROL;
    const { world, runner } = start(def);
    const player = world.player!;
    destroyEntity(world, player);
    world.compact();
    runner.update(DT);
    expect(runner.state).toBe('loss');
  });

  it('護衛対象が破壊されると失敗になる', () => {
    const def = TEST_ESCORT;
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
    const def = TEST_STRIKE;
    const { world, runner } = start(def);
    reachNav(world, runner, def, 1);
    run(world, runner, 1);
    const supplies = world.entities.filter((e) => e.tag === 'supply');
    expect(supplies.length).toBe(2);
    for (const s of supplies) destroyEntity(world, s);
    world.compact();
    runner.update(DT);
    const view = runner.objectiveViews().find((v) => v.text.includes('輸送艦'));
    expect(view?.state).toBe('done');
  });

  it('survive は指定時間の経過で達成になる', () => {
    const def: MissionDef = {
      ...TEST_PATROL,
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
      ...TEST_PATROL,
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
    const def = TEST_PATROL;
    const { world, runner } = start(def);
    // 開始直後は敵ゼロだが、まだ Nav 未到達でウェーブが残っている
    run(world, runner, 1);
    const clear = runner.objectiveViews().find((v) => v.text.includes('全機撃破'));
    expect(clear?.state).toBe('active');
    expect(runner.state).toBe('running');
  });

  it('旗艦強襲は砲塔→エンジン→魚雷の順で進む', () => {
    const base = TEST_FLAGSHIP;
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
    expect(runner.objectiveViews().find((v) => v.text.includes('撃沈'))?.state).toBe('done');
  });
});

describe('ウェーブ投入', () => {
  it('Nav 到達で紐付いた敵グループが出現する', () => {
    const def = TEST_PATROL;
    const { world, runner } = start(def);
    expect(world.entities.filter((e) => e.faction === 'kilrathi')).toHaveLength(0);
    reachNav(world, runner, def, 1);
    // delay 2 + 難易度のウェーブ遅延
    run(world, runner, 3 + DIFFICULTIES.normal.waveDelayBonus);
    expect(world.entities.filter((e) => e.faction === 'kilrathi').length).toBeGreaterThan(0);
  });

  it('エース指定のグループには ace フラグ付きの1機が含まれる', () => {
    const def = TEST_DEFEND;
    const { world, runner } = start(def);
    // 出撃時のスロットルが入るようになった (T2-⑤) ため、操縦しない自機は
    // 戦域から離れ続けてしまう。この検証はウェーブ投入が対象なので、その場に留める
    world.player!.vel.set(0, 0, 0);
    world.player!.input!.throttle = 0;
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
    expect(aces[0].ship!.pilot).toContain('ラギティカ');
  });

  it('輸送艦は passive で、プレイヤーを攻撃しない', () => {
    const def = TEST_ESCORT;
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
      ...TEST_PATROL,
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
  // T2-⑤: どの難易度でも出撃時のスロットル（速度設定）は 0% にしない
  // （0% だと発艦後に止まったままタイマーだけが減る）。
  // W1（07_更なる改善）で実初速は難易度に依らず LAUNCH_SPEED になったので、
  // 難易度の差は速度設定（やさしい 50% / それ以外 LAUNCH_THROTTLE）に残る。
  it('出撃時の実初速は LAUNCH_SPEED で、速度設定はやさしいがいちばん高い', () => {
    const def = TEST_PATROL;
    const easy = start(def, 'easy');
    const normal = start(def, 'normal');
    const hard = start(def, 'hard');
    for (const s of [easy, normal, hard]) {
      expect(s.world.player!.vel.length()).toBeCloseTo(LAUNCH_SPEED, 6);
    }
    // 速度設定は巡航値から始まる（HUD の SET SPD と実挙動が同じ出所）
    expect(normal.world.player!.input!.throttle).toBe(LAUNCH_THROTTLE);
    expect(hard.world.player!.input!.throttle).toBe(LAUNCH_THROTTLE);
    expect(easy.world.player!.input!.throttle).toBeGreaterThan(LAUNCH_THROTTLE);
  });

  it('やさしいではウェーブの投入が遅い', () => {
    const def = TEST_PATROL;
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
    const def = TEST_PATROL;
    const { world, runner } = start(def, 'easy');
    const player = world.player!;
    // 自機に高技量 AI を載せて自動で戦わせる
    player.ai = newAi(0.95);
    const maxAttackers = DIFFICULTIES.easy.maxAttackers;
    // 本番ループと同じ条件（やさしいの弾速・当たり半径補正と照準アシスト）で回す
    const asPlayer = { difficulty: DIFFICULTIES.easy, aimAssist: true };

    // Nav を順に踏み、そのつど出てきた敵を掃討する
    for (let navIndex = 0; navIndex < def.navs.length; navIndex++) {
      if (runner.state !== 'running') break;
      jumpToNav(world, navIndex, def);
      run(world, runner, 1 + DIFFICULTIES.easy.waveDelayBonus + 3, maxAttackers, asPlayer);
      // 出てきた敵を片付けるまで戦う (最大 240 秒)
      for (let t = 0; t < 240 && runner.state === 'running'; t++) {
        run(world, runner, 1, maxAttackers, asPlayer);
        if (world.entities.filter((e) => e.faction === 'kilrathi').length === 0) break;
      }
    }
    expect(runner.state).toBe('win');
    expect(world.player).toBeDefined();
  });
});
