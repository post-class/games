/**
 * tests/golden/scenarios.ts — ゴールデンリプレイの代表試合（T-M15-06。手順書 §14.1）
 *
 * ■ 何のためのものか
 * 手順書 §14.1: 「代表試合の `.mtr` + 期待ハッシュ。**バランス調整以外の変更で壊れたら即バグ**」。
 * 決定論テスト（`tests/determinism/`）は「同じ入力なら同じ結果」を見るが、
 * **結果そのものが変わったこと**は見ない。ゴールデンはそこを押さえる。
 *
 * ■ 代表 3 試合（区間の違う場面を選ぶ。`07§2` の試合の流れ）
 *   1. `econ-2p`   内政だけ（0〜5 分。戦域は立たない）→ 経済・生産・人口の回帰
 *   2. `fronts-2p` 戦域が立って令を配る（`07§3` / `07§4`）→ 戦域・令・戦闘の回帰
 *   3. `eight-8p`  8 人戦（マップが 400×400、プレイヤー 8 人分の系）→ 規模の回帰
 *
 * ■ 入力は「tick だけで決まる」形にしてある
 * 入力が World の状態を見て変わると、ロジックを直したときに
 * **入力列まで変わってしまい、何が壊れたのか分からなくなる**。
 * だから入力列は tick と（tick 0 で 1 回だけ調べた）エンティティ ID だけで決める。
 *
 * ■ 初期配置（`prepare`）を `.mtr` に入れていない理由
 * `Replay` の形式は `07§12` どおり「シード + 入力の記録」で、
 * **兵の初期配置を持つ欄が無い**（持たせると形式が肥大し、記録が映像寄りになる）。
 * 代表試合 2 は戦闘を起こすために兵を置く必要があるので、その配置は
 * ここ（シナリオのコード）に持ち、`.mtr` には入力とハッシュだけを固定する。
 * 配置は数値リテラルの表であって乱数を使わないので、再現性は保たれる。
 */

import type { CivId, MapTypeId, PlayerId } from '@/shared/types';
import { EntityKind } from '@/shared/types';
import type { Command } from '@/sim/command';
import { HASH_CHECK_INTERVAL_TICKS, stepWorld } from '@/sim/index';
import { createMatch } from '@/sim/setup';
import { hashWorld } from '@/sim/hash';
import { spawnEntity } from '@/sim/core/entity';
import { idOfIndex } from '@/sim/core/entity';
import { unitDefById } from '@/sim/core/defs';
import { FX_ONE, fxFromInt } from '@/sim/core/fx';
import type { World } from '@/sim/core/world';
import { ReplayRecorder, type Replay, type ReplaySetup } from '@/replay/format';
import { dataHash } from '@/data/hash';

/** 代表試合 1 本の定義。 */
export interface GoldenScenario {
  /** ファイル名になる（`tests/golden/<id>.mtr.json`）。 */
  readonly id: string;
  /** 何を守るための試合か（落ちたときに読む説明）。 */
  readonly what: string;
  readonly seed: number;
  readonly setup: ReplaySetup;
  /** 回す tick 数。 */
  readonly ticks: number;
  /** tick 0 の前に置くもの（**乱数を使わない固定の表**）。 */
  readonly prepare?: (w: World) => void;
  /** その tick の入力（`ids` は tick 0 で 1 回だけ調べたエンティティ ID）。 */
  readonly input: (tick: number, ids: ScenarioIds) => Command[];
}

/** tick 0 の World から 1 回だけ引く ID の表（入力を tick だけで決めるため）。 */
export interface ScenarioIds {
  /** プレイヤーごとの町の中心（無ければ -1）。 */
  readonly townCenter: readonly number[];
  /** プレイヤーごとの村人 ID（index 昇順）。 */
  readonly villagers: readonly (readonly number[])[];
}

/** tick 0 の World から ID を集める（index 昇順 = 決定論）。 */
export function collectIds(w: World): ScenarioIds {
  const townCenter: number[] = new Array(w.playerCount).fill(-1);
  const villagers: number[][] = Array.from({ length: w.playerCount }, () => []);
  const e = w.entities;
  for (let i = 0; i < e.highWater; i++) {
    if (e.alive[i] !== 1) continue;
    const owner = e.owner[i]!;
    if (owner >= w.playerCount) continue;
    if (e.kind[i] === EntityKind.Building && townCenter[owner] === -1) {
      townCenter[owner] = idOfIndex(e, i);
    } else if (e.kind[i] === EntityKind.Unit) {
      villagers[owner]!.push(idOfIndex(e, i));
    }
  }
  return { townCenter, villagers };
}

// ---------------------------------------------------------------------------
// 代表試合 1: 内政だけ
// ---------------------------------------------------------------------------

const ECON: GoldenScenario = {
  id: 'econ-2p',
  what: '内政だけの区間（採集・生産・人口・建設）。戦域は立たない',
  seed: 11110001,
  setup: { playerCount: 2, civs: ['yamato', 'mongol'], mapType: 'plain' },
  ticks: 1500, // 1 分
  input(tick, ids) {
    const out: Command[] = [];
    // 村人を増やす（両プレイヤー。playerId 昇順で積む = `stepWorld` の規約）
    if (tick === 25 || tick === 400 || tick === 800) {
      for (let p = 0; p < ids.townCenter.length; p++) {
        const b = ids.townCenter[p]!;
        if (b < 0) continue;
        out.push({ t: 'produce', p: p as PlayerId, building: b, unit: 'villager', count: 2 });
      }
    }
    // 家を建てる（人口上限を上げる。搬入距離ペナルティも通る）
    if (tick === 200) {
      for (let p = 0; p < ids.villagers.length; p++) {
        const vs = ids.villagers[p]!;
        if (vs.length === 0) continue;
        out.push({
          t: 'placeBuilding',
          p: p as PlayerId,
          type: 'house',
          x: fxFromInt(GOLDEN_HOUSE_OFFSET[p * 2]!),
          y: fxFromInt(GOLDEN_HOUSE_OFFSET[p * 2 + 1]!),
          villagers: [...vs.slice(0, 2)],
        });
      }
    }
    return out;
  },
};

/**
 * 家を建てる絶対座標（マス）。**レイアウトの表**であってバランス値ではない。
 * 拠点の近くだが資源ノードに重ならない位置を固定で選んでいる。
 */
const GOLDEN_HOUSE_OFFSET: readonly number[] = [60, 60, 140, 140];

// ---------------------------------------------------------------------------
// 代表試合 2: 戦域が立って令を配る
// ---------------------------------------------------------------------------

/** 兵をぶつける位置（マス）。**乱数を使わない固定の表**。 */
const ARMY_SPOTS: readonly (readonly [number, number])[] = [
  [70, 70],
  [70, 110],
  [110, 90],
];

const FRONTS: GoldenScenario = {
  id: 'fronts-2p',
  what: '戦域が立って令を配る区間（戦域の発生・統合・令の遅延・戦闘・士気）',
  seed: 11110002,
  setup: { playerCount: 2, civs: ['yamato', 'mongol'], mapType: 'plain' },
  ticks: 2500, // 100 秒
  prepare(w) {
    // 戦域スロットを開けておく（時代を上げるのは `03§2` のスロット数の表そのまま）
    for (const pl of w.players) {
      pl.age = 3;
      pl.frontSlots = 6;
    }
    for (const [tx, ty] of ARMY_SPOTS) {
      for (let k = 0; k < 4; k++) {
        for (const [owner, id] of [
          [0, 'y-nagae'],
          [1, 'g-heavy'],
        ] as const) {
          const def = unitDefById(id);
          spawnEntity(w.entities, {
            kind: EntityKind.Unit,
            owner,
            typeId: def.index,
            x: fxFromInt(tx + (owner === 0 ? -1 : 1)) + (FX_ONE >> 1),
            y: fxFromInt(ty + k) + (FX_ONE >> 1),
            hpMax: def.hp,
            morale: FX_ONE,
          });
        }
      }
    }
  },
  input(tick) {
    // 150 tick ごとに、スロットを順に回して令を配る（届かないスロットの令は捨てられる）。
    if (tick === 0 || tick % 150 !== 0) return [];
    const n = tick / 150;
    const slot = ((n - 1) % 3) + 1;
    const orders = ['charge', 'hold', 'retreat', 'siege'] as const;
    const order = orders[Math.floor((n - 1) / 3) % orders.length]!;
    return [
      { t: 'setOrder', p: 0 as PlayerId, front: slot, order, tier: 'upper' },
      // 相手も令を出す（片側だけだと `07§5` の重みが片方しか通らない）
      { t: 'setOrder', p: 1 as PlayerId, front: slot, order: 'hold', tier: 'upper' },
    ];
  },
};

// ---------------------------------------------------------------------------
// 代表試合 3: 8 人戦
// ---------------------------------------------------------------------------

const EIGHT: GoldenScenario = {
  id: 'eight-8p',
  what: '8 人戦（マップ 400×400、8 プレイヤー分の経済と人口。`07§13` の広さ）',
  seed: 11110003,
  setup: {
    playerCount: 8,
    civs: ['yamato', 'roma', 'tou', 'viking', 'mali', 'azteca', 'persia', 'mongol'],
    mapType: 'plain',
    teams: [0, 0, 1, 1, 2, 2, 3, 3],
  },
  ticks: 1250, // 50 秒（8 人ぶんの系が回ることを見るのが目的）
  input(tick, ids) {
    if (tick !== 50 && tick !== 500) return [];
    const out: Command[] = [];
    for (let p = 0; p < ids.townCenter.length; p++) {
      const b = ids.townCenter[p]!;
      if (b < 0) continue;
      out.push({ t: 'produce', p: p as PlayerId, building: b, unit: 'villager', count: 1 });
    }
    return out;
  },
};

/** 代表 3 試合。**順序も固定**（ファイル名と 1 対 1）。 */
export const GOLDEN_SCENARIOS: readonly GoldenScenario[] = [ECON, FRONTS, EIGHT];

// ---------------------------------------------------------------------------
// 走らせる
// ---------------------------------------------------------------------------

/** 記録付きで 1 試合回して `.mtr` 相当を作る。 */
export function recordScenario(sc: GoldenScenario): Replay {
  const w = createMatch({
    seed: sc.seed,
    playerCount: sc.setup.playerCount,
    civs: sc.setup.civs,
    mapType: sc.setup.mapType as MapTypeId,
    ...(sc.setup.teams !== undefined ? { teams: sc.setup.teams } : {}),
  }).world;
  sc.prepare?.(w);
  const ids = collectIds(w);
  const rec = new ReplayRecorder(sc.seed, sc.setup, dataHash());
  for (let t = 0; t < sc.ticks; t++) {
    const cmds = sc.input(w.tick, ids);
    rec.record(w.tick, cmds.length > 0 ? groupByPlayer(cmds) : {});
    stepWorld(w, cmds);
    if (w.tick % HASH_CHECK_INTERVAL_TICKS === 0) rec.recordHash(w.tick, hashWorld(w));
  }
  return rec.finish();
}

/** 記録から再生して、250 tick ごとのハッシュ列を返す。 */
export function replayScenario(sc: GoldenScenario, replay: Replay): { tick: number; hash: number }[] {
  const w = createMatch({
    seed: replay.seed,
    playerCount: replay.setup.playerCount,
    civs: replay.setup.civs as readonly CivId[],
    mapType: replay.setup.mapType as MapTypeId,
    ...(replay.setup.teams !== undefined ? { teams: replay.setup.teams } : {}),
  }).world;
  sc.prepare?.(w);
  const out: { tick: number; hash: number }[] = [];
  let cursor = 0;
  const buf: Command[] = [];
  for (let t = 0; t < sc.ticks; t++) {
    buf.length = 0;
    while (cursor < replay.inputs.length && replay.inputs[cursor]!.tick < w.tick) cursor++;
    const frame = replay.inputs[cursor];
    if (frame !== undefined && frame.tick === w.tick) {
      for (const pid of Object.keys(frame.byPlayer)
        .map(Number)
        .sort((a, b) => a - b)) {
        for (const c of frame.byPlayer[pid] ?? []) buf.push(c);
      }
    }
    stepWorld(w, buf);
    if (w.tick % HASH_CHECK_INTERVAL_TICKS === 0) out.push({ tick: w.tick, hash: hashWorld(w) });
  }
  return out;
}

/** `Command[]` を playerId ごとに分ける（`ReplayRecorder.record` の形）。 */
function groupByPlayer(cmds: readonly Command[]): Record<number, Command[]> {
  const out: Record<number, Command[]> = {};
  for (const c of cmds) {
    const p = c.p;
    (out[p] ??= []).push(c);
  }
  return out;
}
