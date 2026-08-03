import { Vector3 } from 'three';
import { bus } from '../core/events';
import { forwardOf } from '../core/math';
import type { Entity } from '../world/entity';
import type { World } from '../world/world';

/**
 * 脱出 (Eject)。
 *
 * 機体を捨ててポッドで離脱する。機体は失うが、パイロットは生き延びる。
 * WC と同じく「勝てない戦いから命だけ持ち帰る」選択肢として置いている。
 *
 * 脱出したポッドは中立扱いで、敵はもう狙わない。
 * ミッションは「機体喪失」として失敗するが、次の出撃はできる。
 */

export interface EjectResult {
  ok: boolean;
  reason?: string;
}

const _fwd = new Vector3();

/** 脱出できる状態かどうか */
export function canEject(e: Entity | undefined): EjectResult {
  if (!e || !e.ship) return { ok: false, reason: '自機がない' };
  if (e.ship.ejected) return { ok: false, reason: 'すでに脱出している' };
  if (e.ship.def.role !== 'fighter' && e.ship.def.role !== 'bomber') {
    return { ok: false, reason: 'この機体には射出座席がない' };
  }
  return { ok: true };
}

/**
 * 脱出を実行する。
 *
 * エンティティは残したまま「ポッド」に変える。
 * 機動と武装を失い、陣営を中立にして狙われなくする。
 */
export function eject(world: World, e: Entity): EjectResult {
  void world;
  const check = canEject(e);
  if (!check.ok) return check;
  const ship = e.ship!;

  ship.ejected = true;
  // 武装と機動を失う
  ship.missiles = [];
  ship.flares = 0;
  ship.energy = 0;
  // ポッドは小さく、装甲も無い
  e.radius = Math.max(3, e.radius * 0.25);
  ship.shield.front = 0;
  ship.shield.rear = 0;
  ship.armor = { front: 0, rear: 0, left: 0, right: 0 };
  ship.hull = Math.max(1, ship.hull * 0.35);
  // 敵は中立を撃たない
  e.faction = 'neutral';
  e.label = '脱出ポッド';
  ship.targetId = undefined;
  ship.lockedId = undefined;
  ship.lockProgress = 0;

  // 機体から前方へ射出される勢いを付ける
  forwardOf(e.quat, _fwd);
  e.vel.addScaledVector(_fwd, 60);
  if (e.input) {
    e.input.throttle = 0;
    e.input.afterburner = false;
    e.input.firePrimary = false;
    e.input.pitch = 0;
    e.input.yaw = 0;
    e.input.roll = 0;
  }

  bus.emit('explosion', { pos: e.pos.clone(), radius: e.radius * 3, kind: 'small' });
  bus.emit('announce', { text: '脱出', kind: 'warn', durationMs: 2600 });
  bus.emit('radio', {
    speaker: '管制',
    text: '脱出を確認。救助艇を向かわせる。動くな。',
    tone: 'command',
  });
  bus.emit('ejected', { entity: e });
  return { ok: true };
}
