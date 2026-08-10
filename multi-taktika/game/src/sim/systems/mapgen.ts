/**
 * sim/systems/mapgen.ts — マップ生成（T-M3-02〜06。実装手順書 §6.10 / `07§13`）
 *
 * **`world.rngMap` 以外の乱数を使わない。** 生成後は `rngMap` を触らない。
 *
 * ■ 生成順序（`07§13` の 5 段階。この順序を変えない）
 *   1. 開始位置を円周上に等間隔配置（中心からの距離は全員同一）
 *   2. 各拠点から**同距離・同量**の 森／石／金／食料 を配る
 *   3. 争点（追加の金鉱・豊かな森）を中央に置く
 *   4. 川・森・丘・水域を、**1〜3 を壊さないように**描く
 *   5. 通行検査（全拠点間の到達性 / 隘路が 1 本だけでないか）
 *      → 失敗したら**シードを +1 して作り直す**（最大 20 回、超えたら平野型へフォールバック）
 *
 * ■ 「壊さない」の実装
 *   1〜3 で決めた位置を `reserved`（1 マス 1 バイトの作業マスク）に塗り、
 *   4 の地形描画はすべて `reserved` のマスを飛ばす。**判定を 1 箇所に集める**ことで
 *   「川だけ壊さない実装を忘れた」という事故を防いでいる。
 *
 * ■ 資源ノードの座標を Fx で持つ理由
 *   拠点ごとの資源は「同一の局所テンプレートを、その拠点の方位ぶん回転して置く」方式。
 *   マス（整数）に丸めてから置くと 1 マス弱の丸め誤差が方位ごとに違う形で出て
 *   「同距離」が崩れる。エンティティ座標は Fx なので、**回転後の Fx をそのまま座標にし**、
 *   地形（森タイル）だけを切り捨てでマスに落としている。これで距離差は 1/256 マス未満。
 *
 * ■ 碑の島の特別領域（掟一違反領域）について
 *   `MapState` に領域を持たせると `world.ts` の変更が必要になるため、
 *   **`generateMap` の戻り値 `MapGenResult.lawZones` で返す**。
 *   呼び出し側（M8 の戦域 / M11 の忠誠度）がここを読む。申し送りは報告に記載。
 */

import mapsJson from '@/data/maps.json' with { type: 'json' };

import type { EntityId, MapTypeId } from '@/shared/types';
import { EntityKind, MAP_TYPE_IDS, NEUTRAL_OWNER, RESOURCE_IDS } from '@/shared/types';
import { entityIndex, spawnEntity } from '../core/entity';
import type { Fx } from '../core/fx';
import { FX_ONE, fx, fxFromInt, idiv, isqrt } from '../core/fx';
import {
  Move,
  Tile,
  allocateTerrain,
  hasTerrain,
  inBounds,
  isPassableIndex,
  setTile,
  tileIndex,
} from '../core/terrain';
import type { MoveMask } from '../core/terrain';
import {
  computeReachable,
  findSectorPath,
  getPathfinder,
  invalidatePathfinder,
  sectorOfXY,
  sectorsConnected,
} from '../core/pathfind';
import { resourceNodeDef, resourceNodeIndex } from '../core/gather';
import type { MapState, World } from '../core/world';
import { MAX_PLAYERS } from '../core/world';
import { cfgNum } from '../core/config';

// ---------------------------------------------------------------- 円周方向ベクトル

/** 方向ベクトルのスケール（Q16）。Q8 では丸め誤差が距離に見えるため 1 段細かくしている。 */
const DIR_SCALE = 65536;

/**
 * 円周上の等間隔方向ベクトル（Q16）。`RING_DIRS[n]` が n 人用で、
 * `[i * 2] = cos, [i * 2 + 1] = sin`。角度は `-PI/2 + 2 * PI * i / n`（1 人目が真北）。
 *
 * **表を埋め込みにしている理由**: `Math.cos` は実装依存の丸めを持つため、
 * sim の入力に使うと端末差でデシンクし得る（§0.3）。値は
 * `round(cos(theta) * 65536)` / `round(sin(theta) * 65536)` で、
 * 最も近い .5 境界からの距離が 0.06 あるので再計算でも同じ整数になることを確認済み。
 */
const RING_DIRS: readonly (readonly number[])[] = [
  [], // 0 人（未使用）
  [0, -65536],
  [0, -65536, 0, 65536],
  [0, -65536, 56756, 32768, -56756, 32768],
  [0, -65536, 65536, 0, 0, 65536, -65536, 0],
  [0, -65536, 62328, -20252, 38521, 53020, -38521, 53020, -62328, -20252],
  [0, -65536, 56756, -32768, 56756, 32768, 0, 65536, -56756, 32768, -56756, -32768],
  [0, -65536, 51238, -40861, 63893, 14583, 28435, 59046, -28435, 59046, -63893, 14583, -51238, -40861],
  [0, -65536, 46341, -46341, 65536, 0, 46341, 46341, 0, 65536, -46341, 46341, -65536, 0, -46341, -46341],
];

// ---------------------------------------------------------------- 戻り値の型

/** 開始位置（拠点。町の中心を置く場所）。 */
export interface StartPosition {
  readonly playerId: number;
  /** 中心座標（Fx）。 */
  readonly x: Fx;
  readonly y: Fx;
  /** 中心のマス。 */
  readonly tx: number;
  readonly ty: number;
}

/** 資源ノード 1 個の情報（生成後の検証とデバッグ表示用）。 */
export interface ResourceNodeInfo {
  readonly id: EntityId;
  /** `RESOURCE_IDS` の添字（0 = food, 1 = wood, 2 = stone, 3 = gold）。 */
  readonly resource: number;
  readonly x: Fx;
  readonly y: Fx;
  readonly amount: Fx;
  /** 争点の「豊かな」ノードか。 */
  readonly rich: boolean;
  /** 紐づく拠点の playerId。争点（中央）は -1。 */
  readonly ownerStart: number;
}

/**
 * 特別領域。今は碑の島（島内での交戦が掟一違反）だけが使う。
 * `MapState` を変更せずに済ませるため `MapGenResult` で返す（申し送り）。
 */
export interface LawZone {
  readonly shape: 'circle';
  readonly x: Fx;
  readonly y: Fx;
  readonly radius: Fx;
  /** 中で交戦すると掟一違反（忠誠度ペナルティ）。 */
  readonly lawOne: boolean;
}

/** 橋（河川型）。M10 の建物ではなく地形の路面。 */
export interface BridgeInfo {
  readonly tx: number;
  readonly ty: number;
  readonly widthTiles: number;
  readonly heightTiles: number;
}

/** `generateMap` の結果。 */
export interface MapGenResult {
  readonly mapType: MapTypeId;
  readonly widthTiles: number;
  readonly heightTiles: number;
  /** 添字 = playerId。 */
  readonly starts: readonly StartPosition[];
  readonly nodes: readonly ResourceNodeInfo[];
  readonly lawZones: readonly LawZone[];
  readonly bridges: readonly BridgeInfo[];
  /** 生成を試みた回数（1 = 一発で通った）。 */
  readonly attempts: number;
  /** 20 回失敗して平野型に落ちたか。 */
  readonly usedFallback: boolean;
  /** 到達性検査に使った移動種（列島は水陸両用で判定する）。 */
  readonly reachMask: MoveMask;
}

/** `generateMap` の引数。 */
export interface MapGenOptions {
  readonly mapType: MapTypeId;
}

// ---------------------------------------------------------------- パラメータ

interface MapParams {
  readonly id: MapTypeId;
  readonly waterRatio: number;
  readonly forestRatio: number;
  readonly hillRatio: number;
  readonly riverCount: number;
  readonly bridgeCount: number;
  readonly hasDefile: boolean;
  readonly minDefileCount: number;
  readonly requiresNavy: boolean;
  readonly islandLawZone: boolean;
  readonly islandRadiusRatio: number;
  readonly sizeByPlayers: Readonly<Record<string, number>>;
}

const MAPS = mapsJson as unknown as Record<string, Record<string, unknown>>;

function numOf(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** `maps.json` の 1 型を読む。未知の型は例外（黙って平野にしない）。 */
export function mapParams(mapType: MapTypeId): MapParams {
  const raw = MAPS[mapType];
  if (raw === undefined) throw new Error(`mapgen: 未知のマップ型 "${mapType}"`);
  const island = (raw['islandZone'] ?? {}) as Record<string, unknown>;
  return {
    id: mapType,
    waterRatio: numOf(raw['waterRatio'], 0),
    forestRatio: numOf(raw['forestDensityRatio'], 0),
    hillRatio: numOf(raw['hillAmountRatio'], 0),
    riverCount: numOf(raw['riverCount'], 0),
    bridgeCount: numOf(raw['bridgeCount'], numOf(raw['riverCount'], 0)),
    hasDefile: raw['hasDefile'] === true,
    minDefileCount: numOf(raw['minDefileCount'], 2),
    requiresNavy: raw['requiresNavy'] === true,
    islandLawZone: raw['islandCombatBreaksLawOne'] === true,
    islandRadiusRatio: numOf(island['radiusRatio'], 0.12),
    sizeByPlayers: (raw['sizeByPlayers'] ?? {}) as Record<string, number>,
  };
}

/**
 * 参加人数からマップ 1 辺のマス数を求める（`07§13`）。
 * `maps.json` の `sizeByPlayers` を引き、表に無い人数は
 * 2 人 = 200 / 8 人 = 400 の線形補間（`round(200 + (players - 2) * 200 / 6)`）で作る。
 */
export function mapSizeForPlayers(mapType: MapTypeId, playerCount: number): number {
  const p = mapParams(mapType);
  const hit = p.sizeByPlayers[String(playerCount)];
  if (typeof hit === 'number') return hit;
  const lo = numOf(p.sizeByPlayers['2'], 200);
  const hi = numOf(p.sizeByPlayers['8'], 400);
  const n = playerCount < 2 ? 2 : playerCount > MAX_PLAYERS ? MAX_PLAYERS : playerCount;
  return Math.round(lo + ((n - 2) * (hi - lo)) / 6);
}

/** マップ生成の既定値。申し送り: `config.json` の `mapgen.*` へ移す（キー名は報告参照）。 */
const P = {
  /** 開始位置を置く円の半径 = min(幅, 高さ) × この比率。 */
  startRingRatio: cfgNum('mapgen.startRingRatio'),
  /** 拠点まわりを平地にして保護する半径（マス）。町の中心 4×4 + 余裕。 */
  startClearTiles: cfgNum('mapgen.startClearTiles'),
  /** 争点を置く中央領域の一辺の比率（`07§13`「中央寄り」= 中央 30% 以内）。 */
  contestBoxRatio: cfgNum('mapgen.contestBoxRatio'),
  /** 争点の金鉱・豊かな森を置く中心からの距離（マップ幅比）。 */
  contestRingRatio: cfgNum('mapgen.contestRingRatio'),
  /** 争点ノードの埋蔵量倍率（「他より豊かな」）。 */
  richMul: cfgNum('mapgen.richMul'),
  /** 争点の追加金鉱の数。 */
  contestGoldCount: cfgNum('mapgen.contestGoldCount'),
  /** 争点の豊かな森 1 クラスタの 1 辺（本数 = 辺²）。 */
  contestForestSide: cfgNum('mapgen.contestForestSide'),
  /** 通行検査に失敗したときの作り直し上限（超えたら平野型）。 */
  maxAttempts: cfgNum('mapgen.maxAttempts'),
  /** 地形ノイズの格子間隔（マス）。大きいほど塊が大きい。 */
  noiseCellTiles: cfgNum('mapgen.noiseCellTiles'),
  /** 川の幅（マス）。 */
  riverWidthTiles: cfgNum('mapgen.riverWidthTiles'),
  /** 小川（密林型）の幅（マス）。 */
  streamWidthTiles: cfgNum('mapgen.streamWidthTiles'),
  /** 橋の幅（マス）。 */
  bridgeWidthTiles: cfgNum('mapgen.bridgeWidthTiles'),
  /** 水際が浅瀬になる確率（Fx。0..FX_ONE）。 */
  shallowFringeChance: fx(cfgNum('mapgen.shallowFringeChance')),
  /** 隘路の壁の厚み（マス）。 */
  defileWallThickness: cfgNum('mapgen.defileWallThickness'),
  /** 隘路の通り道の幅（マス）。 */
  defileGapTiles: cfgNum('mapgen.defileGapTiles'),
  /** 列島型で拠点の島を確保する半径（マス）。 */
  islandClearTiles: cfgNum('mapgen.islandClearTiles'),
} as const;

const RES_FOOD = RESOURCE_IDS.indexOf('food');
const RES_WOOD = RESOURCE_IDS.indexOf('wood');
const RES_STONE = RESOURCE_IDS.indexOf('stone');
const RES_GOLD = RESOURCE_IDS.indexOf('gold');

/**
 * 資源（食料/木材/石材/金）→ **資源ノードの種類**の対応。
 *
 * ここが `RESOURCE_IDS` の添字と別物である点が重要。
 * `EntityKind.Resource` の `typeId` は `core/gather.ts` の
 * `RESOURCE_NODE_DEFS` の添字（farm / hunt / fish / fruit / sheep /
 * forest / stone_quarry / gold_mine）で、採集システムはそちらで解釈する。
 *
 * **以前ここに `RESOURCE_IDS` の添字（0..3）を入れていて、
 * 木材が hunt、石材が fish、金が fruit と読まれ「マップ上の資源が全部食料になる」
 * という不整合が起きていた。** 対応表を 1 箇所に固定して同じ事故を防ぐ。
 */
const NODE_OF_RESOURCE: readonly number[] = [
  resourceNodeIndex('fruit'), // 食料 = 果樹（拠点のすぐ横に置くブロック）
  resourceNodeIndex('forest'), // 木材 = 森
  resourceNodeIndex('stone_quarry'), // 石材 = 石切場
  resourceNodeIndex('gold_mine'), // 金 = 金鉱
];

/**
 * 資源ノード 1 個の埋蔵量。
 * `resources.json` の値は `core/gather.ts` が既に Fx に変換して持っているので、
 * ここでは読み直さない（同じ数値を 2 か所で解釈しないため）。
 */
const DEPOSIT: readonly Fx[] = NODE_OF_RESOURCE.map((n) => resourceNodeDef(n).deposit);

/**
 * 食料のノード種別（`03§1`「農地・狩猟・漁・果樹・羊」）。
 *
 * **以前は果樹だけを置いていた。** `resources.json` は 5 種類を定めているのに
 * マップに出るのは果樹だけで、枯れたあとの食料源が農地しか無かった。
 * 農地は木材 60 を食うので、木材が細ると食料も止まる ―― 実測で AI が
 * 青銅の世（食料 500）に 20〜27 分かかり、`07§2` の起伏が成立しなかった。
 * 人間が遊んでも同じ制約を受ける（果樹が枯れたら農地しかない）。
 */
const NODE_FRUIT = resourceNodeIndex('fruit');
const NODE_SHEEP = resourceNodeIndex('sheep');
const NODE_HUNT = resourceNodeIndex('hunt');

/** ノード種別 → 埋蔵量（`resources.json` の `depositsByNode`）。 */
function depositOfNode(node: number): Fx {
  return resourceNodeDef(node).deposit;
}

/** 拠点まわりに置く資源の局所テンプレート（マス単位のオフセット）。 */
interface TemplateNode {
  readonly resource: number;
  /**
   * 資源ノードの種類（省略時は `NODE_OF_RESOURCE[resource]`）。
   * 食料は 5 種類あるので、果樹・羊・狩猟を書き分けるのに使う。
   */
  readonly node?: number;
  /** +x = 中心から見て外向き。 */
  readonly ox: number;
  readonly oy: number;
}

/**
 * 拠点ごとの初期資源テンプレート。**全拠点で同一**なので、
 * 量は完全一致、距離は回転のみ（1/256 マス未満の誤差）になる。
 *
 * 内訳: 木材 18 本（1,800）/ 食料 6 個（750）/ 石 2 か所（700）/ 金 2 か所（800）。
 * 申し送り: `config.json` の `mapgen.startResources` に出したい。
 */
const START_TEMPLATE: readonly TemplateNode[] = buildStartTemplate();

function buildStartTemplate(): TemplateNode[] {
  const out: TemplateNode[] = [];
  // 森 2 クラスタ（拠点の外側寄り）
  pushBlock(out, RES_WOOD, 5, -6, 3, 3);
  pushBlock(out, RES_WOOD, 5, 3, 3, 3);
  // 食料は 3 種類を置く（`03§1`）。**果樹だけだと枯れたあと農地しか無くなる。**
  //  - 果樹（125/個）: 拠点のすぐ横。最初に手を付けるぶん
  //  - 羊（100/頭）: 拠点の反対側。持ち帰りが短い second source
  //  - 狩猟（140/体）: 少し外。取りに行く判断が要る代わりに 1 体が大きい
  pushBlock(out, RES_FOOD, 1, -7, 3, 2, NODE_FRUIT);
  pushBlock(out, RES_FOOD, 1, 5, 2, 2, NODE_SHEEP);
  pushBlock(out, RES_FOOD, 8, -2, 2, 2, NODE_HUNT);
  // 石（中心寄り）
  out.push({ resource: RES_STONE, ox: -7, oy: 4 }, { resource: RES_STONE, ox: -7, oy: 5 });
  // 金（中心寄り）
  out.push({ resource: RES_GOLD, ox: -7, oy: -5 }, { resource: RES_GOLD, ox: -7, oy: -4 });
  return out;
}

function pushBlock(
  out: TemplateNode[],
  resource: number,
  ox: number,
  oy: number,
  w: number,
  h: number,
  node?: number,
): void {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      out.push(node === undefined ? { resource, ox: ox + x, oy: oy + y } : { resource, node, ox: ox + x, oy: oy + y });
    }
  }
}

// ---------------------------------------------------------------- 生成本体

/** 生成途中の作業状態（World には残さない）。 */
interface GenCtx {
  readonly map: MapState;
  readonly w: number;
  readonly h: number;
  readonly cx: Fx;
  readonly cy: Fx;
  readonly reserved: Uint8Array;
  /**
   * 「水にしてはいけない」マス。`reserved` より広く取る。
   * 拠点の周囲は森や丘は生えてよいが、川や海に沈むと詰むため別のマスクにしている。
   * 列島型ではここが「拠点の島」になる。
   */
  readonly noWater: Uint8Array;
  readonly noise: Uint8Array;
  readonly histogram: Int32Array;
  readonly reach: Uint8Array;
  readonly queue: Int32Array;
  readonly starts: StartPosition[];
  readonly plan: PlannedNode[];
  readonly bridges: BridgeInfo[];
}

interface PlannedNode {
  readonly resource: number;
  /**
   * 資源ノードの種類（`RESOURCE_NODE_DEFS` の添字）。
   *
   * **食料だけは種類が 5 つある**（農地・狩猟・漁・果樹・羊。`03§1`）。
   * `resource` だけでは「果樹」に固定されてしまうので、種類を別に持つ。
   * 木材・石材・金は種類が 1 つしかないので `NODE_OF_RESOURCE` のままでよい。
   */
  readonly node: number;
  readonly x: Fx;
  readonly y: Fx;
  readonly amount: Fx;
  readonly rich: boolean;
  readonly ownerStart: number;
}

/**
 * マップを生成して `world.map` と資源エンティティを作る。
 *
 * `world.map` の広さは `createWorld` で決まっているので、
 * 呼び出し側は `mapSizeForPlayers` で求めた値を渡しておくこと（この関数は広さを変えない）。
 */
export function generateMap(w: World, opts: MapGenOptions): MapGenResult {
  const map = w.map;
  const params0 = mapParams(opts.mapType);

  allocateTerrain(map);
  invalidatePathfinder(map);

  const ctx: GenCtx = {
    map,
    w: map.widthTiles,
    h: map.heightTiles,
    cx: idiv(map.widthTiles * FX_ONE, 2),
    cy: idiv(map.heightTiles * FX_ONE, 2),
    reserved: new Uint8Array(map.widthTiles * map.heightTiles),
    noWater: new Uint8Array(map.widthTiles * map.heightTiles),
    noise: new Uint8Array(map.widthTiles * map.heightTiles),
    histogram: new Int32Array(256),
    reach: new Uint8Array(map.widthTiles * map.heightTiles),
    queue: new Int32Array(map.widthTiles * map.heightTiles),
    starts: [],
    plan: [],
    bridges: [],
  };

  // シードは rngMap から 1 語だけ取り出し、作り直しのたびに +1 して撒き直す（§6.10-5）。
  const baseSeed = w.rngMap.nextU32();
  const maxAttempts = P.maxAttempts;

  let attempts = 0;
  let usedFallback = false;
  let params = params0;
  let ok = false;
  let reachMask: MoveMask = Move.Land;

  for (;;) {
    attempts += 1;
    w.rngMap.seed((baseSeed + attempts - 1) >>> 0);
    resetForAttempt(ctx);
    buildOnce(w, ctx, params);
    reachMask = params.requiresNavy ? Move.Amphibious : Move.Land;
    ok = validate(ctx, reachMask, params);
    if (ok) break;
    if (attempts >= maxAttempts) {
      // 20 回失敗 → 平野型で最後に 1 回だけ作り、結果を無条件で受け入れる（§6.10-5）。
      usedFallback = true;
      params = mapParams('plain');
      attempts += 1;
      w.rngMap.seed((baseSeed + attempts - 1) >>> 0);
      resetForAttempt(ctx);
      buildOnce(w, ctx, params);
      reachMask = Move.Land;
      break;
    }
  }

  // 検査を通ってからエンティティを作る（失敗した候補の後片付けを不要にするため）。
  const nodes = spawnNodes(w, ctx);

  const lawZones: LawZone[] = [];
  if (params.islandLawZone) {
    lawZones.push({
      shape: 'circle',
      x: ctx.cx,
      y: ctx.cy,
      radius: fxFromInt(Math.round(Math.min(ctx.w, ctx.h) * params.islandRadiusRatio)),
      lawOne: true,
    });
  }

  // 生成結果のうち「試合中ずっと参照されるもの」は World にも書き戻す。
  // 戦域の後退先（starts）と掟一の判定領域（lawZones）は M8 / M11 が
  // 毎 tick 参照するので、MapGenResult を持ち回らせない。
  map.mapType = MAP_TYPE_IDS.indexOf(params.id);
  for (let p = 0; p < ctx.starts.length; p++) {
    const st = ctx.starts[p]!;
    map.starts[p * 2] = st.x;
    map.starts[p * 2 + 1] = st.y;
  }
  map.lawZones = new Int32Array(lawZones.length * 4);
  for (let i = 0; i < lawZones.length; i++) {
    const z = lawZones[i]!;
    map.lawZones[i * 4] = z.x;
    map.lawZones[i * 4 + 1] = z.y;
    map.lawZones[i * 4 + 2] = z.radius;
    // 掟番号。現状は掟一（碑の島では戦わない）のみ。
    map.lawZones[i * 4 + 3] = z.lawOne ? 1 : 0;
  }

  return {
    mapType: params.id,
    widthTiles: ctx.w,
    heightTiles: ctx.h,
    starts: ctx.starts.slice(),
    nodes,
    lawZones,
    bridges: ctx.bridges.slice(),
    attempts,
    usedFallback,
    reachMask,
  };
}

function resetForAttempt(ctx: GenCtx): void {
  allocateTerrain(ctx.map);
  invalidatePathfinder(ctx.map);
  ctx.reserved.fill(0);
  ctx.noWater.fill(0);
  ctx.starts.length = 0;
  ctx.plan.length = 0;
  ctx.bridges.length = 0;
}

/** 1 回分の生成（`07§13` の 1〜4）。 */
function buildOnce(w: World, ctx: GenCtx, params: MapParams): void {
  placeStarts(ctx, w.playerCount);
  planStartResources(ctx, w.playerCount);
  planContestResources(ctx, params);
  reserveAreas(ctx, params);
  drawTerrain(w, ctx, params);
}

// ---------------------------------------------------------------- 1. 開始位置

function placeStarts(ctx: GenCtx, playerCount: number): void {
  const dirs = RING_DIRS[playerCount];
  if (dirs === undefined) throw new Error(`mapgen: playerCount ${playerCount} は 1..8`);
  const minSide = ctx.w < ctx.h ? ctx.w : ctx.h;
  const ringFx = fxFromInt(Math.round(minSide * P.startRingRatio));
  for (let p = 0; p < playerCount; p++) {
    const c = dirs[p * 2]!;
    const s = dirs[p * 2 + 1]!;
    const x = ctx.cx + idiv(ringFx * c, DIR_SCALE);
    const y = ctx.cy + idiv(ringFx * s, DIR_SCALE);
    ctx.starts.push({
      playerId: p,
      x,
      y,
      tx: clampInt(idiv(x, FX_ONE), 0, ctx.w - 1),
      ty: clampInt(idiv(y, FX_ONE), 0, ctx.h - 1),
    });
  }
}

// ---------------------------------------------------------------- 2. 初期資源

function planStartResources(ctx: GenCtx, playerCount: number): void {
  const dirs = RING_DIRS[playerCount]!;
  for (let p = 0; p < playerCount; p++) {
    const st = ctx.starts[p]!;
    const c = dirs[p * 2]!;
    const s = dirs[p * 2 + 1]!;
    for (let k = 0; k < START_TEMPLATE.length; k++) {
      const t = START_TEMPLATE[k]!;
      const oxFx = fxFromInt(t.ox);
      const oyFx = fxFromInt(t.oy);
      // 回転（Q16）: (ox, oy) を拠点の方位ぶん回す。距離は保たれる。
      const rx = idiv(oxFx * c - oyFx * s, DIR_SCALE);
      const ry = idiv(oxFx * s + oyFx * c, DIR_SCALE);
      const x = clampInt(st.x + rx, 0, fxFromInt(ctx.w) - 1);
      const y = clampInt(st.y + ry, 0, fxFromInt(ctx.h) - 1);
      const node = t.node ?? NODE_OF_RESOURCE[t.resource]!;
      ctx.plan.push({
        resource: t.resource,
        node,
        x,
        y,
        // 埋蔵量は**ノードの種類**から引く（果樹 125 / 羊 100 / 狩猟 140 …）
        amount: depositOfNode(node),
        rich: false,
        ownerStart: p,
      });
    }
  }
}

// ---------------------------------------------------------------- 3. 争点

function planContestResources(ctx: GenCtx, _params: MapParams): void {
  const minSide = ctx.w < ctx.h ? ctx.w : ctx.h;
  const ring = fxFromInt(Math.round(minSide * P.contestRingRatio));
  const goldCount = P.contestGoldCount;
  const dirs = RING_DIRS[goldCount <= MAX_PLAYERS && goldCount >= 1 ? goldCount : 4]!;
  const richGold = DEPOSIT[RES_GOLD]! * P.richMul;
  for (let i = 0; i < goldCount; i++) {
    const c = dirs[i * 2]!;
    const s = dirs[i * 2 + 1]!;
    ctx.plan.push({
      resource: RES_GOLD,
      node: NODE_OF_RESOURCE[RES_GOLD]!,
      x: ctx.cx + idiv(ring * c, DIR_SCALE),
      y: ctx.cy + idiv(ring * s, DIR_SCALE),
      amount: richGold,
      rich: true,
      ownerStart: -1,
    });
  }
  // 豊かな森（中央）。金鉱の間に 4 クラスタ置く。
  const side = P.contestForestSide;
  const richWood = DEPOSIT[RES_WOOD]! * P.richMul;
  const half = idiv(fxFromInt(side), 2);
  const diag = idiv(ring * 46341, DIR_SCALE); // ring / sqrt(2)
  const corners: readonly Fx[][] = [
    [ctx.cx + diag, ctx.cy + diag],
    [ctx.cx - diag, ctx.cy + diag],
    [ctx.cx + diag, ctx.cy - diag],
    [ctx.cx - diag, ctx.cy - diag],
  ];
  for (let k = 0; k < corners.length; k++) {
    const base = corners[k]!;
    for (let y = 0; y < side; y++) {
      for (let x = 0; x < side; x++) {
        ctx.plan.push({
          resource: RES_WOOD,
          node: NODE_OF_RESOURCE[RES_WOOD]!,
          x: base[0]! + fxFromInt(x) - half,
          y: base[1]! + fxFromInt(y) - half,
          amount: richWood,
          rich: true,
          ownerStart: -1,
        });
      }
    }
  }
}

// ---------------------------------------------------------------- 保護マスク

function reserveAreas(ctx: GenCtx, params: MapParams): void {
  // 拠点まわり: 平地にして保護する（町の中心 4×4 を置ける状態にする）
  const r = P.startClearTiles;
  // 列島型は拠点の島そのものを水から守る（水没して詰むのを防ぐ）
  const dry = params.requiresNavy ? P.islandClearTiles : r * 2;
  for (let i = 0; i < ctx.starts.length; i++) {
    const st = ctx.starts[i]!;
    fillDisc(ctx, st.tx, st.ty, r, Tile.Grass, true);
    markDisc(ctx, st.tx, st.ty, dry);
  }
  // 争点（中央）も水没させない
  markDisc(ctx, idiv(ctx.w, 2), idiv(ctx.h, 2), Math.round(ctx.w * P.contestRingRatio) + 4);
  // 資源ノードのマス
  for (let i = 0; i < ctx.plan.length; i++) {
    const n = ctx.plan[i]!;
    const tx = idiv(n.x, FX_ONE);
    const ty = idiv(n.y, FX_ONE);
    if (!inBounds(ctx.map, tx, ty)) continue;
    ctx.reserved[tileIndex(ctx.map, tx, ty)] = 1;
    // 木材ノードの下は森タイルにする（見た目と射程補正のため）
    setTile(ctx.map, tx, ty, n.resource === RES_WOOD ? Tile.Forest : Tile.Grass);
  }
}

/** 円内の `noWater` マスクを立てる（タイルは変えない）。 */
function markDisc(ctx: GenCtx, tx: number, ty: number, radius: number): void {
  const rr = radius * radius;
  for (let y = ty - radius; y <= ty + radius; y++) {
    for (let x = tx - radius; x <= tx + radius; x++) {
      if (!inBounds(ctx.map, x, y)) continue;
      const dx = x - tx;
      const dy = y - ty;
      if (dx * dx + dy * dy > rr) continue;
      ctx.noWater[tileIndex(ctx.map, x, y)] = 1;
    }
  }
}

/** 水域を描いてよいマスか（保護マスク 2 枚をここ 1 箇所で見る）。 */
function canFlood(ctx: GenCtx, index: number): boolean {
  return ctx.reserved[index] !== 1 && ctx.noWater[index] !== 1;
}

/** 円内を `tile` で塗る。`reserve` が true なら保護マスクも立てる。 */
function fillDisc(
  ctx: GenCtx,
  tx: number,
  ty: number,
  radius: number,
  tile: number,
  reserve: boolean,
): void {
  const rr = radius * radius;
  for (let y = ty - radius; y <= ty + radius; y++) {
    for (let x = tx - radius; x <= tx + radius; x++) {
      if (!inBounds(ctx.map, x, y)) continue;
      const dx = x - tx;
      const dy = y - ty;
      if (dx * dx + dy * dy > rr) continue;
      const i = tileIndex(ctx.map, x, y);
      if (ctx.reserved[i] === 1 && !reserve) continue;
      setTile(ctx.map, x, y, tile);
      if (reserve) ctx.reserved[i] = 1;
    }
  }
}

// ---------------------------------------------------------------- 4. 地形

function drawTerrain(w: World, ctx: GenCtx, params: MapParams): void {
  drawWater(w, ctx, params);
  drawForest(w, ctx, params);
  drawHills(w, ctx, params);
  if (params.hasDefile) drawDefile(w, ctx, params);
  addShallowFringe(w, ctx);
  invalidatePathfinder(ctx.map);
}

function drawWater(w: World, ctx: GenCtx, params: MapParams): void {
  if (params.waterRatio <= 0 && params.riverCount <= 0) return;
  const area = ctx.w * ctx.h;
  const waterTiles = idiv(fx(params.waterRatio) * area, FX_ONE);

  if (params.islandLawZone) {
    // 碑の島: 中央に島を残し、そのまわりを環状の水域にする
    const minSide = ctx.w < ctx.h ? ctx.w : ctx.h;
    const ri = Math.round(minSide * params.islandRadiusRatio);
    // 環の面積 = pi * (ro^2 - ri^2) = waterTiles → ro = isqrt(ri^2 + waterTiles * 7 / 22)
    const ro = isqrt(ri * ri + idiv(waterTiles * 7, 22));
    drawRing(ctx, idiv(ctx.w, 2), idiv(ctx.h, 2), ri, ro, Tile.Water);
    return;
  }

  if (params.requiresNavy) {
    // 列島: ノイズの低い側を水にして水域を過半にする
    buildNoise(w, ctx, P.noiseCellTiles);
    const t = pickThreshold(ctx, waterTiles);
    paintByNoise(ctx, t, Tile.Water);
    return;
  }

  if (params.riverCount > 0) {
    // 河川 / 密林: 水域は川（小川）だけ
    const isStream = params.waterRatio < 0.06;
    const width = isStream ? P.streamWidthTiles : P.riverWidthTiles;
    const tile = isStream ? Tile.Shallow : Tile.Water;
    for (let k = 0; k < params.riverCount; k++) {
      drawRiver(w, ctx, k, params.riverCount, width, tile, isStream ? 0 : params.bridgeCount);
    }
    return;
  }

  if (params.waterRatio >= 0.15) {
    // 内海: 中央に大きな水域
    const r = isqrt(idiv(waterTiles * 7, 22));
    drawLake(w, ctx, idiv(ctx.w, 2), idiv(ctx.h, 2), r);
    return;
  }

  if (params.waterRatio > 0) {
    // 平野などの小さな池
    buildNoise(w, ctx, idiv(P.noiseCellTiles, 2) + 1);
    const t = pickThreshold(ctx, waterTiles);
    paintByNoise(ctx, t, Tile.Water);
  }
}

/** 中央の湖（ノイズで縁をゆがめる）。 */
function drawLake(w: World, ctx: GenCtx, tx: number, ty: number, radius: number): void {
  buildNoise(w, ctx, P.noiseCellTiles);
  for (let y = ty - radius - 4; y <= ty + radius + 4; y++) {
    for (let x = tx - radius - 4; x <= tx + radius + 4; x++) {
      if (!inBounds(ctx.map, x, y)) continue;
      const i = tileIndex(ctx.map, x, y);
      if (!canFlood(ctx, i)) continue;
      const n = ctx.noise[i]!;
      // 縁を ±radius/8 だけゆがめる（整数演算のみ）
      const rr = radius + idiv((n - 128) * radius, 1024);
      const dx = x - tx;
      const dy = y - ty;
      if (dx * dx + dy * dy <= rr * rr) setTile(ctx.map, x, y, Tile.Water);
    }
  }
}

/** 環状の水域（碑の島）。 */
function drawRing(
  ctx: GenCtx,
  tx: number,
  ty: number,
  rIn: number,
  rOut: number,
  tile: number,
): void {
  const inSq = rIn * rIn;
  const outSq = rOut * rOut;
  for (let y = ty - rOut; y <= ty + rOut; y++) {
    for (let x = tx - rOut; x <= tx + rOut; x++) {
      if (!inBounds(ctx.map, x, y)) continue;
      const i = tileIndex(ctx.map, x, y);
      if (!canFlood(ctx, i)) continue;
      const dx = x - tx;
      const dy = y - ty;
      const d2 = dx * dx + dy * dy;
      if (d2 > inSq && d2 <= outSq) setTile(ctx.map, x, y, tile);
    }
  }
}

/**
 * 川を 1 本描く。上下いずれかの辺から反対の辺へ、乱歩で蛇行させる。
 * `bridgeCount > 0` なら等間隔に橋（路面 = `Tile.Road`）を架ける。
 */
function drawRiver(
  w: World,
  ctx: GenCtx,
  index: number,
  count: number,
  width: number,
  tile: number,
  bridgeCount: number,
): void {
  // 縦向きの川を count 本、横方向に等間隔で流す（人数が増えても本数は maps.json 由来）
  const vertical = (index & 1) === 0 || count === 1;
  const along = vertical ? ctx.h : ctx.w;
  const across = vertical ? ctx.w : ctx.h;
  const half = idiv(width, 2);
  let pos = idiv(across * (index + 1), count + 1);
  const bridgeRows: number[] = [];
  for (let b = 0; b < bridgeCount; b++) bridgeRows.push(idiv(along * (b + 1), bridgeCount + 1));

  for (let a = 0; a < along; a++) {
    // 乱歩（-1, 0, +1）。rngMap のみ使用。
    pos += w.rngMap.nextInt(3) - 1;
    if (pos < half + 1) pos = half + 1;
    if (pos > across - half - 2) pos = across - half - 2;
    let isBridge = false;
    for (let b = 0; b < bridgeRows.length; b++) {
      const br = bridgeRows[b]!;
      if (a >= br && a < br + P.bridgeWidthTiles) {
        isBridge = true;
        // 橋 1 本につき 1 件だけ記録する（先頭の行のとき）
        if (a === br) {
          ctx.bridges.push({
            tx: vertical ? pos - half : a,
            ty: vertical ? a : pos - half,
            widthTiles: vertical ? width : P.bridgeWidthTiles,
            heightTiles: vertical ? P.bridgeWidthTiles : width,
          });
        }
      }
    }
    for (let k = -half; k <= half; k++) {
      const x = vertical ? pos + k : a;
      const y = vertical ? a : pos + k;
      if (!inBounds(ctx.map, x, y)) continue;
      if (!canFlood(ctx, tileIndex(ctx.map, x, y))) continue;
      setTile(ctx.map, x, y, isBridge ? Tile.Road : tile);
    }
  }
}

function drawForest(w: World, ctx: GenCtx, params: MapParams): void {
  if (params.forestRatio <= 0) return;
  const target = idiv(fx(params.forestRatio) * ctx.w * ctx.h, FX_ONE);
  buildNoise(w, ctx, P.noiseCellTiles);
  const t = pickThreshold(ctx, target);
  const width = ctx.w;
  for (let i = 0; i < ctx.noise.length; i++) {
    if (ctx.reserved[i] === 1) continue;
    if (ctx.noise[i]! >= t) continue;
    // 水域・丘・崖を森で塗り潰さない（平地だけを森にする）
    if (ctx.map.tiles[i] !== Tile.Grass) continue;
    const x = i % width;
    const y = (i - x) / width;
    setTile(ctx.map, x, y, Tile.Forest);
  }
}

function drawHills(w: World, ctx: GenCtx, params: MapParams): void {
  if (params.hillRatio <= 0) return;
  const target = idiv(fx(params.hillRatio) * ctx.w * ctx.h, FX_ONE);
  buildNoise(w, ctx, P.noiseCellTiles + 4);
  const t = pickThreshold(ctx, target);
  const width = ctx.w;
  for (let i = 0; i < ctx.noise.length; i++) {
    if (ctx.reserved[i] === 1) continue;
    if (ctx.noise[i]! >= t) continue;
    if (ctx.map.tiles[i] !== Tile.Grass) continue;
    const x = i % width;
    const y = (i - x) / width;
    setTile(ctx.map, x, y, Tile.Hill);
  }
}

/**
 * 隘路。拠点の広がりが横長なら縦の壁、縦長なら横の壁を 1 本引き、
 * `minDefileCount` 本の通り道を等間隔で空ける（1 本だけにすると通行検査で落ちる）。
 */
function drawDefile(_w: World, ctx: GenCtx, params: MapParams): void {
  let minX = ctx.w;
  let maxX = 0;
  let minY = ctx.h;
  let maxY = 0;
  for (let i = 0; i < ctx.starts.length; i++) {
    const st = ctx.starts[i]!;
    if (st.tx < minX) minX = st.tx;
    if (st.tx > maxX) maxX = st.tx;
    if (st.ty < minY) minY = st.ty;
    if (st.ty > maxY) maxY = st.ty;
  }
  const vertical = maxX - minX >= maxY - minY;
  const along = vertical ? ctx.h : ctx.w;
  const wallPos = vertical ? idiv(ctx.w, 2) : idiv(ctx.h, 2);
  const gaps = params.minDefileCount < 2 ? 2 : params.minDefileCount;
  const half = idiv(P.defileGapTiles, 2);
  for (let a = 0; a < along; a++) {
    let inGap = false;
    for (let g = 0; g < gaps; g++) {
      const center = idiv(along * (g + 1), gaps + 1);
      if (a >= center - half && a <= center + half) inGap = true;
    }
    if (inGap) continue;
    for (let k = 0; k < P.defileWallThickness; k++) {
      const x = vertical ? wallPos + k : a;
      const y = vertical ? a : wallPos + k;
      if (!inBounds(ctx.map, x, y)) continue;
      if (ctx.reserved[tileIndex(ctx.map, x, y)] === 1) continue;
      setTile(ctx.map, x, y, Tile.Cliff);
    }
  }
}

/** 水際を浅瀬にする（渡し場）。深い水域の内側は残るので大きな湖は船が必要なまま。 */
function addShallowFringe(w: World, ctx: GenCtx): void {
  const width = ctx.w;
  const height = ctx.h;
  const changes: number[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (ctx.map.tiles[i] !== Tile.Water) continue;
      if (ctx.reserved[i] === 1) continue;
      let coastal = false;
      for (let k = 0; k < 4; k++) {
        const nx = x + (k === 0 ? -1 : k === 1 ? 1 : 0);
        const ny = y + (k === 2 ? -1 : k === 3 ? 1 : 0);
        if (!inBounds(ctx.map, nx, ny)) continue;
        const t = ctx.map.tiles[ny * width + nx]!;
        if (t !== Tile.Water && t !== Tile.Shallow) {
          coastal = true;
          break;
        }
      }
      if (coastal) changes.push(i);
    }
  }
  // 一括で反映する（走査中に書き換えると「浅瀬の隣も浅瀬」で連鎖してしまう）
  for (let k = 0; k < changes.length; k++) {
    if (w.rngMap.nextFx() >= P.shallowFringeChance) continue;
    const i = changes[k]!;
    const x = i % width;
    const y = (i - x) / width;
    setTile(ctx.map, x, y, Tile.Shallow);
  }
}

// ---------------------------------------------------------------- ノイズ

/**
 * 整数値ノイズ（格子 + 双一次補間）。`out` は 0..255。
 * 乱数は `rngMap` のみ。補間は `idiv`（0 方向切り捨て）だけで行う。
 */
function buildNoise(w: World, ctx: GenCtx, cellTiles: number): void {
  const cell = cellTiles < 2 ? 2 : cellTiles;
  const lw = idiv(ctx.w, cell) + 2;
  const lh = idiv(ctx.h, cell) + 2;
  const lattice = new Uint8Array(lw * lh);
  for (let i = 0; i < lattice.length; i++) lattice[i] = w.rngMap.nextInt(256);
  for (let y = 0; y < ctx.h; y++) {
    const gy = idiv(y, cell);
    const wy = idiv((y - gy * cell) * 256, cell);
    const row0 = gy * lw;
    const row1 = row0 + lw;
    for (let x = 0; x < ctx.w; x++) {
      const gx = idiv(x, cell);
      const wx = idiv((x - gx * cell) * 256, cell);
      const a = lattice[row0 + gx]!;
      const b = lattice[row0 + gx + 1]!;
      const c = lattice[row1 + gx]!;
      const d = lattice[row1 + gx + 1]!;
      const top = a + idiv((b - a) * wx, 256);
      const bottom = c + idiv((d - c) * wx, 256);
      ctx.noise[y * ctx.w + x] = top + idiv((bottom - top) * wy, 256);
    }
  }
}

/**
 * ノイズ値の下側から数えて `targetTiles` マスになる閾値を返す（0..256）。
 * ヒストグラムを使うので浮動小数も並べ替えも要らない。
 */
function pickThreshold(ctx: GenCtx, targetTiles: number): number {
  ctx.histogram.fill(0);
  for (let i = 0; i < ctx.noise.length; i++) {
    const v = ctx.noise[i]!;
    ctx.histogram[v] = ctx.histogram[v]! + 1;
  }
  let acc = 0;
  for (let v = 0; v < 256; v++) {
    acc += ctx.histogram[v]!;
    if (acc >= targetTiles) return v + 1;
  }
  return 256;
}

/** ノイズが閾値未満のマスを水域（`tile`）にする。保護マスクは飛ばす。 */
function paintByNoise(ctx: GenCtx, threshold: number, tile: number): void {
  const width = ctx.w;
  for (let i = 0; i < ctx.noise.length; i++) {
    if (!canFlood(ctx, i)) continue;
    if (ctx.noise[i]! >= threshold) continue;
    const x = i % width;
    const y = (i - x) / width;
    setTile(ctx.map, x, y, tile);
  }
}

// ---------------------------------------------------------------- 5. 通行検査

/**
 * 通行検査（T-M3-05）。
 *  a) 全拠点が同じ連結成分にあるか（列島型は水陸両用で判定）
 *  b) 最も離れた 2 拠点の間の「通り道」が 1 本だけになっていないか
 *     （粗経路上のセクタを 1 つずつ塞いで、まだ繋がっているかを見る）
 */
function validate(ctx: GenCtx, mask: MoveMask, params: MapParams): boolean {
  const map = ctx.map;
  if (!hasTerrain(map)) return false;
  for (let i = 0; i < ctx.starts.length; i++) {
    const st = ctx.starts[i]!;
    if (!isPassableIndex(map, tileIndex(map, st.tx, st.ty), Move.Land)) return false;
  }
  if (ctx.starts.length < 2) return true;

  const first = ctx.starts[0]!;
  const reached = computeReachable(map, tileIndex(map, first.tx, first.ty), mask, ctx.reach, ctx.queue);
  if (reached === 0) return false;
  for (let i = 1; i < ctx.starts.length; i++) {
    const st = ctx.starts[i]!;
    if (ctx.reach[tileIndex(map, st.tx, st.ty)] !== 1) return false;
  }

  // b) 隘路が 1 本だけでないか
  return !hasSingleChokepoint(ctx, mask, params);
}

/**
 * 「通り道が 1 本しかない」かどうか。
 * 最も離れた 2 拠点の粗経路（セクタ列）から端点以外のセクタを 1 つずつ取り除き、
 * それだけで連結が切れるなら、そこが唯一の隘路だと判定する。
 *
 * 拠点の対の選び方は「距離降順 → (i, j) 昇順」で全順序に固定している（§16-2）。
 */
function hasSingleChokepoint(ctx: GenCtx, mask: MoveMask, params: MapParams): boolean {
  const pf = getPathfinder(ctx.map);
  let bestI = 0;
  let bestJ = 1;
  let bestD = -1;
  for (let i = 0; i < ctx.starts.length; i++) {
    for (let j = i + 1; j < ctx.starts.length; j++) {
      const a = ctx.starts[i]!;
      const b = ctx.starts[j]!;
      const dx = b.tx - a.tx;
      const dy = b.ty - a.ty;
      const d = dx * dx + dy * dy;
      if (d > bestD) {
        bestD = d;
        bestI = i;
        bestJ = j;
      }
    }
  }
  const a = ctx.starts[bestI]!;
  const b = ctx.starts[bestJ]!;
  const from = sectorOfXY(pf, a.tx, a.ty);
  const to = sectorOfXY(pf, b.tx, b.ty);
  if (!findSectorPath(pf, mask, from, to, -1)) return true; // 粗経路すら無い = 論外
  const path = Array.from(pf.sectorPath.subarray(0, pf.sectorPathLen));
  // 平野型（フォールバック）は障害物がほぼ無いので検査を省く
  if (params.id === 'plain' && !params.hasDefile) return false;
  for (let k = 1; k < path.length - 1; k++) {
    const banned = path[k]!;
    if (banned === from || banned === to) continue;
    if (!sectorsConnected(pf, mask, from, to, banned)) return true;
  }
  return false;
}

// ---------------------------------------------------------------- エンティティ生成

/** 計画した資源ノードを実体化する（`EntityKind.Resource`、`amount` に埋蔵量）。 */
function spawnNodes(w: World, ctx: GenCtx): ResourceNodeInfo[] {
  const out: ResourceNodeInfo[] = [];
  for (let i = 0; i < ctx.plan.length; i++) {
    const n = ctx.plan[i]!;
    const id = spawnEntity(w.entities, {
      kind: EntityKind.Resource,
      owner: NEUTRAL_OWNER,
      // `kind === Resource` の typeId は **資源ノードの種類**（`RESOURCE_NODE_DEFS` の添字）。
      // units.json / buildings.json の typeId とも `RESOURCE_IDS` の添字とも別空間で、
      // 採集システム（`core/gather.ts`）がこの添字で解釈する。
      typeId: n.node,
      x: n.x,
      y: n.y,
      // 資源ノードは攻撃対象ではないので HP は 1 固定（枯渇は amount で管理する）
      hpMax: FX_ONE,
    });
    w.entities.amount[entityIndex(id)] = n.amount;
    out.push({
      id,
      resource: n.resource,
      x: n.x,
      y: n.y,
      amount: n.amount,
      rich: n.rich,
      ownerStart: n.ownerStart,
    });
  }
  return out;
}

// ---------------------------------------------------------------- 補助

function clampInt(v: number, lo: number, hi: number): number {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}
