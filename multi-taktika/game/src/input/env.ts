/**
 * input/env.ts — 入力層が外の世界に触るための窓口
 *
 * 入力層は `World` を読み、`Command` を吐く。それ以外（カメラ・選択・UI 状態）は
 * **端末ローカル**なのでここに置く（手順書 §9.1）。
 *
 * `mouse.ts` / `keys.ts` はこの interface しか知らないので、
 * テストでは DOM もレンダラも用意せずに振る舞いを検証できる。
 */

import type { PlayerId } from '@/shared/types';
import type { Command } from '@/sim/command';
import type { World } from '@/sim/core/world';
import type { VisibilityQuery } from '@/render/spriteLayer';
import type { CameraController } from './camera';
import type { Selection } from './selection';

export interface InputContext {
  /** 今の World（読み取り専用で使う）。 */
  world(): World;
  /** 操作しているプレイヤー。 */
  readonly viewer: PlayerId;
  readonly cam: CameraController;
  readonly selection: Selection;
  /** 霧（null = 全部見える）。 */
  vision(): VisibilityQuery | null;
  /**
   * Command を発行する。**この tick の入力列に積むだけ**で、
   * `stepWorld` に渡すのは `main.ts` の責務。
   */
  emit(cmd: Command): void;
  /** 選択・カメラが変わったことを HUD に伝える（省略可）。 */
  onChange?: () => void;
}
