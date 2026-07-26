import { describe, it, expect } from "vitest";
import { Vector3, Quaternion } from "three";
import { World } from "../src/ecs/World";
import { FlightModelSystem } from "../src/game/systems/FlightModelSystem";
import { Comp } from "../src/game/components";
import type { Transform, RigidBody, FlightModel, ThrusterInput } from "../src/game/components";

function makeShip(world: World, flightAssist: boolean, velocity = new Vector3()) {
  const e = world.createEntity();
  const t: Transform = {
    position: new Vector3(),
    quaternion: new Quaternion(),
    prevPosition: new Vector3(),
    prevQuaternion: new Quaternion(),
  };
  world.add(e, Comp.Transform, t);
  const rb: RigidBody = {
    velocity: velocity.clone(),
    angularVelocity: new Vector3(),
    mass: 10,
    inertia: new Vector3(10, 10, 10),
  };
  world.add(e, Comp.RigidBody, rb);
  const fm: FlightModel = {
    maxLinearSpeed: 200,
    afterburnerMaxSpeed: 400,
    linearThrust: new Vector3(100, 100, 300),
    angularThrust: new Vector3(20, 20, 20),
    linearDamping: 1.0,
    angularDamping: 3.0,
    flightAssist,
  };
  world.add(e, Comp.FlightModel, fm);
  const ti: ThrusterInput = {
    linear: new Vector3(),
    angular: new Vector3(),
    afterburner: false,
    firePrimary: false,
    fireMissile: false,
  };
  world.add(e, Comp.ThrusterInput, ti);
  return { e, t, rb, fm, ti };
}

const DT = 1 / 60;

function step(sys: FlightModelSystem, world: World, n: number) {
  for (let i = 0; i < n; i++) sys.update(world, DT);
}

describe("FlightModelSystem: 6DOFニュートン積分", () => {
  it("フライトアシストOFF・無入力なら慣性で等速直線運動を維持する", () => {
    const world = new World();
    const sys = new FlightModelSystem();
    const { t, rb } = makeShip(world, false, new Vector3(0, 0, 100));
    step(sys, world, 60); // 1秒
    // 速度は保存 (減衰なし)。
    expect(rb.velocity.z).toBeCloseTo(100, 3);
    // 位置は約 100 進む。
    expect(t.position.z).toBeGreaterThan(95);
    expect(t.position.z).toBeLessThan(105);
  });

  it("フライトアシストON・無入力なら速度が減衰する", () => {
    const world = new World();
    const sys = new FlightModelSystem();
    const { rb } = makeShip(world, true, new Vector3(80, 0, 0));
    step(sys, world, 60);
    // 横方向速度は指数減衰でほぼ0付近へ。
    expect(Math.abs(rb.velocity.x)).toBeLessThan(40);
  });

  it("前進スロットルで加速し、最大速度でクランプされる", () => {
    const world = new World();
    const sys = new FlightModelSystem();
    const { rb, ti } = makeShip(world, true);
    ti.linear.set(0, 0, 1); // フルスロットル前進
    step(sys, world, 600); // 10秒
    const speed = rb.velocity.length();
    expect(speed).toBeGreaterThan(150);
    expect(speed).toBeLessThanOrEqual(200 + 1e-3); // maxLinearSpeed
  });

  it("正のピッチ入力で機首が上を向く (機首上げ規約)", () => {
    const world = new World();
    const sys = new FlightModelSystem();
    const { t, ti } = makeShip(world, true);
    ti.angular.set(1, 0, 0); // pitch +1 = 機首上げ
    step(sys, world, 20);
    // 機首(+z)方向のワールドベクトルの y 成分が正 = 上を向いている。
    const fwd = new Vector3(0, 0, 1).applyQuaternion(t.quaternion);
    expect(fwd.y).toBeGreaterThan(0.1);
  });

  it("ヨー入力で姿勢クォータニオンが変化する", () => {
    const world = new World();
    const sys = new FlightModelSystem();
    const { t, ti } = makeShip(world, true);
    const before = t.quaternion.clone();
    ti.angular.set(0, 1, 0); // yaw
    step(sys, world, 30);
    expect(t.quaternion.angleTo(before)).toBeGreaterThan(0.05);
  });

  it("prevPosition が前フレーム位置を保持する (補間用)", () => {
    const world = new World();
    const sys = new FlightModelSystem();
    const { t } = makeShip(world, false, new Vector3(0, 0, 60));
    step(sys, world, 1);
    // 1ステップ後、prevPosition は初期(0)、position は前進。
    expect(t.prevPosition.z).toBeCloseTo(0, 5);
    expect(t.position.z).toBeGreaterThan(0);
  });
});
