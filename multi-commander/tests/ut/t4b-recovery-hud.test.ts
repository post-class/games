/**
 * T4-⑮ の HUD 側。
 *
 * 収容の進捗と条件は `recovery` イベント経由で HUD に届く
 * （`game.ts` に配線を足さずに済ませるため）。ここでは
 *
 *  - イベントが来たら DOM に「収容中 2.4s / 3.0s」と、何をすれば良いかが出る
 *  - `active: false` で消える
 *  - 任務をまたいで残らない（`resetTransientState`）
 *
 * を固定する。DOM を持たない node 環境なので `fake-dom.ts` の `FakeElement` を使う。
 */
import { PerspectiveCamera, Vector3 } from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HudView } from '../../src/hud/HudView';
import { resetSettings } from '../../src/app/settings';
import { shipDef } from '../../src/content/ships';
import { bus } from '../../src/core/events';
import { recoveryConditions, type RecoveryStatus } from '../../src/sim/recovery';
import { spawnShip, World } from '../../src/world/world';
import { FakeElement } from './fake-dom';

let nowMs = 0;

class El extends FakeElement {
  override get classList() {
    const base = super.classList;
    return {
      ...base,
      toggle: (name: string, on?: boolean) => {
        const want = on === undefined ? !base.contains(name) : on;
        if (want) base.add(name);
        else base.remove(name);
      },
    };
  }
}

function walk(root: FakeElement, visit: (el: FakeElement) => void): void {
  visit(root);
  root.children.forEach((c) => walk(c, visit));
}

function find(root: FakeElement, className: string): FakeElement {
  let hit: FakeElement | undefined;
  walk(root, (el) => {
    if (!hit && el.classNames().includes(className)) hit = el;
  });
  if (!hit) throw new Error(`要素が見つからない: .${className}`);
  return hit;
}

function setup() {
  const container = new El('div');
  const hud = new HudView(container as unknown as HTMLElement);
  const world = new World();
  const player = spawnShip(world, {
    def: shipDef('hornet'),
    faction: 'confed',
    pos: new Vector3(),
    speed: 0,
    label: '自機',
    pilot: 'あなた',
  });
  world.playerId = player.id;
  const camera = new PerspectiveCamera(70, 16 / 9, 0.5, 60000);
  const frame = {
    world,
    camera,
    width: 1280,
    height: 720,
    throttle: 0.1,
    mouseFlight: false,
    objectives: [{ text: '脱出ポッド3基を収容する', state: 'active' as const }],
    visible: true,
  };
  return { container, hud, world, player, frame };
}

const status = (over: Partial<RecoveryStatus> = {}): RecoveryStatus => ({
  targetId: 1,
  name: '相沢 紗良',
  progress: 2.4,
  need: 3,
  distance: 120,
  relSpeed: 4,
  block: 'ready',
  conditions: recoveryConditions({ range: 300 }),
  ...over,
});

describe('HUD: 収容の進捗と条件 (T4-⑮)', () => {
  beforeEach(() => {
    nowMs = 0;
    resetSettings();
    vi.stubGlobal('document', {
      createElement: (tag: string) => new El(tag),
      createElementNS: (_ns: string, tag: string) => new El(tag),
      body: new El('body'),
    });
    vi.stubGlobal('performance', { now: () => nowMs });
  });

  afterEach(() => {
    bus.clear();
    vi.unstubAllGlobals();
  });

  it('既定では収容の表示は出ていない', () => {
    const { container, hud, frame } = setup();
    hud.update(frame, 1 / 60);
    expect(find(container, 'mc-recovery').style.display).toBe('none');
    expect(hud.recoveryVisible).toBe(false);
  });

  it('保持中は秒数と搭乗者名、進捗バーが出る', () => {
    const { container, hud, frame } = setup();
    hud.update(frame, 1 / 60);
    bus.emit('recovery', { active: true, view: status() });
    expect(hud.recoveryVisible).toBe(true);
    expect(find(container, 'mc-recovery-title').textContent).toContain('収容中 2.4s / 3.0s');
    expect(find(container, 'mc-recovery-title').textContent).toContain('相沢 紗良');
    expect(find(container, 'mc-recovery-bar').style.width).toBe('80%');
  });

  it('速すぎるときは減速の指示が出る (何をすれば良いかが読める)', () => {
    const { container, hud, frame } = setup();
    hud.update(frame, 1 / 60);
    bus.emit('recovery', {
      active: true,
      view: status({ block: 'fast', relSpeed: 210, progress: 0 }),
    });
    const advice = find(container, 'mc-recovery-advice').textContent;
    expect(advice).toContain('速すぎる');
    expect(advice).toContain('減速');
    expect(find(container, 'mc-recovery-bar').style.width).toBe('0%');
  });

  it('遠いときは接近の指示が出る', () => {
    const { container, hud, frame } = setup();
    hud.update(frame, 1 / 60);
    bus.emit('recovery', {
      active: true,
      view: status({ block: 'far', distance: 1000, progress: 0 }),
    });
    expect(find(container, 'mc-recovery-advice').textContent).toContain('接近せよ');
  });

  it('active: false で消える', () => {
    const { hud, frame } = setup();
    hud.update(frame, 1 / 60);
    bus.emit('recovery', { active: true, view: status() });
    expect(hud.recoveryVisible).toBe(true);
    bus.emit('recovery', { active: false });
    expect(hud.recoveryVisible).toBe(false);
  });

  it('任務をまたいで残らない', () => {
    const { hud, frame } = setup();
    hud.update(frame, 1 / 60);
    bus.emit('recovery', { active: true, view: status() });
    hud.resetTransientState();
    expect(hud.recoveryVisible).toBe(false);
  });
});
