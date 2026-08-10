import { Vector3 } from 'three';
import { isHostile } from '../content/factions';
import type { Entity } from '../world/entity';
import type { World } from '../world/world';

/** この距離内に敵がいるとオートパイロットは使えない */
export const AUTOPILOT_BLOCK_RANGE = 4500;
/** この距離内に障害物があるとオートパイロットは使えない */
export const AUTOPILOT_HAZARD_RANGE = 2200;
/** オートパイロット中の巡航速度 */
const AUTOPILOT_SPEED = 7000;
/**
 * オートパイロットが連れて行く味方機の範囲 (m)。
 *
 * 護送作戦の船団は隊列そのものに幅がある（第3章の避難船18隻）。
 * 3000m だと隊列の端が置き去りになり、`escortArrive` が
 * 「操作していないのに達成できない」目標になってしまうため、
 * 到着時の間合い (`src/mission/navArrival.ts` の隊列幅上限) と
 * 釣り合う値まで広げてある。**自機の隣にいることは依然として条件**で、
 * 現場に置いてきた船は連れて行かない。
 */
export const AUTOPILOT_ESCORT_RANGE = 5200;

export function nextNav(world: World): Entity | undefined {
  let best: Entity | undefined;
  for (const e of world.entities) {
    if (!e.alive || e.kind !== 'nav' || !e.nav || e.nav.reached) continue;
    if (!best || e.nav.index < best.nav!.index) best = e;
  }
  return best;
}

export function navByIndex(world: World, index: number): Entity | undefined {
  for (const e of world.entities) {
    if (e.alive && e.kind === 'nav' && e.nav?.index === index) return e;
  }
  return undefined;
}

/** 指定位置の近くにいる敵の数 */
export function hostilesNear(world: World, faction: Entity['faction'], pos: Vector3, range: number): number {
  let n = 0;
  const r2 = range * range;
  for (const e of world.entities) {
    if (!e.alive || e.kind !== 'ship' || !e.ship) continue;
    if (!isHostile(faction, e.faction)) continue;
    if (e.pos.distanceToSquared(pos) <= r2) n++;
  }
  return n;
}

/** 近くに小惑星や機雷があるか。あれば自動航行を許さない */
function hazardNear(world: World, pos: Vector3, range: number): Entity | undefined {
  for (const e of world.entities) {
    if (!e.alive || (e.kind !== 'rock' && e.kind !== 'mine')) continue;
    if (e.pos.distanceTo(pos) - e.radius <= range) return e;
  }
  return undefined;
}

export interface AutopilotCheck {
  ok: boolean;
  reason?: string;
}

/**
 * オートパイロットの可否。
 *
 * ignoreHostiles を立てると敵の存在を無視する。
 * 「戦闘目標を達成し、あとは帰投するだけ」の状態で使う想定で、
 * これが無いと敵が残っている限り母艦へ戻れず詰んでしまう。
 */
export function canAutopilot(
  world: World,
  player: Entity,
  ignoreHostiles = false,
): AutopilotCheck {
  const nav = nextNav(world);
  if (!nav) return { ok: false, reason: '目的地がない' };
  if (!ignoreHostiles && hostilesNear(world, player.faction, player.pos, AUTOPILOT_BLOCK_RANGE) > 0) {
    return { ok: false, reason: '交戦中はオートパイロットを使えない' };
  }
  const hz = hazardNear(world, player.pos, AUTOPILOT_HAZARD_RANGE);
  if (hz) {
    return {
      ok: false,
      reason:
        hz.kind === 'mine' ? '機雷原の中では自動航行できない' : '小惑星帯の中では自動航行できない',
    };
  }
  const d = nav.pos.distanceTo(player.pos);
  if (d < nav.nav!.arriveRadius) return { ok: false, reason: 'すでに到達している' };
  return { ok: true };
}

const _dir = new Vector3();
const _offset = new Vector3();

/**
 * オートパイロットの1ステップ。
 * プレイヤーを次の Nav へ高速で運び、僚機も相対位置を保って同行させる。
 * 戻り値 false で終了 (到達 or 中断)。
 */
export function updateAutopilot(
  world: World,
  dt: number,
  navId?: number,
  ignoreHostiles = false,
): { active: boolean; reason?: string; arrived?: boolean } {
  const player = world.player;
  if (!player) return { active: false, reason: '自機喪失' };
  // 作動開始時に決めた Nav だけを目指す。
  // これを固定しないと、到達判定が入った次のフレームに次の Nav へ走り続けてしまう。
  const nav = (navId !== undefined ? world.byId(navId) : undefined) ?? nextNav(world);
  if (!nav || !nav.nav) return { active: false, reason: '目的地がない' };
  if (nav.nav.reached) return { active: false, arrived: true };

  if (
    !ignoreHostiles &&
    hostilesNear(world, player.faction, player.pos, AUTOPILOT_BLOCK_RANGE) > 0
  ) {
    return { active: false, reason: '敵機接近、オートパイロット解除' };
  }
  if (hazardNear(world, player.pos, AUTOPILOT_HAZARD_RANGE)) {
    return { active: false, reason: '障害物接近、オートパイロット解除' };
  }

  _dir.copy(nav.pos).sub(player.pos);
  const dist = _dir.length();
  if (dist <= nav.nav.arriveRadius) return { active: false, arrived: true };
  _dir.divideScalar(dist);

  const step = Math.min(dist - nav.nav.arriveRadius * 0.9, AUTOPILOT_SPEED * dt);
  // 僚機を相対位置ごと連れて行く
  for (const e of world.entities) {
    if (!e.alive || e.kind !== 'ship' || e.id === player.id) continue;
    if (isHostile(player.faction, e.faction)) continue;
    if (e.ship?.def.role === 'capital') continue;
    if (e.pos.distanceTo(player.pos) > AUTOPILOT_ESCORT_RANGE) continue;
    e.pos.addScaledVector(_dir, step);
    e.renderPrevPos.copy(e.pos);
  }

  player.pos.addScaledVector(_dir, step);
  player.prevPos.copy(player.pos);
  player.renderPrevPos.copy(player.pos);
  // 機首を進行方向へ向ける
  player.quat.setFromUnitVectors(new Vector3(0, 0, -1), _dir);
  player.renderPrevQuat.copy(player.quat);
  player.vel.copy(_dir).multiplyScalar(player.ship!.def.maxSpeed * 0.6);
  void _offset;

  return { active: true };
}

/** Nav 到達判定。到達した Nav を返す。 */
export function checkNavArrival(world: World): Entity | undefined {
  const player = world.player;
  if (!player) return undefined;
  const nav = nextNav(world);
  if (!nav) return undefined;
  if (player.pos.distanceTo(nav.pos) <= nav.nav!.arriveRadius) {
    nav.nav!.reached = true;
    return nav;
  }
  return undefined;
}
