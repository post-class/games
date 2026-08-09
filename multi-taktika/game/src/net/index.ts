/**
 * net/index.ts — 通信層の唯一の入口（手順書 §3.1 / §11。M14）
 *
 * 外の層（`main.ts` / `ui`）はここから見えるものだけを使う。
 * `sim` は net を import しない（決定論の側から通信が見えてはいけない）。
 *
 * 内訳:
 *   - `protocol.ts` … パケットの型と符号化（空入力の省略 = T-M14-04 の圧縮）
 *   - `lockstep.ts` … 入力の待ち合わせ・AI 代行・ハッシュ突合（T-M14-03/05/06）
 *   - `client.ts`   … WebSocket 1 本ぶんの世話
 *   - `session.ts`  … 上 3 つを `main.ts` から使える 4 メソッドにまとめたもの
 */

export type { C2S, S2C, S2CType, RosterEntry } from './protocol';
export { decodeS2C, encodeC2S, utf8Bytes } from './protocol';

export type {
  AiSubstitute,
  DesyncInfo,
  LockstepOptions,
  LockstepStats,
  SendText,
  StepOutcome,
} from './lockstep';
export {
  DEFAULT_INPUT_DELAY_FRAMES,
  InputSender,
  Lockstep,
  REJOIN_PREFILL_TURNS,
  SEAT_HOLD_TICKS,
  SUBSTITUTE_AFTER_TICKS,
  SUBSTITUTE_AI_LEVEL,
  SeatWatch,
  TURN_TICKS,
  joinMessage,
  mergeTurnCommands,
  presentPlayers,
  readyMessage,
} from './lockstep';

export type { ConnectFn, RelayClientOptions, WebSocketLike, WelcomeInfo } from './client';
export { RELAY_PORT, RelayClient, defaultRelayUrl, roomFromLocation } from './client';

export type { JoinMatchOptions, MatchReadyInfo, NetplaySession } from './session';
export { joinMatch } from './session';
