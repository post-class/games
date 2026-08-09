/**
 * システム 7/14: combat — 攻撃判定・投射物・ダメージ（`07§6`, 実装手順書 §6.4）
 *
 * 責務:
 *  - クールダウン（`cooldown`）の減算と攻撃の発生（T-M7-01）。
 *  - 投射物（`core/projectile.ts`）の飛翔と着弾（T-M7-01）。
 *  - ダメージ計算（`core/damage.ts` の純関数を呼ぶだけ。T-M7-02〜06）。
 *  - 祈祷師の治療（T-M7-08）。
 *  - 与ダメージ / 被ダメージを戦域のリングバッファに積む（優勢度の材料）。
 *  - HP 0 のエンティティを `markDeadIndex` で死亡予約する（解放は cleanup）。
 *
 * 乱数は使わない。**命中は確定**（`07§6` に外れ判定が無い）ので、
 * このシステムは `w.rngCombat` を 1 度も消費しない。
 * 将来クリティカル等を入れる場合のみ `rngCombat` を使うこと（`rngAi` / `rngMap` は禁止。§4.3）。
 *
 * 担当マイルストーン: **M7**（T-M7-01〜08）。
 *
 * 決定論の注意:
 *  - 反復は index 昇順。距離は平方距離で比較する。
 *  - 目標選択のタイブレークは「平方距離が小さい方 → index が小さい方」。
 *  - ダメージは Fx の整数演算のみ。倍率の適用順は `damage.ts` に固定してある。
 *
 * 目標選択の分担:
 *  本来の目標選択は `unitDecision`（M8/M9）の仕事で、combat は `target` を尊重する。
 *  ただし `target` が無効・射程外のときは **射程内の最も近い敵** に応戦する
 *  （`07§3`「スロット不足」の既定行動と同じ。これがあるので M9 の前でも戦闘が成立する）。
 */

import type { EntityId, PlayerId } from '@/shared/types';
import { EntityKind, NEUTRAL_OWNER, RESOURCE_COUNT } from '@/shared/types';
import type { Fx } from '../core/fx';
import { FX_ONE, fx, fxMul, fxToInt, idiv, isqrt } from '../core/fx';
import {
  ADVANTAGE_WINDOW_TICKS,
  areAllies,
  getFront,
  getPlayer,
  type Front,
  type World,
} from '../core/world';
import { UnitState, entityIndex, idOfIndex, isAlive, markDeadIndex } from '../core/entity';
import {
  ORDER_DEFS,
  UNIT_DEFS,
  buildingDef,
  orderDefById,
  roleToIndex,
  unitDef,
} from '../core/defs';
import { cellCol, cellRow, queryCircle } from '../core/grid';
import { elevationAt, isForest, isPassable, isWet } from '../core/terrain';
import {
  Formation,
  type DamageModifiers,
  type FormationId,
  NO_MODIFIERS,
  computeDamage,
  formationFromString,
  friendlyFireDamage,
  rangeWithTerrain,
} from '../core/damage';
import { TICK_RATE, cfgArray, cfgFx, cfgInt, cfgNum } from '../core/config';
import {
  type OrderPair,
  NO_ORDERS,
  buildingDamageMulOf,
  damageTakenMulOf,
  hasPushThrough,
  hasWaterAssault,
  killIncomeIncludesBuildings,
  killIncomeRatioOf,
  orderPairFor,
  orderPairOfEntity,
  waterAssaultDamageMul,
  waterAssaultIgnoresLowGround,
} from '../core/orderEffects';
import {
  isProjectileAttackClass,
  shooterElevationOf,
  spawnProjectile,
  stepProjectiles,
} from '../core/projectile';

/** 建物が攻撃側になるときの role（相性表の `building` 行 = すべて等倍）。 */
const BUILDING_ROLE = roleToIndex('building');

/** 治療（祈祷師）を持つ trait 名。`units.json` の `traits`。 */
const TRAIT_HEAL = 'heal';

/** 範囲攻撃が味方も削る trait 名（投石系。`07§6` 友軍被害）。 */
const TRAIT_FRIENDLY_FIRE = 'friendly_fire';

// ---------------------------------------------------------------- 特性（traits）の表
//
// `03§8` の「輪をどう破るか」の列がそのまま仕様。
// **ユニットの名前では絶対に分岐しない。** `units.json` の `traits` の名前だけで分岐し、
// 数値は `config.json` の `traits.*` から引く（手順書 §0.5）。
// 判定を毎撃 `traits.includes()` で行うと文字列比較が積み上がるので、
// 読み込み時に typeId → ビットの表に落としてある（`movement.ts` の速度表と同じ手法）。

const TRAIT_BIT = {
  /** 時間とともに自己回復する（ベルセルク）。 */
  SelfHeal: 1 << 0,
  /** 1 回の射撃で複数の矢を放つ（連弩兵）。 */
  MultiShot: 1 << 1,
  /** 他国のエリートに対して攻撃が大きく上がる（武士）。 */
  AntiElite: 1 << 2,
  /** 他の近接歩兵に対する攻撃が非常に高い（ジャガー戦士）。 */
  AntiInfantry: 1 << 3,
  /** 建物へのダメージが大きい（火矢兵）。 */
  AntiBuilding: 1 << 4,
  /** 同種が隣に並ぶほど防御が上がる（レギオン）。 */
  FormationDefense: 1 << 5,
  /** 周囲の敵をまとめて弾く（戦象・親衛象）。 */
  Knockback: 1 << 6,
  /** 移動しながら射撃できる（親衛弓騎兵）。 */
  MoveAndShoot: 1 << 7,
} as const;

/** trait 名 → ビット。ここに 1 行足せば新しい特性が読める。 */
const TRAIT_NAME_TO_BIT: readonly (readonly [string, number])[] = [
  ['self_heal', TRAIT_BIT.SelfHeal],
  ['multi_shot', TRAIT_BIT.MultiShot],
  ['anti_elite', TRAIT_BIT.AntiElite],
  ['anti_infantry', TRAIT_BIT.AntiInfantry],
  ['anti_building', TRAIT_BIT.AntiBuilding],
  ['formation_defense', TRAIT_BIT.FormationDefense],
  ['knockback', TRAIT_BIT.Knockback],
  ['move_and_shoot', TRAIT_BIT.MoveAndShoot],
];

/** typeId → 特性ビット。`UNIT_DEFS` の index 昇順で作る。 */
const TRAIT_BITS: Uint8Array = buildTraitBits();

function buildTraitBits(): Uint8Array {
  const out = new Uint8Array(UNIT_DEFS.length);
  for (let t = 0; t < UNIT_DEFS.length; t++) {
    let bits = 0;
    const traits = UNIT_DEFS[t]!.traits;
    for (let k = 0; k < TRAIT_NAME_TO_BIT.length; k++) {
      const [name, bit] = TRAIT_NAME_TO_BIT[k]!;
      if (traits.includes(name)) bits |= bit;
    }
    out[t] = bits;
  }
  return out;
}

/** そのユニット typeId が特性ビットを持つか。 */
function hasTrait(typeId: number, bit: number): boolean {
  return typeId < TRAIT_BITS.length && (TRAIT_BITS[typeId]! & bit) !== 0;
}

/** `units.json` の `line` が elite の兵か（`anti_elite` の相手判定。名前では判定しない）。 */
const LINE_ELITE = 'elite';

/** 特性のパラメータ（`config.json` の `traits.*`）。1 度だけ読む。 */
interface TraitParams {
  readonly antiEliteAtkMul: Fx;
  readonly antiInfantryAtkMul: Fx;
  /** 「近接歩兵」とみなす role index の集合（`traits.antiInfantryRoles`）。 */
  readonly antiInfantryRoles: Uint8Array;
  readonly antiBuildingDamageMul: Fx;
  readonly formationDefenseRadius: Fx;
  readonly formationDefenseArmorPerAlly: Fx;
  readonly formationDefenseMaxAllies: number;
  readonly multiShotArrows: number;
  readonly selfHealPerSec: Fx;
  readonly knockbackDist: Fx;
  readonly movingShotCooldownMul: Fx;
}

let traitCache: TraitParams | null = null;

function traits(): TraitParams {
  if (traitCache !== null) return traitCache;
  const roles = new Uint8Array(64);
  for (const r of cfgArray('traits.antiInfantryRoles')) {
    const idx = roleToIndex(String(r));
    if (idx < roles.length) roles[idx] = 1;
  }
  traitCache = {
    antiEliteAtkMul: cfgFx('traits.antiEliteAtkMul'),
    antiInfantryAtkMul: cfgFx('traits.antiInfantryAtkMul'),
    antiInfantryRoles: roles,
    antiBuildingDamageMul: cfgFx('traits.antiBuildingDamageMul'),
    formationDefenseRadius: cfgFx('traits.formationDefenseRadiusTiles'),
    formationDefenseArmorPerAlly: cfgFx('traits.formationDefenseArmorPerAlly'),
    formationDefenseMaxAllies: cfgInt('traits.formationDefenseMaxAllies'),
    multiShotArrows: cfgInt('traits.multiShotArrows'),
    selfHealPerSec: cfgFx('traits.selfHealHpPerSec'),
    knockbackDist: cfgFx('traits.knockbackTiles'),
    movingShotCooldownMul: cfgFx('traits.movingShotCooldownMul'),
  };
  return traitCache;
}

/** テスト用。config を差し替えたときに呼ぶ。 */
export function resetCombatTraitCache(): void {
  traitCache = null;
}

/**
 * 近接攻撃の間合い（Fx）。`config.json` に項目が無いので既定値付きで引く
 * （`combat.meleeReachTiles` を追加してほしい。M7 の申し送り）。
 * 1 マス = 村人 1 体分の幅（`07§1`）なので、隣接 = 1 マスで届く。
 */
function meleeReach(): Fx {
  return fx(cfgNum('combat.meleeReachTiles'));
}

/**
 * 祈祷師 1 回の治療量（Fx の HP）。`config.json` に項目が無いので既定値付き
 * （`combat.healPerAction` を追加してほしい。M7 の申し送り）。
 * 既定 5 HP / 2 秒 = 2.5 HP/秒。歩兵の攻撃力（5〜12）より小さく、
 * 「削り合いを引き延ばすが押し切れる」量に置いている。
 */
function healPerAction(): Fx {
  return fx(cfgNum('combat.healPerAction'));
}

/**
 * 「射程内に敵がいなかった」ときに次の全周探索まで待つ tick 数。
 *
 * `queryCircle` は 1 回あたり 9 セル分を走査するので、
 * **目標を見つけられないユニットが毎 tick 探索すると、これが combat の支配的コストになる**
 * （1600 体の空回しで 1 tick 4ms を超えた）。空振りしたら 12 tick（約 0.5 秒 =
 * `unitDecision` の再選択周期）待つ。乱数ではなく固定間隔なので決定論は保たれる。
 *
 * 待ち時間の実体は `cooldown`（= 次に攻撃を試みるまでの tick）に入れる。
 * 専用の列を SoA に足さずに済ませるため。
 */
function scanBackoffTicks(): number {
  return Math.trunc(cfgNum('combat.targetScanIntervalTicks'));
}

export function combat(w: World): void {
  const e = w.entities;

  // 1) 戦域リングバッファの「今 tick のスロット」を空にする。
  //    ここを忘れると 250 tick 前の値が足し込まれて優勢度が壊れる。
  prepareFrontRings(w);

  // 2) 先に既存の投射物を進める。今 tick に撃つ弾を同じ tick で着弾させないため、
  //    攻撃サイクル（3）より前に置く。
  stepProjectiles(e, w.tick, (pi) => {
    applyProjectileImpact(w, pi);
  });

  // 3) 攻撃サイクル。index 昇順。
  for (let i = 0; i < e.highWater; i++) {
    if (e.alive[i] !== 1) continue;
    const kind = e.kind[i]!;
    if (kind === EntityKind.Unit) {
      selfHealTick(w, i);
      unitAttackCycle(w, i);
    } else if (kind === EntityKind.Building) {
      buildingAttackCycle(w, i);
    }
  }
}

// ---------------------------------------------------------------- 戦域の集計

/**
 * リングバッファの書き込み位置を今 tick に合わせ、そのスロットを 0 にする。
 *
 * **毎 tick 必ず 0 にする。** 250 tick（10 秒）で 1 周するので、消さないと
 * 10 秒前の値に足し込んでしまい優勢度が際限なく膨らむ。
 * combat より前に damage を積むシステムは存在しないので、ここで消して安全。
 * 冪等なので M8（frontLifecycle）が同じことをしても問題ない。
 */
function prepareFrontRings(w: World): void {
  const pos = w.tick % ADVANTAGE_WINDOW_TICKS;
  for (let s = 0; s < w.fronts.length; s++) {
    const f = w.fronts[s]!;
    if (!f.active) continue;
    f.ringPos = pos;
    f.dmgDealt[pos] = 0;
    f.dmgTaken[pos] = 0;
  }
}

/**
 * クールダウンを 1 tick 進める。まだ冷めていなければ true。
 *
 * 「減らしてから 0 かどうかを見る」ので、`attackTicks = 50` なら
 * tick 0 と tick 50 に撃つ（周期がちょうど 50 tick）。
 * 減算前に判定すると 51 tick 周期になり、`attackSec` と一致しなくなる。
 */
function coolingDown(w: World, i: number): boolean {
  const e = w.entities;
  let cd = e.cooldown[i]!;
  if (cd <= 0) return false;
  cd -= 1;
  e.cooldown[i] = cd;
  return cd > 0;
}

/**
 * `frontId`（1..6, 0 = 所属なし）から Front を引く。
 *
 * 戦域はプレイヤーごとに 6 枠あるので、**slot だけでは決まらない**。
 * 所有者も渡す必要がある（`fronts[owner * MAX_FRONTS + (slot - 1)]`）。
 */
function frontOf(w: World, owner: PlayerId, frontId: number): Front | null {
  if (frontId <= 0) return null;
  const f = getFront(w, owner, frontId);
  if (f === undefined || !f.active) return null;
  return f;
}

/**
 * そのエンティティの隊列。
 *
 * 令システム本体は M9 の担当なので、ここは **「front に order があればその formation を読む」**
 * までにとどめる。戦域が閉じた後は `lastOrder`（ユニット側が保持する最後の令）を見る。
 *
 * `morale.ts`（システム 8）も同じ判定が必要なので export している。
 * 判定を 2 箇所に書くと「密集の範囲被害」と「密集の士気維持」がずれる。
 */
export function formationOfEntity(w: World, i: number): FormationId {
  const e = w.entities;
  const f = frontOf(w, e.owner[i]! as PlayerId, e.frontId[i]!);
  if (f !== null && !f.defected) {
    const id = f.order ?? f.orderLower;
    if (id !== null) return formationFromString(orderDefById(id).formation);
  }
  // `lastOrder` は「令 index + 1」（0 = なし）。壊れた値は通常隊列として扱う。
  const last = e.lastOrder[i]!;
  if (last > 0) {
    const d = ORDER_DEFS[last - 1];
    if (d !== undefined) return formationFromString(d.formation);
  }
  return Formation.Normal;
}

// ---------------------------------------------------------------- 攻撃の文脈

/**
 * 1 回の攻撃について「攻撃側が誰で、どこから、どの令の下で撃ったか」をまとめたもの。
 *
 * 投射物の着弾では **射手が既に死んでいることがある**ので、
 * ダメージ計算に必要な攻撃側の情報はここに写し取ってから渡す
 * （射手の index を持ち回すと、死んだ index の再利用で別人の令を読む事故が起きる）。
 */
interface AttackContext {
  /** 攻撃側のユニット typeId。建物の攻撃では -1（特性を持たない）。 */
  readonly typeId: number;
  readonly owner: PlayerId;
  /** 攻撃側の frontId（0 = 戦域外）。与ダメージの集計と令の解決に使う。 */
  readonly frontId: number;
  readonly elevation: number;
  /** 攻撃側に効いている令（上段 + 下段）。 */
  readonly pair: OrderPair;
  /** 攻撃側が浅瀬・湿地に立っているか（令「上陸」の判定）。 */
  readonly onWet: boolean;
  /** 着弾点（`knockback` で弾く向きの基準）。 */
  readonly x: Fx;
  readonly y: Fx;
}

/** 生きているエンティティ（ユニット・建物）から攻撃の文脈を作る。 */
function contextOf(w: World, i: number, isUnit: boolean): AttackContext {
  const e = w.entities;
  const x = e.x[i]!;
  const y = e.y[i]!;
  return {
    typeId: isUnit ? e.typeId[i]! : -1,
    owner: e.owner[i]! as PlayerId,
    frontId: e.frontId[i]!,
    elevation: elevationOf(w, i),
    pair: orderPairOfEntity(w, i),
    onWet: isWet(w.map, fxToInt(x), fxToInt(y)),
    x,
    y,
  };
}

// ---------------------------------------------------------------- 令・特性の補正

/**
 * 令のフラグ（`core/orderEffects.ts`）とユニットの特性を `DamageModifiers` に翻訳する。
 *
 * ここが「令の名前でも兵の名前でも分岐しない」ことの実体:
 *  - 令は `orderEffects` のアクセサ（フラグ名で引く）だけを見る。
 *  - 特性は `TRAIT_BITS`（trait 名から作った表）だけを見る。
 *
 * 何も掛からない一般的な組み合わせでは `NO_MODIFIERS` を返す（確保を避けるため）。
 */
function modifiersFor(w: World, ctx: AttackContext, victimIndex: number): DamageModifiers {
  const e = w.entities;
  const p = traits();
  const victimKind = e.kind[victimIndex]!;
  const victimIsUnit = victimKind === EntityKind.Unit;
  const victimIsBuilding =
    victimKind === EntityKind.Building || victimKind === EntityKind.Attachment;
  const victimPair = orderPairOfEntity(w, victimIndex);

  // ---- 攻撃側の倍率 ----
  let attackerMul = FX_ONE;
  if (ctx.typeId >= 0 && victimIsUnit) {
    const vd = unitDef(e.typeId[victimIndex]!);
    // 武士: 相手が「エリート」系統のときだけ乗る（`03§8`「相手の切り札を名指しで殺す」）。
    if (hasTrait(ctx.typeId, TRAIT_BIT.AntiElite) && vd.line === LINE_ELITE) {
      attackerMul = fxMul(attackerMul, p.antiEliteAtkMul);
    }
    // ジャガー戦士: 相手が近接歩兵の role のときだけ乗る。
    if (
      hasTrait(ctx.typeId, TRAIT_BIT.AntiInfantry) &&
      vd.roleIdx < p.antiInfantryRoles.length &&
      p.antiInfantryRoles[vd.roleIdx] === 1
    ) {
      attackerMul = fxMul(attackerMul, p.antiInfantryAtkMul);
    }
  }
  // 上陸: 水際（浅瀬・湿地）に足を置いて攻めているときだけ「強襲」が乗る。
  const assault = ctx.onWet && hasWaterAssault(ctx.pair);
  if (assault) attackerMul = fxMul(attackerMul, waterAssaultDamageMul());

  // ---- 対建物の倍率（火計 / 火矢兵）----
  let buildingMul = FX_ONE;
  if (victimIsBuilding) {
    buildingMul = buildingDamageMulOf(ctx.pair);
    if (ctx.typeId >= 0 && hasTrait(ctx.typeId, TRAIT_BIT.AntiBuilding)) {
      buildingMul = fxMul(buildingMul, p.antiBuildingDamageMul);
    }
  }

  // ---- 受け側 ----
  const defenderTakenMul = damageTakenMulOf(victimPair);
  const defenderArmorAdd =
    victimIsUnit && hasTrait(e.typeId[victimIndex]!, TRAIT_BIT.FormationDefense)
      ? formationDefenseArmor(w, victimIndex, p)
      : 0;

  const attackerPushThrough = hasPushThrough(ctx.pair);
  const defenderPushThrough = hasPushThrough(victimPair);
  const ignoreLowGround = assault && waterAssaultIgnoresLowGround();

  if (
    attackerMul === FX_ONE &&
    buildingMul === FX_ONE &&
    defenderTakenMul === FX_ONE &&
    defenderArmorAdd === 0 &&
    !attackerPushThrough &&
    !defenderPushThrough &&
    !ignoreLowGround
  ) {
    return NO_MODIFIERS;
  }

  return {
    defenderArmorAdd,
    attackerMul,
    defenderTakenMul,
    buildingMul,
    defenderIsBuilding: victimIsBuilding,
    attackerPushThrough,
    defenderPushThrough,
    attackerIgnoreLowGround: ignoreLowGround,
  };
}

/**
 * レギオンの `formation_defense`（`03§8`「隣に同じレギオンが並ぶほど防御が上がる」）。
 *
 * 半径 `traits.formationDefenseRadiusTiles` 内の **同じ typeId の味方** を数え、
 * `traits.formationDefenseMaxAllies` で打ち切って 1 体あたり
 * `traits.formationDefenseArmorPerAlly` の装甲を加算する。
 * 加算は近接・貫通の両方に効く（`damage.ts` が選んだ装甲に足される）。
 *
 * 「同じ typeId」に限るのは資料の「同じレギオンが並ぶほど」に合わせたもの。
 * 数えるだけ（順序に依存しない加算）なので grid のセルを直接なめてよい。
 */
function formationDefenseArmor(w: World, i: number, p: TraitParams): Fx {
  const e = w.entities;
  const r = p.formationDefenseRadius;
  if (r <= 0 || p.formationDefenseMaxAllies <= 0) return 0;
  const g = w.grid;
  const cx = e.x[i]!;
  const cy = e.y[i]!;
  const rr = r * r;
  const typeId = e.typeId[i]!;
  const owner = e.owner[i]!;
  const c0 = cellCol(g, cx - r);
  const c1 = cellCol(g, cx + r);
  const r0 = cellRow(g, cy - r);
  const r1 = cellRow(g, cy + r);
  let n = 0;
  for (let row = r0; row <= r1; row++) {
    const base = row * g.cols;
    for (let col = c0; col <= c1; col++) {
      const cell = base + col;
      const end = g.cellStart[cell + 1]!;
      for (let k = g.cellStart[cell]!; k < end; k++) {
        const t = g.items[k]!;
        if (t === i) continue;
        if (e.alive[t] !== 1) continue;
        if (e.kind[t] !== EntityKind.Unit) continue;
        if (e.typeId[t] !== typeId) continue;
        if (e.owner[t] !== owner) continue;
        const dx = e.x[t]! - cx;
        const dy = e.y[t]! - cy;
        if (dx * dx + dy * dy > rr) continue;
        n += 1;
        if (n >= p.formationDefenseMaxAllies) {
          row = r1;
          col = c1;
          break;
        }
      }
    }
  }
  return p.formationDefenseArmorPerAlly * n;
}

// ---------------------------------------------------------------- ダメージの適用

/**
 * 実ダメージを 1 体に与える。
 *
 * - HP を減らし、0 以下なら死亡予約（解放は tick 末の cleanup）。
 * - 戦域の与被ダメージリングバッファに積む。
 * - `lastEngageTick` を更新する（戦域の消滅判定に使う）。
 *
 * @param attackerOwner 攻撃側の playerId（戦域はプレイヤーごとに 6 枠あるので slot だけでは引けない）
 * @param attackerFrontId 攻撃側の frontId（0 = 戦域外）
 * @param attackerPair 攻撃側に効いている令（撃破時の資源還元 = 令「奉納」に使う）
 * @param friendly 友軍被害か（true なら「与ダメージ」と「交戦」には数えない）
 */
function dealDamage(
  w: World,
  attackerOwner: PlayerId,
  attackerFrontId: number,
  attackerPair: OrderPair,
  victimIndex: number,
  dmg: Fx,
  friendly: boolean
): void {
  if (dmg <= 0) return;
  const e = w.entities;
  e.hp[victimIndex] = e.hp[victimIndex]! - dmg;

  // 「誰が壊したか」を必ず記録する（掟二・三・五の犯人特定。`core/law.ts`）。
  // **友軍被害でも記録する**: 掟の判定に必要なのは事実であって敵味方の別ではない
  // （自分の投石で自分の井戸を割ったら、割ったのは自分である）。
  e.lastDamagedBy[victimIndex] = attackerOwner;
  e.lastDamagedTick[victimIndex] = w.tick;

  const pos = w.tick % ADVANTAGE_WINDOW_TICKS;

  if (!friendly) {
    const af = frontOf(w, attackerOwner, attackerFrontId);
    if (af !== null) {
      af.dmgDealt[pos] = af.dmgDealt[pos]! + dmg;
      af.lastEngageTick = w.tick;
    }
  }

  const vf = frontOf(w, e.owner[victimIndex]! as PlayerId, e.frontId[victimIndex]!);
  if (vf !== null) {
    vf.dmgTaken[pos] = vf.dmgTaken[pos]! + dmg;
    // 友軍被害は「交戦」ではないので lastEngageTick は動かさない。
    if (!friendly) vf.lastEngageTick = w.tick;
  }

  if (e.hp[victimIndex]! <= 0) {
    e.hp[victimIndex] = 0;
    // 令「奉納」（`killIncomeRatio`）。**死亡予約より前**に呼ぶ（typeId と owner が必要）。
    if (!friendly) applyKillIncome(w, attackerOwner, attackerPair, victimIndex);
    // 建物・付属物の後処理（跡地タイマー・修飾子・戦域スロットの再計算）は
    // ここでは呼ばない。`cleanup` が tick 末に `pendingDead` を 1 回なめて
    // `onBuildingDestroyed` を呼ぶ（死因が増えても呼び忘れ・二重呼びが起きない位置）。
    markDeadIndex(e, victimIndex);
  }
}

/**
 * 令「奉納」（アステカ）: 撃破した敵のコストの `killIncomeRatio` を攻撃側の資源にする。
 *
 * `01` の一行説明は「撃破数が資源に変わる」だけなので、
 * **何が資源になるか**は次のように決めた（`orders.json` の `_meta` にも記録）:
 *  - 対象は **ユニットのみ**（既定）。建物を含めるかは
 *    `orderEffects.killIncomeIncludesBuildings` で切り替えられる。
 *    建物のコストは兵の 10 倍以上あるので、既定で含めると
 *    「攻城のついでに内政が回る」ことになり、下段の令としては強すぎる。
 *  - 還元されるのは **`units.json` のコストと同じ資源の組**（食料で買った兵は食料で返る）。
 *    倍率は 1 つ（`killIncomeRatio`）なので、資源ごとの偏りは兵のコストがそのまま決める。
 *  - 村人・荷車も「撃破」に数える（略奪と組み合わせると収入源になる）。
 */
function applyKillIncome(
  w: World,
  attackerOwner: PlayerId,
  attackerPair: OrderPair,
  victimIndex: number
): void {
  if (attackerPair === NO_ORDERS) return;
  const ratio = killIncomeRatioOf(attackerPair);
  if (ratio <= 0) return;
  const e = w.entities;
  const kind = e.kind[victimIndex]!;
  let cost: Int32Array;
  if (kind === EntityKind.Unit) {
    cost = unitDef(e.typeId[victimIndex]!).cost;
  } else if (kind === EntityKind.Building && killIncomeIncludesBuildings()) {
    cost = buildingDef(e.typeId[victimIndex]!).cost;
  } else {
    return;
  }
  const pl = getPlayer(w, attackerOwner);
  if (pl === undefined) return;
  for (let r = 0; r < RESOURCE_COUNT; r++) {
    const c = cost[r] ?? 0;
    if (c <= 0) continue;
    pl.resources[r] = pl.resources[r]! + fxMul(c, ratio);
  }
}

/** そのエンティティの高さ（立っているタイルの elevation）。 */
function elevationOf(w: World, i: number): number {
  const e = w.entities;
  return elevationAt(w.map, fxToInt(e.x[i]!), fxToInt(e.y[i]!));
}

/** 防御側の装甲と role。建物は `buildings.json` に装甲値が無いので 0。 */
function armorOf(w: World, i: number): { def: Fx; pierceDef: Fx; role: number } {
  const e = w.entities;
  if (e.kind[i] === EntityKind.Unit) {
    const d = unitDef(e.typeId[i]!);
    return { def: d.def, pierceDef: d.pierceDef, role: d.roleIdx };
  }
  // 建物・付属物は HP だけで硬さを表す（`buildings.json` に def が無い）。
  return { def: 0, pierceDef: 0, role: BUILDING_ROLE };
}

/** 攻撃対象になれるか（資源・投射物は対象外。建物は `autoTargetable` に従う）。 */
function isAttackable(w: World, i: number): boolean {
  const e = w.entities;
  const kind = e.kind[i]!;
  if (kind === EntityKind.Unit) return true;
  if (kind === EntityKind.Attachment) return true;
  if (kind === EntityKind.Building) return buildingDef(e.typeId[i]!).autoTargetable;
  return false;
}

/** 敵か（中立は攻撃しない）。 */
function isEnemy(w: World, selfIndex: number, otherIndex: number): boolean {
  const e = w.entities;
  const a = e.owner[selfIndex]!;
  const b = e.owner[otherIndex]!;
  if (a === NEUTRAL_OWNER || b === NEUTRAL_OWNER) return false;
  return !areAllies(w, a, b);
}

// ---------------------------------------------------------------- ユニットの攻撃

function unitAttackCycle(w: World, i: number): void {
  const e = w.entities;

  if (coolingDown(w, i)) return;

  // 退却中（士気 0）と収容中は攻撃しない。
  const st = e.state[i]!;
  if (st === UnitState.Routed || st === UnitState.Garrisoned) return;

  const d = unitDef(e.typeId[i]!);

  // 祈祷師（trait: heal）は攻撃ではなく治療を行う（T-M7-08）。
  if (d.traits.includes(TRAIT_HEAL)) {
    healCycle(w, i, d.range, d.attackTicks);
    return;
  }
  if (d.atk <= 0) return;

  const ranged = d.range > 0;
  // 森の中の遠隔は射程 −25%（式には掛からない補正。`07§6`）。
  const reach = ranged
    ? rangeWithTerrain(d.range, isForest(w.map, fxToInt(e.x[i]!), fxToInt(e.y[i]!)), true)
    : meleeReach();

  const victim = pickVictim(w, i, reach);
  if (victim < 0) {
    // 空振り。次の探索まで待つ（毎 tick 全周探索しないための間引き）。
    e.cooldown[i] = scanBackoffTicks();
    return;
  }

  if (ranged && isProjectileAttackClass(d.attackClass)) {
    shootArrows(w, i, d.attackClass, victim, reach);
  } else {
    // 近接（および射程を持つが投射物を出さない攻撃）は即座に当たる。
    applyUnitHit(w, i, victim, e.x[victim]!, e.y[victim]!);
  }

  e.cooldown[i] = attackCooldownTicks(w, i, d.attackTicks, ranged);
  e.state[i] = UnitState.Attacking;
  e.stateTick[i] = w.tick;
  e.target[i] = idOfIndex(e, victim);
}

/**
 * 次弾までの tick。特性 `move_and_shoot`（親衛弓騎兵）の実装点。
 *
 * `03§8` の「移動しながら射撃でき、減速しない」を、
 * **「移動しながら撃つと次弾が遅れる。この特性を持つ兵だけ遅れない」** と解釈した。
 * 理由:
 *  - 「移動中は撃てない」にすると、遠隔兵が敵へ寄っている間ずっと撃てなくなり、
 *    `unitDecision` が目標の足元を目指す設計（突撃の令）と噛み合わない。
 *  - 「減速しない」の方の解釈（移動速度に補正を入れる）は `movement.ts` の担当で、
 *    combat からは触れない（`speedFactor` は `damage.ts` に用意済み。申し送り参照）。
 *
 * 判定は「この tick に実際に動いたか」（`vx`/`vy` は movement が毎 tick 書く）。
 * 近接は影響しない（間合いに入るには止まるしかないため）。
 */
function attackCooldownTicks(w: World, i: number, base: number, ranged: boolean): number {
  const e = w.entities;
  if (!ranged) return base;
  if (hasTrait(e.typeId[i]!, TRAIT_BIT.MoveAndShoot)) return base;
  if (e.vx[i] === 0 && e.vy[i] === 0) return base;
  const t = idiv(base * traits().movingShotCooldownMul, FX_ONE);
  return t > base ? t : base;
}

/**
 * 矢を放つ。特性 `multi_shot`（連弩兵）の実装点。
 *
 * `03§8`「1 回の射撃で複数の矢を放つ / 密集した近接歩兵を一方的に処理する」を
 * **「射程内の別々の敵へ最大 `traits.multiShotArrows` 本を同時に放つ」** と解釈した。
 * 同じ敵に複数本当てる解釈にすると単体 DPS が丸ごと 3 倍になり、
 * 「密集した歩兵に効く」という資料の狙い（＝敵が多いほど強い）から外れる。
 * 敵が 1 体しかいなければ 1 本しか出ない。
 */
function shootArrows(
  w: World,
  i: number,
  attackClass: string,
  primaryVictim: number,
  reach: Fx
): void {
  const e = w.entities;
  const elevation = elevationOf(w, i);
  const emit = (victim: number): void => {
    spawnProjectile(e, {
      owner: e.owner[i]!,
      shooterTypeId: e.typeId[i]!,
      shooterId: idOfIndex(e, i),
      attackClass,
      x: e.x[i]!,
      y: e.y[i]!,
      targetId: idOfIndex(e, victim),
      targetX: e.x[victim]!,
      targetY: e.y[victim]!,
      shooterElevation: elevation,
      tick: w.tick,
    });
  };

  emit(primaryVictim);
  if (!hasTrait(e.typeId[i]!, TRAIT_BIT.MultiShot)) return;

  const limit = traits().multiShotArrows;
  if (limit <= 1) return;
  // 追加の矢は「主目標以外の、射程内で近い順」に配る。
  // 走査は index 昇順で、選択は (平方距離, index) の全順序なので順序依存はない。
  const out = w.scratch.neighbors;
  const n = queryCircle(w.grid, e, e.x[i]!, e.y[i]!, reach, out);
  let fired = 1;
  let prevSq = -1;
  let prevIdx = -1;
  while (fired < limit) {
    let best = -1;
    let bestSq = 0;
    for (let k = 0; k < n; k++) {
      const t = out[k]!;
      if (t === i || t === primaryVictim) continue;
      if (e.alive[t] !== 1) continue;
      if (!isAttackable(w, t)) continue;
      if (!isEnemy(w, i, t)) continue;
      const dx = e.x[t]! - e.x[i]!;
      const dy = e.y[t]! - e.y[i]!;
      const sq = dx * dx + dy * dy;
      // 既に矢を配った相手（= 直前までに選ばれた順位）を飛ばす。
      if (sq < prevSq || (sq === prevSq && t <= prevIdx)) continue;
      if (best >= 0 && (sq > bestSq || (sq === bestSq && t > best))) continue;
      best = t;
      bestSq = sq;
    }
    if (best < 0) return;
    emit(best);
    prevSq = bestSq;
    prevIdx = best;
    fired += 1;
  }
}

/**
 * 攻撃対象を決める。
 *  1. `target`（unitDecision が入れた目標）が有効で射程内ならそれ。
 *  2. なければ射程内の最も近い敵（平方距離 → index のタイブレーク）。
 * 戻り値は index。見つからなければ -1。
 */
function pickVictim(w: World, i: number, reach: Fx): number {
  const e = w.entities;
  const cx = e.x[i]!;
  const cy = e.y[i]!;
  const rr = reach * reach;

  const assigned: EntityId = e.target[i]!;
  if (isAlive(e, assigned)) {
    const t = entityIndex(assigned);
    if (t !== i && isAttackable(w, t) && isEnemy(w, i, t)) {
      const dx = e.x[t]! - cx;
      const dy = e.y[t]! - cy;
      if (dx * dx + dy * dy <= rr) return t;
    }
  }

  return findNearestEnemy(w, i, cx, cy, reach);
}

/**
 * 射程内で最も近い敵の index（見つからなければ -1）。
 *
 * `queryCircle` を使わず **グリッドのセルを直接走査する**。
 * queryCircle は「全件を配列に積んで index 昇順へ整列」するので、
 * 1 体に 1 回でも 1600 体では整列と push が combat の支配的コストになる
 * （実測 0.56ms/tick → この関数にして 0.2ms 以下）。
 *
 * 決定論: 比較を `(平方距離, index)` の**辞書式の全順序**にしてあるので、
 * セルの走査順に依存しない。したがって queryCircle と同じ結果になる。
 */
function findNearestEnemy(w: World, i: number, cx: Fx, cy: Fx, reach: Fx): number {
  if (reach <= 0) return -1;
  const e = w.entities;
  const g = w.grid;
  const rr = reach * reach;
  const c0 = cellCol(g, cx - reach);
  const c1 = cellCol(g, cx + reach);
  const r0 = cellRow(g, cy - reach);
  const r1 = cellRow(g, cy + reach);

  let best = -1;
  let bestSq = 0;
  for (let row = r0; row <= r1; row++) {
    const base = row * g.cols;
    for (let col = c0; col <= c1; col++) {
      const cell = base + col;
      const end = g.cellStart[cell + 1]!;
      for (let k = g.cellStart[cell]!; k < end; k++) {
        const t = g.items[k]!;
        if (t === i) continue;
        if (e.alive[t] !== 1) continue;
        const dx = e.x[t]! - cx;
        const dy = e.y[t]! - cy;
        const sq = dx * dx + dy * dy;
        if (sq > rr) continue;
        if (best >= 0 && (sq > bestSq || (sq === bestSq && t > best))) continue;
        if (!isAttackable(w, t)) continue;
        if (!isEnemy(w, i, t)) continue;
        best = t;
        bestSq = sq;
      }
    }
  }
  return best;
}

/**
 * ユニットの一撃を適用する（近接・即着弾で共通）。
 * 範囲攻撃なら `impactX/Y` を中心に巻き込む。
 */
function applyUnitHit(
  w: World,
  attackerIndex: number,
  victimIndex: number,
  impactX: Fx,
  impactY: Fx
): void {
  const e = w.entities;
  const d = unitDef(e.typeId[attackerIndex]!);
  const ctx = contextOf(w, attackerIndex, true);

  if (d.aoeRadius > 0) {
    applyAreaHit(w, ctx, impactX, impactY);
    return;
  }
  if (victimIndex < 0 || e.alive[victimIndex] !== 1) return;
  applySingleHit(w, ctx, victimIndex);
}

/** 単体攻撃 1 発。 */
function applySingleHit(w: World, ctx: AttackContext, victimIndex: number): void {
  const d = unitDef(ctx.typeId);
  const a = armorOf(w, victimIndex);
  const dmg = computeDamage({
    atk: d.atk,
    def: a.def,
    pierceDef: a.pierceDef,
    attackClass: d.attackClass,
    pierce: d.pierce,
    attackerRole: d.roleIdx,
    defenderRole: a.role,
    attackerElevation: ctx.elevation,
    defenderElevation: elevationOf(w, victimIndex),
    isAoeAttack: false,
    defenderFormation: formationOfEntity(w, victimIndex),
    mods: modifiersFor(w, ctx, victimIndex),
  });
  dealDamage(w, ctx.owner, ctx.frontId, ctx.pair, victimIndex, dmg, false);
  applyKnockback(w, ctx, victimIndex);
}

/**
 * 範囲攻撃（T-M7-04）。
 * 中心から `aoeRadius` 内の攻撃可能なエンティティすべてに当たる。
 *  - 敵 → そのまま
 *  - 味方 → trait `friendly_fire` を持つ攻撃だけ 50% で当たる
 * 反復は `queryCircle` の index 昇順。
 */
function applyAreaHit(w: World, ctx: AttackContext, cx: Fx, cy: Fx): void {
  const e = w.entities;
  const d = unitDef(ctx.typeId);
  const ff = d.traits.includes(TRAIT_FRIENDLY_FIRE);

  const out = w.scratch.neighbors2;
  const n = queryCircle(w.grid, e, cx, cy, d.aoeRadius, out);
  for (let k = 0; k < n; k++) {
    const t = out[k]!;
    if (e.alive[t] !== 1) continue;
    if (!isAttackable(w, t)) continue;
    const other = e.owner[t]!;
    if (other === NEUTRAL_OWNER) continue;
    const friendly = areAllies(w, ctx.owner, other);
    if (friendly && !ff) continue;

    const a = armorOf(w, t);
    const dmg = computeDamage({
      atk: d.atk,
      def: a.def,
      pierceDef: a.pierceDef,
      attackClass: d.attackClass,
      pierce: d.pierce,
      attackerRole: d.roleIdx,
      defenderRole: a.role,
      attackerElevation: ctx.elevation,
      defenderElevation: elevationOf(w, t),
      isAoeAttack: true,
      defenderFormation: formationOfEntity(w, t),
      mods: modifiersFor(w, ctx, t),
    });
    dealDamage(
      w,
      ctx.owner,
      ctx.frontId,
      ctx.pair,
      t,
      friendly ? friendlyFireDamage(dmg) : dmg,
      friendly
    );
    // 範囲攻撃と組み合わせると「周囲の敵をまとめて弾く」になる（親衛象）。
    if (!friendly) applyKnockback(w, ctx, t);
  }
}

/**
 * 特性 `knockback`（戦象・親衛象）: 当たった敵ユニットを着弾点から遠ざける。
 *
 * `03§8`「極端に硬く、周囲の敵をまとめて弾く / 槍兵の壁を物量で踏み越える」の実装。
 * 押し出す距離は `traits.knockbackTiles`。
 *  - 対象は **生きているユニットのみ**（建物・壁は動かない）。
 *  - 押し出し先が通れないタイルなら押さない（壁の中へ埋めない）。
 *  - 向きは着弾点 → 対象の単位ベクトル。`isqrt` で整数のまま正規化する。
 *
 * `movement.ts` は毎 tick 座標を進めるだけなので、combat が座標を足しても矛盾しない
 * （押し出し `pushApart` と同じことを、敵に対して行っている）。
 */
function applyKnockback(w: World, ctx: AttackContext, victimIndex: number): void {
  if (ctx.typeId < 0 || !hasTrait(ctx.typeId, TRAIT_BIT.Knockback)) return;
  const e = w.entities;
  if (e.alive[victimIndex] !== 1) return;
  if (e.kind[victimIndex] !== EntityKind.Unit) return;
  const dist = traits().knockbackDist;
  if (dist <= 0) return;

  const dx = e.x[victimIndex]! - ctx.x;
  const dy = e.y[victimIndex]! - ctx.y;
  const len = isqrt(dx * dx + dy * dy);
  if (len <= 0) return;
  const nx = e.x[victimIndex]! + idiv(dx * dist, len);
  const ny = e.y[victimIndex]! + idiv(dy * dist, len);
  const tx = fxToInt(nx);
  const ty = fxToInt(ny);
  if (!isPassable(w.map, tx, ty)) return;
  e.x[victimIndex] = nx;
  e.y[victimIndex] = ny;
}

// ---------------------------------------------------------------- 投射物の着弾

/**
 * 投射物の着弾。`stepProjectiles` から呼ばれる。
 *
 * 射手が既に死んでいてもダメージは通る（撃った矢は消えない）。
 * その場合 `frontId` が取れないので与ダメージの集計だけが落ちる。
 */
function applyProjectileImpact(w: World, pi: number): void {
  const e = w.entities;
  const shooterId = e.homeId[pi]!;
  const shooterAlive = isAlive(e, shooterId);
  const shooterIndex = shooterAlive ? entityIndex(shooterId) : -1;
  const attackerFront = shooterIndex >= 0 ? e.frontId[shooterIndex]! : 0;
  // 投射物の owner は射手の owner（`spawnProjectile` が引き継ぐ）。
  // 射手が死んでいても投射物側に残っているので、こちらから引く。
  const shooterOwner = e.owner[pi]! as PlayerId;

  // 射手の高さは発射時に `carryKind` へ記録してある（射手が死んでも再現できる）。
  const recorded = shooterElevationOf(e, pi);
  const attackerElevation =
    recorded >= 0 ? recorded : elevationAt(w.map, fxToInt(e.x[pi]!), fxToInt(e.y[pi]!));

  const targetId = e.target[pi]!;
  const victim = isAlive(e, targetId) ? entityIndex(targetId) : -1;

  // 攻撃側の情報は投射物の typeId（= 射手のユニット typeId）から引く。
  const d = unitDef(e.typeId[pi]!);

  // 令は「射手が今どの戦域にいるか」で解決する。射手が死んでいたら令なし
  // （`lastOrder` は射手の index を通してしか読めず、index は再利用されるため参照しない）。
  const ctx: AttackContext = {
    typeId: d.index,
    owner: shooterOwner,
    frontId: attackerFront,
    elevation: attackerElevation,
    pair:
      shooterIndex >= 0
        ? orderPairFor(w, shooterOwner, attackerFront, e.lastOrder[shooterIndex]!)
        : NO_ORDERS,
    // 「上陸」は足場が水際かどうかで決まる。射手の足場（生きていれば）を見る。
    onWet:
      shooterIndex >= 0 &&
      isWet(w.map, fxToInt(e.x[shooterIndex]!), fxToInt(e.y[shooterIndex]!)),
    x: e.x[pi]!,
    y: e.y[pi]!,
  };

  if (d.aoeRadius > 0) {
    // 目標が死んでいても着弾点で炸裂する。
    applyAreaHit(w, ctx, e.x[pi]!, e.y[pi]!);
    return;
  }
  if (victim < 0) return; // 単体攻撃で目標が消えていたら不発
  applySingleHit(w, ctx, victim);
}

// ---------------------------------------------------------------- 建物の攻撃

/**
 * 見張り塔・櫓・砲塔・城・大天幕の攻撃（T-M7-01）。
 *
 * 建物は投射物を出さず **即座に当てる**。
 * 理由: 投射物の `typeId` に建物の typeId を載せると
 * units / buildings のどちらの表を引くべきか判別できなくなる。
 * 見た目の弾道は描画層（M5）が `attackTicks` から補間すれば足りる。
 * （投射物にしたい場合は SoA に 1 bit 足す必要があるので M7 の申し送りに回した）
 */
function buildingAttackCycle(w: World, i: number): void {
  const e = w.entities;
  if (coolingDown(w, i)) return;
  const d = buildingDef(e.typeId[i]!);
  if (d.attackDamage <= 0 || d.attackRange <= 0) return;
  // 建設中（0 < buildProgress < 1.0）の建物は撃たない。進捗は construction（M10）が入れる。
  const prog = e.buildProgress[i]!;
  if (prog > 0 && prog < FX_ONE) return;

  const victim = pickVictim(w, i, d.attackRange);
  if (victim < 0) {
    e.cooldown[i] = scanBackoffTicks();
    return;
  }

  // 塔・城も戦域に属し得る（`frontEnrollment` は建物も編入する）ので、
  // 受け側の令（陣立て・圧壊）は塔の射撃にも効く。攻撃側の特性は持たない（typeId = -1）。
  const ctx = contextOf(w, i, false);
  const a = armorOf(w, victim);
  const dmg = computeDamage({
    atk: d.attackDamage,
    def: a.def,
    pierceDef: a.pierceDef,
    // 塔・城は矢や弾を放つので貫通装甲で受ける。
    attackClass: 'arrow',
    pierce: false,
    attackerRole: BUILDING_ROLE,
    defenderRole: a.role,
    attackerElevation: ctx.elevation,
    defenderElevation: elevationOf(w, victim),
    isAoeAttack: false,
    defenderFormation: formationOfEntity(w, victim),
    mods: modifiersFor(w, ctx, victim),
  });
  dealDamage(w, ctx.owner, ctx.frontId, ctx.pair, victim, dmg, false);
  e.cooldown[i] = d.attackTicks;
  e.target[i] = idOfIndex(e, victim);
}

// ---------------------------------------------------------------- 自己回復

/**
 * 特性 `self_heal`（ベルセルク）: 時間とともに自己回復する（`03§8`）。
 *
 * 回復量は `traits.selfHealHpPerSec`（毎秒 HP）。
 * 1 tick 分を `rate / 25` で出すと Fx（1/256）より小さくなって 0 に丸まるので、
 * `morale.ts` の `moraleDelta` と同じ **telescoping な差分** で切り出す:
 *
 *   delta(tick) = trunc(rate * (tick + 1) / 25) - trunc(rate * tick / 25)
 *
 * 累積器を持たないので World を並べても決定論が保たれ、
 * 合計は必ず「経過秒数 × rate」に一致する（丸め誤差が溜まらない）。
 * 戦闘中でも回復する（`03§8`「補給のない敵地で戦線を維持できる」）。
 */
function selfHealTick(w: World, i: number): void {
  const e = w.entities;
  if (!hasTrait(e.typeId[i]!, TRAIT_BIT.SelfHeal)) return;
  const hp = e.hp[i]!;
  const max = e.hpMax[i]!;
  if (hp <= 0 || hp >= max) return;
  const rate = traits().selfHealPerSec;
  if (rate <= 0) return;
  const add = idiv(rate * (w.tick + 1), TICK_RATE) - idiv(rate * w.tick, TICK_RATE);
  if (add <= 0) return;
  const next = hp + add;
  e.hp[i] = next > max ? max : next;
}

// ---------------------------------------------------------------- 祈祷師の治療

/**
 * 祈祷師の治療（T-M7-08）。
 * 射程内で **最も HP の欠けている味方** を 1 体だけ治す。
 * タイブレークは「欠損が大きい → index が小さい」。
 * 士気の維持は `morale.ts` 側（`morale.priestRadiusTiles`）で扱う。
 */
function healCycle(w: World, i: number, range: Fx, attackTicks: number): void {
  const e = w.entities;
  if (range <= 0) return;
  const out = w.scratch.neighbors;
  const n = queryCircle(w.grid, e, e.x[i]!, e.y[i]!, range, out);
  let best = -1;
  let bestMissing = 0;
  for (let k = 0; k < n; k++) {
    const t = out[k]!;
    if (t === i) continue;
    if (e.alive[t] !== 1) continue;
    if (e.kind[t] !== EntityKind.Unit) continue;
    const other = e.owner[t]!;
    if (other === NEUTRAL_OWNER) continue;
    if (!areAllies(w, e.owner[i]!, other)) continue;
    const missing = e.hpMax[t]! - e.hp[t]!;
    if (missing <= 0) continue;
    if (best < 0 || missing > bestMissing) {
      best = t;
      bestMissing = missing;
    }
  }
  if (best < 0) {
    e.cooldown[i] = scanBackoffTicks();
    return;
  }
  const heal = healPerAction();
  const add = heal < bestMissing ? heal : bestMissing;
  e.hp[best] = e.hp[best]! + add;
  e.cooldown[i] = attackTicks;
  e.target[i] = idOfIndex(e, best);
}
