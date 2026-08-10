import { Quaternion, Vector3 } from 'three';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InputManager } from '../../src/app/input';
import { resetSettings, settings, updateSettings } from '../../src/app/settings';
import { shipDef } from '../../src/content/ships';
import { newAi } from '../../src/sim/ai';
import { simulateStep } from '../../src/sim/step';
import { targetFront, targetNearest, targetNext } from '../../src/sim/targeting';
import { cycleMissile, dropFlare, fireMissile } from '../../src/sim/weapons';
import { keyChipLabel, TutorialDemo } from '../../src/ui/TutorialDemo';
import { spawnShip, World } from '../../src/world/world';
import { FakeElement, installFakeDom, type FakeDom } from './fake-dom';

/**
 * お手本モード（チュートリアル）。
 *
 * ここで固定したいのは3点。
 * 1. 実演は **人間と同じ入力経路** (`InputManager`) を通る。
 * 2. 画面に点灯するキーは、その経路へ渡した値そのものから作られる
 *    （「表示だけ動いていて実際は操作していない」を許さない）。
 * 3. 台本を流し終えたら代行入力が外れ、操縦が人間へ戻る。
 */

const DT = 1 / 60;

let dom: FakeDom;

function setup(o: { enemyAt?: Vector3 } = {}) {
  const container = new FakeElement('div');
  const demo = new TutorialDemo(container as unknown as HTMLElement);
  const input = new InputManager(new FakeElement('canvas') as unknown as HTMLElement);
  const world = new World();
  const player = spawnShip(world, {
    def: shipDef('hornet'),
    faction: 'confed',
    pos: new Vector3(),
    quat: new Quaternion(),
    speed: 0,
  });
  world.playerId = player.id;
  input.throttle = 0;

  let enemy;
  if (o.enemyAt) {
    enemy = spawnShip(world, {
      def: shipDef('kf03-greyhaul'),
      faction: 'kilrathi',
      pos: o.enemyAt.clone(),
      speed: 0,
      ai: newAi(0.2, { passive: true }),
    });
  }
  return { container, demo, input, world, player, enemy };
}

/**
 * 単発キーの処理。`Game.handleActions()` が本番で行っている分岐のうち、
 * お手本モードが押すものだけを同じ関数で再現する
 * （お手本が「押した」だけで完了扱いにせず、操作の結果まで進める）。
 */
function applyActions(world: World, input: InputManager): void {
  const player = world.player;
  if (!player) return;
  for (const a of input.consumeActions()) {
    if (a === 'targetNearest') targetNearest(world, player);
    else if (a === 'targetNext') targetNext(world, player);
    else if (a === 'targetFront') targetFront(world, player);
    else if (a === 'nextSecondary') cycleMissile(player);
    else if (a === 'fireMissile') fireMissile(world, player);
    else if (a === 'flare') dropFlare(world, player);
  }
}

/** 実演の1フレーム。実機と同じく「実演 → 単発キー処理 → シミュレーション」の順で回す。 */
function frame(
  demo: TutorialDemo,
  world: World,
  input: InputManager,
  locked = false,
): void {
  demo.update(world, input, DT, locked);
  applyActions(world, input);
  const player = world.player;
  if (player?.input) {
    player.input.pitch = input.pitch;
    player.input.yaw = input.yaw;
    player.input.roll = input.roll;
    player.input.throttle = input.throttle;
    player.input.afterburner = input.afterburner;
    player.input.firePrimary = input.firePrimary;
  }
  simulateStep(world, DT, { flightMode: 'wc', ai: {} });
}

/** 点灯しているキーのチップ文字列 */
function litKeys(container: FakeElement): string[] {
  return dom
    .findAll(container, 'key')
    .filter((el) => el.classNames().includes('on'))
    .map((el) => el.textContent);
}

/** 現在のステップ id になるまで B キーで送る (安全弁付き) */
function skipTo(demo: TutorialDemo, world: World, input: InputManager, id: string): void {
  for (let i = 0; i < demo.stepCount + 2 && demo.stepId !== id; i++) {
    dom.key('KeyB');
    frame(demo, world, input);
  }
  expect(demo.stepId).toBe(id);
}

beforeEach(() => {
  dom = installFakeDom();
  resetSettings();
});
afterEach(() => {
  dom.restore();
  resetSettings();
});

describe('お手本モード', () => {
  it('DEMO-01: 実演は InputManager 経由で操縦し、渡した値がそのまま点灯キーになる', () => {
    const { container, demo, input, world } = setup();
    demo.start();
    expect(demo.stepId).toBe('throttle-up');

    const before = input.throttle;
    for (let i = 0; i < 60; i++) frame(demo, world, input);

    // 代行入力が挿し込まれ、速度設定が上がっている
    expect(input.scripted).toBeDefined();
    expect(input.throttle).toBeGreaterThan(before);
    // 点灯キーは「速度設定+」。表示は割り当て (既定 `+`) から作る
    expect(litKeys(container)).toContain(keyChipLabel('throttleUp'));
    expect(keyChipLabel('throttleUp')).toContain('+');
    // 実際に機体が加速している (表示だけ動いていない)
    expect(world.player!.vel.length()).toBeGreaterThan(0);
    demo.stop(input);
  });

  it('DEMO-02: 機首の操作は実際に姿勢を変え、押しているキーが出る', () => {
    const { container, demo, input, world, player } = setup();
    demo.start();
    skipTo(demo, world, input, 'pitch');

    const before = player.quat.clone();
    for (let i = 0; i < 60; i++) frame(demo, world, input);

    expect(input.pitch).toBeGreaterThan(0.12);
    expect(litKeys(container)).toContain(keyChipLabel('pitchUp'));
    expect(player.quat.angleTo(before)).toBeGreaterThan(0.05);
    demo.stop(input);
  });

  it('DEMO-03: ドッグファイトは敵へ機首を向け、射程内で主砲を撃つ', () => {
    // 正面やや上に敵を置く。機首を上げて追う動きになる。
    const { demo, input, world, player } = setup({ enemyAt: new Vector3(0, 260, -1200) });
    demo.start();
    skipTo(demo, world, input, 'dogfight');

    const enemy = world.entities.find((e) => e.faction === 'kilrathi')!;
    let fired = 0;
    let steeredUp = false;
    let sawTarget = false;
    let hits = 0;
    const hullBefore = enemy.ship!.hull;
    for (let i = 0; i < 60 * 12; i++) {
      frame(demo, world, input);
      if (input.pitch > 0.1) steeredUp = true;
      if (input.firePrimary) fired += 1;
      if (player.ship!.targetId !== undefined) sawTarget = true;
      if (!enemy.alive || enemy.ship!.hull < hullBefore) hits += 1;
    }

    // R キー相当で敵を掴み、機首を上げて追い、射程内で撃ち、実際に当てている
    expect(sawTarget).toBe(true);
    expect(steeredUp).toBe(true);
    expect(fired).toBeGreaterThan(0);
    expect(hits).toBeGreaterThan(0);
    demo.stop(input);
  });

  it('DEMO-03b: 敵がまだ出ていない間はドッグファイトの実演を打ち切らない', () => {
    // 増援待ちで空域に敵が0機、という状況（訓練空域は出現に遅延がある）
    const { demo, input, world } = setup();
    demo.start();
    skipTo(demo, world, input, 'dogfight');

    for (let i = 0; i < 60 * 5; i++) frame(demo, world, input);
    expect(demo.sawHostiles).toBe(false);
    expect(demo.stepId).toBe('dogfight');

    // 敵が出て、全機落ちたら終える
    const enemy = spawnShip(world, {
      def: shipDef('kf03-greyhaul'),
      faction: 'kilrathi',
      pos: new Vector3(0, 0, -1500),
      speed: 0,
      ai: newAi(0.2, { passive: true }),
    });
    frame(demo, world, input);
    expect(demo.sawHostiles).toBe(true);
    enemy.alive = false;
    frame(demo, world, input);
    expect(demo.stepId).not.toBe('dogfight');
    demo.stop(input);
  });

  it('DEMO-03c: ミサイルの実演は敵がいない間は始めず、出てきてから実演する', () => {
    const { demo, input, world, player } = setup();
    demo.start();
    skipTo(demo, world, input, 'missile');

    // 敵がいない間は段が進まない (素通りして「お手本にならない」を防ぐ)
    for (let i = 0; i < 60 * 20; i++) frame(demo, world, input);
    expect(demo.stepId).toBe('missile');
    expect(input.firePrimary).toBe(false);

    // 敵が出たら実演を始め、ロックしてミサイルを撃つ
    spawnShip(world, {
      def: shipDef('kf03-greyhaul'),
      faction: 'kilrathi',
      pos: new Vector3(0, 0, -1800),
      speed: 0,
      ai: newAi(0.2, { passive: true }),
    });
    let missiles = 0;
    for (let i = 0; i < 60 * 20 && missiles === 0; i++) {
      frame(demo, world, input);
      missiles = world.entities.filter((e) => e.kind === 'missile').length;
    }
    expect(player.ship!.targetId).toBeDefined();
    expect(missiles).toBeGreaterThan(0);
    demo.stop(input);
  });

  it('DEMO-03d: 敵を待ち続けても実演は詰まらない (上限で先へ進む)', () => {
    const { demo, input, world } = setup();
    demo.start();
    skipTo(demo, world, input, 'flare');

    // 待ち上限 (50秒) + 段の秒数を足しても進む
    for (let i = 0; i < 60 * 70; i++) frame(demo, world, input);
    expect(demo.stepId).not.toBe('flare');
    demo.stop(input);
  });

  it('DEMO-04: 発艦演出中 (locked) は操縦を渡さず、台本も進めない', () => {
    const { demo, input, world } = setup();
    demo.start();
    for (let i = 0; i < 120; i++) frame(demo, world, input, true);

    expect(input.scripted).toBeUndefined();
    expect(demo.stepIndex).toBe(0);
    expect(input.throttle).toBe(0);
    demo.stop(input);
  });

  it('DEMO-05: 台本を流し終えると帯を畳み、操縦を人間へ返す', () => {
    const { demo, input, world } = setup();
    demo.start();
    // 全ステップを B キーで送り切る
    for (let i = 0; i < demo.stepCount + 2; i++) {
      dom.key('KeyB');
      frame(demo, world, input);
    }

    expect(demo.completed).toBe(true);
    expect(demo.active).toBe(false);
    expect(demo.visible).toBe(false);
    expect(input.scripted).toBeUndefined();
  });

  it('DEMO-06: キー表示は割り当て設定から作る (変更が反映される)', () => {
    expect(keyChipLabel('firePrimary')).toContain('Space');
    updateSettings({ keyBindings: { ...settings.keyBindings, firePrimary: 'KeyJ' } });
    expect(keyChipLabel('firePrimary')).toContain('J');
    expect(keyChipLabel('firePrimary')).not.toContain('Space');
  });
});
