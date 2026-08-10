import { Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { shipDef } from '../../src/content/ships';
import { missileDef } from '../../src/content/weapons';
import { eject } from '../../src/sim/eject';
import { simulateStep } from '../../src/sim/step';
import { setTarget } from '../../src/sim/targeting';
import { cycleMissile, fireMissile, updateMissileLock } from '../../src/sim/weapons';
import { spawnShip, World } from '../../src/world/world';
import type { Entity } from '../../src/world/entity';

const DT = 1 / 60;
/** ラピアーの副兵装スロット: 0 = ダムファイア (無誘導) / 1 = ヒートシーカー (誘導) */
const SLOT_DUMBFIRE = 0;
const SLOT_GUIDED = 1;

function playerShip(world: World): Entity {
  const player = spawnShip(world, {
    def: shipDef('rapier'),
    faction: 'confed',
    pos: new Vector3(),
    quat: new Quaternion(),
    speed: 0,
  });
  world.playerId = player.id;
  return player;
}

/** 機首正面 (-Z) の射程内に敵を置き、誘導ミサイルを選択した状態にする */
function guidedSetup(distance = 1500): { world: World; player: Entity; target: Entity } {
  const world = new World();
  const player = playerShip(world);
  const target = spawnShip(world, {
    def: shipDef('kf03-greyhaul'),
    faction: 'kilrathi',
    pos: new Vector3(0, 0, -distance),
    speed: 0,
  });
  player.ship!.activeMissile = SLOT_GUIDED;
  setTarget(player, target);
  return { world, player, target };
}

/** 誘導ミサイルのロック所要時間ぶんのステップ数 (数値を写さず定義から作る) */
function lockSteps(missileId = 'heat-seeker'): number {
  return Math.ceil(missileDef(missileId).lockTime / DT) + 2;
}

describe('W7-3 手動ミサイルロック', () => {
  it('① manual では L 未押下でロックが進まない', () => {
    const { world, player } = guidedSetup();
    const ship = player.ship!;
    expect(ship.lockArmed).toBe(false);

    for (let i = 0; i < lockSteps(); i++) updateMissileLock(world, player, DT, true);

    expect(ship.lockProgress).toBe(0);
    expect(ship.lockedId).toBeUndefined();

    // 同じ配置で自動ロックなら完了する (配置が原因でないことの確認)
    for (let i = 0; i < lockSteps(); i++) updateMissileLock(world, player, DT, false);
    expect(ship.lockProgress).toBe(1);
  });

  it('② lockArmed なら lockTime でロックが完了する', () => {
    const { world, player, target } = guidedSetup();
    const ship = player.ship!;
    ship.lockArmed = true;

    const def = missileDef('heat-seeker');
    // lockTime 直前は未完了
    const before = Math.floor(def.lockTime / DT) - 1;
    for (let i = 0; i < before; i++) updateMissileLock(world, player, DT, true);
    expect(ship.lockProgress).toBeLessThan(1);
    expect(ship.lockedId).toBeUndefined();

    for (let i = 0; i < 3; i++) updateMissileLock(world, player, DT, true);
    expect(ship.lockProgress).toBe(1);
    expect(ship.lockedId).toBe(target.id);
    expect(ship.lockArmed).toBe(true);
  });

  it('③ 視野外へ出ると lockArmed が落ちてロックが減衰する', () => {
    const { world, player, target } = guidedSetup();
    const ship = player.ship!;
    ship.lockArmed = true;

    const half = Math.floor(missileDef('heat-seeker').lockTime / DT / 2);
    for (let i = 0; i < half; i++) updateMissileLock(world, player, DT, true);
    const progress = ship.lockProgress;
    expect(progress).toBeGreaterThan(0);

    // 機体後方へ回り込ませる (視野外)
    target.pos.set(0, 0, 1500);
    updateMissileLock(world, player, DT, true);
    expect(ship.lockArmed).toBe(false);
    expect(ship.lockProgress).toBeLessThan(progress);

    // 正面に戻っても L を押し直すまで進まない
    target.pos.set(0, 0, -1500);
    const decayed = ship.lockProgress;
    for (let i = 0; i < 10; i++) updateMissileLock(world, player, DT, true);
    expect(ship.lockProgress).toBeLessThanOrEqual(decayed);
  });

  it('④ 目標変更・副兵装切替・発射・脱出で lockArmed が落ちる', () => {
    // 目標変更
    {
      const { world, player } = guidedSetup();
      const other = spawnShip(world, {
        def: shipDef('kf03-greyhaul'),
        faction: 'kilrathi',
        pos: new Vector3(200, 0, -1200),
        speed: 0,
      });
      player.ship!.lockArmed = true;
      setTarget(player, other);
      expect(player.ship!.lockArmed).toBe(false);
    }

    // 副兵装切替
    {
      const { player } = guidedSetup();
      player.ship!.lockArmed = true;
      cycleMissile(player);
      expect(player.ship!.lockArmed).toBe(false);
    }

    // 発射 (ロック済みの誘導ミサイル)
    {
      const { world, player } = guidedSetup();
      const ship = player.ship!;
      ship.lockArmed = true;
      for (let i = 0; i < lockSteps(); i++) updateMissileLock(world, player, DT, true);
      expect(ship.lockedId).toBeDefined();
      expect(fireMissile(world, player).fired).toBe(true);
      expect(ship.lockArmed).toBe(false);
      expect(ship.lockProgress).toBe(0);
    }

    // 脱出
    {
      const { world, player } = guidedSetup();
      player.ship!.lockArmed = true;
      eject(world, player);
      expect(player.ship!.lockArmed).toBe(false);
    }

    // 目標が消えた場合 (副兵装スロットが無くなる経路も含めて解除される)
    {
      const { world, player } = guidedSetup();
      const ship = player.ship!;
      ship.lockArmed = true;
      ship.missiles.forEach((m) => (m.count = 0));
      updateMissileLock(world, player, DT, true);
      expect(ship.lockArmed).toBe(false);
    }
  });

  it('⑤ 無誘導は manual でも常時ロック済み', () => {
    const { world, player, target } = guidedSetup();
    const ship = player.ship!;
    ship.activeMissile = SLOT_DUMBFIRE;
    expect(missileDef(ship.missiles[SLOT_DUMBFIRE].missileId).seeker).toBe('none');
    expect(ship.lockArmed).toBe(false);

    updateMissileLock(world, player, DT, true);
    expect(ship.lockProgress).toBe(1);
    expect(ship.lockedId).toBe(target.id);
    expect(fireMissile(world, player).fired).toBe(true);
  });

  it('⑥ simulateStep の手動ロックはプレイヤーだけに掛かり、AI は従来どおりロックできる', () => {
    const world = new World();
    const player = playerShip(world);
    // 敵はプレイヤーを向かい合わせに置く (互いに射程・視野内)
    const enemy = spawnShip(world, {
      def: shipDef('rapier'),
      faction: 'kilrathi',
      pos: new Vector3(0, 0, -1500),
      quat: new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI),
      speed: 0,
    });
    player.ship!.activeMissile = SLOT_GUIDED;
    enemy.ship!.activeMissile = SLOT_GUIDED;
    setTarget(player, enemy);
    setTarget(enemy, player);

    for (let i = 0; i < lockSteps(); i++) {
      simulateStep(world, DT, {
        flightMode: 'wc',
        ai: {},
        playerManualMissileLock: true,
      });
    }

    // プレイヤーは L 未押下なのでロックが進まない
    expect(player.ship!.lockProgress).toBe(0);
    expect(player.ship!.lockedId).toBeUndefined();
    // AI には manual が渡らないので従来どおりロックできる
    expect(enemy.ship!.lockProgress).toBe(1);
    expect(enemy.ship!.lockedId).toBe(player.id);
  });
});
