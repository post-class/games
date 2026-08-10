/**
 * T2-⑤ Nav 到着の間合いとタイマー。
 *
 * - 到着した瞬間に、その Nav の主目標が「見える距離」にいること（上限を固定する）
 * - `timeLimit` の計時を「到着してから」にできること
 * - 旋回で速度が半分以下に落ちないこと
 * - 出撃時のスロットルが 0% でないこと
 * - 第3章が `escortArrive` で「飛んで着けば勝ち」を脱していること
 */
import { Quaternion, Vector3 } from 'three';
import { beforeEach, describe, expect, it } from 'vitest';
import { DIFFICULTIES } from '../../src/app/settings';
import { MISSIONS } from '../../src/content/missions';
import { shipDef } from '../../src/content/ships';
import { VEIL_MISSION_LIST } from '../../src/content/veil/missions/index';
import { VEIL_CH01 } from '../../src/content/veil/missions/ch01';
import { VEIL_CH03 } from '../../src/content/veil/missions/ch03';
import { VEIL_CH04 } from '../../src/content/veil/missions/ch04';
import { VEIL_CH06 } from '../../src/content/veil/missions/ch06';
import { VEIL_CH07 } from '../../src/content/veil/missions/ch07';
import { reseed } from '../../src/core/rng';
import { MissionRunner } from '../../src/mission/MissionRunner';
import {
  NAV_ARRIVE_TARGET_RANGE,
  navArrivalRanges,
  objectiveTagsOf,
} from '../../src/mission/navArrival';
import type { MissionDef } from '../../src/mission/types';
import { destroyEntity, setCombatOptions } from '../../src/sim/combat';
import { updateFlight } from '../../src/sim/flight';
import { simulateStep } from '../../src/sim/step';
import type { Entity } from '../../src/world/entity';
import { spawnShip, World } from '../../src/world/world';

const DT = 1 / 60;
/** 到着時に、その群のどの機体もこの距離以内にいること (隊列の幅を含む) */
const MEMBER_LIMIT = 5000;

beforeEach(() => {
  reseed(0x2b05);
  setCombatOptions({ playerDamageTaken: 1, playerDamageDealt: 1 });
});

function start(def: MissionDef, difficultyId: 'easy' | 'normal' | 'hard' = 'normal') {
  const world = new World();
  const profile = DIFFICULTIES[difficultyId];
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

function teleport(e: Entity, pos: readonly [number, number, number] | Vector3): void {
  if (pos instanceof Vector3) e.pos.copy(pos);
  else e.pos.set(...pos);
  e.prevPos.copy(e.pos);
  e.renderPrevPos.copy(e.pos);
  e.vel.set(0, 0, 0);
}

/**
 * Nav の到達半径のふち（=いちばん遠い到達位置）へ自機を置いて到達させる。
 * 手前の Nav から近づく現実の航路に合わせ、直前の Nav 側のふちに置く。
 */
function arriveAtNav(world: World, runner: MissionRunner, def: MissionDef, index: number): void {
  const player = world.player!;
  for (let i = 0; i <= index; i++) {
    const nav = new Vector3(...def.navs[i].pos);
    const from = i === 0 ? new Vector3() : new Vector3(...def.navs[i - 1].pos);
    const dir = from.clone().sub(nav);
    const radius = def.navs[i].arriveRadius ?? 900;
    if (dir.lengthSq() > 1e-6) nav.addScaledVector(dir.normalize(), radius * 0.98);
    teleport(player, nav);
    run(world, runner, 0.2);
    if (runner.state !== 'running') return;
  }
}

// ───────── 到着時の間合い ─────────

describe('Nav 到着時に主目標が見える距離にいる', () => {
  it('全ミッションの「到着時に主目標が何m先か」の上限が固定されている', () => {
    const report: string[] = [];
    for (const def of Object.values(MISSIONS)) {
      for (const r of navArrivalRanges(def)) {
        report.push(
          `${def.id} nav${r.navIndex} ${r.tag}(${r.shipId}x${r.count}) ` +
            `中心 ${Math.round(r.centerRange)}m / 端 ${Math.round(r.memberRange)}m`,
        );
        expect(r.centerRange, report[report.length - 1]).toBeLessThanOrEqual(
          NAV_ARRIVE_TARGET_RANGE,
        );
        expect(r.memberRange, report[report.length - 1]).toBeLessThanOrEqual(MEMBER_LIMIT);
      }
    }
    // 測る対象がゼロになっていない (宣言の付け替えで空振りしていない) こと
    expect(report.length).toBeGreaterThan(20);
  });

  it('実際に到着させても、その Nav の主目標は視界の距離にいる (veil 10章)', () => {
    for (const def of VEIL_MISSION_LIST) {
      const tags = objectiveTagsOf(def);
      const navIndexes = new Set(
        def.spawns
          .filter((g) => g.atNav !== undefined && g.tag && tags.has(g.tag))
          .map((g) => g.atNav!),
      );
      for (const navIndex of navIndexes) {
        reseed(0x2b05);
        const { world, runner } = start(def);
        arriveAtNav(world, runner, def, navIndex);
        // 出現の遅延ぶんだけ進める (遅れて出る群も同じ基準で測る)
        const delay = Math.max(
          0,
          ...def.spawns.filter((g) => g.atNav === navIndex).map((g) => g.delay ?? 0),
        );
        run(world, runner, delay + 0.5);
        const player = world.player;
        if (!player) continue;
        for (const g of def.spawns) {
          if (g.atNav !== navIndex || !g.tag || !tags.has(g.tag)) continue;
          const members = world.entities.filter((e) => e.alive && e.tag === g.tag);
          if (!members.length) continue;
          const nearest = Math.min(...members.map((e) => e.pos.distanceTo(player.pos)));
          expect(
            nearest,
            `${def.id} nav${navIndex} ${g.tag}: 最至近 ${Math.round(nearest)}m`,
          ).toBeLessThanOrEqual(MEMBER_LIMIT);
        }
      }
    }
  });

  it('第1章は救難区域に着いた時点で輸送船・ポッド・先遣隊がすべて視界内にいる', () => {
    const { world, runner } = start(VEIL_CH01);
    arriveAtNav(world, runner, VEIL_CH01, 1);
    // 先遣隊は delay 3 秒 + 難易度ぶんの遅延で出る
    run(world, runner, 4 + DIFFICULTIES.normal.waveDelayBonus);
    const player = world.player!;
    for (const tag of ['escort', 'rescue', 'target']) {
      const members = world.entities.filter((e) => e.alive && e.tag === tag);
      expect(members.length, tag).toBeGreaterThan(0);
      const nearest = Math.min(...members.map((e) => e.pos.distanceTo(player.pos)));
      // 実プレイでは輸送船 25km / 先遣隊 11.4km だった。4km 以内なら画面に映る
      expect(nearest, `${tag} 最至近 ${Math.round(nearest)}m`).toBeLessThan(4000);
    }
  });

  it('開始時に出る群 (Nav に紐づかない群) の位置は動かさない', () => {
    // 宣言どおりの間合いで置きたい演出用の群を、間合いの補正が壊さないこと
    const def: MissionDef = {
      id: 'ut-t2b-start',
      title: '開始時グループ',
      system: 'テスト',
      briefing: ['x'],
      briefingSpeaker: '管制',
      navs: [{ name: 'NAV 1', pos: [0, 0, -9000] }],
      spawns: [
        {
          shipId: 'drayman',
          count: 1,
          faction: 'confed',
          tag: 'escort',
          displayName: '〈テスト船〉',
          offset: [0, 0, -8000],
          spread: 0,
          speed: 0,
        },
      ],
      objectives: [
        { id: 'keep', text: '守る', required: true, spec: { kind: 'protect', tag: 'escort' } },
        { id: 'nav', text: '到達', required: true, spec: { kind: 'reachNav', navIndex: 0 } },
      ],
      playerShipId: 'hornet',
      debriefWin: ['w'],
      debriefLoss: ['l'],
    };
    const { world, runner } = start(def);
    run(world, runner, 0.05);
    const escort = world.entities.find((e) => e.tag === 'escort')!;
    expect(escort.pos.length()).toBeGreaterThan(7000);
    expect(runner.state).toBe('running');
  });
});

// ───────── 到着してから計時する timeLimit ─────────

function clockDef(seconds: number, startAtNav?: number): MissionDef {
  return {
    id: 'ut-t2b-clock',
    title: '制限時間',
    system: 'テスト',
    briefing: ['x'],
    briefingSpeaker: '管制',
    navs: [
      { name: 'NAV 1', pos: [0, 0, -6000], arriveRadius: 900 },
      { name: '帰投', pos: [0, 0, 0], arriveRadius: 900 },
    ],
    spawns: [],
    objectives: [
      { id: 'clock', text: '制限時間', required: true, spec: { kind: 'timeLimit', seconds, startAtNav } },
      { id: 'home', text: '帰投', required: true, spec: { kind: 'reachNav', navIndex: 1 } },
    ],
    playerShipId: 'hornet',
    debriefWin: ['w'],
    debriefLoss: ['l'],
  };
}

describe('timeLimit の startAtNav (到着してから計時する)', () => {
  it('startAtNav の Nav に着くまで残り時間が減らず、失敗もしない', () => {
    const def = clockDef(3, 0);
    const { world, runner } = start(def);
    run(world, runner, 6);
    expect(runner.state).toBe('running');
    const view = runner.objectiveViews()[0];
    expect(view.state).toBe('active');
    expect(view.text).toContain('残り 3s');
    expect(view.text).toContain('到達後に開始');
  });

  it('到着してから計時が始まり、超過で失敗する', () => {
    const def = clockDef(3, 0);
    const { world, runner } = start(def);
    run(world, runner, 5);
    expect(runner.state).toBe('running');
    teleport(world.player!, def.navs[0].pos);
    run(world, runner, 0.2);
    expect(runner.objectiveViews()[0].text).toContain('残り 3s');
    run(world, runner, 2);
    expect(runner.state).toBe('running');
    run(world, runner, 1.5);
    expect(runner.state).toBe('loss');
  });

  it('startAtNav を書かなければ従来どおりミッション開始から計時する', () => {
    const def = clockDef(1);
    const { world, runner } = start(def);
    expect(runner.objectiveViews()[0].text).not.toContain('到達後に開始');
    run(world, runner, 1.5);
    expect(runner.state).toBe('loss');
  });

  it('第1章の3本のタイマーはすべて救難区域 (NAV 2) 到着から走る', () => {
    const timers = VEIL_CH01.objectives.filter((o) => o.spec.kind === 'timeLimit');
    expect(timers).toHaveLength(3);
    for (const o of timers) {
      expect((o.spec as { startAtNav?: number }).startAtNav, o.id).toBe(1);
    }
    // 隔壁の5分は必須のまま (時間超過で任務失敗になる挙動を維持する)
    const bulkhead = VEIL_CH01.objectives.find((o) => o.id === 'bulkhead')!;
    expect(bulkhead.required).toBe(true);
  });

  it('第1章は移動に時間をかけても、到着時点で3本とも満タンから始まる', () => {
    const { world, runner } = start(VEIL_CH01);
    // 現場まで 90 秒かけて飛ぶ想定（従来はこの時間が締切から引かれていた）
    run(world, runner, 90);
    for (const view of runner.objectiveViews().filter((v) => v.text.includes('到達後に開始'))) {
      expect(view.state).toBe('active');
    }
    arriveAtNav(world, runner, VEIL_CH01, 1);
    run(world, runner, 0.2);
    const bulkheadIndex = VEIL_CH01.objectives.findIndex((o) => o.id === 'bulkhead');
    expect(runner.objectiveViews()[bulkheadIndex].text).toContain('残り 300s');
    expect(runner.state).toBe('running');
  });
});

// ───────── 旋回時の速度 ─────────

describe('旋回で速度が半分以下に落ちない', () => {
  function turningSpeed(shipId: string): number {
    const world = new World();
    const def = shipDef(shipId);
    const e = spawnShip(world, {
      def,
      faction: 'confed',
      pos: new Vector3(),
      quat: new Quaternion(),
      speed: def.maxSpeed,
    });
    e.input!.throttle = 1;
    e.input!.yaw = 1;
    for (let i = 0; i < 60 * 12; i++) updateFlight(e, DT, 'wc');
    return e.vel.length();
  }

  it('全速の横旋回でも最高速の 55% 以上を保つ (追撃が成立する)', () => {
    for (const id of ['hornet', 'rapier', 'kf01-leonfang', 'kf03-greyhaul']) {
      const def = shipDef(id);
      const kept = turningSpeed(id) / def.maxSpeed;
      expect(kept, `${id}: ${(kept * 100).toFixed(0)}%`).toBeGreaterThan(0.55);
    }
  });

  it('機体差は残る (旋回のきつい機体ほど速度を落とす)', () => {
    // 旋回性能の高い軽戦闘機は、速度の保持率では重戦闘機に劣る
    const hornet = turningSpeed('hornet') / shipDef('hornet').maxSpeed;
    const bastion = turningSpeed('kb02-bastion') / shipDef('kb02-bastion').maxSpeed;
    expect(bastion).toBeGreaterThan(hornet);
  });

  it('直線の加速は変わっていない (前後方向の予算は据え置き)', () => {
    const world = new World();
    const def = shipDef('hornet');
    const e = spawnShip(world, {
      def,
      faction: 'confed',
      pos: new Vector3(),
      quat: new Quaternion(),
      speed: 0,
    });
    e.input!.throttle = 1;
    // accel 320 * driftScale 0.91 なので 1 秒後は約 291（変更前と同じ値）
    for (let i = 0; i < 60; i++) updateFlight(e, DT, 'wc');
    expect(e.vel.length()).toBeCloseTo(291.2, 1);
    expect(e.vel.length()).toBeLessThanOrEqual(def.maxSpeed);
  });
});

// ───────── 出撃時のスロットル ─────────

describe('出撃時のスロットル', () => {
  it('どの難易度でも 0% では始まらない', () => {
    for (const id of ['easy', 'normal', 'hard'] as const) {
      const { world } = start(VEIL_CH01, id);
      const player = world.player!;
      expect(player.input!.throttle, id).toBeGreaterThan(0.3);
      expect(player.vel.length(), id).toBeGreaterThan(0);
    }
  });

  it('やさしいの初速はいちばん速い (難易度の差は残る)', () => {
    const easy = start(VEIL_CH01, 'easy').world.player!.vel.length();
    const normal = start(VEIL_CH01, 'normal').world.player!.vel.length();
    const hard = start(VEIL_CH01, 'hard').world.player!.vel.length();
    expect(easy).toBeGreaterThan(normal);
    expect(normal).toBe(hard);
  });
});

// ───────── 第3章 ─────────

describe('第3章の escortArrive 化', () => {
  it('避難船を出口へ送り出すことが必須の達成目標になっている', () => {
    const o = VEIL_CH03.objectives.find((x) => x.spec.kind === 'escortArrive');
    expect(o).toBeDefined();
    expect(o!.required).toBe(true);
    const spec = o!.spec as { kind: 'escortArrive'; tag: string; navIndex: number; min?: number };
    expect(spec.navIndex).toBe(2);
    expect(spec.min).toBe(12);
    // 生存の制約 (protectCount) と同じタグを見ている
    const guard = VEIL_CH03.objectives.find((x) => x.spec.kind === 'protectCount')!;
    expect(spec.tag).toBe((guard.spec as { tag: string }).tag);
  });

  it('名前の出所は増えていない (displayName の宣言だけを使う)', () => {
    const spec = VEIL_CH03.objectives.find((x) => x.spec.kind === 'escortArrive')!.spec as {
      tag: string;
    };
    const groups = VEIL_CH03.spawns.filter((g) => g.tag === spec.tag);
    expect(groups.map((g) => g.displayName)).toEqual(['避難船', '機関停止の避難船']);
  });

  it('自機だけが Nav を踏んで帰っても勝てない (飛んで着けば勝ちを解消)', () => {
    const { world, runner } = start(VEIL_CH03);
    for (let i = 0; i < VEIL_CH03.navs.length; i++) {
      teleport(world.player!, VEIL_CH03.navs[i].pos);
      run(world, runner, 0.2);
      if (runner.state !== 'running') break;
    }
    const corridor = VEIL_CH03.objectives.findIndex((o) => o.id === 'corridor');
    expect(runner.objectiveViews()[corridor].state).toBe('done');
    // 船団を連れて行っていないので任務は終わらない
    expect(runner.state).toBe('running');
    const out = VEIL_CH03.objectives.findIndex((o) => o.id === 'convoy-out');
    expect(runner.objectiveViews()[out].state).toBe('active');
    expect(runner.objectiveViews()[out].text).toContain('/12 到達');
  });

  it('避難船12隻を出口へ入れれば達成できる (詰みではない)', () => {
    const { world, runner } = start(VEIL_CH03);
    teleport(world.player!, VEIL_CH03.navs[0].pos);
    run(world, runner, 0.3);
    const liners = world.entities.filter((e) => e.alive && e.tag === 'escort');
    expect(liners.length).toBe(18);
    // 出口の到達半径 (2400) の中に、ぶつからない間隔で並べる
    const exit = new Vector3(...VEIL_CH03.navs[2].pos);
    for (let i = 0; i < 12; i++) {
      teleport(liners[i], exit.clone().add(new Vector3((i - 5.5) * 180, 0, 0)));
    }
    for (let i = 1; i < VEIL_CH03.navs.length; i++) {
      teleport(world.player!, VEIL_CH03.navs[i].pos);
      run(world, runner, 0.3);
      if (runner.state !== 'running') break;
    }
    expect(runner.state).toBe('win');
  });
});

// ───────── summary() の護衛対象の生存数 (T2-③ からの依頼) ─────────

describe('summary() の escortSurvivors / escortTotal', () => {
  it('第3章は避難船18隻を数え、沈んだぶんだけ減る', () => {
    const { world, runner } = start(VEIL_CH03);
    // 出現前は総数0（何隻いるか判らない段階では数えない）
    expect(runner.summary().escortTotal).toBe(0);
    teleport(world.player!, VEIL_CH03.navs[0].pos);
    run(world, runner, 0.3);
    expect(runner.summary()).toMatchObject({ escortSurvivors: 18, escortTotal: 18 });

    const liners = world.entities.filter((e) => e.alive && e.tag === 'escort');
    destroyEntity(world, liners[0]);
    destroyEntity(world, liners[1]);
    world.compact();
    runner.update(DT);
    expect(runner.summary()).toMatchObject({ escortSurvivors: 16, escortTotal: 18 });
  });

  it('対象の定義は escortTags と同じで、数え直しが不要になっている', () => {
    const { world, runner } = start(VEIL_CH01);
    arriveAtNav(world, runner, VEIL_CH01, 1);
    run(world, runner, 0.3);
    const s = runner.summary();
    // App 側が escortTags × tagSurvivors を突き合わせて得ていた値と一致する
    let alive = 0;
    let total = 0;
    for (const tag of runner.escortTags) {
      const t = s.tagSurvivors[tag];
      if (!t) continue;
      alive += t.alive;
      total += t.total;
    }
    expect(s.escortSurvivors).toBe(alive);
    expect(s.escortTotal).toBe(total);
    expect(s.escortTotal).toBeGreaterThan(0);
  });

  it('護衛対象を失うと escortLost と生存数がそろって動く', () => {
    const { world, runner } = start(VEIL_CH01);
    arriveAtNav(world, runner, VEIL_CH01, 1);
    run(world, runner, 0.3);
    expect(runner.summary().escortSurvivors).toBe(1);
    destroyEntity(world, world.entities.find((e) => e.tag === 'escort')!);
    world.compact();
    runner.update(DT);
    const s = runner.summary();
    expect(s.escortLost).toBe(true);
    expect(s.escortSurvivors).toBe(0);
    expect(s.escortTotal).toBe(1);
  });
});

// ───────── objectiveViews() の構造化 (T2-⑧ からの依頼) ─────────

describe('objectiveViews() の required / timeLeftSec', () => {
  it('required は宣言をそのまま返す (表示文からの逆算が不要)', () => {
    const { world, runner } = start(VEIL_CH01);
    run(world, runner, 0.2);
    const views = runner.objectiveViews();
    expect(views.map((v) => v.required)).toEqual(VEIL_CH01.objectives.map((o) => o.required));
    // 表示文は従来どおり（加点の前置は objectiveRewardPrefix が唯一の出所）
    const pods = VEIL_CH01.objectives.findIndex((o) => o.id === 'pods');
    expect(views[pods].required).toBe(false);
    expect(views[pods].text).toContain('＋帰還者3');
  });

  it('startAtNav で未開始のタイマーは timeLeftSec を返さない (残り0秒と区別できる)', () => {
    const { world, runner } = start(VEIL_CH01);
    run(world, runner, 30);
    const bulkhead = VEIL_CH01.objectives.findIndex((o) => o.id === 'bulkhead');
    expect(runner.objectiveViews()[bulkhead].timeLeftSec).toBeUndefined();
    expect(runner.objectiveViews()[bulkhead].text).toContain('到達後に開始');

    arriveAtNav(world, runner, VEIL_CH01, 1);
    run(world, runner, 2);
    const left = runner.objectiveViews()[bulkhead].timeLeftSec!;
    expect(left).toBeGreaterThan(295);
    expect(left).toBeLessThan(300);
  });

  it('残り秒は表示文の「残り Ns」と同じ値から作られている', () => {
    const def = clockDef(9);
    const { world, runner } = start(def);
    run(world, runner, 3);
    const view = runner.objectiveViews()[0];
    const shown = /残り (\d+)s/.exec(view.text)![1];
    expect(Number(shown)).toBe(Math.ceil(view.timeLeftSec!));
  });

  it('タイマーでない目標は timeLeftSec を持たない', () => {
    const { world, runner } = start(VEIL_CH03);
    run(world, runner, 0.2);
    const views = runner.objectiveViews();
    VEIL_CH03.objectives.forEach((o, i) => {
      if (o.spec.kind === 'timeLimit' || o.spec.kind === 'survive' || o.spec.kind === 'holdTag') return;
      expect(views[i].timeLeftSec, o.id).toBeUndefined();
    });
  });

  it('survive / holdTag も残り秒を返す (タイマー行の候補になる)', () => {
    const def: MissionDef = {
      ...clockDef(60),
      objectives: [
        { id: 'stay', text: '30秒耐える', required: true, spec: { kind: 'survive', seconds: 30 } },
      ],
    };
    const { world, runner } = start(def);
    run(world, runner, 2);
    expect(runner.objectiveViews()[0].timeLeftSec).toBeGreaterThan(27);
    expect(runner.objectiveViews()[0].timeLeftSec).toBeLessThan(29);
  });
});

// ───────── ch04 / ch06 / ch07 の監査 (T3-C で解消済み) ─────────

describe('ch04 / ch06 / ch07 の必須目標の棚卸し', () => {
  it('移動 (reachNav) 以外の達成目標が必須に入っている', () => {
    const constraints = new Set(['protect', 'timeLimit', 'noFriendlyFire', 'weaponsSafe', 'protectCount']);
    // T2-⑤ の時点では3章すべて `reachNav` だけだった（＝飛んで着けば勝ち）。
    // T3-C で章ごとの主目的に合う達成目標を必須に足したので、その内容を記録する。
    const expected: Record<string, string[]> = {
      // 拘束された契約船を牽引して連れ帰る
      'veil-ch04': ['escortArrive', 'reachNav'],
      // 中枢の応答を記録として持ち帰る（撃たずに抜ける経路は残す）
      'veil-ch06': ['reachNav', 'recon'],
      // 中継所へ書式を提出する（到着だけでは受理されない）
      'veil-ch07': ['reachNav', 'recon'],
    };
    for (const def of [VEIL_CH04, VEIL_CH06, VEIL_CH07]) {
      const achieved = def.objectives
        .filter((o) => o.required && !constraints.has(o.spec.kind))
        .map((o) => o.spec.kind);
      expect(new Set(achieved), def.id).toEqual(new Set(expected[def.id]));
      // 「飛んで着けば勝ち」に戻っていないこと
      expect(new Set(achieved), def.id).not.toEqual(new Set(['reachNav']));
    }
  });
});
