/** 物理・ループ関連のチューニング値を一元管理する。 */
export const PHYSICS = {
  /** 固定タイムステップ (秒)。60Hz。 */
  fixedDt: 1 / 60,
  /** 1フレームあたりの最大サブステップ数 (spiral-of-death 防止)。 */
  maxSubSteps: 5,
  /** 1フレームで許容する最大経過時間 (秒)。これを超える分は捨てる。 */
  maxFrameTime: 0.25,

  /**
   * フライトアシストOFF時の速度上限倍率。
   * ニュートン純度重視なら大きく、扱いやすさ重視なら小さく。
   * 通常上限(maxLinearSpeed) に対する倍率。
   */
  assistOffSpeedMultiplier: 1.5,

  /** 角速度の絶対上限 (rad/s)。過剰なスピン防止。 */
  maxAngularSpeed: 3.5,

  /**
   * WCアーケード方式で、速度ベクトルが機首方向へ追従する速さ (1/秒)。
   * 大きいほどキビキビ (旋回すると即座に新方向へ飛ぶ)、小さいほどドリフト感が出る。
   */
  arcadeVelResponse: 2.4,
  /** アフターバーナー時の追従レート (より機敏)。 */
  arcadeAfterburnerResponse: 3.2,
} as const;
