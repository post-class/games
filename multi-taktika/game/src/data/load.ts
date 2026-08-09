/**
 * マスターデータの読み込みとファイル横断の整合性検証（T-M1-02 本体）。
 *
 * 各 JSON 単体の検証は `tests/unit/data.*.test.ts` が担当している。
 * ここが見るのは **ファイルをまたいだ参照の整合性** で、単体テストでは
 * 絶対に見つけられない種類の壊れ方を捕まえる:
 *
 *   - `units.json` の `producedAt` が `buildings.json` に無い
 *   - `buildings.json` の `produces` が `units.json` に無い
 *   - `civs.json` の `unitTree` に載っている兵が `units.json` に無い
 *   - `civs.json` の `forbidBuildings` に載せた建物が、その文明の兵の
 *     `producedAt` になっている（＝作れない建物から兵が出る矛盾）
 *   - `effects` / `econBonus` の `type` が `techs.json:_meta.effectTypes` に未登録
 *   - `role` が `config.json:counterMatrix` に行を持たない
 *
 * 実装手順書 §0.5 / §5 / §14.2。読み込み時に検証し、失敗したら
 * **起動時に例外**（試合中に落ちるより起動時に落とす）。
 */

import configJson from './config.json' with { type: 'json' };
import resourcesJson from './resources.json' with { type: 'json' };
import unitsJson from './units.json' with { type: 'json' };
import buildingsJson from './buildings.json' with { type: 'json' };
import techsJson from './techs.json' with { type: 'json' };
import ordersJson from './orders.json' with { type: 'json' };
import civsJson from './civs.json' with { type: 'json' };
import mapsJson from './maps.json' with { type: 'json' };
import aiJson from './ai.json' with { type: 'json' };

import { Issues, expectRecord, isRecord } from './validate.js';

// ---------------------------------------------------------------- 型

/** 検証を通ったマスターデータ一式。sim / ui はこれだけを参照する。 */
export interface GameData {
  readonly config: Record<string, unknown>;
  readonly resources: Record<string, unknown>;
  readonly units: Record<string, unknown>;
  readonly buildings: Record<string, unknown>;
  readonly techs: Record<string, unknown>;
  readonly orders: Record<string, unknown>;
  readonly civs: Record<string, unknown>;
  readonly maps: Record<string, unknown>;
  readonly ai: Record<string, unknown>;
  /** `_` で始まる注釈キーを除いた ID 集合。参照検査に使う。 */
  readonly ids: {
    readonly resources: ReadonlySet<string>;
    readonly units: ReadonlySet<string>;
    readonly buildings: ReadonlySet<string>;
    readonly techs: ReadonlySet<string>;
    readonly orders: ReadonlySet<string>;
    readonly civs: ReadonlySet<string>;
    readonly maps: ReadonlySet<string>;
    readonly ai: ReadonlySet<string>;
    readonly ages: ReadonlySet<string>;
    readonly roles: ReadonlySet<string>;
    readonly effectTypes: ReadonlySet<string>;
  };
}

// ---------------------------------------------------------------- 入口

let cached: GameData | null = null;

/**
 * マスターデータを読み込み、検証して返す。
 * 2 回目以降はキャッシュを返す（JSON は不変）。
 * @throws DataValidationError 検証に失敗した場合
 */
export function loadGameData(): GameData {
  if (cached !== null) return cached;
  cached = buildAndValidate();
  return cached;
}

/** テスト用。キャッシュを捨てる。 */
export function resetGameDataCache(): void {
  cached = null;
}

// ---------------------------------------------------------------- 本体

function buildAndValidate(): GameData {
  const iss = new Issues('data');

  const config = asRecord(configJson);
  const resources = asRecord(resourcesJson);
  const units = asRecord(unitsJson);
  const buildings = asRecord(buildingsJson);
  const techs = asRecord(techsJson);
  const orders = asRecord(ordersJson);
  const civs = asRecord(civsJson);
  const maps = asRecord(mapsJson);
  const ai = asRecord(aiJson);

  const ids = {
    resources: entryIds(resources),
    units: entryIds(units),
    buildings: entryIds(buildings),
    techs: entryIds(techs),
    orders: entryIds(orders),
    civs: entryIds(civs),
    maps: entryIds(maps),
    ai: entryIds(ai),
    ages: ageIds(config),
    roles: counterMatrixRoles(config),
    effectTypes: effectTypeIds(techs),
  };

  checkUnits(iss, units, ids);
  checkBuildings(iss, buildings, ids);
  checkTechs(iss, techs, ids);
  checkOrders(iss, orders, ids);
  checkCivs(iss, civs, units, buildings, ids);

  iss.throwIfAny();

  return { config, resources, units, buildings, techs, orders, civs, maps, ai, ids };
}

// ---------------------------------------------------------------- 各ファイル

function checkUnits(iss: Issues, units: Record<string, unknown>, ids: GameData['ids']): void {
  forEntries(units, (id, u) => {
    const p = `units.json:${id}`;

    refIfPresent(iss, `${p}.producedAt`, u['producedAt'], ids.buildings, 'buildings.json');
    refIfPresent(iss, `${p}.upgradeTo`, u['upgradeTo'], ids.units, 'units.json');
    refIfPresent(iss, `${p}.age`, u['age'], ids.ages, 'config.json:ages');
    refIfPresent(iss, `${p}.civ`, u['civ'], ids.civs, 'civs.json');

    // role は相性行列に行があること。行が無い role は戦闘計算で黙って
    // neutral になり、バランスの穴として長く残る。
    const role = u['role'];
    if (typeof role === 'string' && !ids.roles.has(role)) {
      iss.add(`${p}.role`, `"${role}" は config.json:counterMatrix に行がありません`);
    }

    for (const key of Object.keys(asRecord(u['cost']))) {
      if (!ids.resources.has(key)) {
        iss.add(`${p}.cost.${key}`, `は資源 ID ではありません`);
      }
    }
  });
}

function checkBuildings(
  iss: Issues,
  buildings: Record<string, unknown>,
  ids: GameData['ids'],
): void {
  forEntries(buildings, (id, b) => {
    const p = `buildings.json:${id}`;

    refIfPresent(iss, `${p}.age`, b['age'], ids.ages, 'config.json:ages');
    refIfPresent(iss, `${p}.civ`, b['civ'], ids.civs, 'civs.json');
    refIfPresent(iss, `${p}.replaces`, b['replaces'], ids.buildings, 'buildings.json');
    // 付属物は複数の親を持てる（井戸は町の中心と家の両方に付く）ので配列も許す
    refOneOrMany(iss, `${p}.attachedTo`, b['attachedTo'], ids.buildings, 'buildings.json');

    refArray(iss, `${p}.produces`, b['produces'], ids.units, 'units.json');
    refArray(iss, `${p}.researches`, b['researches'], ids.techs, 'techs.json');
    refArray(iss, `${p}.attachments`, b['attachments'], ids.buildings, 'buildings.json');

    for (const key of Object.keys(asRecord(b['cost']))) {
      if (!ids.resources.has(key)) {
        iss.add(`${p}.cost.${key}`, `は資源 ID ではありません`);
      }
    }

    checkEffects(iss, `${p}.effects`, b['effects'], ids);
  });
}

function checkTechs(iss: Issues, techs: Record<string, unknown>, ids: GameData['ids']): void {
  forEntries(techs, (id, t) => {
    const p = `techs.json:${id}`;

    refIfPresent(iss, `${p}.at`, t['at'], ids.buildings, 'buildings.json');
    refIfPresent(iss, `${p}.age`, t['age'], ids.ages, 'config.json:ages');
    refArray(iss, `${p}.requires`, t['requires'], ids.techs, 'techs.json');

    for (const key of Object.keys(asRecord(t['cost']))) {
      if (!ids.resources.has(key)) {
        iss.add(`${p}.cost.${key}`, `は資源 ID ではありません`);
      }
    }

    checkEffects(iss, `${p}.effects`, t['effects'], ids);

    // 前提の循環（A が B を要求し、B が A を要求する）を検出する。
    // 研究ツリーが開けなくなるが、単体テストでは気づけない。
    if (hasCycle(id, techs)) {
      iss.add(`${p}.requires`, `に循環があります`);
    }
  });
}

function checkOrders(iss: Issues, orders: Record<string, unknown>, ids: GameData['ids']): void {
  forEntries(orders, (id, o) => {
    const p = `orders.json:${id}`;
    refIfPresent(iss, `${p}.civ`, o['civ'], ids.civs, 'civs.json');

    // tier は二重旗（上段 1 枚 + 下段 1 枚）の判定に使うので必須。
    const tier = o['tier'];
    if (tier !== 'upper' && tier !== 'lower') {
      iss.add(`${p}.tier`, `は "upper" | "lower" である必要があります（実際: ${String(tier)}）`);
    }
  });
}

function checkCivs(
  iss: Issues,
  civs: Record<string, unknown>,
  units: Record<string, unknown>,
  buildings: Record<string, unknown>,
  ids: GameData['ids'],
): void {
  forEntries(civs, (civId, c) => {
    const p = `civs.json:${civId}`;

    refIfPresent(iss, `${p}.uniqueOrder`, c['uniqueOrder'], ids.orders, 'orders.json');
    refIfPresent(iss, `${p}.uniqueTech`, c['uniqueTech'], ids.techs, 'techs.json');
    refIfPresent(iss, `${p}.eliteUnit`, c['eliteUnit'], ids.units, 'units.json');
    refArray(iss, `${p}.forbidBuildings`, c['forbidBuildings'], ids.buildings, 'buildings.json');
    refArray(iss, `${p}.forbidTechs`, c['forbidTechs'], ids.techs, 'techs.json');
    refArray(iss, `${p}.uniqueBuildings`, c['uniqueBuildings'], ids.buildings, 'buildings.json');

    for (const [from, to] of Object.entries(asRecord(c['replaceBuildings']))) {
      if (!ids.buildings.has(from)) {
        iss.add(`${p}.replaceBuildings.${from}`, `は buildings.json に存在しません`);
      }
      refIfPresent(iss, `${p}.replaceBuildings.${from}`, to, ids.buildings, 'buildings.json');
    }

    checkEffects(iss, `${p}.econBonus`, c['econBonus'], ids);

    // --- unitTree: 全要素が units.json にあり、その文明のものであること ---
    const forbidden = new Set(stringArray(c['forbidBuildings']));
    const replaced = asRecord(c['replaceBuildings']);
    const tree = asRecord(c['unitTree']);
    for (const [line, raw] of Object.entries(tree)) {
      if (!Array.isArray(raw)) {
        iss.add(`${p}.unitTree.${line}`, `は配列である必要があります`);
        continue;
      }
      if (raw.length !== 3) {
        iss.add(
          `${p}.unitTree.${line}`,
          `は [青銅, 鉄器, 帝国] の 3 要素である必要があります（実際: ${raw.length}）`,
        );
      }
      raw.forEach((slot, i) => {
        for (const unitId of slot === null ? [] : Array.isArray(slot) ? slot : [slot]) {
          const path = `${p}.unitTree.${line}[${i}]`;
          if (typeof unitId !== 'string' || !ids.units.has(unitId)) {
            iss.add(path, `の "${String(unitId)}" は units.json に存在しません`);
            continue;
          }
          const u = asRecord(units[unitId]);
          if (u['civ'] !== civId) {
            iss.add(path, `の "${unitId}" は civ が "${String(u['civ'])}" で ${civId} と一致しません`);
          }
          // 作れない建物から兵が出る矛盾を検出する。
          // 置換先（例 castle → great_tent）が使えるなら矛盾ではない。
          const at = u['producedAt'];
          if (typeof at === 'string' && forbidden.has(at) && replaced[at] === undefined) {
            iss.add(
              path,
              `の "${unitId}" は producedAt "${at}" だが ${civId} は ${at} を建てられません`,
            );
          }
        }
      });
    }

    // エリートは城（モンゴルは大天幕）で生産される。禁止建物になっていないこと。
    const elite = c['eliteUnit'];
    if (typeof elite === 'string' && ids.units.has(elite)) {
      const at = asRecord(units[elite])['producedAt'];
      if (typeof at === 'string') {
        if (!ids.buildings.has(at)) {
          iss.add(`${p}.eliteUnit`, `の生産元 "${at}" は buildings.json に存在しません`);
        } else if (forbidden.has(at) && replaced[at] === undefined) {
          iss.add(`${p}.eliteUnit`, `の生産元 "${at}" は ${civId} が建てられません`);
        } else if (asRecord(buildings[at])['isOrderSource'] !== true) {
          // 城／大天幕は令の発信点でもある（03§3 / 07§4）。
          iss.add(`${p}.eliteUnit`, `の生産元 "${at}" は令の発信点になっていません`);
        }
      }
    }

    // 固有令はその文明のものであること。
    const uo = c['uniqueOrder'];
    if (typeof uo === 'string' && ids.orders.has(uo)) {
      const o = asRecord(orders(uo));
      if (o['civ'] !== civId) {
        iss.add(`${p}.uniqueOrder`, `"${uo}" の civ が "${String(o['civ'])}" で一致しません`);
      }
    }
  });

  function orders(id: string): unknown {
    return asRecord(ordersJson)[id];
  }
}

// ---------------------------------------------------------------- effects

/**
 * `effects` / `econBonus` の `type` が `techs.json:_meta.effectTypes` に
 * 登録されていることを検査する。
 *
 * 手順書 §5.6「効果は型で表現し、コードに文明名・研究名の分岐を書かない」を
 * 守るための番人。未登録の type は適用エンジンから黙って無視されるので、
 * ここで落とさないと「JSON に書いたのに効かない」というバグになる。
 */
function checkEffects(iss: Issues, path: string, v: unknown, ids: GameData['ids']): void {
  if (v === undefined) return;
  if (!Array.isArray(v)) {
    iss.add(path, `は配列である必要があります`);
    return;
  }
  v.forEach((e, i) => {
    const p = `${path}[${i}]`;
    if (!isRecord(e)) {
      iss.add(p, `はオブジェクトである必要があります`);
      return;
    }
    const type = e['type'];
    if (typeof type !== 'string') {
      iss.add(`${p}.type`, `は文字列である必要があります`);
      return;
    }
    if (!ids.effectTypes.has(type)) {
      iss.add(
        `${p}.type`,
        `"${type}" は techs.json:_meta.effectTypes に未登録です（登録しないと適用エンジンが無視します）`,
      );
    }
    // 参照を含む効果はその参照先も検査する。
    refIfPresent(iss, `${p}.resource`, e['resource'], ids.resources, 'resources.json');
    refIfPresent(iss, `${p}.building`, e['building'], ids.buildings, 'buildings.json');
    // `at` は 1 件でも複数でも書ける（軍団編成は兵舎・射場・厩の 3 件）
    refOneOrMany(iss, `${p}.at`, e['at'], ids.buildings, 'buildings.json');
    refArray(iss, `${p}.units`, e['units'], ids.units, 'units.json');
    refArray(iss, `${p}.roles`, e['roles'], ids.roles, 'config.json:counterMatrix');
  });
}

// ---------------------------------------------------------------- 小道具

function asRecord(v: unknown): Record<string, unknown> {
  return isRecord(v) ? v : {};
}

/** `_` で始まる注釈キーを除いた ID 集合。 */
function entryIds(rec: Record<string, unknown>): Set<string> {
  return new Set(Object.keys(rec).filter((k) => !k.startsWith('_')));
}

function forEntries(
  rec: Record<string, unknown>,
  visit: (id: string, entry: Record<string, unknown>) => void,
): void {
  for (const id of Object.keys(rec)) {
    if (id.startsWith('_')) continue;
    visit(id, asRecord(rec[id]));
  }
}

function ageIds(config: Record<string, unknown>): Set<string> {
  const out = new Set<string>();
  const ages = config['ages'];
  if (Array.isArray(ages)) {
    for (const a of ages) {
      const id = asRecord(a)['id'];
      if (typeof id === 'string') out.add(id);
    }
  }
  return out;
}

function counterMatrixRoles(config: Record<string, unknown>): Set<string> {
  return new Set(Object.keys(asRecord(config['counterMatrix'])));
}

function effectTypeIds(techs: Record<string, unknown>): Set<string> {
  const meta = asRecord(techs['_meta']);
  const reg = meta['effectTypes'];
  if (Array.isArray(reg)) {
    return new Set(
      reg.map((e) => (typeof e === 'string' ? e : String(asRecord(e)['type']))).filter(Boolean),
    );
  }
  return entryIds(asRecord(reg));
}

function stringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** 値があるときだけ参照検査する（省略可能なキー用）。null は「無し」として許す。 */
function refIfPresent(
  iss: Issues,
  path: string,
  v: unknown,
  known: ReadonlySet<string>,
  kind: string,
): void {
  if (v === undefined || v === null) return;
  if (typeof v !== 'string') {
    iss.add(path, `は文字列である必要があります（実際: ${typeof v}）`);
    return;
  }
  if (!known.has(v)) {
    iss.add(path, `の参照先 "${v}" は ${kind} に存在しません`);
  }
}

/** 単一の ID でも ID 配列でも受ける（データ側の書き方を強制しないため）。 */
function refOneOrMany(
  iss: Issues,
  path: string,
  v: unknown,
  known: ReadonlySet<string>,
  kind: string,
): void {
  if (Array.isArray(v)) refArray(iss, path, v, known, kind);
  else refIfPresent(iss, path, v, known, kind);
}

function refArray(
  iss: Issues,
  path: string,
  v: unknown,
  known: ReadonlySet<string>,
  kind: string,
): void {
  if (v === undefined || v === null) return;
  if (!Array.isArray(v)) {
    iss.add(path, `は配列である必要があります`);
    return;
  }
  v.forEach((item, i) => refIfPresent(iss, `${path}[${i}]`, item, known, kind));
}

/** 研究の前提に循環があるか（深さ優先で辿る）。 */
function hasCycle(start: string, techs: Record<string, unknown>): boolean {
  const seen = new Set<string>();
  const stack = [start];
  let first = true;
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (!first && id === start) return true;
    first = false;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const req of stringArray(asRecord(techs[id])['requires'])) {
      stack.push(req);
    }
  }
  return false;
}

// 未使用警告を避けるための再エクスポート（呼び出し側の利便）。
export { expectRecord };
