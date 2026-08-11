/**
 * T5-④ ブラウザで確認できなかった項目を sim レベルで固定する — その1「撃墜」。
 *
 * ■ なぜこのテストがあるか
 * headless Chrome は描画フレームが進まないと sim も進まない（rAF がキャプチャの時だけ回る）。
 * キャプチャが sim の時計になるので押しっぱなしの操縦ができず、
 * 「難易度やさしいで敵機を1機以上撃墜できる」が**人手待ち**で止まっていた
 * （`00_initila_constructions/06_更なる改善/PROGRESS.md`「人手で確認したい項目」1）。
 *
 * ここでは描画に触らず `simulateStep` + `MissionRunner.update` だけを回し、
 * 自機を AI に操縦させて「やさしいなら実際に落とせる」ことを固定する。
 * 手本は `tests/ut/mission.test.ts` の「ミッション通しプレイ (AI が自機を操縦)」。
 *
 * ■ 既存テストとの違い
 * `mission.test.ts` は **勝敗 (`runner.state === 'win'`)** を見ている。
 * こちらは **`summary().kills`（= `killedByPlayer`）が1以上になる**こと、つまり
 * 「敵機が自機の射撃で落ちた」ことそのものを見る。魚雷ラン（AI が苦手な操作）は対象外。
 *
 * ■ ステップの引数を実機と揃える理由（重要）
 * `simulateStep` の `playerWeaponModifiers` と `aimAssist` は
 * **難易度「やさしい」の中身そのもの**（弾速 1.35 倍・当たり半径 1.8 倍・強い照準補助）で、
 * `src/app/game.ts` の本番ループが毎フレーム渡している。
 * これを省くと「やさしい」で回しているつもりで実機と違う条件になり、
 * 実際 300 秒回しても1機も落ちない（＝テストとしても現象としても嘘になる）。
 * 出所は `DIFFICULTIES` ひとつに揃えてある。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DIFFICULTIES, type DifficultyProfile } from '../../src/app/settings';
import { isHostile } from '../../src/content/factions';
import { TEST_PATROL } from './fixtures/missions';
import { VEIL_CH02 } from '../../src/content/veil/missions/ch02';
import { reseed } from '../../src/core/rng';
import { MissionRunner } from '../../src/mission/MissionRunner';
import type { MissionDef } from '../../src/mission/types';
import { newAi } from '../../src/sim/ai';
import { setCombatOptions } from '../../src/sim/combat';
import { simulateStep } from '../../src/sim/step';
import { World } from '../../src/world/world';
import { aimAssistStrength } from '../../src/app/settings';

const DT = 1 / 60;

/** 自機に載せる AI の技量。既存の通しプレイテストと同じ値 */
const PILOT_SKILL = 0.95;

beforeEach(() => {
  setCombatOptions({ playerDamageTaken: 1, playerDamageDealt: 1, playerSubsystemRate: 1 });
});
afterEach(() => {
  setCombatOptions({ playerDamageTaken: 1, playerDamageDealt: 1, playerSubsystemRate: 1 });
});

function start(def: MissionDef, profile: DifficultyProfile) {
  const world = new World();
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
  runner.update(DT);
  return { world, runner };
}

/** `src/app/game.ts` の本番ループと同じステップ引数を作る */
function stepOptions(profile: DifficultyProfile) {
  return {
    flightMode: 'wc' as const,
    ai: { maxAttackersOnPlayer: profile.maxAttackers },
    playerWeaponModifiers: profile,
    // 式は `app/settings.ts` の `aimAssistStrength()` が唯一の出所（設定既定は aimAssist: true）
    aimAssist: aimAssistStrength(true, profile.strongAimHelp),
  };
}

/** 自機を Nav へ運ぶ（オートパイロット相当）。到達判定は通常のステップで降らせる */
function jumpToNav(world: World, def: MissionDef, index: number): void {
  const player = world.player!;
  player.pos.set(...def.navs[index].pos);
  player.prevPos.copy(player.pos);
  player.renderPrevPos.copy(player.pos);
}

interface FightResult {
  /** 自機が最初の撃墜を取った時刻 (秒)。取れなければ -1 */
  killAt: number;
  kills: number;
  state: MissionRunner['state'];
  /** 交戦した敵機の最大数（そもそも敵が出たかの担保） */
  peakHostiles: number;
}

/** 敵が出るまで待ってから、撃墜が出るまで（最長 seconds 秒）普通にステップする */
function fightUntilKill(
  world: World,
  runner: MissionRunner,
  profile: DifficultyProfile,
  seconds: number,
): FightResult {
  const opts = stepOptions(profile);
  const player = world.player!;
  const steps = Math.round(seconds / DT);
  let peakHostiles = 0;
  for (let i = 0; i < steps; i++) {
    simulateStep(world, DT, opts);
    runner.update(DT);
    if (i % 30 === 0) {
      const n = world.entities.filter(
        (e) => e.alive && e.kind === 'ship' && e.ship && isHostile(player.faction, e.faction),
      ).length;
      if (n > peakHostiles) peakHostiles = n;
    }
    if (runner.kills > 0) {
      return { killAt: i * DT, kills: runner.kills, state: runner.state, peakHostiles };
    }
    if (runner.state !== 'running') break;
  }
  return { killAt: -1, kills: runner.kills, state: runner.state, peakHostiles };
}

describe('やさしいで敵機を1機以上撃墜できる (AI が自機を操縦)', () => {
  const easy = DIFFICULTIES.easy;

  /**
   * 第2章。PROGRESS.md が「実機で撃墜まで到達できなかった」と記録している場面そのもの
   * （偽装無人機 = キルラシー陣営の hornet ×3 が NAV 2 で出る）。
   * 乱数の当たり外れで通ったことにしないよう、seed を3つ固定して全部で成立させる。
   */
  it.each([0x5eed0002, 0x5eed0003, 0x5eed0063])('第2章の偽装無人機を落とせる (seed %#)', (seed) => {
    reseed(seed);
    const { world, runner } = start(VEIL_CH02, easy);
    world.player!.ai = newAi(PILOT_SKILL);

    // Nav は最小の未到達 index から順にしか取れないので、NAV 1 → NAV 2 と踏む
    jumpToNav(world, VEIL_CH02, 0);
    for (let i = 0; i < 30; i++) {
      simulateStep(world, DT, stepOptions(easy));
      runner.update(DT);
    }
    jumpToNav(world, VEIL_CH02, 1);

    // 無人機は delay 5（+ やさしいの waveDelayBonus 12）で出る。待ち時間も同じループに含める
    const r = fightUntilKill(world, runner, easy, 260);
    expect(r.peakHostiles).toBeGreaterThan(0);
    expect(r.killAt, `撃墜できなかった (state=${r.state})`).toBeGreaterThan(0);
    expect(r.kills).toBeGreaterThanOrEqual(1);
    // 撃墜数は summary にも同じ値で載る（表示と実挙動の出所が同じ）
    expect(runner.summary().kills).toBe(r.kills);
    runner.dispose();
  });

  /**
   * 哨戒ミッション（第1章相当の腕試し）でも成立すること。
   * こちらは僚機付きなので、`kills` が僚機の撃墜を数えていないことの確認も兼ねる
   * （`kills` は `killedByPlayer` のときだけ増える）。
   */
  it.each([0x5eed0003, 0x5eed3039])('哨戒ミッションでも落とせる (seed %#)', (seed) => {
    reseed(seed);
    const def = TEST_PATROL;
    const { world, runner } = start(def, easy);
    world.player!.ai = newAi(PILOT_SKILL);

    jumpToNav(world, def, 0);
    for (let i = 0; i < 30; i++) {
      simulateStep(world, DT, stepOptions(easy));
      runner.update(DT);
    }
    jumpToNav(world, def, 1);

    const r = fightUntilKill(world, runner, easy, 260);
    expect(r.peakHostiles).toBeGreaterThan(0);
    expect(r.killAt, `撃墜できなかった (state=${r.state})`).toBeGreaterThan(0);

    const wingman = world.entities.find(
      (e) => e.kind === 'ship' && e.id !== world.playerId && e.faction === world.player!.faction,
    );
    // 僚機の戦果は自機の撃墜数に混ざらない
    expect(runner.summary().kills).toBe(runner.kills);
    expect(runner.summary().wingmanKills).toBe(wingman?.ship?.kills ?? 0);
    runner.dispose();
  });

  /**
   * 難易度の中身が `DIFFICULTIES` から `simulateStep` へ届いていることを固定する。
   * これが崩れたら、上のテストが実機と違う条件で通っている可能性がある。
   *
   * ■ 判定を「落とせない」から「弾に補正が乗っている」へ変えた理由
   * 以前は「補正を渡さないと 120 秒で1機も落ちない」ことを根拠にしていたが、
   * (1) 照準環と射線を一致させた (`core/aim.ts`: 弾が照準の上へ飛ばなくなった)
   * (2) やさしいの敵速度を 25% にした (`DIFFICULTIES.easy.enemySpeedScale`)
   * の2点で、補正なしでも当たるようになった。
   * 「当たらないこと」に依存した判定は、命中性の改善で必ず壊れるので、
   * **補正そのものが弾へ乗っているか**を直接見る。
   */
  it('難易度補正が simulateStep から弾へ届いている', () => {
    const fireOneShot = (
      opts: ReturnType<typeof stepOptions> | { flightMode: 'wc'; ai: { maxAttackersOnPlayer: number } },
    ) => {
      reseed(0x5eed0003);
      const def = TEST_PATROL;
      const { world, runner } = start(def, easy);
      const player = world.player!;
      player.input!.firePrimary = true;
      simulateStep(world, DT, opts);
      const shot = world.entities.find((e) => e.kind === 'projectile' && e.projectile?.fromPlayer);
      expect(shot).toBeDefined();
      const result = {
        // 母機の速度を引いた、砲そのものの弾速
        speed: shot!.vel.clone().sub(player.vel).length(),
        hitRadiusScale: shot!.projectile!.hitRadiusScale,
      };
      runner.dispose();
      return result;
    };

    const bare = fireOneShot({ flightMode: 'wc', ai: { maxAttackersOnPlayer: easy.maxAttackers } });
    const withEasy = fireOneShot(stepOptions(easy));

    expect(withEasy.speed).toBeCloseTo(bare.speed * easy.playerGunSpeedScale, 6);
    expect(bare.hitRadiusScale).toBe(1);
    expect(withEasy.hitRadiusScale).toBe(easy.playerGunHitRadiusScale);
  });
});
