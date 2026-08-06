/**
 * 島の復元と保存（docs/02_ゲーム実装プラン/03_データモデル.md §4）
 *
 * IslandSim と Repo の橋渡しだけを担う。
 * - メモリ上の状態が「正」。DBは永続化先にすぎない
 * - 復元は起動時に1回、保存は30秒ごと＋停止時
 */
import { SNAPSHOT_INTERVAL_TICKS, type Actor, type Placeable, type ResourceNode } from '@ai-pet/shared';
import type { Repo, SnapshotData } from '../db/repo.ts';
import type { IslandSim } from './island.ts';

/** DBに島の行があればそのseedを返す（env より DB を優先する。seedが変わると地形が変わってしまうため） */
export function resolveSeed(repo: Repo, islandId: string, envSeed: string): { seed: string; existed: boolean } {
  const rec = repo.loadIsland(islandId);
  if (rec) return { seed: rec.seed, existed: true };
  return { seed: envSeed, existed: false };
}

export interface RestoreResult {
  restored: boolean;
  tick: number;
  islandDay: number;
  /** 停止していた実時間（ms）。catch-up判定に使う */
  offlineMs: number;
  critters: number;
  resources: number;
}

/** 起動時の復元。DBに何も無ければ何もしない */
export function restoreIsland(sim: IslandSim, repo: Repo): RestoreResult {
  const islandRec = repo.loadIsland(sim.islandId);
  const empty: RestoreResult = {
    restored: false,
    tick: 0,
    islandDay: 1,
    offlineMs: 0,
    critters: 0,
    resources: 0,
  };
  if (!islandRec) return empty;

  const world = sim.world;
  const snap = repo.loadSnapshot(sim.islandId);

  if (snap) {
    // RNGの状態を戻す。壊れたデータ（全0）は退化した乱数列になるので採用しない
    if (!snap.rngState.every((v) => v === 0)) world.rng.setState(snap.rngState);
    world.setNextId(snap.nextEntityId);
    if (snap.tilesDecay.length === world.decay.length) world.decay.set(snap.tilesDecay);

    // 資源は addResource 経由で入れる（resourceAt の索引も張られる）
    world.resources.clear();
    world.resourceAt.fill(0);
    for (const r of snap.resources) world.addResource(r);

    world.placeables.clear();
    for (const p of snap.placeables) world.addPlaceable(p);

    // 動物を戻す（プレイヤーとペットは接続時・作成時に復元する）
    for (const [id, a] of [...world.actors]) if (a.kind === 'critter') world.actors.delete(id);
    for (const c of snap.critters) world.addActor(c);

    // island.tick と snapshot.tick は最大30秒ズレる。スナップショット側を採用する
    sim.tick = snap.tick;
  } else {
    sim.tick = islandRec.tick;
  }

  sim.clock.restore({
    islandDay: islandRec.islandDay,
    season: islandRec.season,
    weather: islandRec.weather,
    lastWeatherRollTick: islandRec.lastWeatherRollTick,
  });

  return {
    restored: true,
    tick: sim.tick,
    islandDay: islandRec.islandDay,
    offlineMs: Math.max(0, Date.now() - islandRec.updatedAt),
    critters: snap?.critters.length ?? 0,
    resources: snap?.resources.length ?? 0,
  };
}

function snapshotOf(sim: IslandSim): SnapshotData {
  const critters: Actor[] = [];
  for (const a of sim.world.actors.values()) if (a.kind === 'critter') critters.push(a);
  const resources: ResourceNode[] = [...sim.world.resources.values()];
  const placeables: Placeable[] = [...sim.world.placeables.values()];
  return {
    tick: sim.tick,
    critters,
    resources,
    placeables,
    tilesDecay: sim.world.decay,
    nextEntityId: sim.world.peekNextId(),
    rngState: sim.world.rng.getState(),
  };
}

/** 島の状態＋スナップショットを保存する（30秒ごと／停止時） */
export function saveIsland(sim: IslandSim, repo: Repo): void {
  repo.saveSnapshot(sim.islandId, snapshotOf(sim));
  repo.saveIsland({
    id: sim.islandId,
    seed: sim.seed,
    tick: sim.tick,
    updatedAt: Date.now(),
    ...sim.clock.toJSON(),
  });
}

/** 30秒ごとの保存をtickフックとして登録する */
export function attachAutoSave(sim: IslandSim, repo: Repo, onSave?: () => void): void {
  sim.onTick((tick) => {
    if (tick % SNAPSHOT_INTERVAL_TICKS !== 0) return;
    try {
      saveIsland(sim, repo);
      onSave?.();
    } catch (e) {
      // 保存の失敗でゲームを止めない。次の30秒後に再試行される
      console.error('[persistence] 自動保存に失敗', e);
    }
  });
}
