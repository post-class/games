/**
 * ui/screens/Replay.ts — リプレイ・観戦画面（T-M15-04, 05。`05§14` の 7 項目 / `06§10`）
 *
 * ■ この画面の主役は盤面ではない（`05§14`）
 * 「この画面の主役は盤面ではなく**下半分のタイムライン**で、
 *  『どこで判断を間違えたか』を戦域単位で振り返るために作っています」。
 * だから縦の割り付けは上 = 盤面、下 = タイムライン（下半分を占める）。
 *
 * ■ `05§14` の 7 項目とこのファイルの対応
 *   1 盤面           … `board()`。俯瞰（zoom 0.5）で再生。観戦・リプレイは**視界を全開放**し、
 *                       `Tab` で視点（= 戦域の色と輪の持ち主）を切り替える
 *   2 倍速スライダー … `speedRow()`。0.5〜8 倍。**`tickBudget` を増やすだけ**（`playback.ts`）
 *   3 戦域レーン     … `lanesBox()`。上から戦域 1〜6。区間の幅 = 立っていた時間
 *   4 令の変更点     … レーン上のカード。**クリックでその令を出した瞬間から再生**
 *   5 令が届いた時刻 … カードの少し右の薄い印（`markLayout().deliveredX`）
 *   6 再生ヘッド     … 全レーンを縦に貫く 1 本の線（`playhead`）
 *   7 再生コントロール… 再生／一時停止／前後の令へジャンプ
 *  最後の注記（1 本のレーンだけカードが何度も切り替わっている＝他を放置していた）は
 *  `laneFocusNote()` が文にして注記行に出す。
 *
 * ■ リプレイと観戦は同じ仕組み（`07§12` / T-M15-05）
 * どちらも「入力を受けて `stepWorld` を回すだけ」。違いは入力源（`InputSource`）だけで、
 * この画面は**入力を送る口を一切持たない**（`emit` が無い）。だから観戦者が何人増えても
 * 試合に影響しない。
 *
 * ■ 古いリプレイは拒否する（`checkReplay`）
 * データが変わっていたら**黙って別の試合を見せない**。理由（`describeReject`）を出して終わる。
 *
 * ■ テスト方針
 * 判定・配置・キー割当は DOM の外（`playback.ts` の純関数 + このファイルの
 * `replayKeyAction` / `readReplayParams` / `clockLabel` / `speedLabel` / `viewerLabel`）に
 * 出してある。`tests/unit/ui.replay.test.ts` はそこだけを見る（jsdom 不要）。
 */

import '@/styles/replay.css';

import type { CivId, PlayerId } from '@/shared/types';
import { EntityKind } from '@/shared/types';
import { TICK_RATE } from '@/sim/index';
import { CIV_DEFS, ORDER_DEFS, unitDefById } from '@/sim/core/defs';
import { FX_ONE, fxFromInt } from '@/sim/core/fx';
import { spawnEntity } from '@/sim/core/entity';
import { MAX_FRONTS, type World } from '@/sim/core/world';
import { createMatch } from '@/sim/setup';
import { Renderer } from '@/render/Renderer';
import { PlaceholderSpriteProvider } from '@/render/placeholder';
import { frontColor, frontShape, playerColor } from '@/render/palette';
import { dataHash } from '@/data/hash';
import {
  REPLAY_VERSION,
  checkReplay,
  describeReject,
  parseReplay,
  type Replay,
  type ReplaySetup,
} from '@/replay/format';
import {
  MAX_SPEED,
  MIN_SPEED,
  Playback,
  TimelineScan,
  busiestLane,
  jumpTargetTick,
  laneFocusNote,
  markLayout,
  quantizeSpeed,
  replaySource,
  shiftTargetTick,
  spanLayout,
  stepSpeed,
  tickToX,
  viewerAfterTab,
  xToTick,
  type InputSource,
  type Timeline,
  type TimelineBox,
} from '@/replay/playback';
import { tickToClock } from '../stats';
import { el, button, type Screen, type ScreenNav, type ScreenParams } from './router';

// ---------------------------------------------------------------------------
// 定数
// ---------------------------------------------------------------------------

/** レーン名の列幅（px）。再生ヘッドの左位置もこの値を足して決める。 */
export const LANE_NAME_WIDTH = 92;

/** 1 フレームでタイムライン走査に使う tick 数（見ながら埋まっていく速さ）。 */
const SCAN_TICKS_PER_FRAME = 400;

/** 俯瞰の zoom（`ZOOM_LEVELS` の最小 = いちばん引いた視点）。 */
const OVERVIEW_ZOOM = 0.5;

// ---------------------------------------------------------------------------
// 1. 引数（純関数）
// ---------------------------------------------------------------------------

/** リプレイ画面に渡す引数。 */
export interface ReplayParams {
  /** 再生する記録。 */
  readonly replay?: Replay;
  /** JSON 文字列で渡された記録（ファイルから読んだ場合）。 */
  readonly replayText?: string;
  /** 頭出しの tick（結果画面の「線が離れた瞬間」から来る）。 */
  readonly tick?: number;
  /** 観戦（入力が中継から届く）か。既定 false = リプレイ。 */
  readonly spectate?: boolean;
  /** 観戦の入力源（`net` 層が用意する。**この画面は受け取るだけ**）。 */
  readonly source?: InputSource;
  /** 最初の視点。 */
  readonly viewer?: number;
}

/**
 * `ScreenParams` から取り出す（型は実行時に確かめる）。
 * `replayText` は `parseReplay` を通す（壊れていたら `replay` は undefined）。
 */
export function readReplayParams(params: ScreenParams): ReplayParams {
  const p = params as ReplayParams;
  const fromText =
    p.replay === undefined && typeof p.replayText === 'string' ? parseReplay(p.replayText) : null;
  const replay = p.replay ?? fromText ?? undefined;
  return {
    ...(replay !== undefined ? { replay } : {}),
    ...(typeof p.tick === 'number' && Number.isFinite(p.tick) ? { tick: Math.max(0, p.tick) } : {}),
    ...(p.spectate === true ? { spectate: true } : {}),
    ...(p.source !== undefined ? { source: p.source } : {}),
    ...(typeof p.viewer === 'number' ? { viewer: Math.max(0, Math.floor(p.viewer)) } : {}),
  };
}

// ---------------------------------------------------------------------------
// 2. キー割当（`06§10`。試合中とキーの意味が変わる）
// ---------------------------------------------------------------------------

/** キーで起きること。 */
export type ReplayAction =
  | { readonly k: 'toggle' }
  | { readonly k: 'jumpOrder'; readonly dir: 1 | -1 }
  | { readonly k: 'shiftTime'; readonly dir: 1 | -1 }
  | { readonly k: 'lane'; readonly slot: number }
  | { readonly k: 'speed'; readonly dir: 1 | -1 }
  | { readonly k: 'viewer' };

/** 修飾キー。 */
export interface KeyMods {
  readonly shift: boolean;
  readonly ctrl: boolean;
  readonly alt: boolean;
}

/**
 * `06§10` の表をそのまま関数にしたもの。
 *
 *   `Space`            再生／一時停止（**試合中は「次の警告へ」だった**）
 *   `←` `→`            前後の「令を出した瞬間」へジャンプ
 *   `Shift`+`←` `→`    10 秒ずつ移動
 *   `1`〜`6`           その戦域レーンを追いかける
 *   `+` `-`            倍速
 *   `Tab`              プレイヤーの視界を切り替える（観戦時）
 *
 * `Ctrl` / `Alt` が付いているときは何もしない（ブラウザの操作を奪わない）。
 */
export function replayKeyAction(key: string, mods: KeyMods): ReplayAction | null {
  if (mods.ctrl || mods.alt) return null;
  switch (key) {
    case ' ':
    case 'Space':
    case 'Spacebar':
      return { k: 'toggle' };
    case 'ArrowRight':
      return mods.shift ? { k: 'shiftTime', dir: 1 } : { k: 'jumpOrder', dir: 1 };
    case 'ArrowLeft':
      return mods.shift ? { k: 'shiftTime', dir: -1 } : { k: 'jumpOrder', dir: -1 };
    case 'Tab':
      return { k: 'viewer' };
    case '+':
    case '=': // `+` は Shift+`=` の配列が多い
      return { k: 'speed', dir: 1 };
    case '-':
      return { k: 'speed', dir: -1 };
    default:
      break;
  }
  const n = Number(key);
  if (Number.isInteger(n) && n >= 1 && n <= MAX_FRONTS) return { k: 'lane', slot: n };
  return null;
}

// ---------------------------------------------------------------------------
// 3. 表示の文字（純関数）
// ---------------------------------------------------------------------------

/** `1:23 / 30:00` の形。 */
export function clockLabel(tick: number, endTick: number): string {
  return `${tickToClock(tick, TICK_RATE)} / ${tickToClock(endTick, TICK_RATE)}`;
}

/** `2.0 倍` の形（0.5 は `0.5 倍`）。 */
export function speedLabel(speed: number): string {
  const v = quantizeSpeed(speed);
  return `${v < 1 ? v.toFixed(1) : v.toFixed(v % 1 === 0 ? 0 : 1)} 倍`;
}

/** 視点の表示（`P1 ヤマト`）。 */
export function viewerLabel(viewer: number, civs: readonly CivId[]): string {
  const civ = civs[viewer];
  const name = civ === undefined ? '—' : (CIV_DEFS.find((c) => c.id === civ)?.name ?? civ);
  return `P${viewer + 1} ${name}`;
}

/** 令の表示名（`orders.json` の `name`）。 */
export function orderName(orderIndex: number): string {
  return ORDER_DEFS[orderIndex]?.name ?? '？';
}

/**
 * カードの説明（マウスを乗せたときに出る文）。
 * **出した時刻と届いた時刻のずれ**をここでも数字にする（目で見える印と併記）。
 */
export function markTitle(
  order: number,
  tier: string,
  issuedTick: number,
  deliveredTick: number,
): string {
  const head = `${orderName(order)}（${tier === 'lower' ? '下段' : '上段'}）`;
  const issued = `出した ${tickToClock(issuedTick, TICK_RATE)}`;
  if (deliveredTick < 0) return `${head} / ${issued} / 届く前に記録が終わった`;
  const sec = (deliveredTick - issuedTick) / TICK_RATE;
  return `${head} / ${issued} / 届いた ${tickToClock(deliveredTick, TICK_RATE)}（ずれ ${sec.toFixed(2)} 秒）`;
}

/** 走査の進捗（タイムラインがどこまで埋まったか）。 */
export function scanLabel(progress: number): string {
  if (progress >= 1) return 'タイムライン: 全区間';
  return `タイムライン解析中 ${Math.floor(progress * 100)}%`;
}

// ---------------------------------------------------------------------------
// 4. 画面
// ---------------------------------------------------------------------------

/** `Replay` の `setup` から `createMatch` の引数を作る。 */
function matchOptionsOf(replay: Replay): {
  seed: number;
  playerCount: number;
  civs: readonly CivId[];
  mapType: ReplaySetup['mapType'];
  teams?: readonly number[];
} {
  return {
    seed: replay.seed,
    playerCount: replay.setup.playerCount,
    civs: replay.setup.civs,
    mapType: replay.setup.mapType,
    ...(replay.setup.teams !== undefined ? { teams: replay.setup.teams } : {}),
  };
}

interface LaneDom {
  readonly row: HTMLElement;
  readonly track: HTMLElement;
}

export const replayScreen: Screen = {
  mount(root: HTMLElement, nav: ScreenNav, params: ScreenParams): void {
    const p = readReplayParams(params);
    const screen = el('div', 'mt-rp');

    // ---- ヘッダ（1 行 + 補足 1 行に留める。本体の領域を狭めない） ----
    const head = el('div', 'mt-rp-head');
    head.appendChild(el('span', 'mt-rp-title', p.spectate === true ? '観戦' : 'リプレイ'));
    head.appendChild(
      el('span', 'mt-rp-sub', '主役は下のタイムライン。戦域単位でどこで間違えたかを見る'),
    );
    const headRight = el('span', 'mt-rp-head-right');
    head.appendChild(headRight);
    screen.appendChild(head);

    // ---- 再生できない場合は理由を出して終わる（黙って別の試合を見せない） ----
    // `?dev=replay` のときだけ、記録が渡されていなければデモを組む（**開発中の目視確認用**。
    // 本来の入口は `main.ts` が試合中に `ReplayRecorder` で録った記録を渡すこと）。
    const demo = p.replay === undefined && isDevReplay();
    const replay = p.replay ?? (demo ? demoReplay() : undefined);
    if (demo) {
      head.appendChild(
        el('span', 'mt-rp-dim', 'デモ（開発用。main.ts が記録を渡すようになれば消せる）'),
      );
    }
    if (replay === undefined) {
      screen.appendChild(
        el(
          'div',
          'mt-rp-reject',
          'リプレイがありません（params.replay / params.replayText を渡してください）。',
        ),
      );
      headRight.appendChild(button('mt-rp-btn', '戻る', () => nav.back()));
      root.appendChild(screen);
      return;
    }
    const check = checkReplay(replay, dataHash());
    if (!check.ok) {
      const box = el('div', 'mt-rp-reject');
      box.appendChild(el('div', 'mt-rp-reject-head', 'このリプレイは再生できません'));
      box.appendChild(el('div', undefined, describeReject(check.reason)));
      box.appendChild(
        el(
          'div',
          'mt-rp-dim',
          '（黙って別の試合を再生すると振り返りの意味が無くなるため、拒否しています）',
        ),
      );
      screen.appendChild(box);
      headRight.appendChild(button('mt-rp-btn', '戻る', () => nav.back()));
      root.appendChild(screen);
      return;
    }

    // ---- 再生器（リプレイ・観戦の共通実装） ----
    // 以降は `rep`（**必ずある**記録）を使う。`replay` は上の guard を通った時点で
    // 確定しているが、下の関数群は巻き上げられるので TS の絞り込みが届かない。
    const rep: Replay = replay;
    const opts = matchOptionsOf(rep);
    const createWorld = (): World => {
      const w = createMatch(opts).world;
      if (demo) demoPrepare(w);
      return w;
    };
    const source = p.source ?? replaySource(rep);
    const playback = new Playback({
      createWorld,
      source,
      endTick: rep.endTick,
    });

    // ---- タイムラインの先読み走査（分割して進める） ----
    const scan = new TimelineScan({
      createWorld,
      createSource: () => (p.source !== undefined ? p.source : replaySource(rep)),
      endTick: rep.endTick,
      playerCount: rep.setup.playerCount,
    });
    let timeline: Timeline = scan.snapshot();

    let viewer: PlayerId = Math.min(
      rep.setup.playerCount - 1,
      p.viewer ?? 0,
    ) as PlayerId;
    /** 追いかけている戦域（0 = 追いかけない）。`1`〜`6`。 */
    let followSlot = 0;

    // ---- 盤面（俯瞰。視界は全開放） ----
    const canvas = document.getElementById('field') as HTMLCanvasElement | null;
    const ctx2d = canvas?.getContext('2d') ?? null;
    let renderer: Renderer | null = null;
    if (ctx2d !== null) {
      renderer = new Renderer(ctx2d, playback.w, new PlaceholderSpriteProvider());
      // `05§14-1`「観戦時は全プレイヤーの視界を見られます」。霧を開ける。
      renderer.vision.reveal(true);
      renderer.cam.zoom = OVERVIEW_ZOOM;
      renderer.cam.cx = playback.w.map.widthTiles / 2;
      renderer.cam.cy = playback.w.map.heightTiles / 2;
    }

    // ---- 再生コントロール（7） ----
    const controls = el('div', 'mt-rp-controls');
    const playBtn = button('mt-rp-btn is-primary', '▶ 再生', () => {
      playback.toggle();
      syncControls();
    });
    const prevBtn = button('mt-rp-btn', '|◀ 前の令', () => jumpOrder(-1));
    const nextBtn = button('mt-rp-btn', '次の令 ▶|', () => jumpOrder(1));
    const clock = el('span', 'mt-rp-clock', clockLabel(0, rep.endTick));
    controls.appendChild(prevBtn);
    controls.appendChild(playBtn);
    controls.appendChild(nextBtn);
    controls.appendChild(clock);

    // 倍速スライダー（2）
    const speedWrap = el('label', 'mt-rp-speed');
    speedWrap.appendChild(el('span', undefined, '倍速'));
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = String(MIN_SPEED);
    slider.max = String(MAX_SPEED);
    slider.step = '0.5';
    slider.value = '1';
    slider.className = 'mt-rp-range';
    const speedText = el('span', 'mt-rp-speed-val', speedLabel(1));
    slider.addEventListener('input', () => {
      playback.setSpeed(quantizeSpeed(Number(slider.value)));
      speedText.textContent = speedLabel(playback.speed);
    });
    speedWrap.appendChild(slider);
    speedWrap.appendChild(speedText);
    controls.appendChild(speedWrap);

    // 視点（観戦。`Tab`）
    const viewerBtn = button('mt-rp-btn', viewerLabel(viewer, rep.setup.civs), () => {
      switchViewer();
    });
    viewerBtn.title = 'Tab: プレイヤーの視界を切り替える（観戦時）';
    controls.appendChild(viewerBtn);
    const scanText = el('span', 'mt-rp-scan', scanLabel(0));
    controls.appendChild(scanText);

    headRight.appendChild(button('mt-rp-btn', '結果へ戻る', () => nav.back()));

    // ---- 盤面の領域（上半分。canvas は背後にあるので、ここは目印だけ） ----
    const board = el('div', 'mt-rp-board');
    const boardNote = el('div', 'mt-rp-board-note', '');
    board.appendChild(boardNote);
    screen.appendChild(board);

    // ---- タイムライン（下半分。ここが主役） ----
    const panel = el('div', 'mt-rp-panel');
    panel.appendChild(controls);

    const lanes = el('div', 'mt-rp-lanes');
    const laneDom: LaneDom[] = [];
    for (let slot = 1; slot <= MAX_FRONTS; slot++) {
      const row = el('div', 'mt-rp-lane');
      const name = el('span', 'mt-rp-lane-name');
      name.style.width = `${LANE_NAME_WIDTH}px`;
      name.style.color = frontColor(slot);
      name.textContent = `${frontShape(slot)} 戦域 ${slot}`;
      const track = el('div', 'mt-rp-track');
      track.style.left = `${LANE_NAME_WIDTH}px`;
      // レーンの空いている所をクリック = その時刻から再生（頭出し）
      track.addEventListener('click', (ev) => {
        const rect = track.getBoundingClientRect();
        const t = xToTick(ev.clientX - rect.left, rep.endTick, boxFor(rect.width));
        seek(t);
      });
      row.appendChild(name);
      row.appendChild(track);
      lanes.appendChild(row);
      laneDom.push({ row, track });
    }
    // 再生ヘッド（6）: 全レーンを縦に貫く 1 本
    const playhead = el('div', 'mt-rp-playhead');
    lanes.appendChild(playhead);
    panel.appendChild(lanes);

    const note = el('div', 'mt-rp-note', laneFocusNote([]));
    panel.appendChild(note);
    const help = el(
      'div',
      'mt-rp-help',
      'Space 再生／一時停止\u3000←→ 前後の令\u3000Shift+←→ 10 秒\u30001〜6 レーンを追う\u3000+ - 倍速\u3000Tab 視点',
    );
    panel.appendChild(help);
    screen.appendChild(panel);
    root.appendChild(screen);

    // ---- 頭出しの位置（結果画面の「線が離れた瞬間」から来る） ----
    if (p.tick !== undefined && p.tick > 0) playback.seek(p.tick);

    // ------------------------------------------------------------------ 動作

    function boxFor(width: number): TimelineBox {
      return { width, padLeft: 0, padRight: 0 };
    }

    function marksOfViewer(): Timeline['players'][number]['marks'] {
      return timeline.players[viewer]?.marks ?? [];
    }

    /**
     * レーンを描き直すかどうかの判定キー（前回の値）。
     *
     * **宣言はここに置く。** `resize()` と `switchViewer()` がこれを空にするが、
     * `resize()` は初回に即座に呼ばれるので、宣言が下にあると
     * 「初期化前の参照」で毎フレーム例外になり、盤面も走査も止まる。
     */
    let lastLaneKey = '';

    function seek(tick: number): void {
      playback.seek(tick);
      syncControls();
    }

    function jumpOrder(dir: 1 | -1): void {
      const marks = followSlot > 0
        ? marksOfViewer().filter((m) => m.slot === followSlot)
        : marksOfViewer();
      const t = jumpTargetTick(marks, playback.tick, dir);
      if (t < 0) return; // 端では何もしない
      seek(t);
    }

    function switchViewer(): void {
      viewer = viewerAfterTab(viewer, rep.setup.playerCount) as PlayerId;
      viewerBtn.textContent = viewerLabel(viewer, rep.setup.civs);
      lastLaneKey = ''; // レーンを描き直す
      syncControls();
    }

    function syncControls(): void {
      playBtn.textContent = playback.playing ? '⏸ 一時停止' : '▶ 再生';
      playBtn.classList.toggle('is-playing', playback.playing);
      clock.textContent = clockLabel(playback.tick, rep.endTick);
      const marks = marksOfViewer();
      prevBtn.disabled = jumpTargetTick(marks, playback.tick, -1) < 0;
      nextBtn.disabled = jumpTargetTick(marks, playback.tick, 1) < 0;
    }

    // ---- キー（`06§10`） ----
    const onKey = (ev: KeyboardEvent): void => {
      const a = replayKeyAction(ev.key, {
        shift: ev.shiftKey,
        ctrl: ev.ctrlKey,
        alt: ev.altKey,
      });
      if (a === null) return;
      ev.preventDefault();
      switch (a.k) {
        case 'toggle':
          playback.toggle();
          syncControls();
          break;
        case 'jumpOrder':
          jumpOrder(a.dir);
          break;
        case 'shiftTime':
          seek(shiftTargetTick(playback.tick, a.dir, rep.endTick));
          break;
        case 'lane':
          // その戦域レーンを追いかける（盤面の視点もその戦域へ寄せる）
          followSlot = followSlot === a.slot ? 0 : a.slot;
          lastLaneKey = '';
          break;
        case 'speed': {
          const v = stepSpeed(playback.speed, a.dir);
          playback.setSpeed(v);
          slider.value = String(v);
          speedText.textContent = speedLabel(v);
          break;
        }
        case 'viewer':
          switchViewer();
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKey, true);

    // ---- 画面サイズ ----
    const resize = (): void => {
      if (canvas === null || ctx2d === null || renderer === null) return;
      const dpr = window.devicePixelRatio || 1;
      const w = window.innerWidth;
      const h = window.innerHeight;
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
      renderer.resize(w, h);
      lastLaneKey = '';
    };
    resize();
    window.addEventListener('resize', resize);

    // ---- レーンの描き直し（走査が進んだとき / 幅が変わったとき / 視点が変わったとき） ----
    // `lastLaneKey` は上（`seek` の手前）で宣言している。
    function rebuildLanes(): void {
      const width = laneDom[0]?.track.clientWidth ?? 0;
      const key = `${viewer}|${timeline.scannedTick}|${Math.round(width)}|${followSlot}`;
      if (key === lastLaneKey) return;
      lastLaneKey = key;
      const box = boxFor(width);
      const pt = timeline.players[viewer];
      for (let slot = 1; slot <= MAX_FRONTS; slot++) {
        const dom = laneDom[slot - 1]!;
        dom.track.textContent = '';
        dom.row.classList.toggle('is-follow', followSlot === slot);
        if (pt === undefined) continue;

        // 3. レーンが伸びている時間 = その戦域が立っていた時間
        for (const span of pt.spans) {
          if (span.slot !== slot) continue;
          const r = spanLayout(span, rep.endTick, box);
          const bar = el('div', 'mt-rp-span');
          bar.style.left = `${r.x}px`;
          bar.style.width = `${r.w}px`;
          bar.style.background = frontColor(slot);
          bar.title = `戦域 ${slot} は ${tickToClock(span.startTick, TICK_RATE)} から ${tickToClock(
            span.endTick,
            TICK_RATE,
          )} まで立っていた`;
          dom.track.appendChild(bar);
        }

        // 4. 令の変更点（カード。クリックでその令を出した瞬間から再生）
        // 5. 令が届いた時刻（カードの少し右の薄い印）
        for (const m of pt.marks) {
          if (m.slot !== slot) continue;
          const lay = markLayout(m, rep.endTick, box);
          if (lay.deliveredX >= 0) {
            const pip = el('div', 'mt-rp-delivered');
            pip.style.left = `${lay.deliveredX}px`;
            pip.title = `届いた ${tickToClock(m.deliveredTick, TICK_RATE)}（ずれ ${lay.delaySec.toFixed(2)} 秒）`;
            dom.track.appendChild(pip);
            // ずれを線で結ぶ（印だけだと「少し右」の意味が読み取りにくい）
            const gap = el('div', 'mt-rp-gap');
            gap.style.left = `${lay.x}px`;
            gap.style.width = `${Math.max(1, lay.deliveredX - lay.x)}px`;
            dom.track.appendChild(gap);
          }
          const card = el('button', 'mt-rp-card');
          card.type = 'button';
          card.style.left = `${lay.x}px`;
          card.style.borderColor = frontColor(slot);
          if (m.tier === 'lower') card.classList.add('is-lower');
          card.textContent = orderName(m.order);
          card.title = markTitle(m.order, m.tier, m.issuedTick, m.deliveredTick);
          card.addEventListener('click', (ev) => {
            ev.stopPropagation();
            seek(m.issuedTick);
          });
          dom.track.appendChild(card);
        }
      }
      // 注記（`05§14` の最後）
      note.textContent = laneFocusNote(pt?.marks ?? []);
    }

    // ---- 毎フレーム ----
    let lastMs = performance.now();
    const frame = (nowMs: number): void => {
      const dtMs = Math.min(250, nowMs - lastMs);
      lastMs = nowMs;

      // 1. タイムラインの先読み（少しずつ）
      if (!scan.done) {
        scan.advance(SCAN_TICKS_PER_FRAME);
        timeline = scan.snapshot();
        scanText.textContent = scanLabel(scan.progress);
      } else if (timeline.scannedTick < rep.endTick) {
        timeline = scan.snapshot();
        scanText.textContent = scanLabel(1);
      }

      // 2. 再生（頭出し中は一気に詰める）
      const stepped = playback.frame(dtMs);
      if (stepped > 0 || playback.seeking) syncControls();

      // 3. 盤面
      if (renderer !== null) {
        const w = playback.w;
        // 戦域を追いかけているなら、その戦域の中心へ寄せる（`1`〜`6`）
        if (followSlot > 0) {
          const f = w.fronts[viewer * MAX_FRONTS + (followSlot - 1)];
          if (f !== undefined && f.active) {
            renderer.cam.cx = f.x / FX_ONE;
            renderer.cam.cy = f.y / FX_ONE;
          }
        }
        renderer.updateVision(w, viewer);
        renderer.draw({ world: w, viewer, alpha: 0, selected: null, dragRect: null }, nowMs);
        const b = busiestLane(marksOfViewer());
        boardNote.textContent =
          `俯瞰で再生中（視界は全開放）\u3000視点 ${viewerLabel(viewer, rep.setup.civs)}` +
          (followSlot > 0 ? `\u3000戦域 ${followSlot} を追跡中` : '') +
          `\u3000令 ${b.total} 枚`;
        boardNote.style.borderColor = playerColor(viewer);
      }

      // 4. レーン
      rebuildLanes();
      const width = laneDom[0]?.track.clientWidth ?? 0;
      const x = tickToX(playback.tick, rep.endTick, boxFor(width));
      playhead.style.left = `${LANE_NAME_WIDTH + x}px`;
    };

    active = {
      frame,
      stop: () => {
        window.removeEventListener('keydown', onKey, true);
        window.removeEventListener('resize', resize);
      },
    };
    syncControls();
  },

  unmount(): void {
    active?.stop();
    active = null;
  },

  frame(nowMs: number): void {
    active?.frame(nowMs);
  },
};

/** 表示中の実体（`Screen` は 1 つしか表示されないのでモジュールスコープで足りる）。 */
let active: { frame: (nowMs: number) => void; stop: () => void } | null = null;

// ---------------------------------------------------------------------------
// 5. 開発用のデモ（`?dev=replay`）
// ---------------------------------------------------------------------------
//
// **申し送り**: `main.ts` が試合中に `ReplayRecorder` で入力を録り、結果画面へ
// `replayParams: { replay }` を渡すようになれば、この節はまるごと消せる。
// それまでは `05§14` の 7 項目を実機で目視確認する入口が無いので、ここに置いている。
// 兵を直接置くのは `main.ts` の `stressSpawn`（負荷試験の入口）と同じ扱いで、
// tick 0 の前に 1 回だけ行う初期配置。

/** `?dev=replay` か。 */
function isDevReplay(): boolean {
  try {
    return new URLSearchParams(window.location.search).get('dev') === 'replay';
  } catch {
    return false;
  }
}

/** デモの記録（入力だけ。150 tick ごとに戦域 1〜3 へ令を配る）。 */
function demoReplay(): Replay {
  const inputs = [];
  for (let n = 1; n <= 16; n++) {
    const tick = n * 150;
    const slot = ((n - 1) % 3) + 1;
    const order = (['charge', 'hold', 'retreat', 'siege'] as const)[
      Math.floor((n - 1) / 3) % 4
    ] as never;
    inputs.push({
      tick,
      byPlayer: {
        0: [{ t: 'setOrder' as const, p: 0 as PlayerId, front: slot, order, tier: 'upper' as const }],
      },
    });
  }
  return {
    version: REPLAY_VERSION,
    seed: 11110002,
    setup: { playerCount: 2, civs: ['yamato', 'mongol'], mapType: 'plain' },
    dataHash: dataHash(),
    inputs,
    hashes: [],
    endTick: 2500,
  };
}

/** デモの初期配置（戦闘を起こして戦域を立てるため。**乱数を使わない固定の表**）。 */
function demoPrepare(w: World): void {
  for (const pl of w.players) {
    pl.age = 3;
    pl.frontSlots = 6;
  }
  const spots: readonly (readonly [number, number])[] = [
    [70, 70],
    [70, 110],
    [110, 90],
  ];
  for (const [tx, ty] of spots) {
    for (let k = 0; k < 4; k++) {
      for (const [owner, id] of [
        [0, 'y-nagae'],
        [1, 'g-heavy'],
      ] as const) {
        const def = unitDefById(id);
        spawnEntity(w.entities, {
          kind: EntityKind.Unit,
          owner,
          typeId: def.index,
          x: fxFromInt(tx + (owner === 0 ? -1 : 1)) + (FX_ONE >> 1),
          y: fxFromInt(ty + k) + (FX_ONE >> 1),
          hpMax: def.hp,
          morale: FX_ONE,
        });
      }
    }
  }
}
