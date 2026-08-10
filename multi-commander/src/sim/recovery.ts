/**
 * 収容（ポッドを自分の手で拾う操作）— T4-⑮。
 *
 * ■ なぜこのファイルがあるか
 * 本作は「撃墜数ではなく、誰を帰したか」を指標に掲げているのに、
 * 救助が「半径に入れば自動で回収」だったため**プレイヤーの操作になっていなかった**。
 * ここは救助を操作に変えるための判定だけを持つ。
 *
 *   1. ポッドの近く（`range`）まで寄る
 *   2. 相対速度を落とす（`relSpeed` 以下 = ほぼ並走）
 *   3. その状態を `holdSeconds` 秒保つ
 *
 * 保持中は減速して直進するしかないので**無防備になる**。
 * だからこそ僚機へ「掩護してくれ」と頼む意味が生まれる（既存の通信メニュー）。
 *
 * ■ 設計方針
 * このファイルは `World` も `Entity` も知らない。入力は「距離と相対速度の数値」だけで、
 * 出力も数値と文言の材料だけ。こうしておくと保持・減衰・完了の全境界を単体テストで固定できる。
 * ワールドから数値を作る側（`MissionRunner.evaluateRescue`）と、
 * 文言を組む側（`src/hud/recoveryHud.ts`）を分けている。
 */

/** 収容の成立条件。ミッション定義（`rescue` 目標）から作る。 */
export interface RecoveryConditions {
  /** 表面間距離の上限 (m)。`ObjectiveSpec.rescue.radius` がそのまま入る */
  range: number;
  /** 相対速度の上限 (m/s) */
  relSpeed: number;
  /** 収容に必要な保持秒数 */
  holdSeconds: number;
}

/**
 * 既定値。**数値の出所はここだけ**（HUD もミッションも同じ値を読む）。
 *
 * - `RECOVERY_DEFAULT_RANGE` 260m: 従来の `rescue` の既定半径をそのまま引き継ぐ。
 *   間合いを変えると既存11ミッションの「近づけば拾える距離感」が動くため。
 * - `RECOVERY_REL_SPEED` 60m/s: ホーネット最大 400m/s の 15%。
 *   スロットル 1〜2 段（10〜20%）まで落とせば入る値で、
 *   「減速せよ」が具体的な操作（スロットルを絞る／`Backspace` で全停止）に対応する。
 *   一方 60m/s では半径 300m の球を最短でも 10 秒かけて通過するので、
 *   上限ぎりぎりの速度でも 3 秒の保持は成立する（＝完全停止を強制しない）。
 * - `RECOVERY_HOLD_SECONDS` 3.0s: 仕様の「数秒静止して収容する」。
 *   3 秒は敵1機の攻撃1パスが通り抜ける長さで、掩護を頼む意味が出る下限。
 *   これ以上長いと、同時に3本のタイマーが走る第1章でポッド3基が現実的でなくなる。
 * - `RECOVERY_DECAY_RATE` 1.5: 条件を外れると進捗は 1.5 倍速で戻る。
 *   0（据え置き）にすると通り過ぎながら小刻みに稼げてしまい「静止して収容」にならない。
 *   即リセットにすると軽い被弾で理不尽に感じるため、戻すが取り返せる値にした。
 * - `RECOVERY_NOTICE_SCALE` 4: 条件の案内を出し始める距離（= `range` の4倍）。
 *   何をすれば良いか分からないまま失敗する（第1章で起きたこと）のを防ぐための猶予。
 */
export const RECOVERY_DEFAULT_RANGE = 260;
export const RECOVERY_REL_SPEED = 60;
export const RECOVERY_HOLD_SECONDS = 3;
export const RECOVERY_DECAY_RATE = 1.5;
export const RECOVERY_NOTICE_SCALE = 4;

/** 既定の条件。`rescue` 目標が上書きしなければこの値で判定する。 */
export const DEFAULT_RECOVERY_CONDITIONS: RecoveryConditions = {
  range: RECOVERY_DEFAULT_RANGE,
  relSpeed: RECOVERY_REL_SPEED,
  holdSeconds: RECOVERY_HOLD_SECONDS,
};

/**
 * 収容が進まない理由。HUD の一行はこれで決まる。
 * `ready` 以外のときは進捗が戻る。
 */
export type RecoveryBlock = 'ready' | 'far' | 'fast' | 'suspended';

/** 収容対象1件の実測値。ワールドから作る側が距離と相対速度を詰める。 */
export interface RecoverySample {
  id: number;
  /** 表示名。`SpawnGroupDef.displayName`（→ `displayNameOf`）由来 */
  name: string;
  /** 表面間距離 (m)。中心間距離から対象の半径を引いた値 */
  distance: number;
  /** 相対速度 (m/s) */
  relSpeed: number;
}

/** HUD へ渡す収容の状態。 */
export interface RecoveryStatus {
  targetId: number;
  name: string;
  /** 保持できている秒数 */
  progress: number;
  /** 必要な保持秒数 */
  need: number;
  distance: number;
  relSpeed: number;
  block: RecoveryBlock;
  /** 条件（HUD が「何をすれば良いか」を出すのに使う） */
  conditions: RecoveryConditions;
}

/** 条件を明示的に組む。未指定は既定値。 */
export function recoveryConditions(
  over?: Partial<RecoveryConditions>,
): RecoveryConditions {
  return {
    range: over?.range ?? DEFAULT_RECOVERY_CONDITIONS.range,
    relSpeed: over?.relSpeed ?? DEFAULT_RECOVERY_CONDITIONS.relSpeed,
    holdSeconds: over?.holdSeconds ?? DEFAULT_RECOVERY_CONDITIONS.holdSeconds,
  };
}

/** 案内を出し始める距離。 */
export function recoveryNoticeRange(cond: RecoveryConditions): number {
  return cond.range * RECOVERY_NOTICE_SCALE;
}

/**
 * この対象がいま収容できるか。
 *
 * 判定の順序に意味がある。遠い間は速度を言わない
 * （「速すぎる」と「遠すぎる」を同時に出すと、どちらを直せば良いか読めない）。
 */
export function recoveryBlockOf(
  sample: RecoverySample,
  cond: RecoveryConditions,
  suspended = false,
): RecoveryBlock {
  if (suspended) return 'suspended';
  if (sample.distance > cond.range) return 'far';
  if (sample.relSpeed > cond.relSpeed) return 'fast';
  return 'ready';
}

/** 1フレーム分の結果。 */
export interface RecoveryUpdate {
  /** この更新で収容が完了した対象 */
  collected: RecoverySample[];
  /** HUD に出す1件（保持中のものを最優先、無ければ一番近いもの） */
  status?: RecoveryStatus;
}

/**
 * 収容の保持状態。対象ごとに「何秒保てているか」を持つ。
 *
 * 複数のポッドが同時に条件を満たす場合は同時に進む（意図的に緩くしている。
 * 既存章のポッドは 900〜1100m 散らばるので、実際にはほぼ起きない）。
 */
export class RecoveryHold {
  private held = new Map<number, number>();

  /** 対象ごとの保持秒（テストと HUD の確認用） */
  progressOf(id: number): number {
    return this.held.get(id) ?? 0;
  }

  reset(): void {
    this.held.clear();
  }

  /** 収容済み・喪失した対象を忘れる */
  forget(id: number): void {
    this.held.delete(id);
  }

  /**
   * 保持を進める。
   *
   * @param dt 固定ステップ秒
   * @param samples いま拾える候補（すでに収容済みのものは呼び側が除く）
   * @param cond 条件
   * @param suspended 発艦・着艦演出中／撃墜演出中など、操作を受け付けない状態
   */
  update(
    dt: number,
    samples: readonly RecoverySample[],
    cond: RecoveryConditions,
    suspended = false,
  ): RecoveryUpdate {
    const collected: RecoverySample[] = [];
    const notice = recoveryNoticeRange(cond);
    let best: RecoveryStatus | undefined;
    const seen = new Set<number>();

    for (const s of samples) {
      seen.add(s.id);
      const block = recoveryBlockOf(s, cond, suspended);
      let progress = this.held.get(s.id) ?? 0;
      if (block === 'ready') {
        progress = Math.min(cond.holdSeconds, progress + dt);
      } else if (progress > 0) {
        progress = Math.max(0, progress - dt * RECOVERY_DECAY_RATE);
      }
      if (progress > 0) this.held.set(s.id, progress);
      else this.held.delete(s.id);

      // 固定ステップの積み上げは丸め誤差で必要秒にわずかに届かないことがあるので、
      // 1フレーム未満の差は達成扱いにする（「あと 0.0001 秒」で止まらないように）。
      if (block === 'ready' && progress >= cond.holdSeconds - 1e-6) {
        collected.push(s);
        this.held.delete(s.id);
        continue;
      }

      // HUD は1件だけ出す。保持が進んでいるものを最優先、
      // どれも進んでいなければ「案内距離の中で一番近いもの」。
      if (progress <= 0 && s.distance > notice) continue;
      const candidate: RecoveryStatus = {
        targetId: s.id,
        name: s.name,
        progress,
        need: cond.holdSeconds,
        distance: s.distance,
        relSpeed: s.relSpeed,
        block,
        conditions: cond,
      };
      if (!best || betterStatus(candidate, best)) best = candidate;
    }

    // 候補から消えた対象（撃たれて失われた・回収された）の保持は捨てる
    for (const id of [...this.held.keys()]) if (!seen.has(id)) this.held.delete(id);

    return { collected, status: best };
  }
}

/** 保持中を優先し、同条件なら近い方を選ぶ。 */
function betterStatus(a: RecoveryStatus, b: RecoveryStatus): boolean {
  if (a.progress !== b.progress) return a.progress > b.progress;
  return a.distance < b.distance;
}
