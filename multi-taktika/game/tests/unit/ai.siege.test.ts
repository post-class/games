/**
 * tests/unit/ai.siege.test.ts — 攻城の判断（拠点を落としに行く）
 *
 * ■ なぜこのテストが必要になったか（実測。30 分・AI 段階 4 同士 × 112 試合が**全部時間切れ**）
 * ```
 *  5分 兵 0/0  建物 8/10  町中心HP 2400/2400 敵拠点まで  -/-  マス 戦域 0
 * 15分 兵 5/7  建物 17/18 町中心HP 2400/2400 敵拠点まで 67/50 マス 戦域 0
 * 25分 兵 20/4 建物 21/17 町中心HP 2400/2400 敵拠点まで 14/137マス 戦域 1
 * 30分 兵 24/5 建物 19/14 町中心HP 2400/2400 敵拠点まで 18/107マス 戦域 1
 * ```
 * **町の中心の HP が 30 分間 1 も減らない。** AI は `attackTarget` を一度も出しておらず、
 * `SeenEntity` に `EntityId` が無いので建物を名指しできなかった。
 * 勝利条件は `03§10`「相手の町の中心をすべて破壊」なので、これでは永久に決着しない。
 *
 * ここで固定するのは 4 点:
 *  1. 見えている建物を `attackTarget` で名指しできる（`SeenEntity.id`）
 *  2. 狙う順序が**決定論的な全順序**（町の中心 → 生産元 → その他。同種は距離 → y → x → id）
 *  3. **敵兵が付近にいるときは攻城しない**（交戦は戦域に任せる。既存の挙動を壊さない）
 *  4. **戦域に入っている兵は引き抜かない**
 */

import { describe, expect, it } from 'vitest';
import type { CommandOf } from '@/sim/command';
import type { Command } from '@/sim/command';
import type { EntityId, PlayerId } from '@/shared/types';
import { EntityKind } from '@/shared/types';
import { PROGRESS_DONE, idOfIndex, spawnEntity } from '@/sim/core/entity';
import { fxFromInt } from '@/sim/core/fx';
import { buildingDefById, unitDefById } from '@/sim/core/defs';
import { createWorld } from '@/sim/core/world';
import type { World } from '@/sim/core/world';
import { AiPlayer, aiLevelConfig, createAiView, siegeTargets, pushSiege } from '@/ai/index';
import type { AiContext, AiMemory } from '@/ai/index';

const MAP = 120;
/** 攻城の判断を試す段階（将軍）。 */
const LEVEL = 4;

function makeWorld(): World {
  return createWorld({
    seed: 7,
    playerCount: 2,
    mapWidthTiles: MAP,
    mapHeightTiles: MAP,
    entityCapacity: 256,
    civs: ['yamato', 'viking'],
  });
}

function putUnit(w: World, id: string, owner: number, tx: number, ty: number): number {
  const def = unitDefById(id);
  return spawnEntity(w.entities, {
    kind: EntityKind.Unit,
    owner,
    typeId: def.index,
    x: fxFromInt(tx),
    y: fxFromInt(ty),
    hpMax: def.hp,
  });
}

function putBuilding(w: World, id: string, owner: number, tx: number, ty: number): number {
  const def = buildingDefById(id);
  const i = spawnEntity(w.entities, {
    kind: EntityKind.Building,
    owner,
    typeId: def.index,
    x: fxFromInt(tx),
    y: fxFromInt(ty),
    hpMax: def.hp,
  });
  w.entities.buildProgress[i] = PROGRESS_DONE;
  return i;
}

/**
 * `AiContext` を手で組む（`AiPlayer.think` を通さずに `pushSiege` だけを試すため）。
 * `idOf` は `w.entities` から作る（`AiPlayer.buildOwnIdTable` と同じこと）。
 */
function makeCtx(w: World, p: PlayerId, memory: AiMemory): AiContext {
  const view = createAiView(w, p);
  return {
    playerId: p,
    view,
    cfg: aiLevelConfig(LEVEL),
    rng: w.rngAi,
    memory,
    idOf: (index: number) => idOfIndex(w.entities, index),
  };
}

/** `AiPlayer` の記憶と同じ形の空の記憶（`createMemory` は非公開なのでここで作る）。 */
function emptyMemory(): AiMemory {
  return {
    villagerKnownId: [],
    villagerRole: [],
    villagerBusyUntil: [],
    // 村人にどの資源を採らせているかの記録（需要にもとづく割り当てで追加）。
    villagerResource: [],
    villagerMoveTick: [],
    produceTick: [],
    armyProduceTick: [],
    wantBuildCost: [],
    enemyBuildingIds: [],
    gatherAssignSeq: [],
    nodeIds: [],
    nodeResource: [],
    nodeX: [],
    nodeY: [],
    scoutStep: [],
    assignedByResource: [],
    firstSquadDone: [],
    idleAssignSeq: [],
    dispatched: [],
    released: [],
    dispatchX: [],
    dispatchY: [],
    decoy: [],
    siegeTarget: [],
    decoyTick: -1,
    buildTick: -1,
  };
}

/** 自軍の町の中心と、敵の建物・兵を置いた盤面を作る。 */
function scene(opts: {
  /** 敵の建物（id と座標）。 */
  readonly enemyBuildings: readonly { id: string; tx: number; ty: number }[];
  /** 自軍の兵を置く座標（すべて `yamato` の槍兵）。 */
  readonly ownUnits: readonly { tx: number; ty: number }[];
  /** 敵の兵（守り手）。 */
  readonly enemyUnits?: readonly { tx: number; ty: number }[];
}): { w: World; ownIdx: number[] } {
  const w = makeWorld();
  // 自軍の町の中心（距離の基準。`siegeTargets` の並びに使われる）。
  putBuilding(w, 'town_center', 0, 10, 10);
  for (const b of opts.enemyBuildings) {
    putBuilding(w, b.id, 1, b.tx, b.ty);
    // **視界に入れるために斥候を隣に置く**（`AiView` は視界内の敵しか渡さない。`07§11`）。
    // 斥候は `lineIdx === 0` なので `combatUnits` には数えられず、兵数の判定に影響しない。
    putUnit(w, 'scout', 0, b.tx, b.ty);
  }
  const ownIdx: number[] = [];
  for (const u of opts.ownUnits) ownIdx.push(putUnit(w, 'y-ashigaru', 0, u.tx, u.ty));
  for (const u of opts.enemyUnits ?? []) putUnit(w, 'v-shield', 1, u.tx, u.ty);
  return { w, ownIdx };
}

/**
 * 「一度送って着いた兵」の状態を記憶に仕込む。
 *
 * `pushSiege` が使うのは **`pushDispatch` が令に返した兵だけ**（生産直後の兵を
 * 攻城に取られると派遣と囮が動かなくなるため）。試合中はこの状態が自然に出来るが、
 * 単体テストでは手で作る。
 */
function markArrived(w: World, memory: AiMemory, ownIdx: readonly number[]): void {
  for (const i of ownIdx) {
    const id = idOfIndex(w.entities, i);
    memory.dispatched[i] = id;
    memory.released[i] = id;
  }
}

/** 「送って着いた兵が並んでいる」状態の `AiContext` と記憶を作る。 */
function arrived(
  w: World,
  ownIdx: readonly number[],
  memory: AiMemory = emptyMemory()
): { ctx: AiContext; memory: AiMemory } {
  markArrived(w, memory, ownIdx);
  return { ctx: makeCtx(w, 0 as PlayerId, memory), memory };
}

function attackCmds(cmds: readonly Command[]): CommandOf<'attackTarget'>[] {
  return cmds.filter((c) => c.t === 'attackTarget') as CommandOf<'attackTarget'>[];
}

describe('AiView.SeenEntity.id — 見えているものを名指しできる', () => {
  it('視界内の敵建物の EntityId が入っている（視界外のものは入らない）', () => {
    const w = makeWorld();
    putUnit(w, 'scout', 0, 50, 50);
    const near = putBuilding(w, 'house', 1, 52, 50);
    putBuilding(w, 'house', 1, 110, 110); // 遠すぎて見えない
    const view = createAiView(w, 0 as PlayerId);
    const ids = view.seenEnemies.map((s) => s.id);
    expect(ids).toEqual([idOfIndex(w.entities, near)]);
    // `EntityId` は 0 にならない（`Command` に載せられる値）。
    expect(ids[0]!).toBeGreaterThan(0);
  });
});

describe('攻城の目標の並び（決定論的な全順序）', () => {
  it('町の中心 → 生産元 → その他の順（03§10「町の中心をすべて破壊」）', () => {
    // わざと「町の中心をいちばん遠くに」置く: 距離ではなく段が優先されることを見る。
    const { w } = scene({
      enemyBuildings: [
        { id: 'house', tx: 40, ty: 40 },
        { id: 'barracks', tx: 45, ty: 40 },
        { id: 'town_center', tx: 50, ty: 40 },
      ],
      ownUnits: [{ tx: 44, ty: 40 }, { tx: 45, ty: 41 }, { tx: 46, ty: 40 }],
    });
    const ctx = makeCtx(w, 0 as PlayerId, emptyMemory());
    const ts = siegeTargets(ctx);
    expect(ts.map((t) => t.rank)).toEqual([0, 1, 2]);
  });

  it('同じ段なら 自軍拠点からの距離 → y → x 昇順（同値の決め方まで固定）', () => {
    // 家 3 棟。1 つは近く、2 つは自軍拠点から等距離（対称）。
    const { w } = scene({
      enemyBuildings: [
        { id: 'house', tx: 50, ty: 40 }, // 遠い側・y が小さい
        { id: 'house', tx: 40, ty: 50 }, // 遠い側・y が大きい（距離は同じ）
        { id: 'house', tx: 44, ty: 44 }, // 近い
      ],
      ownUnits: [{ tx: 44, ty: 44 }, { tx: 45, ty: 44 }, { tx: 46, ty: 44 }],
    });
    const ctx = makeCtx(w, 0 as PlayerId, emptyMemory());
    const ts = siegeTargets(ctx);
    expect(ts.map((t) => [t.x / (1 << 8), t.y / (1 << 8)])).toEqual([
      [44, 44],
      [50, 40],
      [40, 50],
    ]);
  });

  it('並びは呼ぶたびに同じ（デシンクしない）', () => {
    const { w } = scene({
      enemyBuildings: [
        { id: 'house', tx: 50, ty: 40 },
        { id: 'house', tx: 40, ty: 50 },
        { id: 'barracks', tx: 45, ty: 45 },
      ],
      ownUnits: [{ tx: 45, ty: 45 }, { tx: 46, ty: 45 }, { tx: 47, ty: 45 }],
    });
    const ctx = makeCtx(w, 0 as PlayerId, emptyMemory());
    expect(siegeTargets(ctx)).toEqual(siegeTargets(ctx));
  });
});

describe('攻城の判断（pushSiege）', () => {
  const cfg = aiLevelConfig(LEVEL);
  const need = cfg.siegeMinSquads * 3; // front.spawnMinUnits = 3

  it('兵が足りていて敵兵がいなければ、町の中心に attackTarget を出す', () => {
    const own: { tx: number; ty: number }[] = [];
    for (let k = 0; k < need; k++) own.push({ tx: 44 + k, ty: 40 });
    const { w, ownIdx } = scene({
      enemyBuildings: [{ id: 'town_center', tx: 45, ty: 40 }],
      ownUnits: own,
    });
    const { ctx } = arrived(w, ownIdx);
    const cmds: Command[] = [];
    pushSiege(ctx, cmds);
    const atk = attackCmds(cmds);
    expect(atk.length).toBe(1);
    expect(atk[0]!.units.length).toBe(need);
    // 目標は視界内の敵の町の中心。
    const target = ctx.view.seenEnemies.find((s) => s.kind === EntityKind.Building)!;
    expect(atk[0]!.target).toBe(target.id);
  });

  it('兵が足りなければ攻城しない（`siegeMinSquads` 未満）', () => {
    const own: { tx: number; ty: number }[] = [];
    for (let k = 0; k < need - 1; k++) own.push({ tx: 44 + k, ty: 40 });
    const { w, ownIdx } = scene({
      enemyBuildings: [{ id: 'town_center', tx: 45, ty: 40 }],
      ownUnits: own,
    });
    const cmds: Command[] = [];
    pushSiege(arrived(w, ownIdx).ctx, cmds);
    expect(attackCmds(cmds).length).toBe(0);
  });

  it('付近に敵の戦闘ユニットがいるときは攻城しない（交戦は戦域に任せる。07§3）', () => {
    const own: { tx: number; ty: number }[] = [];
    for (let k = 0; k < need; k++) own.push({ tx: 44 + k, ty: 40 });
    const { w, ownIdx } = scene({
      enemyBuildings: [{ id: 'town_center', tx: 45, ty: 40 }],
      ownUnits: own,
      enemyUnits: [{ tx: 46, ty: 41 }], // 守り手が 1 体でもいれば攻城しない
    });
    const cmds: Command[] = [];
    pushSiege(arrived(w, ownIdx).ctx, cmds);
    expect(attackCmds(cmds).length).toBe(0);
  });

  it('戦域に入っている兵は引き抜かない（frontId !== 0 は数えない）', () => {
    const own: { tx: number; ty: number }[] = [];
    for (let k = 0; k < need; k++) own.push({ tx: 44 + k, ty: 40 });
    const { w, ownIdx } = scene({
      enemyBuildings: [{ id: 'town_center', tx: 45, ty: 40 }],
      ownUnits: own,
    });
    // 1 体を戦域に編入した状態にすると、残りは `need` 未満になる。
    w.entities.frontId[ownIdx[0]!] = 1;
    const cmds: Command[] = [];
    pushSiege(arrived(w, ownIdx).ctx, cmds);
    expect(attackCmds(cmds).length).toBe(0);
  });

  it('同じ目標に二度命じない（APM を食わない。07§11）', () => {
    const own: { tx: number; ty: number }[] = [];
    for (let k = 0; k < need; k++) own.push({ tx: 44 + k, ty: 40 });
    const { w, ownIdx } = scene({
      enemyBuildings: [{ id: 'town_center', tx: 45, ty: 40 }],
      ownUnits: own,
    });
    const { ctx, memory } = arrived(w, ownIdx);
    const first: Command[] = [];
    pushSiege(ctx, first);
    expect(attackCmds(first).length).toBe(1);
    const second: Command[] = [];
    pushSiege(makeCtx(w, 0 as PlayerId, memory), second);
    expect(attackCmds(second).length).toBe(0);
  });

  it('目標が視界から消えたら releaseManual で令に返す（manual のまま放置しない）', () => {
    const own: { tx: number; ty: number }[] = [];
    for (let k = 0; k < need; k++) own.push({ tx: 44 + k, ty: 40 });
    const { w, ownIdx } = scene({
      enemyBuildings: [{ id: 'town_center', tx: 45, ty: 40 }],
      ownUnits: own,
    });
    const { ctx, memory } = arrived(w, ownIdx);
    pushSiege(ctx, []);
    // 目標の建物を落とす（= 視界から消える）。
    for (let i = 0; i < w.entities.highWater; i++) {
      if (w.entities.owner[i] === 1 && w.entities.kind[i] === EntityKind.Building) {
        w.entities.alive[i] = 0;
      }
    }
    const cmds: Command[] = [];
    pushSiege(makeCtx(w, 0 as PlayerId, memory), cmds);
    const rel = cmds.filter((c) => c.t === 'releaseManual') as CommandOf<'releaseManual'>[];
    expect(rel.length).toBe(1);
    expect(rel[0]!.units.length).toBe(need);
    // 記憶も消えている（次の判断で新しい目標に就ける）。
    for (let i = 0; i < memory.siegeTarget.length; i++) expect(memory.siegeTarget[i]).toBe(0);
  });

  it('段階 1（素人）は拠点を攻めない（07§11「内政のみ」）', () => {
    const own: { tx: number; ty: number }[] = [];
    for (let k = 0; k < need; k++) own.push({ tx: 44 + k, ty: 40 });
    const { w, ownIdx } = scene({
      enemyBuildings: [{ id: 'town_center', tx: 45, ty: 40 }],
      ownUnits: own,
    });
    const ctx: AiContext = { ...arrived(w, ownIdx).ctx, cfg: aiLevelConfig(1) };
    const cmds: Command[] = [];
    pushSiege(ctx, cmds);
    expect(cmds.length).toBe(0);
  });
});

describe('ai.json の攻城の調整値（コードに数値を書かない）', () => {
  it('段階 1 は 0、段階 2 以上は 1 隊より多い兵を要求する', () => {
    expect(aiLevelConfig(1).siegeMinSquads).toBe(0);
    for (const lv of [2, 3, 4, 5]) expect(aiLevelConfig(lv).siegeMinSquads).toBeGreaterThan(1);
  });

  it('集合の半径は戦域が立つ半径（15 マス）より広く、敵兵の判定は狭い', () => {
    for (const lv of [2, 3, 4, 5]) {
      const c = aiLevelConfig(lv);
      expect(c.siegeStageRadiusTiles).toBeGreaterThan(15);
      expect(c.siegeClearRadiusTiles).toBeLessThan(15);
    }
  });
});

describe('AiPlayer が attackTarget を出せるようになっている', () => {
  it('判断 tick に町の中心へ attackTarget を出す（段階 4）', () => {
    const own: { tx: number; ty: number }[] = [];
    for (let k = 0; k < 6; k++) own.push({ tx: 44 + k, ty: 40 });
    const { w } = scene({
      enemyBuildings: [{ id: 'town_center', tx: 45, ty: 40 }],
      ownUnits: own,
    });
    const ai = new AiPlayer(0 as PlayerId, LEVEL);
    // 攻城は「送る → 着く → 攻める」の 3 段を踏むので、判断を何回か回す
    // （`stepWorld` を通さないので兵は動かないが、目標のそばに置いてある）。
    let found: EntityId | null = null;
    for (let t = 0; t < aiLevelConfig(LEVEL).intervalTicks * 6 && found === null; t++) {
      for (const c of ai.think(w)) if (c.t === 'attackTarget') found = c.target;
      w.tick++;
    }
    expect(found).not.toBeNull();
  });
});
