import { Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { shipDef } from '../src/content/ships';
import { isHostile } from '../src/content/factions';
import { pointOnSegment, spheresOverlap, sweepSphere } from '../src/sim/collision';
import { applyDamage, hitFaces, healthRatios } from '../src/sim/damage';
import { updateFlight, updateShipPower } from '../src/sim/flight';
import { spawnShip, World } from '../src/world/world';
import { resolveProjectileHits, updateOrdnance } from '../src/sim/combat';
import { fireGuns, activeMissileSlot, cycleMissile } from '../src/sim/weapons';

function newWorld() {
  return new World();
}

function playerShip(world: World, id = 'rapier', pos = new Vector3()) {
  const e = spawnShip(world, { def: shipDef(id), faction: 'confed', pos, speed: 0 });
  world.playerId = e.id;
  return e;
}

describe('スイープ衝突', () => {
  it('球を通り抜ける線分は交差する', () => {
    const t = sweepSphere(new Vector3(0, 0, 100), new Vector3(0, 0, -100), new Vector3(), 10);
    expect(t).not.toBeNull();
    expect(t!).toBeGreaterThan(0.4);
    expect(t!).toBeLessThan(0.5);
  });

  it('離れた線分は交差しない', () => {
    const t = sweepSphere(new Vector3(50, 0, 100), new Vector3(50, 0, -100), new Vector3(), 10);
    expect(t).toBeNull();
  });

  it('始点が球内なら t=0', () => {
    const t = sweepSphere(new Vector3(1, 0, 0), new Vector3(100, 0, 0), new Vector3(), 10);
    expect(t).toBe(0);
  });

  it('高速弾でも1ステップ分の移動でめり込みを検出する', () => {
    // 弾速 1600, dt 1/60 → 1ステップ 26.7 units。半径 12 の球を跨ぐ。
    const p0 = new Vector3(0, 0, 14);
    const p1 = new Vector3(0, 0, 14 - 1600 / 60);
    const t = sweepSphere(p0, p1, new Vector3(), 12);
    expect(t).not.toBeNull();
  });

  it('2球の重なり判定', () => {
    expect(spheresOverlap(new Vector3(), 5, new Vector3(9, 0, 0), 5)).toBe(true);
    expect(spheresOverlap(new Vector3(), 5, new Vector3(11, 0, 0), 5)).toBe(false);
  });

  it('pointOnSegment は線形補間', () => {
    const p = pointOnSegment(new Vector3(0, 0, 0), new Vector3(10, 0, 0), 0.25);
    expect(p.x).toBeCloseTo(2.5);
  });
});

describe('ダメージ配分', () => {
  it('正面からの被弾は前面シールドに入る', () => {
    const w = newWorld();
    const e = playerShip(w);
    const faces = hitFaces(e, new Vector3(0, 0, -20));
    expect(faces.shieldFace).toBe('front');
    expect(faces.armorFace).toBe('front');
  });

  it('後方からの被弾は後面シールドに入る', () => {
    const w = newWorld();
    const e = playerShip(w);
    const faces = hitFaces(e, new Vector3(0, 0, 20));
    expect(faces.shieldFace).toBe('rear');
    expect(faces.armorFace).toBe('rear');
  });

  it('側面からの被弾は左右アーマーに入る', () => {
    const w = newWorld();
    const e = playerShip(w);
    expect(hitFaces(e, new Vector3(20, 0, -1)).armorFace).toBe('right');
    expect(hitFaces(e, new Vector3(-20, 0, -1)).armorFace).toBe('left');
  });

  it('機体が回転していれば被弾面も追従する', () => {
    const w = newWorld();
    const e = playerShip(w);
    // 180度ヨー: ワールドの -Z は機体の後方になる
    e.quat.setFromAxisAngle(new Vector3(0, 1, 0), Math.PI);
    expect(hitFaces(e, new Vector3(0, 0, -20)).shieldFace).toBe('rear');
  });

  it('シールド → アーマー → ハル の順に貫通する', () => {
    const w = newWorld();
    const e = playerShip(w);
    const s = e.ship!;
    const def = s.def;
    // シールド内で収まる
    let r = applyDamage(e, 10, new Vector3(0, 0, -20));
    expect(r.shieldAbsorbed).toBe(10);
    expect(r.armorAbsorbed).toBe(0);
    expect(s.shield.front).toBe(def.shield.front - 10);

    // シールドを抜いてアーマーへ
    r = applyDamage(e, def.shield.front + 5, new Vector3(0, 0, -20));
    expect(r.shieldAbsorbed).toBeCloseTo(def.shield.front - 10);
    expect(r.armorAbsorbed).toBeCloseTo(15);
    expect(s.hull).toBe(def.hull);
  });

  it('総ダメージがシールド+アーマー+ハルを超えると撃墜される', () => {
    const w = newWorld();
    const e = playerShip(w);
    const def = e.ship!.def;
    const total = def.shield.front + def.armor.front + def.hull;
    const r = applyDamage(e, total + 1, new Vector3(0, 0, -20));
    expect(r.destroyed).toBe(true);
    expect(e.ship!.hull).toBe(0);
  });

  it('healthRatios は 0..1 に収まる', () => {
    const w = newWorld();
    const e = playerShip(w);
    applyDamage(e, 1e6, new Vector3(0, 0, -20));
    const h = healthRatios(e);
    expect(h.hull).toBe(0);
    expect(h.shieldFront).toBe(0);
    expect(h.armor.rear).toBe(1);
  });
});

describe('飛行モデル', () => {
  it('スロットル 100% で最大速度に漸近する', () => {
    const w = newWorld();
    const e = playerShip(w);
    e.input!.throttle = 1;
    for (let i = 0; i < 600; i++) updateFlight(e, 1 / 60, 'wc');
    expect(e.vel.length()).toBeCloseTo(e.ship!.def.maxSpeed, 0);
  });

  it('アフターバーナーで最大速度を超える', () => {
    const w = newWorld();
    const e = playerShip(w);
    e.input!.throttle = 1;
    e.input!.afterburner = true;
    for (let i = 0; i < 120; i++) updateFlight(e, 1 / 60, 'wc');
    expect(e.vel.length()).toBeGreaterThan(e.ship!.def.maxSpeed);
  });

  it('アフターバーナーは燃料を消費し、切ると回復する', () => {
    const w = newWorld();
    const e = playerShip(w);
    const def = e.ship!.def;
    e.input!.afterburner = true;
    for (let i = 0; i < 120; i++) updateFlight(e, 1 / 60, 'wc');
    const after = e.ship!.fuel;
    expect(after).toBeLessThan(def.fuel);
    e.input!.afterburner = false;
    for (let i = 0; i < 300; i++) updateFlight(e, 1 / 60, 'wc');
    expect(e.ship!.fuel).toBeGreaterThan(after);
  });

  it('燃料が尽きるとアフターバーナーが効かない', () => {
    const w = newWorld();
    const e = playerShip(w);
    e.ship!.fuel = 0;
    e.input!.throttle = 1;
    e.input!.afterburner = true;
    for (let i = 0; i < 600; i++) updateFlight(e, 1 / 60, 'wc');
    expect(e.vel.length()).toBeLessThan(e.ship!.def.maxSpeed * 1.05);
  });

  it('WC モードでは速度が機首方向へ追従する', () => {
    const w = newWorld();
    const e = playerShip(w);
    e.input!.throttle = 1;
    for (let i = 0; i < 300; i++) updateFlight(e, 1 / 60, 'wc');
    // 90度ヨーさせてから十分に時間を進める
    e.quat.setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2);
    for (let i = 0; i < 600; i++) updateFlight(e, 1 / 60, 'wc');
    const dir = e.vel.clone().normalize();
    expect(dir.x).toBeCloseTo(-1, 1);
  });

  it('Newton モードでは機首を変えても慣性が残る', () => {
    const w = newWorld();
    const e = playerShip(w);
    e.input!.throttle = 1;
    for (let i = 0; i < 300; i++) updateFlight(e, 1 / 60, 'newton');
    const before = e.vel.clone();
    e.quat.setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2);
    e.input!.throttle = 0;
    updateFlight(e, 1 / 60, 'newton');
    // 1ステップでは向きが反転しない
    expect(e.vel.clone().normalize().dot(before.clone().normalize())).toBeGreaterThan(0.9);
  });
});

describe('エネルギーとシールド再生', () => {
  it('無傷ならエネルギーは上限で維持される', () => {
    const w = newWorld();
    const e = playerShip(w);
    for (let i = 0; i < 60; i++) updateShipPower(e, 1 / 60);
    expect(e.ship!.energy).toBeCloseTo(e.ship!.def.energy);
  });

  it('シールドは時間をかけて回復する', () => {
    const w = newWorld();
    const e = playerShip(w);
    e.ship!.shield.front = 0;
    for (let i = 0; i < 60 * 20; i++) updateShipPower(e, 1 / 60);
    expect(e.ship!.shield.front).toBeCloseTo(e.ship!.def.shield.front, 0);
  });

  it('エネルギーが枯渇するとシールド再生が遅くなる', () => {
    const w = newWorld();
    const a = playerShip(w, 'rapier');
    const b = spawnShip(w, { def: shipDef('rapier'), faction: 'confed', pos: new Vector3(500, 0, 0), speed: 0 });
    a.ship!.shield.front = 0;
    b.ship!.shield.front = 0;
    b.ship!.energy = 0;
    for (let i = 0; i < 60; i++) {
      updateShipPower(a, 1 / 60);
      updateShipPower(b, 1 / 60);
    }
    expect(a.ship!.shield.front).toBeGreaterThan(b.ship!.shield.front);
  });
});

describe('砲の発射', () => {
  it('主砲を撃つと弾が出てエネルギーが減る', () => {
    const w = newWorld();
    const e = playerShip(w);
    const before = e.ship!.energy;
    e.input!.firePrimary = true;
    fireGuns(w, e, 1 / 60);
    expect(w.count('projectile')).toBe(e.ship!.def.guns.length);
    expect(e.ship!.energy).toBeLessThan(before);
  });

  it('連射間隔中は撃たない', () => {
    const w = newWorld();
    const e = playerShip(w);
    e.input!.firePrimary = true;
    fireGuns(w, e, 1 / 60);
    const n = w.count('projectile');
    fireGuns(w, e, 1 / 60);
    expect(w.count('projectile')).toBe(n);
  });

  it('エネルギー切れでは撃てない', () => {
    const w = newWorld();
    const e = playerShip(w);
    e.ship!.energy = 0;
    e.input!.firePrimary = true;
    fireGuns(w, e, 1 / 60);
    expect(w.count('projectile')).toBe(0);
  });

  it('弾は敵機に当たってダメージを与える', () => {
    const w = newWorld();
    const p = playerShip(w);
    const enemy = spawnShip(w, {
      def: shipDef('dralthi'),
      faction: 'kilrathi',
      pos: new Vector3(0, 0, -300),
      speed: 0,
    });
    const before = enemy.ship!.shield.rear + enemy.ship!.shield.front;
    p.input!.firePrimary = true;
    fireGuns(w, p, 1 / 60);
    for (let i = 0; i < 60; i++) {
      updateOrdnance(w, 1 / 60);
      resolveProjectileHits(w);
      w.compact();
    }
    const after = enemy.ship!.shield.rear + enemy.ship!.shield.front;
    expect(after).toBeLessThan(before);
  });

  it('自分の弾で自分は傷つかない', () => {
    const w = newWorld();
    const p = playerShip(w);
    const hull = p.ship!.hull;
    p.input!.firePrimary = true;
    fireGuns(w, p, 1 / 60);
    for (let i = 0; i < 10; i++) {
      updateOrdnance(w, 1 / 60);
      resolveProjectileHits(w);
      w.compact();
    }
    expect(p.ship!.hull).toBe(hull);
  });
});

describe('副兵装の選択', () => {
  it('残弾のあるスロットを返す', () => {
    const w = newWorld();
    const e = playerShip(w, 'rapier');
    const slot = activeMissileSlot(e);
    expect(slot).toBeDefined();
    expect(slot!.count).toBeGreaterThan(0);
  });

  it('弾切れスロットは飛ばして巡回する', () => {
    const w = newWorld();
    const e = playerShip(w, 'rapier');
    e.ship!.missiles[1].count = 0;
    e.ship!.activeMissile = 0;
    cycleMissile(e);
    expect(e.ship!.missiles[e.ship!.activeMissile].count).toBeGreaterThan(0);
    expect(e.ship!.activeMissile).not.toBe(1);
  });

  it('全弾切れなら undefined', () => {
    const w = newWorld();
    const e = playerShip(w, 'rapier');
    for (const m of e.ship!.missiles) m.count = 0;
    expect(activeMissileSlot(e)).toBeUndefined();
  });
});

describe('陣営', () => {
  it('異なる陣営は敵対する', () => {
    expect(isHostile('confed', 'kilrathi')).toBe(true);
    expect(isHostile('confed', 'confed')).toBe(false);
  });

  it('中立はどちらとも戦わない', () => {
    expect(isHostile('neutral', 'kilrathi')).toBe(false);
    expect(isHostile('confed', 'neutral')).toBe(false);
  });
});

describe('World', () => {
  it('compact で死んだエンティティが消える', () => {
    const w = newWorld();
    const a = playerShip(w);
    const b = spawnShip(w, { def: shipDef('salthi'), faction: 'kilrathi', pos: new Vector3(0, 0, -500), speed: 0 });
    w.kill(b);
    const removed = w.compact();
    expect(removed).toHaveLength(1);
    expect(w.entities).toHaveLength(1);
    expect(w.byId(a.id)).toBeDefined();
    expect(w.byId(b.id)).toBeUndefined();
  });

  it('スポーン時に前方への初速が入る', () => {
    const w = newWorld();
    const e = spawnShip(w, {
      def: shipDef('hornet'),
      faction: 'confed',
      pos: new Vector3(),
      quat: new Quaternion(),
      speed: 200,
    });
    expect(e.vel.z).toBeCloseTo(-200);
  });
});
