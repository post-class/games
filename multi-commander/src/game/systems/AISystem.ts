import { Vector3, Quaternion } from "three";
import type { System } from "../../ecs/System";
import type { World } from "../../ecs/World";
import type { EntityId } from "../../ecs/Entity";
import { Comp, Faction } from "../components";
import type { Transform, ThrusterInput, Targeting, RigidBody, WeaponMount, Health } from "../components";
import type { AIController } from "../components/AIController";
import { isHostile } from "../factions";
import { computeLeadPosition } from "../../hud/ReticleCalc";
import { clamp } from "../../util/math";
import type { MissionManager } from "../mission/MissionManager";
import { DIFFICULTIES, type DifficultyMods } from "../Settings";

const dirWorld = new Vector3();
const dirLocal = new Vector3();
const invQ = new Quaternion();
const fwdZ = new Vector3(0, 0, 1);
const slotWorld = new Vector3();
const leadPos = new Vector3();
const zeroVel = new Vector3();
const toTarget = new Vector3();

/** 回避機動の定義: ThrusterInput への反映と持続時間。 */
interface EvadeManeuver {
  /** 機動名 (ログ/デバッグ用)。 */
  name: string;
  /** 機動の想定継続時間(秒)。経過後 Pursue へ戻る。 */
  duration: number;
  /**
   * 機動を ThrusterInput に反映する関数。
   * ctx: 敵との方向・距離など、t: 自機Transform、ti: 入力、stateTimer: Evade入場からの経過時間。
   */
  apply: (ctx: AIContext, t: Transform, ti: ThrusterInput, stateTimer: number, skill: number) => void;
}

/** 機動ライブラリ。状況に応じて Evade 入場時に選択される。 */
const EVASIVE_MANEUVERS: Record<string, EvadeManeuver> = {
  /** 敵と反対方向へ急旋回して離脱 (至近距離で有効)。 */
  break: {
    name: "break",
    duration: 1.8,
    apply: (ctx, t, ti, _stateTimer, skill) => {
      if (!ctx.targetPos) return;
      // 敵の反対方向へ機首を向ける入力 (ローカル座標で反転)。
      toTarget.copy(ctx.targetPos).sub(t.position).normalize().negate();
      invQ.copy(t.quaternion).conjugate();
      dirLocal.copy(toTarget).applyQuaternion(invQ);
      const yawErr = Math.atan2(dirLocal.x, dirLocal.z);
      const pitchErr = Math.atan2(dirLocal.y, dirLocal.z);
      // 技量が低いと入力に微小ノイズを加える (精度低下)。
      const noise = (1 - skill) * 0.15 * (Math.random() - 0.5);
      ti.angular.x = clamp(pitchErr * 2.5 + noise, -1, 1);
      ti.angular.y = clamp(yawErr * 2.5 + noise, -1, 1);
      ti.linear.z = 1;
      ti.afterburner = true;
    },
  },
  /** 小刻みに機首を振って弾を避ける (被弾中に有効)。 */
  jink: {
    name: "jink",
    duration: 1.2,
    apply: (_ctx, _t, ti, stateTimer, skill) => {
      // 周期的に pitch/yaw を反転させる (サイン波)。
      const freq = 3.5 + skill * 1.5; // 技量高いほど高周波で機敏。
      const phase = stateTimer * freq * Math.PI;
      const amp = 0.7 + skill * 0.2; // 技量高いほど振幅大。
      ti.angular.x = Math.sin(phase) * amp;
      ti.angular.y = Math.cos(phase * 1.3) * amp; // 位相をずらして不規則に。
      ti.linear.z = 0.9;
      ti.afterburner = false;
    },
  },
  /** ロールしながら前進 (弾幕をかわしつつ距離を維持)。 */
  barrelRoll: {
    name: "barrelRoll",
    duration: 2.0,
    apply: (_ctx, _t, ti, stateTimer, skill) => {
      // ロール入力 + 軽い pitch で螺旋軌道。
      const rollSpeed = 1.8 + skill * 0.5;
      ti.angular.z = rollSpeed;
      ti.angular.x = 0.3 * Math.sin(stateTimer * rollSpeed * Math.PI);
      ti.linear.z = 0.85;
      ti.afterburner = false;
    },
  },
  /** 全開+ABで距離を取り仕切り直し (劣勢時)。 */
  extend: {
    name: "extend",
    duration: 2.5,
    apply: (ctx, t, ti, _stateTimer, skill) => {
      // 敵から遠ざかる方向へ機首を向けつつ全開加速。
      if (!ctx.targetPos) {
        ti.linear.z = 1;
        ti.afterburner = true;
        return;
      }
      toTarget.copy(ctx.targetPos).sub(t.position).normalize().negate();
      invQ.copy(t.quaternion).conjugate();
      dirLocal.copy(toTarget).applyQuaternion(invQ);
      const yawErr = Math.atan2(dirLocal.x, dirLocal.z);
      const pitchErr = Math.atan2(dirLocal.y, dirLocal.z);
      const noise = (1 - skill) * 0.1 * (Math.random() - 0.5);
      ti.angular.x = clamp(pitchErr * 2.0 + noise, -1, 1);
      ti.angular.y = clamp(yawErr * 2.0 + noise, -1, 1);
      ti.linear.z = 1;
      ti.afterburner = true;
    },
  },
};

interface AIContext {
  hasTarget: boolean;
  distance: number;
  aimDot: number;
  targetPos: Vector3 | null;
}

/** 編隊スロットの機体ローカルオフセット (プレイヤー基準)。 */
const FORMATION_SLOTS: Array<[number, number, number]> = [
  [-45, 3, -30],
  [45, 3, -30],
  [-80, 6, -60],
  [80, 6, -60],
];

/**
 * AI システム。
 * - enemy: 自律的に最至近の敵対機を追尾・攻撃・回避する FSM。
 * - ally (僚機): 指示 (engage/formUp/attackTarget) に従う。敵がいなければ編隊で追従。
 * プレイヤー/敵/僚機すべて共通の ThrusterInput を出力し、FlightModelSystem が処理する。
 */
export class AISystem implements System {
  readonly name = "AISystem";

  /** @param mission 難易度補正 (maxSimultaneousAttackers/enemyAccuracyMul) の参照元。省略時は normal 相当。 */
  constructor(private readonly mission?: MissionManager) {}

  update(world: World, dt: number): void {
    const player = this.findPlayer(world);
    const mods = this.mission?.getMods() ?? DIFFICULTIES.normal;
    const entities = world.query(
      Comp.AIController,
      Comp.Transform,
      Comp.ThrusterInput,
      Comp.Faction,
    );
    for (const entity of entities) {
      const ai = world.getOrThrow<AIController>(entity, Comp.AIController);
      const t = world.getOrThrow<Transform>(entity, Comp.Transform);
      const ti = world.getOrThrow<ThrusterInput>(entity, Comp.ThrusterInput);
      const myFaction = world.getOrThrow<Faction>(entity, Comp.Faction);
      ai.stateTimer += dt;

      this.resetInput(ti);

      if (ai.role === "ally") {
        this.updateAlly(world, entity, ai, t, ti, myFaction, player);
      } else {
        this.updateEnemy(world, entity, ai, t, ti, myFaction, player, mods);
      }
    }
  }

  // ---- enemy ----

  private updateEnemy(
    world: World,
    self: EntityId,
    ai: AIController,
    t: Transform,
    ti: ThrusterInput,
    myFaction: Faction,
    player: EntityId | null,
    mods: DifficultyMods,
  ): void {
    // 士気初期化 (初回のみ)。
    if (ai.morale === undefined) ai.morale = 1.0;

    // 士気計算: HP低下と孤立で低下。
    this.updateMorale(world, self, ai, myFaction);

    // 離脱中は戦闘放棄して逃走。
    if (ai.fleeing) {
      ti.linear.z = 1;
      ti.afterburner = true;
      // 敵から離れる方向へ旋回。
      if (ai.target && this.targetValid(world, ai.target)) {
        const tt = world.getOrThrow<Transform>(ai.target, Comp.Transform);
        toTarget.copy(tt.position).sub(t.position).normalize().negate();
        invQ.copy(t.quaternion).conjugate();
        dirLocal.copy(toTarget).applyQuaternion(invQ);
        ti.angular.y = clamp(Math.atan2(dirLocal.x, dirLocal.z) * 2, -1, 1);
        ti.angular.x = clamp(Math.atan2(dirLocal.y, dirLocal.z) * 2, -1, 1);
      }
      return;
    }

    if (!this.targetValid(world, ai.target)) {
      // 同時攻撃制限: プレイヤーを攻撃中の敵数が上限に達していたら、プレイヤーを新規targetにしない。
      const capReached =
        player !== null &&
        this.countAttackersOnPlayer(world, player) >= mods.maxSimultaneousAttackers;
      ai.target = this.findNearestHostile(
        world,
        self,
        myFaction,
        t.position,
        ai.detectRange,
        capReached ? player : null,
      );
    }
    const ctx = this.buildContext(world, ai.target, t);
    const next = this.transition(ai, ctx);
    this.applyStateChange(next, ai, world, self, ctx);
    this.combatAction(world, self, ai, ctx, ti, t, mods.enemyAccuracyMul);
  }

  /** プレイヤーを target にして Pursue/Attack 中の enemy AI 数。 */
  private countAttackersOnPlayer(world: World, player: EntityId): number {
    let count = 0;
    for (const e of world.query(Comp.AIController)) {
      const ai = world.getOrThrow<AIController>(e, Comp.AIController);
      if (ai.role === "enemy" && ai.target === player && (ai.state === "Pursue" || ai.state === "Attack")) {
        count++;
      }
    }
    return count;
  }

  private updateMorale(world: World, self: EntityId, ai: AIController, myFaction: Faction): void {
    const health = world.get<Health>(self, Comp.Health);
    if (!health) return;

    const hpRatio = (health.shield + health.armor + health.hull) /
      (health.shieldMax + health.armorMax + health.hullMax);

    // HP低下で士気ダメージ。
    const hpPenalty = (1 - hpRatio) * 0.4;

    // 孤立ペナルティ: 味方が少ないほど士気低下。
    const allies = world.query(Comp.Faction, Comp.Health)
      .filter(e => e !== self && world.get<Faction>(e, Comp.Faction) === myFaction);
    const isolationPenalty = allies.length === 0 ? 0.25 : allies.length === 1 ? 0.1 : 0;

    // 技量が高い(エース)ほど士気が維持される。
    const skillBonus = (ai.skill ?? 0.5) * 0.2;

    ai.morale = clamp(1.0 - hpPenalty - isolationPenalty + skillBonus, 0, 1);

    // 士気閾値で離脱判定。
    if (!ai.fleeing && ai.morale < 0.25) {
      ai.fleeing = true;
    }
  }

  // ---- ally (僚機) ----

  private updateAlly(
    world: World,
    self: EntityId,
    ai: AIController,
    t: Transform,
    ti: ThrusterInput,
    myFaction: Faction,
    player: EntityId | null,
  ): void {
    // 指示に応じてターゲットを決定。
    let target: EntityId | null = null;
    if (ai.order === "attackTarget" && player !== null) {
      const pt = world.get<Targeting>(player, Comp.Targeting);
      const cand = pt?.target ?? null;
      target = this.hostileOrNull(world, myFaction, cand);
      if (target === null) {
        target = this.findNearestHostile(world, self, myFaction, t.position, ai.detectRange);
      }
    } else if (ai.order === "engage") {
      if (!this.targetValid(world, ai.target)) {
        ai.target = this.findNearestHostile(world, self, myFaction, t.position, ai.detectRange);
      }
      target = ai.target;
    }
    // formUp は交戦しない。

    if (target !== null && ai.order !== "formUp") {
      ai.target = target;
      const ctx = this.buildContext(world, target, t);
      const next = this.transition(ai, ctx);
      this.applyStateChange(next, ai, world, self, ctx);
      this.combatAction(world, self, ai, ctx, ti, t);
      return;
    }

    // 交戦対象なし → 編隊追従。
    ai.target = null;
    ai.state = "Form";
    if (player !== null && world.has(player, Comp.Transform)) {
      this.formationFollow(world, self, ai, t, ti, player);
    } else {
      ti.linear.z = 0; // プレイヤー不在時は停止気味。
    }
  }

  private formationFollow(
    world: World,
    self: EntityId,
    ai: AIController,
    t: Transform,
    ti: ThrusterInput,
    player: EntityId,
  ): void {
    const rb = world.getOrThrow<RigidBody>(self, Comp.RigidBody);
    const pt = world.getOrThrow<Transform>(player, Comp.Transform);
    const slot = FORMATION_SLOTS[ai.formationSlot % FORMATION_SLOTS.length];
    slotWorld.set(slot[0], slot[1], slot[2]).applyQuaternion(pt.quaternion).add(pt.position);
    dirWorld.copy(slotWorld).sub(t.position);
    const dist = dirWorld.length();

    if (dist > 8) {
      dirWorld.divideScalar(dist);
      this.aimAt(t, dirWorld, ti, rb.angularVelocity);
      // 距離に応じてスロットル。遠いほど速く。
      ti.linear.z = dist > 200 ? 1 : dist > 60 ? 0.7 : 0.3;
      if (dist > 400) ti.afterburner = true;
    } else {
      // スロット到達: プレイヤーの機首方向に合わせて整列。
      this.aimAt(t, fwdZ.clone().applyQuaternion(pt.quaternion), ti, rb.angularVelocity);
      ti.linear.z = 0.25;
    }
  }

  // ---- 共通ヘルパー ----

  private resetInput(ti: ThrusterInput): void {
    ti.linear.set(0, 0, 0);
    ti.angular.set(0, 0, 0);
    ti.afterburner = false;
    ti.firePrimary = false;
    ti.fireMissile = false;
  }

  private findPlayer(world: World): EntityId | null {
    const players = world.query(Comp.PlayerControlled, Comp.Transform);
    return players.length > 0 ? players[0] : null;
  }

  private targetValid(world: World, target: EntityId | null): boolean {
    return target !== null && world.isAlive(target) && world.has(target, Comp.Transform);
  }

  private hostileOrNull(world: World, myFaction: Faction, target: EntityId | null): EntityId | null {
    if (!this.targetValid(world, target)) return null;
    const f = world.get<Faction>(target!, Comp.Faction);
    return f !== undefined && isHostile(myFaction, f) ? target : null;
  }

  private findNearestHostile(
    world: World,
    self: EntityId,
    myFaction: Faction,
    pos: Vector3,
    range: number,
    exclude?: EntityId | null,
  ): EntityId | null {
    let best: EntityId | null = null;
    let bestDist = range * range;
    for (const e of world.query(Comp.Transform, Comp.Health, Comp.Faction)) {
      if (e === self) continue;
      if (exclude !== undefined && exclude !== null && e === exclude) continue;
      const f = world.getOrThrow<Faction>(e, Comp.Faction);
      if (!isHostile(myFaction, f)) continue;
      const tt = world.getOrThrow<Transform>(e, Comp.Transform);
      const d = tt.position.distanceToSquared(pos);
      if (d < bestDist) {
        bestDist = d;
        best = e;
      }
    }
    return best;
  }

  private buildContext(world: World, target: EntityId | null, t: Transform): AIContext {
    if (!this.targetValid(world, target)) {
      return { hasTarget: false, distance: Infinity, aimDot: -1, targetPos: null };
    }
    const tt = world.getOrThrow<Transform>(target!, Comp.Transform);
    dirWorld.copy(tt.position).sub(t.position);
    const distance = dirWorld.length();
    if (distance > 1e-3) dirWorld.divideScalar(distance);
    const fwd = fwdZ.clone().applyQuaternion(t.quaternion);
    const aimDot = dirWorld.dot(fwd);
    return { hasTarget: true, distance, aimDot, targetPos: tt.position };
  }

  private transition(controller: AIController, ctx: AIContext): AIController["state"] {
    return evaluateTransition(controller, ctx);
  }

  /**
   * 状況に応じて回避機動を選択する (Evade入場時)。
   * - 至近距離: break (反対方向へ急旋回)
   * - 被弾中/中距離: jink (小刻みに機首を振る) または barrelRoll (ロール回避)
   * - 劣勢/遠距離: extend (全開で距離を取る)
   */
  private selectEvadeManeuver(_ai: AIController, ctx: AIContext, world: World, self: EntityId): string {
    const health = world.get<{ current: number; max: number }>(self, Comp.Health);
    const hpRatio = health ? health.current / health.max : 1.0;
    const dist = ctx.distance;
    const rand = Math.random();

    // 至近距離 (<150m) は break 優先。
    if (dist < 150) {
      return rand < 0.7 ? "break" : "jink";
    }
    // 被弾して HP 50% 以下なら jink で弾避け優先。
    if (hpRatio < 0.5) {
      return rand < 0.6 ? "jink" : "barrelRoll";
    }
    // 劣勢 (HP 70% 以下) または遠距離 (>400m) は extend で離脱。
    if (hpRatio < 0.7 || dist > 400) {
      return rand < 0.7 ? "extend" : "break";
    }
    // 中距離・互角: jink/barrelRoll をランダム。
    return rand < 0.5 ? "jink" : "barrelRoll";
  }

  private applyStateChange(newState: AIController["state"], ai: AIController, world: World, self: EntityId, ctx: AIContext): void {
    if (newState !== ai.state) {
      ai.state = newState;
      ai.stateTimer = 0;
      if (newState === "Evade") {
        // 機動選択 (旧 evadeDir 乱数は廃止)。
        ai.evadeManeuver = this.selectEvadeManeuver(ai, ctx, world, self);
        ai.evadeDir = null; // 機動ライブラリ側で制御するため不要。
      }
    }
  }

  /**
   * dirNorm (ワールド系の目標方向) へ機首を向ける PD 制御。
   * 比例項で角度誤差を詰め、微分項 (現在の角速度) でオーバーシュート/スパイラルを抑える。
   * angVel は機体ローカル角速度 (x=pitch, y=yaw)。
   */
  private aimAt(t: Transform, dirNorm: Vector3, ti: ThrusterInput, angVel: Vector3): void {
    invQ.copy(t.quaternion).conjugate();
    dirLocal.copy(dirNorm).applyQuaternion(invQ);
    // 機体ローカルでの目標方位角。z=前方, x=右, y=上。
    const yawErr = Math.atan2(dirLocal.x, dirLocal.z); // + = 目標が右
    const pitchErr = Math.atan2(dirLocal.y, dirLocal.z); // + = 目標が上
    const Kp = 2.4;
    const Kd = 0.45;
    // ダンピング項の符号は各軸の「入力→機首回転」の向きに合わせる。
    // ピッチは物理側で符号反転しているため +angVel.x、ヨーは -angVel.y。
    ti.angular.x = clamp(pitchErr * Kp + angVel.x * Kd, -1, 1);
    ti.angular.y = clamp(yawErr * Kp - angVel.y * Kd, -1, 1);
  }

  private combatAction(
    world: World,
    self: EntityId,
    ai: AIController,
    ctx: AIContext,
    ti: ThrusterInput,
    t: Transform,
    accuracyMul = 1.0,
  ): void {
    if (!ctx.hasTarget || !ctx.targetPos) {
      ti.linear.z = 0.3;
      return;
    }

    // 技量の導出 (未設定時は aggression から)。
    const skill = ai.skill !== undefined ? ai.skill : 0.4 + ai.aggression * 0.5;

    if (ai.state === "Evade") {
      // 機動ライブラリを使用 (旧 evadeDir 方式は廃止)。
      const maneuver = ai.evadeManeuver ? EVASIVE_MANEUVERS[ai.evadeManeuver] : undefined;
      if (maneuver) {
        maneuver.apply(ctx, t, ti, ai.stateTimer, skill);
      } else {
        // フォールバック (未定義時は全開離脱)。
        ti.linear.z = 1;
        ti.afterburner = true;
      }
      return;
    }

    // 偏差射撃: ターゲット速度と弾速から命中予測点を求め、そこへ機首を向ける。
    const rb = world.getOrThrow<RigidBody>(self, Comp.RigidBody);
    const wm = world.get<WeaponMount>(self, Comp.WeaponMount);
    const gunSpeed = wm ? wm.gunProjectileSpeed : 1300;
    const trb = ai.target !== null ? world.get<RigidBody>(ai.target, Comp.RigidBody) : undefined;
    const tvel = trb ? trb.velocity : zeroVel;
    computeLeadPosition(t.position, gunSpeed, ctx.targetPos, tvel, leadPos);

    dirWorld.copy(leadPos).sub(t.position).normalize();
    this.aimAt(t, dirWorld, ti, rb.angularVelocity);
    const fwd = fwdZ.clone().applyQuaternion(t.quaternion);
    const leadDot = dirWorld.dot(fwd);

    // Attack 中にたまに軽い jink を混ぜて直線的すぎない動き (10%の確率で微小な振動)。
    if (ai.state === "Attack" && Math.random() < 0.1) {
      const jinkAmp = 0.15 * skill; // 技量高いほど振幅小 (精密)。
      ti.angular.x += (Math.random() - 0.5) * jinkAmp;
      ti.angular.y += (Math.random() - 0.5) * jinkAmp;
    }

    // ジョスト方式のスロットル制御:
    // - 至近距離で減速して団子化するのを避け、全速で突き抜けて離脱 (extension)。
    // - 中距離 (射撃帯) では速度を抑えて機首を合わせやすくする。
    // - 遠距離では全開で接近。
    // 近距離戦重視: 標的の見かけ角度が大きく命中しやすい ~300m 帯で戦う。
    const firingBand = Math.min(ai.attackRange * 0.22, 320);
    if (ctx.distance < 130) {
      // 至近でのマージは突き抜けて離脱 (次のパスへ)。
      ti.linear.z = 1;
      ti.afterburner = true;
    } else if (ctx.distance > firingBand * 1.3) {
      ti.linear.z = 1;
      if (ctx.distance > ai.attackRange * 0.7) ti.afterburner = true;
    } else {
      // 射撃帯では減速して機首を合わせ続ける。
      ti.linear.z = 0.35;
    }

    // 予測点に機首が合っていて射撃帯内なら発砲。
    // 技量が低いほど閾値を緩める (0.96 → 0.92 程度)。技量高いほど厳しく (0.96 → 0.97)。
    const skillThreshold = 0.96 + (skill - 0.5) * 0.02; // skill=0→0.95, skill=1→0.97
    // 難易度の enemyAccuracyMul を許容誤差 (1-threshold) に掛ける。
    // Easy(0.5)は許容誤差が半分になり閾値が上がって発砲機会が減る (下手になる)。
    // Hard(1.3)は許容誤差が広がり閾値が下がって発砲機会が増える (上手くなる)。
    const leadThreshold = 1 - (1 - skillThreshold) * accuracyMul;
    if (leadDot > leadThreshold && ctx.distance < firingBand * 2) {
      ti.firePrimary = true;
    }

    // 中距離で正面を捉えたらミサイルを撃つ (残弾/クールダウンは WeaponSystem が管理)。
    if (wm && wm.missiles > 0 && leadDot > 0.9 && ctx.distance > 250 && ctx.distance < 1400) {
      ti.fireMissile = true;
    }
  }
}

/** 状態遷移の純関数。現状態とコンテキストから次状態を返す。 */
export function evaluateTransition(controller: AIController, ctx: AIContext): AIController["state"] {
  if (!ctx.hasTarget) return "Idle";

  switch (controller.state) {
    case "Idle":
    case "Form":
      return "Pursue";
    case "Pursue":
      if (ctx.aimDot > 0.9 && ctx.distance < controller.attackRange) return "Attack";
      return "Pursue";
    case "Attack":
      if (controller.stateTimer > 3 + controller.aggression * 2 && ctx.distance < controller.attackRange * 0.45) {
        return "Evade";
      }
      if (ctx.aimDot < 0.55 || ctx.distance > controller.attackRange * 1.25) return "Pursue";
      return "Attack";
    case "Evade": {
      // 機動ごとの持続時間を参照 (未定義時は 1.5秒)。
      const maneuver = controller.evadeManeuver ? EVASIVE_MANEUVERS[controller.evadeManeuver] : undefined;
      const duration = maneuver ? maneuver.duration : 1.5;
      if (controller.stateTimer > duration) return "Pursue";
      return "Evade";
    }
    default:
      return "Pursue";
  }
}
