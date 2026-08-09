import { Vector3 } from 'three';
import { bus } from '../core/events';
import { integrateRotation } from '../core/math';
import type { Entity } from '../world/entity';
import { spawnRock, type World } from '../world/world';
import { pointOnSegment, spheresOverlap, sweepSphere } from './collision';
import { applyDamage } from './damage';
import { destroyEntity } from './combat';

/**
 * 小惑星と機雷。
 *
 * 何も無い空間では回避に意味が無いので、「そこを通ると危ない場所」を作る。
 * 岩は撃って壊せるが、避けた方が速い。機雷は近づくと起爆する。
 */

const _hit = new Vector3();
const _sep = new Vector3();

/**
 * 岩にぶつかったときのダメージ係数 (相対速度に対して)。
 * 全速で突っ込めば致命傷になるが、一撃で死なない程度に抑える。
 * これより大きいと、岩が見えた瞬間には手遅れになってしまう。
 */
const ROCK_IMPACT = 0.28;
/** 岩の接触ダメージを再判定する間隔 */
const ROCK_DAMAGE_INTERVAL = 0.5;

/**
 * 機雷センサの規則 (第3章 T6-3 の熱紋機雷)。
 *
 * ■ なぜ機雷1個ごとのフィールドではなく、このモジュールの状態にしたか
 * `Entity.mine` にフィールドを足すと `world.ts` / `entity.ts` の機雷状態
 * (生成・保存・複製の全経路) に手を入れることになり、既存11ミッションの機雷が
 * 通る道をすべて変えてしまう。熱紋判定と共鳴パルス窓は
 * 「その作戦の回廊全体にかかる規則」であって個々の機雷の属性ではないので、
 * ミッション単位の規則として障害物モジュールに閉じ込めた。
 * `MissionRunner.build()` が必ず `resetMineSensors()` を呼ぶため、
 * 既定 (thermalOnly = false) の既存ミッションには一切影響しない。
 */
interface MineSensorState {
  /**
   * 軍用推進器の熱紋にのみ反応する。
   * 戦闘機・爆撃機 (`fighter` / `bomber`) だけを拾い、
   * 避難船や救難艇のような非武装船 (`transport`) には反応しない。
   */
  thermalOnly: boolean;
  /** 共鳴パルスの安全窓が開いている (熱紋判定が鈍り、起爆しない) */
  suppressed: boolean;
}

const mineSensors: MineSensorState = { thermalOnly: false, suppressed: false };

/** 機雷センサの規則を既定 (陣営判定のみ) に戻す。ミッション開始ごとに呼ぶ */
export function resetMineSensors(): void {
  mineSensors.thermalOnly = false;
  mineSensors.suppressed = false;
}

/** 熱紋機雷にするかを設定する */
export function configureMineSensors(o: { thermalOnly?: boolean }): void {
  if (o.thermalOnly !== undefined) mineSensors.thermalOnly = o.thermalOnly;
}

/** 共鳴パルスの安全窓を開閉する (開いている間、機雷は起爆シーケンスに入らない) */
export function setMineSuppression(active: boolean): void {
  mineSensors.suppressed = active;
}

/** 現在のセンサ規則 (テストと HUD 表示用の読み取り) */
export function mineSensorState(): Readonly<MineSensorState> {
  return mineSensors;
}

/**
 * 重力井戸 (第4章 T6-4 のオルドの重力アンカー)。
 *
 * ■ なぜ「機雷センサと同じ、障害物モジュールのミッション単位の状態」にしたか
 * 1. `Entity` に重力用のフィールドを足すと `entity.ts` / `world.ts` の生成・複製の
 *    全経路に手が入り、既存11ミッションのすべての機体が通る道を変えてしまう。
 *    重力井戸は「その作戦の空域にかかる規則」であって機体の属性ではない。
 * 2. アンカー機 (`oe06-ironroot`) の entity を参照する形にすると、
 *    「アンカーを撃てば重力が消える」ことになってしまう。仕様では
 *    アンカーは兵器ではなく境界標で、撃つかどうかは別の選択 (BOUNDARY) なので、
 *    重力は機体ではなく**空域の宣言** (`HazardDef.kind: 'gravity-well'`) から作る。
 * 3. T6-3 の `mineSensors` と同じく `MissionRunner.build()` (→ `spawnHazards()`) が
 *    必ず `resetGravityWells()` を呼ぶので、宣言の無いミッションでは
 *    `gravityMassFactor()` が常に 1 を返す = 既定の飛行モデルと完全に一致する。
 *
 * 効果は2つだけで、**難易度パラメータ (敵のHP・攻撃力・弾速・命中補正・出現数) には触らない**。
 * - 自機 (と井戸の中にいる全機) の実効質量が数秒周期で変わる → 加速と旋回の効きが変動する
 * - ミサイルが井戸の中心へ引かれる → 弾道が弧を描く
 */
export interface GravityWell {
  /** 井戸の中心 (アンカーの位置) */
  pos: Vector3;
  /** 影響半径。中心に近いほど効きが強い */
  radius: number;
  /** 実効質量が一巡する周期 (秒)。「数秒単位で変わる」ので数秒に取る */
  cycle: number;
  /** 実効質量の振れ幅。0.45 なら中心で 0.55〜1.45 倍 */
  swing: number;
  /** ミサイルを中心へ引く加速度 (m/s^2) */
  pull: number;
  /** 位相のずれ (井戸が複数あるとき、山と谷をずらす) */
  phase: number;
}

const gravityWells: GravityWell[] = [];
/** 井戸の位相を進める時計。`tickGravityWells()` だけが進める */
let gravityTime = 0;

const _gravTo = new Vector3();

/** 重力井戸の宣言を捨てる。ミッション開始ごとに呼ぶ (既定は「井戸なし」) */
export function resetGravityWells(): void {
  gravityWells.length = 0;
  gravityTime = 0;
}

/** 重力井戸を1つ宣言する */
export function addGravityWell(w: {
  pos: Vector3;
  radius: number;
  cycle?: number;
  swing?: number;
  pull?: number;
  phase?: number;
}): void {
  gravityWells.push({
    pos: w.pos.clone(),
    radius: Math.max(1, w.radius),
    cycle: Math.max(0.5, w.cycle ?? 8),
    swing: Math.max(0, w.swing ?? 0.4),
    pull: Math.max(0, w.pull ?? 120),
    phase: w.phase ?? 0,
  });
}

/** 宣言されている井戸 (テストと表示用の読み取り) */
export function gravityWellState(): Readonly<{ wells: readonly GravityWell[]; time: number }> {
  return { wells: gravityWells, time: gravityTime };
}

/** 重力井戸が宣言されているか */
export function gravityWellsActive(): boolean {
  return gravityWells.length > 0;
}

/** 井戸の効き 0..1 (中心で 1、影響半径の外で 0) */
function wellFalloff(w: GravityWell, pos: Vector3): number {
  const d = pos.distanceTo(w.pos);
  if (d >= w.radius) return 0;
  const t = 1 - d / w.radius;
  // 端でなめらかに 0 になるようにする (境界で機動が急変しない)
  return t * t;
}

/**
 * その位置での実効質量倍率。
 * 1 = 従来どおり。1 より大きいと重く (加速・旋回が鈍く)、小さいと軽くなる。
 * 井戸の宣言が無ければ必ず 1 を返す。
 */
export function gravityMassFactor(pos: Vector3): number {
  if (gravityWells.length === 0) return 1;
  let factor = 1;
  for (const w of gravityWells) {
    const f = wellFalloff(w, pos);
    if (f <= 0) continue;
    factor += Math.sin((gravityTime / w.cycle) * Math.PI * 2 + w.phase) * w.swing * f;
  }
  // 0 以下や極端な値にはしない (操作不能にならない範囲)
  return Math.min(4, Math.max(0.25, factor));
}

/**
 * いま重力が重い側か軽い側か (-1..1)。
 * 最初に宣言された井戸 (= アンカー) の位相を返す。
 * 「重力が動いた瞬間」を無線と目標の note で知らせるために使う。
 */
export function gravityWellPulse(): number {
  const w = gravityWells[0];
  if (!w) return 0;
  return Math.sin((gravityTime / w.cycle) * Math.PI * 2 + w.phase);
}

/** 最初の井戸の周期 (秒)。note の残り時間表示に使う */
export function gravityWellCycle(): number {
  return gravityWells[0]?.cycle ?? 0;
}

/**
 * 重力井戸を1ステップ進める。
 *
 * `updateObstacles()` はゲーム本体の固定ステップから呼ばれていないため
 * (`sim/step.ts` は岩と機雷を更新しない)、井戸の時計と弾道の曲げは
 * 毎フレーム必ず通る `MissionRunner.update()` から回す。
 * 宣言が無ければ何もしない。
 */
export function tickGravityWells(world: World, dt: number): void {
  if (gravityWells.length === 0) return;
  gravityTime += dt;

  // ミサイルの弾道を曲げる。推力は機首方向にしか出ないので、
  // 横向きの加速が積もると「弧を描いて戻ってくる」軌跡になる。
  for (const e of world.entities) {
    if (!e.alive || e.kind !== 'missile') continue;
    for (const w of gravityWells) {
      const f = wellFalloff(w, e.pos);
      if (f <= 0) continue;
      _gravTo.copy(w.pos).sub(e.pos);
      const d = _gravTo.length();
      if (d < 1e-3) continue;
      e.vel.addScaledVector(_gravTo.divideScalar(d), w.pull * f * dt);
    }
  }
}

/** 軍用推進器を持つか (熱紋機雷が拾う相手) */
function hasMilitaryThermalSignature(e: Entity): boolean {
  const role = e.ship?.def.role;
  return role === 'fighter' || role === 'bomber';
}

/** 岩の漂流と自転、機雷の起爆判定 */
export function updateObstacles(world: World, dt: number): void {
  for (const e of world.entities) {
    if (!e.alive) continue;

    if (e.kind === 'rock') {
      e.prevPos.copy(e.pos);
      e.pos.addScaledVector(e.vel, dt);
      integrateRotation(e.quat, e.rock!.spin, dt);
      continue;
    }

    if (e.kind === 'mine') {
      updateMine(world, e, dt);
    }
  }
}

function updateMine(world: World, e: Entity, dt: number): void {
  const m = e.mine!;
  e.prevPos.copy(e.pos);
  e.pos.addScaledVector(e.vel, dt);

  if (m.armed) {
    m.fuse -= dt;
    if (m.fuse <= 0) detonateMine(world, e);
    return;
  }

  // 共鳴パルスの窓が開いている間は熱紋を拾えないので、誰が通っても起爆しない
  if (mineSensors.suppressed) return;

  // 敷設側以外の機体が近づくと起爆シーケンスに入る
  for (const s of world.entities) {
    if (!s.alive || s.kind !== 'ship' || !s.ship) continue;
    if (s.faction === m.ownerFaction) continue;
    if (s.ship.def.role === 'capital') continue;
    // 熱紋機雷は軍用推進器だけに反応する。避難船・救難艇は通り抜けられる
    if (mineSensors.thermalOnly && !hasMilitaryThermalSignature(s)) continue;
    if (s.pos.distanceTo(e.pos) > m.triggerRadius + s.radius) continue;
    m.armed = true;
    if (s.id === world.playerId) {
      bus.emit('announce', { text: '機雷 — 起爆する', kind: 'bad', durationMs: 1400 });
    }
    return;
  }
}

function detonateMine(world: World, e: Entity): void {
  const m = e.mine!;
  for (const s of world.entities) {
    if (!s.alive || s.kind !== 'ship' || !s.ship) continue;
    const d = s.pos.distanceTo(e.pos) - s.radius;
    if (d > m.blastRadius) continue;
    const falloff = 1 - Math.max(0, d) / m.blastRadius;
    const res = applyDamage(s, m.damage * (0.3 + 0.7 * falloff), e.pos);
    if (res.shieldAbsorbed > 0) {
      bus.emit('shieldHit', {
        target: s,
        point: e.pos.clone(),
        amount: res.shieldAbsorbed,
        isPlayer: s.id === world.playerId,
      });
    }
    if (res.armorAbsorbed > 0) {
      bus.emit('armorHit', {
        target: s,
        point: e.pos.clone(),
        amount: res.armorAbsorbed,
        layer: 'armor',
        isPlayer: s.id === world.playerId,
      });
    }
    if (res.hullDamage > 0) {
      bus.emit('armorHit', {
        target: s,
        point: e.pos.clone(),
        amount: res.hullDamage,
        layer: 'hull',
        isPlayer: s.id === world.playerId,
      });
    }
    if (res.destroyed) destroyEntity(world, s, undefined, 'mine');
  }
  bus.emit('explosion', { pos: e.pos.clone(), radius: m.blastRadius * 0.5, kind: 'missile' });
  world.kill(e);
}

/**
 * 弾が岩や機雷に当たる判定。
 * 岩に隠れて撃ち合える (弾が遮られる) ことで、戦域に地形としての意味が出る。
 */
export function resolveObstacleHits(world: World): void {
  for (const p of world.entities) {
    if (!p.alive || p.kind !== 'projectile') continue;
    const pr = p.projectile!;
    if (pr.damage <= 0) continue;

    let bestT = Infinity;
    let target: Entity | undefined;
    for (const o of world.entities) {
      if (!o.alive || (o.kind !== 'rock' && o.kind !== 'mine')) continue;
      const t = sweepSphere(p.prevPos, p.pos, o.pos, o.radius);
      if (t !== null && t < bestT) {
        bestT = t;
        target = o;
      }
    }
    if (!target) continue;

    pointOnSegment(p.prevPos, p.pos, bestT, _hit);
    if (target.kind === 'mine') {
      // 機雷は撃てば安全に処理できる
      target.mine!.hull -= pr.damage;
      bus.emit('explosion', { pos: _hit.clone(), radius: 12, kind: 'small' });
      if (target.mine!.hull <= 0) {
        bus.emit('explosion', {
          pos: target.pos.clone(),
          radius: target.mine!.blastRadius * 0.4,
          kind: 'missile',
        });
        world.kill(target);
      }
    } else {
      target.rock!.hull -= pr.damage;
      bus.emit('armorHit', {
        target,
        point: _hit.clone(),
        amount: pr.damage,
        layer: 'armor',
        isPlayer: false,
      });
      if (target.rock!.hull <= 0) breakRock(world, target);
    }
    world.kill(p);
  }
}

/** 岩を砕く。大きい岩は小さい破片に分裂する */
function breakRock(world: World, rock: Entity): void {
  bus.emit('explosion', { pos: rock.pos.clone(), radius: rock.radius * 1.2, kind: 'missile' });
  world.kill(rock);

  const r = rock.radius * 0.42;
  if (r < 7) return;
  for (let i = 0; i < 3; i++) {
    const dir = new Vector3(
      Math.sin(i * 2.1 + rock.pos.x),
      Math.sin(i * 1.7 + rock.pos.y),
      Math.cos(i * 2.4 + rock.pos.z),
    );
    if (dir.lengthSq() < 1e-6) dir.set(1, 0, 0);
    dir.normalize();
    const child = spawnRock(world, {
      pos: rock.pos.clone().addScaledVector(dir, rock.radius * 0.6),
      radius: r,
      vel: rock.vel.clone().addScaledVector(dir, 26),
      variant: (rock.rock!.variant + i + 1) % 4,
      seed: rock.pos.x + i * 7.3,
    });
    child.label = '岩塊';
    child.rock!.spin.copy(rock.rock!.spin).multiplyScalar(1.8);
  }
}

/**
 * 機体が岩に接触したときの処理。
 * 相対速度が高いほど痛い。艦艇は岩を押し退ける。
 */
export function resolveObstacleCollisions(world: World): void {
  for (const o of world.entities) {
    if (!o.alive || o.kind !== 'rock') continue;
    for (const s of world.entities) {
      if (!s.alive || s.kind !== 'ship' || !s.ship) continue;
      if (!spheresOverlap(s.pos, s.radius, o.pos, o.radius)) continue;

      const rel = _sep.copy(s.vel).sub(o.vel).length();
      if (s.ship.collisionCooldown <= 0) {
        if (s.id === world.playerId) {
          bus.emit('announce', { text: '岩に接触', kind: 'bad', durationMs: 1200 });
          bus.emit('cameraShake', { strength: 0.5 });
        }
        s.ship.collisionCooldown = ROCK_DAMAGE_INTERVAL;
        const mid = _hit.copy(s.pos).add(o.pos).multiplyScalar(0.5);
        const impact = Math.max(0, rel - 30);
        const dmg = 5 + impact * ROCK_IMPACT;
        const res = applyDamage(s, dmg, mid);
        if (res.shieldAbsorbed > 0) {
          bus.emit('shieldHit', {
            target: s,
            point: mid.clone(),
            amount: res.shieldAbsorbed,
            isPlayer: s.id === world.playerId,
          });
        }
        if (res.armorAbsorbed > 0) {
          bus.emit('armorHit', {
            target: s,
            point: mid.clone(),
            amount: res.armorAbsorbed,
            layer: 'armor',
            isPlayer: s.id === world.playerId,
          });
        }
        if (res.hullDamage > 0) {
          bus.emit('armorHit', {
            target: s,
            point: mid.clone(),
            amount: res.hullDamage,
            layer: 'hull',
            isPlayer: s.id === world.playerId,
          });
        }
        if (res.destroyed) destroyEntity(world, s, undefined, 'rock');
        // 小さい岩は機体に砕かれる
        if (o.radius < s.radius * 0.8) {
          breakRock(world, o);
          continue;
        }
      }

      // 押し戻し。岩の方が軽ければ岩が動く
      _sep.copy(o.pos).sub(s.pos);
      const d = _sep.length();
      if (d < 1e-4) _sep.set(1, 0, 0);
      else _sep.divideScalar(d);
      const overlap = s.radius + o.radius - d;
      if (o.radius < s.radius) {
        o.pos.addScaledVector(_sep, overlap);
        o.vel.addScaledVector(_sep, 24);
      } else {
        s.pos.addScaledVector(_sep, -overlap);
        s.vel.addScaledVector(_sep, -18);
      }
    }
  }
}

/** ミサイルが岩に当たる (誘導兵器が地形に吸われる) */
export function resolveObstacleMissileHits(world: World): void {
  for (const m of world.entities) {
    if (!m.alive || m.kind !== 'missile') continue;
    for (const o of world.entities) {
      if (!o.alive || o.kind !== 'rock') continue;
      const t = sweepSphere(m.prevPos, m.pos, o.pos, o.radius);
      if (t === null) continue;
      pointOnSegment(m.prevPos, m.pos, t, _hit);
      o.rock!.hull -= m.missile!.def.damage * 0.5;
      bus.emit('explosion', {
        pos: _hit.clone(),
        radius: m.missile!.def.blastRadius * 0.7,
        kind: 'missile',
      });
      if (o.rock!.hull <= 0) breakRock(world, o);
      world.kill(m);
      break;
    }
  }
}

/** 障害物が近くにあるか (AI の回避と HUD 警告に使う) */
export function nearestObstacle(world: World, pos: Vector3, range: number): Entity | undefined {
  let best: Entity | undefined;
  let bestD = range;
  for (const o of world.entities) {
    if (!o.alive || (o.kind !== 'rock' && o.kind !== 'mine')) continue;
    const d = o.pos.distanceTo(pos) - o.radius;
    if (d < bestD) {
      bestD = d;
      best = o;
    }
  }
  return best;
}
