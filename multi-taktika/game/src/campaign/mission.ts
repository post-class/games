/**
 * campaign/mission.ts — ミッション定義の型・読み込み・検証（T-M16-01）
 *
 * 完了条件は「**JSON で完結し、コードにミッション固有の分岐が無い**」こと。
 * したがってこのファイルには
 *   - 「第 1 話は内政だけ」「第 4 話は南が押される」のような**個別の話の知識**
 *   - バランス数値（tick 数・体数・資源量）
 * を一切書かない。書いてよいのは
 *   ① 定義の**型**（勝利条件 / 敗北条件 / スクリプトイベントの種類）
 *   ② その型に合っているかの**検証**（壊れていたら起動時に例外。`src/data/validate.ts` の作法）
 * だけ。ミッションを足すときに触るのは `src/data/campaign/*.json` だけになる。
 *
 * ---- 定義ファイルの見つけ方 ----
 *
 * `src/data/campaign/*.json` を `import.meta.glob` で**全部**読む。
 * ここを明示 import の羅列にすると「ミッションを足すときに .ts を触る」ことになり、
 * T-M16-01 の完了条件を満たせなくなるため。`_` で始まるファイル
 * （`_config.json`）は定義ではなく構造値なので除外する。
 *
 * ---- 分岐（T-M16-03）----
 *
 * `onVictory` / `onDefeat` に次のミッション ID を書く。**負けても `onDefeat` があるので
 * ゲームオーバーにならない**（`02`「戦のあと ― この世界に『滅亡』はない」）。
 * 服属ルート（`route: "vassal"`）は「開始資源が少ない / 寄せ手が多い」を
 * `extends` + 上書きで表す。**コードに服属の分岐は無い。**
 */

import { AGE_IDS, CIV_IDS, MAP_TYPE_IDS, RESOURCE_IDS } from '@/shared/types';
import type { Age, CivId, MapTypeId, OrderId, ResourceId, Tier } from '@/shared/types';
import { cfgObject } from '@/sim/core/config';
import { MAX_FRONTS } from '@/sim';
import { loadGameData } from '@/data/load';
import {
  DataValidationError,
  Issues,
  expectArray,
  expectBool,
  expectEnum,
  expectInt,
  expectNoUnknownKeys,
  expectRecord,
  expectRef,
  expectString,
  isRecord,
} from '@/data/validate';

import campaignConfig from '@/data/campaign/_config.json' with { type: 'json' };

// ---------------------------------------------------------------------------
// 構造値（`_config.json`。コードに数値リテラルを書かないための唯一の窓口）
// ---------------------------------------------------------------------------

/** `_config.json` の 1 セクションを引く（無ければ起動時に例外）。 */
function section(name: string): Record<string, unknown> {
  const raw = (campaignConfig as Record<string, unknown>)[name];
  if (!isRecord(raw)) {
    throw new Error(`campaign/_config.json: "${name}" セクションがありません`);
  }
  return raw;
}

function configInt(sectionName: string, key: string): number {
  const v = section(sectionName)[key];
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    throw new Error(`campaign/_config.json: ${sectionName}.${key} は整数である必要があります`);
  }
  return v;
}

function configString(sectionName: string, key: string): string {
  const v = section(sectionName)[key];
  if (typeof v !== 'string') {
    throw new Error(`campaign/_config.json: ${sectionName}.${key} は文字列である必要があります`);
  }
  return v;
}

/** セーブの互換性（T-M16-06）。 */
export const SAVE_VERSION: number = configInt('save', 'version');
export const SAVE_STORAGE_KEY: string = configString('save', 'storageKey');
export const SAVE_MAX_HISTORY: number = configInt('save', 'maxHistory');

/** 構造的な上限（バランス値ではなく「壊れた定義」を落とすための安全弁）。 */
const LIMITS = {
  placementOffsetTiles: configInt('limits', 'maxPlacementOffsetTiles'),
  unitsPerGroup: configInt('limits', 'maxUnitsPerGroup'),
  groupsPerEvent: configInt('limits', 'maxGroupsPerEvent'),
  events: configInt('limits', 'maxEvents'),
  conditions: configInt('limits', 'maxConditions'),
  hints: configInt('limits', 'maxHints'),
  textChars: configInt('limits', 'maxTextChars'),
  ticks: configInt('limits', 'maxTicks'),
  count: configInt('limits', 'maxCount'),
  percent: configInt('limits', 'percentMax'),
  spawnSearchTiles: configInt('limits', 'maxSpawnSearchTiles'),
} as const;

/** ユニット・建物を置く場所を探す範囲（マス）。`runner.ts` が使う。 */
export const SPAWN_SEARCH_TILES = LIMITS.spawnSearchTiles;

/** 百分率の最大値（忠誠度の条件を % で書けるようにするための換算に使う）。 */
export const PERCENT_MAX = LIMITS.percent;

// ---------------------------------------------------------------------------
// 型
// ---------------------------------------------------------------------------

/** ルート。`vassal` = 服属ルート（`02` の服属。負けた側が進む立場の悪いルート）。 */
export type MissionRoute = 'main' | 'vassal';

/** 置き場所。マス指定と「あるプレイヤーの開始位置からの相対」の 2 通り。 */
export type Placement =
  | { readonly kind: 'absolute'; readonly tileX: number; readonly tileY: number }
  | { readonly kind: 'relative'; readonly player: number; readonly dx: number; readonly dy: number };

/** 出す兵の 1 組。 */
export interface UnitGroup {
  readonly unit: string;
  readonly count: number;
}

/**
 * 勝利条件 / 敗北条件の共通型。
 *
 * **`victory` は全部満たしたら勝ち（AND）、`defeat` はどれか 1 つで負け（OR）**。
 * `player` は正規化済みの playerId（JSON では `"self"` と書ける）。
 */
export type MissionCondition =
  /** 対象プレイヤーの町の中心をすべて破壊した（`03§10` の「制圧」）。 */
  | { readonly type: 'destroyAllTownCenters'; readonly target: number }
  /** 指定 tick まで進んだ。`victory` では「守り切った」、`defeat` では「時間切れ」。 */
  | { readonly type: 'surviveTicks'; readonly ticks: number }
  /** その資源を累計で `amount` 単位集めた（**累計**なので使っても減らない）。 */
  | {
      readonly type: 'gatherResource';
      readonly player: number;
      readonly resource: ResourceId;
      readonly amount: number;
    }
  /** その令が立っている戦域を `count` 本、`ticks` の間続けて保った。 */
  | {
      readonly type: 'holdFrontsWithOrder';
      readonly player: number;
      readonly order: OrderId;
      readonly count: number;
      readonly ticks: number;
    }
  /** 生存ユニット数（`unit` が null なら種類を問わない）。 */
  | {
      readonly type: 'unitCountAtLeast' | 'unitCountAtMost';
      readonly player: number;
      readonly unit: string | null;
      readonly count: number;
    }
  /** 完成済み建物の棟数。 */
  | {
      readonly type: 'buildingCountAtLeast' | 'buildingCountAtMost';
      readonly player: number;
      readonly building: string;
      readonly count: number;
    }
  /** 忠誠度が `percent` % 以下（`03§10` の敗北条件）。 */
  | { readonly type: 'loyaltyAtMostPercent'; readonly player: number; readonly percent: number };

/** 条件の種類の固定順リスト（検証と網羅性の担保に使う）。 */
export const MISSION_CONDITION_TYPES = [
  'destroyAllTownCenters',
  'surviveTicks',
  'gatherResource',
  'holdFrontsWithOrder',
  'unitCountAtLeast',
  'unitCountAtMost',
  'buildingCountAtLeast',
  'buildingCountAtMost',
  'loyaltyAtMostPercent',
] as const satisfies readonly MissionCondition['type'][];

/**
 * イベントの発火条件。
 *
 * **`Date.now()` は使わない**（リプレイで再現できなくなる。§0.3）。
 * 発火は tick 番号か World の状態だけで決まる。
 */
export type MissionTrigger =
  | { readonly type: 'atTick'; readonly tick: number }
  /** 自軍の戦域が `count` 本以上立った。 */
  | { readonly type: 'frontOpened'; readonly count: number }
  /** 任意の条件（勝敗条件と同じ型を使い回す）。 */
  | { readonly type: 'condition'; readonly condition: MissionCondition };

/** イベントの内容。 */
export type MissionAction =
  /** ヒントを 1 行出す（`06§13` の練習メニューの文をそのまま入れてよい）。 */
  | { readonly type: 'showHint'; readonly text: string }
  /** 兵を置く（動かさない）。 */
  | {
      readonly type: 'spawnUnits';
      readonly player: number;
      readonly units: readonly UnitGroup[];
      readonly at: Placement;
    }
  /** 兵を置いて、`attackAt` へ向かわせる（`moveUnits` コマンドを出す）。 */
  | {
      readonly type: 'spawnEnemyWave';
      readonly player: number;
      readonly units: readonly UnitGroup[];
      readonly at: Placement;
      readonly attackAt: Placement | null;
    }
  /** 資源を渡す（援軍・年貢の表現）。単位数。 */
  | {
      readonly type: 'grantResources';
      readonly player: number;
      readonly resources: readonly { readonly resource: ResourceId; readonly amount: number }[];
    }
  /** 令をセットする（`setOrder` コマンドを出す。敵側の演出に使う）。 */
  | {
      readonly type: 'setOrder';
      readonly player: number;
      readonly front: number;
      readonly order: OrderId;
      readonly tier: Tier;
    };

/** アクションの種類の固定順リスト。 */
export const MISSION_ACTION_TYPES = [
  'showHint',
  'spawnUnits',
  'spawnEnemyWave',
  'grantResources',
  'setOrder',
] as const satisfies readonly MissionAction['type'][];

/** スクリプトイベント 1 件。 */
export interface MissionEvent {
  readonly trigger: MissionTrigger;
  readonly action: MissionAction;
  /** true = 1 回だけ発火（既定）。false = 条件が成立するたび発火。 */
  readonly once: boolean;
}

/** 初期配置に足すユニット。 */
export interface MissionUnitPlacement {
  readonly player: number;
  readonly unit: string;
  readonly count: number;
  readonly at: Placement;
}

/** 初期配置に足す建物（完成状態で置く）。 */
export interface MissionBuildingPlacement {
  readonly player: number;
  readonly building: string;
  readonly at: Placement;
}

/** 初期配置（`createMatch` に渡す分 + ミッション固有の追加分）。 */
export interface MissionSetup {
  readonly map: MapTypeId;
  readonly seed: number;
  readonly playerCount: number;
  /** 人間が操作するプレイヤー（`"self"` の解決先）。 */
  readonly player: number;
  readonly civs: readonly CivId[];
  readonly teams: readonly number[];
  readonly startAge: Age;
  readonly startResources: string;
  readonly assignVillagers: boolean;
  /** 開始資源の上書き（単位数）。服属ルートの「蔵が空」を表すのに使う。 */
  readonly resourceOverrides: readonly {
    readonly player: number;
    readonly resources: readonly { readonly resource: ResourceId; readonly amount: number }[];
  }[];
  readonly units: readonly MissionUnitPlacement[];
  readonly buildings: readonly MissionBuildingPlacement[];
}

/** ミッション 1 件（検証済み）。 */
export interface Mission {
  readonly id: string;
  readonly chapter: number;
  /** 章の中の話数（1..）。服属ルートは分岐元と同じ番号を持つ。 */
  readonly index: number;
  readonly route: MissionRoute;
  readonly title: string;
  readonly brief: string;
  readonly hints: readonly string[];
  readonly setup: MissionSetup;
  readonly victory: readonly MissionCondition[];
  readonly defeat: readonly MissionCondition[];
  readonly events: readonly MissionEvent[];
  /** 勝ったら次（null = 章の終わり）。 */
  readonly onVictory: string | null;
  /** 負けたら次（null = 終端。**null になるのは onVictory も null の終端だけ**）。 */
  readonly onDefeat: string | null;
}

/** 章の見出し（章選択画面が使う）。 */
export interface ChapterInfo {
  readonly chapter: number;
  readonly title: string;
  readonly subtitle: string;
  readonly age: Age;
  readonly missionCount: number;
}

// ---------------------------------------------------------------------------
// 参照集合
// ---------------------------------------------------------------------------

interface RefSets {
  readonly units: ReadonlySet<string>;
  readonly buildings: ReadonlySet<string>;
  readonly orders: ReadonlySet<string>;
  readonly startResourcePresets: ReadonlySet<string>;
}

function refSets(): RefSets {
  const data = loadGameData();
  const presets = cfgObject('matchOptions.startResources.presets');
  return {
    units: data.ids.units,
    buildings: data.ids.buildings,
    orders: data.ids.orders,
    startResourcePresets: new Set(Object.keys(presets).filter((k) => !k.startsWith('_'))),
  };
}

// ---------------------------------------------------------------------------
// 検証つき読み込み
// ---------------------------------------------------------------------------

const SETUP_KEYS = [
  'map',
  'seed',
  'playerCount',
  'player',
  'civs',
  'teams',
  'startAge',
  'startResources',
  'assignVillagers',
  'resourceOverrides',
  'units',
  'buildings',
] as const;

const MISSION_KEYS = [
  'extends',
  'id',
  'chapter',
  'index',
  'route',
  'title',
  'brief',
  'hints',
  'setup',
  'victory',
  'defeat',
  'events',
  'extraEvents',
  'onVictory',
  'onDefeat',
] as const;

/**
 * 生の JSON 1 件をミッションに変換する。
 *
 * @param source エラーメッセージに出す出所（ファイル名）
 * @throws DataValidationError 1 か所でも壊れていたら（全件集めてから投げる）
 */
export function parseMission(raw: unknown, source: string): Mission {
  const iss = new Issues(source);
  const m = parseMissionInto(iss, raw, refSets());
  iss.throwIfAny();
  if (m === null) throw new DataValidationError([`${source}: ミッションを読めませんでした`]);
  return m;
}

function parseMissionInto(iss: Issues, raw: unknown, refs: RefSets): Mission | null {
  const rec = expectRecord(iss, '', raw);
  if (rec === null) return null;
  expectNoUnknownKeys(iss, '', rec, MISSION_KEYS);

  const id = expectString(iss, 'id', rec['id']);
  const chapter = expectInt(iss, 'chapter', rec['chapter']);
  const index = expectInt(iss, 'index', rec['index']);
  const route = expectEnum<MissionRoute>(iss, 'route', rec['route'], ['main', 'vassal']);
  const title = expectString(iss, 'title', rec['title']);
  const brief = expectString(iss, 'brief', rec['brief']);
  const hints = parseTextArray(iss, 'hints', rec['hints']);
  const setup = parseSetup(iss, 'setup', rec['setup'], refs);
  if (id === null || chapter === null || index === null || route === null) return null;
  if (title === null || brief === null || setup === null) return null;

  const victory = parseConditions(iss, 'victory', rec['victory'], setup, refs);
  const defeat = parseConditions(iss, 'defeat', rec['defeat'], setup, refs);
  const events = parseEvents(iss, rec, setup, refs);

  if (victory.length === 0) {
    iss.add('victory', 'は 1 件以上必要です（勝てないミッションになります）');
  }
  if (hints.length === 0) {
    iss.add('hints', 'は 1 件以上必要です（何をすればよいか分からないミッションになります）');
  }
  if (chapter < 1 || index < 1) {
    iss.add('chapter', 'と index は 1 以上である必要があります');
  }

  const onVictory = parseNextId(iss, 'onVictory', rec['onVictory']);
  const onDefeat = parseNextId(iss, 'onDefeat', rec['onDefeat']);
  // **負けてもゲームオーバーにしない**（T-M16-03）。敗北条件があるのに
  // 行き先が無いミッションは、負けたら詰む = 資料と矛盾するので落とす。
  // 例外は終端（勝っても次が無い章の最後）だけ。
  if (defeat.length > 0 && onDefeat === null && onVictory !== null) {
    iss.add(
      'onDefeat',
      'は敗北条件があるミッションでは必須です（負けてもゲームオーバーにしない。02 の服属）',
    );
  }

  return {
    id,
    chapter,
    index,
    route,
    title,
    brief,
    hints,
    setup,
    victory,
    defeat,
    events,
    onVictory,
    onDefeat,
  };
}

function parseNextId(iss: Issues, path: string, v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return expectString(iss, path, v);
}

function parseTextArray(iss: Issues, path: string, v: unknown): string[] {
  const arr = expectArray(iss, path, v);
  if (arr === null) return [];
  if (arr.length > LIMITS.hints) {
    iss.add(path, `は ${LIMITS.hints} 件以内である必要があります（実際: ${arr.length} 件）`);
  }
  const out: string[] = [];
  for (let i = 0; i < arr.length; i++) {
    const s = expectText(iss, `${path}[${i}]`, arr[i]);
    if (s !== null) out.push(s);
  }
  return out;
}

function expectText(iss: Issues, path: string, v: unknown): string | null {
  const s = expectString(iss, path, v);
  if (s === null) return null;
  if (s.length === 0 || s.length > LIMITS.textChars) {
    iss.add(path, `は 1〜${LIMITS.textChars} 文字である必要があります（実際: ${s.length}）`);
    return null;
  }
  return s;
}

function expectTicks(iss: Issues, path: string, v: unknown): number | null {
  const n = expectInt(iss, path, v);
  if (n === null) return null;
  if (n < 0 || n > LIMITS.ticks) {
    iss.add(path, `は 0〜${LIMITS.ticks} tick である必要があります（実際: ${n}）`);
    return null;
  }
  return n;
}

function expectCount(iss: Issues, path: string, v: unknown, max: number): number | null {
  const n = expectInt(iss, path, v);
  if (n === null) return null;
  if (n < 0 || n > max) {
    iss.add(path, `は 0〜${max} である必要があります（実際: ${n}）`);
    return null;
  }
  return n;
}

// ---------------------------------------------------------------- setup

function parseSetup(iss: Issues, path: string, v: unknown, refs: RefSets): MissionSetup | null {
  const rec = expectRecord(iss, path, v);
  if (rec === null) return null;
  expectNoUnknownKeys(iss, path, rec, SETUP_KEYS);

  const map = expectEnum<MapTypeId>(iss, `${path}.map`, rec['map'], MAP_TYPE_IDS);
  const seed = expectInt(iss, `${path}.seed`, rec['seed']);
  const playerCount = expectInt(iss, `${path}.playerCount`, rec['playerCount']);
  const startAge = expectEnum<Age>(iss, `${path}.startAge`, rec['startAge'], AGE_IDS);
  const preset = expectRef(
    iss,
    `${path}.startResources`,
    rec['startResources'],
    refs.startResourcePresets,
    'config.json:matchOptions.startResources.presets',
  );
  if (map === null || seed === null || playerCount === null || startAge === null) return null;
  if (preset === null) return null;
  if (playerCount < 1) {
    iss.add(`${path}.playerCount`, 'は 1 以上である必要があります');
    return null;
  }

  const player = expectPlayerIndex(iss, `${path}.player`, rec['player'], playerCount);
  if (player === null) return null;

  const civs: CivId[] = [];
  const civArr = expectArray(iss, `${path}.civs`, rec['civs']);
  if (civArr !== null) {
    if (civArr.length !== playerCount) {
      iss.add(`${path}.civs`, `の要素数は playerCount（${playerCount}）と一致させてください`);
    }
    civArr.forEach((c, i) => {
      const civ = expectEnum<CivId>(iss, `${path}.civs[${i}]`, c, CIV_IDS);
      if (civ !== null) civs.push(civ);
    });
  }

  const teams: number[] = [];
  const teamRaw = rec['teams'];
  if (teamRaw === undefined) {
    // 省略時は全員別チーム（`createWorld` と同じ既定）。
    for (let p = 0; p < playerCount; p++) teams.push(p);
  } else {
    const arr = expectArray(iss, `${path}.teams`, teamRaw);
    if (arr !== null) {
      if (arr.length !== playerCount) {
        iss.add(`${path}.teams`, `の要素数は playerCount（${playerCount}）と一致させてください`);
      }
      arr.forEach((t, i) => {
        const n = expectCount(iss, `${path}.teams[${i}]`, t, playerCount);
        if (n !== null) teams.push(n);
      });
    }
  }

  const assignVillagers =
    rec['assignVillagers'] === undefined
      ? true
      : (expectBool(iss, `${path}.assignVillagers`, rec['assignVillagers']) ?? true);

  const resourceOverrides: MissionSetup['resourceOverrides'][number][] = [];
  const ovArr = rec['resourceOverrides'] === undefined ? [] : expectArray(iss, `${path}.resourceOverrides`, rec['resourceOverrides']);
  (ovArr ?? []).forEach((o, i) => {
    const p = `${path}.resourceOverrides[${i}]`;
    const orec = expectRecord(iss, p, o);
    if (orec === null) return;
    expectNoUnknownKeys(iss, p, orec, ['player', 'resources']);
    const pl = expectPlayerIndex(iss, `${p}.player`, orec['player'], playerCount);
    const res = parseResourceAmounts(iss, `${p}.resources`, orec['resources']);
    if (pl === null) return;
    resourceOverrides.push({ player: pl, resources: res });
  });

  const units: MissionUnitPlacement[] = [];
  const unitArr = rec['units'] === undefined ? [] : expectArray(iss, `${path}.units`, rec['units']);
  (unitArr ?? []).forEach((u, i) => {
    const p = `${path}.units[${i}]`;
    const urec = expectRecord(iss, p, u);
    if (urec === null) return;
    expectNoUnknownKeys(iss, p, urec, ['player', 'unit', 'count', 'at']);
    const pl = expectPlayerIndex(iss, `${p}.player`, urec['player'], playerCount);
    const unit = expectRef(iss, `${p}.unit`, urec['unit'], refs.units, 'units.json');
    const count = expectCount(iss, `${p}.count`, urec['count'], LIMITS.unitsPerGroup);
    const at = parsePlacement(iss, `${p}.at`, urec['at'], playerCount);
    if (pl === null || unit === null || count === null || at === null) return;
    units.push({ player: pl, unit, count, at });
  });

  const buildings: MissionBuildingPlacement[] = [];
  const bArr = rec['buildings'] === undefined ? [] : expectArray(iss, `${path}.buildings`, rec['buildings']);
  (bArr ?? []).forEach((b, i) => {
    const p = `${path}.buildings[${i}]`;
    const brec = expectRecord(iss, p, b);
    if (brec === null) return;
    expectNoUnknownKeys(iss, p, brec, ['player', 'building', 'at']);
    const pl = expectPlayerIndex(iss, `${p}.player`, brec['player'], playerCount);
    const building = expectRef(iss, `${p}.building`, brec['building'], refs.buildings, 'buildings.json');
    const at = parsePlacement(iss, `${p}.at`, brec['at'], playerCount);
    if (pl === null || building === null || at === null) return;
    buildings.push({ player: pl, building, at });
  });

  return {
    map,
    seed,
    playerCount,
    player,
    civs,
    teams,
    startAge,
    startResources: preset,
    assignVillagers,
    resourceOverrides,
    units,
    buildings,
  };
}

function expectPlayerIndex(
  iss: Issues,
  path: string,
  v: unknown,
  playerCount: number,
): number | null {
  const n = expectInt(iss, path, v);
  if (n === null) return null;
  if (n < 0 || n >= playerCount) {
    iss.add(path, `は 0〜${playerCount - 1} である必要があります（実際: ${n}）`);
    return null;
  }
  return n;
}

/** `"self"` を人間プレイヤー番号に解決する（正規化後は数値だけになる）。 */
function expectPlayerRef(
  iss: Issues,
  path: string,
  v: unknown,
  setup: MissionSetup,
): number | null {
  if (v === undefined || v === 'self') return setup.player;
  return expectPlayerIndex(iss, path, v, setup.playerCount);
}

function parseResourceAmounts(
  iss: Issues,
  path: string,
  v: unknown,
): { readonly resource: ResourceId; readonly amount: number }[] {
  const rec = expectRecord(iss, path, v);
  if (rec === null) return [];
  const out: { resource: ResourceId; amount: number }[] = [];
  // 資源は `RESOURCE_IDS` の固定順で読む（オブジェクトのキー順に依存しない。§0.3）。
  for (let r = 0; r < RESOURCE_IDS.length; r++) {
    const id = RESOURCE_IDS[r]!;
    const raw = rec[id];
    if (raw === undefined) continue;
    const n = expectInt(iss, `${path}.${id}`, raw);
    if (n === null || n < 0) {
      if (n !== null) iss.add(`${path}.${id}`, 'は 0 以上である必要があります');
      continue;
    }
    out.push({ resource: id, amount: n });
  }
  for (const k of Object.keys(rec)) {
    if (!(RESOURCE_IDS as readonly string[]).includes(k)) {
      iss.add(`${path}.${k}`, `は資源 ID ではありません（${RESOURCE_IDS.join(' | ')}）`);
    }
  }
  return out;
}

function parsePlacement(
  iss: Issues,
  path: string,
  v: unknown,
  playerCount: number,
): Placement | null {
  const rec = expectRecord(iss, path, v);
  if (rec === null) return null;
  if (rec['tileX'] !== undefined || rec['tileY'] !== undefined) {
    expectNoUnknownKeys(iss, path, rec, ['tileX', 'tileY']);
    const tileX = expectInt(iss, `${path}.tileX`, rec['tileX']);
    const tileY = expectInt(iss, `${path}.tileY`, rec['tileY']);
    if (tileX === null || tileY === null) return null;
    if (tileX < 0 || tileY < 0) {
      iss.add(path, 'の tileX / tileY は 0 以上である必要があります');
      return null;
    }
    return { kind: 'absolute', tileX, tileY };
  }
  expectNoUnknownKeys(iss, path, rec, ['player', 'dx', 'dy']);
  const player = expectPlayerIndex(iss, `${path}.player`, rec['player'], playerCount);
  const dx = expectOffset(iss, `${path}.dx`, rec['dx']);
  const dy = expectOffset(iss, `${path}.dy`, rec['dy']);
  if (player === null || dx === null || dy === null) return null;
  return { kind: 'relative', player, dx, dy };
}

function expectOffset(iss: Issues, path: string, v: unknown): number | null {
  const n = expectInt(iss, path, v);
  if (n === null) return null;
  const max = LIMITS.placementOffsetTiles;
  if (n < -max || n > max) {
    iss.add(path, `は ${-max}〜${max} マスである必要があります（実際: ${n}）`);
    return null;
  }
  return n;
}

// ---------------------------------------------------------------- conditions

function parseConditions(
  iss: Issues,
  path: string,
  v: unknown,
  setup: MissionSetup,
  refs: RefSets,
): MissionCondition[] {
  if (v === undefined) return [];
  const arr = expectArray(iss, path, v);
  if (arr === null) return [];
  if (arr.length > LIMITS.conditions) {
    iss.add(path, `は ${LIMITS.conditions} 件以内である必要があります（実際: ${arr.length} 件）`);
  }
  const out: MissionCondition[] = [];
  for (let i = 0; i < arr.length; i++) {
    const c = parseCondition(iss, `${path}[${i}]`, arr[i], setup, refs);
    if (c !== null) out.push(c);
  }
  return out;
}

function parseCondition(
  iss: Issues,
  path: string,
  v: unknown,
  setup: MissionSetup,
  refs: RefSets,
): MissionCondition | null {
  const rec = expectRecord(iss, path, v);
  if (rec === null) return null;
  const type = expectEnum(iss, `${path}.type`, rec['type'], MISSION_CONDITION_TYPES);
  if (type === null) return null;

  switch (type) {
    case 'destroyAllTownCenters': {
      expectNoUnknownKeys(iss, path, rec, ['type', 'target']);
      const target = expectPlayerIndex(iss, `${path}.target`, rec['target'], setup.playerCount);
      return target === null ? null : { type, target };
    }
    case 'surviveTicks': {
      expectNoUnknownKeys(iss, path, rec, ['type', 'ticks']);
      const ticks = expectTicks(iss, `${path}.ticks`, rec['ticks']);
      return ticks === null ? null : { type, ticks };
    }
    case 'gatherResource': {
      expectNoUnknownKeys(iss, path, rec, ['type', 'player', 'resource', 'amount']);
      const player = expectPlayerRef(iss, `${path}.player`, rec['player'], setup);
      const resource = expectEnum<ResourceId>(
        iss,
        `${path}.resource`,
        rec['resource'],
        RESOURCE_IDS,
      );
      const amount = expectCount(iss, `${path}.amount`, rec['amount'], LIMITS.count);
      if (player === null || resource === null || amount === null) return null;
      return { type, player, resource, amount };
    }
    case 'holdFrontsWithOrder': {
      expectNoUnknownKeys(iss, path, rec, ['type', 'player', 'order', 'count', 'ticks']);
      const player = expectPlayerRef(iss, `${path}.player`, rec['player'], setup);
      const order = expectRef(iss, `${path}.order`, rec['order'], refs.orders, 'orders.json');
      const count = expectCount(iss, `${path}.count`, rec['count'], MAX_FRONTS);
      const ticks = expectTicks(iss, `${path}.ticks`, rec['ticks']);
      if (player === null || order === null || count === null || ticks === null) return null;
      if (count < 1) {
        iss.add(`${path}.count`, 'は 1 以上である必要があります');
        return null;
      }
      return { type, player, order: order as OrderId, count, ticks };
    }
    case 'unitCountAtLeast':
    case 'unitCountAtMost': {
      expectNoUnknownKeys(iss, path, rec, ['type', 'player', 'unit', 'count']);
      const player = expectPlayerRef(iss, `${path}.player`, rec['player'], setup);
      const unit =
        rec['unit'] === undefined || rec['unit'] === null
          ? null
          : expectRef(iss, `${path}.unit`, rec['unit'], refs.units, 'units.json');
      const count = expectCount(iss, `${path}.count`, rec['count'], LIMITS.count);
      if (player === null || count === null) return null;
      if (rec['unit'] !== undefined && rec['unit'] !== null && unit === null) return null;
      return { type, player, unit, count };
    }
    case 'buildingCountAtLeast':
    case 'buildingCountAtMost': {
      expectNoUnknownKeys(iss, path, rec, ['type', 'player', 'building', 'count']);
      const player = expectPlayerRef(iss, `${path}.player`, rec['player'], setup);
      const building = expectRef(
        iss,
        `${path}.building`,
        rec['building'],
        refs.buildings,
        'buildings.json',
      );
      const count = expectCount(iss, `${path}.count`, rec['count'], LIMITS.count);
      if (player === null || building === null || count === null) return null;
      return { type, player, building, count };
    }
    case 'loyaltyAtMostPercent': {
      expectNoUnknownKeys(iss, path, rec, ['type', 'player', 'percent']);
      const player = expectPlayerRef(iss, `${path}.player`, rec['player'], setup);
      const percent = expectCount(iss, `${path}.percent`, rec['percent'], LIMITS.percent);
      if (player === null || percent === null) return null;
      return { type, player, percent };
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------- events

function parseEvents(
  iss: Issues,
  rec: Record<string, unknown>,
  setup: MissionSetup,
  refs: RefSets,
): MissionEvent[] {
  const out: MissionEvent[] = [];
  collectEvents(iss, 'events', rec['events'], setup, refs, out);
  // `extends` した定義に足すぶん（服属ルートで寄せ手を増やす、など）。
  collectEvents(iss, 'extraEvents', rec['extraEvents'], setup, refs, out);
  if (out.length > LIMITS.events) {
    iss.add('events', `は ${LIMITS.events} 件以内である必要があります（実際: ${out.length} 件）`);
  }
  return out;
}

function collectEvents(
  iss: Issues,
  path: string,
  v: unknown,
  setup: MissionSetup,
  refs: RefSets,
  out: MissionEvent[],
): void {
  if (v === undefined) return;
  const arr = expectArray(iss, path, v);
  if (arr === null) return;
  for (let i = 0; i < arr.length; i++) {
    const e = parseEvent(iss, `${path}[${i}]`, arr[i], setup, refs);
    if (e !== null) out.push(e);
  }
}

const EVENT_COMMON_KEYS = ['when', 'atTick', 'once', 'type'] as const;

function parseEvent(
  iss: Issues,
  path: string,
  v: unknown,
  setup: MissionSetup,
  refs: RefSets,
): MissionEvent | null {
  const rec = expectRecord(iss, path, v);
  if (rec === null) return null;

  const trigger = parseTrigger(iss, path, rec, setup, refs);
  const once = rec['once'] === undefined ? true : (expectBool(iss, `${path}.once`, rec['once']) ?? true);
  const action = parseAction(iss, path, rec, setup, refs);
  if (trigger === null || action === null) return null;
  return { trigger, action, once };
}

function parseTrigger(
  iss: Issues,
  path: string,
  rec: Record<string, unknown>,
  setup: MissionSetup,
  refs: RefSets,
): MissionTrigger | null {
  const hasAtTick = rec['atTick'] !== undefined;
  const hasWhen = rec['when'] !== undefined;
  if (hasAtTick && hasWhen) {
    iss.add(path, 'は atTick と when のどちらか一方だけを持てます');
    return null;
  }
  if (hasAtTick) {
    const tick = expectTicks(iss, `${path}.atTick`, rec['atTick']);
    return tick === null ? null : { type: 'atTick', tick };
  }
  if (!hasWhen) {
    iss.add(path, 'には atTick か when が必要です（Date.now() は使えないので tick か World の状態で決める）');
    return null;
  }
  const wrec = expectRecord(iss, `${path}.when`, rec['when']);
  if (wrec === null) return null;
  const type = expectEnum(iss, `${path}.when.type`, wrec['type'], [
    'atTick',
    'frontOpened',
    'condition',
  ] as const);
  if (type === null) return null;
  switch (type) {
    case 'atTick': {
      expectNoUnknownKeys(iss, `${path}.when`, wrec, ['type', 'tick']);
      const tick = expectTicks(iss, `${path}.when.tick`, wrec['tick']);
      return tick === null ? null : { type, tick };
    }
    case 'frontOpened': {
      expectNoUnknownKeys(iss, `${path}.when`, wrec, ['type', 'count']);
      const count = expectCount(iss, `${path}.when.count`, wrec['count'], MAX_FRONTS);
      if (count === null) return null;
      if (count < 1) {
        iss.add(`${path}.when.count`, 'は 1 以上である必要があります');
        return null;
      }
      return { type, count };
    }
    case 'condition': {
      expectNoUnknownKeys(iss, `${path}.when`, wrec, ['type', 'condition']);
      const condition = parseCondition(
        iss,
        `${path}.when.condition`,
        wrec['condition'],
        setup,
        refs,
      );
      return condition === null ? null : { type, condition };
    }
    default:
      return null;
  }
}

function parseAction(
  iss: Issues,
  path: string,
  rec: Record<string, unknown>,
  setup: MissionSetup,
  refs: RefSets,
): MissionAction | null {
  const type = expectEnum(iss, `${path}.type`, rec['type'], MISSION_ACTION_TYPES);
  if (type === null) return null;

  switch (type) {
    case 'showHint': {
      expectNoUnknownKeys(iss, path, rec, [...EVENT_COMMON_KEYS, 'text']);
      const text = expectText(iss, `${path}.text`, rec['text']);
      return text === null ? null : { type, text };
    }
    case 'spawnUnits':
    case 'spawnEnemyWave': {
      const allowed =
        type === 'spawnEnemyWave'
          ? [...EVENT_COMMON_KEYS, 'player', 'units', 'at', 'attackAt']
          : [...EVENT_COMMON_KEYS, 'player', 'units', 'at'];
      expectNoUnknownKeys(iss, path, rec, allowed);
      const player = expectPlayerIndex(iss, `${path}.player`, rec['player'], setup.playerCount);
      const units = parseUnitGroups(iss, `${path}.units`, rec['units'], refs);
      const at = parsePlacement(iss, `${path}.at`, rec['at'], setup.playerCount);
      if (player === null || at === null || units.length === 0) {
        if (units.length === 0) iss.add(`${path}.units`, 'は 1 組以上必要です');
        return null;
      }
      if (type === 'spawnUnits') return { type, player, units, at };
      const attackAt =
        rec['attackAt'] === undefined || rec['attackAt'] === null
          ? null
          : parsePlacement(iss, `${path}.attackAt`, rec['attackAt'], setup.playerCount);
      return { type, player, units, at, attackAt };
    }
    case 'grantResources': {
      expectNoUnknownKeys(iss, path, rec, [...EVENT_COMMON_KEYS, 'player', 'resources']);
      const player = expectPlayerIndex(iss, `${path}.player`, rec['player'], setup.playerCount);
      const resources = parseResourceAmounts(iss, `${path}.resources`, rec['resources']);
      if (player === null) return null;
      if (resources.length === 0) {
        iss.add(`${path}.resources`, 'は 1 種類以上必要です');
        return null;
      }
      return { type, player, resources };
    }
    case 'setOrder': {
      expectNoUnknownKeys(iss, path, rec, [...EVENT_COMMON_KEYS, 'player', 'front', 'order', 'tier']);
      const player = expectPlayerIndex(iss, `${path}.player`, rec['player'], setup.playerCount);
      const front = expectCount(iss, `${path}.front`, rec['front'], MAX_FRONTS);
      const order = expectRef(iss, `${path}.order`, rec['order'], refs.orders, 'orders.json');
      const tier = expectEnum<Tier>(iss, `${path}.tier`, rec['tier'], ['upper', 'lower']);
      if (player === null || front === null || order === null || tier === null) return null;
      return { type, player, front, order: order as OrderId, tier };
    }
    default:
      return null;
  }
}

function parseUnitGroups(iss: Issues, path: string, v: unknown, refs: RefSets): UnitGroup[] {
  const arr = expectArray(iss, path, v);
  if (arr === null) return [];
  if (arr.length > LIMITS.groupsPerEvent) {
    iss.add(path, `は ${LIMITS.groupsPerEvent} 組以内である必要があります`);
  }
  const out: UnitGroup[] = [];
  for (let i = 0; i < arr.length; i++) {
    const p = `${path}[${i}]`;
    const rec = expectRecord(iss, p, arr[i]);
    if (rec === null) continue;
    expectNoUnknownKeys(iss, p, rec, ['unit', 'count']);
    const unit = expectRef(iss, `${p}.unit`, rec['unit'], refs.units, 'units.json');
    const count = expectCount(iss, `${p}.count`, rec['count'], LIMITS.unitsPerGroup);
    if (unit === null || count === null || count < 1) {
      if (count !== null && count < 1) iss.add(`${p}.count`, 'は 1 以上である必要があります');
      continue;
    }
    out.push({ unit, count });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 全ミッションの読み込み（起動時 1 回）
// ---------------------------------------------------------------------------

/**
 * `src/data/campaign/*.json` を全部読む。
 * **明示 import の羅列にしない**（ミッションを足すときに .ts を触らないため。T-M16-01）。
 */
const RAW_FILES = import.meta.glob<unknown>('../data/campaign/*.json', {
  eager: true,
  import: 'default',
});

/** `extends` を解決する。トップレベルは浅く、`setup` だけ 1 段深くマージする。 */
function resolveExtends(
  iss: Issues,
  id: string,
  rawById: ReadonlyMap<string, Record<string, unknown>>,
  seen: readonly string[],
): Record<string, unknown> | null {
  const rec = rawById.get(id);
  if (rec === undefined) {
    iss.add(id, 'は extends の参照先として存在しません');
    return null;
  }
  const base = rec['extends'];
  if (base === undefined || base === null) return rec;
  if (typeof base !== 'string') {
    iss.add(`${id}.extends`, 'は文字列である必要があります');
    return null;
  }
  if (seen.includes(base)) {
    iss.add(`${id}.extends`, `に循環があります（${[...seen, base].join(' → ')}）`);
    return null;
  }
  const parent = resolveExtends(iss, base, rawById, [...seen, id]);
  if (parent === null) return null;

  const merged: Record<string, unknown> = { ...parent, ...rec };
  delete merged['extends'];
  const ps = parent['setup'];
  const cs = rec['setup'];
  if (isRecord(ps) && isRecord(cs)) merged['setup'] = { ...ps, ...cs };
  // `extraEvents` は継承しない（足す側だけのもの）。継承すると 2 重に足される。
  if (rec['extraEvents'] === undefined) delete merged['extraEvents'];
  return merged;
}

function loadAllMissions(): Mission[] {
  const iss = new Issues('campaign');
  /** ミッション個別の検証結果（出所を `campaign:<id>` にしたいので別の Issues で集める）。 */
  const perMission: string[] = [];
  const refs = refSets();

  // ファイル名昇順で読む（`Map` の反復順ではなく**名前の昇順**に固定する。§0.3）。
  const paths = Object.keys(RAW_FILES).sort();
  const rawById = new Map<string, Record<string, unknown>>();
  const order: string[] = [];
  for (const path of paths) {
    const file = path.slice(path.lastIndexOf('/') + 1);
    if (file.startsWith('_')) continue; // `_config.json` は定義ではない
    const rec = RAW_FILES[path];
    if (!isRecord(rec)) {
      iss.add(file, 'はオブジェクトである必要があります');
      continue;
    }
    const id = rec['id'];
    if (typeof id !== 'string' || id.length === 0) {
      iss.add(file, 'に文字列の id がありません');
      continue;
    }
    if (rawById.has(id)) {
      iss.add(file, `の id "${id}" は重複しています`);
      continue;
    }
    rawById.set(id, rec);
    order.push(id);
  }

  const missions: Mission[] = [];
  for (const id of order) {
    const merged = resolveExtends(iss, id, rawById, [id]);
    if (merged === null) continue;
    const sub = new Issues(`campaign:${id}`);
    const m = parseMissionInto(sub, merged, refs);
    perMission.push(...sub.all());
    if (m === null) continue;
    if (m.id !== id) {
      iss.add(id, `の id が "${m.id}" になっています（ファイルの id と一致させてください）`);
      continue;
    }
    missions.push(m);
  }

  // 分岐先が存在すること（T-M16-03）。
  const known = new Set(missions.map((m) => m.id));
  for (const m of missions) {
    for (const [key, next] of [
      ['onVictory', m.onVictory],
      ['onDefeat', m.onDefeat],
    ] as const) {
      if (next !== null && !known.has(next)) {
        iss.add(`${m.id}.${key}`, `の参照先 "${next}" というミッションはありません`);
      }
      if (next === m.id) {
        iss.add(`${m.id}.${key}`, 'が自分自身を指しています（進めなくなります）');
      }
    }
  }
  // 服属ルートは勝てば本線に戻れること（`02`「そこで勝てば旗を戻して本線に復帰」）。
  const byId = new Map(missions.map((m) => [m.id, m]));
  for (const m of missions) {
    if (m.route !== 'vassal' || m.onVictory === null) continue;
    const next = byId.get(m.onVictory);
    if (next !== undefined && next.route !== 'main') {
      iss.add(`${m.id}.onVictory`, 'は服属ルートから本線（route: "main"）へ戻す必要があります');
    }
  }
  // 敗北を辿って必ず終端に着くこと（無限ループにしない）。
  for (const m of missions) {
    let cur: Mission | undefined = m;
    const path: string[] = [];
    while (cur !== undefined && cur.onDefeat !== null) {
      if (path.includes(cur.id)) {
        iss.add(`${m.id}.onDefeat`, `の連鎖に循環があります（${path.join(' → ')}）`);
        break;
      }
      path.push(cur.id);
      cur = byId.get(cur.onDefeat);
    }
  }

  const problems = [...iss.all(), ...perMission];
  if (problems.length > 0) throw new DataValidationError(problems);

  // 章 → 話数 → ルート（本線が先）→ id の順に並べる。反復順を名前で固定する。
  missions.sort(
    (a, b) =>
      a.chapter - b.chapter ||
      a.index - b.index ||
      (a.route === b.route ? 0 : a.route === 'main' ? -1 : 1) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return missions;
}

/** 検証済みの全ミッション（章 → 話数 → ルートの順）。 */
export const MISSIONS: readonly Mission[] = loadAllMissions();

const MISSION_INDEX = new Map<string, Mission>(MISSIONS.map((m) => [m.id, m]));

/** ID からミッションを引く（無ければ null）。 */
export function missionById(id: string): Mission | null {
  return MISSION_INDEX.get(id) ?? null;
}

/** 章の一覧（`_config.json` の `chapters`）。 */
export function campaignChapters(): readonly ChapterInfo[] {
  const raw = (campaignConfig as Record<string, unknown>)['chapters'];
  if (!Array.isArray(raw)) throw new Error('campaign/_config.json: chapters は配列である必要があります');
  const out: ChapterInfo[] = [];
  for (const c of raw) {
    if (!isRecord(c)) continue;
    const chapter = c['chapter'];
    const title = c['title'];
    const subtitle = c['subtitle'];
    const age = c['age'];
    if (typeof chapter !== 'number' || typeof title !== 'string') continue;
    out.push({
      chapter,
      title,
      subtitle: typeof subtitle === 'string' ? subtitle : '',
      age: (AGE_IDS as readonly string[]).includes(String(age)) ? (age as Age) : AGE_IDS[0]!,
      missionCount: missionsOfChapter(chapter).filter((m) => m.route === 'main').length,
    });
  }
  out.sort((a, b) => a.chapter - b.chapter);
  return out;
}

/** その章のミッション（本線 + 服属ルート。話数昇順）。 */
export function missionsOfChapter(chapter: number): readonly Mission[] {
  return MISSIONS.filter((m) => m.chapter === chapter);
}

/** その章の本線ミッション（`06§13` の練習メニューの順）。 */
export function mainMissionsOfChapter(chapter: number): readonly Mission[] {
  return MISSIONS.filter((m) => m.chapter === chapter && m.route === 'main');
}

/** 章の最初のミッション（章選択画面の「はじめから」）。 */
export function firstMissionOfChapter(chapter: number): Mission | null {
  return mainMissionsOfChapter(chapter)[0] ?? null;
}
