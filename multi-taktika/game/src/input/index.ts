/**
 * input/index.ts — 入力層の入口。
 *
 * 入力層が sim に渡すのは `Command` のみ。
 * 選択状態・カメラ・UI 状態は端末ローカルで、Command にしない（手順書 §9.1）。
 */

export * from './env';
export * from './camera';
export * from './selection';
export * from './context';
export * from './cursor';
export * from './mouse';
export * from './keys';
