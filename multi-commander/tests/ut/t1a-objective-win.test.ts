/**
 * T1-① 勝敗の成立。
 *
 * - `escortArrive`（護衛対象を Nav へ乗せる）の達成・失敗・進捗表示
 * - 第1章が「帰投しただけでは勝てない」こと
 * - 達成度3段階（任務達成 / 部分達成 / 任務失敗）の境界
 * - 任意目標の「加点」表示と、破られていない制約の判定表示
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { DIFFICULTIES } from '../../src/app/settings';
import { reseed } from '../../src/core/rng';
import { shipDef } from '../../src/content/ships';
import {
  MissionRunner,
  displayNameOf,
  objectiveLabel,
  objectiveRewardPrefix,
} from '../../src/mission/MissionRunner';
import { VEIL_MISSION_LIST } from '../../src/content/veil/missions/index';
import type { MissionDef, ObjectiveDef } from '../../src/mission/types';
import { VEIL_CH01 } from '../../src/content/veil/missions/ch01';
import { destroyEntity, setCombatOptions } from '../../src/sim/combat';
import { simulateStep } from '../../src/sim/step';
import type { Entity } from '../../src/world/entity';
import { World } from '../../src/world/world';

const DT = 1 / 60;

beforeEach(() => {
  reseed(0x71a1);
  setCombatOptions({ playerDamageTaken: 1, playerDamageDealt: 1 });
});

function baseDef(overrides: Partial<MissionDef>): MissionDef {
  return {
    id: 'ut-t1a',
    title: '勝敗テスト',
    system: 'テスト星系',
    briefing: ['勝敗の検証'],
    briefingSpeaker: '管制',
    navs: [
      { name: 'NAV 1', pos: [0, 0, -4000] },
      { name: '帰投', pos: [0, 0, 0], arriveRadius: 1000 },
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

/** 機体をその場に固定して指定座標へ動かす（オートパイロットで連れ帰った状態を作る） */
function teleport(e: Entity, pos: [number, number, number]): void {
  e.pos.set(...pos);
  e.prevPos.copy(e.pos);
  e.renderPrevPos.copy(e.pos);
  e.vel.set(0, 0, 0);
}

function viewOf(runner: MissionRunner, id: string) {
  const index = runner.def.objectives.findIndex((o) => o.id === id);
  return runner.objectiveViews()[index];
}

// ───────── escortArrive ─────────

describe('escortArrive (護衛対象を Nav へ乗せる)', () => {
  const escortDef = (min?: number, count = 1) =>
    baseDef({
      spawns: [
        {
          shipId: 'drayman',
          count,
          faction: 'confed',
          tag: 'escort',
          offset: [0, 0, -4000],
          spread: 100,
          speed: 0,
        },
      ],
      objectives: [
        {
          id: 'escort-home',
          text: '輸送船を帰投航路に乗せる',
          required: true,
          spec: { kind: 'escortArrive', tag: 'escort', navIndex: 1, min },
        },
      ],
    });

  it('Nav の到達半径へ入れたら達成し、勝利する', () => {
    const def = escortDef();
    const { world, runner } = start(def);
    run(world, runner, 0.3);
    expect(viewOf(runner, 'escort-home').state).toBe('active');
    expect(viewOf(runner, 'escort-home').text).toContain('0/1 到達');
    expect(runner.state).toBe('running');

    const escort = world.entities.find((e) => e.tag === 'escort')!;
    teleport(escort, [0, 0, -500]);
    run(world, runner, 0.1);
    expect(runner.state).toBe('win');
    expect(runner.summary().objectives[0].state).toBe('done');
  });

  it('到達半径の外にいる間は達成にならない', () => {
    const def = escortDef();
    const { world, runner } = start(def);
    const escort = world.entities.find((e) => e.tag === 'escort')!;
    // 半径 1000 の外（機体半径を差し引いても届かない距離）
    teleport(escort, [0, 0, -1400]);
    run(world, runner, 0.1);
    expect(viewOf(runner, 'escort-home').state).toBe('active');
    expect(runner.state).toBe('running');
  });

  it('対象を失って min に届かなくなったら失敗し、必須なので敗北する', () => {
    const def = escortDef();
    const { world, runner } = start(def);
    run(world, runner, 0.3);
    const escort = world.entities.find((e) => e.tag === 'escort')!;
    destroyEntity(world, escort);
    world.compact();
    runner.update(DT);
    expect(viewOf(runner, 'escort-home').state).toBe('failed');
    expect(runner.state).toBe('loss');
  });

  it('min を指定すると、その数だけ到達させれば達成する', () => {
    const def = escortDef(2, 3);
    const { world, runner } = start(def);
    run(world, runner, 0.3);
    const escorts = world.entities.filter((e) => e.tag === 'escort');
    expect(escorts).toHaveLength(3);
    teleport(escorts[0], [0, 0, -300]);
    run(world, runner, 0.1);
    expect(viewOf(runner, 'escort-home').text).toContain('1/2 到達');
    expect(runner.state).toBe('running');
    teleport(escorts[1], [0, 0, -300]);
    run(world, runner, 0.1);
    expect(runner.state).toBe('win');
  });

  it('一度到達させた対象は、その後に失われても達成のまま', () => {
    const def = escortDef(2, 3);
    const { world, runner } = start(def);
    run(world, runner, 0.3);
    const escorts = world.entities.filter((e) => e.tag === 'escort');
    teleport(escorts[0], [0, 0, -300]);
    run(world, runner, 0.1);
    destroyEntity(world, escorts[0]);
    world.compact();
    runner.update(DT);
    expect(viewOf(runner, 'escort-home').text).toContain('1/2 到達');
    expect(viewOf(runner, 'escort-home').state).toBe('active');
  });
});

// ───────── 第1章 ─────────

describe('第1章の必須目標', () => {
  it('必須は escortArrive / protect / timeLimit / reachNav の4つ', () => {
    const required = VEIL_CH01.objectives.filter((o) => o.required).map((o) => o.spec.kind);
    expect(required).toEqual(['escortArrive', 'protect', 'timeLimit', 'reachNav']);
    const bulkhead = VEIL_CH01.objectives.find((o) => o.id === 'bulkhead')!;
    // 計時は救難区域 (NAV 2 = index 1) 到着から始まる（T2-⑤）
    expect(bulkhead.spec).toEqual({ kind: 'timeLimit', seconds: 300, startAtNav: 1 });
  });

  it('任意目標には加点（reward）が書かれている', () => {
    for (const o of VEIL_CH01.objectives.filter((x) => !x.required)) {
      expect(o.reward, `${o.id} に reward がない`).toBeTruthy();
    }
  });

  it('自機が帰投しただけでは勝てない（輸送船を乗せていないため）', () => {
    const world = new World();
    const runner = new MissionRunner(world, VEIL_CH01, { shipId: VEIL_CH01.playerShipId }, DIFFICULTIES.normal);
    runner.build();
    const player = world.player!;

    // NAV 1 → NAV 2（救難信号源。ここで輸送船が出る）→ 帰投
    for (const index of [0, 1, 2]) {
      teleport(player, VEIL_CH01.navs[index].pos);
      run(world, runner, 0.2);
    }
    const home = runner.def.objectives.findIndex((o) => o.id === 'home');
    expect(runner.objectiveViews()[home].state).toBe('done');
    // 輸送船はまだ帰投航路に乗っていないので、任務は終わらない
    expect(runner.state).toBe('running');
    const escortHome = runner.def.objectives.findIndex((o) => o.id === 'astra-home');
    expect(runner.objectiveViews()[escortHome].state).toBe('active');

    // 輸送船を連れ帰ると勝てる
    const escort = world.entities.find((e) => e.tag === 'escort')!;
    teleport(escort, [0, 0, 0]);
    run(world, runner, 0.1);
    expect(runner.state).toBe('win');
  });
});

// ───────── 護衛対象の固有名 ─────────

describe('護衛対象の取得（escortTargets / displayNameOf）', () => {
  it('第1章の輸送船は宣言された固有名で取れる', () => {
    const world = new World();
    const runner = new MissionRunner(world, VEIL_CH01, { shipId: VEIL_CH01.playerShipId }, DIFFICULTIES.normal);
    runner.build();
    // NAV 1 を踏まないと NAV 2 の到達判定が降りない（輸送船はそこで出る）
    for (const index of [0, 1]) {
      teleport(world.player!, VEIL_CH01.navs[index].pos);
      run(world, runner, 0.2);
    }

    const targets = runner.escortTargets();
    expect(targets).toHaveLength(1);
    expect(targets[0].name).toBe('〈アストラ・メイ〉');
    expect(targets[0].displayName).toBe('〈アストラ・メイ〉');
    expect(targets[0].tag).toBe('escort');
    // 名前の出所は1つ。機体のラベルも同じ名前になっている
    const escort = world.byId(targets[0].id)!;
    expect(displayNameOf(escort)).toBe('〈アストラ・メイ〉');
    expect(runner.isEscortTarget(escort)).toBe(true);
    expect(runner.isEscortTarget(world.player!)).toBe(false);
  });

  it('固有名の宣言が無い群は displayName が undefined で、機体名にフォールバックする', () => {
    const def = baseDef({
      spawns: [
        { shipId: 'drayman', count: 1, faction: 'confed', tag: 'escort', offset: [0, 0, -4000], speed: 0 },
      ],
      objectives: [
        { id: 'keep', text: '輸送船を守る', required: true, spec: { kind: 'protect', tag: 'escort' } },
        { id: 'nav', text: 'NAV 1 到達', required: true, spec: { kind: 'reachNav', navIndex: 0 } },
      ],
    });
    const { world, runner } = start(def);
    run(world, runner, 0.2);
    const targets = runner.escortTargets();
    expect(targets).toHaveLength(1);
    expect(targets[0].displayName).toBeUndefined();
    expect(targets[0].name).toBe(shipDef('drayman').name);
  });

  it('escortTags は protect / protectCount / escortArrive / holdTag の対象だけを拾う', () => {
    const def = baseDef({
      spawns: [
        { shipId: 'drayman', count: 1, faction: 'confed', tag: 'escort', offset: [0, 0, -4000], speed: 0 },
        { shipId: 'ke04-mirage', count: 1, faction: 'kilrathi', tag: 'foe', offset: [3000, 0, -4000] },
      ],
      objectives: [
        { id: 'keep', text: '輸送船を守る', required: true, spec: { kind: 'protect', tag: 'escort' } },
        { id: 'kill', text: '敵を落とす', required: false, spec: { kind: 'destroyTag', tag: 'foe' } },
      ],
    });
    const { world, runner } = start(def);
    run(world, runner, 0.2);
    expect([...runner.escortTags]).toEqual(['escort']);
    expect(runner.escortTargets().map((t) => t.tag)).toEqual(['escort']);
  });

  it('撃墜された護衛対象も同じ関数で名前が読める（戦闘中の通知用）', () => {
    const world = new World();
    const runner = new MissionRunner(world, VEIL_CH01, { shipId: VEIL_CH01.playerShipId }, DIFFICULTIES.normal);
    runner.build();
    // NAV 1 を踏まないと NAV 2 の到達判定が降りない（輸送船はそこで出る）
    for (const index of [0, 1]) {
      teleport(world.player!, VEIL_CH01.navs[index].pos);
      run(world, runner, 0.2);
    }
    const escort = world.entities.find((e) => e.tag === 'escort')!;
    destroyEntity(world, escort);
    expect(displayNameOf(escort)).toBe('〈アストラ・メイ〉');
    world.compact();
    runner.update(DT);
    // 戦域から外れた対象は一覧には残らない
    expect(runner.escortTargets()).toHaveLength(0);
    expect(runner.summary().escortLost).toBe(true);
  });

  it('護衛・保護の対象になっている全章の群に固有名が宣言されている', () => {
    const kinds = ['protect', 'protectCount', 'escortArrive', 'holdTag'];
    for (const mission of VEIL_MISSION_LIST) {
      const tags = new Set(
        mission.objectives
          .filter((o) => kinds.includes(o.spec.kind))
          .map((o) => (o.spec as { tag?: string }).tag)
          .filter((t): t is string => !!t),
      );
      for (const spawn of mission.spawns) {
        if (!spawn.tag || !tags.has(spawn.tag)) continue;
        expect(spawn.displayName, `${mission.id} の ${spawn.shipId} (${spawn.tag}) に固有名がない`).toBeTruthy();
      }
    }
  });
});

// ───────── 達成度3段階 ─────────

describe('達成度3段階', () => {
  it('必須も任意も達成したら complete', () => {
    const def = baseDef({
      objectives: [
        { id: 'nav', text: 'NAV 1 到達', required: true, spec: { kind: 'reachNav', navIndex: 0 } },
        { id: 'hold', text: '0.5 秒耐える', required: false, reward: '＋帰還者1', spec: { kind: 'survive', seconds: 0.5 } },
      ],
    });
    const { world, runner } = start(def);
    run(world, runner, 0.7);
    expect(runner.state).toBe('running');
    teleport(world.player!, def.navs[0].pos);
    run(world, runner, 0.1);
    expect(runner.state).toBe('win');
    expect(runner.grade).toBe('complete');
    expect(runner.summary().grade).toBe('complete');
  });

  it('必須は達成、任意に未達があれば partial', () => {
    const def = baseDef({
      objectives: [
        { id: 'nav', text: 'NAV 1 到達', required: true, spec: { kind: 'reachNav', navIndex: 0 } },
        { id: 'hold', text: '60 秒耐える', required: false, reward: '＋帰還者1', spec: { kind: 'survive', seconds: 60 } },
      ],
    });
    const { world, runner } = start(def);
    teleport(world.player!, def.navs[0].pos);
    run(world, runner, 0.2);
    expect(runner.state).toBe('win');
    expect(runner.grade).toBe('partial');
  });

  it('必須が失敗したら failed', () => {
    const def = baseDef({
      objectives: [
        { id: 'clock', text: '0.5 秒以内', required: true, spec: { kind: 'timeLimit', seconds: 0.5 } },
        { id: 'nav', text: 'NAV 1 到達', required: true, spec: { kind: 'reachNav', navIndex: 0 } },
      ],
    });
    const { world, runner } = start(def);
    run(world, runner, 1);
    expect(runner.state).toBe('loss');
    expect(runner.grade).toBe('failed');
  });

  it('必須が未達のまま自機を失っても failed（機体喪失を記録する）', () => {
    const def = baseDef({
      objectives: [
        { id: 'nav', text: 'NAV 1 到達', required: true, spec: { kind: 'reachNav', navIndex: 0 } },
      ],
    });
    const { world, runner } = start(def);
    run(world, runner, 0.2);
    destroyEntity(world, world.player!);
    world.compact();
    runner.update(DT);
    expect(runner.state).toBe('loss');
    expect(runner.grade).toBe('failed');
    expect(runner.summary().playerLost).toBe(true);
  });
});

// ───────── 表示 ─────────

describe('目標の表示', () => {
  const def = baseDef({
    spawns: [
      { shipId: 'drayman', count: 1, faction: 'confed', tag: 'escort', offset: [0, 0, -4000], speed: 0 },
    ],
    objectives: [
      { id: 'keep', text: '輸送船を守る', required: true, spec: { kind: 'protect', tag: 'escort' } },
      { id: 'nav', text: 'NAV 1 到達', required: true, spec: { kind: 'reachNav', navIndex: 0 } },
      { id: 'pods', text: '脱出ポッドを回収する', required: false, reward: '＋帰還者3', spec: { kind: 'survive', seconds: 600 } },
      { id: 'extra', text: '余力があれば偵察する', required: false, spec: { kind: 'survive', seconds: 600 } },
    ],
  });

  it('任意目標は reward があれば加点として出し、無ければ (任意) にする', () => {
    const { world, runner } = start(def);
    run(world, runner, 0.2);
    expect(viewOf(runner, 'pods').text).toContain('＋帰還者3 …脱出ポッドを回収する');
    expect(viewOf(runner, 'pods').text).not.toContain('(任意)');
    expect(viewOf(runner, 'extra').text).toContain('(任意) …余力があれば偵察する');
    // 必須目標には前置しない
    expect(viewOf(runner, 'nav').text).toBe('NAV 1 到達');
  });

  /**
   * ブリーフィングの目標一覧（`App.showBriefing`）は
   * `<span class="dim">前置</span>目標文` の形で組み立てる。
   * その組み立てが HUD の表記（`objectiveLabel`）と一字も違わないことを固定する。
   * 「前置 + 目標文」以外の組み立て方を新たに書いたらここで落ちる。
   */
  function briefingText(o: ObjectiveDef): string {
    return `${objectiveRewardPrefix(o)}${o.text}`;
  }

  it('ブリーフィングの表記と HUD の表記が全章で一致する', () => {
    for (const mission of VEIL_MISSION_LIST) {
      for (const o of mission.objectives) {
        expect(briefingText(o), `${mission.id}/${o.id}`).toBe(objectiveLabel(o));
      }
    }
  });

  it('第1章のブリーフィングに (任意) が残らず、加点表記になる', () => {
    const texts = VEIL_CH01.objectives.map((o) => briefingText(o));
    expect(texts.some((t) => t.includes('(任意)'))).toBe(false);
    // 目標文そのものではなく「加点の前置が付くこと」を固定する
    // (T4-⑮ で収容の操作を目標文に書いたので、文言を焼き付けない)
    const pods = VEIL_CH01.objectives.find((o) => o.id === 'pods')!;
    expect(texts).toContain(`＋帰還者3 …${pods.text}`);
    expect(pods.text).toContain('脱出ポッド3基');
    // 必須目標には前置を付けない
    expect(texts).toContain(`${VEIL_CH01.objectives.find((o) => o.id === 'home')!.text}`);
  });

  it('HUD の目標行はブリーフィングの表記から始まる（進捗だけが後ろに付く）', () => {
    const world = new World();
    const runner = new MissionRunner(world, VEIL_CH01, { shipId: VEIL_CH01.playerShipId }, DIFFICULTIES.normal);
    runner.build();
    run(world, runner, 0.2);
    runner.objectiveViews().forEach((v, i) => {
      expect(v.text.startsWith(briefingText(VEIL_CH01.objectives[i]))).toBe(true);
    });
  });

  it('破られていない制約はデブリーフでは「達成」として出す', () => {
    const { world, runner } = start(def);
    teleport(world.player!, def.navs[0].pos);
    run(world, runner, 0.2);
    expect(runner.state).toBe('win');
    const s = runner.summary();
    expect(s.objectives[0].state).toBe('done'); // protect（成立し続けた）
    expect(s.objectives[1].state).toBe('done'); // reachNav
    expect(s.objectives[2].state).toBe('active'); // 未達の任意目標
    expect(s.grade).toBe('partial');
    expect(s.playerLost).toBe(false);
  });
});
