import { Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import {
  aimError,
  damp,
  forwardOf,
  integrateRotation,
  leadPoint,
  moveTowards,
  upOf,
} from '../../src/core/math';

describe('math ヘルパー', () => {
  it('moveTowards は目標を越えない', () => {
    expect(moveTowards(0, 1, 0.3)).toBeCloseTo(0.3);
    expect(moveTowards(0, 1, 5)).toBe(1);
    expect(moveTowards(1, -1, 0.5)).toBeCloseTo(0.5);
  });

  it('damp は halfLife 秒で差が半分になる', () => {
    expect(damp(1, 0, 0.5, 0.5)).toBeCloseTo(0.5);
    expect(damp(1, 0, 0.5, 1)).toBeCloseTo(0.25);
  });

  it('forwardOf は既定姿勢で -Z を向く', () => {
    const f = forwardOf(new Quaternion());
    expect(f.x).toBeCloseTo(0);
    expect(f.y).toBeCloseTo(0);
    expect(f.z).toBeCloseTo(-1);
  });
});

describe('姿勢の積分', () => {
  it('ωx が正だと機首が上がる (pitch up)', () => {
    const q = new Quaternion();
    // 0.5 rad ぶん機首上げ
    for (let i = 0; i < 100; i++) integrateRotation(q, new Vector3(0.5, 0, 0), 0.01);
    const f = forwardOf(q);
    expect(f.y).toBeGreaterThan(0.4);
    expect(f.z).toBeLessThan(0);
  });

  it('ωy が負だと機首が右を向く (yaw right)', () => {
    const q = new Quaternion();
    for (let i = 0; i < 100; i++) integrateRotation(q, new Vector3(0, -0.5, 0), 0.01);
    const f = forwardOf(q);
    expect(f.x).toBeGreaterThan(0.4);
  });

  it('ωz が負だと右ロールになる (上ベクトルが右へ倒れる)', () => {
    const q = new Quaternion();
    for (let i = 0; i < 100; i++) integrateRotation(q, new Vector3(0, 0, -0.5), 0.01);
    const u = upOf(q);
    expect(u.x).toBeGreaterThan(0.4);
  });

  it('積分後も単位クォータニオンを保つ', () => {
    const q = new Quaternion();
    for (let i = 0; i < 500; i++) integrateRotation(q, new Vector3(1.3, -0.9, 2.2), 1 / 60);
    expect(q.length()).toBeCloseTo(1, 6);
  });
});

describe('aimError', () => {
  it('真正面ならずれ 0', () => {
    const e = aimError(new Quaternion(), new Vector3(0, 0, -100));
    expect(e.angle).toBeCloseTo(0);
    expect(e.pitch).toBeCloseTo(0);
    expect(e.yaw).toBeCloseTo(0);
  });

  it('上にある目標は pitch が正になる', () => {
    const e = aimError(new Quaternion(), new Vector3(0, 50, -100));
    expect(e.pitch).toBeGreaterThan(0);
  });

  it('右にある目標は yaw が正になる', () => {
    const e = aimError(new Quaternion(), new Vector3(50, 0, -100));
    expect(e.yaw).toBeGreaterThan(0);
  });

  it('真後ろの目標は角度が pi 近く', () => {
    const e = aimError(new Quaternion(), new Vector3(0, 0, 100));
    expect(e.angle).toBeCloseTo(Math.PI, 3);
  });
});

describe('leadPoint (偏差射撃)', () => {
  it('静止目標なら目標位置そのまま', () => {
    const p = leadPoint(new Vector3(), new Vector3(0, 0, -100), new Vector3(), 1000);
    expect(p.z).toBeCloseTo(-100);
  });

  it('横切る目標には進行方向へ先を読む', () => {
    // 目標は +X 方向へ 200/s。弾速 1000, 距離 1000 → 到達 1 秒 → 約 +200
    const p = leadPoint(new Vector3(), new Vector3(0, 0, -1000), new Vector3(200, 0, 0), 1000);
    expect(p.x).toBeGreaterThan(150);
    expect(p.x).toBeLessThan(260);
  });

  it('射点への距離 / 弾速 が飛行時間と一致する', () => {
    const shooter = new Vector3();
    const tpos = new Vector3(300, 0, -800);
    const tvel = new Vector3(-120, 40, 60);
    const speed = 900;
    const p = leadPoint(shooter, tpos, tvel, speed);
    const t = p.distanceTo(shooter) / speed;
    const expected = tpos.clone().addScaledVector(tvel, t);
    expect(p.distanceTo(expected)).toBeLessThan
      (1e-3);
  });

  it('弾より速く逃げる目標では解なしで現在位置を返す', () => {
    const p = leadPoint(new Vector3(), new Vector3(0, 0, -100), new Vector3(0, 0, -500), 100);
    expect(p.z).toBeCloseTo(-100);
  });
});
