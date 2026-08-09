/**
 * net/session.ts — 「接続 + 待ち合わせ」を 1 個の口にまとめる（`main.ts` の結線用）
 *
 * `main.ts` に通信の手順を書くと、対戦画面の他の結線（HUD・パネル・入力）と混ざって
 * 触りにくくなる。だから **`main.ts` が知るのは `NetplaySession` の 4 メソッドだけ**にした。
 *
 * ```ts
 * const net = joinMatch({ room, name, onReady: ({ playerId, seed }) => 試合を作る() });
 * // 毎フレーム
 * for (const c of uiCommands) net.emit(c);
 * if (net.step(world) !== 'stepped') 描画だけ続ける();
 * ```
 *
 * ■ 開始の順番
 *   `join` → `welcome`（自分の playerId とシード） → `ready` → `start` → `onReady`
 * `onReady` が呼ばれてはじめて World を作る。**先に World を作ってしまうと
 * 自分の playerId が分からず、視点が常に P0 になる。**
 */

import type { PlayerId } from '@/shared/types';
import type { Command } from '@/sim/command';
import type { World } from '@/sim/core/world';

import type { ConnectFn, WelcomeInfo } from './client';
import { RelayClient, defaultRelayUrl } from './client';
import type { DesyncInfo, StepOutcome } from './lockstep';
import { Lockstep } from './lockstep';
import type { RosterEntry } from './protocol';

/** 試合を始められる状態になったときに渡される情報。 */
export interface MatchReadyInfo {
  /** 自分の playerId（= 対戦画面の視点）。 */
  readonly playerId: PlayerId;
  /** サーバが決めたシード（**部屋の主に引き直させない**ためサーバが配る）。 */
  readonly seed: number;
  /** 参加者の playerId（昇順）。 */
  readonly playerIds: readonly PlayerId[];
  readonly players: readonly RosterEntry[];
}

/** `main.ts` から見た通信。 */
export interface NetplaySession {
  /** ローカルの入力を積む（送るのは次の turn 境界）。 */
  emit(cmd: Command): void;
  /**
   * 1 tick 進めようとする。
   * `'notStarted'` は「まだ `start` が来ていない」（World も作られていない）。
   */
  step(world: World): StepOutcome | 'notStarted';
  /** HUD のデバッグ行に出す 1 行。 */
  statusText(tick: number): string;
  /** 接続を切る（画面を離れるとき）。 */
  stop(): void;
  /** デシンクの内容（null = 正常）。 */
  readonly desync: DesyncInfo | null;
  /** 代行中の席（playerId 昇順）。 */
  substituting(): readonly PlayerId[];
  /**
   * その席の代行を始めた tick（-1 = 代行していない）。
   * **全端末で同じ値になる**（tick 番号だけで決めているため）。
   */
  substituteStartTick(p: PlayerId): number;
}

export interface JoinMatchOptions {
  readonly room: string;
  readonly name: string;
  /** 中継サーバの URL（省略時は同じホストの `net.relayPort`）。 */
  readonly url?: string;
  readonly connect?: ConnectFn;
  /** `start` が来たら呼ばれる。ここで World を作る。 */
  readonly onReady: (info: MatchReadyInfo) => void;
  readonly onStatus?: (text: string) => void;
  readonly onDesync?: (info: DesyncInfo) => void;
}

/**
 * 部屋に入って試合の開始を待つ。
 *
 * 戻り値はすぐ使えるが、`step` は `onReady` が呼ばれるまで `'notStarted'` を返す。
 */
export function joinMatch(opts: JoinMatchOptions): NetplaySession {
  const url =
    opts.url ??
    defaultRelayUrl(
      typeof location === 'undefined'
        ? { protocol: 'http:', hostname: 'localhost' }
        : { protocol: location.protocol, hostname: location.hostname },
    );

  let lockstep: Lockstep | null = null;
  let welcome: WelcomeInfo | null = null;
  let roster: readonly RosterEntry[] = [];
  /** `start` 前に積まれた入力（開始後に流す）。 */
  const early: Command[] = [];
  let status = '接続中…';

  const setStatus = (text: string): void => {
    status = text;
    opts.onStatus?.(text);
  };

  const client = new RelayClient({
    url,
    room: opts.room,
    name: opts.name,
    ...(opts.connect === undefined ? {} : { connect: opts.connect }),
    onWelcome: (info) => {
      welcome = info;
      roster = info.players;
      setStatus(`部屋 ${opts.room} に入りました（P${info.playerId}）`);
    },
    onRoster: (players) => {
      roster = players;
      const waiting = players.filter((p) => !p.ready).length;
      if (lockstep === null) {
        setStatus(waiting > 0 ? `準備待ち ${waiting} 人` : '開始します');
      }
    },
    onStart: () => {
      const w = welcome;
      if (w === null) return; // `welcome` より先に `start` は来ない
      const playerIds = roster.map((p) => p.playerId).sort((a, b) => a - b);
      const ids = playerIds.length > 0 ? playerIds : [w.playerId];
      lockstep = new Lockstep({
        localPlayerId: w.playerId,
        playerIds: ids,
        inputDelayFrames: w.inputDelayFrames,
        send: (text) => client.sendText(text),
        ...(opts.onDesync === undefined ? {} : { onDesync: opts.onDesync }),
      });
      lockstep.prime();
      for (const c of early.splice(0)) lockstep.emit(c);
      setStatus('対戦中');
      opts.onReady({ playerId: w.playerId, seed: w.seed, playerIds: ids, players: roster });
    },
    onMessage: (msg, text) => {
      // `welcome` / `roster` / `start` は上で処理済み。ここでは待ち合わせに要る種別だけ渡す。
      if (msg.t !== 'input' && msg.t !== 'desync' && msg.t !== 'left') return;
      void text;
      lockstep?.receive(msg);
    },
    onError: (message) => setStatus(`エラー: ${message}`),
    onClose: () => setStatus('接続が切れました（席は 120 秒保持されます）'),
  });

  return {
    emit(cmd) {
      if (lockstep === null) early.push(cmd);
      else lockstep.emit(cmd);
    },
    step(world) {
      if (lockstep === null) return 'notStarted';
      return lockstep.step(world);
    },
    statusText(tick) {
      return lockstep === null ? status : `${status} / ${lockstep.statusText(tick)}`;
    },
    stop() {
      client.close();
    },
    get desync() {
      return lockstep?.desync ?? null;
    },
    substituting() {
      return lockstep?.substituting() ?? [];
    },
    substituteStartTick(p) {
      return lockstep?.substituteStartTick(p) ?? -1;
    },
  };
}
