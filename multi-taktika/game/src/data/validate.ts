/**
 * マスターデータの起動時バリデータ（T-M1-02）。
 *
 * 実装手順書 §0.5 / §5:
 *   - 数値はすべて JSON にある。コードに数値リテラルを書かない。
 *   - 読み込み時に検証し、失敗したら **起動時に** 例外にする
 *     （試合中に落ちるより起動時に落とす）。
 *
 * 外部ライブラリ（zod 等）を入れない方針なので、必要最小限の
 * スキーマ DSL を自作している。エラーメッセージにはデータ上の
 * パス（例 `units.json:y-ashigaru.cost.food`）を必ず含める。
 */

// ---------------------------------------------------------------- エラー

export class DataValidationError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(
      `マスターデータの検証に失敗しました（${issues.length} 件）:\n` +
        issues.map((s) => `  - ${s}`).join('\n'),
    );
    this.name = 'DataValidationError';
  }
}

// ---------------------------------------------------------------- 収集器

/** 検証中に見つけた問題を貯める。1 件目で止めずに全部集めてから投げる。 */
export class Issues {
  private readonly list: string[] = [];

  constructor(private readonly source: string) {}

  add(path: string, message: string): void {
    this.list.push(`${this.source}:${path} ${message}`);
  }

  get count(): number {
    return this.list.length;
  }

  all(): readonly string[] {
    return this.list;
  }

  /** 問題が 1 件でもあれば例外にする。 */
  throwIfAny(): void {
    if (this.list.length > 0) throw new DataValidationError(this.list);
  }
}

// ---------------------------------------------------------------- 基本検査

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** オブジェクト（辞書）であることを検査する。§5「トップレベルはオブジェクト」 */
export function expectRecord(
  iss: Issues,
  path: string,
  v: unknown,
): Record<string, unknown> | null {
  if (!isRecord(v)) {
    iss.add(path, `はオブジェクトである必要があります（実際: ${typeName(v)}）`);
    return null;
  }
  return v;
}

export function expectString(iss: Issues, path: string, v: unknown): string | null {
  if (typeof v !== 'string') {
    iss.add(path, `は文字列である必要があります（実際: ${typeName(v)}）`);
    return null;
  }
  return v;
}

export function expectNumber(iss: Issues, path: string, v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    iss.add(path, `は有限の数値である必要があります（実際: ${typeName(v)}）`);
    return null;
  }
  return v;
}

export function expectInt(iss: Issues, path: string, v: unknown): number | null {
  const n = expectNumber(iss, path, v);
  if (n === null) return null;
  if (!Number.isInteger(n)) {
    iss.add(path, `は整数である必要があります（実際: ${n}）`);
    return null;
  }
  return n;
}

export function expectBool(iss: Issues, path: string, v: unknown): boolean | null {
  if (typeof v !== 'boolean') {
    iss.add(path, `は真偽値である必要があります（実際: ${typeName(v)}）`);
    return null;
  }
  return v;
}

export function expectArray(iss: Issues, path: string, v: unknown): unknown[] | null {
  if (!Array.isArray(v)) {
    iss.add(path, `は配列である必要があります（実際: ${typeName(v)}）`);
    return null;
  }
  return v;
}

/** 数値が範囲内であることを検査する。 */
export function expectRange(
  iss: Issues,
  path: string,
  v: unknown,
  min: number,
  max: number,
): number | null {
  const n = expectNumber(iss, path, v);
  if (n === null) return null;
  if (n < min || n > max) {
    iss.add(path, `は ${min}〜${max} の範囲である必要があります（実際: ${n}）`);
    return null;
  }
  return n;
}

/** 列挙値のいずれかであることを検査する。 */
export function expectEnum<T extends string>(
  iss: Issues,
  path: string,
  v: unknown,
  allowed: readonly T[],
): T | null {
  const s = expectString(iss, path, v);
  if (s === null) return null;
  if (!(allowed as readonly string[]).includes(s)) {
    iss.add(path, `は ${allowed.join(' | ')} のいずれかである必要があります（実際: "${s}"）`);
    return null;
  }
  return s as T;
}

/** 参照先の ID が存在することを検査する（外部キー制約）。 */
export function expectRef(
  iss: Issues,
  path: string,
  id: unknown,
  known: ReadonlySet<string>,
  kind: string,
): string | null {
  const s = expectString(iss, path, id);
  if (s === null) return null;
  if (!known.has(s)) {
    iss.add(path, `の参照先 "${s}" は ${kind} に存在しません`);
    return null;
  }
  return s;
}

/** 参照 ID の配列を検査する。 */
export function expectRefArray(
  iss: Issues,
  path: string,
  v: unknown,
  known: ReadonlySet<string>,
  kind: string,
): string[] {
  const arr = expectArray(iss, path, v);
  if (arr === null) return [];
  const out: string[] = [];
  arr.forEach((item, i) => {
    const r = expectRef(iss, `${path}[${i}]`, item, known, kind);
    if (r !== null) out.push(r);
  });
  return out;
}

/**
 * コスト表（`{ food: 50, wood: 20 }`）を検査する。
 * 資源 ID は resources.json 由来のものだけを許す。
 */
export function expectCost(
  iss: Issues,
  path: string,
  v: unknown,
  resourceIds: ReadonlySet<string>,
): Record<string, number> {
  const rec = expectRecord(iss, path, v);
  if (rec === null) return {};
  const out: Record<string, number> = {};
  for (const [k, raw] of Object.entries(rec)) {
    if (!resourceIds.has(k)) {
      iss.add(`${path}.${k}`, `は資源 ID ではありません（${[...resourceIds].join(' | ')}）`);
      continue;
    }
    const n = expectNumber(iss, `${path}.${k}`, raw);
    if (n === null) continue;
    if (n < 0) {
      iss.add(`${path}.${k}`, `は 0 以上である必要があります（実際: ${n}）`);
      continue;
    }
    out[k] = n;
  }
  return out;
}

/** 想定していないキーが混ざっていないかを検査する（綴り間違いの検出）。 */
export function expectNoUnknownKeys(
  iss: Issues,
  path: string,
  rec: Record<string, unknown>,
  allowed: readonly string[],
): void {
  for (const k of Object.keys(rec)) {
    if (k.startsWith('_')) continue; // `_meta` などの注釈キーは許可
    if (!allowed.includes(k)) {
      iss.add(`${path}.${k}`, `は未知のキーです（許可: ${allowed.join(', ')}）`);
    }
  }
}

/** 件数がちょうど期待どおりであることを検査する（手順書 §14.2 の件数検証）。 */
export function expectCount(
  iss: Issues,
  path: string,
  actual: number,
  expected: number,
  label: string,
): void {
  if (actual !== expected) {
    iss.add(path, `の${label}は ${expected} 件である必要があります（実際: ${actual} 件）`);
  }
}

/**
 * ID 一覧が期待集合と完全一致することを検査する。
 * 不足と余剰を別々に報告する（どちらなのかが分からないと直せない）。
 */
export function expectIdSet(
  iss: Issues,
  path: string,
  actual: readonly string[],
  expected: readonly string[],
): void {
  const a = new Set(actual);
  const e = new Set(expected);
  const missing = expected.filter((id) => !a.has(id));
  const extra = actual.filter((id) => !e.has(id));
  if (missing.length > 0) iss.add(path, `に不足している ID: ${missing.join(', ')}`);
  if (extra.length > 0) iss.add(path, `に余分な ID: ${extra.join(', ')}`);
}

/**
 * 辞書の全エントリを検査する共通ループ。
 * `_` で始まるキー（`_meta` など）は注釈として読み飛ばす。
 */
export function forEachEntry(
  iss: Issues,
  path: string,
  v: unknown,
  visit: (id: string, entry: Record<string, unknown>, entryPath: string) => void,
): string[] {
  const rec = expectRecord(iss, path, v);
  if (rec === null) return [];
  const ids: string[] = [];
  for (const id of Object.keys(rec)) {
    if (id.startsWith('_')) continue;
    const entryPath = path === '' ? id : `${path}.${id}`;
    const entry = expectRecord(iss, entryPath, rec[id]);
    if (entry === null) continue;
    ids.push(id);
    visit(id, entry, entryPath);
  }
  return ids;
}

// ---------------------------------------------------------------- 補助

function typeName(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}
