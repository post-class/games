import { Vector3 } from 'three';
import { beforeEach, describe, expect, it } from 'vitest';
import { shipDef } from '../src/content/ships';
import { reseed } from '../src/core/rng';
import { setCombatOptions } from '../src/sim/combat';
import { applyDamage } from '../src/sim/damage';
import { updateFlight, updateShipPower } from '../src/sim/flight';
import {
  afterburnerAvailable,
  commsAvailable,
  engineOutput,
  gunOperational,
  hasDamage,
  newSubsystems,
  radarQuality,
  repairAll,
  rollSubsystemDamage,
  stateOf,
  SUBSYSTEMS,
  thrusterOutput,
} from '../src/sim/subsystems';
import { fireGuns } from '../src/sim/weapons';
import { spawnShip, World } from '../src/world/world';
import type { Entity } from '../src/world/entity';

beforeEach(() => {
  reseed(0x51b5e7a4);
  setCombatOptions({ playerDamageTaken: 1, playerDamageDealt: 1 });
});

function fighter(id = 'rapier'): { world: World; e: Entity } {
  const world = new World();
  const e = spawnShip(world, {
    def: shipDef(id),
    faction: 'confed',
    pos: new Vector3(),
    speed: 0,
  });
  world.playerId = e.id;
  return { world, e };
}

describe('サブシステムの初期状態', () => {
  it('戦闘機は全部位が正常で生成される', () => {
    const { e } = fighter();
    expect(e.ship!.subsystems).toBeDefined();
    for (const info of SUBSYSTEMS) {
      expect(stateOf(e.ship, info.id)).toBe('ok');
    }
    expect(hasDamage(e.ship)).toBe(false);
  });

  it('輸送艦・艦艇は部位損傷を持たない', () => {
    const { e: t } = fighter('drayman');
    const { e: c } = fighter('tigers-claw');
    expect(t.ship!.subsystems).toBeUndefined();
    expect(c.ship!.subsystems).toBeUndefined();
    // 参照しても既定値 (正常) が返る
    expect(stateOf(t.ship, 'radar')).toBe('ok');
    expect(radarQuality(t.ship)).toBe(1);
  });
});

describe('故障の判定', () => {
  it('ハルに通らなければ何も壊れない', () => {
    const { e } = fighter();
    for (let i = 0; i < 200; i++) {
      expect(rollSubsystemDamage(e, 0, 'front')).toBeUndefined();
    }
    expect(hasDamage(e.ship)).toBe(false);
  });

  it('ハルダメージを重ねるといずれ壊れる', () => {
    const { e } = fighter();
    let broke: string | undefined;
    for (let i = 0; i < 60 && !broke; i++) {
      broke = rollSubsystemDamage(e, 12, 'front');
    }
    expect(broke).toBeDefined();
    expect(hasDamage(e.ship)).toBe(true);
  });

  it('同じ部位を2度壊すと損失になる', () => {
    const { e } = fighter();
    e.ship!.subsystems = newSubsystems();
    e.ship!.subsystems.radar = 'damaged';
    // 前面被弾はレーダーが壊れやすいので、繰り返せば dead になる
    for (let i = 0; i < 120 && stateOf(e.ship, 'radar') !== 'dead'; i++) {
      rollSubsystemDamage(e, 30, 'front');
    }
    expect(stateOf(e.ship, 'radar')).toBe('dead');
  });

  it('被弾面によって壊れる砲が偏る', () => {
    let leftHits = 0;
    let rightHits = 0;
    for (let round = 0; round < 40; round++) {
      const { e } = fighter();
      for (let i = 0; i < 12; i++) rollSubsystemDamage(e, 20, 'left');
      if (stateOf(e.ship, 'gunsLeft') !== 'ok') leftHits++;
      if (stateOf(e.ship, 'gunsRight') !== 'ok') rightHits++;
    }
    // 左から撃たれたのだから左舷砲の方が壊れている
    expect(leftHits).toBeGreaterThan(rightHits);
  });

  it('修理で全部位が正常に戻る', () => {
    const { e } = fighter();
    for (let i = 0; i < 40; i++) rollSubsystemDamage(e, 25, 'front');
    expect(hasDamage(e.ship)).toBe(true);
    repairAll(e.ship!);
    expect(hasDamage(e.ship)).toBe(false);
  });
});

describe('故障の効果', () => {
  it('レーダー損失で探知できなくなる', () => {
    const { e } = fighter();
    expect(radarQuality(e.ship)).toBe(1);
    e.ship!.subsystems!.radar = 'damaged';
    expect(radarQuality(e.ship)).toBeGreaterThan(0);
    expect(radarQuality(e.ship)).toBeLessThan(1);
    e.ship!.subsystems!.radar = 'dead';
    expect(radarQuality(e.ship)).toBe(0);
  });

  it('エンジン損失で最高速が落ち、アフターバーナーが使えない', () => {
    const { e } = fighter();
    expect(afterburnerAvailable(e.ship)).toBe(true);
    e.ship!.subsystems!.engine = 'dead';
    expect(afterburnerAvailable(e.ship)).toBe(false);
    expect(engineOutput(e.ship)).toBeLessThan(1);

    e.input!.throttle = 1;
    for (let i = 0; i < 600; i++) updateFlight(e, 1 / 60, 'wc');
    // 出力倍率の分だけ最高速が下がる
    expect(e.vel.length()).toBeCloseTo(e.ship!.def.maxSpeed * engineOutput(e.ship), 0);
  });

  it('姿勢制御損失で旋回が鈍る', () => {
    const measure = (state: 'ok' | 'dead') => {
      const { e } = fighter();
      e.ship!.subsystems!.thrusters = state;
      e.input!.throttle = 0.5;
      e.input!.pitch = 1;
      for (let i = 0; i < 60; i++) updateFlight(e, 1 / 60, 'wc');
      return Math.abs(e.angVel.x);
    };
    expect(thrusterOutput(undefined)).toBe(1);
    expect(measure('dead')).toBeLessThan(measure('ok') * 0.8);
  });

  it('シールド発生器損失で再生が止まる', () => {
    const { e } = fighter();
    e.ship!.shield.front = 0;
    e.ship!.subsystems!.shieldGen = 'dead';
    for (let i = 0; i < 60 * 20; i++) updateShipPower(e, 1 / 60);
    expect(e.ship!.shield.front).toBe(0);
  });

  it('片舷の砲が損失すると弾数が半分になる', () => {
    const { world, e } = fighter('rapier');
    // rapier は左右2門ずつ
    e.ship!.subsystems!.gunsLeft = 'dead';
    e.input!.firePrimary = true;
    fireGuns(world, e, 1 / 60);
    const fired = world.count('projectile');
    expect(fired).toBe(2);
    expect(gunOperational(e.ship, -3)).toBe(false);
    expect(gunOperational(e.ship, 3)).toBe(true);
  });

  it('両舷の砲が損失すると撃てない', () => {
    const { world, e } = fighter('rapier');
    e.ship!.subsystems!.gunsLeft = 'dead';
    e.ship!.subsystems!.gunsRight = 'dead';
    e.input!.firePrimary = true;
    fireGuns(world, e, 1 / 60);
    expect(world.count('projectile')).toBe(0);
  });

  it('通信機損失で僚機へ指示できない', () => {
    const { e } = fighter();
    expect(commsAvailable(e.ship)).toBe(true);
    e.ship!.subsystems!.comms = 'dead';
    expect(commsAvailable(e.ship)).toBe(false);
  });
});

describe('被弾からの一連の流れ', () => {
  it('装甲を抜けてハルに通ると故障判定が走る', () => {
    const { e } = fighter();
    const def = e.ship!.def;
    // 前面のシールドと装甲を抜く量を1発で入れる
    const total = def.shield.front + def.armor.front + 40;
    const res = applyDamage(e, total, new Vector3(0, 0, -20));
    expect(res.hullDamage).toBeGreaterThan(0);
    let broke = false;
    for (let i = 0; i < 30 && !broke; i++) {
      broke = !!rollSubsystemDamage(e, res.hullDamage, res.armorFace);
    }
    expect(broke).toBe(true);
  });
});
