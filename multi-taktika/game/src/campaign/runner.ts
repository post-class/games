/**
 * campaign/runner.ts — ミッションの進行（T-M16-01 の実行側）
 *
 * 責務は 3 つだけ:
 *   1. ミッション定義から **World を組み立てる**（`createMatch` + 定義に書かれた追加配置）
 *   2. スクリプトイベントを **tick 番号か World の状態**で発火し、`Command` を出す
 *   3. 勝利条件 / 敗北条件を判定する
 *
 * ---- 守っている制約 ----
 *  - **ミッション固有の分岐を書かない。** switch はすべて「条件の型」「イベントの型」
 *    に対するもので、ミッション ID で分岐する箇所は 1 つも無い。
 *  - **`Date.now()` / `Math.random()` を使わない。** 発火は tick と World の状態だけで決まるので、
 *    同じ入力列からは常に同じ結果になる（リプレイで再現できる）。
 *  - World を直接書き換えるのは**初期配置とスクリプトの増援配置**だけ
 *    （`createMatch` と同じ扱い。乱数を消費しない）。それ以外は `Command` を出す。
 *  - 数値リテラルを書かない。tick 数・体数はミッション JSON、構造値は `_config.json`。
 *  - 反復は index 昇順（`Map` / `Set` の反復順に依存しない）。
 *
 * ---- 判定の意味 ----
 *  - `victory` は **全部同時に満たしたら勝ち**（AND）
 *  - `defeat` は **どれか 1 つ満たしたら負け**（OR）
 *  - `holdFrontsWithOrder` は「連続 `ticks` 保つ」条件なので、達成した時点で**成立が固定**される
 *    （途切れたら数え直し。既に達成した分は消えない）
 *  - `gatherResource` は**累計**。増えた分だけを足していくので、使っても減らない
 *  - `世界の決着`（`world.gameOver`）は、勝者が自分の味方なら勝利、そうでなければ敗北として扱う。
 *    **負けても「ゲームオーバー」にはしない**（次のミッションへ分岐する。`02` の服属）
 */

import { EntityKind, RESOURCE_IDS } from '@/shared/types';
import type { EntityId, PlayerId } from '@/shared/types';
import type { Command } from '@/sim';
import {
  FX_ONE,
  MAX_FRONTS,
  createMatch,
  fx,
  idOfIndex,
  resolveIndex,
  spawnEntity,
  stepWorld,
  type MatchSetup,
  type World,
} from '@/sim';
import { buildingIndex, unitDefById } from '@/sim/core/defs';
import {
  applyUnitStat,
  getPlayerModifiers,
  isBuildingComplete,
  markModifiersDirty,
} from '@/sim/core/effects';
import { UnitState } from '@/sim/core/entity';
import { FX_HALF, idiv } from '@/sim/core/fx';
import { Move, hasTerrain, isPassableFor } from '@/sim/core/terrain';
import { spawnBuilding } from '@/sim/systems/construction';
import { countTownCenters } from '@/sim/systems/loyalty';

import { PERCENT_MAX, SPAWN_SEARCH_TILES } from './mission';
import type {
  Mission,
  MissionCondition,
  MissionEvent,
  MissionTrigger,
  Placement,
  UnitGroup,
} from './mission';

/** ミッションの決着。**`defeat` でもゲームオーバーではない**（分岐して次へ進む）。 */
export type MissionOutcome = 'running' | 'victory' | 'defeat';

/** 画面に出す 1 行のヒント（`06§13` の練習メニューの文がそのまま入る）。 */
export interface MissionHint {
  /** 出た tick（0 = ミッション開始時のヒント）。 */
  readonly tick: number;
  readonly text: string;
}

/** 目標 1 件の進捗（HUD の目標表示用）。 */
export interface ObjectiveProgress {
  readonly condition: MissionCondition;
  /** 満たしているか。 */
  readonly met: boolean;
  /** 継続が必要な条件の残り tick（継続条件でなければ 0）。 */
  readonly remainingTicks: number;
}

/** 1 tick 進めた結果。 */
export interface MissionStepResult {
  readonly outcome: MissionOutcome;
  /** この tick に出たヒント。 */
  readonly hints: readonly MissionHint[];
}

/** 進行中のミッション。 */
export interface MissionRun {
  readonly mission: Mission;
  readonly world: World;
  readonly setup: MatchSetup;
  /** 人間が操作するプレイヤー。 */
  readonly self: PlayerId;
  /** 現在の決着。 */
  outcome(): MissionOutcome;
  /** これまでに出た全ヒント（発生順）。 */
  hints(): readonly MissionHint[];
  /** 勝利条件の進捗（表示用）。 */
  objectives(): readonly ObjectiveProgress[];
  /**
   * 1 tick 進める。`playerCmds` は**その tick に確定したプレイヤーの入力**。
   * スクリプトが出すコマンドはその後ろに並ぶ（順序が結果を決めるので固定する）。
   */
  step(playerCmds?: readonly Command[]): MissionStepResult;
}

// ---------------------------------------------------------------------------
// 内部状態
// ---------------------------------------------------------------------------

interface ConditionTracker {
  /** 連続で成立している tick 数。 */
  streak: number;
  /** 必要な連続 tick 数を満たしたか（満たしたら消えない）。 */
  done: boolean;
}

interface RunState {
  outcome: MissionOutcome;
  readonly hints: MissionHint[];
  /** 発火済みイベント（添字 = mission.events の添字）。 */
  readonly fired: Uint8Array;
  /** 累計採集量（Fx。添字 = playerId * RESOURCE_COUNT + resource）。 */
  readonly gathered: Int32Array;
  /** 前 tick の資源量（Fx）。増えた分を `gathered` に足す。 */
  readonly lastResources: Int32Array;
  readonly victoryTrackers: ConditionTracker[];
  readonly defeatTrackers: ConditionTracker[];
}

// ---------------------------------------------------------------------------
// 組み立て
// ---------------------------------------------------------------------------

/**
 * ミッションを開始できる状態にする。
 *
 * `createMatch` が「すぐ遊べる World」を作るので、ここが足すのは
 * **定義に書かれた分だけ**（開始資源の上書き・追加ユニット・追加建物）。
 */
export function createMissionRun(mission: Mission): MissionRun {
  const s = mission.setup;
  const setup = createMatch({
    seed: s.seed,
    playerCount: s.playerCount,
    mapType: s.map,
    startAge: s.startAge,
    startResources: s.startResources,
    assignVillagers: s.assignVillagers,
    ...(s.civs.length === s.playerCount ? { civs: s.civs } : {}),
    ...(s.teams.length === s.playerCount ? { teams: s.teams } : {}),
  });
  const world = setup.world;

  // 1) 開始資源の上書き（服属ルートの「蔵が空」を定義だけで表せるようにする）。
  for (let i = 0; i < s.resourceOverrides.length; i++) {
    const ov = s.resourceOverrides[i]!;
    const pl = world.players[ov.player];
    if (pl === undefined) continue;
    for (let k = 0; k < ov.resources.length; k++) {
      const r = ov.resources[k]!;
      pl.resources[RESOURCE_IDS.indexOf(r.resource)] = fx(r.amount);
    }
  }

  // 2) 追加建物 → 3) 追加ユニット の順（建物の足元にユニットを置かないため）。
  for (let i = 0; i < s.buildings.length; i++) {
    const b = s.buildings[i]!;
    const t = resolveTile(world, b.at);
    spawnBuilding(world, b.player, b.building, tileCenterFx(t.x), tileCenterFx(t.y));
  }
  for (let i = 0; i < s.units.length; i++) {
    const u = s.units[i]!;
    spawnUnitGroup(world, u.player, [{ unit: u.unit, count: u.count }], u.at);
  }

  const state: RunState = {
    outcome: 'running',
    hints: mission.hints.map((text) => ({ tick: world.tick, text })),
    fired: new Uint8Array(mission.events.length),
    gathered: new Int32Array(s.playerCount * RESOURCE_IDS.length),
    lastResources: new Int32Array(s.playerCount * RESOURCE_IDS.length),
    victoryTrackers: mission.victory.map(() => ({ streak: 0, done: false })),
    defeatTrackers: mission.defeat.map(() => ({ streak: 0, done: false })),
  };
  snapshotResources(world, state);

  return {
    mission,
    world,
    setup,
    self: s.player,
    outcome: () => state.outcome,
    hints: () => state.hints,
    objectives: () => describeObjectives(world, mission, state),
    step: (playerCmds) => stepMission(world, mission, state, playerCmds ?? []),
  };
}

// ---------------------------------------------------------------------------
// 1 tick
// ---------------------------------------------------------------------------

function stepMission(
  w: World,
  m: Mission,
  st: RunState,
  playerCmds: readonly Command[],
): MissionStepResult {
  if (st.outcome !== 'running') return { outcome: st.outcome, hints: [] };

  const before = st.hints.length;
  // 1) スクリプト（tick 番号 / World の状態だけで発火する）。
  const scripted = fireEvents(w, m, st);
  // 2) プレイヤー入力 → スクリプトの順で 1 tick 進める。
  stepWorld(w, playerCmds.length === 0 ? scripted : [...playerCmds, ...scripted]);
  // 3) 累計採集量を更新してから条件を判定する。
  accumulateGathered(w, st);
  updateOutcome(w, m, st);

  return { outcome: st.outcome, hints: st.hints.slice(before) };
}

/** 発火条件が成立したイベントを実行し、出すべき `Command` を返す。 */
function fireEvents(w: World, m: Mission, st: RunState): Command[] {
  const cmds: Command[] = [];
  for (let i = 0; i < m.events.length; i++) {
    const ev = m.events[i]!;
    if (ev.once && st.fired[i] === 1) continue;
    if (!triggerHolds(w, m, st, ev.trigger)) continue;
    st.fired[i] = 1;
    runAction(w, st, ev, cmds);
  }
  return cmds;
}

function triggerHolds(w: World, m: Mission, st: RunState, t: MissionTrigger): boolean {
  switch (t.type) {
    case 'atTick':
      return w.tick >= t.tick;
    case 'frontOpened':
      return activeFrontCount(w, m.setup.player) >= t.count;
    case 'condition':
      return conditionHolds(w, st, t.condition);
    default:
      return false;
  }
}

function runAction(w: World, st: RunState, ev: MissionEvent, cmds: Command[]): void {
  const a = ev.action;
  switch (a.type) {
    case 'showHint':
      st.hints.push({ tick: w.tick, text: a.text });
      return;

    case 'spawnUnits':
      spawnUnitGroup(w, a.player, a.units, a.at);
      return;

    case 'spawnEnemyWave': {
      const ids = spawnUnitGroup(w, a.player, a.units, a.at);
      if (a.attackAt === null || ids.length === 0) return;
      const t = resolveTile(w, a.attackAt);
      // **World を直接動かさず `moveUnits` を出す。** 交戦が続けば
      // `frontLifecycle` が戦域を立ててくれる（`07§3`）。
      cmds.push({
        t: 'moveUnits',
        p: a.player,
        units: ids,
        x: tileCenterFx(t.x),
        y: tileCenterFx(t.y),
        queued: false,
      });
      return;
    }

    case 'grantResources': {
      const pl = w.players[a.player];
      if (pl === undefined) return;
      for (let i = 0; i < a.resources.length; i++) {
        const r = a.resources[i]!;
        const idx = RESOURCE_IDS.indexOf(r.resource);
        pl.resources[idx] = pl.resources[idx]! + fx(r.amount);
      }
      // 貰った分は「集めた」に数えない（`gatherResource` は採集量なので）。
      snapshotResources(w, st);
      return;
    }

    case 'setOrder':
      // 令は必ず `Command` で渡す（遅延・切り替え間隔をすべて sim に判定させる）。
      cmds.push({ t: 'setOrder', p: a.player, front: a.front, order: a.order, tier: a.tier });
      return;

    default:
      return;
  }
}

// ---------------------------------------------------------------------------
// 勝敗
// ---------------------------------------------------------------------------

function updateOutcome(w: World, m: Mission, st: RunState): void {
  const victory = advanceTrackers(w, st, m.victory, st.victoryTrackers);
  const defeat = advanceTrackers(w, st, m.defeat, st.defeatTrackers);

  // 勝利は AND（全部）、敗北は OR（どれか 1 つ）。勝利を先に見る
  // （最後の敵を倒した tick に時間切れが重なった場合は勝ちにする）。
  if (m.victory.length > 0 && victory.every((v) => v)) {
    st.outcome = 'victory';
    return;
  }
  if (defeat.some((v) => v)) {
    st.outcome = 'defeat';
    return;
  }

  // 試合そのものが決着した場合（制圧・碑の写し・服属）。
  if (w.gameOver) {
    const self = m.setup.player;
    const winner = w.winner;
    const won = winner >= 0 && w.teams[winner] === w.teams[self];
    st.outcome = won ? 'victory' : 'defeat';
  }
}

function advanceTrackers(
  w: World,
  st: RunState,
  conds: readonly MissionCondition[],
  trackers: readonly ConditionTracker[],
): boolean[] {
  const out: boolean[] = [];
  for (let i = 0; i < conds.length; i++) {
    const c = conds[i]!;
    const tr = trackers[i]!;
    const need = requiredTicks(c);
    if (tr.done) {
      out.push(true);
      continue;
    }
    if (conditionHolds(w, st, c)) {
      tr.streak += 1;
      if (tr.streak >= need) tr.done = true;
    } else {
      tr.streak = 0;
    }
    // 継続が要らない条件は「今この tick に成立しているか」をそのまま返す
    // （成立を固定しない。例: 敵を全滅させた状態は、増援が来れば崩れる）。
    out.push(need > 1 ? tr.done : tr.streak > 0);
  }
  return out;
}

/** その条件が「連続で成立していなければならない」tick 数（既定 1 = 瞬間判定）。 */
function requiredTicks(c: MissionCondition): number {
  return c.type === 'holdFrontsWithOrder' && c.ticks > 1 ? c.ticks : 1;
}

/** 条件が**今この tick** に成立しているか。 */
function conditionHolds(w: World, st: RunState, c: MissionCondition): boolean {
  switch (c.type) {
    case 'destroyAllTownCenters':
      return countTownCenters(w)[c.target]! === 0;

    case 'surviveTicks':
      return w.tick >= c.ticks;

    case 'gatherResource': {
      const idx = c.player * RESOURCE_IDS.length + RESOURCE_IDS.indexOf(c.resource);
      return st.gathered[idx]! >= fx(c.amount);
    }

    case 'holdFrontsWithOrder':
      return frontsWithOrder(w, c.player, c.order) >= c.count;

    case 'unitCountAtLeast':
      return countUnits(w, c.player, c.unit) >= c.count;

    case 'unitCountAtMost':
      return countUnits(w, c.player, c.unit) <= c.count;

    case 'buildingCountAtLeast':
      return countBuildings(w, c.player, c.building) >= c.count;

    case 'buildingCountAtMost':
      return countBuildings(w, c.player, c.building) <= c.count;

    case 'loyaltyAtMostPercent': {
      const pl = w.players[c.player];
      if (pl === undefined) return false;
      return pl.loyalty * PERCENT_MAX <= c.percent * FX_ONE;
    }

    default:
      return false;
  }
}

function describeObjectives(w: World, m: Mission, st: RunState): ObjectiveProgress[] {
  const out: ObjectiveProgress[] = [];
  for (let i = 0; i < m.victory.length; i++) {
    const c = m.victory[i]!;
    const tr = st.victoryTrackers[i]!;
    const need = requiredTicks(c);
    const met = tr.done || (need <= 1 && conditionHolds(w, st, c));
    out.push({
      condition: c,
      met,
      remainingTicks: met ? 0 : need > 1 ? need - tr.streak : 0,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// World の数え上げ（index 昇順）
// ---------------------------------------------------------------------------

function countUnits(w: World, p: PlayerId, unitId: string | null): number {
  const e = w.entities;
  const typeId = unitId === null ? -1 : unitDefById(unitId).index;
  let n = 0;
  for (let i = 0; i < e.highWater; i++) {
    if (e.alive[i] !== 1) continue;
    if (e.kind[i] !== EntityKind.Unit) continue;
    if (e.owner[i] !== p) continue;
    if (typeId >= 0 && e.typeId[i] !== typeId) continue;
    n += 1;
  }
  return n;
}

/** 完成済みの建物だけを数える（建設中の枠を「建った」と数えない）。 */
function countBuildings(w: World, p: PlayerId, buildingId: string): number {
  const e = w.entities;
  const typeId = buildingIndex(buildingId);
  let n = 0;
  for (let i = 0; i < e.highWater; i++) {
    if (e.alive[i] !== 1) continue;
    if (e.kind[i] !== EntityKind.Building && e.kind[i] !== EntityKind.Attachment) continue;
    if (e.owner[i] !== p) continue;
    if (e.typeId[i] !== typeId) continue;
    if (!isBuildingComplete(w, i)) continue;
    n += 1;
  }
  return n;
}

function frontsWithOrder(w: World, p: PlayerId, order: string): number {
  let n = 0;
  for (let s = 0; s < MAX_FRONTS; s++) {
    const f = w.fronts[p * MAX_FRONTS + s]!;
    if (!f.active) continue;
    if (f.order === order || f.orderLower === order) n += 1;
  }
  return n;
}

function activeFrontCount(w: World, p: PlayerId): number {
  let n = 0;
  for (let s = 0; s < MAX_FRONTS; s++) {
    if (w.fronts[p * MAX_FRONTS + s]!.active) n += 1;
  }
  return n;
}

// ---------------------------------------------------------------------------
// 累計採集量
// ---------------------------------------------------------------------------

function snapshotResources(w: World, st: RunState): void {
  for (let p = 0; p < w.playerCount; p++) {
    const pl = w.players[p]!;
    for (let r = 0; r < RESOURCE_IDS.length; r++) {
      st.lastResources[p * RESOURCE_IDS.length + r] = pl.resources[r]!;
    }
  }
}

/** 増えた分だけを足す（使っても減らない = 「集めた量」になる）。 */
function accumulateGathered(w: World, st: RunState): void {
  for (let p = 0; p < w.playerCount; p++) {
    const pl = w.players[p]!;
    for (let r = 0; r < RESOURCE_IDS.length; r++) {
      const k = p * RESOURCE_IDS.length + r;
      const now = pl.resources[r]!;
      const diff = now - st.lastResources[k]!;
      if (diff > 0) st.gathered[k] = st.gathered[k]! + diff;
      st.lastResources[k] = now;
    }
  }
}

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

/** マス番号 → マス中心の Fx 座標。 */
function tileCenterFx(t: number): number {
  return t * FX_ONE + FX_HALF;
}

/** 定義の置き場所を実際のマスに解決する（マップ外はマップ内に収める）。 */
function resolveTile(w: World, at: Placement): { x: number; y: number } {
  let tx: number;
  let ty: number;
  if (at.kind === 'absolute') {
    tx = at.tileX;
    ty = at.tileY;
  } else {
    tx = idiv(w.map.starts[at.player * 2]!, FX_ONE) + at.dx;
    ty = idiv(w.map.starts[at.player * 2 + 1]!, FX_ONE) + at.dy;
  }
  return { x: clampTile(tx, w.map.widthTiles), y: clampTile(ty, w.map.heightTiles) };
}

function clampTile(v: number, size: number): number {
  if (v < 0) return 0;
  return v >= size ? size - 1 : v;
}

/**
 * 兵を置く。
 *
 * 置き場所は「目標マスから外へ広がる四角のらせん」を index 昇順に走って
 * **最初に通れるマス**を使う（乱数を使わないので同じ定義からは常に同じ配置になる）。
 * 反復順が結果を決めるため、探索の順序は固定してある。
 */
function spawnUnitGroup(
  w: World,
  p: PlayerId,
  groups: readonly UnitGroup[],
  at: Placement,
): EntityId[] {
  const origin = resolveTile(w, at);
  const out: EntityId[] = [];
  let placed = 0;
  for (let g = 0; g < groups.length; g++) {
    const grp = groups[g]!;
    const def = unitDefById(grp.unit);
    const hpMax = applyUnitStat(getPlayerModifiers(w, p), def, 'hp', def.hp);
    for (let k = 0; k < grp.count; k++) {
      const tile = findFreeTile(w, origin.x, origin.y, placed);
      placed += 1;
      if (tile === null) continue;
      const x = tileCenterFx(tile.x);
      const y = tileCenterFx(tile.y);
      const id = spawnEntity(w.entities, {
        kind: EntityKind.Unit,
        owner: p,
        typeId: def.index,
        x,
        y,
        hpMax,
      });
      const idx = resolveIndex(w.entities, id);
      if (idx < 0) continue;
      w.entities.destX[idx] = x;
      w.entities.destY[idx] = y;
      w.entities.state[idx] = UnitState.Idle;
      w.entities.stateTick[idx] = w.tick;
      out.push(idOfIndex(w.entities, idx));
    }
  }
  markModifiersDirty(w, p);
  return out;
}

/**
 * `skip` 個ぶん飛ばした「通れるマス」を返す（らせん順）。
 * 見つからなければ null（マップの隅を指定した場合など）。
 */
function findFreeTile(
  w: World,
  cx: number,
  cy: number,
  skip: number,
): { x: number; y: number } | null {
  let seen = 0;
  for (let ring = 0; ring <= SPAWN_SEARCH_TILES; ring++) {
    for (let dy = -ring; dy <= ring; dy++) {
      for (let dx = -ring; dx <= ring; dx++) {
        // その ring の外周だけを見る（内側は前の ring で見ている）。
        const onEdge = dx === -ring || dx === ring || dy === -ring || dy === ring;
        if (!onEdge) continue;
        const tx = cx + dx;
        const ty = cy + dy;
        if (tx < 0 || ty < 0 || tx >= w.map.widthTiles || ty >= w.map.heightTiles) continue;
        if (hasTerrain(w.map) && !isPassableFor(w.map, tx, ty, Move.Land)) continue;
        if (seen === skip) return { x: tx, y: ty };
        seen += 1;
      }
    }
  }
  return null;
}
