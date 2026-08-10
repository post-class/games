/**
 * T5-④ ブラウザで確認できなかった項目を sim レベルで固定する — その2「収容の完遂」。
 *
 * ■ なぜこのテストがあるか
 * 実機（headless）で確認できたのは
 * 「収容準備 — 接近せよ — 残り 807m（300m 以内へ）」までで、
 * **300m 圏へ入って3秒保ち「〈名前〉を収容」に至る流れ**が人手待ちで残っていた
 * （`00_initila_constructions/06_更なる改善/PROGRESS.md`「人手で確認したい項目」2）。
 *
 * ■ 既存テストとの棲み分け（重複させない）
 * - `tests/ut/t4b-recovery.test.ts`: `RecoveryHold` の単体と、
 *   **毎フレーム自機の座標と速度を対象へ貼り付ける**（`recover()`）ミッション判定。
 *   条件境界・演出中の停止・第1章3基の収容可否を固定している。
 * - このファイル: **自機を1回だけ置いたあとは通常のステップ実行で進める**。
 *   速度も姿勢もスロットルも `updateFlight` に任せるので、
 *   「機体を運んで、絞って、保つ」という**操作の並び**そのものが対象になる。
 *   見るのは HUD へ流れる `recovery` イベント（案内 → 準備完了 → 収容）と
 *   `announce`（「〈名前〉を収容」）で、**プレイヤーが画面で見る一行**を通しで追う。
 *   収容の成立を関数呼び出しで捏造しない（`RecoveryHold` を直接叩かない）。
 */
import { Vector3 } from 'three';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DIFFICULTIES } from '../../src/app/settings';
import { VEIL_CH02 } from '../../src/content/veil/missions/ch02';
import { bus } from '../../src/core/events';
import { reseed } from '../../src/core/rng';
import { displayNameOf, MissionRunner } from '../../src/mission/MissionRunner';
import {
  RECOVERY_HOLD_SECONDS,
  RECOVERY_REL_SPEED,
  type RecoveryStatus,
} from '../../src/sim/recovery';
import { setCombatOptions } from '../../src/sim/combat';
import { simulateStep } from '../../src/sim/step';
import type { Entity } from '../../src/world/entity';
import { World } from '../../src/world/world';
import { aimAssistStrength } from '../../src/app/settings';

const DT = 1 / 60;
/** ch02 の rescue 目標の条件距離 (m) */
const RANGE = 300;

const easy = DIFFICULTIES.easy;

interface Harness {
  world: World;
  runner: MissionRunner;
  /** HUD へ流れた収容表示の履歴 */
  views: RecoveryStatus[];
  /** 「消した」通知の回数 */
  cleared: number;
  announces: string[];
  dispose: () => void;
}

function stepOptions() {
  return {
    flightMode: 'wc' as const,
    ai: { maxAttackersOnPlayer: easy.maxAttackers },
    playerWeaponModifiers: easy,
    aimAssist: aimAssistStrength(true, easy.strongAimHelp),
  };
}

/** 第2章を建てて、漂流者3基が出る NAV 2 まで運ぶ */
function startAtDrifters(seed: number): Harness {
  reseed(seed);
  const world = new World();
  setCombatOptions({
    playerDamageTaken: easy.playerDamageTaken,
    playerDamageDealt: easy.playerDamageDealt,
    playerSubsystemRate: easy.playerSubsystemRate,
  });
  const runner = new MissionRunner(
    world,
    VEIL_CH02,
    { shipId: VEIL_CH02.playerShipId },
    easy,
  );
  const views: RecoveryStatus[] = [];
  const announces: string[] = [];
  let cleared = 0;
  const offs = [
    bus.on('recovery', (p) => {
      if (p.active && p.view) views.push({ ...p.view });
      else cleared += 1;
    }),
    bus.on('announce', (p) => announces.push(p.text)),
  ];
  runner.build();
  runner.update(DT);

  const h: Harness = {
    world,
    runner,
    views,
    announces,
    get cleared() {
      return cleared;
    },
    dispose: () => {
      for (const off of offs) off();
      runner.dispose();
    },
  } as Harness;

  // NAV 1 → NAV 2。Nav は最小の未到達 index から順にしか取れない
  for (const index of [0, 1]) {
    const p = world.player!;
    p.pos.set(...VEIL_CH02.navs[index].pos);
    p.prevPos.copy(p.pos);
    p.renderPrevPos.copy(p.pos);
    step(h, 0.5);
  }
  return h;
}

/** 通常のステップ実行。座標も速度も触らない */
function step(h: Harness, seconds: number): void {
  const steps = Math.max(1, Math.round(seconds / DT));
  const opts = stepOptions();
  for (let i = 0; i < steps; i++) {
    simulateStep(h.world, DT, opts);
    h.runner.update(DT);
  }
}

function drifters(h: Harness): Entity[] {
  return h.world.entities.filter((e) => e.alive && e.tag === 'rescue');
}

/**
 * 自機を対象の手前 `distance` m へ**1回だけ**置く。
 * 以後は通常のステップで進むので、速度は `updateFlight` が決める。
 */
function placeNear(h: Harness, target: Entity, distance: number): void {
  const p = h.world.player!;
  const dir = new Vector3(0, 0, 1);
  p.pos.copy(target.pos).addScaledVector(dir, distance + target.radius);
  p.prevPos.copy(p.pos);
  p.renderPrevPos.copy(p.pos);
  p.vel.set(0, 0, 0);
  p.input!.throttle = 0;
  p.input!.afterburner = false;
}

/**
 * 対象と反対の方向へ機首を向ける（旋回して離脱する操作の代わり）。
 * これをせずに全開にすると対象へ突っ込んで衝突で壊してしまう。
 */
function turnAwayFrom(h: Harness, target: Entity): void {
  const p = h.world.player!;
  const away = new Vector3().copy(p.pos).sub(target.pos).normalize();
  p.quat.setFromUnitVectors(new Vector3(0, 0, -1), away);
  p.angVel.set(0, 0, 0);
}

/** 収容表示のうち、その対象の最後の1件 */
function lastViewOf(h: Harness, id: number): RecoveryStatus | undefined {
  for (let i = h.views.length - 1; i >= 0; i--) if (h.views[i].targetId === id) return h.views[i];
  return undefined;
}

function maxProgressOf(h: Harness, id: number): number {
  let max = 0;
  for (const v of h.views) if (v.targetId === id && v.progress > max) max = v.progress;
  return max;
}

let active: Harness | undefined;
beforeEach(() => {
  setCombatOptions({ playerDamageTaken: 1, playerDamageDealt: 1, playerSubsystemRate: 1 });
});
afterEach(() => {
  active?.dispose();
  active = undefined;
  setCombatOptions({ playerDamageTaken: 1, playerDamageDealt: 1, playerSubsystemRate: 1 });
});

describe('第2章の漂流者を実際に収容するまで通す', () => {
  it('案内（接近せよ）から 300m 圏の準備完了、3秒で収容まで一続きに進む', () => {
    const h = (active = startAtDrifters(0x5d20001));
    const pod = drifters(h)[0];
    expect(pod).toBeDefined();
    const name = displayNameOf(pod);
    expect(name.length).toBeGreaterThan(0);

    // ① 案内距離の中・条件距離の外（実機で止まっていた「接近せよ」の状態）
    placeNear(h, pod, 800);
    step(h, 0.5);
    const far = lastViewOf(h, pod.id)!;
    expect(far.block).toBe('far');
    expect(far.progress).toBe(0);
    expect(far.distance).toBeGreaterThan(RANGE);
    expect(far.conditions.range).toBe(RANGE);
    expect(far.conditions.holdSeconds).toBe(RECOVERY_HOLD_SECONDS);

    // ② 300m 圏へ入って絞る。以後は普通のステップだけ
    placeNear(h, pod, 200);
    step(h, 0.5);
    const ready = lastViewOf(h, pod.id)!;
    expect(ready.block).toBe('ready');
    expect(ready.distance).toBeLessThanOrEqual(RANGE);
    expect(ready.relSpeed).toBeLessThanOrEqual(RECOVERY_REL_SPEED);
    expect(ready.progress).toBeGreaterThan(0);
    expect(ready.progress).toBeLessThan(RECOVERY_HOLD_SECONDS);

    // ③ 3秒保つ → 収容。バーが必要秒まで伸びていたことも見る
    step(h, RECOVERY_HOLD_SECONDS);
    expect(maxProgressOf(h, pod.id)).toBeGreaterThan(RECOVERY_HOLD_SECONDS * 0.8);
    const s = h.runner.summary();
    expect(s.rescued).toBe(1);
    expect(s.rescuedNames).toEqual([name]);
    // 対象は戦域から外れる（以後は守る必要がない）
    expect(h.world.byId(pod.id)).toBeUndefined();
    // 画面に出る一行（実機で見たかったもの）
    expect(h.announces).toContain(`${name} を収容`);
  });

  it('保持中に加速すると進捗が巻き戻り、戻ってやり直せる', () => {
    const h = (active = startAtDrifters(0x5d20002));
    const pod = drifters(h)[0];

    placeNear(h, pod, 180);
    step(h, 1.5);
    const held = maxProgressOf(h, pod.id);
    expect(held).toBeGreaterThan(1);
    expect(held).toBeLessThan(RECOVERY_HOLD_SECONDS);
    expect(h.runner.summary().rescued).toBe(0);

    // 機首を反対へ向けて全開にする（以後は入力だけ。座標には触らない）
    turnAwayFrom(h, pod);
    h.world.player!.input!.throttle = 1;
    step(h, 3);
    // 対象は生きたまま置いていく（ぶつけて壊したのではない）
    expect(pod.alive).toBe(true);
    expect(pod.pos.distanceTo(h.world.player!.pos)).toBeGreaterThan(RANGE);
    const after = lastViewOf(h, pod.id);
    // 収容されないまま、進捗は保持できた値より戻っている
    expect(h.runner.summary().rescued).toBe(0);
    expect(after?.progress ?? 0).toBeLessThan(held);

    // 戻って絞り直せば収容できる（詰みではない）
    placeNear(h, pod, 150);
    step(h, RECOVERY_HOLD_SECONDS + 0.6);
    expect(h.runner.summary().rescued).toBe(1);
    expect(h.runner.summary().rescuedNames).toEqual([displayNameOf(pod)]);
  });

  it('速すぎる間は「減速せよ」のまま進まない', () => {
    const h = (active = startAtDrifters(0x5d20003));
    const pod = drifters(h)[0];

    // 条件距離の中に置くが、相対速度の上限を超える速度を持たせる
    placeNear(h, pod, 120);
    const p = h.world.player!;
    p.vel.copy(pod.vel).addScaledVector(new Vector3(0, 1, 0), RECOVERY_REL_SPEED * 2);
    step(h, 0.2);
    const fast = lastViewOf(h, pod.id)!;
    expect(fast.block).toBe('fast');
    expect(fast.relSpeed).toBeGreaterThan(RECOVERY_REL_SPEED);
    expect(fast.progress).toBe(0);
    expect(h.runner.summary().rescued).toBe(0);
  });

  it('3基すべて連れて帰れて、rescued と rescuedNames と目標が揃う', () => {
    const h = (active = startAtDrifters(0x5d20004));
    const pods = drifters(h);
    expect(pods).toHaveLength(3);
    const names = pods.map((e) => displayNameOf(e));
    // 名前の出所はミッション定義の displayNames だけ（HUD で作らない）
    const declared = VEIL_CH02.spawns.find((g) => g.shipId === 'escape-pod')!.displayNames!;
    for (const n of names) expect(declared).toContain(n);

    for (const pod of pods) {
      placeNear(h, pod, 160);
      step(h, RECOVERY_HOLD_SECONDS + 0.6);
    }
    const s = h.runner.summary();
    expect(s.rescued).toBe(3);
    expect(s.rescuedNames).toEqual(names);
    expect(s.rescuedNames).toHaveLength(s.rescued);
    expect(
      s.objectives.find((o) => o.text.includes('漂流者3名'))?.state,
      JSON.stringify(s.objectives),
    ).toBe('done');
    // 収容ごとに1行ずつ出る（まとめて1行にしない）
    for (const n of names) expect(h.announces).toContain(`${n} を収容`);
    // 収容が終われば表示は消える（消す通知は出しっぱなしにしない）
    step(h, 0.5);
    expect(h.cleared).toBeGreaterThan(0);
  });
});
