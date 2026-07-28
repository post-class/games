import { describe, it, expect } from "vitest";
import { Vector3 } from "three";
import { computeLeadPosition } from "../src/hud/ReticleCalc";

describe("computeLeadPosition: 命中予測点", () => {
  it("静止ターゲットならターゲット位置そのもの", () => {
    const shooter = new Vector3(0, 0, 0);
    const target = new Vector3(0, 0, 1000);
    const lead = computeLeadPosition(shooter, 1000, target, new Vector3(0, 0, 0));
    expect(lead.distanceTo(target)).toBeLessThan(1e-6);
  });

  it("横移動するターゲットは進行方向へリードする", () => {
    const shooter = new Vector3(0, 0, 0);
    const target = new Vector3(0, 0, 1000);
    // 弾速1000, 距離1000 -> 到達約1秒。ターゲットは +x に 100/s。
    const lead = computeLeadPosition(shooter, 1000, target, new Vector3(100, 0, 0));
    // リードは +x 側へずれる。
    expect(lead.x).toBeGreaterThan(50);
  });

  it("反復が収束し、予測点までの飛翔時間が一貫する", () => {
    const shooter = new Vector3(0, 0, 0);
    const speed = 800;
    const target = new Vector3(0, 0, 1200);
    const vel = new Vector3(120, 40, 0);
    const lead = computeLeadPosition(shooter, speed, target, vel);
    const t = shooter.distanceTo(lead) / speed;
    // lead == target + vel*t を満たすはず。
    const expected = target.clone().addScaledVector(vel, t);
    expect(lead.distanceTo(expected)).toBeLessThan(1.0);
  });

  it("弾速0なら現在位置を返す", () => {
    const lead = computeLeadPosition(new Vector3(), 0, new Vector3(5, 5, 5), new Vector3(9, 9, 9));
    expect(lead.equals(new Vector3(5, 5, 5))).toBe(true);
  });
});
