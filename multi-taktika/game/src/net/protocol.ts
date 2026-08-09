/**
 * net/protocol.ts — 中継サーバとやり取りするパケットの型と符号化（T-M14-02〜04）
 *
 * ここは `server/relay.ts` の `C2S` / `S2C` と**同じ形**を持つだけのファイル。
 * サーバは実装を共有できない（`server/` は Node 側、`src/` はブラウザ側）ので、
 * **形の一致はテストで担保する**（`tests/unit/net.protocol.test.ts`）。
 *
 * ■ 送るのは入力だけ（`07§12`）
 * `input` に入るのは `Command`（クリック座標と令の番号）だけで、
 * **ユニットの座標は 1 つも入らない**。だから通信量は人数に依存しない。
 *
 * ■ 空入力の省略（T-M14-04）
 * `encodeC2S` は `cmds` が空のとき **`cmds` フィールドを丸ごと落とす**。
 * サーバ側は `Array.isArray(msg.cmds) ? msg.cmds : []` と書かれているので、
 * 欠けていれば空入力として扱われる。30 分のほとんどは無入力なので、
 * この 9 バイトの差が全体の通信量を決める。
 *
 * 「送らない」と「まだ届いていない」の区別は**符号化ではなく進行の規約**で付ける。
 * 詳細は `lockstep.ts` の `InputSender`（turn の境界では必ず 1 通送る）を参照。
 */

import type { Command } from '@/sim/command';

/** 部屋の参加者 1 人ぶん（`roster` / `welcome` に入る）。 */
export interface RosterEntry {
  readonly playerId: number;
  readonly name: string;
  readonly ready: boolean;
}

/** クライアント → サーバ。`server/relay.ts` の `C2S` と同じ形。 */
export type C2S =
  | { readonly t: 'join'; readonly room: string; readonly name: string }
  | { readonly t: 'ready' }
  | { readonly t: 'input'; readonly tick: number; readonly cmds: readonly Command[] }
  | { readonly t: 'hash'; readonly tick: number; readonly hash: number };

/** サーバ → クライアント。`server/relay.ts` の `S2C` と同じ形。 */
export type S2C =
  | {
      readonly t: 'welcome';
      readonly playerId: number;
      readonly seed: number;
      readonly inputDelayFrames: number;
      readonly players: readonly RosterEntry[];
    }
  | { readonly t: 'roster'; readonly players: readonly RosterEntry[] }
  | { readonly t: 'start'; readonly startTick: number }
  | { readonly t: 'input'; readonly tick: number; readonly byPlayer: Readonly<Record<number, Command[]>> }
  | { readonly t: 'desync'; readonly tick: number; readonly hashes: Readonly<Record<number, number>> }
  | { readonly t: 'left'; readonly playerId: number; readonly atTick: number; readonly holdMs: number }
  | { readonly t: 'error'; readonly message: string };

/** `S2C` の判別子。 */
export type S2CType = S2C['t'];

const encoder = new TextEncoder();

/** UTF-8 のバイト数（通信量の実測に使う。T-M14-04）。 */
export function utf8Bytes(text: string): number {
  return encoder.encode(text).length;
}

/**
 * `C2S` を文字列にする。
 *
 * **空入力は `cmds` を省く**（T-M14-04）。`JSON.stringify` に任せると
 * `"cmds":[]` の 9 バイトが 30 分ぶん（数万通）積み上がる。
 */
export function encodeC2S(msg: C2S): string {
  if (msg.t === 'input' && msg.cmds.length === 0) {
    return `{"t":"input","tick":${msg.tick}}`;
  }
  return JSON.stringify(msg);
}

/**
 * サーバからの文字列を `S2C` に戻す。
 *
 * **読めなければ `null` を返して黙って捨てる**（例外にしない）。
 * 壊れた 1 通で試合が落ちるのは、デシンクよりたちが悪い。
 */
export function decodeS2C(text: string): S2C | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const rec = raw as Record<string, unknown>;
  switch (rec['t']) {
    case 'welcome':
      if (!isInt(rec['playerId']) || !isInt(rec['seed']) || !isInt(rec['inputDelayFrames'])) {
        return null;
      }
      return {
        t: 'welcome',
        playerId: rec['playerId'],
        seed: rec['seed'],
        inputDelayFrames: rec['inputDelayFrames'],
        players: toRoster(rec['players']),
      };
    case 'roster':
      return { t: 'roster', players: toRoster(rec['players']) };
    case 'start':
      return { t: 'start', startTick: isInt(rec['startTick']) ? rec['startTick'] : 0 };
    case 'input': {
      if (!isInt(rec['tick'])) return null;
      const by = rec['byPlayer'];
      if (typeof by !== 'object' || by === null) return null;
      return { t: 'input', tick: rec['tick'], byPlayer: toByPlayer(by as Record<string, unknown>) };
    }
    case 'desync': {
      if (!isInt(rec['tick'])) return null;
      const h = rec['hashes'];
      if (typeof h !== 'object' || h === null) return null;
      return { t: 'desync', tick: rec['tick'], hashes: toHashes(h as Record<string, unknown>) };
    }
    case 'left':
      if (!isInt(rec['playerId'])) return null;
      return {
        t: 'left',
        playerId: rec['playerId'],
        atTick: isInt(rec['atTick']) ? rec['atTick'] : -1,
        holdMs: isInt(rec['holdMs']) ? rec['holdMs'] : 0,
      };
    case 'error':
      return { t: 'error', message: String(rec['message'] ?? '') };
    default:
      return null;
  }
}

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}

function toRoster(v: unknown): RosterEntry[] {
  if (!Array.isArray(v)) return [];
  const out: RosterEntry[] = [];
  for (const e of v) {
    if (typeof e !== 'object' || e === null) continue;
    const r = e as Record<string, unknown>;
    if (!isInt(r['playerId'])) continue;
    out.push({ playerId: r['playerId'], name: String(r['name'] ?? ''), ready: r['ready'] === true });
  }
  // playerId 昇順に固定する（`Object.keys` / 配列の順序に判断を預けない。§0.3）
  out.sort((a, b) => a.playerId - b.playerId);
  return out;
}

/**
 * `byPlayer` を `playerId → Command[]` に直す。
 *
 * **中身の妥当性はここで判定しない。** `applyCommands` が不正な Command を
 * 黙って無視する設計なので、ここでの絞り込みは
 * 「オブジェクトで `t` が文字列」という最小限だけ。
 * 全端末が同じデータに同じ絞り込みをかけるので決定論は崩れない。
 */
function toByPlayer(rec: Record<string, unknown>): Record<number, Command[]> {
  const out: Record<number, Command[]> = {};
  for (const key of Object.keys(rec)) {
    const pid = Number.parseInt(key, 10);
    if (!Number.isInteger(pid)) continue;
    out[pid] = toCommands(rec[key]);
  }
  return out;
}

function toCommands(v: unknown): Command[] {
  if (!Array.isArray(v)) return [];
  const out: Command[] = [];
  for (const c of v) {
    if (typeof c !== 'object' || c === null) continue;
    if (typeof (c as Record<string, unknown>)['t'] !== 'string') continue;
    out.push(c as Command);
  }
  return out;
}

function toHashes(rec: Record<string, unknown>): Record<number, number> {
  const out: Record<number, number> = {};
  for (const key of Object.keys(rec)) {
    const pid = Number.parseInt(key, 10);
    const h = rec[key];
    if (!Number.isInteger(pid) || typeof h !== 'number') continue;
    out[pid] = h | 0;
  }
  return out;
}
