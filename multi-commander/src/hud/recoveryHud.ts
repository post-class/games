/**
 * 収容の HUD 表記 (T4-⑮)。
 *
 * 第1章で起きたのは「脱出ポッド3基を回収する」が**近づく手段を示されないまま失敗する**ことだった。
 * そのため、ここでは常に「いま何が足りないか」と「何をすれば良いか」を一組で返す。
 *
 * DOM を触らない純粋な組み立てなので、文言と進捗の刻みを単体テストで固定できる。
 * 数値の出所は `src/sim/recovery.ts`（条件）と `RecoveryStatus`（実測値）だけで、
 * ここで別の閾値を定義しない。
 */

import type { RecoveryStatus } from '../sim/recovery';

/** 収容表示の1件。 */
export interface RecoveryHudView {
  /** 1行目。対象名と状態 */
  title: string;
  /** 2行目。何をすれば良いか */
  advice: string;
  /** 進捗バー用の 0..1 */
  ratio: number;
  /** 収容が進んでいるか（色分けに使う） */
  holding: boolean;
}

/** 秒の表記。0.1 秒刻みで、進んでいることが読めるようにする。 */
export function formatHoldSeconds(seconds: number): string {
  return `${Math.max(0, seconds).toFixed(1)}s`;
}

/** メートルの表記。 */
function meters(m: number): string {
  return `${Math.max(0, Math.round(m))}m`;
}

/**
 * 収容表示を組む。
 *
 * - 保持できている: 「収容中 2.4s / 3.0s」＋「この位置を保て — 掩護を頼め」
 * - 速すぎる:       「収容できない — 速すぎる」＋「減速せよ — 相対速度 180 / 60 m/s」
 * - 遠すぎる:       「収容準備 — 〈対象〉」＋「接近せよ — 残り 640m（260m 以内）」
 * - 演出中:         「収容できない — 機体が安定していない」
 */
export function recoveryHudView(status: RecoveryStatus): RecoveryHudView {
  const cond = status.conditions;
  const ratio = cond.holdSeconds > 0 ? Math.min(1, status.progress / cond.holdSeconds) : 0;
  const holding = status.block === 'ready' && status.progress > 0;

  if (status.block === 'suspended') {
    return {
      title: `収容できない — ${status.name}`,
      advice: '機体が安定していない — 落ち着いてからやり直せ',
      ratio,
      holding: false,
    };
  }
  if (status.block === 'far') {
    return {
      title: `収容準備 — ${status.name}`,
      advice: `接近せよ — 残り ${meters(status.distance - cond.range)}（${meters(cond.range)} 以内へ）`,
      ratio,
      holding: false,
    };
  }
  if (status.block === 'fast') {
    return {
      title: `収容できない — ${status.name}`,
      advice: `速すぎる — 減速せよ（相対 ${Math.round(status.relSpeed)} / ${Math.round(cond.relSpeed)} m/s）`,
      ratio,
      holding: false,
    };
  }
  return {
    title: `収容中 ${formatHoldSeconds(status.progress)} / ${formatHoldSeconds(cond.holdSeconds)} — ${status.name}`,
    advice: 'この位置を保て — 無防備になる。僚機に掩護を頼め',
    ratio,
    holding,
  };
}
