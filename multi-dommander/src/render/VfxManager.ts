import type { Scene } from "three";
import type { System } from "../ecs/System";
import type { World } from "../ecs/World";

/**
 * 視覚効果プールの共通インタフェース。
 * 各エフェクト種別 (爆発閃光/衝撃波/デブリ/煙/火花/マズルフラッシュ/トレイル 等) は
 * これを実装し、起動時に確保した固定長バッファを再利用する (毎フレームの new を避けGCスパイクを防ぐ)。
 */
export interface VfxPool<TConfig = unknown> {
  /** プールから1エフェクトを発生させる (上限超過時は最古を回収して再利用)。 */
  spawn(config: TConfig): void;
  /** 可変レートで内部パーティクルを進める。 */
  update(dt: number): void;
  /** 現在アクティブなエフェクト/パーティクル数 (性能計測用)。 */
  activeCount(): number;
  /** 全エフェクトを即時除去する (ミッション切替時)。 */
  reset(): void;
  /** シーンからの取り外しとリソース解放。 */
  dispose(): void;
}

/**
 * 視覚効果の一元管理。プールを名前で登録し、`spawn(key, config)` で発生させる。
 * 可変レート System として登録し、`update()` で全プールを一括更新する。
 * 具体的なプール実装 (Points/InstancedMesh ベース) は各エフェクト側が register する。
 */
export class VfxManager implements System {
  readonly name = "VfxManager";
  private readonly pools = new Map<string, VfxPool>();

  constructor(readonly scene: Scene) {}

  /** プールを登録する。key は "explosion.flash" のような種別名。 */
  register<T>(key: string, pool: VfxPool<T>): this {
    this.pools.set(key, pool as VfxPool);
    return this;
  }

  /** 登録済みプールにエフェクト発生を要求する。未登録キーは無視 (演出は欠けてもゲームは進む)。 */
  spawn<T = unknown>(key: string, config: T): void {
    this.pools.get(key)?.spawn(config);
  }

  /** 可変レート更新 (World は使わないが System 契約に合わせる)。 */
  update(_world: World, dt: number): void {
    for (const pool of this.pools.values()) pool.update(dt);
  }

  /** 全プールのアクティブ数合計 (性能オーバーレイ用)。 */
  activeCount(): number {
    let n = 0;
    for (const pool of this.pools.values()) n += pool.activeCount();
    return n;
  }

  /** ミッション切替時などに全エフェクトを消す。 */
  reset(): void {
    for (const pool of this.pools.values()) pool.reset();
  }

  dispose(): void {
    for (const pool of this.pools.values()) pool.dispose();
    this.pools.clear();
  }
}
