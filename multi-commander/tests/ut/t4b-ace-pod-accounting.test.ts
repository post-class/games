/**
 * エースの脱出ポッドを撃った結果の宛先（T4-⑯ からの依頼、T4-⑮ 担当が実装）。
 *
 * ■ 何を固定するか
 * ポッドの座席を狙って撃つのは**意図的な行為**なので、その記録は
 * 「敵エースの誓約」へ行くべきで、
 *   - `friendlyFireHits`（味方と中立の**識別ミス**を測る＝「誤射ゼロ」目標）
 *   - `civilianLosses`（民間損害＝航路信頼）
 * に混ざってはいけない。混ざると「誤射ゼロ」が本来と違う理由で失敗し、
 * 敵エースを撃ったことが民間人を殺したのと同じ扱いになる。
 *
 * 一方、**通常の脱出ポッド**（`sim/eject.ts` が出す自機・僚機のポッド、
 * ミッション定義の救難ポッド）は `ace-pod:` の接頭辞を持たないので、
 * 従来どおり誤射・民間損害に数えなければならない。両方を並べて固定する。
 */
import { Vector3 } from 'three';
import { beforeEach, describe, expect, it } from 'vitest';
import { DIFFICULTIES } from '../../src/app/settings';
import { ACE_POD_TAG_PREFIX, isAcePodTag } from '../../src/sim/eject';
import { ACE_POD_TAG_PREFIX as GAME_ACE_POD_TAG_PREFIX } from '../../src/app/game';
import { bus } from '../../src/core/events';
import { reseed } from '../../src/core/rng';
import { MissionRunner } from '../../src/mission/MissionRunner';
import type { MissionDef } from '../../src/mission/types';
import { destroyEntity, setCombatOptions } from '../../src/sim/combat';
import type { Entity } from '../../src/world/entity';
import { World } from '../../src/world/world';

const DT = 1 / 60;

function defWith(tag: string): MissionDef {
  return {
    id: `test-pod-${tag}`,
    title: 'ポッド集計テスト',
    system: 'Test',
    briefing: [''],
    briefingSpeaker: '管制',
    playerShipId: 'hornet',
    // 自機の開始位置で帰投判定が降りないよう、帰投 Nav は離しておく
    navs: [{ name: '帰投', pos: [0, 0, 30000] }],
    spawns: [
      {
        shipId: 'escape-pod',
        count: 1,
        faction: 'neutral',
        tag,
        offset: [0, 0, -1200],
        spread: 0,
        speed: 0,
      },
    ],
    objectives: [
      { id: 'ff', text: '誤射ゼロ', required: true, spec: { kind: 'noFriendlyFire' } },
      { id: 'home', text: '帰投', required: true, spec: { kind: 'reachNav', navIndex: 0 } },
    ],
    debriefWin: [''],
    debriefLoss: [''],
  };
}

function start(tag: string) {
  const world = new World();
  const def = defWith(tag);
  const runner = new MissionRunner(world, def, { shipId: 'hornet' }, DIFFICULTIES.normal);
  runner.build();
  runner.update(DT);
  const pod = world.entities.find((e) => e.tag === tag)!;
  return { world, runner, pod };
}

/** 自機の射撃がポッドに当たった、という1件を流す */
function playerHit(pod: Entity): void {
  bus.emit('weaponHit', { target: pod, fromPlayer: true, weaponKind: 'gun', weaponId: 'laser' });
}

describe('エースの脱出ポッドは誤射・民間損害に数えない', () => {
  beforeEach(() => {
    reseed(0x4bace);
    setCombatOptions({ playerDamageTaken: 1, playerDamageDealt: 1 });
  });

  it('tag の接頭辞の判定', () => {
    expect(isAcePodTag('ace-pod:ragitika')).toBe(true);
    expect(isAcePodTag(ACE_POD_TAG_PREFIX)).toBe(true);
    expect(isAcePodTag('pods')).toBe(false);
    expect(isAcePodTag(undefined)).toBe(false);
  });

  it('接頭辞の文字列がポッドを出す側 (game.ts) と一致している', () => {
    // 出所は将来 `sim/eject.ts` の1つにまとめる（game.ts 側の宣言を re-export にする）。
    // それまでの間、文字列がずれたらここで落ちる。
    expect(GAME_ACE_POD_TAG_PREFIX).toBe(ACE_POD_TAG_PREFIX);
  });

  it('エースのポッドに当てても誤射に数えない', () => {
    const { runner, pod } = start(`${ACE_POD_TAG_PREFIX}ragitika`);
    playerHit(pod);
    playerHit(pod);
    runner.update(DT);
    expect(runner.summary().friendlyFireHits).toBe(0);
    // 「誤射ゼロ」目標も破られない
    expect(runner.summary().objectives.find((o) => o.text.includes('誤射ゼロ'))?.state).not.toBe(
      'failed',
    );
    runner.dispose();
  });

  it('エースのポッドを壊しても民間損害に数えない', () => {
    const { world, runner, pod } = start(`${ACE_POD_TAG_PREFIX}ragitika`);
    destroyEntity(world, pod);
    world.compact();
    runner.update(DT);
    expect(runner.summary().civilianLosses).toBe(0);
    runner.dispose();
  });

  it('通常の脱出ポッドは従来どおり誤射に数える', () => {
    const { runner, pod } = start('pods');
    playerHit(pod);
    runner.update(DT);
    expect(runner.summary().friendlyFireHits).toBe(1);
    expect(runner.summary().objectives.find((o) => o.text.includes('誤射ゼロ'))?.state).toBe(
      'failed',
    );
    runner.dispose();
  });

  it('通常の脱出ポッドの喪失は従来どおり民間損害に数える', () => {
    const { world, runner, pod } = start('pods');
    destroyEntity(world, pod);
    world.compact();
    runner.update(DT);
    expect(runner.summary().civilianLosses).toBe(1);
    runner.dispose();
  });

  it('タグの無い中立艦の喪失も従来どおり民間損害に数える', () => {
    const world = new World();
    const def = defWith('pods');
    const runner = new MissionRunner(world, def, { shipId: 'hornet' }, DIFFICULTIES.normal);
    runner.build();
    runner.update(DT);
    const neutral = world.entities.find((e) => e.tag === 'pods')!;
    neutral.tag = undefined;
    neutral.pos.add(new Vector3(0, 0, -100));
    destroyEntity(world, neutral);
    world.compact();
    runner.update(DT);
    expect(runner.summary().civilianLosses).toBe(1);
    runner.dispose();
  });
});
