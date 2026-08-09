/**
 * sim/core/fx.ts — 固定小数点 Q8（実装手順書 §4.2）
 *
 * 座標・体力・士気・速度・資源はすべて整数で持つ。小数が必要な量は 1/256 単位の
 * スケール整数（Q8）として扱う。**浮動小数を状態として保持しない**（§0.3, §16-1）。
 *
 * 丸めの規約（このファイルの最重要事項）:
 *   すべての除算・積のスケール戻しは **0 方向切り捨て（truncate toward zero）** に統一する。
 *   `>>` は算術シフト（= 負数で floor）なので使わない。`Math.floor` と `| 0` を混在させない。
 *   → 本ファイルでは `trunc0`（Math.trunc + -0 の正規化）だけを使う。
 *
 * 桁あふれについて:
 *   JS の number は 2^53 まで整数を正確に表す。`fxMul` は内部で a*b を作るため、
 *   |a*b| <= 2^53 の範囲でしか正しくない。マップ最大 400 マス = 102,400 Fx なので
 *   座標同士の積は約 1.0e10 で十分収まる。HP・士気も同様。
 *   これを超える計算が必要になったら段階的にスケールを落とすこと（`| 0` で int32 に
 *   丸めると静かに壊れるので使わない）。
 */

/** 固定小数点の値。実体は整数。値 = 実数 × 256。 */
export type Fx = number;

/** Q8 のシフト幅。 */
export const FX_SHIFT = 8;

/** 1.0 を表す Fx。1 マス = 村人 1 体分の幅 = `FX_ONE`（`07§1`）。 */
export const FX_ONE = 1 << FX_SHIFT;

/** 0.5 を表す Fx。 */
export const FX_HALF = FX_ONE >> 1;

/** Fx として安全に扱える最大値（int32 上限）。 */
export const FX_MAX = 0x7fffffff;

/** Fx として安全に扱える最小値（int32 下限）。 */
export const FX_MIN = -0x80000000;

/**
 * 実数 → Fx。**マスターデータ読込時と定数定義時のみ**使用する。
 * tick 中の計算では使わない（float が混ざる経路を作らないため）。
 * 丸めは四捨五入（Math.round）。境界 .5 は +∞ 方向に丸まる点に注意。
 */
export function fx(n: number): Fx {
  const r = Math.round(n * FX_ONE);
  return r === 0 ? 0 : r; // -0 を +0 に正規化
}

/**
 * 0 方向切り捨て + **-0 の正規化**。
 *
 * `Math.trunc(-0.5)` は `-0` を返す。-0 は `===` では 0 と等しいが
 * `Object.is` / `JSON.stringify` / `1 / x` の符号で違いが出るため、
 * 状態に混ぜると「同値なのにハッシュや比較が食い違う」事故の種になる。
 * Fx の演算結果は必ずここを通して +0 に正規化する。
 */
function trunc0(v: number): number {
  const t = Math.trunc(v);
  return t === 0 ? 0 : t;
}

/** 整数（マス数など）→ Fx。 */
export function fxFromInt(n: number): Fx {
  return trunc0(n) * FX_ONE;
}

/** Fx → 整数（0 方向切り捨て）。 */
export function fxToInt(a: Fx): number {
  return trunc0(a / FX_ONE);
}

/**
 * Fx → 実数（float）。**表示・描画専用**。
 * 戻り値を sim の状態に書き戻してはいけない（§0.3）。
 */
export function fxToNumber(a: Fx): number {
  return a / FX_ONE;
}

/** 整数除算。0 方向切り捨て。b = 0 は実装バグなので例外にする。 */
export function idiv(a: number, b: number): number {
  if (b === 0) throw new Error('idiv: division by zero');
  return trunc0(a / b);
}

/**
 * Fx の積。(a * b) / 256 を 0 方向切り捨て。
 * 例: fxMul(-fx(1.5), fx(1)) === -384、fxMul(-1, 1) === 0（floor なら -1 になる）。
 */
export function fxMul(a: Fx, b: Fx): Fx {
  return trunc0((a * b) / FX_ONE);
}

/** Fx の商。(a * 256) / b を 0 方向切り捨て。 */
export function fxDiv(a: Fx, b: Fx): Fx {
  if (b === 0) throw new Error('fxDiv: division by zero');
  return trunc0((a * FX_ONE) / b);
}

/**
 * 整数平方根 floor(sqrt(n))。整数ニュートン法（T-M2-02）。
 * n < 0 は 0 を返す。
 *
 * 初期値を 2 の冪の倍化で作るため float の平方根に依存しない。
 * 最後に ±1 の補正を入れて、巨大な n で `n / x` の丸め誤差が出ても
 * 必ず厳密な floor(sqrt(n)) になるようにしている。
 */
export function isqrt(n: number): number {
  if (!(n > 0)) return 0;
  const t = Math.trunc(n);
  if (t < 2) return t;
  // x > sqrt(t) となる初期値を作る
  let x = 1;
  while (x * x <= t) x *= 2;
  // ニュートン法: x_{k+1} = floor((x_k + floor(t / x_k)) / 2)
  for (;;) {
    const y = Math.trunc((x + Math.trunc(t / x)) / 2);
    if (y >= x) break;
    x = y;
  }
  // 丸め誤差の補正（通常 0 回で抜ける）
  while (x > 0 && x * x > t) x -= 1;
  while ((x + 1) * (x + 1) <= t) x += 1;
  return x;
}

/**
 * Fx の平方根。sqrt(a/256) を Fx で返す = floor(sqrt(a * 256))。
 * 誤差は常に 0 以上 1/256 未満（切り捨てのみ）で、単調増加（T-M2-02）。
 *
 * **距離比較には使わない。** 平方距離で比較する（`distSq` / `withinRange`）。
 * 令の遅延計算など、式として距離そのものが必要な箇所だけで使う（§4.2, §6.2）。
 */
export function fxSqrt(a: Fx): Fx {
  if (a <= 0) return 0;
  return isqrt(a * FX_ONE);
}

/** 絶対値。 */
export function fxAbs(a: Fx): Fx {
  return a < 0 ? -a : a;
}

/** 小さい方。 */
export function fxMin(a: Fx, b: Fx): Fx {
  return a < b ? a : b;
}

/** 大きい方。 */
export function fxMax(a: Fx, b: Fx): Fx {
  return a > b ? a : b;
}

/** lo..hi に丸める。lo > hi の呼び出しは実装バグ。 */
export function fxClamp(a: Fx, lo: Fx, hi: Fx): Fx {
  if (a < lo) return lo;
  if (a > hi) return hi;
  return a;
}

/**
 * 平方距離。戻り値の単位は Fx²（= 実数² × 65536）で、**Fx ではない**。
 * 比較相手も同じ単位にすること（半径 r Fx なら `r * r`）。
 * スケールを戻さないのは精度を落とさないため。
 */
export function distSq(x0: Fx, y0: Fx, x1: Fx, y1: Fx): number {
  const dx = x1 - x0;
  const dy = y1 - y0;
  return dx * dx + dy * dy;
}

/** 半径 r（Fx）以内かどうか。平方距離で比較する（fxSqrt を使わない）。 */
export function withinRange(x0: Fx, y0: Fx, x1: Fx, y1: Fx, r: Fx): boolean {
  return distSq(x0, y0, x1, y1) <= r * r;
}
