import { describe, expect, it } from 'vitest';
import {
  casualtyBanner,
  endDelayFor,
  LOSS_READ_DELAY,
  PLAYER_DEATH_HOLD,
} from '../../src/app/game';
import { displayNameOf, MissionRunner } from '../../src/mission/MissionRunner';
import { DIFFICULTIES } from '../../src/app/settings';
import { World } from '../../src/world/world';
import {
  CONTROL_ESCORT_LOST,
  controlEscortLostLine,
  escortDamageLine,
} from '../../src/content/dialogue';
import { VEIL_CH01 } from '../../src/content/veil/missions';
import type { MissionDef } from '../../src/mission/types';

/**
 * T1-② 追補: 護衛対象の被弾・喪失を戦闘中に伝える。
 *
 * 護衛対象の喪失は「一番大事な負け筋」なので、僚機・自機と同じ扱い
 * （段階ごとの無線 → 中央告知 → 読める時間）が必要。
 */

/** 第1章の定義（護衛対象〈アストラ・メイ〉を持つ実データで確認する） */
const CH01: MissionDef = VEIL_CH01;

/** 第1章を組み立てて runner を返す（護衛対象の列挙は runner の公開 API に任せる） */
function buildCh01(): { runner: MissionRunner; world: World } {
  const world = new World();
  const runner = new MissionRunner(world, CH01, { shipId: 'hornet' }, DIFFICULTIES.normal);
  runner.build();
  return { runner, world };
}

describe('護衛対象の読み取り（MissionRunner の公開 API を使う）', () => {
  it('第1章の護衛タグは protect / escortArrive の対象で、回収対象は含まない', () => {
    const { runner } = buildCh01();
    expect(runner.escortTags.has('escort')).toBe(true);
    expect(runner.escortTags.has('rescue')).toBe(false);
  });

  it('第1章の護衛対象は〈アストラ・メイ〉として宣言されている', () => {
    expect(CH01.spawns.find((g) => g.tag === 'escort')?.displayName).toContain('アストラ・メイ');
  });

  it('出現済みの護衛対象を宣言名で列挙でき、撃墜イベントの機体からも同じ名前が読める', () => {
    // 第1章の護衛対象は Nav1 で出現するため、判定経路だけを最小の定義で確認する
    const def: MissionDef = {
      id: 'escort-now',
      title: '護衛テスト',
      system: 'テスト',
      briefing: ['—'],
      briefingSpeaker: '管制',
      navs: [{ name: '帰投', pos: [0, 0, -2000] }],
      spawns: [
        {
          shipId: 'drayman',
          count: 1,
          faction: 'confed',
          tag: 'escort',
          displayName: '〈テスト・メイ〉',
          offset: [0, 0, -600],
          spread: 0,
        },
      ],
      objectives: [
        { id: 'keep', text: '守る', required: true, spec: { kind: 'protect', tag: 'escort' } },
      ],
      playerShipId: 'hornet',
      debriefWin: ['—'],
      debriefLoss: ['—'],
    };
    const world = new World();
    const runner = new MissionRunner(world, def, { shipId: 'hornet' }, DIFFICULTIES.normal);
    runner.build();

    const targets = runner.escortTargets();
    expect(targets).toHaveLength(1);
    expect(targets[0].name).toBe('〈テスト・メイ〉');
    expect(targets[0].tag).toBe('escort');

    const entity = world.byId(targets[0].id)!;
    expect(runner.isEscortTarget(entity)).toBe(true);
    // 撃墜イベントの target からも同じ名前を読める（中央告知に使う経路）
    expect(displayNameOf(entity)).toBe('〈テスト・メイ〉');
  });

  it('護衛対象でない機体は isEscortTarget が false（無関係な機体に無線を出さない）', () => {
    const { runner, world } = buildCh01();
    const player = world.player!;
    expect(runner.isEscortTarget(player)).toBe(false);
  });
});

describe('護衛対象の被弾段階の無線', () => {
  it('シールド喪失・装甲被弾・ハル危険域で別の文になる', () => {
    const draw = (stage: 'shield-down' | 'armor-hit' | 'hull-critical') =>
      new Set(Array.from({ length: 100 }, () => escortDamageLine(stage)));
    const shield = draw('shield-down');
    const armor = draw('armor-hit');
    const critical = draw('hull-critical');
    expect(shield.size).toBeGreaterThan(0);
    for (const line of armor) expect(shield.has(line)).toBe(false);
    for (const line of critical) expect(shield.has(line)).toBe(false);
    for (const line of critical) expect(armor.has(line)).toBe(false);
  });

  it('喪失の無線には必ず艦名が入る', () => {
    for (const line of CONTROL_ESCORT_LOST) expect(line).toContain('{name}');
    for (let i = 0; i < 30; i++) {
      const line = controlEscortLostLine('〈アストラ・メイ〉');
      expect(line).toContain('〈アストラ・メイ〉');
      expect(line).not.toContain('{name}');
    }
  });
});

describe('中央告知は僚機戦死・護衛喪失・自機撃墜を区別する', () => {
  it('護衛対象は「喪失」、僚機は「戦死」で、文言が重ならない', () => {
    const escort = casualtyBanner('escort', '〈アストラ・メイ〉');
    const wingman = casualtyBanner('wingman', 'Sable');
    expect(escort.title).toBe('〈アストラ・メイ〉 喪失');
    expect(escort.title).not.toContain('戦死');
    expect(wingman.title).toBe('Sable 戦死');
    expect(escort.note).not.toBe(wingman.note);
    // 艦であることが分かる説明になっている
    expect(escort.note).toContain('護衛対象');
  });

  it('自機撃墜は名前ではなく「撃墜された」を出し、間の長さに合わせて表示する', () => {
    const player = casualtyBanner('player');
    expect(player.title).toBe('撃墜された');
    expect(player.durationMs).toBe(PLAYER_DEATH_HOLD * 1000);
  });

  it('護衛喪失の告知は2〜3秒', () => {
    const escort = casualtyBanner('escort', '船');
    expect(escort.durationMs).toBeGreaterThanOrEqual(2000);
    expect(escort.durationMs).toBeLessThanOrEqual(3000);
  });
});

describe('任務終了までの余韻', () => {
  it('失敗で終わるときも見出しを読める時間が残る', () => {
    expect(LOSS_READ_DELAY).toBeGreaterThanOrEqual(2.5);
    expect(endDelayFor('loss', { landing: false })).toBe(LOSS_READ_DELAY);
    // 護衛を失って負けた場合（撃墜されていない）も同じ
    expect(endDelayFor('loss', { landing: false })).toBeGreaterThanOrEqual(2.5);
  });

  it('達成で帰投するときの既存テンポ（4.2秒の着艦演出）は変えない', () => {
    expect(endDelayFor('win', { landing: true })).toBe(4.2);
  });

  it('脱出して勝った場合（着艦演出なし）も見出しを読める時間を取る', () => {
    expect(endDelayFor('win', { landing: false })).toBe(LOSS_READ_DELAY);
  });

  it('撃墜されたときは撃墜演出の残りが尽きるまで待つ', () => {
    expect(endDelayFor('loss', { landing: false, deathRemaining: PLAYER_DEATH_HOLD })).toBeCloseTo(
      PLAYER_DEATH_HOLD + 0.4,
      5,
    );
    // 演出が残り少なくても、読める時間は下回らない
    expect(endDelayFor('loss', { landing: false, deathRemaining: 0.1 })).toBe(LOSS_READ_DELAY);
  });
});
