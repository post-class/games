/**
 * net/lockstep.ts — 入力の待ち合わせと tick の進行（T-M14-03 / 04 / 05 / 06）
 *
 * ■ このファイルが引き受けていること
 *  1. **自分の入力を「現在 tick + inputDelayFrames」宛に送る**（`InputSender`）
 *  2. **全員の入力が揃った tick だけ進める**。揃っていなければ待つ（`Lockstep.step`）
 *  3. **空入力を送らない圧縮**（turn 単位のまとめ送り + `cmds` の省略）
 *  4. **切断時の AI 代行の開始・終了を tick 番号だけで決める**（`SeatWatch`）
 *  5. **250 tick ごとのハッシュ送信**と、`desync` を受けたら即停止
 *
 * ■ ここに DOM も WebSocket も無い
 * 送信口は `send(text: string)` という関数 1 つだけ。実際の WebSocket は `client.ts`、
 * テストは配列に溜めるだけの偽リンクを差す。**待ち合わせの規則を DOM 抜きで検算できる**
 * ようにするための分割（`tests/unit/net.lockstep.test.ts`）。
 *
 * ■ 「送らない」と「まだ届いていない」を混同しないための規約（T-M14-04）
 * 中継サーバは「その tick を**全員が**出したときだけ配る」ので、
 * 誰か 1 人が黙ると部屋は永久に止まる。だから
 *
 *   - 送る tick は **turn 境界（`turnTicks` の倍数）だけ**に固定する。
 *     どの端末も同じ tick 集合を出すので、待ち合わせが噛み合う。
 *   - **turn 境界では入力が空でも必ず 1 通送る**（= これが「まだ届いていない」との区別）。
 *   - 省くのは *turn の中の tick ぶんの通信* と、空のときの `cmds` フィールド。
 *
 * 45,000 tick を 1 tick ごとに送ると 15,000 通 → 45,000 通で 1.5MB を超える。
 * turn（既定 6 tick = 240ms）でまとめると 7,500 通になり、
 * 送信・受信を合わせても 1MB を切る（T-M14-04 の完了条件）。
 *
 * ■ 決定論のために絶対に守っていること（`07§12` / 手順書 §11.3）
 *  - **代行の開始判定に時計を使わない。** 使うのは「確定入力に載っていなかった tick 数」だけ。
 *    `Date.now()` で判定すると端末ごとに違うフレームで代行が始まり、確実にデシンクする。
 *  - サーバの `left`（切断通知）は**判断に使わない**。あれは実時間で飛んでくるうえ
 *    `atTick` が -1 なので、端末ごとに到着フレームが違う。表示にだけ使う。
 *  - `stepWorld` に渡す配列は **playerId 昇順 → 発行順**。
 *  - `Math.random` / `Date.now` はこの層では使ってよいが、**`Command` には混ぜない**。
 */

import type { PlayerId } from '@/shared/types';
import type { Command } from '@/sim/command';
import type { World } from '@/sim/core/world';
import { HASH_CHECK_INTERVAL_TICKS, hashWorld, stepWorld } from '@/sim';
import { TICK_RATE, cfgInt, cfgNum } from '@/sim/core/config';
import { AiPlayer } from '@/ai/AiPlayer';

import type { C2S, S2C } from './protocol';
import { decodeS2C, encodeC2S, utf8Bytes } from './protocol';

// ---------------------------------------------------------------- 設定（config.json）

/** 接続前の既定の入力遅延（フレーム）。`welcome.inputDelayFrames` が来たらそちらを使う。 */
export const DEFAULT_INPUT_DELAY_FRAMES = cfgInt('net.inputDelayFrames');

/** 入力を送る間隔（tick）。この tick 数ぶんをまとめて 1 通で送る。 */
export const TURN_TICKS = cfgInt('net.turnTicks');

/** 代行を始めるまでの tick 数（`07§12`「入力が 3 秒届かなかったフレーム番号」）。 */
export const SUBSTITUTE_AFTER_TICKS = Math.round(cfgNum('net.substituteAfterSec') * TICK_RATE);

/** 席を保持する tick 数（`07§12`「席は 120 秒保持」）。 */
export const SEAT_HOLD_TICKS = Math.round(cfgNum('net.seatHoldSec') * TICK_RATE);

/** 代行 AI の段階。 */
export const SUBSTITUTE_AI_LEVEL = cfgInt('net.substituteAiLevel');

/** 復帰した席が部屋を止めないために先送りする空入力の turn 数。 */
export const REJOIN_PREFILL_TURNS = cfgInt('net.rejoinPrefillTurns');

// ---------------------------------------------------------------- 送信

/** 文字列を 1 通送る口。実体は WebSocket（`client.ts`）かテストの配列。 */
export type SendText = (text: string) => void;

/** `tick` 以上で最も近い `unit` の倍数。 */
function alignUp(tick: number, unit: number): number {
  return Math.ceil(tick / unit) * unit;
}

/**
 * 自分の入力を送る側（T-M14-03 / 04）。
 *
 * **turn 境界の tick を実行する直前**に `onBeforeTick` を呼ぶだけでよい。
 * 宛先は `alignUp(tick + inputDelayFrames, turnTicks)` = 「現在 tick + 入力遅延」を
 * turn 境界に丸めた tick。既定値（遅延 3 / turn 6）ではちょうど `tick + 6`。
 *
 * 過去や現在の tick 宛には**絶対に送らない**（`lastTarget` より前へ戻らない）。
 * これが「アンドゥが存在しない」（`07§12`）ことの実装上の姿でもある。
 */
export class InputSender {
  private readonly link: SendText;
  private readonly turnTicks: number;
  private readonly delayFrames: number;
  /** まだ送っていない自分の Command（**発行順**を保つ）。 */
  private pending: Command[] = [];
  /** 最後に送った宛先 tick（-1 = まだ送っていない）。 */
  private lastTarget = -1;

  /** 送ったバイト数（UTF-8）。 */
  sentBytes = 0;
  /** 送った通数。 */
  sentMessages = 0;
  /** そのうち中身が空だった通数（圧縮の効き具合を見るため）。 */
  emptyMessages = 0;

  constructor(opts: {
    readonly send: SendText;
    readonly inputDelayFrames?: number;
    readonly turnTicks?: number;
  }) {
    this.link = opts.send;
    this.delayFrames = opts.inputDelayFrames ?? DEFAULT_INPUT_DELAY_FRAMES;
    this.turnTicks = opts.turnTicks ?? TURN_TICKS;
  }

  /** 入力を積む（送るのは次の turn 境界）。 */
  push(cmd: Command): void {
    this.pending.push(cmd);
  }

  /** 積んである数（テストと HUD の表示用）。 */
  get pendingCount(): number {
    return this.pending.length;
  }

  /** 最後に送った宛先 tick。 */
  get lastTargetTick(): number {
    return this.lastTarget;
  }

  /** `tick` の入力を出すときの宛先 tick。 */
  targetTickFor(tick: number): number {
    return alignUp(tick + this.delayFrames, this.turnTicks);
  }

  /**
   * 試合の開始前に呼ぶ。
   *
   * 最初の turn は「誰も送っていないので誰も進めない」状態になるため、
   * `onBeforeTick(startTick)` が出す宛先より前の turn を先に埋めておく。
   */
  prime(startTick = 0): void {
    const first = Math.floor(startTick / this.turnTicks) * this.turnTicks;
    const until = this.targetTickFor(startTick);
    for (let t = first; t < until; t += this.turnTicks) this.submit(t);
  }

  /** turn 境界なら 1 通送る（境界以外では何もしない）。 */
  onBeforeTick(tick: number): void {
    if (tick % this.turnTicks !== 0) return;
    this.submit(this.targetTickFor(tick));
  }

  /**
   * 空入力を連続で先送りする（復帰した席が部屋を止めないため。T-M14-05）。
   *
   * 中継サーバは同じ tick の 2 通目を捨てるので、先送りした空入力は
   * **その turn のあいだ操作できない**という代償だけで、他の端末を壊さない。
   */
  prefillEmpty(fromTargetTick: number, turns: number = REJOIN_PREFILL_TURNS): void {
    const first = alignUp(fromTargetTick, this.turnTicks);
    for (let i = 0; i < turns; i++) this.submit(first + i * this.turnTicks);
  }

  private submit(target: number): void {
    if (target <= this.lastTarget) return; // 過去へ戻らない
    const cmds = this.pending;
    this.pending = [];
    const text = encodeC2S({ t: 'input', tick: target, cmds });
    this.lastTarget = target;
    this.sentBytes += utf8Bytes(text);
    this.sentMessages += 1;
    if (cmds.length === 0) this.emptyMessages += 1;
    this.link(text);
  }
}

// ---------------------------------------------------------------- 席の見張り

/**
 * 誰の入力が届いていないかを **tick 番号だけ**で判断する（T-M14-05）。
 *
 * 材料は「確定入力（サーバが配った `input`）にその playerId が載っていたか」だけ。
 * 確定入力は**全端末に同じ内容が同じ順序で届く**ので、
 * ここから出る結論（何 tick 目から代行か）も全端末で完全に一致する。
 *
 * **時計は 1 か所も使わない。** `Date.now()` を使った途端に
 * 「端末 A は 74 tick 目、端末 B は 76 tick 目から代行」になり、確実にデシンクする。
 */
export class SeatWatch {
  private readonly ids: readonly PlayerId[];
  /** playerId → 最後に確定入力に載っていた turn の tick。 */
  private readonly lastSeen = new Map<PlayerId, number>();
  /** playerId → 代行を始めた tick（-1 = 代行していない）。 */
  private readonly startedAt = new Map<PlayerId, number>();
  private readonly afterTicks: number;
  private readonly holdTicks: number;

  constructor(
    playerIds: readonly PlayerId[],
    opts?: { readonly startTick?: number; readonly afterTicks?: number; readonly holdTicks?: number },
  ) {
    // playerId 昇順に固定（反復順に判断を預けない。§0.3）
    this.ids = [...playerIds].sort((a, b) => a - b);
    this.afterTicks = opts?.afterTicks ?? SUBSTITUTE_AFTER_TICKS;
    this.holdTicks = opts?.holdTicks ?? SEAT_HOLD_TICKS;
    const start = opts?.startTick ?? 0;
    for (const p of this.ids) {
      this.lastSeen.set(p, start);
      this.startedAt.set(p, -1);
    }
  }

  /** 見張っている playerId（昇順）。 */
  get playerIds(): readonly PlayerId[] {
    return this.ids;
  }

  /**
   * 確定入力が 1 turn ぶん届いたことを記録する。
   * `present` に載っていない席は「入力が来ていない席」。
   */
  noteTurn(turnTick: number, present: readonly PlayerId[]): void {
    for (const p of present) {
      if (!this.lastSeen.has(p)) continue;
      this.lastSeen.set(p, turnTick);
      // 戻ってきたら代行をやめる（`07§12`「戻れば操作を引き継げます」）
      this.startedAt.set(p, -1);
    }
  }

  /**
   * その tick の代行状態を確定させる。**毎 tick、進める直前に 1 回呼ぶ。**
   * （開始 tick を記録するために状態を進めるので、判定だけの `isSubstituting` と分けてある）
   */
  advance(tick: number): void {
    for (const p of this.ids) {
      if (this.absentTicks(p, tick) < this.afterTicks) continue;
      if (this.startedAt.get(p) === -1) this.startedAt.set(p, tick);
    }
  }

  /** その席の入力が届かなくなってからの tick 数。 */
  absentTicks(p: PlayerId, tick: number): number {
    const seen = this.lastSeen.get(p);
    return seen === undefined ? 0 : tick - seen;
  }

  /** いま AI が代行しているか（`advance` の結果を読むだけ）。 */
  isSubstituting(p: PlayerId): boolean {
    return (this.startedAt.get(p) ?? -1) >= 0;
  }

  /** 代行を始めた tick（-1 = 代行していない）。**全端末で同じ値になる。** */
  substituteStartTick(p: PlayerId): number {
    return this.startedAt.get(p) ?? -1;
  }

  /** 代行中の席の一覧（playerId 昇順）。 */
  substituting(): PlayerId[] {
    return this.ids.filter((p) => this.isSubstituting(p));
  }

  /**
   * 席の保持期限（120 秒）を過ぎたか。過ぎても AI はそのまま続ける
   * （`07§12`「戻らなければ AI がそのまま続けます」）。表示のための判定。
   */
  isSeatExpired(p: PlayerId, tick: number): boolean {
    return this.absentTicks(p, tick) >= this.holdTicks;
  }
}

// ---------------------------------------------------------------- 本体

/** 1 tick 進めようとした結果。 */
export type StepOutcome =
  /** 進めた。 */
  | 'stepped'
  /** 入力が揃っていないので待った（描画は続けてよい。補間の alpha は進めない）。 */
  | 'waiting'
  /** デシンクを検出して止まっている。 */
  | 'halted';

/** デシンクの通知内容（`07§12`「どちらが正しいかは分からない」ので勝者は入っていない）。 */
export interface DesyncInfo {
  readonly tick: number;
  readonly hashes: Readonly<Record<number, number>>;
}

/** 代行に使う AI（`AiPlayer` がそのまま当てはまる。テストでは偽物を差す）。 */
export interface AiSubstitute {
  think(w: World): Command[];
}

export interface LockstepOptions {
  /** 自分の playerId。**代行の判定から自分を除外してはいけない**（端末ごとに判断が変わる）。 */
  readonly localPlayerId: PlayerId;
  /** 参加者の playerId（昇順でなくてよい。内部で昇順に直す）。 */
  readonly playerIds: readonly PlayerId[];
  readonly inputDelayFrames?: number;
  readonly turnTicks?: number;
  readonly startTick?: number;
  /** 送信口。 */
  readonly send: SendText;
  /** 代行 AI を作る（既定は `AiPlayer`）。 */
  readonly createAi?: (p: PlayerId) => AiSubstitute;
  readonly onDesync?: (info: DesyncInfo) => void;
  readonly onSubstituteStart?: (p: PlayerId, tick: number) => void;
}

/** 通信量と待ち時間の実測（T-M14-03 / 04 の完了条件を数える）。 */
export interface LockstepStats {
  sentBytes: number;
  sentMessages: number;
  recvBytes: number;
  recvMessages: number;
  /** 入力待ちで 1 tick も進めなかった回数（「誰かが遅いと全員が同じだけ待つ」の実測）。 */
  waitedTicks: number;
  steppedTicks: number;
}

/**
 * ロックステップの進行役。
 *
 * 使い方（`main.ts` の結線）:
 * ```ts
 * const ls = new Lockstep({ localPlayerId, playerIds, send: (t) => ws.send(t) });
 * ls.prime();                       // 最初の turn を送る
 * // 毎フレーム
 * for (const c of uiCommands) ls.emit(c);
 * while (acc >= TICK_MS && steps < 5) {
 *   if (ls.step(world) !== 'stepped') break;   // 揃っていなければ待つ（描画は続ける）
 *   acc -= TICK_MS; steps++;
 * }
 * ```
 */
export class Lockstep {
  private readonly ids: readonly PlayerId[];
  private readonly localId: PlayerId;
  private readonly turnTicks: number;
  private readonly link: SendText;
  private readonly sender: InputSender;
  private readonly seats: SeatWatch;
  private readonly ai = new Map<PlayerId, AiSubstitute>();
  private readonly createAi: (p: PlayerId) => AiSubstitute;
  private readonly onDesync: ((info: DesyncInfo) => void) | null;
  private readonly onSubstituteStart: ((p: PlayerId, tick: number) => void) | null;

  /** 確定入力（turn の先頭 tick → playerId → Command[]）。 */
  private readonly confirmed = new Map<number, Record<number, Command[]>>();
  /** 直近に受けた `left`（**表示専用**。判断には使わない）。 */
  private lastLeft: { playerId: PlayerId; holdMs: number } | null = null;
  private halt: DesyncInfo | null = null;
  private lastHashTick = -1;
  private lastHash = 0;
  private waitingTickValue = -1;

  readonly stats: LockstepStats = {
    sentBytes: 0,
    sentMessages: 0,
    recvBytes: 0,
    recvMessages: 0,
    waitedTicks: 0,
    steppedTicks: 0,
  };

  constructor(opts: LockstepOptions) {
    this.ids = [...opts.playerIds].sort((a, b) => a - b);
    this.localId = opts.localPlayerId;
    this.turnTicks = opts.turnTicks ?? TURN_TICKS;
    this.link = opts.send;
    this.createAi = opts.createAi ?? ((p) => new AiPlayer(p, SUBSTITUTE_AI_LEVEL));
    this.onDesync = opts.onDesync ?? null;
    this.onSubstituteStart = opts.onSubstituteStart ?? null;
    const startTick = opts.startTick ?? 0;
    this.sender = new InputSender({
      send: (text) => this.sendText(text),
      ...(opts.inputDelayFrames === undefined ? {} : { inputDelayFrames: opts.inputDelayFrames }),
      turnTicks: this.turnTicks,
    });
    this.seats = new SeatWatch(this.ids, { startTick });
  }

  /** 自分の playerId。 */
  get localPlayerId(): PlayerId {
    return this.localId;
  }

  /** 席の見張り（代行の開始 tick を外から読むため）。 */
  get seatWatch(): SeatWatch {
    return this.seats;
  }

  /** 送信側（通信量の実測とテスト用）。 */
  get inputSender(): InputSender {
    return this.sender;
  }

  /** デシンクの内容（null = 正常）。 */
  get desync(): DesyncInfo | null {
    return this.halt;
  }

  /** 直近に送ったハッシュ。 */
  get lastSentHash(): number {
    return this.lastHash;
  }

  /** 直近の切断通知（**表示専用**）。 */
  get lastLeftNotice(): { playerId: PlayerId; holdMs: number } | null {
    return this.lastLeft;
  }

  /** 入力待ちの tick（-1 = 待っていない）。 */
  get waitingTick(): number {
    return this.waitingTickValue;
  }

  /** 試合の開始前に 1 回呼ぶ（最初の turn を送る）。 */
  prime(startTick = 0): void {
    this.sender.prime(startTick);
  }

  /** ローカルの入力を積む（送るのは次の turn 境界）。 */
  emit(cmd: Command): void {
    this.sender.push(cmd);
  }

  /** サーバからの生文字列を処理する（受信バイト数もここで数える）。 */
  receiveText(text: string): S2C | null {
    this.stats.recvBytes += utf8Bytes(text);
    this.stats.recvMessages += 1;
    const msg = decodeS2C(text);
    if (msg !== null) this.receive(msg);
    return msg;
  }

  /** 解読済みのメッセージを処理する。 */
  receive(msg: S2C): void {
    switch (msg.t) {
      case 'input':
        // 同じ tick を 2 回受けたら最初のものを残す（サーバ側も同じ規約）
        if (!this.confirmed.has(msg.tick)) {
          this.confirmed.set(msg.tick, msg.byPlayer as Record<number, Command[]>);
        }
        return;
      case 'desync': {
        if (this.halt !== null) return;
        this.halt = { tick: msg.tick, hashes: msg.hashes };
        this.onDesync?.(this.halt);
        return;
      }
      case 'left':
        // **判断には使わない。** 実時間で飛んでくるので端末ごとに到着フレームが違う。
        this.lastLeft = { playerId: msg.playerId, holdMs: msg.holdMs };
        return;
      default:
        return;
    }
  }

  /**
   * 1 tick 進めようとする。
   *
   * 返り値が `'stepped'` 以外のときは **`world.tick` は動いていない**。
   * 呼び出し側は描画だけ続けること（補間の alpha は進めない）。
   */
  step(world: World): StepOutcome {
    if (this.halt !== null) return 'halted';
    const tick = world.tick;

    // 250 tick ごとに状態ハッシュを送る（T-M14-06）。**待っている間に二重送信しない。**
    this.maybeSendHash(world);

    let turnInputs: Record<number, Command[]> | null = null;
    if (tick % this.turnTicks === 0) {
      // 先に自分の入力を出す（`tick + inputDelayFrames` 宛）。ここを step の後にすると
      // 「自分が送らないので誰も進めない」で相互に止まる。
      this.sender.onBeforeTick(tick);
      const conf = this.confirmed.get(tick);
      if (conf === undefined) {
        // **揃っていなければ待つ。** これが「誰かの回線が遅いと全員が同じだけ待つ」（`07§12`）。
        this.stats.waitedTicks += 1;
        this.waitingTickValue = tick;
        return 'waiting';
      }
      this.confirmed.delete(tick);
      this.seats.noteTurn(tick, presentPlayers(conf));
      turnInputs = conf;
    }
    this.waitingTickValue = -1;

    // 代行の開始・終了を tick 番号だけで決める（T-M14-05）
    const before = this.substitutingSnapshot();
    this.seats.advance(tick);
    if (this.onSubstituteStart !== null) {
      for (const p of this.ids) {
        if (this.seats.isSubstituting(p) && !before.has(p)) this.onSubstituteStart(p, tick);
      }
    }

    // **playerId 昇順 → 発行順**（手順書 §4.1。順序が変わると結果が変わる）
    const cmds = mergeTurnCommands(this.ids, turnInputs, (p) =>
      // 代行中の席は AI が出す。全端末が同じ tick に同じ AI を回すので一致する。
      this.seats.isSubstituting(p) ? this.aiFor(p).think(world) : null,
    );

    stepWorld(world, cmds);
    this.stats.steppedTicks += 1;
    return 'stepped';
  }

  /** 代行中の席（playerId 昇順）。 */
  substituting(): PlayerId[] {
    return this.seats.substituting();
  }

  /** 代行を始めた tick（-1 = 代行していない）。 */
  substituteStartTick(p: PlayerId): number {
    return this.seats.substituteStartTick(p);
  }

  /** 状態の 1 行表示（HUD のデバッグ行に出す）。 */
  statusText(tick: number): string {
    if (this.halt !== null) return `デシンク検出（tick ${this.halt.tick}）`;
    const subs = this.substituting();
    const parts: string[] = [];
    parts.push(this.waitingTickValue >= 0 ? `入力待ち tick ${this.waitingTickValue}` : '同期中');
    if (subs.length > 0) {
      parts.push(
        `AI 代行 ${subs
          .map((p) => `P${p}${this.seats.isSeatExpired(p, tick) ? '(席解放)' : ''}`)
          .join(',')}`,
      );
    }
    parts.push(`送信 ${(this.stats.sentBytes / 1024).toFixed(1)}KB`);
    return parts.join(' / ');
  }

  private substitutingSnapshot(): Set<PlayerId> {
    const s = new Set<PlayerId>();
    for (const p of this.ids) if (this.seats.isSubstituting(p)) s.add(p);
    return s;
  }

  private aiFor(p: PlayerId): AiSubstitute {
    const found = this.ai.get(p);
    if (found !== undefined) return found;
    // **代行の開始 tick が全端末で同じ**なので、ここで作る AI の内部状態も一致する。
    const made = this.createAi(p);
    this.ai.set(p, made);
    return made;
  }

  private maybeSendHash(world: World): void {
    if (world.tick % HASH_CHECK_INTERVAL_TICKS !== 0) return;
    if (this.lastHashTick === world.tick) return;
    this.lastHashTick = world.tick;
    this.lastHash = hashWorld(world);
    this.sendText(encodeC2S({ t: 'hash', tick: world.tick, hash: this.lastHash }));
  }

  private sendText(text: string): void {
    this.stats.sentBytes += utf8Bytes(text);
    this.stats.sentMessages += 1;
    this.link(text);
  }
}

/**
 * その tick に `stepWorld` へ渡す配列を組む（純関数。T-M14-03 / 05）。
 *
 * 並びは **playerId 昇順 → 発行順**（手順書 §4.1）。ここが崩れると
 * 「同じ入力なのに違う結果」になり、数十分後にデシンクとして現れる。
 *
 * @param byPlayer この turn の確定入力（turn の先頭 tick 以外は null）
 * @param substitute 代行中なら AI の Command、代行していなければ null を返す関数
 */
export function mergeTurnCommands(
  playerIds: readonly PlayerId[],
  byPlayer: Readonly<Record<number, Command[]>> | null,
  substitute: (p: PlayerId) => readonly Command[] | null,
): Command[] {
  const out: Command[] = [];
  for (const p of playerIds) {
    const ai = substitute(p);
    if (ai !== null) {
      // 代行中の席は**確定入力を見ない**（そもそも届いていない）
      pushAll(out, ai);
      continue;
    }
    if (byPlayer === null) continue;
    const own = byPlayer[p];
    if (own !== undefined) pushAll(out, own);
  }
  return out;
}

/** 確定入力に載っていた playerId（昇順）。 */
export function presentPlayers(byPlayer: Readonly<Record<number, Command[]>>): PlayerId[] {
  const out: PlayerId[] = [];
  for (const key of Object.keys(byPlayer)) {
    const pid = Number.parseInt(key, 10);
    if (Number.isInteger(pid)) out.push(pid);
  }
  out.sort((a, b) => a - b);
  return out;
}

/**
 * `join` と `ready` を組み立てる（`client.ts` とテストが使う）。
 * ここに置いてあるのは、パケットの綴りを 1 か所に閉じ込めるため。
 */
export function joinMessage(room: string, name: string): C2S {
  return { t: 'join', room, name };
}

/** `ready`（全員が押したらサーバが `start` を配る）。 */
export function readyMessage(): C2S {
  return { t: 'ready' };
}

function pushAll(dst: Command[], src: readonly Command[]): void {
  for (let i = 0; i < src.length; i++) dst.push(src[i]!);
}
