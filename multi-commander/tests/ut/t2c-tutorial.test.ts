import { Vector3 } from 'three';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bus } from '../../src/core/events';
import { Tutorial, type TutorialContext } from '../../src/ui/Tutorial';
import { resetSettings, settings } from '../../src/app/settings';
import { shipDef } from '../../src/content/ships';
import { spawnShip, World } from '../../src/world/world';
import { FakeElement, installFakeDom, type FakeDom } from './fake-dom';

/**
 * T2-⑭ チュートリアルの不具合。
 *
 * - 表示どおりの操作で進む（スロットルを1段上げたら1歩目が終わる）
 * - 6ステップを最後まで通せる
 * - 出撃が終わったら帯が消え、以後は勝手に出てこない
 *
 * 「操作イベントを受け取った」だけで完了扱いにしないため、
 * 判定は操作後のゲーム状態（スロットル値・ターゲット・オートパイロット）で行う。
 */

interface FakeInput {
  throttle: number;
  pitch: number;
  yaw: number;
  roll: number;
  afterburner: boolean;
  afterburnerUsed: boolean;
  flightInputUsed: boolean;
}

function makeCtx(world: World): { ctx: TutorialContext; input: FakeInput } {
  const input: FakeInput = {
    throttle: 0.5,
    pitch: 0,
    yaw: 0,
    roll: 0,
    afterburner: false,
    afterburnerUsed: false,
    flightInputUsed: false,
  };
  const ctx = {
    world,
    input,
    autopilot: false,
    commsOpen: false,
    navMapOpen: false,
  } as unknown as TutorialContext;
  return { ctx, input };
}

let dom: FakeDom;

function setup() {
  const container = new FakeElement('div');
  const tutorial = new Tutorial(container as unknown as HTMLElement);
  const world = new World();
  const player = spawnShip(world, {
    def: shipDef('rapier'),
    faction: 'confed',
    pos: new Vector3(),
    speed: 0,
    label: '自機',
    pilot: 'あなた',
  });
  world.playerId = player.id;
  // 出撃直後のスロットルを 50% にしておく（実機で詰まった状況と同じ）
  player.input!.throttle = 0.5;
  const { ctx, input } = makeCtx(world);
  return { container, tutorial, world, player, ctx, input };
}

/** 実際に撃った経路で発射数を数えさせる（内部値を直接書き換えない） */
function fire(player: ReturnType<typeof setup>['player'], kind: 'gun' | 'missile'): void {
  bus.emit('weaponFired', {
    shooter: player,
    muzzle: new Vector3(),
    direction: new Vector3(0, 0, -1),
    weaponKind: kind,
    weaponId: kind === 'gun' ? 'mass-driver' : 'javelin',
    isPlayer: true,
  });
}

beforeEach(() => {
  resetSettings();
  dom = installFakeDom();
});

afterEach(() => {
  dom.restore();
});

describe('T2-⑭ 完了条件が表示と一致する', () => {
  it('スロットルを 50% → 60% に上げたら1歩目が終わる', () => {
    const { tutorial, ctx, input } = setup();
    tutorial.start('simple');
    expect(tutorial.stepIndex).toBe(0);

    // 上げる前は進まない（何もしていないのに進まないこと）
    tutorial.update(ctx, 1 / 60);
    expect(tutorial.stepIndex).toBe(0);

    input.throttle = 0.6;
    tutorial.update(ctx, 1 / 60);
    expect(tutorial.throttleRaised).toBe(true);
    expect(tutorial.stepIndex).toBe(1);
  });

  it('スロットルを下げただけでは進まない', () => {
    const { tutorial, ctx, input } = setup();
    tutorial.start('simple');
    tutorial.update(ctx, 1 / 60);
    input.throttle = 0.4;
    tutorial.update(ctx, 1 / 60);
    expect(tutorial.throttleRaised).toBe(false);
    expect(tutorial.stepIndex).toBe(0);
  });

  it('停止まで戻したら完了扱いにしない（表示と実状態を一致させる）', () => {
    const { tutorial, ctx, input } = setup();
    tutorial.start('simple');
    tutorial.update(ctx, 1 / 60);
    input.throttle = 0.6;
    input.throttle = 0; // 上げてすぐ 0 に戻した状態を1フレームで見る
    tutorial.update(ctx, 1 / 60);
    expect(tutorial.stepIndex).toBe(0);
  });
});

describe('T2-⑭ 6ステップを最後まで通せる', () => {
  it('案内どおりに操作すると簡易訓練が完走して帯が消える', () => {
    const { tutorial, world, player, ctx, input } = setup();
    tutorial.start('simple');
    expect(tutorial.stepCount).toBe(6);

    // 1: スロットルを上げる（1フレーム目は出撃時の値 50% を読むだけ）
    tutorial.update(ctx, 1 / 60);
    expect(tutorial.stepIndex).toBe(0);
    input.throttle = 0.6;
    tutorial.update(ctx, 1 / 60);
    expect(tutorial.stepIndex).toBe(1);

    // 2: 機首を振る（読む時間 2 秒を確保したうえで、実際に舵が入っていること）
    input.pitch = 1;
    for (let i = 0; i < 4; i++) tutorial.update(ctx, 1);
    input.pitch = 0;
    expect(tutorial.stepIndex).toBe(2);

    // 3: ターゲットを取る（ゲーム状態としてターゲットが入っていること）
    const enemy = spawnShip(world, {
      def: shipDef('dralthi'),
      faction: 'kilrathi',
      pos: new Vector3(0, 0, -900),
      speed: 0,
      label: 'ドゥル',
      pilot: 'ドゥル',
    });
    tutorial.update(ctx, 1 / 60);
    expect(tutorial.stepIndex).toBe(2);
    player.ship!.targetId = enemy.id;
    tutorial.update(ctx, 1 / 60);
    expect(tutorial.stepIndex).toBe(3);

    // 4: 主砲を撃つ
    for (let i = 0; i < 9; i++) fire(player, 'gun');
    tutorial.update(ctx, 2.1);
    expect(tutorial.stepIndex).toBe(4);

    // 5: ミサイルを撃つ
    fire(player, 'missile');
    tutorial.update(ctx, 3.1);
    expect(tutorial.stepIndex).toBe(5);

    // 6: オートパイロット
    tutorial.update(ctx, 2.1);
    expect(tutorial.stepIndex).toBe(5);
    (ctx as { autopilot: boolean }).autopilot = true;
    tutorial.update(ctx, 2.1);

    expect(tutorial.completed).toBe(true);
    expect(tutorial.active).toBe(false);
    expect(tutorial.visible).toBe(false);
    // 完走しただけで「訓練済み」を書き込まない（出撃の結果は App が決める）
    expect(settings.tutorialDone).toBe(false);
  });

  it('B キーで送っても最後で折り返さずに終わる', () => {
    const { tutorial, ctx } = setup();
    tutorial.start('simple');
    for (let i = 0; i < 5; i++) {
      dom.key('KeyB');
      // B で送った直後は条件判定を挟まない（ステップ番号だけが進む）
      expect(tutorial.stepIndex).toBe(i + 1);
    }
    dom.key('KeyB');
    expect(tutorial.completed).toBe(true);
    expect(tutorial.visible).toBe(false);
    // 終わった後の B は何もしない
    dom.key('KeyB');
    expect(tutorial.visible).toBe(false);
    // 進行中は必ず1ステップ分の案内が出ている
    void ctx;
  });
});

describe('T2-⑭ 出撃が終わったら訓練の表示を消す', () => {
  it('finish() で帯が消え、その後 update しても戻らない', () => {
    const { tutorial, ctx, input } = setup();
    tutorial.start('simple');
    expect(tutorial.visible).toBe(true);

    // Game が出撃終了時に呼ぶのと同じ形（`tutorialDone` は書き換えない）
    tutorial.finish(false);
    expect(tutorial.visible).toBe(false);
    expect(settings.tutorialDone).toBe(false);

    input.throttle = 0.9;
    tutorial.update(ctx, 1);
    dom.key('KeyB');
    expect(tutorial.visible).toBe(false);
    expect(tutorial.active).toBe(false);
  });

  it('もう一度出撃すれば最初のステップから出る', () => {
    const { tutorial } = setup();
    tutorial.start('simple');
    tutorial.finish(false);
    tutorial.start('simple');
    expect(tutorial.visible).toBe(true);
    expect(tutorial.stepIndex).toBe(0);
    expect(tutorial.throttleRaised).toBe(false);
  });
});
