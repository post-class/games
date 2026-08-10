/**
 * T5-④ ブラウザで確認できなかった項目を sim レベルで固定する — その3「決闘中の非交戦」。
 *
 * ■ なぜこのテストがあるか
 * 「決闘が成立すると、周りの帝国機が撃ってこなくなる」は目視でしか確かめられておらず、
 * headless では連続操縦ができないため人手待ちで残っていた
 * （`00_initila_constructions/06_更なる改善/PROGRESS.md`「人手で確認したい項目」3）。
 *
 * ■ 既存テストとの棲み分け（重複させない）
 * - `tests/ut/t4a-ace-comms.test.ts`: `updateAi` だけを回して
 *   **`ai.targetId` と `duelStandDown()` の判定**を固定している（条件の単体）。
 * - このファイル: `MissionRunner` で建てた宙域を `simulateStep` で通し、
 *   **実際に弾が1発も出ないこと**（`projectile` エンティティの持ち主を数える）と
 *   **自機のハルが誓約を守る側の射撃では減らないこと**を見る。
 *   同じ seed で「決闘なし」の対照を取り、撃てる位置に居たのに撃たなかったことを示す。
 *
 * ■ 決闘の宣言の出所について（実装への申し送り）
 * `standDownFaction`（= 当事者以外は自機を撃たない）を渡しているのは
 * いま `src/app/game.ts` の決闘受諾処理だけで、ミッション定義（`spawns[].ace.duel`）から
 * `MissionRunner` が渡す経路は無い。ここでは game.ts と同じ引数で `configureDuel` を呼ぶ。
 * 引数がひとところに無いので、`game.ts` 側から受諾時の規約を組む関数を
 * export してもらえれば、この二重化は消せる（報告済み）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DIFFICULTIES } from '../../src/app/settings';
import { reseed } from '../../src/core/rng';
import { MissionRunner } from '../../src/mission/MissionRunner';
import type { MissionDef } from '../../src/mission/types';
import { breakDuel, configureDuel, duelActive, duelState, resetDuel } from '../../src/sim/ai';
import { setCombatOptions } from '../../src/sim/combat';
import { simulateStep } from '../../src/sim/step';
import type { Entity } from '../../src/world/entity';
import { World } from '../../src/world/world';
import { playerDuelRules } from '../../src/app/game';
import { VEIL_MISSION_LIST } from '../../src/content/veil/missions';

const DT = 1 / 60;
const profile = DIFFICULTIES.normal;

/**
 * 決闘の宙域。自機1機 対 エース1機 + 同じ陣営の僚機3機。
 *
 * 自機以外に連邦機を置いていないので、帝国機が撃つ相手は自機しか居ない。
 * 「弾が1発も出ない」がそのまま「自機を撃たなかった」になる。
 */
const DUEL_FIELD: MissionDef = {
  id: 'test-duel-ceasefire',
  title: '決闘テスト',
  system: 'Test',
  briefing: [''],
  briefingSpeaker: '管制',
  playerShipId: 'rapier',
  navs: [{ name: 'NAV 1', pos: [0, 0, -6000] }],
  spawns: [
    {
      shipId: 'kf03-greyhaul',
      count: 1,
      faction: 'kilrathi',
      offset: [0, 0, -900],
      spread: 0,
      speed: 0,
      tag: 'ace',
      ace: { pilot: 'ラギティカ', skillBonus: 0.3 },
    },
    {
      shipId: 'kf01-leonfang',
      count: 3,
      faction: 'kilrathi',
      offset: [500, 0, -1100],
      spread: 200,
      speed: 0,
      tag: 'wingmen',
    },
  ],
  objectives: [
    { id: 'clear', text: '撃破', required: true, spec: { kind: 'destroyAll' } },
  ],
  debriefWin: [''],
  debriefLoss: [''],
};

interface Field {
  world: World;
  runner: MissionRunner;
  player: Entity;
  ace: Entity;
  wingmen: Entity[];
}

function build(seed: number): Field {
  reseed(seed);
  resetDuel();
  const world = new World();
  setCombatOptions({
    playerDamageTaken: profile.playerDamageTaken,
    playerDamageDealt: profile.playerDamageDealt,
    playerSubsystemRate: profile.playerSubsystemRate,
  });
  const runner = new MissionRunner(world, DUEL_FIELD, { shipId: DUEL_FIELD.playerShipId }, profile);
  runner.build();
  runner.update(DT);
  const player = world.player!;
  // 自機は撃たない（撃ち返しで相手を減らすと対照が崩れる）。操縦もしない
  player.input!.firePrimary = false;
  player.input!.throttle = 0.3;
  const ace = world.entities.find((e) => e.tag === 'ace')!;
  const wingmen = world.entities.filter((e) => e.tag === 'wingmen');
  expect(ace).toBeDefined();
  expect(wingmen).toHaveLength(3);
  return { world, runner, player, ace, wingmen };
}

/**
 * `src/app/game.ts` の決闘受諾と**同じ規約**を張る。
 *
 * 数値を写さず `playerDuelRules()` を呼ぶ（実装が唯一の出所）。
 * 以前はここに `spareHullRatio: 0.12` などを書き写していたので、
 * 実装側を変えてもテストが古い値で通り続けてしまう状態だった。
 */
function acceptDuel(f: Field): void {
  configureDuel(
    playerDuelRules({ duellistId: f.ace.id, opponentId: f.player.id, faction: f.ace.faction }),
  );
  if (f.ace.ai) {
    f.ace.ai.targetId = f.player.id;
    f.ace.ai.order = undefined;
  }
  if (f.ace.ship) f.ace.ship.targetId = f.player.id;
}

interface Shots {
  /** 撃った機体の id → 発射した弾数 */
  byOwner: Map<number, number>;
  /** 自機を目標に選んだ機体の id */
  aimedAtPlayer: Set<number>;
  /** 引き金を引いたときに自機を狙っていた機体の id */
  firedAtPlayer: Set<number>;
}

/** 弾の持ち主を数えながら通しでステップする */
function fly(f: Field, seconds: number): Shots {
  const byOwner = new Map<number, number>();
  const aimedAtPlayer = new Set<number>();
  const firedAtPlayer = new Set<number>();
  const seen = new Set<number>();
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) {
    f.player.input!.firePrimary = false;
    simulateStep(f.world, DT, {
      flightMode: 'wc',
      ai: { maxAttackersOnPlayer: 4 },
    });
    f.runner.update(DT);
    for (const e of f.world.entities) {
      if (e.kind !== 'projectile' || !e.projectile) continue;
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      byOwner.set(e.projectile.ownerId, (byOwner.get(e.projectile.ownerId) ?? 0) + 1);
    }
    for (const e of f.world.entities) {
      if (e.kind !== 'ship' || !e.ai || e.id === f.player.id) continue;
      if (e.ai.targetId === f.player.id) {
        aimedAtPlayer.add(e.id);
        if (e.input?.firePrimary) firedAtPlayer.add(e.id);
      }
    }
  }
  return { byOwner, aimedAtPlayer, firedAtPlayer };
}

function shotsFrom(shots: Shots, ships: readonly Entity[]): number {
  let n = 0;
  for (const s of ships) n += shots.byOwner.get(s.id) ?? 0;
  return n;
}

beforeEach(() => {
  resetDuel();
  setCombatOptions({ playerDamageTaken: 1, playerDamageDealt: 1, playerSubsystemRate: 1 });
});
afterEach(() => {
  resetDuel();
  setCombatOptions({ playerDamageTaken: 1, playerDamageDealt: 1, playerSubsystemRate: 1 });
});

const SEED = 0x5d5d0001;
const WINDOW = 40;

describe('決闘中はエースの陣営の他機が自機を撃たない (通し)', () => {
  /** 対照。決闘が無ければ僚機は自機を狙って撃つ */
  it('決闘なしなら僚機は自機を狙い、実際に弾を撃つ', () => {
    const f = build(SEED);
    const shots = fly(f, WINDOW);
    const wingmanShots = shotsFrom(shots, f.wingmen);
    expect(wingmanShots).toBeGreaterThan(0);
    expect(f.wingmen.some((w) => shots.aimedAtPlayer.has(w.id))).toBe(true);
    expect(f.wingmen.some((w) => shots.firedAtPlayer.has(w.id))).toBe(true);
    f.runner.dispose();
  });

  it('決闘が成立すると僚機は弾を1発も撃たず、自機を目標にも選ばない', () => {
    const f = build(SEED);
    acceptDuel(f);
    expect(duelActive()).toBe(true);

    const shots = fly(f, WINDOW);
    // 撃つ相手は自機しか居ないので、弾が0発 = 自機へ撃たなかった
    expect(shotsFrom(shots, f.wingmen)).toBe(0);
    for (const w of f.wingmen) {
      expect(shots.aimedAtPlayer.has(w.id), `僚機 ${w.id} が自機を狙った`).toBe(false);
      expect(shots.firedAtPlayer.has(w.id)).toBe(false);
      // 生きたまま同じ空域に居る（居なくなったから撃たれなかった、ではない）
      expect(w.alive).toBe(true);
      expect(w.pos.distanceTo(f.player.pos)).toBeLessThan(20000);
    }
    // 当事者（エース）は付き合う。決闘そのものは動いている
    expect(shots.aimedAtPlayer.has(f.ace.id)).toBe(true);
    f.runner.dispose();
  });

  it('自機に当たる弾は当事者のものだけになる', () => {
    const noDuel = build(SEED);
    const before = noDuel.player.ship!.hull;
    fly(noDuel, WINDOW);
    const damageWithoutDuel = before - noDuel.player.ship!.hull;
    noDuel.runner.dispose();

    const f = build(SEED);
    acceptDuel(f);
    const hullBefore = f.player.ship!.hull;
    const shots = fly(f, WINDOW);
    const damageWithDuel = hullBefore - f.player.ship!.hull;

    // 一対一になった分、受ける火力は減る（増えていたら非交戦が効いていない）
    expect(damageWithDuel).toBeLessThanOrEqual(damageWithoutDuel);
    // 帝国機のうち弾を出したのは当事者だけ
    const shooters = [...shots.byOwner.keys()].filter((id) => id !== f.player.id);
    expect(shooters.every((id) => id === f.ace.id), `撃った機体: ${shooters}`).toBe(true);
    f.runner.dispose();
  });

  it('誓約が破られると僚機は通常の交戦に戻り、また撃ってくる', () => {
    const f = build(SEED);
    acceptDuel(f);
    const quiet = fly(f, 12);
    expect(shotsFrom(quiet, f.wingmen)).toBe(0);

    // 急進派の介入相当。破った側として僚機を登録する
    breakDuel(f.wingmen.map((w) => w.id));
    expect(duelActive()).toBe(false);
    expect(duelState().broken).toBe(true);

    const after = fly(f, WINDOW);
    expect(shotsFrom(after, f.wingmen)).toBeGreaterThan(0);
    expect(f.wingmen.some((w) => after.aimedAtPlayer.has(w.id))).toBe(true);
    f.runner.dispose();
  });
});

/**
 * ミッション宣言の決闘（第5章）は**陣営を退かせない**。
 *
 * プレイヤーが自分で申し込む決闘（`playerDuelRules`）は相手の陣営全体を退かせるが、
 * `MissionRunner` が `spawns[].ace.duel` から張る決闘は `standDownFaction` を渡さない。
 * 第5章は同じ `kilrathi` 陣営の中に「誓約派（保護対象）」と「急進派（撃破対象）」が
 * 同時に居る作りで、陣営単位で退かせると**必須目標の「急進派の阻止」が成立しなくなる**。
 *
 * これは意図した設計なので、「決闘なのに退かないのはバグでは」と後から
 * `e.faction` を渡してしまわないよう、ここで固定する。
 */
describe('ミッション宣言の決闘は陣営を退かせない（第5章の作りを守る）', () => {
  it('playerDuelRules は standDownFaction を持つ（プレイヤーの申し込みは退かせる）', () => {
    const rules = playerDuelRules({ duellistId: 1, opponentId: 2, faction: 'kilrathi' });
    expect(rules.standDownFaction).toBe('kilrathi');
  });

  it('第5章の決闘宣言に陣営を退かせる指定が無い', () => {
    // 章データ側に「陣営ごと退かせる」項目が生えていないことを確認する。
    // ここが増えたら、急進派も撃ってこなくなり必須目標が壊れる。
    const ch05 = VEIL_MISSION_LIST.find((d) => d.id === 'veil-ch05');
    expect(ch05).toBeDefined();
    const duels = (ch05!.spawns ?? []).filter((g) => g.ace?.duel).map((g) => g.ace!.duel!);
    expect(duels.length).toBeGreaterThan(0);
    for (const d of duels) {
      expect(Object.keys(d)).not.toContain('standDownFaction');
    }
  });

  it('第5章は同じ陣営の中に保護対象と撃破対象が同時に居る（退かせられない理由）', () => {
    const ch05 = VEIL_MISSION_LIST.find((d) => d.id === 'veil-ch05')!;
    const kil = (ch05.spawns ?? []).filter((g) => g.faction === 'kilrathi');
    const tags = new Set(kil.map((g) => g.tag).filter(Boolean) as string[]);
    // 「守る側」と「落とす側」が同じ陣営に混在している
    expect(tags.size).toBeGreaterThan(1);
    const objectiveTags = new Set(
      ch05.objectives
        .map((o) => ('tag' in o.spec ? (o.spec as { tag?: string }).tag : undefined))
        .filter(Boolean) as string[],
    );
    // 目標が参照するタグが、同じ陣営の複数のグループを指している
    const shared = [...objectiveTags].filter((t) => tags.has(t));
    expect(shared.length).toBeGreaterThan(1);
  });
});
