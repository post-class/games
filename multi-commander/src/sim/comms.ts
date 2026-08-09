import { Vector3 } from 'three';
import { leadPoint } from '../core/math';
import type { Entity } from '../world/entity';
import type { World } from '../world/world';

/**
 * 味方間の通信遅延（第6章 T6-6 の通信妨害）。
 *
 * ■ なぜ「ミッション単位のモジュール状態」にしたか
 * `src/sim/obstacles.ts` の熱紋機雷（T6-3）と同じ流儀に合わせている。
 * 遅延は個々の機体の属性ではなく「その作戦の宙域にかかる規則」であり、
 * `Entity` にフィールドを足すと `world.ts` / `entity.ts` の生成・複製経路すべてに
 * 波及して既存11ミッションの機体を巻き込む。
 * `MissionRunner.build()` が必ず `resetCommsDelay()` を呼ぶので、
 * 宣言のないミッションは**完全に従来どおり**（遅延 0 = 実位置をそのまま返す）。
 *
 * ■ 遅延させる対象
 * 妨害されているのは「味方同士の通信」なので、
 * **自機と同じ陣営の他機だけ**を遅らせる。自機は自分の位置を知っているので遅れず、
 * 敵機・非敵対の他勢力はこちらのデータリンクに載っていない（自分の目とレーダーで
 * 見ている）ので遅れない。
 *
 * ■ 表示と照準支援を同じ出所から作る
 * `AI_CODING.md` の「表示だけ変えて実挙動が変わらない状態を作らない」に従い、
 * HUD の位置表示・距離・レーダー・航法マップと、ITTS の照準支援（`reportedLeadPoint`）
 * がすべてこのモジュールの返す「報告位置」を使う。
 * 「表示は3秒古いのに照準だけ正確」という状態を作らない。
 */

/** 位置履歴を刻む間隔 (秒)。3秒の遅延に対して十分な分解能で、確保する標本数を抑える */
const SAMPLE_INTERVAL = 0.1;

interface CommsSample {
  /** 記録時刻 (ミッション開始からの経過秒) */
  t: number;
  pos: Vector3;
  vel: Vector3;
}

interface CommsDelayState {
  /** 味方の位置報告が遅れる秒数。0 なら遅延なし (既定) */
  friendlySeconds: number;
  /** 直近に記録した時刻 */
  now: number;
}

const state: CommsDelayState = { friendlySeconds: 0, now: 0 };
const history = new Map<number, CommsSample[]>();

/** 通信遅延を既定 (遅延なし) に戻す。ミッション開始ごとに呼ぶ */
export function resetCommsDelay(): void {
  state.friendlySeconds = 0;
  state.now = 0;
  history.clear();
}

/** 味方位置の報告遅延を設定する (秒) */
export function configureCommsDelay(o: { friendlySeconds?: number }): void {
  if (o.friendlySeconds !== undefined) {
    state.friendlySeconds = Math.max(0, o.friendlySeconds);
  }
}

/** いま効いている味方位置の遅延秒数 (0 なら妨害なし)。HUD 表示とテストが読む */
export function commsDelaySeconds(): number {
  return state.friendlySeconds;
}

/**
 * 味方機の位置履歴を1フレーム分記録する。
 * 遅延が宣言されていないミッションでは何もしない (履歴も持たない)。
 */
export function recordCommsPositions(world: World, time: number): void {
  if (state.friendlySeconds <= 0) return;
  const player = world.player;
  if (!player) return;
  state.now = time;
  const keep = state.friendlySeconds + SAMPLE_INTERVAL * 3;

  for (const e of world.entities) {
    if (!e.alive || e.kind !== 'ship' || !e.ship) continue;
    if (e.id === player.id) continue;
    // 遅れるのは味方同士のデータリンクだけ。敵と非敵対の他勢力は遅らせない
    if (e.faction !== player.faction) continue;

    let buf = history.get(e.id);
    if (!buf) {
      buf = [];
      history.set(e.id, buf);
    }
    const last = buf[buf.length - 1];
    if (!last || time - last.t >= SAMPLE_INTERVAL) {
      buf.push({ t: time, pos: e.pos.clone(), vel: e.vel.clone() });
    }
    // 遅延ぶんより古い標本は捨てる (1つだけ残して「まだ届いていない」時間帯を埋める)
    while (buf.length > 2 && buf[1].t < time - keep) buf.shift();
  }
}

/**
 * その機体の「報告されている」標本。
 * 遅延が無い / 履歴が無い相手は undefined を返す (= 実位置を使う)。
 */
function sampleFor(e: Entity): CommsSample | undefined {
  if (state.friendlySeconds <= 0) return undefined;
  const buf = history.get(e.id);
  if (!buf || buf.length === 0) return undefined;
  const want = state.now - state.friendlySeconds;
  let found: CommsSample | undefined;
  for (const s of buf) {
    if (s.t > want) break;
    found = s;
  }
  // 出撃直後は3秒前の記録が無い。最も古い記録 (発艦位置) を報告する
  return found ?? buf[0];
}

/** その機体の位置が遅れて届いているか (テストと表示用) */
export function isPositionDelayed(e: Entity): boolean {
  return sampleFor(e) !== undefined;
}

/**
 * HUD・航法マップ・照準支援が使う「報告位置」。
 * 遅延対象なら3秒前の位置、それ以外は実位置。
 */
export function reportedPosition(e: Entity, out?: Vector3): Vector3 {
  const s = sampleFor(e);
  const src = s ? s.pos : e.pos;
  return out ? out.copy(src) : src;
}

/** 報告位置と同じ時刻の速度。距離の増減表示とリード計算を同じ時刻に揃える */
export function reportedVelocity(e: Entity, out?: Vector3): Vector3 {
  const s = sampleFor(e);
  const src = s ? s.vel : e.vel;
  return out ? out.copy(src) : src;
}

/**
 * ITTS の射点 (照準支援)。
 *
 * 遅延対象の相手には報告位置・報告速度を使うので、
 * 「味方をターゲットに取ったときの照準」も HUD の距離表示と同じだけ古くなる。
 * 敵に対しては実位置・実速度なので、既存ミッションの照準は一切変わらない。
 */
export function reportedLeadPoint(
  self: Entity,
  target: Entity,
  gunSpeed: number,
  out = new Vector3(),
): Vector3 {
  const s = sampleFor(target);
  return leadPoint(self.pos, s ? s.pos : target.pos, s ? s.vel : target.vel, gunSpeed, out);
}
