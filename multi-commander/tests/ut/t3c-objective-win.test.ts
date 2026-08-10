/**
 * T3-C 勝敗の成立（第3期）。
 *
 * - ch04 / ch06 / ch07 が「自機だけ Nav を踏んで帰る」では勝てないこと
 * - その必須目標が達成可能であること（詰みではない）
 * - 加点表記（`ObjectiveDef.reward`）が `src/app/narrative.ts` の4状態と一致すること
 * - **全10章**で「required の達成対象が `reachNav` だけ」になっていないこと
 *   （第4期以降に章を追加しても崩れないよう、章の一覧から回して固定する）
 */
import { Vector3 } from 'three';
import { beforeEach, describe, expect, it } from 'vitest';
import { NARRATIVE_LABEL } from '../../src/app/narrative';
import { DIFFICULTIES } from '../../src/app/settings';
import { VEIL_MISSION_LIST } from '../../src/content/veil/missions/index';
import { VEIL_CH04 } from '../../src/content/veil/missions/ch04';
import { VEIL_CH06 } from '../../src/content/veil/missions/ch06';
import { VEIL_CH07 } from '../../src/content/veil/missions/ch07';
import { reseed } from '../../src/core/rng';
import { MissionRunner } from '../../src/mission/MissionRunner';
import type { MissionDef, ObjectiveSpec } from '../../src/mission/types';
import { setCombatOptions } from '../../src/sim/combat';
import { simulateStep } from '../../src/sim/step';
import type { Entity } from '../../src/world/entity';
import { World } from '../../src/world/world';

const DT = 1 / 60;

/** 制約（守るべき条件）。達成する目標ではないので勝利条件に数えない */
const CONSTRAINT_KINDS = new Set<ObjectiveSpec['kind']>([
  'protect',
  'timeLimit',
  'noFriendlyFire',
  'weaponsSafe',
  'protectCount',
]);

beforeEach(() => {
  reseed(0x3c01);
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

/** 自機だけで全 Nav を順に踏む（＝「飛んで着けば勝ち」の再現） */
function touchAllNavs(world: World, runner: MissionRunner, def: MissionDef): void {
  for (let i = 0; i < def.navs.length; i++) {
    if (def.navs[i].reflection) continue;
    teleport(world.player!, def.navs[i].pos);
    run(world, runner, 0.3);
    if (runner.state !== 'running') return;
  }
}

/** 対象を自機の正面（距離 d）へ置いて、recon の照準条件を満たす姿勢を作る */
function aimAt(player: Entity, target: Entity, distance: number): void {
  const fwd = new Vector3(0, 0, -1).applyQuaternion(player.quat);
  teleport(target, player.pos.clone().addScaledVector(fwd, distance));
}

function objectiveIndex(def: MissionDef, id: string): number {
  const i = def.objectives.findIndex((o) => o.id === id);
  expect(i, id).toBeGreaterThanOrEqual(0);
  return i;
}

// ───────── 第4章: 契約船を連れ帰る ─────────

describe('第4章の escortArrive 化', () => {
  it('契約船を母艦へ連れ帰ることが必須の達成目標になっている', () => {
    const o = VEIL_CH04.objectives.find((x) => x.spec.kind === 'escortArrive');
    expect(o).toBeDefined();
    expect(o!.required).toBe(true);
    const spec = o!.spec as Extract<ObjectiveSpec, { kind: 'escortArrive' }>;
    // 到達先は帰投 Nav（自機の帰投目標と同じ Nav）
    const home = VEIL_CH04.objectives.find((x) => x.id === 'home')!;
    expect(spec.navIndex).toBe((home.spec as Extract<ObjectiveSpec, { kind: 'reachNav' }>).navIndex);
    // 沈めない制約 (protect) と同じタグを見ている
    const guard = VEIL_CH04.objectives.find((x) => x.spec.kind === 'protect')!;
    expect(spec.tag).toBe((guard.spec as { tag: string }).tag);
  });

  it('名前の出所は増えていない (displayName の宣言だけを使う)', () => {
    const spec = VEIL_CH04.objectives.find((x) => x.spec.kind === 'escortArrive')!.spec as {
      tag: string;
    };
    const groups = VEIL_CH04.spawns.filter((g) => g.tag === spec.tag);
    expect(groups.map((g) => g.displayName)).toEqual(['連邦契約船']);
  });

  it('自機だけが Nav を踏んで帰っても勝てない', () => {
    const { world, runner } = start(VEIL_CH04);
    touchAllNavs(world, runner, VEIL_CH04);
    const home = objectiveIndex(VEIL_CH04, 'home');
    expect(runner.objectiveViews()[home].state).toBe('done');
    expect(runner.state).toBe('running');
    const tow = objectiveIndex(VEIL_CH04, 'contract-home');
    expect(runner.objectiveViews()[tow].state).toBe('active');
    expect(runner.objectiveViews()[tow].text).toContain('/1 到達');
  });

  it('契約船を帰投 Nav へ入れれば達成できる (詰みではない)', () => {
    const { world, runner } = start(VEIL_CH04);
    // 拘束点（NAV 2）へ着いて契約船を出現させる
    teleport(world.player!, VEIL_CH04.navs[0].pos);
    run(world, runner, 0.3);
    teleport(world.player!, VEIL_CH04.navs[1].pos);
    run(world, runner, 0.3);
    const ship = world.entities.find((e) => e.alive && e.tag === 'escort');
    expect(ship).toBeDefined();
    // 牽引して母艦まで戻った状態
    teleport(ship!, VEIL_CH04.navs[3].pos);
    for (let i = 2; i < VEIL_CH04.navs.length; i++) {
      teleport(world.player!, VEIL_CH04.navs[i].pos);
      run(world, runner, 0.3);
      if (runner.state !== 'running') break;
    }
    expect(runner.state).toBe('win');
  });

  it('契約船は牽引で母艦方向へ動く宣言を持つ', () => {
    const g = VEIL_CH04.spawns.find((s) => s.tag === 'escort')!;
    expect(g.cruiseToNav).toBe(3);
    // 自力の推進は死んでいる（初速 0）
    expect(g.speed).toBe(0);
  });

  it('契約船は空気の制限時間 (420秒) 以内に母艦へ届く速度で動く (詰みではない)', () => {
    // 自機がまったく手伝わない（現場に着くだけで、以後は放置する）最悪の条件で測る。
    // 実際はオートパイロットが護衛圏の船を一緒に連れて行くので、これより早く着く。
    const { world, runner } = start(VEIL_CH04);
    const player = world.player!;
    const home = new Vector3(...VEIL_CH04.navs[3].pos);
    const limit = (
      VEIL_CH04.objectives.find((o) => o.id === 'air')!.spec as Extract<
        ObjectiveSpec,
        { kind: 'timeLimit' }
      >
    ).seconds;
    let arrived = -1;
    for (let i = 0; i < Math.round(limit / DT); i++) {
      const t = i * DT;
      // 20秒で境界標、40秒で拘束点に着いた想定
      if (Math.abs(t - 20) < DT) teleport(player, VEIL_CH04.navs[0].pos);
      if (Math.abs(t - 40) < DT) teleport(player, VEIL_CH04.navs[1].pos);
      simulateStep(world, DT, { flightMode: 'wc', ai: { maxAttackersOnPlayer: 2 } });
      runner.update(DT);
      const ship = world.entities.find((e) => e.alive && e.tag === 'escort');
      if (ship && arrived < 0 && ship.pos.distanceTo(home) - ship.radius <= 1400) arrived = t;
      if (arrived >= 0) break;
    }
    expect(arrived, `契約船の母艦到達 ${arrived.toFixed(0)}s / 制限 ${limit}s`).toBeGreaterThan(0);
    expect(arrived).toBeLessThan(limit);
  });
});

// ───────── 第6章: 中枢の応答を記録する ─────────

describe('第6章の必須目標', () => {
  it('中枢の応答の記録 (recon) が必須の達成目標になっている', () => {
    const o = VEIL_CH06.objectives.find((x) => x.id === 'intent')!;
    expect(o.required).toBe(true);
    const spec = o.spec as Extract<ObjectiveSpec, { kind: 'recon' }>;
    expect(spec.kind).toBe('recon');
    // 中枢（統治空母）を見ている
    expect(spec.tag).toBe('capital');
    expect(VEIL_CH06.spawns.some((g) => g.tag === spec.tag)).toBe(true);
  });

  it('中継器・護衛ドローンの撃破は必須にしていない (撃たずに抜ける経路を残す)', () => {
    for (const id of ['relays', 'guards']) {
      expect(VEIL_CH06.objectives.find((o) => o.id === id)!.required, id).toBe(false);
    }
    expect(VEIL_CH06.objectives.some((o) => o.required && o.spec.kind === 'destroyTag')).toBe(false);
  });

  it('自機だけが Nav を踏んで帰っても勝てない', () => {
    const { world, runner } = start(VEIL_CH06);
    touchAllNavs(world, runner, VEIL_CH06);
    const home = objectiveIndex(VEIL_CH06, 'home');
    expect(runner.objectiveViews()[home].state).toBe('done');
    expect(runner.state).toBe('running');
    const intent = objectiveIndex(VEIL_CH06, 'intent');
    expect(runner.objectiveViews()[intent].state).toBe('active');
  });

  it('中枢へ機首を向け続ければ達成できる (詰みではない)', () => {
    const { world, runner } = start(VEIL_CH06);
    // 中枢（NAV 4 = index 3）まで順に踏んで統治空母を出現させる
    for (let i = 0; i <= 3; i++) {
      teleport(world.player!, VEIL_CH06.navs[i].pos);
      run(world, runner, 0.3);
    }
    const core = world.entities.find((e) => e.alive && e.tag === 'capital');
    expect(core).toBeDefined();
    const spec = VEIL_CH06.objectives.find((o) => o.id === 'intent')!.spec as Extract<
      ObjectiveSpec,
      { kind: 'recon' }
    >;
    // 正面 1200m に置いたまま所要秒数ぶん保つ（撃つ必要はない）
    const steps = Math.round((spec.seconds! + 1) / DT);
    for (let i = 0; i < steps && runner.state === 'running'; i++) {
      aimAt(world.player!, core!, 1200);
      simulateStep(world, DT, { flightMode: 'wc', ai: { maxAttackersOnPlayer: 2 } });
      runner.update(DT);
    }
    const intent = objectiveIndex(VEIL_CH06, 'intent');
    expect(runner.objectiveViews()[intent].state === 'done' || runner.state === 'win').toBe(true);
    // 帰投まで済ませれば勝てる
    if (runner.state === 'running') {
      teleport(world.player!, VEIL_CH06.navs[4].pos);
      run(world, runner, 0.3);
    }
    expect(runner.state).toBe('win');
  });
});

// ───────── 第7章: 書式の提出 ─────────

describe('第7章の必須目標', () => {
  it('中継所への提出 (recon) が必須の達成目標になっている', () => {
    const o = VEIL_CH07.objectives.find((x) => x.id === 'file')!;
    expect(o.required).toBe(true);
    const spec = o.spec as Extract<ObjectiveSpec, { kind: 'recon' }>;
    expect(spec.kind).toBe('recon');
    const relay = VEIL_CH07.spawns.find((g) => g.tag === spec.tag)!;
    expect(relay.displayName).toBe('公証中継所');
    // 中立の共同設備なので誰にも撃たれない（詰みを作らない）
    expect(relay.faction).toBe('neutral');
    // 中継所 Nav に着いた時点で現れる
    expect(relay.atNav).toBe(2);
  });

  it('哨戒機の保護は任意のまま (撃てない相手を守らされない)', () => {
    const patrol = VEIL_CH07.objectives.find((o) => o.id === 'patrol-alive')!;
    expect(patrol.required).toBe(false);
    expect(VEIL_CH07.objectives.some((o) => o.required && o.spec.kind === 'escortArrive')).toBe(false);
  });

  it('自機だけが Nav を踏んでも勝てない', () => {
    const { world, runner } = start(VEIL_CH07);
    touchAllNavs(world, runner, VEIL_CH07);
    const deliver = objectiveIndex(VEIL_CH07, 'deliver');
    expect(runner.objectiveViews()[deliver].state).toBe('done');
    expect(runner.state).toBe('running');
    const file = objectiveIndex(VEIL_CH07, 'file');
    expect(runner.objectiveViews()[file].state).toBe('active');
  });

  it('中継所へ回線を向け続ければ達成できる (詰みではない)', () => {
    const { world, runner } = start(VEIL_CH07);
    for (let i = 0; i < VEIL_CH07.navs.length; i++) {
      teleport(world.player!, VEIL_CH07.navs[i].pos);
      run(world, runner, 0.3);
    }
    const relay = world.entities.find((e) => e.alive && e.tag === 'survey');
    expect(relay).toBeDefined();
    const spec = VEIL_CH07.objectives.find((o) => o.id === 'file')!.spec as Extract<
      ObjectiveSpec,
      { kind: 'recon' }
    >;
    const steps = Math.round((spec.seconds! + 1) / DT);
    for (let i = 0; i < steps && runner.state === 'running'; i++) {
      aimAt(world.player!, relay!, 1200);
      simulateStep(world, DT, { flightMode: 'wc', ai: { maxAttackersOnPlayer: 2 } });
      runner.update(DT);
    }
    expect(runner.state).toBe('win');
  });
});

// ───────── 加点表記 (reward) ─────────

describe('加点表記 (reward) が4状態と一致する', () => {
  const labels = Object.values(NARRATIVE_LABEL);

  it('reward を付けた全目標の名前が4状態のいずれかと一致する', () => {
    let checked = 0;
    for (const def of VEIL_MISSION_LIST) {
      for (const o of def.objectives) {
        if (!o.reward) continue;
        checked += 1;
        expect(o.required, `${def.id}/${o.id} は必須なので reward を持たない`).toBe(false);
        expect(
          labels.some((l) => o.reward!.includes(l)),
          `${def.id}/${o.id}: ${o.reward}`,
        ).toBe(true);
        // 前置は「加点」として読める形（`(任意)` のフォールバックではない）
        expect(o.reward!.startsWith('＋'), `${def.id}/${o.id}: ${o.reward}`).toBe(true);
      }
    }
    expect(checked).toBeGreaterThanOrEqual(15);
  });

  it('十章すべての任意目標に加点表記が付いている', () => {
    for (const def of VEIL_MISSION_LIST) {
      for (const o of def.objectives) {
        if (o.required) continue;
        expect(o.reward, `${def.id}/${o.id} に reward が無い`).toBeTruthy();
      }
    }
  });

  it('加点の宛先は目標の判定内容と噛み合っている (実際に動く状態を書く)', () => {
    /**
     * `src/app/narrative.ts` の `sortieNarrative` が実際に動かす状態:
     *   - rescue（味方・民間の回収） → 帰還者（人数）
     *   - rescue（敵籍の回収）       → 敵エースの誓約 (+5/件)
     *   - protect / protectCount / holdTag（生存） → 航路信頼 (+3 / -3)
     *   - weaponsSafe（一発も撃たない）           → 航路信頼 (+4)
     *   - それ以外の達成目標（destroyTag / recon 等）→ 軍令信用
     *     （未達は「未達成の条件」で -2、全達成は complete で +8）
     */
    const allowed: Record<string, string[]> = {
      rescue: ['帰還者', '敵エースの誓約'],
      protect: ['航路信頼'],
      protectCount: ['航路信頼'],
      holdTag: ['航路信頼'],
      weaponsSafe: ['航路信頼'],
      destroyTag: ['軍令信用'],
      destroyAll: ['軍令信用'],
      recon: ['軍令信用'],
      reachNav: ['軍令信用'],
      survive: ['軍令信用'],
      escortArrive: ['帰還者', '航路信頼'],
      timeLimit: ['帰還者', '航路信頼', '軍令信用'],
      noFriendlyFire: ['航路信頼', '敵エースの誓約'],
    };
    for (const def of VEIL_MISSION_LIST) {
      for (const o of def.objectives) {
        if (!o.reward) continue;
        const ok = allowed[o.spec.kind] ?? [];
        expect(
          ok.some((l) => o.reward!.includes(l)),
          `${def.id}/${o.id}: ${o.spec.kind} に ${o.reward} は噛み合わない`,
        ).toBe(true);
      }
    }
  });

  it('敵エースの誓約を名乗る目標は、敵籍の対象を回収するものだけ', () => {
    for (const def of VEIL_MISSION_LIST) {
      for (const o of def.objectives) {
        if (!o.reward?.includes('敵エースの誓約')) continue;
        expect(o.spec.kind, `${def.id}/${o.id}`).toBe('rescue');
        const tag = (o.spec as { tag: string }).tag;
        const groups = def.spawns.filter((g) => g.tag === tag);
        expect(groups.length, `${def.id}/${o.id}`).toBeGreaterThan(0);
        // 敵陣営（キルラシー）の対象を拾う目標であること
        expect(
          groups.some((g) => g.faction === 'kilrathi'),
          `${def.id}/${o.id}: ${groups.map((g) => g.faction).join(',')}`,
        ).toBe(true);
      }
    }
  });
});

// ───────── 全10章の勝利条件 ─────────

describe('全10章の必須目標', () => {
  it('required の達成対象が reachNav だけの章は無い', () => {
    expect(VEIL_MISSION_LIST.length).toBe(10);
    const report: string[] = [];
    for (const def of VEIL_MISSION_LIST) {
      const achieved = def.objectives
        .filter((o) => o.required && !CONSTRAINT_KINDS.has(o.spec.kind))
        .map((o) => o.spec.kind);
      report.push(`${def.id}: ${achieved.join(' / ')}`);
      // 達成する目標がまったく無い章（＝制約だけが必須）も作らない
      expect(achieved.length, report[report.length - 1]).toBeGreaterThan(0);
      const nonNav = achieved.filter((k) => k !== 'reachNav');
      expect(nonNav.length, `${report[report.length - 1]} — 飛んで着けば勝ちになっている`).toBeGreaterThan(0);
    }
  });

  it('必須の達成目標には必ず対象の宣言がある (綴り違いで詰まない)', () => {
    for (const def of VEIL_MISSION_LIST) {
      for (const o of def.objectives) {
        if (!o.required) continue;
        const tag = (o.spec as { tag?: string }).tag;
        if (!tag) continue;
        expect(
          def.spawns.some((g) => g.tag === tag),
          `${def.id}/${o.id}: タグ ${tag} を出す群が無い`,
        ).toBe(true);
      }
    }
  });
});
