import { describe, it, expect } from "vitest";
import { MouseFlightStick } from "../src/game/input/MouseFlightStick";

// vitest のデフォルト環境は "node" で、vitest.config.ts / vite.config.ts に
// environment: "jsdom" の設定がなく、jsdom も devDependencies に入っていない。
// InputManager は window/document の addEventListener に依存するため、
// DOM環境の追加は別タスクとし、ここでは DOM 不要な MouseFlightStick のみをテストする。

const VIEWPORT = { w: 1920, h: 1080 };

function makeStick(config?: Partial<ConstructorParameters<typeof MouseFlightStick>[1]>) {
  const stick = new MouseFlightStick(() => VIEWPORT, config);
  stick.enabled = true;
  return stick;
}

describe("MouseFlightStick", () => {
  it("中央位置では pitch=0, yaw=0 を返す", () => {
    const stick = makeStick();
    stick.onMouseMove(VIEWPORT.w / 2, VIEWPORT.h / 2);
    const { pitch, yaw } = stick.sample();
    expect(pitch).toBe(0);
    expect(yaw).toBe(0);
  });

  it("右端では yaw がほぼ +1 に近い値を返す", () => {
    const stick = makeStick();
    stick.onMouseMove(VIEWPORT.w, VIEWPORT.h / 2);
    const { yaw } = stick.sample();
    expect(yaw).toBeGreaterThan(0.9);
    expect(yaw).toBeLessThanOrEqual(1);
  });

  it("上端では pitch が正の値 (機首上げ) を返す", () => {
    const stick = makeStick();
    // 画面上端 = clientY 0 => dy = -1 => invertY=false なら pitchSign=-1 => pitch = +1
    stick.onMouseMove(VIEWPORT.w / 2, 0);
    const { pitch } = stick.sample();
    expect(pitch).toBeGreaterThan(0);
  });

  it("デッドゾーン内 (中央付近の小さな移動) では 0 を返す", () => {
    const stick = makeStick({ deadzone: 0.06 });
    // 中央から数ピクセルのずれ (デッドゾーン閾値未満) を与える
    stick.onMouseMove(VIEWPORT.w / 2 + 2, VIEWPORT.h / 2 + 2);
    const { pitch, yaw } = stick.sample();
    expect(pitch).toBe(0);
    expect(yaw).toBe(0);
  });

  it("感度 2.0 は感度 1.0 より大きな値を返す", () => {
    const stickLow = makeStick({ sensitivity: 1.0 });
    const stickHigh = makeStick({ sensitivity: 2.0 });
    const x = VIEWPORT.w / 2 + VIEWPORT.w * 0.2; // 中央から適度にずらす
    stickLow.onMouseMove(x, VIEWPORT.h / 2);
    stickHigh.onMouseMove(x, VIEWPORT.h / 2);
    const yawLow = stickLow.sample().yaw;
    const yawHigh = stickHigh.sample().yaw;
    expect(yawHigh).toBeGreaterThan(yawLow);
  });

  it("invertY=true で同じ位置での pitch の符号が反転する", () => {
    const stickNormal = makeStick({ invertY: false });
    const stickInverted = makeStick({ invertY: true });
    // 中央より上 (clientY小さい)
    const y = VIEWPORT.h / 2 - VIEWPORT.h * 0.2;
    stickNormal.onMouseMove(VIEWPORT.w / 2, y);
    stickInverted.onMouseMove(VIEWPORT.w / 2, y);
    const pitchNormal = stickNormal.sample().pitch;
    const pitchInverted = stickInverted.sample().pitch;
    expect(pitchNormal).toBeGreaterThan(0);
    expect(pitchInverted).toBeLessThan(0);
    expect(Math.sign(pitchNormal)).toBe(-Math.sign(pitchInverted));
  });

  it("enabled=false のときは常に {pitch: 0, yaw: 0} を返す", () => {
    const stick = makeStick();
    stick.onMouseMove(VIEWPORT.w, 0); // 端に動かしても
    stick.enabled = false;
    const { pitch, yaw } = stick.sample();
    expect(pitch).toBe(0);
    expect(yaw).toBe(0);
  });

  it("resetToCenter 呼び出し後は {pitch: 0, yaw: 0} を返す", () => {
    const stick = makeStick();
    stick.onMouseMove(VIEWPORT.w, 0);
    // 中心に戻す前は 0 ではないはず
    expect(stick.sample().yaw).not.toBe(0);
    stick.resetToCenter();
    const { pitch, yaw } = stick.sample();
    expect(pitch).toBe(0);
    expect(yaw).toBe(0);
  });
});
