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
// 各パネル・画面は自分専用の CSS を持つ（並行実装で `hud.css` が競合しないようにした結果）。
import '@/styles/panels.css';
import '@/styles/frontCommand.css';
import '@/styles/screens.css';
import '@/styles/result.css';

import type { CivId, MapTypeId, PlayerId } from '@/shared/types';
import type { Command } from '@/sim/command';
import { TICK_MS, createMatch, stepWorld } from '@/sim';
import { FX_ONE } from '@/sim/core/fx';
import { EntityKind } from '@/shared/types';
import { spawnEntity } from '@/sim/core/entity';
import { unitDefById } from '@/sim/core/defs';
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
import { FrontCommandView } from '@/ui/hud/frontCommandView';
import { OrderCards } from '@/ui/hud/orderCards';
import { WarningSystem } from '@/ui/hud/warnings';
import { TechPanel } from '@/ui/hud/techPanel';
import { MarketPanel } from '@/ui/hud/marketPanel';
import { InfoPanels } from '@/ui/hud/infoPanels';
import { ProductionPanel } from '@/ui/hud/commandGrid';
import { MatchStats } from '@/ui/stats';
import { ScreenRouter, type Screen, type ScreenParams } from '@/ui/screens/router';
import { registerScreens } from '@/ui/screens/register';

/** 1 フレームで進める tick の上限（手順書 §4.1）。 */
const MAX_STEPS_PER_FRAME = 5;

/** ゲーム速度（0.5〜1.5。`07§14`。tick レートは変えない）。 */
const SPEED_MUL = 1;

/** M5 の通し確認で使う対戦カード。 */
const CIVS: readonly CivId[] = ['yamato', 'mongol'];

/**
 * 負荷試験用にユニットを撒く（`?stress=400`）。
 *
 * 完了条件が「400 体で 60fps」なので、**実機で数えられる入口**が必要。
 * 兵を両軍に半分ずつ、拠点の周りに格子状に置く。
 * sim の状態を直接触るのは通常なら層違反だが、これは試合前の初期配置と同じ扱い
 * （`createMatch` がやっていることと同じ）で、tick が進む前に 1 回だけ行う。
 */
function stressSpawn(world: ReturnType<typeof createMatch>['world'], raw: string | null): void {
  if (raw === null) return;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return;
  const ids = ['y-nagae', 'g-heavy'] as const;
  for (let k = 0; k < n; k++) {
    const owner = (k % 2) as PlayerId;
    const def = unitDefById(ids[owner]!);
    const side = Math.ceil(Math.sqrt(n));
    const ox = (k % side) - side / 2;
    const oy = Math.floor(k / side) - side / 2;
    spawnEntity(world.entities, {
      kind: EntityKind.Unit,
      owner,
      typeId: def.index,
      x: world.map.starts[0]! + Math.round(ox * FX_ONE),
      y: world.map.starts[1]! + Math.round(oy * FX_ONE),
      hpMax: def.hp,
      morale: FX_ONE,
    });
  }
}

/**
 * 対戦画面（`05§6`）。**13 画面のうち唯一「常に表示されている」画面**で、
 * 他のパネルはこの上に重なるオーバーレイ（`ui/hud/*`）。
 *
 * ここが `stepWorld` を回す唯一の場所。ルータの `frame` から毎フレーム呼ばれる。
 */
function createMatchScreen(): Screen {
  let stop: (() => void) | null = null;
  let onFrame: ((nowMs: number) => void) | null = null;
  return {
    mount(root, _nav, params) {
      const r = startMatch(root, params);
      stop = r.stop;
      onFrame = r.frame;
    },
    unmount() {
      stop?.();
      stop = null;
      onFrame = null;
    },
    frame(nowMs) {
      onFrame?.(nowMs);
    },
  };
}

/** 対戦画面の起動。戻り値でフレーム処理と後片付けを返す。 */
function startMatch(
  overlay: HTMLElement,
  params: ScreenParams,
): { frame: (nowMs: number) => void; stop: () => void } {
  const canvas = document.getElementById('field') as HTMLCanvasElement | null;
  const boot = document.getElementById('boot');
  if (canvas === null) {
    throw new Error('main: #field が見つからない');
  }
  const ctx2d = canvas.getContext('2d');
  if (ctx2d === null) throw new Error('main: 2d コンテキストが取れない');

  // ---------------------------------------------------------------- 試合を作る
  const { world } = createMatch({
    seed: typeof params['seed'] === 'number' ? params['seed'] : DEFAULT_SEED,
    playerCount: typeof params['playerCount'] === 'number' ? params['playerCount'] : 2,
    civs: Array.isArray(params['civs']) ? (params['civs'] as CivId[]) : [...CIVS],
    mapType: typeof params['mapType'] === 'string' ? (params['mapType'] as MapTypeId) : 'plain',
  });
  const viewer: PlayerId = 0;

  // 負荷試験: `?stress=400` で兵を N 体足す（手順書 §1.2「400 体 60fps」の実測用）。
  // 描画の予算はユニット数で決まるので、実機で数えられる入口を用意しておく。
  stressSpawn(world, new URLSearchParams(location.search).get('stress'));

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

  // `attach` は購読解除の関数を返す（画面を離れるときに呼ぶ）。
  const detachMouse = mouse.attach(canvas);
  const detachKeys = keys.attach(window);

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
      // `Tab` と同じ動作（`06§1`）。キーを使わない運用のための入口（`06§12`）。
      frontView.toggle();
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

  // ---------------------------------------------------------------- 試合中のパネル群（M12）
  //
  // **どのパネルを開いても試合は止まらない**（`05§1`）。
  // だからパネルは画面（Screen）ではなく HUD の上に重なるオーバーレイとして持つ。
  // ループは対戦画面が回し続け、パネルは `update` されるだけ。

  /** 統計の収集（結果画面の材料）。sim には列を足さず、UI 側で毎 tick 観測する。 */
  const stats = new MatchStats(world.playerCount);

  /** 令カードパネルで選んでいる戦域スロット（0 = 未選択）。 */
  let selectedFrontSlot = 0;

  /** `Alt` の情報表示をトグルにするか（`06§12` の「長押しを使わない設定」）。 */
  const altToggleMode = (): boolean => {
    try {
      return window.localStorage.getItem('multi-taktika.altToggle') === '1';
    } catch {
      return false;
    }
  };

  const jumpTo = (tileX: number, tileY: number): void => {
    cam.cam.cx = tileX;
    cam.cam.cy = tileY;
  };

  const orderCards = new OrderCards(overlay, {
    world: () => world,
    viewer,
    emit: (cmd: Command) => pending.push(cmd),
    selectedFront: () => selectedFrontSlot,
    selectFront: (slot: number) => {
      selectedFrontSlot = slot;
      keys.selectFront(slot, true);
    },
  });

  const frontView = new FrontCommandView(overlay, {
    world: () => world,
    viewer,
    vision: () => renderer.vision,
    emit: (cmd: Command) => pending.push(cmd),
    selectFront: (slot: number) => {
      selectedFrontSlot = slot;
      keys.selectFront(slot, false);
    },
    selectedFront: () => selectedFrontSlot,
    jumpTo,
    openOrderCards: (slot: number) => {
      selectedFrontSlot = slot;
      orderCards.toggle(slot);
    },
  });

  const warnings = new WarningSystem(overlay, {
    world: () => world,
    viewer,
    jumpTo,
    selectFront: (slot: number) => {
      selectedFrontSlot = slot;
      keys.selectFront(slot, true);
    },
  });

  const techPanel = new TechPanel(overlay, {
    world: () => world,
    viewer,
    emit: (cmd: Command) => pending.push(cmd),
  });

  const marketPanel = new MarketPanel(overlay, {
    world: () => world,
    viewer,
    emit: (cmd: Command) => pending.push(cmd),
    isVisible: (xFx: number, yFx: number) =>
      renderer.vision.isVisible(Math.floor(xFx / FX_ONE), Math.floor(yFx / FX_ONE)),
  });

  const infoPanels = new InfoPanels(overlay, {
    world: () => world,
    viewer,
    vision: () => renderer.vision,
    camera: () => cam.cam,
    stats: () => stats.snapshot(),
    altToggleMode,
  });

  const production = new ProductionPanel(overlay, {
    world: () => world,
    viewer,
    selected: () => [...selection.list()],
    emit: (cmd: Command) => pending.push(cmd),
    beginPlacement: (buildingId: string) => {
      placing = buildingId;
      canvas.style.outline = '2px solid #e0b34a';
    },
  });

  // `Tab` = 戦域指令ビューの開閉（`06§1` の最小操作セット）
  keys.onToggleOverview = () => {
    frontView.toggle();
  };

  /**
   * パネルのキー（`06§14` の全キー一覧）。
   *
   * **capture 段で先に拾う。** `KeyboardInput` は通常段で購読しているので、
   * ここで拾ったキーは後段へ流さない（`Esc` の「上から 1 つだけ実行」を壊さないため）。
   */
  const onPanelKey = (ev: KeyboardEvent): void => {
    if (ev.ctrlKey || ev.metaKey) return;
    const k = ev.key;

    // `Esc` は上から 1 つだけ（`06§11`）: ①開いているパネルを閉じる が最優先。
    if (k === 'Escape') {
      if (infoPanels.closeTop()) return stopKey(ev);
      if (orderCards.isOpen()) {
        orderCards.close();
        return stopKey(ev);
      }
      if (techPanel.visible) {
        techPanel.close();
        return stopKey(ev);
      }
      if (marketPanel.visible) {
        marketPanel.close();
        return stopKey(ev);
      }
      if (frontView.isOpen()) {
        frontView.close();
        return stopKey(ev);
      }
      return; // 閉じるものが無ければ後段（手動解除 → 選択解除 → メニュー）へ
    }

    if (!ev.shiftKey && !ev.altKey) {
      if (k === 'k' || k === 'K') {
        techPanel.toggle();
        return stopKey(ev);
      }
      if (k === 't' || k === 'T') {
        marketPanel.toggle();
        return stopKey(ev);
      }
    }

    // 情報パネル（`L` 戦績 / `G` 残量 / `N` 進化条件 / `Y` 令の履歴 / `Alt`）
    if (infoPanels.onKeyDown(k, { shift: ev.shiftKey, ctrl: ev.ctrlKey, alt: ev.altKey })) {
      return stopKey(ev);
    }

    // 令カードは戦域を選んでいるときだけ数字で選べる（`06§4`。`Shift`+数字は keys.ts が拾う）
    if (orderCards.isOpen() && !ev.shiftKey && !ev.altKey) {
      const n = Number(k);
      if (Number.isInteger(n) && n >= 1 && n <= 7 && orderCards.pressKey(n)) return stopKey(ev);
    }

    // コマンドグリッド（QWER/ASDF/ZXCV は並びと一対一。`05§9`）
    if (!ev.shiftKey && !ev.altKey && production.pressKey(k)) return stopKey(ev);
    if (!ev.shiftKey && !ev.altKey && hud.pressGridKey(k)) return stopKey(ev);
  };
  window.addEventListener('keydown', onPanelKey, true);

  const onPanelKeyUp = (ev: KeyboardEvent): void => {
    infoPanels.onKeyUp(ev.key);
  };
  window.addEventListener('keyup', onPanelKeyUp, true);

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

  let running = true;
  const frame = (nowMs: number): void => {
    if (!running) return;
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
      // **統計は毎 tick 観測する**（飛ばすと撃破を取り逃がす。結果画面の材料）。
      stats.sample(world);
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
    // パネルは「開いていても試合は止まらない」（`05§1`）。毎フレーム更新するだけ。
    frontView.update(nowMs);
    orderCards.update(nowMs);
    warnings.update(nowMs);
    techPanel.update();
    // 市場は**閉じていても相場の標本を取る**（開いた瞬間にグラフが空だと
    // 「相手の行動を読む」が成立しない）。
    marketPanel.update(nowMs);
    infoPanels.frame(nowMs);
    production.update();

    perf.frameMs = performance.now() - frameStart;
    fpsCount++;
    if (nowMs - fpsSinceMs >= 500) {
      perf.fps = (fpsCount * 1000) / (nowMs - fpsSinceMs);
      fpsCount = 0;
      fpsSinceMs = nowMs;
    }
  };

  return {
    frame,
    stop: () => {
      running = false;
      window.removeEventListener('resize', resize);
      window.removeEventListener('keydown', onPanelKey, true);
      window.removeEventListener('keyup', onPanelKeyUp, true);
      detachMouse();
      detachKeys();
      frontView.destroy();
      orderCards.destroy();
      warnings.destroy();
      techPanel.destroy();
      marketPanel.destroy();
      infoPanels.destroy();
      production.destroy();
    },
  };
}

/** キーを後段へ流さない（capture 段で処理済みにする）。 */
function stopKey(ev: KeyboardEvent): void {
  ev.preventDefault();
  ev.stopPropagation();
}

/** 既定のシード（`?seed=` で上書き）。 */
const DEFAULT_SEED = 20260809;

function main(): void {
  const overlay = document.getElementById('overlay');
  if (overlay === null) throw new Error('main: #overlay が見つからない');

  const router = new ScreenRouter(overlay);
  router.register('match', createMatchScreen());
  registerScreens(router);

  // 起動先: 既定はタイトル（`05§1` の遷移）。
  // `?dev=match` で対戦画面へ直接入る（開発中の確認用。M5 の通し確認がこれ）。
  const q = new URLSearchParams(location.search);
  const dev = q.get('dev');
  const seedRaw = q.get('seed');
  const seed = seedRaw === null ? DEFAULT_SEED : Number.parseInt(seedRaw, 10);
  const startAt = dev === 'match' || !router.has('title') ? 'match' : 'title';
  router.go(startAt, { seed: Number.isFinite(seed) ? seed : DEFAULT_SEED });

  const loop = (nowMs: number): void => {
    router.frame(nowMs);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

main();
