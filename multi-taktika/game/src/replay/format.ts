/**
 * replay/format.ts — リプレイの記録形式（T-M15-01, 03）
 *
 * `07§12`「保存されているのは映像ではなく **入力の記録**」。
 * ゲームロジックが決定論なので、シードと入力列があれば試合が完全に再現できる。
 * だから容量が小さく、再生時に別プレイヤーの視点へ切り替えたり、
 * 令の履歴を後から集計したりできる（`05§14`）。
 *
 * ■ `dataHash` がある理由（手順書 §12）
 * マスターデータ（`src/data/*.json`）を 1 つでも変えると、同じ入力でも試合が変わる。
 * それを検出せずに再生すると「**黙って別の試合を見せる**」ことになり、
 * 「どこで判断を間違えたか」を振り返る目的（`05§14`）が果たせない。
 * だから記録時のデータのハッシュを持たせ、**合わなければ再生を拒否**する。
 *
 * ■ ハッシュ列（`hashes`）がある理由
 * 再生した結果が元の試合と一致しているかを、**250 tick ごとに突き合わせる**。
 * 一致しなければ「決定論が壊れた」ことがその場で分かる（T-M15-02 / T-M15-06）。
 */

import type { Command } from '@/sim/command';
import type { CivId, MapTypeId } from '@/shared/types';

/** 記録形式の版。**形を変えたら必ず上げる**（古い記録を黙って読まない）。 */
export const REPLAY_VERSION = 1;

/** 試合の設定（`createMatch` の引数と 1 対 1）。 */
export interface ReplaySetup {
  readonly playerCount: number;
  readonly civs: readonly CivId[];
  readonly mapType: MapTypeId;
  /** チーム番号（省略時は全員別チーム）。 */
  readonly teams?: readonly number[];
  /** プレイヤー名（表示用。試合結果には影響しない）。 */
  readonly names?: readonly string[];
}

/** 1 tick 分の入力（**空の tick は記録しない**）。 */
export interface ReplayFrame {
  readonly tick: number;
  /** playerId → その tick の Command 列（発行順）。 */
  readonly byPlayer: Readonly<Record<number, readonly Command[]>>;
}

/** 突き合わせ用のハッシュ。 */
export interface ReplayHash {
  readonly tick: number;
  readonly hash: number;
}

/** リプレイ 1 本。 */
export interface Replay {
  readonly version: number;
  readonly seed: number;
  readonly setup: ReplaySetup;
  /** 記録時のマスターデータのハッシュ。合わなければ再生しない。 */
  readonly dataHash: string;
  /** 入力の記録（tick 昇順）。 */
  readonly inputs: readonly ReplayFrame[];
  /** 250 tick ごとの状態ハッシュ。 */
  readonly hashes: readonly ReplayHash[];
  /** 記録が終わった tick（試合の長さ）。 */
  readonly endTick: number;
}

/** 再生を拒否する理由。 */
export type ReplayRejectReason =
  | { kind: 'version'; found: number; expected: number }
  | { kind: 'dataHash'; found: string; expected: string }
  | { kind: 'malformed'; detail: string };

/** 検証の結果。 */
export type ReplayCheck = { ok: true } | { ok: false; reason: ReplayRejectReason };

/**
 * リプレイが今のビルドで再生できるかを調べる。
 *
 * **黙って再生しない。** 理由を返して呼び出し側に「なぜ見られないか」を出させる
 * （`05§14` の目的は振り返りなので、別の試合を見せるのは最悪の失敗）。
 */
export function checkReplay(r: Replay, currentDataHash: string): ReplayCheck {
  if (r.version !== REPLAY_VERSION) {
    return { ok: false, reason: { kind: 'version', found: r.version, expected: REPLAY_VERSION } };
  }
  if (r.dataHash !== currentDataHash) {
    return {
      ok: false,
      reason: { kind: 'dataHash', found: r.dataHash, expected: currentDataHash },
    };
  }
  if (!Number.isInteger(r.seed)) {
    return { ok: false, reason: { kind: 'malformed', detail: 'seed が整数でない' } };
  }
  if (r.setup === undefined || !Array.isArray(r.setup.civs)) {
    return { ok: false, reason: { kind: 'malformed', detail: 'setup.civs が無い' } };
  }
  if (r.setup.civs.length !== r.setup.playerCount) {
    return {
      ok: false,
      reason: { kind: 'malformed', detail: 'civs の数が playerCount と合わない' },
    };
  }
  // 入力は tick 昇順・重複なし（順序が崩れると再現できない）
  let prev = -1;
  for (const f of r.inputs) {
    if (!Number.isInteger(f.tick) || f.tick <= prev) {
      return {
        ok: false,
        reason: { kind: 'malformed', detail: `inputs の tick が昇順でない（${f.tick}）` },
      };
    }
    prev = f.tick;
  }
  return { ok: true };
}

/** 拒否理由を人が読める 1 行にする（UI に出す）。 */
export function describeReject(reason: ReplayRejectReason): string {
  switch (reason.kind) {
    case 'version':
      return `記録形式が違います（記録 v${reason.found} / このビルド v${reason.expected}）。このリプレイは再生できません。`;
    case 'dataHash':
      return (
        'ゲームのデータ（ユニットや建物の数値）が記録時と違うため、再生すると別の試合になります。' +
        'このリプレイは再生できません。'
      );
    case 'malformed':
      return `リプレイの中身が壊れています（${reason.detail}）。`;
    default:
      return 'このリプレイは再生できません。';
  }
}

// ---------------------------------------------------------------- 直列化

/**
 * JSON にする（保存用）。
 *
 * gzip は呼び出し側（`CompressionStream` かサーバ）で行う。
 * ここで圧縮まで抱えると、テストで node と browser の差を踏む。
 */
export function serializeReplay(r: Replay): string {
  return JSON.stringify(r);
}

/** JSON から読む。壊れていれば null（例外にしない）。 */
export function parseReplay(text: string): Replay | null {
  try {
    const v = JSON.parse(text) as Replay;
    if (typeof v !== 'object' || v === null) return null;
    if (!Array.isArray(v.inputs) || !Array.isArray(v.hashes)) return null;
    return v;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- 記録

/**
 * 試合中に入力を貯める。
 *
 * **空の tick は記録しない**（30 分 = 45,000 tick のほとんどは入力が無い）。
 * これで 1 試合が数百 KB に収まる（手順書 T-M15-01 の完了条件は 500KB 以内）。
 */
export class ReplayRecorder {
  private readonly frames: ReplayFrame[] = [];
  private readonly hashList: ReplayHash[] = [];
  private endTick = 0;

  constructor(
    readonly seed: number,
    readonly setup: ReplaySetup,
    readonly dataHash: string,
  ) {}

  /**
   * その tick の入力を記録する。
   * `byPlayer` が空（誰も何もしていない）なら**何も記録しない**。
   */
  record(tick: number, byPlayer: Readonly<Record<number, readonly Command[]>>): void {
    this.endTick = tick;
    let any = false;
    for (const key of Object.keys(byPlayer)) {
      if ((byPlayer[Number(key)] ?? []).length > 0) {
        any = true;
        break;
      }
    }
    if (!any) return;
    // playerId 昇順で詰め直す（`stepWorld` に渡す並び順の規約と揃える）
    const sorted: Record<number, readonly Command[]> = {};
    for (const pid of Object.keys(byPlayer)
      .map(Number)
      .sort((a, b) => a - b)) {
      const cmds = byPlayer[pid] ?? [];
      if (cmds.length > 0) sorted[pid] = cmds;
    }
    this.frames.push({ tick, byPlayer: sorted });
  }

  /** 250 tick ごとの状態ハッシュを記録する。 */
  recordHash(tick: number, hash: number): void {
    this.hashList.push({ tick, hash });
  }

  /** 記録を閉じて `Replay` にする。 */
  finish(): Replay {
    return {
      version: REPLAY_VERSION,
      seed: this.seed,
      setup: this.setup,
      dataHash: this.dataHash,
      inputs: this.frames.slice(),
      hashes: this.hashList.slice(),
      endTick: this.endTick,
    };
  }
}

/**
 * リプレイから「その tick の入力」を引く索引。
 *
 * 再生は tick を 1 つずつ進めるので、毎回配列を探すのではなく
 * **tick 昇順の位置を覚えて進む**（45,000 tick × 二分探索を避ける）。
 */
export class ReplayReader {
  private cursor = 0;

  constructor(private readonly replay: Replay) {}

  /** その tick の入力（無ければ空配列）。**tick は昇順に呼ぶこと。** */
  take(tick: number, out: Command[]): Command[] {
    out.length = 0;
    const inputs = this.replay.inputs;
    while (this.cursor < inputs.length && inputs[this.cursor]!.tick < tick) this.cursor++;
    const frame = inputs[this.cursor];
    if (frame === undefined || frame.tick !== tick) return out;
    // playerId 昇順 → 発行順（`stepWorld` の規約）
    for (const pid of Object.keys(frame.byPlayer)
      .map(Number)
      .sort((a, b) => a - b)) {
      for (const c of frame.byPlayer[pid] ?? []) out.push(c);
    }
    return out;
  }

  /** その tick に記録されたハッシュ（無ければ null）。 */
  hashAt(tick: number): number | null {
    for (const h of this.replay.hashes) {
      if (h.tick === tick) return h.hash;
    }
    return null;
  }

  /** 先頭に戻す（巻き戻し再生のため）。 */
  reset(): void {
    this.cursor = 0;
  }
}
