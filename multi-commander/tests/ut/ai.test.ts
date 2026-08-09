import { Quaternion, Vector3 } from 'three';
import { beforeEach, describe, expect, it } from 'vitest';
import { reseed } from '../../src/core/rng';
import { DIFFICULTIES } from '../../src/app/settings';
import { shipDef } from '../../src/content/ships';
import { newAi } from '../../src/sim/ai';
import { setCombatOptions } from '../../src/sim/combat';
import { simulateStep } from '../../src/sim/step';
import { spawnShip, World } from '../../src/world/world';
import type { Entity } from '../../src/world/entity';

const DT = 1 / 60;

// AI の揺らぎは共有乱数なので、テストごとに種を固定して再現性を確保する
beforeEach(() => reseed(0x51ed5eed));

function facing(from: Vector3, to: Vector3): Quaternion {
  const dir = to.clone().sub(from).normalize();
  return new Quaternion().setFromUnitVectors(new Vector3(0, 0, -1), dir);
}

interface DuelResult {
  seconds: number;
  /** 残存耐久の実数 */
  aHp: number;
  bHp: number;
  aAlive: boolean;
  bAlive: boolean;
  /** どちらかが1発でも当てたか */
  anyDamage: boolean;
  /** 残存耐久の割合 (0..1) */
  aLeft: number;
  bLeft: number;
  /** 戦闘中に記録した耐久の最低値 (シールド再生で戻る分を見逃さない) */
  aMin: number;
  bMin: number;
  decided: boolean;
}

function totalHp(e: Entity): number {
  const s = e.ship!;
  return (
    s.hull + s.armor.front + s.armor.rear + s.armor.left + s.armor.right +
    s.shield.front + s.shield.rear
  );
}

function duel(
  aId: string,
  bId: string,
  aSkill: number,
  bSkill: number,
  maxSeconds = 120,
  separation = 2500,
): DuelResult {
  setCombatOptions({ playerDamageTaken: 1, playerDamageDealt: 1 });
  const world = new World();
  const aPos = new Vector3(0, 0, 0);
  const bPos = new Vector3(0, 0, -separation);
  const a = spawnShip(world, {
    def: shipDef(aId),
    faction: 'confed',
    pos: aPos,
    quat: facing(aPos, bPos),
    speed: 200,
    ai: newAi(aSkill),
  });
  const b = spawnShip(world, {
    def: shipDef(bId),
    faction: 'kilrathi',
    pos: bPos,
    quat: facing(bPos, aPos),
    speed: 200,
    ai: newAi(bSkill),
  });
  const aFull = totalHp(a);
  const bFull = totalHp(b);

  const steps = Math.round(maxSeconds / DT);
  let aMin = 1;
  let bMin = 1;
  for (let i = 0; i < steps; i++) {
    simulateStep(world, DT, { flightMode: 'wc', ai: { maxAttackersOnPlayer: 4 } });
    if (a.alive) aMin = Math.min(aMin, totalHp(a) / aFull);
    if (b.alive) bMin = Math.min(bMin, totalHp(b) / bFull);
    if (!a.alive || !b.alive) {
      return {
        seconds: i * DT,
        aAlive: a.alive,
        bAlive: b.alive,
        anyDamage: true,
        aLeft: a.alive ? totalHp(a) / aFull : 0,
        bLeft: b.alive ? totalHp(b) / bFull : 0,
        aMin: a.alive ? aMin : 0,
        bMin: b.alive ? bMin : 0,
        aHp: a.alive ? totalHp(a) : 0,
        bHp: b.alive ? totalHp(b) : 0,
        decided: true,
      };
    }
  }
  return {
    seconds: maxSeconds,
    aAlive: true,
    bAlive: true,
    anyDamage: aMin < 0.999 || bMin < 0.999,
    aLeft: totalHp(a) / aFull,
    bLeft: totalHp(b) / bFull,
    aMin,
    bMin,
    aHp: totalHp(a),
    bHp: totalHp(b),
    decided: false,
  };
}

describe('AI ドッグファイト', () => {
  // 設計方針: 同技量の AI 同士は決着しにくい。
  // 命中は「近距離で正面に捉えた瞬間」に限られるため、
  // 照準の上手いプレイヤーが戦局を決める役割を担う。
  it('同型同技量の 1v1 では互いに被弾しつつ、決着は付きにくい', () => {
    let anyHit = 0;
    for (let i = 0; i < 4; i++) {
      const r = duel('rapier', 'rapier', 0.6, 0.6, 120, 2200 + i * 260);
      if (r.anyDamage) anyHit++;
      if (r.decided) expect(r.seconds).toBeGreaterThan(3); // 一撃で消し飛ばない
    }
    expect(anyHit).toBeGreaterThanOrEqual(3);
  });

  it('技量差が大きければ低技量側が押される', () => {
    let highBetter = 0;
    const rounds = 7;
    for (let i = 0; i < rounds; i++) {
      const r = duel('kf03-greyhaul', 'kf03-greyhaul', 0.1, 0.95, 90, 1600 + i * 220);
      // 残存でも最低値でも、高技量側が有利であること
      if (r.bMin > r.aMin || (r.bAlive && !r.aAlive)) highBetter++;
    }
    expect(highBetter).toBeGreaterThanOrEqual(5);
  });

  // 機体ごとの癖 (drift / turnSpeedPenalty) を入れた結果、
  // 軽戦闘機は旋回戦で有利になり「残存率」では重戦闘機を上回る。
  // 重戦闘機の強みは残存率ではなく「絶対的な耐久量と火力」なので、そこを検証する。
  it('重戦闘機は軽戦闘機より多くの耐久を残して戦い続けられる', () => {
    let heavyTougher = 0;
    for (let i = 0; i < 5; i++) {
      const r = duel('ke04-mirage', 'kb02-bastion', 0.7, 0.7, 120, 1800 + i * 300);
      if (r.bHp >= r.aHp) heavyTougher++;
    }
    expect(heavyTougher).toBeGreaterThanOrEqual(4);
  });

  it('軽戦闘機は重戦闘機より旋回性能を高く保てる (機体の癖)', () => {
    const light = shipDef('ke04-mirage');
    const heavy = shipDef('kb02-bastion');
    // 最高速付近で失う旋回性能
    expect(light.handling.turnSpeedPenalty).toBeLessThan(heavy.handling.turnSpeedPenalty);
    // 旋回時に速度が流れる度合い
    expect(light.handling.drift).toBeLessThan(heavy.handling.drift);
  });

  it('遠距離では損害がほとんど出ず、接近戦で初めて削り合う', () => {
    // 離れて撃ち合っている間はほぼ当たらない
    const far = duel('kf03-greyhaul', 'kf03-greyhaul', 0.5, 0.5, 10, 9000);
    expect(Math.min(far.aMin, far.bMin)).toBeGreaterThan(0.9);
    // 近距離から始めればいずれ当たる
    const close = duel('kf03-greyhaul', 'kf03-greyhaul', 0.7, 0.7, 90, 900);
    expect(close.anyDamage).toBe(true);
  });

  it('AI は味方を撃たない (同陣営 2 機で放置しても無傷)', () => {
    const world = new World();
    const a = spawnShip(world, {
      def: shipDef('hornet'),
      faction: 'confed',
      pos: new Vector3(0, 0, 0),
      speed: 200,
      ai: newAi(0.8),
    });
    const b = spawnShip(world, {
      def: shipDef('hornet'),
      faction: 'confed',
      pos: new Vector3(0, 0, -600),
      speed: 200,
      ai: newAi(0.8),
    });
    for (let i = 0; i < 60 * 30; i++) {
      simulateStep(world, DT, { flightMode: 'wc', ai: {} });
    }
    expect(a.ship!.hull).toBe(a.ship!.def.hull);
    expect(b.ship!.hull).toBe(b.ship!.def.hull);
  });

  it('大きく損傷した機体は士気が下がって離脱モードに入る', () => {
    const world = new World();
    const prey = spawnShip(world, {
      def: shipDef('ke04-mirage'),
      faction: 'kilrathi',
      pos: new Vector3(0, 0, -900),
      speed: 200,
      ai: newAi(0.5),
    });
    prey.ship!.hull = prey.ship!.def.hull * 0.15;
    let fled = false;
    for (let i = 0; i < 60 * 25; i++) {
      simulateStep(world, DT, { flightMode: 'wc', ai: {} });
      if (prey.ai!.mode === 'flee') {
        fled = true;
        break;
      }
    }
    expect(fled).toBe(true);
    expect(prey.ai!.morale).toBeLessThan(0.05);
  });

  it('撃たれなくなった離脱機は立て直して再交戦する', () => {
    const world = new World();
    const prey = spawnShip(world, {
      def: shipDef('kf01-leonfang'),
      faction: 'kilrathi',
      pos: new Vector3(0, 0, -900),
      speed: 200,
      ai: newAi(0.6),
    });
    prey.ship!.hull = prey.ship!.def.hull * 0.2;
    // まず離脱状態にする
    for (let i = 0; i < 60 * 20 && prey.ai!.mode !== 'flee'; i++) {
      simulateStep(world, DT, { flightMode: 'wc', ai: {} });
    }
    expect(prey.ai!.mode).toBe('flee');
    // 敵が現れないまま時間が経てば士気が戻る
    for (let i = 0; i < 60 * 10; i++) {
      simulateStep(world, DT, { flightMode: 'wc', ai: {} });
    }
    expect(prey.ai!.morale).toBeGreaterThan(0.2);
  });

  it('無傷の機体は数の不利だけでは逃げない', () => {
    const world = new World();
    const lone = spawnShip(world, {
      def: shipDef('rapier'),
      faction: 'confed',
      pos: new Vector3(0, 0, 0),
      speed: 200,
      ai: newAi(0.6),
    });
    for (let i = 0; i < 4; i++) {
      spawnShip(world, {
        def: shipDef('kf03-greyhaul'),
        faction: 'kilrathi',
        pos: new Vector3(-400 + i * 260, 0, -3000),
        speed: 200,
        ai: newAi(0.1),
      });
    }
    for (let i = 0; i < 60 * 6; i++) {
      simulateStep(world, DT, { flightMode: 'wc', ai: {} });
      // 無傷のうちは離脱しない
      if (lone.ship!.hull === lone.ship!.def.hull) {
        expect(lone.ai!.mode).not.toBe('flee');
      }
    }
  });
});

describe('僚機の編隊飛行', () => {
  it('form 指令の僚機はリーダーの近くに留まる', () => {
    const world = new World();
    const leader = spawnShip(world, {
      def: shipDef('rapier'),
      faction: 'confed',
      pos: new Vector3(0, 0, 0),
      speed: 250,
    });
    world.playerId = leader.id;
    leader.input!.throttle = 0.6;
    const wing = spawnShip(world, {
      def: shipDef('hornet'),
      faction: 'confed',
      pos: new Vector3(600, 200, 900),
      speed: 200,
      ai: newAi(0.7, { leaderId: leader.id, order: 'form' }),
    });
    for (let i = 0; i < 60 * 40; i++) {
      simulateStep(world, DT, { flightMode: 'wc', ai: {} });
    }
    const d = wing.pos.distanceTo(leader.pos);
    expect(d).toBeLessThan(520);
  });
});

describe('難易度プロファイル', () => {
  it('やさしい→むずかしい で敵技量が上がり被ダメが増える', () => {
    const ids = ['easy', 'normal', 'hard'] as const;
    for (let i = 1; i < ids.length; i++) {
      const prev = DIFFICULTIES[ids[i - 1]];
      const cur = DIFFICULTIES[ids[i]];
      expect(cur.enemySkill).toBeGreaterThan(prev.enemySkill);
      expect(cur.playerDamageTaken).toBeGreaterThan(prev.playerDamageTaken);
      expect(cur.maxAttackers).toBeGreaterThanOrEqual(prev.maxAttackers);
    }
  });

  it('やさしいは同時攻撃 1 機まで', () => {
    expect(DIFFICULTIES.easy.maxAttackers).toBe(1);
  });
});

describe('衝突回避', () => {
  it('編隊飛行中の僚機はリーダーに衝突しない', () => {
    const world = new World();
    const leader = spawnShip(world, {
      def: shipDef('rapier'),
      faction: 'confed',
      pos: new Vector3(0, 0, 0),
      speed: 0,
    });
    world.playerId = leader.id;
    leader.input!.throttle = 0;
    const wing = spawnShip(world, {
      def: shipDef('hornet'),
      faction: 'confed',
      pos: new Vector3(90, -14, 110),
      speed: 120,
      ai: newAi(0.7, { leaderId: leader.id, order: 'form' }),
    });
    const minSafe = leader.radius + wing.radius;
    let closest = Infinity;
    for (let i = 0; i < 60 * 60; i++) {
      simulateStep(world, DT, { flightMode: 'wc', ai: {} });
      closest = Math.min(closest, wing.pos.distanceTo(leader.pos));
    }
    expect(leader.ship!.hull).toBe(leader.ship!.def.hull);
    expect(closest).toBeGreaterThan(minSafe);
  });

  it('正面から接近する2機は衝突せずすれ違う', () => {
    const world = new World();
    const aPos = new Vector3(0, 0, 0);
    const bPos = new Vector3(0, 0, -3000);
    const a = spawnShip(world, {
      def: shipDef('rapier'),
      faction: 'confed',
      pos: aPos,
      quat: facing(aPos, bPos),
      speed: 400,
      ai: newAi(0.6),
    });
    const b = spawnShip(world, {
      def: shipDef('rapier'),
      faction: 'kilrathi',
      pos: bPos,
      quat: facing(bPos, aPos),
      speed: 400,
      ai: newAi(0.6),
    });
    // 最初のすれ違いまでを見る
    let closest = Infinity;
    for (let i = 0; i < 60 * 10; i++) {
      simulateStep(world, DT, { flightMode: 'wc', ai: { maxAttackersOnPlayer: 4 } });
      if (!a.alive || !b.alive) break;
      closest = Math.min(closest, a.pos.distanceTo(b.pos));
    }
    expect(a.alive).toBe(true);
    expect(b.alive).toBe(true);
    expect(closest).toBeGreaterThan(a.radius + b.radius);
  });
});
