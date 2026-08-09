/**
 * sim/core/config.ts — `data/config.json` への型付きアクセサ。
 *
 * 実装手順書 §0.5「数値リテラルをコードに書かない」を守るための唯一の窓口。
 * sim の各システムはここを通して数値を読む。
 *
 * 設計方針:
 *  - **キーごとに関数を増やさない。** パス文字列で引く汎用 API にしてある。
 *    そうしないと、システムを追加するたびにこのファイルが編集競合の的になる。
 *  - **存在しないパスは即例外。** 綴り間違いを黙って `undefined` にしない
 *    （`undefined` が計算に混ざると NaN になり、数十分後に不可解な挙動になる）。
 *  - 秒 → tick、マス → Fx の変換をここで済ませる。システム側で
 *    「この値の単位は何だったか」を考えなくて済むようにするため。
 *  - 変換結果はキャッシュする。毎 tick の文字列パス解決を避ける。
 *
 * 決定論: `fx()` は読み込み時に 1 回だけ丸めるので、実行中に浮動小数点が
 * 状態へ入り込むことはない（§0.3）。
 */

import configJson from '@/data/config.json' with { type: 'json' };
import type { Fx } from './fx';
import { fx } from './fx';

/** 1 秒あたりの tick 数。config.json の `tickRate`（= 25）。 */
export const TICK_RATE: number = readNumber(configJson as unknown, 'tickRate');

/** 試合長（tick）。約 30 分 = 45,000 tick。 */
export const MATCH_LENGTH_TICKS: number = Math.round(
  readNumber(configJson as unknown, 'matchLengthSec') * TICK_RATE,
);

const numCache = new Map<string, number>();
const fxCache = new Map<string, number>();

/**
 * 生の数値を引く。
 * @param path `'front.spawnRadiusTiles'` のようなドット区切りパス
 * @throws パスが無い / 数値でない場合（起動時に落とす）
 */
export function cfgNum(path: string): number {
  const hit = numCache.get(path);
  if (hit !== undefined) return hit;
  const v = readNumber(configJson as unknown, path);
  numCache.set(path, v);
  return v;
}

/** 整数として引く（小数だったら例外）。 */
export function cfgInt(path: string): number {
  const v = cfgNum(path);
  if (!Number.isInteger(v)) {
    throw new Error(`config.json: ${path} は整数である必要があります（実際: ${v}）`);
  }
  return v;
}

/** 真偽値を引く。 */
export function cfgBool(path: string): boolean {
  const v = readPath(configJson as unknown, path);
  if (typeof v !== 'boolean') {
    throw new Error(`config.json: ${path} は真偽値である必要があります（実際: ${describe(v)}）`);
  }
  return v;
}

/** 文字列を引く。 */
export function cfgStr(path: string): string {
  const v = readPath(configJson as unknown, path);
  if (typeof v !== 'string') {
    throw new Error(`config.json: ${path} は文字列である必要があります（実際: ${describe(v)}）`);
  }
  return v;
}

/** 倍率・比率を Fx に変換して引く（例 `combat.counterGood` → 1.5 → 384）。 */
export function cfgFx(path: string): Fx {
  const hit = fxCache.get(path);
  if (hit !== undefined) return hit;
  const v = fx(cfgNum(path));
  fxCache.set(path, v);
  return v;
}

/**
 * マス単位の距離を Fx に変換して引く（1 マス = FX_ONE）。
 * 中身は `cfgFx` と同じだが、呼び出し側で単位が読み取れるように別名にしている。
 */
export function cfgTiles(path: string): Fx {
  return cfgFx(path);
}

/**
 * 秒を tick に変換して引く（四捨五入）。
 * 端数は切り上げも切り捨てもしない。丸め方をここ 1 箇所に固定するのが目的。
 */
export function cfgTicks(path: string): number {
  const key = `ticks:${path}`;
  const hit = numCache.get(key);
  if (hit !== undefined) return hit;
  const t = Math.round(cfgNum(path) * TICK_RATE);
  numCache.set(key, t);
  return t;
}

/** 「毎秒 x」を「毎 tick の Fx」に変換して引く（士気の増減など）。 */
export function cfgPerTickFx(path: string): Fx {
  const key = `pertick:${path}`;
  const hit = fxCache.get(key);
  if (hit !== undefined) return hit;
  const v = fx(cfgNum(path) / TICK_RATE);
  fxCache.set(key, v);
  return v;
}

/** 数値配列を引く（建設速度テーブルなど）。 */
export function cfgNumArray(path: string): readonly number[] {
  const v = readPath(configJson as unknown, path);
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'number' || !Number.isFinite(x))) {
    throw new Error(`config.json: ${path} は有限数の配列である必要があります`);
  }
  return v as number[];
}

/** 数値配列を Fx 配列にして引く。 */
export function cfgFxArray(path: string): readonly Fx[] {
  return cfgNumArray(path).map(fx);
}

/** オブジェクトをそのまま引く（相性行列・オプション表など）。 */
export function cfgObject(path: string): Record<string, unknown> {
  const v = readPath(configJson as unknown, path);
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new Error(`config.json: ${path} はオブジェクトである必要があります`);
  }
  return v as Record<string, unknown>;
}

/** 配列をそのまま引く（`ages` など）。 */
export function cfgArray(path: string): readonly unknown[] {
  const v = readPath(configJson as unknown, path);
  if (!Array.isArray(v)) {
    throw new Error(`config.json: ${path} は配列である必要があります`);
  }
  return v;
}

/** 時代（`ages`）の定義。添字 0..3 が `AGE_IDS` に対応する。 */
export interface AgeConfig {
  readonly id: string;
  readonly slots: number;
  readonly cost: Readonly<Record<string, number>>;
  readonly researchTicks: number;
  readonly requireBuildingsOfPrevAge: number;
}

let agesCache: readonly AgeConfig[] | null = null;

/** `ages` を tick 変換込みで引く。 */
export function cfgAges(): readonly AgeConfig[] {
  if (agesCache !== null) return agesCache;
  const raw = cfgArray('ages');
  agesCache = raw.map((a, i) => {
    const rec = a as Record<string, unknown>;
    const id = rec['id'];
    if (typeof id !== 'string') throw new Error(`config.json: ages[${i}].id が文字列でありません`);
    const slots = rec['slots'];
    if (typeof slots !== 'number') throw new Error(`config.json: ages[${i}].slots が数値でありません`);
    const sec = typeof rec['researchSec'] === 'number' ? rec['researchSec'] : 0;
    const cost = (rec['cost'] ?? {}) as Record<string, number>;
    const req =
      typeof rec['requireBuildingsOfPrevAge'] === 'number' ? rec['requireBuildingsOfPrevAge'] : 0;
    return {
      id,
      slots,
      cost,
      researchTicks: Math.round(sec * TICK_RATE),
      requireBuildingsOfPrevAge: req,
    };
  });
  return agesCache;
}

/** テスト用。キャッシュを捨てる。 */
export function resetConfigCache(): void {
  numCache.clear();
  fxCache.clear();
  agesCache = null;
}

// ---------------------------------------------------------------- 内部

function readPath(root: unknown, path: string): unknown {
  const parts = path.split('.');
  let cur: unknown = root;
  for (let i = 0; i < parts.length; i++) {
    const key = parts[i] as string;
    if (typeof cur !== 'object' || cur === null) {
      throw new Error(
        `config.json: ${path} を解決できません（${parts.slice(0, i).join('.') || '(root)'} がオブジェクトでない）`,
      );
    }
    cur = (cur as Record<string, unknown>)[key];
    if (cur === undefined) {
      throw new Error(`config.json: ${path} が存在しません（${parts.slice(0, i + 1).join('.')} が未定義）`);
    }
  }
  return cur;
}

function readNumber(root: unknown, path: string): number {
  const v = readPath(root, path);
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`config.json: ${path} は有限の数値である必要があります（実際: ${describe(v)}）`);
  }
  return v;
}

function describe(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}
