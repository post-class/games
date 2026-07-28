import type { System } from "../../ecs/System";
import type { World } from "../../ecs/World";
import type { EventBus } from "../../util/EventBus";
import type { VfxManager } from "../../render/VfxManager";

/** 爆発レイヤー構成定義。 */
interface ExplosionLayers {
  flash: boolean;
  shockwave: boolean;
  debris: number;
  smoke: number;
  sparks: number;
}

/** 撃墜時のフルレイヤー爆発。 */
const DESTROYED_LAYERS: ExplosionLayers = {
  flash: true,
  shockwave: true,
  debris: 8,
  smoke: 6,
  sparks: 24,
};

/** 被弾時の軽量爆発 (閃光+火花のみ)。 */
const HIT_LAYERS: ExplosionLayers = {
  flash: true,
  shockwave: false,
  debris: 0,
  smoke: 0,
  sparks: 6,
};

/**
 * 撃墜・被弾イベントを購読し、多層パーティクル爆発をVfxManagerに要求する。
 * VfxManager が実際のパーティクル更新を担うため、本Systemのupdateはno-op。
 * ECS外の純粋な視覚要素として管理する (可変レート更新)。
 */
export class ExplosionSystem implements System {
  readonly name = "ExplosionSystem";

  constructor(
    events: EventBus,
    private readonly vfx: VfxManager,
  ) {
    events.on("destroyed", (e) => {
      // 撃墜時: フルレイヤー爆発 + velocity継承
      const scale = this.getScaleByFaction(e.faction);
      this.spawnLayered(e.position, DESTROYED_LAYERS, scale, e.velocity);
    });
    events.on("hit", (e) => {
      // 被弾時: 軽量爆発 (閃光+火花)
      this.spawnLayered(e.position, HIT_LAYERS, 0.5);
    });
  }

  /**
   * 多層パーティクル爆発を生成する。
   * @param position 爆発中心座標
   * @param layers 各レイヤーの有効/無効と個数
   * @param scale 全体スケール係数
   * @param velocity オプション: デブリに継承する親速度
   */
  private spawnLayered(
    position: import("three").Vector3,
    layers: ExplosionLayers,
    scale: number,
    velocity?: import("three").Vector3,
  ): void {
    if (layers.flash) {
      this.vfx.spawn("explosion.flash", { position, scale });
    }
    if (layers.shockwave) {
      this.vfx.spawn("explosion.shockwave", { position, scale });
    }
    if (layers.debris > 0) {
      this.vfx.spawn("explosion.debris", { position, count: layers.debris, scale, velocity });
    }
    if (layers.smoke > 0) {
      this.vfx.spawn("explosion.smoke", { position, count: layers.smoke });
    }
    if (layers.sparks > 0) {
      this.vfx.spawn("explosion.sparks", { position, count: layers.sparks });
    }
  }

  /**
   * 陣営やサイズに応じて爆発スケールを調整する。
   * 将来的に機体サイズ情報があればそれも加味できる。
   */
  private getScaleByFaction(_faction: number): number {
    // 簡易実装: 全て同スケール。faction別の差別化は将来拡張。
    return 1.0;
  }

  /** ミッション切替時に全エフェクトを即時除去する。 */
  reset(): void {
    this.vfx.reset();
  }

  /**
   * 可変レート更新。パーティクル更新はVfxManagerが担うのでno-op。
   * Systemとしての契約を満たすためのスタブ。
   */
  update(_world: World, _dt: number): void {
    // VfxManagerが一括更新するため、ここでは何もしない。
  }
}
