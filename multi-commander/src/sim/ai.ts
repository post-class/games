import { Quaternion, Vector3 } from 'three';
import { clamp, clamp01, forwardOf, leadPoint } from '../core/math';
import { bus } from '../core/events';
import { rng } from '../core/rng';
import { isHostile } from '../content/factions';
import { gunDef, missileDef } from '../content/weapons';
import type { AiRuntime, Entity, WingmanOrder } from '../world/entity';
import type { World } from '../world/world';
import { fireMissile, fireTurrets, selectMissileFor } from './weapons';

export interface AiOptions {
  /** プレイヤーを同時に攻撃できる敵の上限 */
  maxAttackersOnPlayer: number;
  /** 敵のミサイル使用頻度倍率 */
  enemyMissileRate: number;
}

const DEFAULT_AI_OPTIONS: AiOptions = { maxAttackersOnPlayer: 2, enemyMissileRate: 1 };

const _fwd = new Vector3();
const _to = new Vector3();
const _lead = new Vector3();
const _axis = new Vector3();
const _invQ = new Quaternion();
const _tmp = new Vector3();
const _formation = new Vector3();

/** 交戦を開始する距離 */
const ENGAGE_RANGE = 9000;
/** これより近いと離脱して仕切り直す (相手が大きいほど余裕を取る) */
const TOO_CLOSE_BASE = 180;

/** 目標のサイズに応じた「近すぎる」距離。艦艇に突っ込んで自爆しないための余裕。 */
function tooCloseFor(self: Entity, target: Entity): number {
  return TOO_CLOSE_BASE + self.radius + target.radius * 2.4;
}

export function newAi(skill: number, opts: Partial<AiRuntime> = {}): AiRuntime {
  return {
    mode: 'idle',
    skill: clamp01(skill),
    timer: 0,
    maneuverTimer: 0,
    maneuverSign: 1,
    maneuverCooldown: 0,
    morale: 1,
    fireHold: 0,
    missileCooldown: 3,
    engagedFor: 0,
    ...opts,
  };
}

/**
 * 全 AI 機の思考を1ステップ進める。
 * 出力は ThrusterInput なので、飛行モデルはプレイヤーと完全に共通。
 */
export function updateAi(world: World, dt: number, options: Partial<AiOptions> = {}): void {
  const opts = { ...DEFAULT_AI_OPTIONS, ...options };

  // プレイヤーを狙っている機体数を数え、上限を超えた分は他を狙わせる
  let attackersOnPlayer = 0;
  for (const e of world.entities) {
    if (e.alive && e.ai && e.ai.targetId === world.playerId) attackersOnPlayer++;
  }

  for (const e of world.entities) {
    if (!e.alive || e.kind !== 'ship' || !e.ship || !e.ai || !e.input) continue;
    const before = e.ai.targetId;
    updateOne(world, e, dt, opts, attackersOnPlayer);
    if (before !== e.ai.targetId) {
      if (before === world.playerId) attackersOnPlayer--;
      if (e.ai.targetId === world.playerId) attackersOnPlayer++;
    }
  }
}

function updateOne(
  world: World,
  e: Entity,
  dt: number,
  opts: AiOptions,
  attackersOnPlayer: number,
): void {
  const ai = e.ai!;
  const ship = e.ship!;
  const input = e.input!;
  ai.timer += dt;
  if (ai.fireHold > 0) ai.fireHold -= dt;
  if (ai.missileCooldown > 0) ai.missileCooldown -= dt;
  if (ai.maneuverTimer > 0) ai.maneuverTimer -= dt;
  if (ai.maneuverCooldown > 0) ai.maneuverCooldown -= dt;

  // 既定値 (毎フレーム作り直す)
  input.firePrimary = false;
  input.fireSecondary = false;
  input.afterburner = false;

  // 輸送艦・艦艇は機動せず巡航するだけ。ただし艦艇は対空砲火を撃つ。
  if (ai.passive) {
    if (ship.def.role === 'capital') fireTurrets(world, e);
    if (!avoidCollision(world, e)) doCruise(world, e, dt);
    return;
  }

  updateMorale(world, e, dt);
  const target = pickTarget(world, e, opts, attackersOnPlayer);
  ship.targetId = target?.id;

  // 士気が尽きたら離脱。十分に距離を取れれば立て直して戻ってくる。
  if (shouldFlee(world, e)) {
    ai.mode = 'flee';
    doFlee(world, e, dt);
    return;
  }
  if (ai.mode === 'flee') ai.mode = 'pursue';

  // 衝突コースは何よりも先に回避する。
  // 編隊飛行や待機中も対象にしないと、僚機がリーダーに体当たりしてしまう。
  if (avoidCollision(world, e)) {
    ai.mode = 'evade';
    ai.maneuver = undefined;
    ai.maneuverTimer = 0;
    if (target) {
      _to.copy(target.pos).sub(e.pos);
      tryFireGuns(world, e, target, _to.length());
    }
    return;
  }

  // 僚機の「編隊」指令中は攻撃せず追従する。
  // ただし従順さが低いパイロットは、近くに敵がいると勝手に飛び出す。
  if (ai.order === 'form' && !isForcedToFight(world, e) && !isDisobeying(world, e, dt)) {
    doFormation(world, e, dt);
    return;
  }

  if (!target) {
    doIdle(world, e, dt);
    return;
  }

  _to.copy(target.pos).sub(e.pos);
  const distance = _to.length();
  ai.engagedFor += dt;

  // 回避機動の判定。クールダウンを置いて「回避しかしない」状態を避ける。
  if (ai.maneuverTimer <= 0 && ai.maneuverCooldown <= 0) {
    const threat = detectThreat(world, e);
    const hullRatio = ship.hull / ship.def.hull;
    if (distance < tooCloseFor(e, target)) {
      // すれ違い直後は急旋回して背後を取りに行く (漫然と離れない)
      startManeuver(ai, 'break', 1.0);
    } else if (threat && ai.skill > 0.15) {
      // 技量が高いほど早く反応する。慎重なパイロットは長めに振る
      const caution = ai.personality?.caution ?? 0.5;
      startManeuver(ai, threat.close ? 'break' : 'jink', (0.9 + (1 - ai.skill) * 0.8) * (0.7 + caution * 0.7));
    } else if (hullRatio < 0.4 && ai.skill > 0.4 && rng.chance(dt * 0.5)) {
      startManeuver(ai, 'roll', 1.0);
    }
  }

  if (ai.maneuverTimer > 0 && ai.maneuver) {
    doManeuver(world, e, target, dt);
    return;
  }

  // 攻撃性が高いほど遠くから突っ込み、低いと近づくまで様子を見る
  const pursueRange = 1400 * (1.5 - (ai.personality?.aggression ?? 0.5));
  if (distance > pursueRange) {
    ai.mode = 'pursue';
    doPursue(world, e, target, distance, dt);
  } else {
    ai.mode = 'attack';
    doAttack(world, e, target, distance, dt, opts);
  }
}

// ───────── ターゲット選択 ─────────

function pickTarget(
  world: World,
  e: Entity,
  opts: AiOptions,
  attackersOnPlayer: number,
): Entity | undefined {
  const ai = e.ai!;
  const current = world.byId(ai.targetId);

  // 僚機オーダー: リーダーの目標を攻撃
  if (ai.order === 'attack-my-target') {
    const leader = world.byId(ai.leaderId);
    const lt = world.byId(leader?.ship?.targetId);
    if (lt && isHostile(e.faction, lt.faction)) {
      ai.targetId = lt.id;
      return lt;
    }
  }

  // 現在の目標が有効なら継続 (毎フレーム乗り換えると挙動が落ち着かない)
  if (current && current.kind === 'ship' && isHostile(e.faction, current.faction)) {
    const d = current.pos.distanceTo(e.pos);
    if (d < ENGAGE_RANGE * 1.4) {
      if (current.id !== world.playerId) return current;
      // プレイヤーを狙い続けてよいのは上限内のときだけ
      if (attackersOnPlayer <= opts.maxAttackersOnPlayer) return current;
    }
  }

  let best: Entity | undefined;
  let bestScore = -Infinity;
  for (const t of world.entities) {
    if (!t.alive || t.kind !== 'ship' || !t.ship || t.id === e.id) continue;
    if (!isHostile(e.faction, t.faction)) continue;
    const d = t.pos.distanceTo(e.pos);
    if (d > ENGAGE_RANGE) continue;
    if (t.id === world.playerId && attackersOnPlayer >= opts.maxAttackersOnPlayer) continue;
    // 近い相手を優先し、脅威度の高い艦は少し優先度を上げる。
    // 係数を大きくすると全機が艦艇へ殺到してしまうので控えめにする
    let score = -d + t.ship.def.threat * 220;
    if (t.id === ai.targetId) score += 800;
    if (score > bestScore) {
      bestScore = score;
      best = t;
    }
  }
  if (!best && current && isHostile(e.faction, current.faction)) return current;
  ai.targetId = best?.id;
  if (!best) ai.engagedFor = 0;
  return best;
}

/**
 * 命令を無視して勝手に交戦するか。
 *
 * 「編隊を組め」と言った次の秒に単独で突っ込んでいく僚機を表現するための処理。
 * 従順さが低いほど、近くに敵がいると飛び出す確率が上がる。
 * いったん飛び出したら数秒は戻ってこない。
 */
function isDisobeying(world: World, e: Entity, dt: number): boolean {
  const ai = e.ai!;
  if (ai.disobeyTimer !== undefined && ai.disobeyTimer > 0) {
    ai.disobeyTimer -= dt;
    return true;
  }
  const obedience = ai.personality?.obedience ?? 1;
  if (obedience >= 0.85) return false;

  // 近くに敵がいなければ命令に従う
  let nearest = Infinity;
  for (const t of world.entities) {
    if (!t.alive || t.kind !== 'ship' || !t.ship) continue;
    if (!isHostile(e.faction, t.faction)) continue;
    nearest = Math.min(nearest, t.pos.distanceToSquared(e.pos));
  }
  if (nearest > 3500 * 3500) return false;

  // 従順さが低いほど頻繁に飛び出す
  if (rng.chance((1 - obedience) * dt * 0.6)) {
    ai.disobeyTimer = 6 + rng.next() * 8;
    bus.emit('wingmanDisobeyed', { entity: e });
    return true;
  }
  return false;
}

function isForcedToFight(world: World, e: Entity): boolean {
  // 自分が攻撃されているなら編隊指令でも応戦する
  for (const t of world.entities) {
    if (!t.alive || t.kind !== 'ship' || !t.ship) continue;
    if (!isHostile(e.faction, t.faction)) continue;
    if (t.ship.targetId === e.id && t.pos.distanceToSquared(e.pos) < 900 * 900) return true;
  }
  return false;
}

// ───────── 操縦の基本部品 ─────────

/**
 * 機首を目標方向へ向ける PD 制御。
 * 必要な回転軸をローカル系に変換し、そのまま操縦入力に落とす。
 */
function steerToDirection(e: Entity, desiredDir: Vector3, gain: number, bank = 0.5): void {
  const input = e.input!;
  const def = e.ship!.def;
  forwardOf(e.quat, _fwd);
  _axis.copy(_fwd).cross(desiredDir); // 長さ = sin(角度)
  _axis.applyQuaternion(_invQ.copy(e.quat).invert());
  const dot = _fwd.dot(desiredDir);
  // 真後ろ (dot<0) では sin が小さくなるので、旋回量を最大に押し上げる
  const boost = dot < 0 ? 1 / Math.max(0.25, _axis.length()) : 1;

  const kd = 0.28;
  input.pitch = clamp(_axis.x * gain * boost - (e.angVel.x / def.turn[0]) * kd, -1, 1);
  input.yaw = clamp(-_axis.y * gain * boost + (e.angVel.y / def.turn[1]) * kd, -1, 1);
  // ヨー方向へバンクさせて航空機らしい旋回に見せる
  input.roll = clamp(-_axis.z * gain - _axis.y * bank * boost, -1, 1);
}

function steerToPoint(e: Entity, point: Vector3, gain: number, bank = 0.5): void {
  _tmp.copy(point).sub(e.pos);
  const len = _tmp.length();
  if (len < 1e-4) return;
  steerToDirection(e, _tmp.divideScalar(len), gain, bank);
}

/** 平均的な主砲の弾速と有効射程 */
function gunProfile(e: Entity): { speed: number; range: number } {
  const guns = e.ship!.def.guns;
  if (guns.length === 0) return { speed: 1200, range: 2000 };
  let speed = 0;
  let range = Infinity;
  for (const g of guns) {
    const d = gunDef(g.gunId);
    speed += d.speed;
    range = Math.min(range, d.speed * d.life);
  }
  return { speed: speed / guns.length, range: range * 0.75 };
}

/** 射線上に味方がいるなら撃たない */
function friendlyInLine(world: World, e: Entity, targetDistance: number): boolean {
  forwardOf(e.quat, _fwd);
  for (const f of world.entities) {
    if (!f.alive || f.kind !== 'ship' || f.id === e.id) continue;
    if (isHostile(e.faction, f.faction)) continue;
    _tmp.copy(f.pos).sub(e.pos);
    const d = _tmp.length();
    if (d > targetDistance || d < 1e-3) continue;
    _tmp.divideScalar(d);
    // 距離が近いほど許容角度を広げる
    const halfAngle = Math.atan2(f.radius * 1.6, d);
    if (_tmp.dot(_fwd) > Math.cos(halfAngle)) return true;
  }
  return false;
}

/** 技量に応じた照準のばらつき (時間で滑らかに揺れる) */
function aimJitter(e: Entity, world: World, distance: number, out: Vector3): Vector3 {
  const ai = e.ai!;
  // 技量が低いほど大きく外す。距離に比例させることで、
  // 遠距離の撃ち合いは当たらず、近距離の食いつきが重要になる。
  const amp = (1 - ai.skill) * distance * 0.085 + 3;
  const t = world.time * 0.9 + e.id * 1.7;
  return out.set(
    Math.sin(t * 1.3) * amp,
    Math.sin(t * 0.87 + 1.1) * amp,
    Math.sin(t * 1.09 + 2.3) * amp,
  );
}

// ───────── 各モード ─────────

/** 指定地点へ向かって巡航する (輸送艦・護衛対象) */
function doCruise(world: World, e: Entity, dt: number): void {
  const ai = e.ai!;
  const input = e.input!;
  if (!ai.cruiseTo) {
    input.throttle = 0.35;
    input.pitch = 0;
    input.yaw = 0;
    input.roll = 0;
    ai.mode = 'idle';
    return;
  }
  const d = e.pos.distanceTo(ai.cruiseTo);
  if (d < 400) {
    input.throttle = 0;
    ai.mode = 'idle';
    return;
  }
  steerToPoint(e, ai.cruiseTo, 2.2, 0.25);
  input.throttle = 0.85;
  ai.mode = 'escort';
  void world;
  void dt;
}

function doIdle(world: World, e: Entity, dt: number): void {
  const ai = e.ai!;
  const input = e.input!;
  if (ai.cruiseTo) {
    doCruise(world, e, dt);
    return;
  }
  const leader = world.byId(ai.leaderId);
  if (leader) {
    doFormation(world, e, dt);
    return;
  }
  // ゆるく旋回しながら待機
  input.throttle = 0.45;
  const t = world.time * 0.25 + e.id;
  input.pitch = Math.sin(t * 0.7) * 0.15;
  input.yaw = Math.sin(t * 0.4) * 0.25;
  input.roll = Math.sin(t * 0.3) * 0.2;
  ai.mode = 'idle';
}

function doPursue(world: World, e: Entity, target: Entity, distance: number, dt: number): void {
  void dt;
  const input = e.input!;
  const ai = e.ai!;
  const { speed } = gunProfile(e);
  leadPoint(e.pos, target.pos, target.vel, speed, _lead);
  steerToPoint(e, _lead, 3.2, 0.6);
  input.throttle = 1;
  // 遠いときはアフターバーナーで詰める
  input.afterburner = distance > 2600 && e.ship!.fuel > e.ship!.def.fuel * 0.35;
  void world;
  ai.mode = 'pursue';
}

function doAttack(
  world: World,
  e: Entity,
  target: Entity,
  distance: number,
  dt: number,
  opts: AiOptions,
): void {
  void dt;
  const input = e.input!;
  const ai = e.ai!;
  const ship = e.ship!;
  const { speed, range } = gunProfile(e);

  leadPoint(e.pos, target.pos, target.vel, speed, _lead);
  _lead.add(aimJitter(e, world, distance, _tmp));
  steerToPoint(e, _lead, 3.6, 0.45);
  void range;

  // 速度合わせ: 旋回戦になるよう、近距離では相手の速度に合わせて回り込む
  const targetSpeed = target.vel.length();
  let want: number;
  const standoff = tooCloseFor(e, target);
  if (distance < standoff * 1.6) want = Math.max(0.3, targetSpeed / ship.def.maxSpeed - 0.2);
  else if (distance < 900 + standoff) want = clamp01(targetSpeed / ship.def.maxSpeed + 0.1);
  else want = 1;
  input.throttle = clamp01(want);
  // 相手に振り切られそうなときだけ AB を使う
  input.afterburner =
    distance > 1000 && targetSpeed > ship.def.maxSpeed * 0.9 && ship.fuel > ship.def.fuel * 0.4;

  const cos = tryFireGuns(world, e, target, distance);

  // ミサイル
  if (
    ai.missileCooldown <= 0 &&
    ship.missiles.some((m) => m.count > 0) &&
    distance > 500 &&
    distance < 4000 &&
    cos > 0.985
  ) {
    selectMissileFor(e, target);
    const slot = ship.missiles[ship.activeMissile];
    const def = missileDef(slot.missileId);
    // ロックが要るミサイルはロック完了を待つ
    if (def.seeker === 'none' || ship.lockedId === target.id) {
      if (fireMissile(world, e).fired) {
        ai.missileCooldown = (7 + rng.next() * 8) / Math.max(0.2, opts.enemyMissileRate);
      }
    }
  }

  ai.mode = 'attack';
}

const _rel = new Vector3();
const _relVel = new Vector3();
const _miss = new Vector3();
const _desired = new Vector3();

/** 接触までこの秒数を切ったら回避に入る */
const AVOID_TTC = 1.1;
/** これ以下の接近速度なら回避不要 (追尾中の緩やかな詰めを邪魔しない) */
const AVOID_MIN_CLOSING = 90;

/**
 * 最接近点 (CPA) を予測して衝突コースを避ける。
 * これが無いと AI は目標へ真っ直ぐ突っ込んで相打ちになる。
 * 戻り値 true のときは操縦を乗っ取っている。
 */
function avoidCollision(world: World, e: Entity): boolean {
  const input = e.input!;
  let worst: { s: Entity; miss: Vector3; ttc: number } | undefined;

  for (const s of world.entities) {
    if (!s.alive || s.id === e.id) continue;
    if (s.kind !== 'ship' && s.kind !== 'rock' && s.kind !== 'mine') continue;
    // 自軍が敷設した機雷は起爆しないので避ける必要がない
    if (s.kind === 'mine' && s.mine!.ownerFaction === e.faction) continue;
    _rel.copy(s.pos).sub(e.pos);
    const d = _rel.length();
    // 大きい相手ほど早めに舵を切る。機雷は起爆半径の外を通りたい
    const safe =
      s.kind === 'mine'
        ? s.mine!.triggerRadius + e.radius + 40
        : (e.radius + s.radius) * 2.2 + 60;
    if (d < 1e-3) continue;
    _relVel.copy(s.vel).sub(e.vel);
    const relSpeedSq = _relVel.lengthSq();
    // すでに接触寸前なら、接近速度に関係なく離れる。
    // これが無いと、低速で大型艦に寄りかかったまま擦り続けてしまう。
    if (d < safe * 0.75) {
      if (!worst || 0 < worst.ttc) worst = { s, miss: _rel.clone(), ttc: 0 };
      continue;
    }
    if (relSpeedSq < 1e-4) continue;
    // 接近速度 (正なら近づいている)
    const closing = -_rel.dot(_relVel) / d;
    if (closing < AVOID_MIN_CLOSING) continue;
    const ttc = (d - safe) / closing;
    if (ttc > AVOID_TTC) continue;
    // 最接近点でどれだけ離れて通過するか
    const tca = -_rel.dot(_relVel) / relSpeedSq;
    if (tca <= 0) continue;
    _miss.copy(_rel).addScaledVector(_relVel, tca);
    if (_miss.length() > safe) continue;
    if (!worst || ttc < worst.ttc) worst = { s, miss: _miss.clone(), ttc };
  }
  if (!worst) return false;

  // 最接近点で相手がいる方向の逆へ機首を振る
  forwardOf(e.quat, _fwd);
  if (worst.miss.lengthSq() < 1e-6) {
    // 完全な正面衝突コースなら上方へ逃げる
    _desired.set(0, 1, 0).applyQuaternion(e.quat);
  } else {
    _desired.copy(worst.miss).normalize().negate();
  }
  // 前方成分を残して、急激に失速しないよう滑らかに逸れる
  _desired.multiplyScalar(1.5).add(_fwd).normalize();
  steerToDirection(e, _desired, 4.2, 0.7);
  input.throttle = 1;
  return true;
}

/**
 * 射撃判定。命中しそうなら firePrimary を立て、機首と射点のなす cos を返す。
 * 回避機動中でもすれ違いの一瞬に撃てるよう、操縦とは分離してある。
 */
function tryFireGuns(world: World, e: Entity, target: Entity, distance: number): number {
  const ai = e.ai!;
  const ship = e.ship!;
  const input = e.input!;
  const { speed, range } = gunProfile(e);
  leadPoint(e.pos, target.pos, target.vel, speed, _lead);
  _lead.add(aimJitter(e, world, distance, _tmp));

  forwardOf(e.quat, _fwd);
  _tmp.copy(_lead).sub(e.pos);
  const leadDist = _tmp.length();
  const cos = leadDist > 1e-4 ? _tmp.divideScalar(leadDist).dot(_fwd) : 0;
  const cone = Math.cos(0.045 + (1 - ai.skill) * 0.075);

  if (
    cos > cone &&
    distance < range &&
    ship.energy > ship.def.energy * 0.2 &&
    ai.engagedFor > 1.3 + (1 - ai.skill) * 1.8 &&
    ai.fireHold <= 0 &&
    !friendlyInLine(world, e, distance)
  ) {
    input.firePrimary = true;
    // 技量が低いほど短く途切れさせる
    if (ai.skill < 0.7 && rng.chance(0.012)) ai.fireHold = (1 - ai.skill) * 0.7;
  }
  return cos;
}

interface Threat {
  entity: Entity;
  close: boolean;
}

/** 自分の後方から迫っている敵を検出する */
function detectThreat(world: World, e: Entity): Threat | undefined {
  forwardOf(e.quat, _fwd);
  for (const t of world.entities) {
    if (!t.alive || t.kind !== 'ship' || !t.ship || t.id === e.id) continue;
    if (!isHostile(e.faction, t.faction)) continue;
    if (t.ship.targetId !== e.id) continue;
    _tmp.copy(t.pos).sub(e.pos);
    const d = _tmp.length();
    if (d > 750 || d < 1e-3) continue;
    _tmp.divideScalar(d);
    // 自分の後方 (dot < 0.2) にいて、こちらへ機首をよく向けているか
    if (_tmp.dot(_fwd) > 0.2) continue;
    forwardOf(t.quat, _lead);
    if (_lead.dot(_tmp) < 0.93) continue; // 相手の機首が自分を向いていない
    return { entity: t, close: d < 450 };
  }
  return undefined;
}

function startManeuver(ai: AiRuntime, kind: AiRuntime['maneuver'], duration: number): void {
  ai.maneuver = kind;
  ai.maneuverTimer = duration;
  ai.maneuverSign = rng.chance(0.5) ? -1 : 1;
  // 技量が高いほど短い間隔で機動を挟める
  ai.maneuverCooldown = duration + 3.2 - ai.skill * 1.6;
}

function doManeuver(world: World, e: Entity, target: Entity, dt: number): void {
  void dt;
  const ai = e.ai!;
  const input = e.input!;
  const ship = e.ship!;
  const s = ai.maneuverSign;
  ai.mode = 'evade';

  switch (ai.maneuver) {
    case 'break':
      // 急旋回で射線から外れる
      input.pitch = 1;
      input.yaw = s * 0.6;
      input.roll = s;
      input.throttle = 1;
      input.afterburner = ship.fuel > 0.5;
      break;
    case 'jink':
      // 不規則に振って狙いを外させる
      input.pitch = Math.sin(world.time * 7.5 + e.id) * 0.9;
      input.yaw = Math.sin(world.time * 5.3 + e.id * 2) * 0.9;
      input.roll = Math.sin(world.time * 6.1 + e.id * 3) * 0.7;
      input.throttle = 0.95;
      break;
    case 'roll':
      input.roll = s;
      input.pitch = 0.5 * s;
      input.throttle = 1;
      break;
    case 'extend':
      // いったん距離を取る (深追いされたときの仕切り直し)
      _tmp.copy(e.pos).sub(target.pos).normalize();
      steerToDirection(e, _tmp, 3, 0.4);
      input.throttle = 1;
      break;
    default:
      break;
  }
  if (ai.maneuverTimer <= 0) ai.maneuver = undefined;
}

function doFlee(world: World, e: Entity, dt: number): void {
  void dt;
  const input = e.input!;
  const ship = e.ship!;
  // 最も近い敵から離れる方向へ全速
  let nearest: Entity | undefined;
  let nd = Infinity;
  for (const t of world.entities) {
    if (!t.alive || t.kind !== 'ship' || !isHostile(e.faction, t.faction)) continue;
    const d = t.pos.distanceToSquared(e.pos);
    if (d < nd) {
      nd = d;
      nearest = t;
    }
  }
  if (nearest) {
    _tmp.copy(e.pos).sub(nearest.pos).normalize();
    steerToDirection(e, _tmp, 2.6, 0.3);
  }
  input.throttle = 1;
  input.afterburner = ship.fuel > 0.2;
  e.ai!.mode = 'flee';
}

/** 編隊飛行: リーダーの斜め後方に付く */
function doFormation(world: World, e: Entity, dt: number): void {
  void dt;
  const ai = e.ai!;
  const input = e.input!;
  const leader = world.byId(ai.leaderId);
  if (!leader) {
    doIdle(world, e, dt);
    return;
  }
  const side = e.id % 2 === 0 ? 1 : -1;
  _formation
    .set(side * (130 + (e.id % 3) * 45), -18, 150)
    .applyQuaternion(leader.quat)
    .add(leader.pos);

  _tmp.copy(_formation).sub(e.pos);
  const d = _tmp.length();
  if (d > 60) {
    steerToPoint(e, _formation, 3, 0.5);
  } else {
    // 定位置に付いたらリーダーと同じ向きを保つ
    forwardOf(leader.quat, _tmp);
    steerToDirection(e, _tmp, 2.4, 0.4);
  }
  const leaderSpeed = leader.vel.length();
  const want = leaderSpeed / e.ship!.def.maxSpeed + (d > 260 ? 0.4 : 0);
  input.throttle = clamp01(want);
  input.afterburner = d > 900 && e.ship!.fuel > 1;
  ai.mode = 'escort';
}

// ───────── 士気 ─────────

function updateMorale(world: World, e: Entity, dt: number): void {
  const ai = e.ai!;
  const ship = e.ship!;
  const hullRatio = ship.hull / ship.def.hull;

  // 味方と敵の数を数える
  let friends = 0;
  let foes = 0;
  for (const t of world.entities) {
    if (!t.alive || t.kind !== 'ship' || !t.ship) continue;
    const d = t.pos.distanceToSquared(e.pos);
    if (d > 4000 * 4000) continue;
    if (isHostile(e.faction, t.faction)) foes++;
    else if (t.id !== e.id) friends++;
  }

  // エースは粘り、技量が低い機体は早く折れる。性格の粘りも効く
  const grit = (0.35 + ai.skill * 0.9) * (0.7 + (ai.personality?.grit ?? 0.5) * 0.6);
  let pressure = 0;
  // 士気低下の主因は損傷。数の不利は補助的な要因に留める。
  if (hullRatio < 0.35) pressure += (0.35 - hullRatio) * 1.1;
  if (foes > friends + 2) pressure += 0.02 * (foes - friends - 2);
  if (pressure > 0) ai.morale = Math.max(0, ai.morale - (pressure * dt) / grit);
  else ai.morale = Math.min(1, ai.morale + dt * 0.08);
}

/** 逃走を続けるか、立て直して再交戦するか */
function shouldFlee(world: World, e: Entity): boolean {
  const ai = e.ai!;
  const ship = e.ship!;
  const hullRatio = ship.hull / ship.def.hull;
  // 無傷のまま逃げ出すことはない
  if (hullRatio > 0.55) return false;
  if (ai.mode !== 'flee') return ai.morale <= 0.001;

  let nearest = Infinity;
  for (const t of world.entities) {
    if (!t.alive || t.kind !== 'ship' || !isHostile(e.faction, t.faction)) continue;
    nearest = Math.min(nearest, t.pos.distanceToSquared(e.pos));
  }
  // 十分に離れた、または一定時間撃たれていないなら立て直して再交戦する
  const safeDistance = nearest > 4200 * 4200;
  const notBeingHit = ship.shieldDelay <= 0 && nearest > 1100 * 1100;
  if (safeDistance || notBeingHit) {
    ai.morale = 0.45;
    return false;
  }
  return true;
}

/** 僚機へのオーダーを設定する */
export function setWingmanOrder(world: World, order: WingmanOrder, leaderId: number): Entity[] {
  const changed: Entity[] = [];
  const leader = world.byId(leaderId);
  if (!leader) return changed;
  for (const e of world.entities) {
    if (!e.alive || !e.ai || e.faction !== leader.faction || e.id === leaderId) continue;
    if (e.ai.leaderId !== leaderId) continue;
    e.ai.order = order;
    if (order === 'break-and-attack' || order === 'attack-my-target') {
      e.ai.mode = 'pursue';
    }
    changed.push(e);
  }
  return changed;
}
