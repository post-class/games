/**
 * sim/core/damage.ts — ダメージ式と係数（`07§6`, 実装手順書 §6.4 / T-M7-02〜06）
 *
 * ここは **純関数だけ** を置く。World も Entities も見ない。
 * 理由: 手計算した期待値と 1 対 1 で突き合わせられるようにするため（T-M7-02 の完了条件）。
 * World を触る処理は `systems/combat.ts` 側に置く。
 *
 * 式（`07§6` / 手順書 §6.4）:
 *
 *   dmg = max(1, atk - defEffective) * counter * terrain * formation
 *     defEffective = pierce ? floor(def / 2) : def   ← `combat.pierceIgnoreDefRatio`
 *     counter      = 有利 1.5 / 不利 0.7 / 等倍 1.0（**役割** で判定。名前では判定しない）
 *     terrain      = 高所→低所 1.15 / 低所→高所 0.9 / 同 1.0
 *     formation    = 範囲攻撃を密集隊列が受けると 1.4
 *     友軍被害     = 範囲攻撃の 50%（味方にも入る）
 *
 * 式に **掛からない** 補正（`07§6` の 2 つ目の表）は
 * `forestRangedRange` / `shallowCavSpeed` / `looseSpeed` として別関数にしてある。
 * ダメージと同じ関数に混ぜると「なぜ倍率が合わないのか」が分からなくなるため分離した。
 *
 * 丸めについて:
 *  - すべて Fx（実数 × 256）の整数演算。`fxMul` は 0 方向切り捨て。
 *  - 倍率は `fx()` で量子化されるので **実数の期待値とは僅かにずれる**。
 *    例: 1.4 → 358/256 = 1.3984375、0.7 → 179/256 = 0.69921875。
 *    テストの期待値は Fx の値そのもので書くこと（実数を丸め直すと一致しない）。
 *  - 掛ける順序を `counter → terrain → formation` に固定する。
 *    切り捨てがあるため順序を変えると結果が変わる = デシンクする。
 */

import { cfgFx } from './config';
import { counterMul } from './defs';
import type { Fx } from './fx';
import { FX_ONE, fxMul } from './fx';

// ---------------------------------------------------------------- 隊列

/**
 * 隊列。`orders.json` の `formation` 文字列に対応する。
 * 令システム本体（M9）ができるまでは `front.order` の令定義から読むだけ。
 */
export const Formation = {
  Normal: 0,
  /** 密集（死守・方陣・圧砕）。範囲攻撃の被害 ×1.4。 */
  Dense: 1,
  /** 散開（略奪・後退・遊撃）。移動速度 −15%。 */
  Loose: 2,
  /** 護衛（包囲）。攻撃・被害の倍率は通常と同じ。 */
  Escort: 3,
} as const;
export type FormationId = (typeof Formation)[keyof typeof Formation];

/** `orders.json` の formation 文字列 → `Formation`。未知の値は Normal（黙って落とさない）。 */
export function formationFromString(s: string): FormationId {
  switch (s) {
    case 'dense':
      return Formation.Dense;
    case 'loose':
      return Formation.Loose;
    case 'escort':
      return Formation.Escort;
    default:
      return Formation.Normal;
  }
}

// ---------------------------------------------------------------- 係数（個別）

/** 最低保証ダメージ（`combat.minDamage` = 1）。硬い相手にも必ず通る（`07§6` 明記）。 */
export function minDamage(): Fx {
  return cfgFx('combat.minDamage');
}

/**
 * 防御に使う装甲値を選ぶ。
 *
 * `units.json` は `def`（近接装甲）と `pierceDef`（貫通装甲）を別々に持っている。
 * どちらを使うかは **攻撃側の `attackClass`** で決める:
 *   melee / aoe（投石の面圧） → `def`
 *   arrow / gunpowder / siege（矢・弾・弩の直撃） → `pierceDef`
 *
 * 手順書 §6.4 の式は `def` と 1 つしか書いていないが、データに 2 種類あるので
 * 「どちらの def なのか」をここ 1 箇所で決める。
 */
export function armorForAttackClass(attackClass: string, def: Fx, pierceDef: Fx): Fx {
  switch (attackClass) {
    case 'arrow':
    case 'gunpowder':
    case 'siege':
      return pierceDef;
    default:
      // 'melee' / 'aoe' とそれ以外
      return def;
  }
}

/**
 * 貫通（`pierce`）を考慮した実効防御。
 * `combat.pierceIgnoreDefRatio`（0.5）ぶんの防御を無視する = 防御の半分無視。
 * 比率を config から引くので、0.5 以外に調整しても式は変えなくてよい。
 */
export function effectiveDefense(armor: Fx, pierce: boolean): Fx {
  if (!pierce) return armor;
  const keep = FX_ONE - cfgFx('combat.pierceIgnoreDefRatio');
  return fxMul(armor, keep);
}

/**
 * 相性倍率。**role index で判定する**（T-M7-03）。
 * ヤマトの長柄組（`y-nagae`）とペルシアの長槍隊（`p-naga`）は
 * どちらも role = spear なので、騎兵に対して同じ倍率になる。
 */
export function counterFactor(attackerRole: number, defenderRole: number): Fx {
  return counterMul(attackerRole, defenderRole);
}

/**
 * 令「圧壊」（`pushThrough`）を考慮した相性倍率。
 *
 * `pushThrough` の解釈（`03§7` の獣兵の行「槍兵に止められない突破力」）:
 *  - 攻撃側が持つとき: **自分の不利（0.7）を等倍に戻す**。
 *    槍の壁に阻まれないのは「槍に対して弱くならない」ことなので。
 *  - 受け側が持つとき: **相手の有利（1.5）を等倍に落とす**。
 *    「止められない」は、槍側の対騎兵ボーナスが乗らないという形で現れる。
 *
 * 「等倍に寄せる」だけなので、有利側は伸びない（押し崩す令が万能にならない）。
 * role 名でも令の名前でも分岐していないので、`pushThrough` を別の令に付けても同じに効く。
 */
export function counterFactorWithPush(
  attackerRole: number,
  defenderRole: number,
  attackerPushThrough: boolean,
  defenderPushThrough: boolean
): Fx {
  const c = counterMul(attackerRole, defenderRole);
  const neutral = cfgFx('combat.counterNeutral');
  if (attackerPushThrough && c < neutral) return neutral;
  if (defenderPushThrough && c > neutral) return neutral;
  return c;
}

/**
 * 地形倍率。高所 → 低所 1.15 / 低所 → 高所 0.9 / 同 1.0。
 * 段差の大きさは見ない（1 段でも 3 段でも同じ）。`07§6` の表がそうなっている。
 */
export function terrainFactor(attackerElevation: number, defenderElevation: number): Fx {
  if (attackerElevation > defenderElevation) return cfgFx('combat.highGround');
  if (attackerElevation < defenderElevation) return cfgFx('combat.lowGround');
  return FX_ONE;
}

/**
 * 令「上陸」（`waterAssault`）を考慮した地形倍率。
 * 攻め上がる不利（低所 → 高所 = 0.9）だけを等倍に戻す。高所からの有利は伸ばさない。
 */
export function terrainFactorWithAssault(
  attackerElevation: number,
  defenderElevation: number,
  ignoreLowGround: boolean
): Fx {
  const t = terrainFactor(attackerElevation, defenderElevation);
  if (ignoreLowGround && t < FX_ONE) return FX_ONE;
  return t;
}

/**
 * 隊列倍率。**範囲攻撃を密集隊列が受けたときだけ** 1.4。
 * それ以外（近接を密集で受ける・範囲を散開で受ける）は 1.0。
 * 「死守は密集するので投石系に狙われやすい」という設計意図（`07§6`）を素直に写したもの。
 */
export function formationFactor(isAoeAttack: boolean, defenderFormation: FormationId): Fx {
  if (isAoeAttack && defenderFormation === Formation.Dense) return cfgFx('combat.denseAoeTaken');
  return FX_ONE;
}

/** 友軍被害。範囲攻撃のダメージの 50%（`combat.friendlyFire`）。 */
export function friendlyFireDamage(dmg: Fx): Fx {
  return fxMul(dmg, cfgFx('combat.friendlyFire'));
}

// ---------------------------------------------------------------- ダメージ本体

// ---------------------------------------------------------------- 令・特性の補正

/**
 * 令のフラグとユニットの特性（`units.json` の `traits`）から来る補正。
 *
 * **ここには「どの令か」「どの特性か」は入らない。** 効果に翻訳し終えた数値だけが入る
 * （翻訳は `core/orderEffects.ts` と `systems/combat.ts` の担当）。
 * こうしておくと、このファイルは相変わらず「手計算と 1 対 1 で突き合わせられる純関数」で済む。
 *
 * 掛ける順序は `computeDamage` に固定してある（切り捨てがあるので順序が結果に出る）。
 */
export interface DamageModifiers {
  /** 受け側の装甲への加算（Fx）。特性 `formation_defense`。 */
  readonly defenderArmorAdd: Fx;
  /** 攻撃側の与ダメージ倍率（Fx）。特性 `anti_elite` / `anti_infantry`、令「上陸」の強襲。 */
  readonly attackerMul: Fx;
  /** 受け側の被ダメージ倍率（Fx）。令「陣立て」。 */
  readonly defenderTakenMul: Fx;
  /** 対建物のときだけ掛かる倍率（Fx）。令「火計」、特性 `anti_building`。 */
  readonly buildingMul: Fx;
  /** 受け側が建物・付属物か（`buildingMul` を掛けるかの判定）。 */
  readonly defenderIsBuilding: boolean;
  /** 攻撃側が相性の不利を打ち消すか。令「圧壊」。 */
  readonly attackerPushThrough: boolean;
  /** 受け側が相性の有利を打ち消すか。令「圧壊」。 */
  readonly defenderPushThrough: boolean;
  /** 攻撃側が「低所 → 高所」の不利を受けないか。令「上陸」。 */
  readonly attackerIgnoreLowGround: boolean;
}

/** 補正なし（既定）。既存の呼び出しはこれと同じ結果になる。 */
export const NO_MODIFIERS: DamageModifiers = {
  defenderArmorAdd: 0,
  attackerMul: FX_ONE,
  defenderTakenMul: FX_ONE,
  buildingMul: FX_ONE,
  defenderIsBuilding: false,
  attackerPushThrough: false,
  defenderPushThrough: false,
  attackerIgnoreLowGround: false,
};

/** `computeDamage` の入力。すべて Fx か index。 */
export interface DamageInput {
  /** 攻撃力（Fx。研究・文明ボーナス加算後の値を渡す）。 */
  readonly atk: Fx;
  /** 防御側の近接装甲（Fx）。 */
  readonly def: Fx;
  /** 防御側の貫通装甲（Fx）。 */
  readonly pierceDef: Fx;
  /** 攻撃側の `attackClass`（'melee' | 'arrow' | 'gunpowder' | 'siege' | 'aoe'）。 */
  readonly attackClass: string;
  /** 攻撃側が貫通属性を持つか。 */
  readonly pierce: boolean;
  /** 攻撃側の role index（`defs.roleToIndex`）。 */
  readonly attackerRole: number;
  /** 防御側の role index。 */
  readonly defenderRole: number;
  /** 攻撃側の立っているタイルの高さ。 */
  readonly attackerElevation: number;
  /** 防御側の立っているタイルの高さ。 */
  readonly defenderElevation: number;
  /** 範囲攻撃か（`aoeRadiusTiles > 0`）。 */
  readonly isAoeAttack: boolean;
  /** 防御側の隊列。 */
  readonly defenderFormation: FormationId;
  /** 令・特性の補正（省略時は `NO_MODIFIERS`）。 */
  readonly mods?: DamageModifiers;
}

/**
 * 与ダメージ（Fx）。
 *
 * 計算順を固定する（切り捨てがあるので順序が結果に出る）:
 *   1. 装甲を選ぶ（attackClass）
 *   2. 貫通で半分無視
 *   3. base = max(minDamage, atk - defEffective)   ← ここで最低保証
 *   4. × counter
 *   5. × terrain
 *   6. × formation
 *
 * 最低保証は **3 の位置だけ**（手順書 §6.4 の式どおり）。
 * 倍率の最小の組み合わせは 0.7 × 0.9 = 0.63 なので、
 * base = 1 でも結果は 0 にならない（= 硬い相手にも必ず通る）。
 *
 * 令・特性の補正（`mods`）は **式の後ろに追加する**。順序は
 *   7. × 攻撃側の倍率（特性・上陸の強襲）
 *   8. × 対建物の倍率（火計・anti_building）
 *   9. × 受け側の被ダメージ倍率（陣立て）
 * で固定する。装甲加算（`formation_defense`）と相性・地形の打ち消し（圧壊・上陸）は
 * それぞれ 1・4・5 の段で効くので、後ろに足すのではなく該当段に混ぜてある。
 */
export function computeDamage(inp: DamageInput): Fx {
  const m = inp.mods ?? NO_MODIFIERS;
  const armor = armorForAttackClass(inp.attackClass, inp.def, inp.pierceDef) + m.defenderArmorAdd;
  const defEff = effectiveDefense(armor, inp.pierce);
  const min = minDamage();
  const raw = inp.atk - defEff;
  const base = raw > min ? raw : min;
  let d = fxMul(
    base,
    counterFactorWithPush(
      inp.attackerRole,
      inp.defenderRole,
      m.attackerPushThrough,
      m.defenderPushThrough
    )
  );
  d = fxMul(
    d,
    terrainFactorWithAssault(
      inp.attackerElevation,
      inp.defenderElevation,
      m.attackerIgnoreLowGround
    )
  );
  d = fxMul(d, formationFactor(inp.isAoeAttack, inp.defenderFormation));
  if (m.attackerMul !== FX_ONE) d = fxMul(d, m.attackerMul);
  if (m.defenderIsBuilding && m.buildingMul !== FX_ONE) d = fxMul(d, m.buildingMul);
  if (m.defenderTakenMul !== FX_ONE) d = fxMul(d, m.defenderTakenMul);
  return d;
}

// ---------------------------------------------------------------- 式に掛からない補正

/**
 * 森の中の遠隔は射程 −25%（`combat.forestRangedRange`）。
 * **ダメージには掛からない。** 射程だけが縮む（`07§6` の 2 つ目の表）。
 *
 * @param baseRange 素の射程（Fx）
 * @param shooterInForest 射手が森のタイルにいるか
 * @param isRangedAttack 遠隔攻撃か（近接には効かない）
 */
export function rangeWithTerrain(
  baseRange: Fx,
  shooterInForest: boolean,
  isRangedAttack: boolean
): Fx {
  if (!shooterInForest || !isRangedAttack) return baseRange;
  // forestRangedRange は −0.25 という「増減」表記なので 1 + (−0.25) を掛ける
  const mul = FX_ONE + cfgFx('combat.forestRangedRange');
  return fxMul(baseRange, mul);
}

/**
 * 移動速度の補正倍率（Fx）。**ダメージには掛からない。**
 *  - 水際（浅瀬・湿地）の騎兵 −30%（`combat.shallowCavSpeed`）
 *  - 散開隊列 −15%（`combat.looseSpeed`）
 * 両方成立するときは **順に掛ける**（加算ではなく乗算）。
 *
 * `movement.ts` は M3 担当の持ち物なので、ここでは倍率を返すだけにしてある。
 */
export function speedFactor(
  isCavalry: boolean,
  onShallowWater: boolean,
  formation: FormationId
): Fx {
  let mul = FX_ONE;
  if (isCavalry && onShallowWater) mul = fxMul(mul, FX_ONE + cfgFx('combat.shallowCavSpeed'));
  if (formation === Formation.Loose) mul = fxMul(mul, FX_ONE + cfgFx('combat.looseSpeed'));
  return mul;
}

/** 騎兵系の role か（速度補正の対象。`camel` も水際で鈍る）。 */
export function isCavalryRole(role: string): boolean {
  return role === 'cavalry' || role === 'camel';
}
