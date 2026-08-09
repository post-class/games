import { PerspectiveCamera, Vector3 } from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HudView } from '../../src/hud/HudView';
import { resetSettings, settings } from '../../src/app/settings';
import { shipDef } from '../../src/content/ships';
import { spawnShip, World } from '../../src/world/world';
import { FakeElement } from './fake-dom';

/**
 * T1-② の HUD 側。
 *
 * - ハル危険域で赤い縁取りと脱出案内が出る（`reducedFlashes` では点滅させない）
 * - 戦死・自機撃墜を画面中央に別枠で出す
 * - 外部視点ではダッシュボード（DOM の計器盤）を隠し、最小 HUD に置き換える
 *
 * DOM を持たない既定の node 環境なので、`fake-dom.ts` の `FakeElement` を使って
 * `document` を差し替える（SVG も同じ要素で代用する）。
 */

let nowMs = 0;

/**
 * `classList.toggle` を足した最小要素。
 * 共有の `fake-dom.ts` を書き換えずに、HUD が使う API だけを補う。
 */
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
    def: shipDef('rapier'),
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
    throttle: 0.8,
    mouseFlight: false,
    objectives: [{ text: '輸送船を帰投航路に乗せる', state: 'active' as const }],
    visible: true,
  };
  return { container, hud, world, player, frame };
}

describe('HUD: ハル危険域と戦死の見せ方', () => {
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
    vi.unstubAllGlobals();
  });

  it('ハルが健全なら赤い縁取りも脱出案内も出ない', () => {
    const { container, hud, frame } = setup();
    hud.update(frame, 1 / 60);
    expect(find(container, 'mc-hulldanger').style.display).toBe('none');
    expect(find(container, 'mc-warnlights').children.some((c) => c.classNames().includes('on'))).toBe(
      false,
    );
  });

  it('ハル 30% 以下で画面周辺が赤くなり、Alt+E の案内が点く', () => {
    const { container, hud, frame, player } = setup();
    const ship = player.ship!;
    ship.hull = ship.def.hull * 0.25;
    hud.update(frame, 1 / 60);

    const danger = find(container, 'mc-hulldanger');
    expect(danger.style.display).toBe('');
    expect(Number(danger.style.opacity)).toBeGreaterThan(0);

    const light = find(container, 'mc-warnlights').children.find((c) =>
      c.textContent.includes('Alt+E'),
    );
    expect(light).toBeTruthy();
    expect(light!.classNames()).toContain('on');
    expect(light!.textContent).toContain('ハル危険域');
  });

  it('ハル 31% では危険域にしない（境界の外）', () => {
    const { container, hud, frame, player } = setup();
    const ship = player.ship!;
    ship.hull = ship.def.hull * 0.31;
    hud.update(frame, 1 / 60);
    expect(find(container, 'mc-hulldanger').style.display).toBe('none');
  });

  it('閃光を抑える設定では点滅させず、文字情報は残す', () => {
    const { container, hud, frame, player } = setup();
    settings.reducedFlashes = true;
    const ship = player.ship!;
    ship.hull = ship.def.hull * 0.1;
    hud.update(frame, 1 / 60);
    hud.update(frame, 1 / 60);

    // 一定の濃さのまま（フレームごとに脈動しない）
    expect(find(container, 'mc-hulldanger').style.opacity).toBe('0.5');
    const light = find(container, 'mc-warnlights').children.find((c) =>
      c.textContent.includes('Alt+E'),
    )!;
    expect(light.classNames()).toContain('on');
    expect(light.style.animation).toBe('none');
  });

  it('僚機の戦死を画面中央に出し、時間が経つと消える（右上の撃墜ログとは別枠）', () => {
    const { container, hud, frame } = setup();
    hud.showCasualty('Sable 戦死', '編隊から1機失った', 2600);
    const casualty = find(container, 'mc-casualty');
    expect(hud.casualtyVisible).toBe(true);
    expect(casualty.innerHTML).toContain('Sable 戦死');
    // 撃墜ログ（右上）は空のまま。別枠であることを確認する
    expect(find(container, 'mc-killfeed').children.length).toBe(0);

    nowMs = 2000;
    hud.update(frame, 1 / 60);
    expect(hud.casualtyVisible).toBe(true);

    nowMs = 2700;
    hud.update(frame, 1 / 60);
    expect(hud.casualtyVisible).toBe(false);
  });

  it('被弾段階の告知は任務アナウンスとは別の要素に出す', () => {
    const { container, hud } = setup();
    hud.showDamageStage('hull-critical');
    const stage = find(container, 'mc-damagestage');
    expect(stage.style.display).toBe('');
    expect(stage.textContent).toContain('ハル危険域');
    expect(stage.textContent).toContain('Alt+E');
    expect(find(container, 'mc-announce').textContent).toBe('');
  });

  it('任務をまたぐと段階告知と戦死告知が消える', () => {
    const { container, hud } = setup();
    hud.showCasualty('撃墜された');
    hud.showDamageStage('hull-hit');
    hud.resetTransientState();
    expect(hud.casualtyVisible).toBe(false);
    expect(find(container, 'mc-damagestage').style.display).toBe('none');
    expect(hud.isExternalView).toBe(false);
  });
});

describe('HUD: 外部視点でダッシュボードを隠す', () => {
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
    vi.unstubAllGlobals();
  });

  it('コクピット視点では計器盤を出し、外部視点用 HUD は出さない', () => {
    const { container, hud, frame } = setup();
    hud.update(frame, 1 / 60);
    expect(hud.dashboardVisible).toBe(true);
    expect(find(container, 'mc-exthud').style.display).toBe('none');
  });

  it('外部視点では計器盤を隠し、速度・スロットル・ターゲット・目標を最小 HUD に置き換える', () => {
    const { container, hud, frame, player, world } = setup();
    const enemy = spawnShip(world, {
      def: shipDef('dralthi'),
      faction: 'kilrathi',
      pos: new Vector3(0, 0, -1200),
      speed: 0,
      label: 'ドゥル',
      pilot: 'ドゥル',
    });
    player.ship!.targetId = enemy.id;
    player.vel.set(0, 0, -320);

    hud.setExternalView(true);
    hud.update(frame, 1 / 60);

    expect(hud.isExternalView).toBe(true);
    expect(hud.dashboardVisible).toBe(false);
    const ext = find(container, 'mc-exthud');
    expect(ext.style.display).toBe('');
    // 情報を消すのではなく置き換える
    expect(ext.textContent).toContain('320');
    expect(ext.textContent).toContain('80%');
    expect(ext.textContent).toContain('ドゥル');
    expect(ext.textContent).toContain('輸送船を帰投航路に乗せる');
  });

  it('コクピット視点へ戻すと計器盤が戻り、最小 HUD が消える', () => {
    const { container, hud, frame } = setup();
    hud.setExternalView(true);
    hud.update(frame, 1 / 60);
    hud.setExternalView(false);
    hud.update(frame, 1 / 60);
    expect(hud.dashboardVisible).toBe(true);
    expect(find(container, 'mc-exthud').style.display).toBe('none');
  });

  it('メニュー表示中（visible=false）は外部視点でも最小 HUD を出さない', () => {
    const { container, hud, frame } = setup();
    hud.setExternalView(true);
    hud.update({ ...frame, visible: false }, 1 / 60);
    expect(find(container, 'mc-exthud').style.display).toBe('none');
    expect(hud.dashboardVisible).toBe(false);
  });
});
