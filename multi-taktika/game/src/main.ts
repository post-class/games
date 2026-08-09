/**
 * main.ts — エントリポイント（M5 の通し確認）
 *
 * 起動したら `createMatch` で **2 人（ヤマト vs モンゴル）** の試合を作り、
 * 実際に動く対戦画面を出す。
 *
 * ■ ループ（手順書 §4.1）
 * ```
 * acc += dtMs * speedMul;
 * while (acc >= 40 && steps < 5) {   // 上限 5: 遅い端末で暴走させない
 *   renderer.beforeStep(world);      // tick 間補間の退避（T-M5-03）
 *   stepWorld(world, takeCommands());
 *   acc -= 40; steps++;
 * }
 * renderer.draw(..., acc / 40);      // acc / 40 = 補間係数 alpha
 * ```
 *
 * ■ 層（手順書 §3.1）
 *   `render` / `ui` / `input` は sim を**読むだけ**。
 *   sim を変えるのは `Command` 経由だけ（`pending` に積んで tick 頭で渡す）。
 *   `Command` は playerId 昇順 → 発行順に並べる（順序が変わると結果が変わる）。
 *
 * ■ M12 への申し送り
 *   本来はここがタイトル → 対戦設定 → 対戦画面の画面遷移のルートになる。
 *   今はスカーミッシュ 1 本を直接起動している。
 */

import '@/styles/hud.css';

import type { CivId, PlayerId } from '@/shared/types';
import type { Command } from '@/sim/command';
import { TICK_MS, createMatch, stepWorld } from '@/sim';
import { FX_ONE } from '@/sim/core/fx';
import { Renderer } from '@/render/Renderer';
import { PlaceholderSpriteProvider } from '@/render/placeholder';
import type { VisibilityQuery } from '@/render/spriteLayer';
import { CameraController } from '@/input/camera';
import { KeyboardInput } from '@/input/keys';
import { MouseInput } from '@/input/mouse';
import { Selection } from '@/input/selection';
import { tileToFx } from '@/input/context';
import type { InputContext } from '@/input/env';
import { Hud, type HudContext } from '@/ui';

/** 1 フレームで進める tick の上限（手順書 §4.1）。 */
const MAX_STEPS_PER_FRAME = 5;

/** ゲーム速度（0.5〜1.5。`07§14`。tick レートは変えない）。 */
const SPEED_MUL = 1;

/** M5 の通し確認で使う対戦カード。 */
const CIVS: readonly CivId[] = ['yamato', 'mongol'];

function main(): void {
  const canvas = document.getElementById('field') as HTMLCanvasElement | null;
  const overlay = document.getElementById('overlay');
  const boot = document.getElementById('boot');
  if (canvas === null || overlay === null) {
    throw new Error('main: #field / #overlay が見つからない');
  }
  const ctx2d = canvas.getContext('2d');
  if (ctx2d === null) throw new Error('main: 2d コンテキストが取れない');

  // ---------------------------------------------------------------- 試合を作る
  const { world } = createMatch({
    seed: 20260809,
    playerCount: 2,
    civs: CIVS,
    mapType: 'plain',
  });
  const viewer: PlayerId = 0;

  // ---------------------------------------------------------------- 描画
  const renderer = new Renderer(ctx2d, world, new PlaceholderSpriteProvider());
  const cam = new CameraController(renderer.cam, world.map.widthTiles, world.map.heightTiles);
  // 自拠点を最初に映す
  cam.cam.cx = world.map.starts[viewer * 2]! / FX_ONE;
  cam.cam.cy = world.map.starts[viewer * 2 + 1]! / FX_ONE;

  // ---------------------------------------------------------------- 入力
  const selection = new Selection();
  /** この tick に発行された Command（発行順）。 */
  let pending: Command[] = [];
  /** 建設の「置くモード」（クリックで位置を決める）。 */
  let placing: string | null = null;

  const vision = (): VisibilityQuery => renderer.vision;
  const inputCtx: InputContext = {
    world: () => world,
    viewer,
    cam,
    selection,
    vision,
    emit: (cmd: Command) => pending.push(cmd),
  };
  const mouse = new MouseInput(inputCtx);
  const keys = new KeyboardInput(inputCtx);

  // 「置くモード」中の左クリックは建設に使う（`placeBuilding` は位置が必要）
  mouse.onGroundClick = (tileX, tileY): boolean => {
    if (placing === null) return false;
    pending.push({
      t: 'placeBuilding',
      p: viewer,
      type: placing,
      x: tileToFx(tileX),
      y: tileToFx(tileY),
      villagers: [...selection.list()].slice(0, 8),
    });
    placing = null;
    canvas.style.outline = '';
    return true;
  };

  mouse.attach(canvas);
  keys.attach(window);

  // ---------------------------------------------------------------- HUD
  const hudCtx: HudContext = {
    world: () => world,
    viewer,
    selection,
    cam,
    vision: () => renderer.vision,
    emit: (cmd: Command) => pending.push(cmd),
    selectFront: (slot: number) => {
      keys.selectFront(slot, true);
    },
    toggleOverview: () => {
      // 戦域指令ビューは M12（`T-M12-06`）。今は入口だけ用意しておく。
    },
    beginPlacement: (buildingId: string) => {
      placing = buildingId;
      canvas.style.outline = '2px solid #e0b34a';
    },
    debugText: () =>
      `tick ${world.tick} / ${perf.fps.toFixed(0)}fps / ` +
      `描画 ${renderer.last.ms.toFixed(1)}ms / シム ${perf.simMs.toFixed(1)}ms / ` +
      `フレーム ${perf.frameMs.toFixed(1)}ms / ` +
      `表示 ${renderer.last.sprites.drawn} 体 / タイル ${renderer.last.terrain.tiles} / zoom ${cam.cam.zoom}` +
      ` / 地形 ${renderer.last.layers.terrain.toFixed(1)} 霧 ${renderer.last.layers.fog.toFixed(1)} ` +
      `兵 ${renderer.last.layers.sprites.toFixed(1)} 戦域 ${renderer.last.layers.fronts.toFixed(1)} ` +
      `既知 ${renderer.last.layers.remembered.toFixed(1)} 消去 ${renderer.last.layers.clear.toFixed(1)}` +
      (placing !== null ? ` / 建設: ${placing}（地面をクリック）` : ''),
  };
  const hud = new Hud(overlay, hudCtx);

  // コマンドグリッドのキー（QWER/ASDF/ZXCV は並びと一対一。`05§9`）
  window.addEventListener('keydown', (ev: KeyboardEvent) => {
    if (ev.ctrlKey || ev.metaKey || ev.altKey || ev.shiftKey) return;
    if (hud.pressGridKey(ev.key)) ev.preventDefault();
  });

  // ---------------------------------------------------------------- 画面サイズ
  const resize = (): void => {
    const dpr = window.devicePixelRatio || 1;
    const w = window.innerWidth;
    const h = window.innerHeight;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    // 論理座標を CSS px に揃える（各レイヤは px で計算する）
    ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    renderer.resize(w, h);
  };
  resize();
  window.addEventListener('resize', resize);

  if (boot !== null) boot.remove();

  // ---------------------------------------------------------------- ループ
  let acc = 0;
  let lastMs = performance.now();
  /** 直近フレームの実測（描画とシムを分けて見る）。 */
  const perf = { frameMs: 0, simMs: 0, fps: 0 };
  let fpsCount = 0;
  let fpsSinceMs = lastMs;

  const frame = (nowMs: number): void => {
    const frameStart = performance.now();
    const dtMs = Math.min(250, nowMs - lastMs); // タブ復帰時の巨大な dt を切る
    lastMs = nowMs;

    // 視点（矢印キー / 画面端）
    cam.update(
      dtMs,
      keys.scrollKeys,
      mouse.pointerInside ? { x: mouse.pointerX, y: mouse.pointerY, inside: true } : null,
    );

    // シム: 25 tick/秒。1 フレームで進めるのは最大 5 tick
    acc += dtMs * SPEED_MUL;
    const simStart = performance.now();
    let steps = 0;
    while (acc >= TICK_MS && steps < MAX_STEPS_PER_FRAME) {
      renderer.beforeStep(world);
      // この tick の入力（1 人操作なので playerId 昇順は自明。発行順を保つ）
      const cmds = pending;
      pending = [];
      stepWorld(world, cmds);
      acc -= TICK_MS;
      steps++;
    }
    perf.simMs = performance.now() - simStart;

    // 視界は 5 tick ごと（T-M5-05）
    renderer.updateVision(world, viewer);
    selection.prune(world);

    renderer.draw(
      {
        world,
        viewer,
        alpha: acc / TICK_MS,
        selected: selection.asSet(),
        dragRect: mouse.dragRect(),
      },
      nowMs,
    );
    hud.update(nowMs);

    perf.frameMs = performance.now() - frameStart;
    fpsCount++;
    if (nowMs - fpsSinceMs >= 500) {
      perf.fps = (fpsCount * 1000) / (nowMs - fpsSinceMs);
      fpsCount = 0;
      fpsSinceMs = nowMs;
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

main();
