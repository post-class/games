/**
 * sim/core/law.ts — 戦の作法（掟）と試合オプションの判定（`02` 戦の作法 / `07§10` / `07§14`）
 *
 * ここには **World をほとんど書き換えない判定** だけを置く（`front.ts` と同じ方針）。
 * 実際に忠誠度を動かすのは `systems/loyalty.ts`、決着を付けるのは `systems/victory.ts`。
 *
 * 決定論の約束（§0.3）:
 *  - 乱数を一切使わない。掟の成立判定・違反者の特定・離反対象の選び方はすべて全順序で決める。
 *  - 数値リテラルを書かない。すべて `config.json`（`loyalty.*` / `matchOptions.*`）から引く。
 *  - 小数は Fx。距離比較は平方距離。
 *
 * ---- 掟の一覧（`02` 戦の作法）----
 *  一 碑の島では戦わない … `map.lawZones` の島内で交戦した時点で成立（-25%）
 *  二 井戸を埋めない     … `well` を壊した時点（-25%）
 *  三 種籾を焼かない     … `seed_store` を壊した時点（-25%）
 *  四 休戦の季を守る     … **任意オプション**。破っても罰は無く、守り切ると +15%
 *  五 降った城の民は通す … 落城地点から逃げる村人を 30 秒以内に攻撃した時点（-25%）
 *
 * 掟一・二・三・五は「掟の適用」（`matchOptions.lawsEnabled`）が無効なら
 * **忠誠度の仕組みごと働かない**（`07§14`）。
 */

import buildingsJson from '@/data/buildings.json' with { type: 'json' };
import type { PlayerId } from '@/shared/types';
import { NEUTRAL_OWNER } from '@/shared/types';
import { cfgBool, cfgFx, cfgInt, cfgNum, cfgObject, cfgStr, cfgTicks, TICK_RATE } from './config';
import { BUILDING_DEFS, buildingDef } from './defs';
import type { Fx } from './fx';
import { FX_ONE, fx, fxClamp } from './fx';
import { getPlayer, type MapState, type World } from './world';

// ---------------------------------------------------------------------------
// 掟の ID
// ---------------------------------------------------------------------------

/**
 * 掟の ID。`buildings.json` の `lawViolationOnDestroy`（`law2` / `law3`）と
 * `config.json` の `loyalty.lawPenaltyKeyByLawId` のキーがこの語彙。
 */
export const LAW_MONOLITH_ISLE = 'law1';
export const LAW_WELL = 'law2';
export const LAW_SEED_STORE = 'law3';
export const LAW_TRUCE = 'law4';
export const LAW_FLEEING_VILLAGER = 'law5';

/**
 * `map.lawZones` の 4 番目の要素（掟番号）が「掟一の領域」を表す値。
 * `mapgen.ts` が `z.lawOne ? 1 : 0` を書き込んでいるので 1 が掟一。
 */
export const LAW_ZONE_LAW_ONE = 1;

/** `map.lawZones` の 1 領域あたりの要素数（x, y, radius, 掟番号）。 */
export const LAW_ZONE_STRIDE = 4;

// ---------------------------------------------------------------------------
// 試合オプション（`07§14` の 7 種）
//
// **申し送り**: 試合ごとの設定値は本来 `World` に持つべきだが、`world.ts` を
// 編集できないため `config.json` の既定値 + このモジュールの上書き口で動かしている。
// `World` に `matchOptions` を足したら、下の `matchRules()` をそこ参照へ差し替える。
// ---------------------------------------------------------------------------

/** 試合ごとに変えられる規則（`07§14`）。省略したものは `config.json` の既定値。 */
export interface MatchRuleOverrides {
  /** 掟の適用（無効にすると忠誠度の仕組みが働かない）。 */
  readonly lawsEnabled?: boolean;
  /** 休戦の季。 */
  readonly truceSeason?: boolean;
  /** 休戦の季の開始（秒）。 */
  readonly truceStartSec?: number;
  /** 休戦の季の長さ（秒）。 */
  readonly truceDurationSec?: number;
  /** 戦域スロット上限（2..6）。 */
  readonly frontSlotCap?: number;
  /** 資源の枯渇。 */
  readonly resourceDepletion?: boolean;
  /** ゲーム速度（0.5..1.5）。 */
  readonly gameSpeed?: number;
  /** 開始時代（`AGE_IDS` の ID）。 */
  readonly startAge?: string;
  /** 開始資源プリセット名。 */
  readonly startResources?: string;
  /** 人口上限（建物で増える上限の打ち止め）。 */
  readonly populationCap?: number;
}

let overrides: MatchRuleOverrides = {};

/**
 * 試合オプションを上書きする（対戦設定 / テストが使う口）。
 * 呼ばなければ `config.json` の既定値で動く。
 */
export function configureMatchRules(o: MatchRuleOverrides): void {
  overrides = { ...overrides, ...o };
}

/** 上書きを捨てて `config.json` の既定値に戻す。 */
export function resetMatchRules(): void {
  overrides = {};
}

/** 現在の上書き内容（デバッグ・リプレイの書き出し用）。 */
export function matchRuleOverrides(): MatchRuleOverrides {
  return overrides;
}

/** 掟の適用（`matchOptions.lawsEnabled.default`）。 */
export function lawsEnabled(): boolean {
  return overrides.lawsEnabled ?? cfgBool('matchOptions.lawsEnabled.default');
}

/** 休戦の季（`matchOptions.truceSeason.default`。既定は無効）。 */
export function truceSeasonEnabled(): boolean {
  return overrides.truceSeason ?? cfgBool('matchOptions.truceSeason.default');
}

/** 休戦の季が始まる tick（`matchOptions.truceSeason.startSec` = 900 秒）。 */
export function truceStartTick(): number {
  const sec = overrides.truceStartSec;
  if (sec !== undefined) return Math.round(sec * TICK_RATE);
  return cfgTicks('matchOptions.truceSeason.startSec');
}

/** 休戦の季の長さ（tick。`matchOptions.truceSeason.durationSec` = 60 秒）。 */
export function truceDurationTicks(): number {
  const sec = overrides.truceDurationSec;
  if (sec !== undefined) return Math.round(sec * TICK_RATE);
  return cfgTicks('matchOptions.truceSeason.durationSec');
}

/** 休戦の季が終わる tick（この tick は休戦に含まない）。 */
export function truceEndTick(): number {
  return truceStartTick() + truceDurationTicks();
}

/** 今この tick が休戦の季か（オプション無効なら常に false）。 */
export function isTruceActive(w: World): boolean {
  if (!truceSeasonEnabled()) return false;
  return w.tick >= truceStartTick() && w.tick < truceEndTick();
}

/** 休戦中は新しい戦域が発生しないか（`matchOptions.truceSeason.blocksNewFronts`）。 */
export function truceBlocksNewFronts(): boolean {
  return cfgBool('matchOptions.truceSeason.blocksNewFronts');
}

/** 休戦中は既存戦域も交戦をやめるか（`matchOptions.truceSeason.existingFrontsStopEngaging`）。 */
export function truceStopsEngaging(): boolean {
  return cfgBool('matchOptions.truceSeason.existingFrontsStopEngaging');
}

/** 休戦中も令は維持されるか（`matchOptions.truceSeason.existingFrontsHoldOrders`）。 */
export function truceHoldsOrders(): boolean {
  return cfgBool('matchOptions.truceSeason.existingFrontsHoldOrders');
}

/** 休戦を守り切ったときの忠誠度（Fx。`matchOptions.truceSeason.loyaltyBonusOnKept`）。 */
export function truceKeptBonus(): Fx {
  return cfgFx('matchOptions.truceSeason.loyaltyBonusOnKept');
}

/** 戦域スロット上限（2..6。`matchOptions.frontSlotCap.default`）。 */
export function frontSlotCap(): number {
  const v = overrides.frontSlotCap ?? cfgInt('matchOptions.frontSlotCap.default');
  const lo = cfgInt('matchOptions.frontSlotCap.min');
  const hi = cfgInt('matchOptions.frontSlotCap.max');
  return v < lo ? lo : v > hi ? hi : v;
}

/** 資源の枯渇（`matchOptions.resourceDepletion.default`）。 */
export function resourceDepletionOption(): boolean {
  return overrides.resourceDepletion ?? cfgBool('matchOptions.resourceDepletion.default');
}

/** ゲーム速度（`matchOptions.gameSpeed.default`。tick レートは変えず描画側の予算で調整する）。 */
export function gameSpeedOption(): number {
  const v = overrides.gameSpeed ?? cfgNum('matchOptions.gameSpeed.default');
  const lo = cfgNum('matchOptions.gameSpeed.min');
  const hi = cfgNum('matchOptions.gameSpeed.max');
  return v < lo ? lo : v > hi ? hi : v;
}

/** 開始時代（`matchOptions.startAge.default`）。 */
export function startAgeOption(): string {
  return overrides.startAge ?? cfgStr('matchOptions.startAge.default');
}

/** 開始資源プリセット名（`matchOptions.startResources.default`）。 */
export function startResourcesOption(): string {
  return overrides.startResources ?? cfgStr('matchOptions.startResources.default');
}

/** 人口上限（`population.defaultCap`。対戦設定で変更可）。 */
export function populationCapOption(): number {
  const v = overrides.populationCap ?? cfgInt('population.defaultCap');
  return v > 0 ? v : cfgInt('population.defaultCap');
}

// ---------------------------------------------------------------------------
// 忠誠度の設定アクセサ（`loyalty.*`）
// ---------------------------------------------------------------------------

/** 忠誠度の開始値（Fx）。`loyalty.start` = 1.0。 */
export function loyaltyStart(): Fx {
  return cfgFx('loyalty.start');
}

/** 忠誠度の下限（Fx）。`loyalty.minValue`。 */
export function loyaltyMin(): Fx {
  return cfgFx('loyalty.minValue');
}

/** 忠誠度の上限（Fx）。`loyalty.maxValue`。 */
export function loyaltyMax(): Fx {
  return cfgFx('loyalty.maxValue');
}

/** 自然回復量（Fx）。`loyalty.regenPer30s` = +0.01。 */
export function loyaltyRegenAmount(): Fx {
  return cfgFx('loyalty.regenPer30s');
}

/** 自然回復の周期（tick）。`loyalty.regenPeriodSec` = 30 秒。 */
export function loyaltyRegenPeriodTicks(): number {
  return cfgTicks('loyalty.regenPeriodSec');
}

/** 町の中心 1 つを失ったときの変化（Fx。負値）。`loyalty.loseTownCenter` = -0.05。 */
export function loyaltyLoseTownCenter(): Fx {
  return cfgFx('loyalty.loseTownCenter');
}

/** 戦域を見捨てたときの変化（Fx。負値）。`loyalty.abandonFronts` = -0.10。 */
export function loyaltyAbandonPenalty(): Fx {
  return cfgFx('loyalty.abandonFronts');
}

/** 「見捨てた」と数える戦域の数（`loyalty.abandonCountThreshold` = 3）。 */
export function loyaltyAbandonCountThreshold(): number {
  return cfgInt('loyalty.abandonCountThreshold');
}

/** 令を渡さない放置時間（tick。`loyalty.abandonIdleSec` = 60 秒）。 */
export function loyaltyAbandonIdleTicks(): number {
  return cfgTicks('loyalty.abandonIdleSec');
}

/** 後退の令で畳んだ戦域を対象外にするか（`loyalty.abandonExcludesRetreatOrder`）。 */
export function loyaltyAbandonExcludesRetreat(): boolean {
  return cfgBool('loyalty.abandonExcludesRetreatOrder');
}

/** 令の遅延 +2 秒が掛かる閾値（Fx）。`loyalty.thresholdDelayPenalty` = 0.80。 */
export function loyaltyThresholdDelay(): Fx {
  return cfgFx('loyalty.thresholdDelayPenalty');
}

/** 戦域 1 つが離反する閾値（Fx）。`loyalty.thresholdDefect` = 0.50。 */
export function loyaltyThresholdDefect(): Fx {
  return cfgFx('loyalty.thresholdDefect');
}

/** 敗北の閾値（Fx）。`loyalty.thresholdDefeat` = 0.0。 */
export function loyaltyThresholdDefeat(): Fx {
  return cfgFx('loyalty.thresholdDefeat');
}

/** 逃亡村人の成立期限（tick）。`loyalty.fleeingVillagerWindowSec` = 30 秒。 */
export function fleeingVillagerWindowTicks(): number {
  return cfgTicks('loyalty.fleeingVillagerWindowSec');
}

/** 落城 1 回でスパーンする逃亡村人の数（`loyalty.fleeingVillagerCount`）。 */
export function fleeingVillagerCount(): number {
  return cfgInt('loyalty.fleeingVillagerCount');
}

/** 逃亡村人がスパーンする間隔（マス。`loyalty.fleeingVillagerSpacingTiles`）。 */
export function fleeingVillagerSpacing(): Fx {
  return cfgFx('loyalty.fleeingVillagerSpacingTiles');
}

/**
 * 離反が忠誠度の回復で解けるか（`loyalty.defectRecoversAboveThreshold`）。
 *
 * `07§10` は解除条件を書いていないが、自然回復があるので
 * 「閾値を戻せば旗も戻る」を既定にしている（`02` の「次の代で旗を戻した国はいくつもある」）。
 */
export function defectRecovers(): boolean {
  return cfgBool('loyalty.defectRecoversAboveThreshold');
}

/**
 * 掟 ID に対応する忠誠度の変化（Fx。負値）。
 *
 * `loyalty.lawPenaltyKeyByLawId` で掟 ID → `loyalty.lawPenalties` のキーを引く。
 * 対応が無い掟 ID は `loyalty.breakLaw`（一律 -25%）を使う。
 */
export function lawPenalty(lawId: string): Fx {
  const map = cfgObject('loyalty.lawPenaltyKeyByLawId');
  const key = map[lawId];
  if (typeof key !== 'string') return cfgFx('loyalty.breakLaw');
  return cfgFx(`loyalty.lawPenalties.${key}`);
}

// ---------------------------------------------------------------------------
// 掟一 — 碑の島の領域
// ---------------------------------------------------------------------------

/** 掟一の領域の数（`map.lawZones` は 1 領域 4 要素）。 */
export function lawZoneCount(map: MapState): number {
  return Math.trunc(map.lawZones.length / LAW_ZONE_STRIDE);
}

/**
 * `(x, y)` が掟一の領域（碑の島）の中か。
 * 領域が無いマップでは常に false（`lawZones.length === 0`）。
 */
export function isInLawOneZone(map: MapState, x: Fx, y: Fx): boolean {
  const zones = map.lawZones;
  for (let z = 0; z + LAW_ZONE_STRIDE <= zones.length; z += LAW_ZONE_STRIDE) {
    if (zones[z + 3]! !== LAW_ZONE_LAW_ONE) continue;
    const dx = x - zones[z]!;
    const dy = y - zones[z + 1]!;
    const r = zones[z + 2]!;
    if (dx * dx + dy * dy <= r * r) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 掟二・三 — 壊すと掟破りになる建物
// ---------------------------------------------------------------------------

/**
 * `buildings.json` の `lawViolationOnDestroy`（typeId 昇順の表）。
 *
 * `BuildingDef` にこの列が無い（`defs.ts` は編集できない）ので、
 * ここで生データから引き直して typeId で並べておく。
 */
const LAW_VIOLATION_BY_TYPE: readonly (string | null)[] = (() => {
  const raw = buildingsJson as unknown as Record<string, Record<string, unknown>>;
  return BUILDING_DEFS.map((d) => {
    const v = raw[d.id]?.['lawViolationOnDestroy'];
    return typeof v === 'string' ? v : null;
  });
})();

/** `revealToAll`（碑の写しのように位置を隠せない建物）の表（typeId 昇順）。 */
const REVEAL_TO_ALL_BY_TYPE: readonly boolean[] = (() => {
  const raw = buildingsJson as unknown as Record<string, Record<string, unknown>>;
  return BUILDING_DEFS.map((d) => raw[d.id]?.['revealToAll'] === true);
})();

/** その建物を壊すと成立する掟 ID（無ければ null）。 */
export function buildingLawViolation(typeId: number): string | null {
  return LAW_VIOLATION_BY_TYPE[typeId] ?? null;
}

/** その建物は全プレイヤーに位置が公開されるか（`07§7`「記念碑だけは例外」）。 */
export function buildingRevealsToAll(typeId: number): boolean {
  return REVEAL_TO_ALL_BY_TYPE[typeId] ?? false;
}

/** 記念碑（`kind === 'monument'`）か。 */
export function isMonumentBuilding(typeId: number): boolean {
  return buildingDef(typeId).kind === MONUMENT_KIND;
}

/** `buildings.json` の `kind`。記念碑の判定に使う。 */
const MONUMENT_KIND = 'monument';

/** 失うと敗北する建物（町の中心）か。 */
export function isDefeatCriticalBuilding(typeId: number): boolean {
  return buildingDef(typeId).lossCausesDefeat;
}

/**
 * 落城したときに逃亡村人が出る建物か（`07§10` 掟五「降った城の民」）。
 *
 * 「城・町の中心」= **令の発信点になる建物**（`isOrderSource`）。
 * town_center / castle / great_tent がこれに当たり、
 * データ側だけで決まるので文明の分岐をコードに書かなくて済む。
 */
export function isCityBuilding(typeId: number): boolean {
  return buildingDef(typeId).isOrderSource;
}

// ---------------------------------------------------------------------------
// 犯人の特定
// ---------------------------------------------------------------------------

/**
 * その index を **最後に壊した者**（`Entities.lastDamagedBy`）を返す。誰にも殴られて
 * いなければ -1。
 *
 * 以前は「周囲でいちばん近い敵の攻撃者」を犯人とする近傍推定
 * （`blameNearestEnemy` / `loyalty.blameRadiusTiles`）だったが、
 * **近くにいるだけの無関係なプレイヤーが罰される**という致命的な誤りがあった。
 * `combat.dealDamage` が友軍被害を含めて必ず記録するようになったので、
 * 掟二・三・五の犯人は事実で決める。
 *
 * **近傍推定はフォールバックとしても残していない。** 残すと「たまたま推定で当たる」
 * ケースがテストを通してしまい、記録漏れに気付けなくなる。
 * 記録が無い（自壊・老朽・スクリプトによる `markDead`）なら誰も罰されないのが正しい。
 */
export function blameLastDamager(w: World, victimIndex: number): PlayerId | -1 {
  const e = w.entities;
  const by = e.lastDamagedBy[victimIndex]!;
  if (by < 0 || by === NEUTRAL_OWNER || by >= w.playerCount) return -1;
  return by as PlayerId;
}

/**
 * その index が「今から `windowTicks` 以内」に殴られたか（掟五の 30 秒判定の下請け）。
 * 記録が無ければ false。
 */
export function damagedWithin(w: World, victimIndex: number, windowTicks: number): boolean {
  const e = w.entities;
  const t = e.lastDamagedTick[victimIndex]!;
  if (t < 0) return false;
  return w.tick - t <= windowTicks;
}

// ---------------------------------------------------------------------------
// 忠誠度の加減算
// ---------------------------------------------------------------------------

/**
 * 忠誠度を動かす（0..1 でクランプ）。戻り値は実際に動いた量（Fx）。
 * `delta` は Fx（負値で減算）。
 */
export function addLoyalty(w: World, p: PlayerId, delta: Fx): Fx {
  const pl = getPlayer(w, p);
  if (pl === undefined) return 0;
  const before = pl.loyalty;
  pl.loyalty = fxClamp(before + delta, loyaltyMin(), loyaltyMax());
  return pl.loyalty - before;
}

/** 忠誠度を割合（0..1 の実数）で読む補助。UI とテストの可読性のためだけに置く。 */
export function loyaltyRatio(value: Fx): number {
  return value / FX_ONE;
}

/** 実数 0..1 を忠誠度の Fx にする（テストと対戦設定用）。 */
export function loyaltyFromRatio(ratio: number): Fx {
  return fxClamp(fx(ratio), loyaltyMin(), loyaltyMax());
}
