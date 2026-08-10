import { Vector3 } from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import { shipDef } from '../../src/content/ships';
import {
  resolveProjectileHits,
  resolveShipCollisions,
  setCombatOptions,
  updateOrdnance,
} from '../../src/sim/combat';
import { fireGuns } from '../../src/sim/weapons';
import { spawnShip, World } from '../../src/world/world';
import type { Entity } from '../../src/world/entity';

/**
 * W2 「Easy では自機と非敵対勢力の接触ダメージを 0 にする」の単体テスト。
 * 07_テスト計画.md の w2 ケース①〜⑦に対応する。
 */

/** Easy 相当の戦闘オプション（味方接触は無傷） */
const EASY_OPTS = { playerDamageTaken: 0.55, playerDamageDealt: 1, friendlyCollisionDamage: 0 };
/** Normal / Hard 相当（従来どおり接触でダメージを受ける） */
const NORMAL_OPTS = { playerDamageTaken: 1, playerDamageDealt: 1, friendlyCollisionDamage: 1 };

afterEach(() => {
  // 他のテストへ設定を持ち越さないよう既定へ戻す
  setCombatOptions({ playerDamageTaken: 1, playerDamageDealt: 1, friendlyCollisionDamage: 1 });
});

function newWorld() {
  return new World();
}

function playerShip(world: World, pos = new Vector3()) {
  const e = spawnShip(world, { def: shipDef('hornet'), faction: 'confed', pos, speed: 0 });
  world.playerId = e.id;
  return e;
}

/** ハル + アーマー4面 + シールド2面の合計。1つでも減れば下がる。 */
function totalHealth(e: Entity): number {
  const s = e.ship!;
  return (
    s.hull +
    s.armor.front +
    s.armor.rear +
    s.armor.left +
    s.armor.right +
    s.shield.front +
    s.shield.rear
  );
}

/**
 * 2機を重なった位置に置き、相対速度 90 kps で接触させる。
 * `resolveShipCollisions` は重なりを見て 0.5 秒に1回ダメージを入れる。
 */
function stageContact(a: Entity, b: Entity): void {
  // 半径の合計より近づけて確実に重なるようにする
  b.pos.copy(a.pos).add(new Vector3(0, 0, -(a.radius + b.radius) * 0.5));
  a.vel.set(0, 0, -60);
  b.vel.set(0, 0, 30);
}

describe('W2 味方接触ダメージ', () => {
  it('① Easy: 自機 × 母艦（neutral・大半径）は双方無傷', () => {
    setCombatOptions(EASY_OPTS);
    const w = newWorld();
    const p = playerShip(w);
    const carrier = spawnShip(w, {
      def: shipDef('tigers-claw'),
      faction: 'neutral',
      pos: new Vector3(),
      speed: 0,
    });
    stageContact(p, carrier);
    const beforeP = totalHealth(p);
    const beforeC = totalHealth(carrier);

    resolveShipCollisions(w);

    expect(totalHealth(p)).toBe(beforeP);
    expect(totalHealth(carrier)).toBe(beforeC);
    expect(p.alive).toBe(true);
  });

  it('② Easy: 自機 × confed 輸送船も無傷', () => {
    setCombatOptions(EASY_OPTS);
    const w = newWorld();
    const p = playerShip(w);
    const transport = spawnShip(w, {
      def: shipDef('drayman'),
      faction: 'confed',
      pos: new Vector3(),
      speed: 0,
    });
    stageContact(p, transport);
    const beforeP = totalHealth(p);
    const beforeT = totalHealth(transport);

    resolveShipCollisions(w);

    expect(totalHealth(p)).toBe(beforeP);
    expect(totalHealth(transport)).toBe(beforeT);
  });

  it('② Easy: 自機 × 救難ポッド（neutral）も無傷', () => {
    setCombatOptions(EASY_OPTS);
    const w = newWorld();
    const p = playerShip(w);
    const pod = spawnShip(w, {
      def: shipDef('escape-pod'),
      faction: 'neutral',
      pos: new Vector3(),
      speed: 0,
    });
    stageContact(p, pod);
    const beforeP = totalHealth(p);
    const beforePod = totalHealth(pod);

    resolveShipCollisions(w);

    expect(totalHealth(p)).toBe(beforeP);
    expect(totalHealth(pod)).toBe(beforePod);
  });

  it('③ Easy: 自機 × キルラシー機は従来どおりダメージを受ける', () => {
    setCombatOptions(EASY_OPTS);
    const w = newWorld();
    const p = playerShip(w);
    const enemy = spawnShip(w, {
      def: shipDef('kf03-greyhaul'),
      faction: 'kilrathi',
      pos: new Vector3(),
      speed: 0,
    });
    stageContact(p, enemy);
    const beforeP = totalHealth(p);
    const beforeE = totalHealth(enemy);

    resolveShipCollisions(w);

    expect(totalHealth(p)).toBeLessThan(beforeP);
    expect(totalHealth(enemy)).toBeLessThan(beforeE);
  });

  it('④ Easy: AI × AI（confed × neutral）は自機が当事者でないので従来どおり', () => {
    setCombatOptions(EASY_OPTS);
    const w = newWorld();
    // 自機は遠くに置く（当事者にならない）
    playerShip(w, new Vector3(0, 0, 50000));
    const wingman = spawnShip(w, {
      def: shipDef('hornet'),
      faction: 'confed',
      pos: new Vector3(),
      speed: 0,
    });
    const carrier = spawnShip(w, {
      def: shipDef('tigers-claw'),
      faction: 'neutral',
      pos: new Vector3(),
      speed: 0,
    });
    stageContact(wingman, carrier);
    const beforeW = totalHealth(wingman);
    const beforeC = totalHealth(carrier);

    resolveShipCollisions(w);

    expect(totalHealth(wingman)).toBeLessThan(beforeW);
    expect(totalHealth(carrier)).toBeLessThan(beforeC);
  });

  it('⑤ Normal / Hard: 自機 × 母艦はダメージを受ける', () => {
    setCombatOptions(NORMAL_OPTS);
    const w = newWorld();
    const p = playerShip(w);
    const carrier = spawnShip(w, {
      def: shipDef('tigers-claw'),
      faction: 'neutral',
      pos: new Vector3(),
      speed: 0,
    });
    stageContact(p, carrier);
    const beforeP = totalHealth(p);

    resolveShipCollisions(w);

    // 質量比は上限 14 に張り付くので、1回の接触で致命傷級になる（従来どおり）
    expect(totalHealth(p)).toBeLessThan(beforeP);
  });

  it('⑤ Easy でも母艦接触は「免除が無ければ」痛い（免除の効果量を確認）', () => {
    const w = newWorld();
    const p = playerShip(w);
    const carrier = spawnShip(w, {
      def: shipDef('tigers-claw'),
      faction: 'neutral',
      pos: new Vector3(),
      speed: 0,
    });

    // 免除なしの Easy（playerDamageTaken だけ 0.55）
    setCombatOptions({ ...EASY_OPTS, friendlyCollisionDamage: 1 });
    stageContact(p, carrier);
    const before = totalHealth(p);
    resolveShipCollisions(w);
    const withoutExemption = before - totalHealth(p);
    expect(withoutExemption).toBeGreaterThan(50);

    // 免除あり: 同じ条件でまったく減らない
    const w2 = newWorld();
    const p2 = playerShip(w2);
    const carrier2 = spawnShip(w2, {
      def: shipDef('tigers-claw'),
      faction: 'neutral',
      pos: new Vector3(),
      speed: 0,
    });
    setCombatOptions(EASY_OPTS);
    stageContact(p2, carrier2);
    const before2 = totalHealth(p2);
    resolveShipCollisions(w2);
    expect(before2 - totalHealth(p2)).toBe(0);
  });

  it('⑥ Easy の免除時でも押し戻しが働く', () => {
    setCombatOptions(EASY_OPTS);
    const w = newWorld();
    const p = playerShip(w);
    const carrier = spawnShip(w, {
      def: shipDef('tigers-claw'),
      faction: 'neutral',
      pos: new Vector3(),
      speed: 0,
    });
    stageContact(p, carrier);
    const before = p.pos.distanceTo(carrier.pos);

    resolveShipCollisions(w);

    const after = p.pos.distanceTo(carrier.pos);
    expect(after).toBeGreaterThan(before);
  });

  it('⑦ 誤射（弾の被弾）には影響しない', () => {
    setCombatOptions(EASY_OPTS);
    const w = newWorld();
    const p = playerShip(w);
    const transport = spawnShip(w, {
      def: shipDef('drayman'),
      faction: 'confed',
      pos: new Vector3(0, 0, -300),
      speed: 0,
    });
    const before = totalHealth(transport);

    p.input!.firePrimary = true;
    fireGuns(w, p, 1 / 60);
    for (let i = 0; i < 60; i++) {
      updateOrdnance(w, 1 / 60);
      resolveProjectileHits(w);
      w.compact();
    }

    expect(totalHealth(transport)).toBeLessThan(before);
  });
});
