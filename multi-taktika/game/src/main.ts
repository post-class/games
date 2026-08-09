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
// 通信（M14）の表示。デシンクの停止パネルと入力待ちの帯だけを持つ。
import '@/styles/net.css';
import '@/styles/gameMenu.css';

import type { CivId, MapTypeId, PlayerId } from '@/shared/types';
import type { Command } from '@/sim/command';
import { TICK_MS, createMatch, stepWorld } from '@/sim';
import { FX_ONE } from '@/sim/core/fx';
import { EntityKind } from '@/shared/types';
import { spawnEntity } from '@/sim/core/entity';
import { unitDefById } from '@/sim/core/defs';
import { Renderer } from '@/render/Renderer';
import { FallbackSpriteProvider } from '@/render/placeholder';
import { AtlasSpriteProvider, loadAtlas } from '@/render/atlas';
import { loadTerrainTextures } from '@/render/terrainTextures';
import { WebAudioSink, sfx } from '@/audio/sfx';
import { ReplayRecorder } from '@/replay/format';
import { dataHash } from '@/data/hash';
import {
  createMissionRun,
  loadProgress,
  missionById,
  recordOutcome,
  saveProgress,
} from '@/campaign';
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
import { ScreenRouter, el, type Screen, type ScreenNav, type ScreenParams } from '@/ui/screens/router';
import { registerScreens } from '@/ui/screens/register';
import { DesyncOverlay } from '@/ui/hud/desync';
import { MissionPanel } from '@/ui/hud/missionPanel';
import { GameMenu } from '@/ui/hud/gameMenu';
import { type NetplaySession, joinMatch, roomFromLocation } from '@/net';

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
    mount(root, nav, params) {
      // ---- オンライン対戦（T-M14-02）。`#room=` が付いていたら中継サーバへ ----
      //
      // **World は `start` が来てから作る。** 先に作ってしまうと自分の playerId が
      // 分からず、視点が常に P0 になる（`welcome` で初めて席が決まる）。
      const room = onlineRoom(params);
      if (room !== null) {
        const banner = document.createElement('div');
        banner.className = 'mt-net-wait';
        banner.textContent = '中継サーバへ接続中…';
        root.appendChild(banner);
        const session: NetplaySession = joinMatch({
          room,
          name: localPlayerName(),
          onStatus: (text) => {
            banner.textContent = text;
          },
          onReady: (info) => {
            banner.remove();
            const started = startMatch(root, {
              ...params,
              // シードはサーバが決めた値を使う（部屋の主に引き直させない）
              seed: info.seed,
              playerCount: Math.max(2, info.playerIds.length),
              viewer: info.playerId,
              netplay: session,
            }, nav);
            stop = () => {
              started.stop();
              session.stop();
            };
            onFrame = started.frame;
          },
        });
        // 接続中に画面を離れたときも線を切る
        stop = () => session.stop();
        return;
      }

      const r = startMatch(root, params, nav);
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
  /** 画面遷移の口。決着したら結果画面へ移るのに使う（無ければ移らない）。 */
  nav?: ScreenNav,
): { frame: (nowMs: number) => void; stop: () => void } {
  const canvas = document.getElementById('field') as HTMLCanvasElement | null;
  const boot = document.getElementById('boot');
  if (canvas === null) {
    throw new Error('main: #field が見つからない');
  }
  const ctx2d = canvas.getContext('2d');
  if (ctx2d === null) throw new Error('main: 2d コンテキストが取れない');

  // ---------------------------------------------------------------- 試合を作る
  //
  // キャンペーン（`missionId` が来ているとき）は `createMissionRun` が
  // 初期配置・勝敗条件・スクリプトイベントを持つ。**ここが唯一の分岐**で、
  // 以降のループはミッションでもスカーミッシュでも同じ形になる
  // （`advance()` がどちらを回すかだけを吸収する）。
  const missionId = typeof params['missionId'] === 'string' ? params['missionId'] : null;
  const mission = missionId === null ? null : (missionById(missionId) ?? null);
  const run = mission === null ? null : createMissionRun(mission);
  const world =
    run !== null
      ? run.world
      : createMatch({
          seed: typeof params['seed'] === 'number' ? params['seed'] : DEFAULT_SEED,
          playerCount: typeof params['playerCount'] === 'number' ? params['playerCount'] : 2,
          civs: Array.isArray(params['civs']) ? (params['civs'] as CivId[]) : [...CIVS],
          mapType: typeof params['mapType'] === 'string' ? (params['mapType'] as MapTypeId) : 'plain',
        }).world;
  // 視点は自分の席（キャンペーンはミッションが決める。オンラインでは `welcome.playerId`）。
  const viewer: PlayerId =
    run !== null
      ? run.self
      : typeof params['viewer'] === 'number'
        ? (params['viewer'] as PlayerId)
        : 0;
  /** オンライン対戦の口（null = 単独プレイ。手順書 §11） */
  const netplay: NetplaySession | null = isNetplay(params['netplay']) ? params['netplay'] : null;

  // ---------------------------------------------------------------- リプレイの記録
  //
  // **記録するのは入力だけ**（`07§12`）。映像も座標も保存しない。
  // 同じシード・同じデータ・同じ入力列なら同じ試合が再生できる、という
  // 決定論そのものが記録形式になっている。
  //
  // `dataHash()` を一緒に持たせるのが要点 ―― データを変えたあとに古い記録を
  // 再生すると**別の試合が始まってしまう**ので、`checkReplay` が拒否できるようにする。
  /** 結果画面へ移ったか（決着は 1 回しか通知しない）。 */
  let finished = false;

  const recorder = new ReplayRecorder(
    typeof params['seed'] === 'number' ? params['seed'] : DEFAULT_SEED,
    {
      playerCount: world.playerCount,
      civs: world.players.map((p) => p.civ),
      // `world.map.mapType` は添字（数値）なので、記録には ID 文字列を入れる
      // （データの並びが変わっても再生できるように。`replay/format.ts` の約束）。
      mapType: typeof params['mapType'] === 'string' ? (params['mapType'] as MapTypeId) : 'plain',
    },
    dataHash(),
  );

  // ミッションの目標とヒント（キャンペーンのときだけ出る）。
  const missionPanel = mission === null ? null : new MissionPanel(overlay, mission);

  // 試合中のメニュー（`06§11` の F10 = 設定・投了・退出 / Pause = 一時停止）。
  // **投了 = 服属**（`03§10` の勝敗 3 通りのうちの 1 つ）なので、
  // これが無いと負け方が 1 つ足りず、キャンペーンの服属ルートにも入れない。
  const pausedBand = el('div', 'mt-paused-band');
  pausedBand.textContent = '一時停止中 — Pause で再開';
  pausedBand.hidden = true;
  overlay.appendChild(pausedBand);
  const gameMenu = new GameMenu(overlay, {
    viewer,
    emit: (cmd: Command) => pending.push(cmd),
    openSettings: () => nav?.go('settings'),
    leave: () => nav?.go('title'),
    // オンラインでは一時停止を無効にする（1 人が止めると全員が止まる）
    isOnline: () => netplay !== null,
  });

  // 負荷試験: `?stress=400` で兵を N 体足す（手順書 §1.2「400 体 60fps」の実測用）。
  // 描画の予算はユニット数で決まるので、実機で数えられる入口を用意しておく。
  stressSpawn(world, new URLSearchParams(location.search).get('stress'));

  // ---------------------------------------------------------------- 描画
  // アセット（`public/assets/atlas.webp`）は**あれば使う**。
  // 読み込みを待たない ―― 無い / 失敗したあいだは `FallbackSpriteProvider` が
  // プレースホルダ図形に落とすので、アセット 0 枚でも試合は始められる。
  const atlas = new AtlasSpriteProvider();
  void loadAtlas(atlas);
  const renderer = new Renderer(ctx2d, world, new FallbackSpriteProvider(atlas));
  // 地形の模様も同じ扱い（無ければ `TILE_COLORS` の単色で塗る）。
  // 読めた時点で地形キャッシュが自分から焼き直す。
  void loadTerrainTextures(renderer.terrainTextures);
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
      (placing !== null ? ` / 建設: ${placing}（地面をクリック）` : '') +
      (netplay !== null ? ` / 通信 ${netplay.statusText(world.tick)}` : ''),
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
  // 警告音（M17）。音源が無ければ何も起きない（`audio/sfx.ts` の設計どおり）。
  // 時計は描画側の `performance.now()` を渡す ―― 音の間引きは端末ごとの体感の話で、
  // 試合の状態ではないので tick を使わない（使うと倍速で間引きが変わる）。
  const audioSink = new WebAudioSink();
  sfx.attach(audioSink);
  void sfx.preloadAll();
  warnings.onSound = () => sfx.play('warning', performance.now());
  // 利用者が最初に触った時点で音を出せるようにする（ブラウザの自動再生制限）。
  const unlockAudio = (): void => audioSink.unlock();
  window.addEventListener('keydown', unlockAudio, { once: true });
  window.addEventListener('pointerdown', unlockAudio, { once: true });

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

    // `F10` / `Pause` は最優先（メニューが開いていれば `Esc` もここで拾う）。
    if (gameMenu.handleKey(k)) return stopKey(ev);

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

  // ---------------------------------------------------------------- 通信の表示（M14）
  //
  // デシンクは**即座に出して試合を止める**（手順書 §4.5）。入力待ちは細い帯だけ出す
  // （待っている間も描画は続くので、何も出さないと不具合と区別できない）。
  const desyncView = new DesyncOverlay(overlay);
  const waitBand = document.createElement('div');
  waitBand.className = 'mt-net-wait';
  waitBand.hidden = true;
  if (netplay !== null) overlay.appendChild(waitBand);

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

    // オンラインでは入力を**送るだけ**にする（自分の分もサーバから戻ってきてから効く）。
    // ここで `pending` を先に適用してしまうと、自分の端末だけ 1 手先に進んでデシンクする。
    if (netplay !== null && pending.length > 0) {
      for (const cmd of pending) netplay.emit(cmd);
      pending = [];
    }

    // シム: 25 tick/秒。1 フレームで進めるのは最大 5 tick
    // 一時停止中は時間を溜めない（解除した瞬間に早送りしないため）。
    // **World には何も書かない** ―― 「止まっている」を World に持たせると
    // hash に入れる必要が出てデシンクの種になる。
    pausedBand.hidden = !gameMenu.isPaused();
    if (gameMenu.isPaused()) acc = 0;
    else acc += dtMs * SPEED_MUL;
    const simStart = performance.now();
    let steps = 0;
    /** 入力が揃わずに待ったか（`07§12`「誰かの回線が遅いと全員が同じだけ待つ」）。 */
    let waiting = false;
    while (acc >= TICK_MS && steps < MAX_STEPS_PER_FRAME) {
      renderer.beforeStep(world);
      if (netplay !== null) {
        // 揃った tick だけ進む。揃っていなければ**待つ**（描画はこの後も続ける）。
        if (netplay.step(world) !== 'stepped') {
          waiting = true;
          break;
        }
      } else {
        // この tick の入力（1 人操作なので playerId 昇順は自明。発行順を保つ）
        const cmds = pending;
        pending = [];
        // **記録は進める前に取る**（進めたあとだと tick 番号が 1 つずれる）。
        // 空の tick は `record` が自分で捨てるので、ここで分岐しなくてよい。
        recorder.record(world.tick, { [viewer]: cmds });
        // キャンペーンは `run.step` が「プレイヤーの入力 → スクリプトの入力」の順で
        // `stepWorld` を呼ぶ。**順序が結果を決める**のでミッション側に任せる。
        if (run !== null) run.step(cmds);
        else stepWorld(world, cmds);
      }
      // **統計は毎 tick 観測する**（飛ばすと撃破を取り逃がす。結果画面の材料）。
      stats.sample(world);
      acc -= TICK_MS;
      steps++;
    }
    // 待っている間に acc を溜め込まない（復帰した瞬間の早送りを防ぐ）。
    if (waiting) acc = Math.min(acc, TICK_MS);
    perf.simMs = performance.now() - simStart;

    if (netplay !== null) {
      const info = netplay.desync;
      if (info !== null) desyncView.show(info, { localPlayerId: viewer });
      waitBand.hidden = !waiting || info !== null;
      if (waiting) waitBand.textContent = '入力待ち — 全員の入力が揃うまで進みません';
    }

    // 視界は 5 tick ごと（T-M5-05）
    renderer.updateVision(world, viewer);
    selection.prune(world);

    renderer.draw(
      {
        world,
        viewer,
        // 待っている間は補間を進めない（進めると兵が滑って「動いている」ように見える）
        alpha: waiting ? 0 : acc / TICK_MS,
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
    if (run !== null && missionPanel !== null) {
      missionPanel.update(run.objectives(), run.hints());
    }

    // ---- 決着したら結果画面へ（`03§10` / `05§13`）----
    //
    // **1 回だけ**遷移する（`gameOver` は立ったままなので、印を持たないと
    // 毎フレーム `nav.go` を呼んでしまう）。
    // キャンペーンは**ミッションの条件**で決まる（`world.gameOver` だけでは足りない ――
    // 「500 集める」のような勝ち方があるので）。
    const outcome = run !== null ? run.outcome() : world.gameOver ? 'over' : 'running';
    if (outcome !== 'running' && !finished) {
      finished = true;
      if (run !== null && missionId !== null && outcome !== 'over') {
        // **負けてもゲームオーバーにしない**（`02`「この世界に滅亡はない」）。
        // `recordOutcome` が次の行き先（服属ルート）を決めるので、ここは記録するだけ。
        saveProgress(recordOutcome(loadProgress(), missionId, outcome, world.tick));
      }
      nav?.go('result', {
        world,
        stats: stats.snapshot(),
        // リプレイ画面へ渡すのは**記録だけ**。結果画面はそれをそのまま素通しする。
        replayParams: { replay: recorder.finish() },
        ...(run !== null ? { campaign: true, missionId, outcome } : {}),
      });
    }

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
      desyncView.destroy();
      missionPanel?.destroy();
      gameMenu.destroy();
      pausedBand.remove();
      waitBand.remove();
    },
  };
}

// ---------------------------------------------------------------------------
// オンライン対戦の入口（M14）
// ---------------------------------------------------------------------------

/**
 * オンライン対戦の部屋 ID（null = 単独プレイ）。
 *
 * 優先順は「画面から渡された `room`」→「URL の `#room=` / `?room=`」。
 * 共有 URL を作るのは `ui/screens/MatchSetup.ts`（`roomIdFromSeed`）。
 */
function onlineRoom(params: ScreenParams): string | null {
  const fromParams = params['room'];
  if (typeof fromParams === 'string' && fromParams !== '') return fromParams;
  return roomFromLocation({ hash: location.hash, search: location.search });
}

/**
 * 席の名前。**中継サーバは「同じ名前で戻ってきた席」を引き継ぐ**（120 秒保持）ので、
 * 再読み込みしても同じ名前になるよう端末に覚えさせる。
 * ここで `Math.random` を使うのは通信層なので構わない（`Command` には混ぜない）。
 */
function localPlayerName(): string {
  const key = 'multi-taktika.playerName';
  try {
    const saved = window.localStorage.getItem(key);
    if (saved !== null && saved !== '') return saved;
    const made = `P-${Math.random().toString(36).slice(2, 8)}`;
    window.localStorage.setItem(key, made);
    return made;
  } catch {
    return `P-${Math.random().toString(36).slice(2, 8)}`;
  }
}

/** `params.netplay` が通信の口かどうか（`ScreenParams` は `unknown` なので絞り込む）。 */
function isNetplay(v: unknown): v is NetplaySession {
  return typeof v === 'object' && v !== null && typeof (v as NetplaySession).step === 'function';
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
  //
  // `?dev=<画面 ID>` で**登録されている画面へ直接入れる**（`?dev=match` `?dev=settings` …）。
  // 13 画面の目視レビュー（T-M18-06）で毎回タイトルから辿るのは現実的でないので、
  // 入口を 1 つ用意しておく。登録されていない ID を渡したときはタイトルに落ちる
  // （黙って何も出ないより、遷移の起点が見えるほうがよい）。
  const q = new URLSearchParams(location.search);
  const dev = q.get('dev');
  const seedRaw = q.get('seed');
  const seed = seedRaw === null ? DEFAULT_SEED : Number.parseInt(seedRaw, 10);
  const startAt =
    dev !== null && router.has(dev as Parameters<typeof router.go>[0])
      ? (dev as Parameters<typeof router.go>[0])
      : router.has('title')
        ? 'title'
        : 'match';
  router.go(startAt, { seed: Number.isFinite(seed) ? seed : DEFAULT_SEED });

  const loop = (nowMs: number): void => {
    router.frame(nowMs);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

main();
