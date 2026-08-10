/**
 * sim/core/world.ts — World 型と createWorld（実装手順書 §4）
 *
 * World は「1 試合の状態のすべて」。ここに入っていないものは復元できない。
 * 逆に、**再現に不要な作業領域は `scratch` に置き、状態ハッシュの対象にしない**。
 *
 * 決定論の約束:
 *  - 反復順が意味を持つ配列（players / fronts / entities）は index 昇順で回す。
 *  - `Map` / `Set` を状態に持たない（反復順が挿入順依存になるため。§0.3）。
 *    「研究済みセット」は techId の添字を引く `Uint8Array` で表す。
 *  - 小数が必要な量はすべて Fx（実数 × 256）。
 */

import type { CivId, EntityId, OrderId, PlayerId, Tier } from '@/shared/types';
import { CIV_IDS, RESOURCE_COUNT } from '@/shared/types';
import type { Entities } from './entity';
import { createEntities, entityIndex, isAlive } from './entity';
import type { Fx } from './fx';
import { FX_ONE } from './fx';
import type { Grid } from './grid';
import { createGrid } from './grid';
import { Rng } from './rng';

/** 最大プレイヤー数（8 人対戦）。 */
export const MAX_PLAYERS = 8;

/** 戦域スロットの上限（`config.json` の `front.maxSlots` / `slotBonus.hardMax` と一致）。 */
export const MAX_FRONTS = 6;

/** 優勢度リングバッファの長さ = 250 tick = 10 秒（`07§3`）。 */
export const ADVANTAGE_WINDOW_TICKS = 250;

/**
 * 研究済みフラグの容量。`techs.json` は 34 件だが、
 * 固有研究の追加で増えても配列長を変えずに済むよう余裕を持たせている。
 */
export const TECH_CAPACITY = 64;

/** 既定のエンティティ容量。人口上限 200 × 8 人 + 建物 + 資源 + 投射物の目安。 */
export const DEFAULT_ENTITY_CAPACITY = 16384;

/** rng ストリームを 1 つのシードから分離するための派生定数（用途ごとに固定）。 */
const RNG_SALT_COMBAT = 0x00c0ffee;
const RNG_SALT_AI = 0x00a1a1a1;
const RNG_SALT_MAP = 0x00facade;

/** 毎 tick 呼ばれるシステムの型。cmds を受けるのは applyCommands だけ。 */
export type System = (w: World) => void;

/** 戦域（`07§3`, 実装手順書 §6.1）。 */
export interface Front {
  /** 表示番号・色・キー割当と一致する 1..MAX_FRONTS。配列添字 + 1。 */
  readonly slot: number;
  /** 使用中かどうか。false のスロットは解放済み。 */
  active: boolean;
  /**
   * 戦域の持ち主。**配列上の位置で決まるので変更不可**
   * （`fronts[owner * MAX_FRONTS + (slot - 1)]`）。
   *
   * 戦域は「そのプレイヤーが令を配れる単位」なので、プレイヤーごとに 6 枠ある。
   * 同じ戦闘に両軍が関わっていても、赤の戦域 1 と青の戦域 3 は別物として進行する。
   */
  readonly owner: PlayerId;
  /** 中心（所属ユニットの重心。毎 tick 更新）。 */
  x: Fx;
  y: Fx;
  /** 半径（Fx）。15 → 最大 30 マス。 */
  radius: Fx;
  /** 上段の令。 */
  order: OrderId | null;
  /** 下段の令（二重旗のみ）。 */
  orderLower: OrderId | null;
  /** 配達中の令。null = なし。 */
  /**
   * 配達中の令。`single` は「**この 1 枚だけを置く**」（二重旗が無い戦域）。
   * `05§10`「各戦域に 1 枚。帝国の世の研究『二重旗』で 2 枚まで重ねられます」。
   */
  pendingOrder: { id: OrderId; tier: Tier; single: boolean; deliverAtTick: number } | null;
  /** 切り替え間隔（6 秒 / 早馬 4.2 秒）の判定用。 */
  lastSwitchTick: number;
  /** 消滅判定（15 秒）用。最後に実ダメージが発生した tick。 */
  lastEngageTick: number;
  /** 優勢度（-FX_ONE..FX_ONE）。 */
  advantage: Fx;
  /** 直近 10 秒の与ダメージ（リングバッファ、Fx）。 */
  readonly dmgDealt: Int32Array;
  /** 直近 10 秒の被ダメージ（リングバッファ、Fx）。 */
  readonly dmgTaken: Int32Array;
  /** リングバッファの書き込み位置（tick % ADVANTAGE_WINDOW_TICKS）。 */
  ringPos: number;
  /** 戦域に入った時点の自軍 HP 合計（兵力比の分母。Fx）。 */
  hpBaseOwn: Fx;
  /** 戦域に入った時点の敵軍 HP 合計（Fx）。 */
  hpBaseEnemy: Fx;
  /** 忠誠度による離反（令を無視して既定行動のみ。`07§10`）。 */
  defected: boolean;
  /** 所属ユニット数（frontEnrollment が毎 tick 数える）。 */
  memberCount: number;

  // ---- 発生候補（孵化）の状態 ----
  // `07§3`「交戦が 2 秒続いたら戦域化」を判定するための、**戦域になる前**の状態。
  // `active === false` のスロットが候補の置き場を兼ねる（候補もスロットを 1 つ押さえる。
  // スロットが無ければ戦域にならないという規則と一致する）。
  //
  // 専用フィールドにしている理由: 以前は `ringPos` / `advantage` / `hpBase*` を
  // 流用していたが、(1) 同じ列が 2 つの意味を持って読めなくなる、
  // (2) `hashWorld` が `active === false` のスロットを飛ばすため
  //     **孵化中の食い違いがデシンク検出に載らない**、という 2 つの問題があった。
  /** 近接条件が連続して成立している tick 数（0 = 孵化していない）。 */
  candidateTicks: number;
  /** 孵化中に実ダメージを 1 度でも観測したか（`07§3` の「交戦」）。 */
  candidateDamageSeen: boolean;
  /** 前 tick の自軍側 HP 合計（Fx）。減っていれば被弾があったと判定する。 */
  candidateHpOwn: Fx;
  /** 前 tick の敵側 HP 合計（Fx）。 */
  candidateHpEnemy: Fx;
}

/** プレイヤー状態。 */
export interface PlayerState {
  readonly id: PlayerId;
  civ: CivId;
  /** 資源 4 種。単位は Fx（採集が tick ごとに端数で入るため）。順序は RESOURCE_IDS。 */
  readonly resources: Int32Array;
  /** 忠誠度（Fx、0..FX_ONE。開始 100%）。`07§10` */
  loyalty: Fx;
  /** 時代（AGE_IDS の添字 0..3）。 */
  age: number;
  /** 現在人口。 */
  pop: number;
  /** 人口上限（家 +5 / 町の中心 +10 / 既定 200）。 */
  popCap: number;
  /** 研究済みフラグ。添字は techs.json のロード順（`Set` を使わない理由は §0.3）。 */
  readonly researched: Uint8Array;
  /** 使用可能な戦域スロット数（時代 + 城 + 研究「旗竿」）。上限 MAX_FRONTS。 */
  frontSlots: number;
  /** 投了した。 */
  resigned: boolean;
  /** 敗北した（町の中心全喪失 or 忠誠度 0）。 */
  defeated: boolean;
}

/** 地形マップ。地形グリッドの中身は M3（T-M3-01）で埋める。 */
export interface MapState {
  /** 幅（マス）。1v1 で 200、8 人で 400（`07§13`）。 */
  readonly widthTiles: number;
  /** 高さ（マス）。 */
  readonly heightTiles: number;
  /**
   * タイル種別。M3 まで**長さ 0 の空配列**。
   * M3 で `new Uint8Array(widthTiles * heightTiles)` に差し替える。
   */
  tiles: Uint8Array;
  /** 通行可否ビット。M3 で確保する。 */
  passable: Uint8Array;
  /** 高低（段差。`combat.highGround` の判定に使う）。M3 で確保する。 */
  elevation: Uint8Array;
  /**
   * マップ型（`MAP_TYPE_IDS` の添字）。生成後に mapgen が設定する。
   * 型ごとに戦域の立ち方が変わるので、AI（M13）とリプレイの復元が参照する。
   */
  mapType: number;
  /**
   * 各プレイヤーの開始位置（Fx）。`starts[p * 2]` = x, `starts[p * 2 + 1]` = y。
   * 「最寄りの拠点へ下がる」（後退の令・退却）の既定目標にも使う。
   */
  starts: Int32Array;
  /**
   * 掟の適用領域（碑の島など）。`07§10` の掟一「碑の島では戦わない」の判定に使う。
   * 1 領域 = 中心 x, y, 半径（すべて Fx）と掟番号の 4 要素。空なら該当領域なし。
   */
  lawZones: Int32Array;
}

/**
 * 市場の相場（`07§8`）。**全プレイヤー共通**なので World 直下に置く。
 * 「相手が石材を買い漁っていれば城か壁を建てていると読める」という
 * 情報漏れが設計上の意図なので、プレイヤーごとに分けてはいけない。
 */
export interface MarketState {
  /**
   * 資源ごとの価格倍率（Fx。開始 1.0）。
   * 100 単位買うごとに +3%、30 秒ごとに 1% ずつ戻る。
   * 添字は RESOURCE_IDS の順。
   */
  readonly priceMul: Int32Array;
  /** 相場を戻す処理を最後に行った tick（30 秒ごとの判定用）。 */
  lastDecayTick: number;
}

/**
 * 破壊跡地（`07§9`）。**これは派生物ではなく実際の状態**なので World に持つ。
 *
 * `config.construction.rubbleSec` の間は同じ場所に建て直せず、建物の `onDestroyEffects` に
 * `forbidRebuild*` / `gatherRateAura` があればさらに長く（`durationSec` -1 で永久に）効く。
 * 壁・門の跡地（穴）は試合中ずっと残り、建て直しの時間が伸びる。
 *
 * 判定は `core/effects.ts` の `isRebuildBlocked` / `isWallHole` /
 * `pruneDestroyedSites` が行う。登録は `registerDestroyedSite`。
 */
export interface DestroyedSite {
  /** 壊れた建物の typeId（`buildings.json` の添字）。 */
  readonly typeId: number;
  /** マス単位の座標（建物の基準点）。 */
  readonly tileX: number;
  readonly tileY: number;
  /** 破壊された tick。期限は「この tick + 効果の durationSec」で判定する。 */
  readonly tick: number;
  /** 壁・門だったか（穴は試合中ずっと通り道になる。`07§9`）。 */
  readonly wasWall: boolean;
  /** 所有者（跡地のオーラは元の所有者に効く）。 */
  readonly owner: PlayerId;
}

/**
 * 再現に不要な作業領域。**状態ハッシュの対象にしない。**
 * 毎 tick 使い回して GC 圧を避ける。
 */
export interface Scratch {
  /** 近傍検索の結果受け（`queryCircle`）。 */
  readonly neighbors: number[];
  /** 近傍検索の 2 段目（入れ子の問い合わせ用）。 */
  readonly neighbors2: number[];
  /** index の一時リスト（整列して全順序を作るときに使う）。 */
  readonly indices: number[];
}

/** 1 試合の状態のすべて。 */
export interface World {
  /** 経過 tick。1 tick = 40ms（25 tick/秒）。試合長 45,000 tick。 */
  tick: number;
  /** 生成に使ったシード（リプレイに書き出す）。 */
  readonly seed: number;
  /** プレイヤー。index = playerId。長さ = playerCount。 */
  readonly players: PlayerState[];
  readonly playerCount: number;
  readonly entities: Entities;
  /**
   * 戦域スロット。長さ `MAX_PLAYERS * MAX_FRONTS` 固定で、
   * **index = owner * MAX_FRONTS + (slot - 1)**（`frontIndex` を使う）。
   * `active` が使用中を表す。反復は index 昇順 = プレイヤー昇順 → スロット昇順。
   */
  readonly fronts: Front[];
  readonly grid: Grid;
  /** 戦闘用乱数。 */
  readonly rngCombat: Rng;
  /** AI 用乱数。 */
  readonly rngAi: Rng;
  /** マップ生成用乱数（生成後は触らない）。 */
  readonly rngMap: Rng;
  readonly map: MapState;
  /** 市場の相場（全プレイヤー共通）。 */
  readonly market: MarketState;
  /**
   * チーム番号（添字 = playerId）。同じ番号が味方。
   * 1 対 1 なら全員別番号。貢納・門の通行・視界共有の判定に使う。
   */
  readonly teams: Uint8Array;
  /**
   * 破壊跡地の一覧。**状態ハッシュの対象**（`sim/hash.ts`）。
   *
   * 決定論のため、並び順を次の全順序に固定する（`Map` / `Set` を使わない理由は §0.3）:
   *   `tick` 昇順 → 同 tick 内は `tileY` 昇順 → `tileX` 昇順 → `typeId` 昇順 → `owner` 昇順。
   * `registerDestroyedSite` が挿入位置を決めてこの順序を保つので、
   * **同一 tick に何棟がどの順で壊れても配列の中身が一致する**（§16-2）。
   * 期限切れの要素は `pruneDestroyedSites` が前詰めで捨てる（相対順序は保たれる）。
   */
  readonly destroyedSites: DestroyedSite[];
  /** 決着したか。 */
  gameOver: boolean;
  /** 勝者 playerId。未決着 / 引き分けは -1。 */
  winner: PlayerId;
  readonly scratch: Scratch;
}

/** createWorld の引数。 */
export interface WorldOptions {
  seed: number;
  /** 1..MAX_PLAYERS。 */
  playerCount: number;
  /** マップ幅（マス）。 */
  mapWidthTiles: number;
  /** マップ高さ（マス）。 */
  mapHeightTiles: number;
  /** 省略時 DEFAULT_ENTITY_CAPACITY。 */
  entityCapacity?: number;
  /**
   * プレイヤーごとの文明。省略時は CIV_IDS の先頭から順に割り当てる。
   * 長さは playerCount と一致させること。
   */
  civs?: readonly CivId[];
  /**
   * チーム番号（添字 = playerId）。省略時は全員別チーム（総当たり）。
   * 長さは playerCount と一致させること。
   */
  teams?: readonly number[];
}

function createFront(owner: PlayerId, slotIndex: number): Front {
  return {
    slot: slotIndex + 1,
    active: false,
    owner,
    x: 0,
    y: 0,
    radius: 0,
    order: null,
    orderLower: null,
    pendingOrder: null,
    lastSwitchTick: 0,
    lastEngageTick: 0,
    advantage: 0,
    dmgDealt: new Int32Array(ADVANTAGE_WINDOW_TICKS),
    dmgTaken: new Int32Array(ADVANTAGE_WINDOW_TICKS),
    ringPos: 0,
    hpBaseOwn: 0,
    hpBaseEnemy: 0,
    defected: false,
    memberCount: 0,
    candidateTicks: 0,
    candidateDamageSeen: false,
    candidateHpOwn: 0,
    candidateHpEnemy: 0,
  };
}

function createPlayer(id: PlayerId, civ: CivId): PlayerState {
  return {
    id,
    civ,
    resources: new Int32Array(RESOURCE_COUNT),
    // 忠誠度の開始値は 100%。実数値は config.json（loyalty.start）から
    // M11 で上書きする。ここでは「満タン」という構造的既定値のみ置く。
    loyalty: FX_ONE,
    age: 0,
    pop: 0,
    popCap: 0,
    researched: new Uint8Array(TECH_CAPACITY),
    frontSlots: 1,
    resigned: false,
    defeated: false,
  };
}

/** 既定の文明割り当て（CIV_IDS の先頭から順）。 */
const DEFAULT_CIVS: readonly CivId[] = CIV_IDS;

/**
 * World を作る。**この関数は乱数を消費しない**（マップ生成は M3 の mapgen が rngMap で行う）。
 * 同じ WorldOptions からは常に同じ World ができる。
 */
export function createWorld(opts: WorldOptions): World {
  const { seed, playerCount, mapWidthTiles, mapHeightTiles } = opts;
  if (!Number.isInteger(playerCount) || playerCount < 1 || playerCount > MAX_PLAYERS) {
    throw new Error(`createWorld: playerCount must be 1..${MAX_PLAYERS} (got ${playerCount})`);
  }
  if (!Number.isInteger(seed)) {
    throw new Error(`createWorld: seed must be an integer (got ${seed})`);
  }
  if (mapWidthTiles < 1 || mapHeightTiles < 1) {
    throw new Error('createWorld: map size must be positive');
  }
  if (opts.civs !== undefined && opts.civs.length !== playerCount) {
    throw new Error('createWorld: civs.length must equal playerCount');
  }
  if (opts.teams !== undefined && opts.teams.length !== playerCount) {
    throw new Error('createWorld: teams.length must equal playerCount');
  }

  const capacity = opts.entityCapacity ?? DEFAULT_ENTITY_CAPACITY;
  const entities = createEntities(capacity);

  const players: PlayerState[] = [];
  for (let p = 0; p < playerCount; p++) {
    const civ = opts.civs?.[p] ?? DEFAULT_CIVS[p % DEFAULT_CIVS.length]!;
    players.push(createPlayer(p, civ));
  }

  // 戦域は **プレイヤーごとに MAX_FRONTS 枠**。index = owner * MAX_FRONTS + (slot - 1)。
  // playerCount ぶんだけでなく MAX_PLAYERS ぶん確保しておく（添字計算を分岐なしにするため）。
  const fronts: Front[] = [];
  for (let p = 0; p < MAX_PLAYERS; p++) {
    for (let s = 0; s < MAX_FRONTS; s++) fronts.push(createFront(p, s));
  }

  const teams = new Uint8Array(MAX_PLAYERS);
  for (let p = 0; p < playerCount; p++) teams[p] = opts.teams?.[p] ?? p;

  const map: MapState = {
    widthTiles: mapWidthTiles,
    heightTiles: mapHeightTiles,
    // M3（T-M3-01）で確保する。今は空配列。
    tiles: new Uint8Array(0),
    passable: new Uint8Array(0),
    elevation: new Uint8Array(0),
    mapType: 0,
    starts: new Int32Array(MAX_PLAYERS * 2),
    lawZones: new Int32Array(0),
  };

  return {
    tick: 0,
    seed,
    players,
    playerCount,
    entities,
    fronts,
    grid: createGrid(mapWidthTiles, mapHeightTiles, capacity),
    rngCombat: new Rng((seed ^ RNG_SALT_COMBAT) >>> 0),
    rngAi: new Rng((seed ^ RNG_SALT_AI) >>> 0),
    rngMap: new Rng((seed ^ RNG_SALT_MAP) >>> 0),
    map,
    market: {
      // 相場は 1.0 倍から始まる（構造的既定値。変動量は config.json）
      priceMul: new Int32Array(RESOURCE_COUNT).fill(FX_ONE),
      lastDecayTick: 0,
    },
    teams,
    // 跡地は試合開始時は空。`registerDestroyedSite` が tick 昇順で積む。
    destroyedSites: [],
    gameOver: false,
    winner: -1,
    scratch: { neighbors: [], neighbors2: [], indices: [] },
  };
}

/** `fronts` の添字を求める（owner と slot 1..MAX_FRONTS から）。 */
export function frontIndex(owner: PlayerId, slot: number): number {
  return owner * MAX_FRONTS + (slot - 1);
}

/** owner と slot（1..MAX_FRONTS）から Front を引く。範囲外は undefined。 */
export function getFront(w: World, owner: PlayerId, slot: number): Front | undefined {
  if (!Number.isInteger(owner) || owner < 0 || owner >= w.playerCount) return undefined;
  if (!Number.isInteger(slot) || slot < 1 || slot > MAX_FRONTS) return undefined;
  return w.fronts[frontIndex(owner, slot)];
}

/**
 * そのプレイヤーの空きスロットのうち **slot 番号が最小のもの**を返す（1..MAX_FRONTS）。
 * 空きが無ければ -1。
 *
 * 番号の小さい方から埋めるのは、統合のときに「番号の小さい戦域が大きい方を吸収する」
 * （`07§3`）という規則と噛み合わせるため。使える枠数は `PlayerState.frontSlots`。
 */
export function acquireFrontSlot(w: World, owner: PlayerId): number {
  const pl = getPlayer(w, owner);
  if (pl === undefined) return -1;
  const usable = pl.frontSlots < MAX_FRONTS ? pl.frontSlots : MAX_FRONTS;
  for (let slot = 1; slot <= usable; slot++) {
    if (!w.fronts[frontIndex(owner, slot)]!.active) return slot;
  }
  return -1;
}

/** 戦域を解放する（cleanup が呼ぶ）。中身は初期状態に戻すが owner と slot は不変。 */
export function releaseFront(w: World, owner: PlayerId, slot: number): void {
  const f = getFront(w, owner, slot);
  if (f === undefined || !f.active) return;
  f.active = false;
  f.order = null;
  f.orderLower = null;
  f.pendingOrder = null;
  f.advantage = 0;
  f.memberCount = 0;
  f.defected = false;
  f.dmgDealt.fill(0);
  f.dmgTaken.fill(0);
  f.ringPos = 0;
  f.hpBaseOwn = 0;
  f.hpBaseEnemy = 0;
  f.radius = 0;
  f.x = 0;
  f.y = 0;
  f.candidateTicks = 0;
  f.candidateDamageSeen = false;
  f.candidateHpOwn = 0;
  f.candidateHpEnemy = 0;
}

/** playerId から PlayerState を引く。範囲外は undefined。 */
export function getPlayer(w: World, p: PlayerId): PlayerState | undefined {
  if (!Number.isInteger(p) || p < 0 || p >= w.playerCount) return undefined;
  return w.players[p];
}

/** 2 人が味方（同チーム）かどうか。自分自身は味方扱い。 */
export function areAllies(w: World, a: PlayerId, b: PlayerId): boolean {
  if (a === b) return true;
  if (a < 0 || b < 0 || a >= w.playerCount || b >= w.playerCount) return false;
  return w.teams[a] === w.teams[b];
}

/** EntityId のエンティティが生存しており、かつ所有者が p かどうか（コマンド検証用）。 */
export function isOwnedBy(w: World, id: EntityId, p: PlayerId): boolean {
  const e = w.entities;
  if (!isAlive(e, id)) return false;
  return e.owner[entityIndex(id)] === p;
}
