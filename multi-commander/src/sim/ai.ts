import { Vector3 } from 'three';
import { clamp01, forwardOf, leadPoint } from '../core/math';
import { bus } from '../core/events';
import { rng } from '../core/rng';
import { isHostile } from '../content/factions';
import type { Faction } from '../content/ships';
import { gunDef, missileDef } from '../content/weapons';
import type { AiRuntime, Entity, WingmanOrder } from '../world/entity';
import type { World } from '../world/world';
import { steerCommand, type SteerCommand } from './steer';
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
const _tmp = new Vector3();
const _formation = new Vector3();
/** 操縦入力の受け皿 (`steerCommand` の結果を写す) */
const _steer: SteerCommand = { pitch: 0, yaw: 0, roll: 0 };
/** 学習した群体が進入をずらすための横方向ベクトル (第6章) */
const _swarmSide = new Vector3();

/** 交戦を開始する距離 */
const ENGAGE_RANGE = 9000;
/** これより近いと離脱して仕切り直す (相手が大きいほど余裕を取る) */
const TOO_CLOSE_BASE = 180;

/** 目標のサイズに応じた「近すぎる」距離。艦艇に突っ込んで自爆しないための余裕。 */
function tooCloseFor(self: Entity, target: Entity): number {
  return TOO_CLOSE_BASE + self.radius + target.radius * 2.4;
}

/**
 * 決闘規約 (第5章 T6-5 のラギティカ)。
 *
 * ■ なぜ AI 個体のフィールドではなく、このモジュールのミッション単位の状態にしたか
 * 1. `AiRuntime` (`world/entity.ts`) にフィールドを足すと、AI を持つ全機体の
 *    生成・複製経路に手が入る。決闘は「その作戦にひと組だけ存在する取り決め」なので、
 *    T6-3 の `mineSensors` / T6-4 の重力井戸と同じくモジュール単位の規則として持つ。
 * 2. 陣営関係 (`MissionDef.factionStances`) では表現できない。誓約を守る側 (ラギティカ) と
 *    破る側 (急進派) は**同じ `kilrathi` 陣営**なので、陣営単位の関係表では
 *    「一方とは停戦、他方とは敵対」を書き分けられない (第8章で記録済みの限界)。
 *    そのため決闘は entity id 単位の規則としてここに置く。
 *
 * `MissionRunner.build()` が必ず `resetDuel()` を呼ぶので、
 * 宣言の無いミッションでは AI は一切従来どおり動く。
 * **技量 (skill) と難易度補正には触らない。変えるのは狙い方だけ。**
 */
export interface DuelRules {
  /** 誓約を守る側 (決闘の当事者) の entity id */
  duellistId: number;
  /** 決闘の相手 (通常は自機) の entity id */
  opponentId: number;
  /** 相手のハル率がこれ以下なら引き金を引かない (撃墜を狙わない) */
  spareHullRatio: number;
  /** 相手の癖を測るために保つ距離 (m) */
  measureRange: number;
  /**
   * 決闘中、砲門を閉じる陣営 (T4-⑯)。
   *
   * `AceOathRules.noThirdPartyFire`「決闘中は決闘の当事者以外へ砲撃しない」を
   * **AI の狙い方として** 実装するための指定。この陣営の機体は、
   * 決闘の当事者 (`duellistId`) を除いて `opponentId` を目標に選ばず、撃たない。
   * 誓約が破られた (`breakDuel`) 時点で無効になり、全機が通常の交戦へ戻る。
   *
   * **技量・攻撃力・出現数には触れない。** 変わるのは「誰を狙うか」だけ。
   * 未指定なら従来どおり（第三者も撃つ）。
   */
  standDownFaction?: Faction;
}

interface DuelState {
  rules?: DuelRules;
  /** 誓約が破られたか (急進派の介入) */
  broken: boolean;
  /** 誓約を破った側の entity id。破られた後はこちらへ機首を向ける */
  breakerIds: Set<number>;
}

const duel: DuelState = { broken: false, breakerIds: new Set<number>() };

/** 決闘規約を捨てる。ミッション開始ごとに呼ぶ (既定は「決闘なし」) */
export function resetDuel(): void {
  duel.rules = undefined;
  duel.broken = false;
  duel.breakerIds.clear();
}

/** 決闘規約を宣言する */
export function configureDuel(r: {
  duellistId: number;
  opponentId: number;
  spareHullRatio?: number;
  measureRange?: number;
  standDownFaction?: Faction;
}): void {
  duel.rules = {
    duellistId: r.duellistId,
    opponentId: r.opponentId,
    spareHullRatio: Math.min(0.95, Math.max(0, r.spareHullRatio ?? 0.35)),
    measureRange: Math.max(120, r.measureRange ?? 900),
    standDownFaction: r.standDownFaction,
  };
  duel.broken = false;
  duel.breakerIds.clear();
}

/**
 * 誓約が破られた (急進派が決闘空域へ入った)。
 * 以後、決闘の当事者は相手を測るのをやめ、**同じ陣営であっても**
 * 誓約を破った側へ機首を向ける (敵味方の線と誓約の線がずれる)。
 */
export function breakDuel(breakerIds: readonly number[]): void {
  if (!duel.rules) return;
  duel.broken = true;
  for (const id of breakerIds) duel.breakerIds.add(id);
}

/** 決闘が成立中か (宣言があり、まだ破られていない) */
export function duelActive(): boolean {
  return !!duel.rules && !duel.broken;
}

/** 現在の決闘規約 (テストと表示用の読み取り) */
export function duelState(): Readonly<{
  rules?: DuelRules;
  broken: boolean;
  breakerIds: ReadonlySet<number>;
}> {
  return duel;
}

/** e から見て f が「誓約を破った側」か (射線の味方判定から外す) */
function isDuelBreaker(e: Entity, f: Entity): boolean {
  return duel.broken && duel.rules?.duellistId === e.id && duel.breakerIds.has(f.id);
}

/**
 * e は決闘中、目標 `targetId` に手を出してはいけない立場か (T4-⑯)。
 *
 * 「決闘の当事者以外は撃たない」を、狙う相手の選択と発砲判定の2箇所で効かせる。
 * 決闘の宣言が無い / `standDownFaction` 未指定 / 誓約が破られた場合は常に false
 * なので、既存ミッションの挙動は変わらない。
 */
export function duelStandDown(e: Entity, targetId: number | undefined): boolean {
  const rules = duel.rules;
  if (!rules || duel.broken || rules.standDownFaction === undefined) return false;
  if (targetId === undefined || targetId !== rules.opponentId) return false;
  if (e.id === rules.duellistId) return false;
  return e.faction === rules.standDownFaction;
}

/**
 * 脱出ポッドは狙わない。
 *
 * `sim/eject.ts` は「脱出したポッドは中立扱いで、敵はもう狙わない」を
 * 陣営の付け替えで実現していたが、T4-⑯ で **敵エースの脱出ポッド** を
 * 撃つ／撃たないの選択にしたため、陣営に依らない規則として明示する。
 * 味方の AI が勝手に座席を撃ってしまうと、プレイヤーの選択が成立しない。
 */
function isEscapePod(t: Entity): boolean {
  return t.ship?.ejected === true;
}

// ───────── 学習する群体 (第6章 T6-6) ─────────

/**
 * 撃墜された数に応じて戦い方を変える群体ドローン（第6章）。
 *
 * ■ 何を変えて、何を変えないか（この線引きは崩さない）
 * 変えるのは**振る舞いだけ**:
 *   - 隊形（同じ射線に重ならないよう、進入を横へずらす）
 *   - 同時に自機へ張り付く機数（`maxAttackersOnPlayer` への上乗せ）
 *   - 回避の入れ方（回避機動を挟む間隔と、脅威が無くても入れる振り）
 *   - 包み込む距離（追尾から攻撃へ移る距離）
 * **変えないもの**: HP・攻撃力・弾速・命中補正。
 * `ship.def`（ハル/装甲/シールド）、`gunDef`（威力と弾速）、`ai.skill`、
 * `aimJitter`（命中のばらつき）には一切触れていない。
 * 「撃墜されるほど硬くなる／痛くなる」のは難易度の書き換えであって学習ではない。
 *
 * ■ 上限を設ける理由（無限に強くならない）
 * 個体を潰しても群体は痛みを感じない相手なので、撃つほど不利になる設計だが、
 * 上限が無いと「一定数を撃った時点で回避不能」になり、
 * 撃たずに抜ける選択肢（第6章の静脈路）を選ばなかった者に対して
 * 詰みを作ってしまう。段階は `MAX_SWARM_LEVEL = 3` で止める。
 * これは 4機撃墜ごとに1段階（`LOSSES_PER_LEVEL`）で、
 * 第6章に配置されたドローン21機のうち12機を落とした時点で頭打ちになる数値。
 * 上限では「同時に張り付く数 2→5」「回避間隔 約0.64倍」に留まり、
 * 一機のラピアーIIでも振り切れる範囲に収まる。
 *
 * ■ なぜモジュール単位の状態か
 * `src/sim/obstacles.ts` の熱紋機雷（T6-3）と同じ流儀。学習は個体の属性ではなく
 * 「その作戦の群体全体が共有する記憶」なので、`AiRuntime` を増やさない。
 * `MissionRunner.build()` が必ず `resetSwarmLearning()` を呼ぶので、
 * 宣言のないミッションの AI は完全に従来どおり動く。
 */
export const MAX_SWARM_LEVEL = 3;
/** 1段階の学習に必要な撃墜数 */
export const LOSSES_PER_SWARM_LEVEL = 4;

export interface SwarmProfile {
  /** 学習段階 0..MAX_SWARM_LEVEL */
  level: number;
  /** 自機へ同時に張り付ける機数の上乗せ */
  attackerBonus: number;
  /** 攻撃進入を横へずらす距離 (m)。隊形が扇形に開く */
  lateralSpread: number;
  /** 回避機動を挟む間隔の倍率 (小さいほど頻繁に振る) */
  maneuverCooldownScale: number;
  /** 攻撃へ移る距離の倍率 (大きいほど遠くから包む) */
  pursueRangeScale: number;
}

/** 学習していない相手のプロファイル（既定。これを返す限り挙動は従来どおり） */
const NO_SWARM_LEARNING: SwarmProfile = {
  level: 0,
  attackerBonus: 0,
  lateralSpread: 0,
  maneuverCooldownScale: 1,
  pursueRangeScale: 1,
};

interface SwarmState {
  /** 学習する陣営 (未宣言なら undefined = 学習なし) */
  faction?: Faction;
  /** 学習に必要な1段階あたりの撃墜数 */
  lossesPerLevel: number;
  /** これまでに失った個体数 */
  losses: number;
  profile: SwarmProfile;
}

const swarm: SwarmState = {
  lossesPerLevel: LOSSES_PER_SWARM_LEVEL,
  losses: 0,
  profile: NO_SWARM_LEARNING,
};

function swarmProfileFor(level: number): SwarmProfile {
  const l = Math.max(0, Math.min(MAX_SWARM_LEVEL, level));
  if (l === 0) return NO_SWARM_LEARNING;
  return {
    level: l,
    // 同時に張り付く数: 既定2 に対して +1 ずつ (上限で5機)
    attackerBonus: l,
    // 隊形: 段階ごとに120m ずつ進入をずらす
    lateralSpread: l * 120,
    // 回避の入れ方: 段階ごとに12%短い間隔で振る (上限0.64倍)
    maneuverCooldownScale: 1 - l * 0.12,
    // 包み込む距離: 段階ごとに12%手前から攻撃へ移る
    pursueRangeScale: 1 + l * 0.12,
  };
}

/** 群体の学習を捨てる。ミッション開始ごとに呼ぶ (既定は「学習なし」) */
export function resetSwarmLearning(): void {
  swarm.faction = undefined;
  swarm.lossesPerLevel = LOSSES_PER_SWARM_LEVEL;
  swarm.losses = 0;
  swarm.profile = NO_SWARM_LEARNING;
}

/** 学習する群体を宣言する */
export function configureSwarmLearning(o: { faction: Faction; lossesPerLevel?: number }): void {
  swarm.faction = o.faction;
  swarm.lossesPerLevel = Math.max(1, Math.round(o.lossesPerLevel ?? LOSSES_PER_SWARM_LEVEL));
  swarm.losses = 0;
  swarm.profile = NO_SWARM_LEARNING;
}

/**
 * 個体を1機失った。宣言された陣営以外は数えない。
 * 「個体を潰しても群体は痛みを感じない」＝士気ではなく学習として蓄積する。
 */
export function recordSwarmLoss(faction: Faction): void {
  if (!swarm.faction || faction !== swarm.faction) return;
  swarm.losses += 1;
  swarm.profile = swarmProfileFor(Math.floor(swarm.losses / swarm.lossesPerLevel));
}

/** 現在の学習段階 (0..MAX_SWARM_LEVEL)。テストと表示用 */
export function swarmLearningLevel(): number {
  return swarm.profile.level;
}

/** 現在の学習状態 (テストと表示用の読み取り) */
export function swarmLearningState(): Readonly<{
  faction?: Faction;
  losses: number;
  profile: SwarmProfile;
}> {
  return swarm;
}

/** その陣営に効いている学習プロファイル。宣言外の陣営は既定値 */
export function swarmProfile(faction: Faction): SwarmProfile {
  return swarm.faction && faction === swarm.faction ? swarm.profile : NO_SWARM_LEARNING;
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

  // 決闘規約 (第5章)。宣言が無ければこの行は素通りする。
  // 士気の集計だけは通常どおり行い、狙い方だけを差し替える。
  if (duel.rules && e.id === duel.rules.duellistId && updateDuellist(world, e, dt, opts)) return;

  // 学習する群体 (第6章)。宣言が無ければ既定値なので、以下の計算はすべて従来と同値。
  const learned = swarmProfile(e.faction);
  const target = pickTarget(world, e, opts, attackersOnPlayer, learned.attackerBonus);
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
      startManeuver(ai, 'break', 1.0, learned.maneuverCooldownScale);
    } else if (threat && ai.skill > 0.15) {
      // 技量が高いほど早く反応する。慎重なパイロットは長めに振る
      const caution = ai.personality?.caution ?? 0.5;
      startManeuver(
        ai,
        threat.close ? 'break' : 'jink',
        (0.9 + (1 - ai.skill) * 0.8) * (0.7 + caution * 0.7),
        learned.maneuverCooldownScale,
      );
    } else if (hullRatio < 0.4 && ai.skill > 0.4 && rng.chance(dt * 0.5)) {
      startManeuver(ai, 'roll', 1.0, learned.maneuverCooldownScale);
    } else if (learned.level >= 2 && rng.chance(dt * 0.12 * learned.level)) {
      // 学習した群体は、狙われていなくても振りを入れてくる (同じ攻め方が通らなくなる)。
      // 技量も命中補正も変えていない。挟むタイミングだけが変わる。
      startManeuver(ai, 'jink', 0.8, learned.maneuverCooldownScale);
    }
  }

  if (ai.maneuverTimer > 0 && ai.maneuver) {
    doManeuver(world, e, target, dt);
    return;
  }

  // 攻撃性が高いほど遠くから突っ込み、低いと近づくまで様子を見る
  const pursueRange =
    1400 * (1.5 - (ai.personality?.aggression ?? 0.5)) * learned.pursueRangeScale;
  if (distance > pursueRange) {
    ai.mode = 'pursue';
    doPursue(world, e, target, distance, dt);
  } else {
    ai.mode = 'attack';
    doAttack(world, e, target, distance, dt, opts, learned);
  }
}

// ───────── 決闘 (第5章) ─────────

/**
 * 決闘の当事者の思考。操縦を引き受けたら true を返す。
 *
 * - 誓約成立中: 相手を**撃墜せず**、距離を測りながら癖を見る。
 * - 誓約が破られた後: 同じ陣営でも、誓約を破った側へ機首を向ける
 *   (`AceOathRules.onBroken: 'defend-duel'`)。破った側が残っていなければ
 *   false を返して通常の交戦へ戻す。
 */
function updateDuellist(world: World, e: Entity, dt: number, opts: AiOptions): boolean {
  const rules = duel.rules!;
  const ai = e.ai!;
  const ship = e.ship!;

  const target = duel.broken
    ? nearestDuelBreaker(world, e)
    : world.byId(rules.opponentId);
  if (!target || target.kind !== 'ship' || !target.ship) return false;

  ai.targetId = target.id;
  ship.targetId = target.id;
  ai.engagedFor += dt;

  if (avoidCollision(world, e)) {
    ai.mode = 'evade';
    ai.maneuver = undefined;
    ai.maneuverTimer = 0;
    return true;
  }

  const distance = target.pos.distanceTo(e.pos);
  if (!duel.broken) {
    doDuelMeasure(world, e, target, distance);
    return true;
  }
  // 誓約を破った側へは通常どおり撃つ (手加減しない)
  if (distance > 1400) doPursue(world, e, target, distance, dt);
  else doAttack(world, e, target, distance, dt, opts);
  return true;
}

/** 誓約を破った側のうち、いちばん近い機体 */
function nearestDuelBreaker(world: World, e: Entity): Entity | undefined {
  let best: Entity | undefined;
  let bestD = Infinity;
  for (const id of duel.breakerIds) {
    const t = world.byId(id);
    if (!t || t.kind !== 'ship' || !t.ship) continue;
    const d = t.pos.distanceToSquared(e.pos);
    if (d < bestD) {
      bestD = d;
      best = t;
    }
  }
  return best;
}

/**
 * 「撃墜を狙わず、こちらの癖を測る」機動。
 *
 * 照準のばらつき (技量) と射撃判定は通常戦闘と同じものを使う。
 * 変えるのは2点だけ:
 *   - 相手のハルが `spareHullRatio` 以下になったら引き金を引かない (致命打を避ける)
 *   - ミサイルを使わない (決闘は機動で測るもの)
 * さらに `measureRange` 前後の距離を保ち、相手の機動に追随する。
 */
function doDuelMeasure(world: World, e: Entity, target: Entity, distance: number): void {
  const ai = e.ai!;
  const ship = e.ship!;
  const input = e.input!;
  const rules = duel.rules!;
  const maxSpeed = ship.def.maxSpeed * Math.max(0.01, ship.speedScale);
  const { speed } = gunProfile(e);

  leadPoint(e.pos, target.pos, target.vel, speed, _lead);
  _lead.add(aimJitter(e, world, distance, _tmp));
  steerToPoint(e, _lead, 3.6, 0.45);

  // 距離を測る: 近すぎれば絞り、離れれば詰める。相手の速度に合わせて追随する
  const targetSpeed = target.vel.length();
  const want =
    distance < rules.measureRange
      ? targetSpeed / maxSpeed - 0.25
      : targetSpeed / maxSpeed + 0.3;
  input.throttle = clamp01(Math.max(0.2, want));
  input.afterburner = false;

  const hullRatio = target.ship!.hull / Math.max(1, target.ship!.def.hull);
  if (hullRatio > rules.spareHullRatio) tryFireGuns(world, e, target, distance);

  ai.mode = 'attack';
}

// ───────── ターゲット選択 ─────────

function pickTarget(
  world: World,
  e: Entity,
  opts: AiOptions,
  attackersOnPlayer: number,
  /** 学習した群体が自機へ同時に張り付ける機数の上乗せ (既定0 = 従来どおり) */
  attackerBonus = 0,
): Entity | undefined {
  const ai = e.ai!;
  const current = world.byId(ai.targetId);
  const attackerLimit = opts.maxAttackersOnPlayer + attackerBonus;

  // 僚機オーダー: リーダーの目標を攻撃
  if (ai.order === 'attack-my-target') {
    const leader = world.byId(ai.leaderId);
    const lt = world.byId(leader?.ship?.targetId);
    if (lt && isHostile(e.faction, lt.faction) && !isEscapePod(lt) && !duelStandDown(e, lt.id)) {
      ai.targetId = lt.id;
      return lt;
    }
  }

  // 現在の目標が有効なら継続 (毎フレーム乗り換えると挙動が落ち着かない)
  if (
    current &&
    current.kind === 'ship' &&
    isHostile(e.faction, current.faction) &&
    !isEscapePod(current) &&
    !duelStandDown(e, current.id)
  ) {
    const d = current.pos.distanceTo(e.pos);
    if (d < ENGAGE_RANGE * 1.4) {
      if (current.id !== world.playerId) return current;
      // プレイヤーを狙い続けてよいのは上限内のときだけ
      if (attackersOnPlayer <= attackerLimit) return current;
    }
  }

  let best: Entity | undefined;
  let bestScore = -Infinity;
  for (const t of world.entities) {
    if (!t.alive || t.kind !== 'ship' || !t.ship || t.id === e.id) continue;
    if (!isHostile(e.faction, t.faction)) continue;
    // 脱出ポッドと、決闘中の当事者以外が触れてはいけない相手は候補に入れない
    if (isEscapePod(t) || duelStandDown(e, t.id)) continue;
    const d = t.pos.distanceTo(e.pos);
    if (d > ENGAGE_RANGE) continue;
    if (t.id === world.playerId && attackersOnPlayer >= attackerLimit) continue;
    // 近い相手を優先し、脅威度の高い艦は少し優先度を上げる。
    // 係数を大きくすると全機が艦艇へ殺到してしまうので控えめにする
    let score = -d + t.ship.def.threat * 220;
    if (t.id === ai.targetId) score += 800;
    if (score > bestScore) {
      bestScore = score;
      best = t;
    }
  }
  if (
    !best &&
    current &&
    isHostile(e.faction, current.faction) &&
    !isEscapePod(current) &&
    !duelStandDown(e, current.id)
  ) {
    return current;
  }
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
 *
 * 式そのものは `sim/steer.ts` に置き、ここでは結果を操縦入力へ写すだけにする。
 * チュートリアルのお手本モードが同じ式で飛ぶため、
 * 「AI の動き」と「お手本の動き」が別物にならない。
 */
function steerToDirection(e: Entity, desiredDir: Vector3, gain: number, bank = 0.5): void {
  const input = e.input!;
  steerCommand(e, desiredDir, gain, bank, _steer);
  input.pitch = _steer.pitch;
  input.yaw = _steer.yaw;
  input.roll = _steer.roll;
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
    // 誓約を破った側は同じ陣営でも庇わない (第5章。決闘の線と敵味方の線がずれる)
    if (isDuelBreaker(e, f)) continue;
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
  /** 学習した群体のプロファイル (既定は「学習なし」= 従来の攻め方) */
  learned: SwarmProfile = NO_SWARM_LEARNING,
): void {
  void dt;
  const input = e.input!;
  const ai = e.ai!;
  const ship = e.ship!;
  const maxSpeed = ship.def.maxSpeed * Math.max(0.01, ship.speedScale);
  const { speed, range } = gunProfile(e);

  leadPoint(e.pos, target.pos, target.vel, speed, _lead);
  // 隊形 (第6章の学習)。同じ射線に重ならないよう、機体ごとに一定方向へ進入をずらす。
  // 命中のばらつき (aimJitter) とは別物で、こちらは「どこから入るか」しか変えない。
  if (learned.lateralSpread > 0) {
    _swarmSide
      .set(e.id % 2 === 0 ? 1 : -1, ((e.id % 3) - 1) * 0.5, 0)
      .applyQuaternion(e.quat)
      .multiplyScalar(learned.lateralSpread);
    _lead.add(_swarmSide);
  }
  _lead.add(aimJitter(e, world, distance, _tmp));
  steerToPoint(e, _lead, 3.6, 0.45);
  void range;

  // 速度合わせ: 旋回戦になるよう、近距離では相手の速度に合わせて回り込む
  const targetSpeed = target.vel.length();
  let want: number;
  const standoff = tooCloseFor(e, target);
  if (distance < standoff * 1.6) want = Math.max(0.3, targetSpeed / maxSpeed - 0.2);
  else if (distance < 900 + standoff) want = clamp01(targetSpeed / maxSpeed + 0.1);
  else want = 1;
  input.throttle = clamp01(want);
  // 相手に振り切られそうなときだけ AB を使う
  input.afterburner =
    distance > 1000 && targetSpeed > maxSpeed * 0.9 && ship.fuel > ship.def.fuel * 0.4;

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
  // 決闘中は当事者以外が撃たない。座席（脱出ポッド）も撃たない。
  if (isEscapePod(target) || duelStandDown(e, target.id)) return 0;
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

function startManeuver(
  ai: AiRuntime,
  kind: AiRuntime['maneuver'],
  duration: number,
  /** 回避を挟む間隔の倍率 (第6章の学習。既定1 = 従来どおり) */
  cooldownScale = 1,
): void {
  ai.maneuver = kind;
  ai.maneuverTimer = duration;
  ai.maneuverSign = rng.chance(0.5) ? -1 : 1;
  // 技量が高いほど短い間隔で機動を挟める
  ai.maneuverCooldown = (duration + 3.2 - ai.skill * 1.6) * cooldownScale;
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
  const want = leaderSpeed / (e.ship!.def.maxSpeed * Math.max(0.01, e.ship!.speedScale)) + (d > 260 ? 0.4 : 0);
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
