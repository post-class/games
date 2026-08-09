/**
 * replay/playback.ts — 再生の制御と、タイムラインの素材づくり（T-M15-04, 05）
 *
 * ■ リプレイと観戦は同じ仕組み（`07§12`）
 * 「同じ入力を同じ順序で与えれば同じ試合になる」ので、
 * **リプレイも観戦も「入力を受けて `stepWorld` を回すだけ」**。
 * 違いは入力がどこから来るかだけなので、そこを `InputSource` 1 本に抽象化した。
 *   - リプレイ  … `replaySource(replay)`  … 記録済みの入力（最後まで先が読める）
 *   - 観戦      … `liveSource()`          … 中継から届いた分だけ（先は読めない）
 * `readyTick()` が「ここまでは進めてよい」を返すので、観戦では届いた先へ進まない。
 *
 * ■ 観戦者が試合に影響しないこと（T-M15-05 の完了条件）
 * `Playback` にも `InputSource` にも**入力を送る口が無い**。
 * `liveSource` は `push`（受け取る）だけで、送信関数を持たない。
 * だから観戦者が何人増えても、その端末が試合に足せるものは何も無い。
 * `tests/unit/replay.playback.test.ts` がこの構造をテストしている。
 *
 * ■ 倍速（`05§14-2`, 手順書 §12）
 * **tick レートは変えない。** 1 フレームで進める tick 数（`tickBudget`）を増やすだけ。
 * 25 tick/秒のまま「1 フレームに何 tick 詰めるか」を変えるので、
 * 8 倍でも決定論はまったく崩れない（0.5 倍は 1 tick 分の時間を 2 倍待つ）。
 *
 * ■ 巻き戻しの方法
 * 状態のスナップショットは持たない（World は数 MB あり、45,000 tick 分は現実的でない）。
 * 巻き戻しは **World を作り直して目的の tick まで一気に回す**。
 * 「入力の記録」だけで試合が完全に再現できるという性質をそのまま使う（`07§12`）。
 *
 * DOM を触らないので、この中身は jsdom が無くてもテストできる。
 */

import type { OrderId, PlayerId, Tier } from '@/shared/types';
import type { Command } from '@/sim/command';
import { TICK_RATE, stepWorld } from '@/sim/index';
import { MAX_FRONTS, frontIndex, type World } from '@/sim/core/world';
import { ORDER_IDS } from '@/shared/types';
import type { Replay } from './format';

// ---------------------------------------------------------------------------
// 1. 入力の供給元（リプレイ / 観戦の共通口）
// ---------------------------------------------------------------------------

/**
 * その tick の入力を渡すもの。**渡すだけで、受け取らない**（観戦者は入力を送らない）。
 */
export interface InputSource {
  /** その tick の入力（playerId 昇順 → 発行順）。`out` を使い回す。 */
  take(tick: number, out: Command[]): Command[];
  /** 先頭に戻す（巻き戻し再生のため）。 */
  reset(): void;
  /** ここまでは進めてよい tick（これより先の入力は「まだ確定していない」）。 */
  readyTick(): number;
}

/** リプレイを入力源にする。 */
export function replaySource(replay: Replay): InputSource {
  // `ReplayReader` は tick 昇順の前提でカーソルを進める実装なので、
  // 巻き戻しのたびに作り直す（`reset` が同じことをしている）。
  let cursor = 0;
  const inputs = replay.inputs;
  return {
    take(tick, out) {
      out.length = 0;
      while (cursor < inputs.length && inputs[cursor]!.tick < tick) cursor++;
      const frame = inputs[cursor];
      if (frame === undefined || frame.tick !== tick) return out;
      for (const pid of Object.keys(frame.byPlayer)
        .map(Number)
        .sort((a, b) => a - b)) {
        for (const c of frame.byPlayer[pid] ?? []) out.push(c);
      }
      return out;
    },
    reset() {
      cursor = 0;
    },
    readyTick() {
      return replay.endTick;
    },
  };
}

/** 観戦の入力源。中継から届いた分を貯めるだけ（**送る口は無い**）。 */
export interface LiveInputSource extends InputSource {
  /** 中継から届いた 1 tick 分を受け取る（tick 昇順に呼ぶ）。 */
  push(tick: number, cmds: readonly Command[]): void;
  /** 受け取った tick 数。 */
  readonly frameCount: number;
}

export function liveSource(): LiveInputSource {
  const ticks: number[] = [];
  const frames: Command[][] = [];
  let last = -1;
  const src = {
    push(tick: number, cmds: readonly Command[]): void {
      // 同じ tick を 2 回受けたら後から来たものは捨てる（確定した入力は変わらない）。
      if (tick <= last) return;
      last = tick;
      ticks.push(tick);
      frames.push([...cmds]);
    },
    take(tick: number, out: Command[]): Command[] {
      out.length = 0;
      // 観戦は届いた順に前から消費するので、線形に探して構わない（tick 昇順）。
      const i = ticks.indexOf(tick);
      if (i < 0) return out;
      for (const c of frames[i]!) out.push(c);
      return out;
    },
    reset(): void {
      /* 受け取った入力は消さない（巻き戻しても同じ入力を使う） */
    },
    readyTick(): number {
      return last;
    },
    get frameCount(): number {
      return ticks.length;
    },
  };
  return src;
}

// ---------------------------------------------------------------------------
// 2. 倍速（tickBudget だけで実装する）
// ---------------------------------------------------------------------------

/** 倍速の段（`05§14-2`「0.5〜8 倍」）。`+` `-` はこの段を 1 つずつ動く。 */
export const SPEED_STEPS: readonly number[] = [0.5, 1, 2, 3, 4, 6, 8];

export const MIN_SPEED = 0.5;
export const MAX_SPEED = 8;

/** 1 フレームで進める tick 数の基準（等速。手順書 §4.1 の 5 と揃える）。 */
export const BASE_TICK_BUDGET = 5;

/** 0.5〜8 に収める。 */
export function clampSpeed(v: number): number {
  if (!Number.isFinite(v)) return 1;
  if (v < MIN_SPEED) return MIN_SPEED;
  if (v > MAX_SPEED) return MAX_SPEED;
  return v;
}

/**
 * スライダーの生の値を段に丸める。
 * **段の外側は端に寄せる**（0.4 → 0.5、9 → 8）。同距離なら遅い側を採る（読みやすさ優先）。
 */
export function quantizeSpeed(v: number): number {
  const c = clampSpeed(v);
  let best = SPEED_STEPS[0]!;
  let bestD = Number.POSITIVE_INFINITY;
  for (const s of SPEED_STEPS) {
    const d = Math.abs(s - c);
    if (d < bestD - 1e-9) {
      bestD = d;
      best = s;
    }
  }
  return best;
}

/** `+` `-` の 1 段移動。 */
export function stepSpeed(current: number, dir: 1 | -1): number {
  const cur = quantizeSpeed(current);
  const i = SPEED_STEPS.indexOf(cur);
  const next = Math.min(SPEED_STEPS.length - 1, Math.max(0, (i < 0 ? 1 : i) + dir));
  return SPEED_STEPS[next]!;
}

/**
 * その倍速で 1 フレームに許す tick 数。**これが倍速の実装そのもの**
 * （tick の長さ 40ms は変えない）。
 * 0.5 倍でも 1 は許す（許さないと 1 フレームも進まない）。
 */
export function tickBudget(speed: number, base: number = BASE_TICK_BUDGET): number {
  const n = Math.round(base * clampSpeed(speed));
  return n < 1 ? 1 : n;
}

/** 1 tick のミリ秒（25 tick/秒）。 */
export const TICK_MS = 1000 / TICK_RATE;

/**
 * 経過時間を tick 数に割る（純関数）。
 *
 * 倍速は「実時間の進み方」に掛ける（`acc += dtMs * speed`）。
 * `budget` を超えた分は捨てる（貯め続けると、重いフレームの後に早送りが起きる）。
 */
export function advanceTicks(
  accMs: number,
  dtMs: number,
  speed: number,
  budget: number,
): { ticks: number; acc: number } {
  let acc = accMs + Math.max(0, dtMs) * clampSpeed(speed);
  let ticks = 0;
  while (acc >= TICK_MS && ticks < budget) {
    acc -= TICK_MS;
    ticks++;
  }
  if (acc > TICK_MS) acc = TICK_MS; // 予算切れ分は捨てる
  return { ticks, acc };
}

/**
 * 頭出しの計画（純関数）。
 *
 * 前に戻るときだけ World を作り直す（`restart`）。あとは目的の tick まで回す steps。
 */
export function seekPlan(
  currentTick: number,
  targetTick: number,
  endTick: number,
): { restart: boolean; steps: number; target: number } {
  const target = Math.max(0, Math.min(Math.floor(targetTick), endTick));
  if (target < currentTick) return { restart: true, steps: target, target };
  return { restart: false, steps: target - currentTick, target };
}

/** 頭出し中に 1 フレームで回す tick 数（体感が固まらない上限）。 */
export const SEEK_TICKS_PER_FRAME = 1500;

// ---------------------------------------------------------------------------
// 3. 再生器（リプレイ・観戦の共通実装）
// ---------------------------------------------------------------------------

export interface PlaybackOptions {
  /** tick 0 の World を作る。**巻き戻しのたびに呼ばれる**ので、毎回同じ World を返すこと。 */
  readonly createWorld: () => World;
  readonly source: InputSource;
  /** 記録の長さ（リプレイ）。観戦は `Number.MAX_SAFE_INTEGER` を渡す。 */
  readonly endTick: number;
  /** 毎 tick の観測（`TimelineRecorder.observe` を渡す）。**World を書き換えないこと。** */
  readonly onTick?: (w: World) => void;
  /** 1 フレームの tick 予算の基準（既定 5）。 */
  readonly baseBudget?: number;
}

/**
 * 入力を受けて `stepWorld` を回すだけの再生器。
 *
 * **sim を書き換えるのは `stepWorld` に渡す `Command` だけ**（手順書 §3.1）。
 * 再生器から令を作ったり、World を直接いじったりはしない。
 */
export class Playback {
  private readonly opts: PlaybackOptions;
  private readonly buf: Command[] = [];
  private world: World;
  private accMs = 0;
  private seekTarget = -1;

  /** 再生中か（`Space` でトグル）。 */
  playing = false;
  /** 倍速（0.5〜8）。 */
  speed = 1;

  constructor(opts: PlaybackOptions) {
    this.opts = opts;
    this.world = opts.createWorld();
    this.opts.source.reset();
    this.opts.onTick?.(this.world);
  }

  /** 今の World（**読むだけ**）。 */
  get w(): World {
    return this.world;
  }

  /** 今の tick。 */
  get tick(): number {
    return this.world.tick;
  }

  /** 記録の長さ。 */
  get endTick(): number {
    return this.opts.endTick;
  }

  /** 頭出し中か（進捗表示に使う）。 */
  get seeking(): boolean {
    return this.seekTarget >= 0;
  }

  /** 頭出しの目標 tick（頭出し中でなければ -1）。 */
  get seekTargetTick(): number {
    return this.seekTarget;
  }

  play(): void {
    this.playing = true;
  }

  pause(): void {
    this.playing = false;
  }

  /** `Space`（`06§10`。試合中の「次の警告へ」とは意味が変わる）。 */
  toggle(): boolean {
    this.playing = !this.playing;
    return this.playing;
  }

  setSpeed(v: number): number {
    this.speed = clampSpeed(v);
    return this.speed;
  }

  /** 1 フレームに許す tick 数。 */
  get budget(): number {
    return tickBudget(this.speed, this.opts.baseBudget ?? BASE_TICK_BUDGET);
  }

  /**
   * 指定 tick へ頭出しする（`05§14-4` のカードのクリック / `←` `→`）。
   * 実際の巻き戻し・早送りは `frame` の中で分割して行う（画面を固めないため）。
   */
  seek(tick: number): void {
    const plan = seekPlan(this.world.tick, tick, this.opts.endTick);
    if (plan.restart) {
      this.world = this.opts.createWorld();
      this.opts.source.reset();
      this.accMs = 0;
      this.opts.onTick?.(this.world);
    }
    this.seekTarget = plan.target;
  }

  /**
   * 1 フレーム進める。戻り値は進めた tick 数。
   *
   * 頭出し中は倍速を無視して一気に詰める（待ち時間を短くするため）。
   */
  frame(dtMs: number): number {
    if (this.seekTarget >= 0) {
      let n = 0;
      while (this.world.tick < this.seekTarget && n < SEEK_TICKS_PER_FRAME) {
        if (!this.stepOnce()) break;
        n++;
      }
      if (this.world.tick >= this.seekTarget) this.seekTarget = -1;
      return n;
    }
    if (!this.playing) return 0;
    const a = advanceTicks(this.accMs, dtMs, this.speed, this.budget);
    this.accMs = a.acc;
    let n = 0;
    for (let i = 0; i < a.ticks; i++) {
      if (!this.stepOnce()) {
        // 記録の終わり（観戦なら「まだ届いていない」）。再生を止める。
        this.playing = false;
        break;
      }
      n++;
    }
    return n;
  }

  /** 1 tick 進める。進めなかった（記録の終わり / 未着）なら false。 */
  private stepOnce(): boolean {
    const t = this.world.tick;
    if (t >= this.opts.endTick) return false;
    if (t > this.opts.source.readyTick()) return false;
    stepWorld(this.world, this.opts.source.take(t, this.buf));
    this.opts.onTick?.(this.world);
    return true;
  }
}

// ---------------------------------------------------------------------------
// 4. タイムラインの素材（`05§14` の主役）
// ---------------------------------------------------------------------------

/** レーンが伸びている区間 = **その戦域が立っていた時間**（`05§14-3`）。 */
export interface LaneSpan {
  readonly slot: number;
  readonly startTick: number;
  /** 閉じた tick（まだ立っているなら観測した最後の tick）。 */
  readonly endTick: number;
}

/** レーン上のカード 1 枚（`05§14-4`, `05§14-5`）。 */
export interface OrderMark {
  readonly slot: number;
  /** `ORDER_IDS` の添字。 */
  readonly order: number;
  readonly orderId: OrderId;
  readonly tier: Tier;
  /** 令を出した tick（`pendingOrder` が現れた tick）。 */
  readonly issuedTick: number;
  /** 戦域に届いた tick（-1 = 届く前に記録が終わった）。 */
  readonly deliveredTick: number;
}

/** プレイヤー 1 人分のタイムライン。 */
export interface PlayerTimeline {
  readonly player: PlayerId;
  readonly spans: readonly LaneSpan[];
  /** `issuedTick` 昇順。 */
  readonly marks: readonly OrderMark[];
}

export interface Timeline {
  /** 記録の長さ（横軸の右端）。 */
  readonly endTick: number;
  /** どこまで観測したか（走査が途中なら endTick より小さい）。 */
  readonly scannedTick: number;
  readonly players: readonly PlayerTimeline[];
}

/**
 * 戦域と令を毎 tick 観測して、タイムラインの素材を作る。
 *
 * ■ なぜ sim から取らないのか
 * World は「今」しか持たない（履歴は状態ではない）。履歴を sim に足すと
 * 状態ハッシュの対象になり、数え方を直すたびに過去のリプレイが無効になる。
 * だから `ui/stats.ts` と同じく **UI 側の観測**として持つ。
 *
 * ■ 令の「出した時刻」と「届いた時刻」（`05§14-5` の薄い印）
 * `pendingOrder` が現れた tick = 出した時刻、`order` が変わった tick = 届いた時刻。
 * この 2 つを別々に持つことが要点（片方だけだと遅延が画面から消える。手順書 §16-4）。
 */
export class TimelineRecorder {
  private readonly playerCount: number;
  private readonly spans: LaneSpan[][] = [];
  private readonly marks: OrderMark[][] = [];
  /** 開いている区間の開始 tick（-1 = 立っていない）。添字 `p * MAX_FRONTS + slot-1`。 */
  private readonly openAt: Int32Array;
  private readonly prevPendingOrder: Int8Array;
  private readonly prevPendingAt: Int32Array;
  private readonly pendingMarkIdx: Int32Array;
  private lastTick = 0;
  private started = false;

  constructor(playerCount: number) {
    this.playerCount = playerCount;
    const n = playerCount * MAX_FRONTS;
    this.openAt = new Int32Array(n).fill(-1);
    this.prevPendingOrder = new Int8Array(n);
    this.prevPendingAt = new Int32Array(n).fill(-1);
    this.pendingMarkIdx = new Int32Array(n).fill(-1);
    for (let p = 0; p < playerCount; p++) {
      this.spans.push([]);
      this.marks.push([]);
    }
  }

  /** 観測した最後の tick。 */
  get scannedTick(): number {
    return this.lastTick;
  }

  /** **`stepWorld` の直後に毎 tick 呼ぶ。** World は読むだけ。 */
  observe(w: World): void {
    const first = !this.started;
    this.started = true;
    this.lastTick = w.tick;
    for (let p = 0; p < this.playerCount; p++) {
      for (let slot = 1; slot <= MAX_FRONTS; slot++) {
        const f = w.fronts[frontIndex(p as PlayerId, slot)];
        if (f === undefined) continue;
        const k = p * MAX_FRONTS + (slot - 1);

        // ---- レーンの区間（立っていた時間）----
        if (f.active && this.openAt[k]! < 0) this.openAt[k] = w.tick;
        else if (!f.active && this.openAt[k]! >= 0) {
          this.spans[p]!.push({ slot, startTick: this.openAt[k]!, endTick: w.tick });
          this.openAt[k] = -1;
        }

        // ---- 令の「出した」「届いた」----
        //
        // 判定を **`pendingOrder`（配達中の令）の出入りだけ**で行う。
        //   現れた           → 出した（カードを 1 枚置く）
        //   消えた + 期限到達 → 届いた（薄い印を置く）
        //   消えた + 期限前   → 届かなかった（戦域が閉じた・離反した。印は置かない）
        // `order` の値の変化で「届いた」を見ると、**同じ令を出し直したとき**に
        // 値が変わらないので届いたことが分からない（`07§4` の切り替えは同じ令でも起きる）。
        const pend = f.pendingOrder;
        const pendOrder = pend === null ? 0 : ORDER_IDS.indexOf(pend.id) + 1;
        const pendAt = pend === null ? -1 : pend.deliverAtTick;
        const prevOrder = this.prevPendingOrder[k]!;
        const prevAt = this.prevPendingAt[k]!;
        const changed = pendOrder !== prevOrder || pendAt !== prevAt;
        if (!first && changed) {
          if (prevOrder !== 0) {
            const mi = this.pendingMarkIdx[k]!;
            const row = mi >= 0 ? this.marks[p]![mi] : undefined;
            // 期限に達していて、旗がまだ生きているなら届いた（`orderDelivery` の条件と同じ）
            if (row !== undefined && row.deliveredTick < 0 && w.tick >= prevAt) {
              if (f.active && !f.defected) this.marks[p]![mi] = { ...row, deliveredTick: w.tick };
            }
            this.pendingMarkIdx[k] = -1;
          }
          if (pendOrder !== 0 && pend !== null) {
            const o = pendOrder - 1;
            this.pendingMarkIdx[k] = this.marks[p]!.length;
            this.marks[p]!.push({
              slot,
              order: o,
              orderId: ORDER_IDS[o]!,
              tier: pend.tier,
              issuedTick: w.tick,
              deliveredTick: -1,
            });
          }
        }
        this.prevPendingOrder[k] = pendOrder;
        this.prevPendingAt[k] = pendAt;
      }
    }
  }

  /** 今までの観測を写す。開いている区間は「観測した最後の tick」で閉じる。 */
  snapshot(endTick: number): Timeline {
    const players: PlayerTimeline[] = [];
    for (let p = 0; p < this.playerCount; p++) {
      const spans = [...this.spans[p]!];
      for (let slot = 1; slot <= MAX_FRONTS; slot++) {
        const start = this.openAt[p * MAX_FRONTS + (slot - 1)]!;
        if (start >= 0) spans.push({ slot, startTick: start, endTick: this.lastTick });
      }
      spans.sort((a, b) => a.slot - b.slot || a.startTick - b.startTick);
      players.push({ player: p as PlayerId, spans, marks: [...this.marks[p]!] });
    }
    return { endTick, scannedTick: this.lastTick, players };
  }
}

/**
 * タイムラインの先読み走査。
 *
 * ■ なぜ先読みが必要か
 * `05§14` のタイムラインは**試合全体**（レーンが立っていた時間・全部の令カード）を出す。
 * これは「今の World」からは分からないので、記録を最後まで 1 回回して観測するしかない。
 *
 * ■ なぜ分割して走らせるか
 * 30 分の試合は 45,000 tick あり、一気に回すと画面が数十秒固まる。
 * `advance(maxTicks)` を毎フレーム少しずつ呼ぶことで、
 * **見ながらタイムラインが埋まっていく**形にする（`progress` を進捗表示に使う）。
 *
 * 再生用の World とは別の World を使う（再生と走査が同じ World を共有すると、
 * 走査が進んだ分だけ再生が飛ぶ）。
 */
export class TimelineScan {
  private readonly world: World;
  private readonly source: InputSource;
  private readonly rec: TimelineRecorder;
  private readonly buf: Command[] = [];
  private readonly end: number;

  constructor(opts: {
    createWorld: () => World;
    createSource: () => InputSource;
    endTick: number;
    playerCount: number;
  }) {
    this.world = opts.createWorld();
    this.source = opts.createSource();
    this.end = opts.endTick;
    this.rec = new TimelineRecorder(opts.playerCount);
    this.rec.observe(this.world);
  }

  get done(): boolean {
    return this.world.tick >= this.end;
  }

  /** 0..1。 */
  get progress(): number {
    if (this.end <= 0) return 1;
    return Math.min(1, this.world.tick / this.end);
  }

  /** 最大 `maxTicks` だけ走査する。戻り値は進んだ tick 数。 */
  advance(maxTicks: number): number {
    let n = 0;
    while (n < maxTicks && this.world.tick < this.end) {
      if (this.world.tick > this.source.readyTick()) break;
      stepWorld(this.world, this.source.take(this.world.tick, this.buf));
      this.rec.observe(this.world);
      n++;
    }
    return n;
  }

  snapshot(): Timeline {
    return this.rec.snapshot(this.end);
  }
}

// ---------------------------------------------------------------------------
// 5. タイムラインの配置計算（純関数。DOM を触らない = jsdom 不要）
// ---------------------------------------------------------------------------

/** レーンの描画枠（px）。 */
export interface TimelineBox {
  /** レーン 1 本の全幅（px）。 */
  readonly width: number;
  /** 左の内側余白（レーン名の幅）。 */
  readonly padLeft: number;
  /** 右の内側余白。 */
  readonly padRight: number;
}

/** 目盛りの有効幅。 */
function trackWidth(box: TimelineBox): number {
  const w = box.width - box.padLeft - box.padRight;
  return w > 0 ? w : 0;
}

/** tick → x（px）。`endTick` が 0 のときは左端。 */
export function tickToX(tick: number, endTick: number, box: TimelineBox): number {
  const w = trackWidth(box);
  if (endTick <= 0 || w <= 0) return box.padLeft;
  const t = Math.max(0, Math.min(tick, endTick));
  return box.padLeft + (t / endTick) * w;
}

/** x（px）→ tick。枠の外は 0 / endTick に丸める（レーンのクリック位置に使う）。 */
export function xToTick(x: number, endTick: number, box: TimelineBox): number {
  const w = trackWidth(box);
  if (endTick <= 0 || w <= 0) return 0;
  const r = (x - box.padLeft) / w;
  const t = Math.round(r * endTick);
  return Math.max(0, Math.min(t, endTick));
}

/**
 * レーンの区間の矩形（x と幅）。
 * **1 tick しか立たなかった戦域も見えるように**、幅は最低 2px を確保する。
 */
export function spanLayout(
  span: LaneSpan,
  endTick: number,
  box: TimelineBox,
): { x: number; w: number } {
  const x0 = tickToX(span.startTick, endTick, box);
  const x1 = tickToX(span.endTick, endTick, box);
  const w = x1 - x0;
  return { x: x0, w: w < 2 ? 2 : w };
}

/**
 * カードと「届いた印」の位置（`05§14-4`, `05§14-5`）。
 *
 * `deliveredX` は**カードの少し右**に来る。これが出した時刻とのずれそのもの。
 * 届く前に記録が終わった令（`deliveredTick < 0`）は `deliveredX = -1`（印を出さない）。
 */
export function markLayout(
  mark: OrderMark,
  endTick: number,
  box: TimelineBox,
): { x: number; deliveredX: number; delayTicks: number; delaySec: number } {
  const x = tickToX(mark.issuedTick, endTick, box);
  const delivered = mark.deliveredTick >= 0;
  const delayTicks = delivered ? mark.deliveredTick - mark.issuedTick : -1;
  return {
    x,
    deliveredX: delivered ? tickToX(mark.deliveredTick, endTick, box) : -1,
    delayTicks,
    delaySec: delivered ? delayTicks / TICK_RATE : -1,
  };
}

/** レーンごとのカード枚数（添字 0 = 戦域 1）。 */
export function laneCardCounts(marks: readonly OrderMark[], maxSlots = MAX_FRONTS): number[] {
  const out = new Array<number>(maxSlots).fill(0);
  for (const m of marks) {
    if (m.slot < 1 || m.slot > maxSlots) continue;
    out[m.slot - 1] = out[m.slot - 1]! + 1;
  }
  return out;
}

/** いちばんカードが多いレーン（同数なら小さい番号。乱数を使わない）。 */
export function busiestLane(
  marks: readonly OrderMark[],
  maxSlots = MAX_FRONTS,
): { slot: number; count: number; total: number; share: number } {
  const counts = laneCardCounts(marks, maxSlots);
  let slot = 0;
  let count = 0;
  let total = 0;
  for (let i = 0; i < counts.length; i++) {
    total += counts[i]!;
    if (counts[i]! > count) {
      count = counts[i]!;
      slot = i + 1;
    }
  }
  return { slot, count, total, share: total > 0 ? count / total : 0 };
}

/**
 * `05§14` の最後の注記を文にする。
 *
 * 「1 本のレーンだけカードが何度も切り替わっているなら、
 *   その戦域に手を取られて他を放置していた」
 *
 * 判定: **1 本に令の半分以上が集まっていて、かつそのレーンのカードが 3 枚以上**。
 * 半分ちょうどを含めるのは、2 本立っていて片方に集中した試合を拾うため。
 */
export function laneFocusNote(marks: readonly OrderMark[], maxSlots = MAX_FRONTS): string {
  const b = busiestLane(marks, maxSlots);
  if (b.total === 0) return '令はまだ出ていない。レーンが伸びている時間がその戦域が立っていた時間。';
  const pct = Math.round(b.share * 100);
  if (b.count >= 3 && b.share >= 0.5) {
    return (
      `戦域 ${b.slot} に令が集中している（${b.count} / ${b.total} 枚 = ${pct}%）。` +
      'この戦域に手を取られて他を放置していた形。'
    );
  }
  return `令は ${b.total} 枚。いちばん多いのは戦域 ${b.slot}（${b.count} 枚 = ${pct}%）で、偏りは小さい。`;
}

// ---------------------------------------------------------------------------
// 6. 頭出しの相手を選ぶ（`06§10` の `←` `→`）
// ---------------------------------------------------------------------------

/**
 * 「前後の令を出した瞬間」（`←` `→`）。
 *
 * 見つからなければ -1（何もしない。端で勝手に 0 や末尾へ飛ばさない）。
 * 同じ tick に複数の令があっても 1 回で通り過ぎる（tick 単位で選ぶ）。
 */
export function jumpTargetTick(
  marks: readonly OrderMark[],
  currentTick: number,
  dir: 1 | -1,
): number {
  let best = -1;
  for (const m of marks) {
    const t = m.issuedTick;
    if (dir > 0) {
      if (t > currentTick && (best < 0 || t < best)) best = t;
    } else if (t < currentTick && (best < 0 || t > best)) best = t;
  }
  return best;
}

/** `Shift`+`←` `→` の 10 秒移動。端で止める。 */
export function shiftTargetTick(
  currentTick: number,
  dir: 1 | -1,
  endTick: number,
  seconds = 10,
): number {
  const d = Math.round(seconds * TICK_RATE) * dir;
  return Math.max(0, Math.min(currentTick + d, endTick));
}

/** `Tab` で次の視点へ（観戦。`06§10`）。 */
export function viewerAfterTab(current: number, playerCount: number): number {
  if (playerCount <= 0) return 0;
  return (current + 1) % playerCount;
}
