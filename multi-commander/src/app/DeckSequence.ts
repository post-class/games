import { Quaternion, Vector3 } from 'three';
import { bus } from '../core/events';
import { forwardOf } from '../core/math';
import { shipDef } from '../content/ships';
import { newAi } from '../sim/ai';
import type { Entity } from '../world/entity';
import { spawnShip, type World } from '../world/world';

/**
 * 発艦・着艦シーケンス。
 *
 * WC ではカタパルトで撃ち出され、帰投時は着艦誘導があった。
 * 「いきなり宇宙にいる」状態を避け、母艦に所属している感覚を作るための演出。
 *
 * 演出中はプレイヤーの入力を受け付けず、機体を台本通りに動かす。
 */

export type DeckPhase = 'none' | 'launch' | 'landing';

const _fwd = new Vector3();

/** 発艦にかかる秒数 */
const LAUNCH_TIME = 3.4;
/** 着艦にかかる秒数 */
const LANDING_TIME = 3.6;

export class DeckSequence {
  phase: DeckPhase = 'none';
  private timer = 0;
  /** 演出用に置いた母艦 (演出後も戦域に残す) */
  private carrierId?: number;
  private spoke = new Set<string>();

  get active(): boolean {
    return this.phase !== 'none';
  }

  /**
   * 発艦を開始する。
   * 自機の後方に母艦を置き、カタパルトで前方へ撃ち出す。
   */
  startLaunch(world: World, player: Entity): void {
    this.phase = 'launch';
    this.timer = 0;
    this.spoke.clear();

    // 母艦を後方に配置する。中立なので誰も撃たず、目標判定にも影響しない。
    forwardOf(player.quat, _fwd);
    const pos = player.pos.clone().addScaledVector(_fwd, -520);
    const carrier = spawnShip(world, {
      def: shipDef('tigers-claw'),
      faction: 'neutral',
      pos,
      quat: player.quat.clone(),
      speed: 30,
      label: 'TCS タイガーズ・クロー',
      tag: 'homebase',
      ai: newAi(0, { passive: true }),
    });
    this.carrierId = carrier.id;

    // 発艦直後の初速。カタパルトで押し出される
    player.vel.copy(_fwd).multiplyScalar(60);
    if (player.input) player.input.throttle = 0;
  }

  /** 着艦を開始する。前方に母艦を置き、減速して滑り込む */
  startLanding(world: World, player: Entity): void {
    this.phase = 'landing';
    this.timer = 0;
    this.spoke.clear();

    let carrier = this.carrierId ? world.byId(this.carrierId) : undefined;
    if (!carrier) {
      forwardOf(player.quat, _fwd);
      const pos = player.pos.clone().addScaledVector(_fwd, 900);
      carrier = spawnShip(world, {
        def: shipDef('tigers-claw'),
        faction: 'neutral',
        pos,
        quat: player.quat.clone(),
        speed: 30,
        label: 'TCS タイガーズ・クロー',
        tag: 'homebase',
        ai: newAi(0, { passive: true }),
      });
      this.carrierId = carrier.id;
    }
    // 母艦の方を向かせる
    const dir = carrier.pos.clone().sub(player.pos);
    if (dir.lengthSq() > 1e-4) {
      player.quat.setFromUnitVectors(new Vector3(0, 0, -1), dir.normalize());
    }
  }

  /**
   * 演出を1ステップ進める。true を返す間はプレイヤー入力を無効にする。
   */
  update(world: World, dt: number): boolean {
    if (this.phase === 'none') return false;
    const player = world.player;
    if (!player?.input) {
      this.phase = 'none';
      return false;
    }
    this.timer += dt;

    if (this.phase === 'launch') return this.updateLaunch(player);
    return this.updateLanding(world, player);
  }

  private say(key: string, speaker: string, text: string): void {
    if (this.spoke.has(key)) return;
    this.spoke.add(key);
    bus.emit('radio', { speaker, text, tone: 'command' });
  }

  private updateLaunch(player: Entity): boolean {
    const t = this.timer;
    const input = player.input!;
    input.firePrimary = false;
    input.pitch = 0;
    input.yaw = 0;
    input.roll = 0;

    if (t < 0.7) {
      // カタパルトに載っている段階
      this.say('hold', '発着管制', '発艦位置へ。カタパルト、ロック。');
      input.throttle = 0.1;
      bus.emit('cameraShake', { strength: 0.05 });
    } else if (t < 2.0) {
      // 射出
      this.say('go', '発着管制', 'カタパルト作動。行け！');
      input.throttle = 1;
      input.afterburner = true;
      bus.emit('cameraShake', { strength: 0.09 });
    } else if (t < LAUNCH_TIME) {
      this.say('clear', '発着管制', '発艦を確認。あとは任せる。生きて戻れ。');
      input.throttle = 0.7;
      input.afterburner = false;
    } else {
      this.phase = 'none';
      return false;
    }
    return true;
  }

  private updateLanding(world: World, player: Entity): boolean {
    const t = this.timer;
    const input = player.input!;
    input.firePrimary = false;
    input.afterburner = false;

    const carrier = this.carrierId ? world.byId(this.carrierId) : undefined;
    if (carrier) {
      // 母艦の方へ機首を寄せ続ける
      const dir = carrier.pos.clone().sub(player.pos);
      const dist = dir.length();
      if (dist > 1e-3) {
        dir.divideScalar(dist);
        const want = new Quaternion().setFromUnitVectors(new Vector3(0, 0, -1), dir);
        player.quat.slerp(want, 1 - Math.pow(0.5, 1 / 12));
      }
      // 距離に応じて減速する
      input.throttle = dist > 600 ? 0.5 : dist > 300 ? 0.25 : 0.08;
    } else {
      input.throttle = 0.15;
    }
    input.pitch = 0;
    input.yaw = 0;
    input.roll = 0;

    if (t < 1.0) {
      this.say('approach', '発着管制', '着艦誘導を開始する。速度を落とせ。');
    } else if (t < 2.4) {
      this.say('align', '発着管制', '進入角良好。そのまま滑り込め。');
    } else if (t < LANDING_TIME) {
      this.say('down', '発着管制', '着艦を確認。……よく帰ってきた。');
      bus.emit('cameraShake', { strength: 0.06 });
    } else {
      this.phase = 'none';
      return false;
    }
    return true;
  }

  reset(): void {
    this.phase = 'none';
    this.timer = 0;
    this.carrierId = undefined;
    this.spoke.clear();
  }
}
