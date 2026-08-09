import { PerspectiveCamera, Vector3 } from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HudView } from '../../src/hud/HudView';
import { openingRectPx, pointInRect, rectEdgeArrow } from '../../src/hud/project';
import { COCKPIT_OPENING } from '../../src/render/Cockpit';
import { resetSettings } from '../../src/app/settings';
import { shipDef } from '../../src/content/ships';
import { spawnShip, World } from '../../src/world/world';
import { FakeElement } from './fake-dom';

/**
 * T1-② 追補: コクピット構造の裏にいる相手へ枠を描かない。
 *
 * 風防の開口部（`COCKPIT_OPENING`、3D 側が唯一の出所）の外に投影された
 * ターゲット枠・ラベル・ITTS リード・機体マーカーは、
 * 「見えていない」ので画面外と同じ扱い（開口部の縁の矢印）にする。
 * コクピット装飾 OFF と外部視点では従来どおり画面全体に描く。
 */

const WIDTH = 1920;
const HEIGHT = 1080;

/** `classList.toggle` を足した最小要素（共有の fake-dom は書き換えない） */
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

function findAll(root: FakeElement, className: string): FakeElement[] {
  const out: FakeElement[] = [];
  walk(root, (el) => {
    if (el.classNames().includes(className)) out.push(el);
  });
  return out;
}

function find(root: FakeElement, className: string): FakeElement {
  const hit = findAll(root, className)[0];
  if (!hit) throw new Error(`要素が見つからない: .${className}`);
  return hit;
}

/**
 * 自機・敵1機・カメラを用意する。
 * カメラは原点で -Z を向く既定の向きなので、敵の座標で投影位置を作れる。
 */
function setup(enemyPos: Vector3) {
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
  const enemy = spawnShip(world, {
    def: shipDef('dralthi'),
    faction: 'kilrathi',
    pos: enemyPos,
    speed: 0,
    label: 'KE04 ミラージュ',
    pilot: 'ドゥル',
  });
  player.ship!.targetId = enemy.id;

  const camera = new PerspectiveCamera(70, WIDTH / HEIGHT, 0.5, 60000);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();

  const frame = {
    world,
    camera,
    width: WIDTH,
    height: HEIGHT,
    throttle: 0.5,
    mouseFlight: false,
    visible: true,
  };
  return { container, hud, world, player, enemy, frame };
}

/** 開口部の内側（正面 1.2km） */
const INSIDE = new Vector3(0, 0, -1200);
/**
 * 開口部の下端より下（機首より下にいて、3D では計器盤の筐体に隠れている）。
 * FOV 70 / 距離 1200 で NDC.y ≒ -0.71 なので、画面内かつ開口部 (-0.4) の外。
 */
const BELOW = new Vector3(0, -600, -1200);

describe('開口部の矩形', () => {
  it('3D 側の開口部 (NDC) をそのままピクセルへ写す', () => {
    const r = openingRectPx(COCKPIT_OPENING, WIDTH, HEIGHT);
    expect(r.top).toBeCloseTo(((1 - COCKPIT_OPENING.top) / 2) * HEIGHT, 5);
    expect(r.bottom).toBeCloseTo(((1 - COCKPIT_OPENING.bottom) / 2) * HEIGHT, 5);
    // 実機で確認した比率（上 約18% / 下 約70%）と一致する
    expect(r.top / HEIGHT).toBeGreaterThan(0.13);
    expect(r.top / HEIGHT).toBeLessThan(0.22);
    expect(r.bottom / HEIGHT).toBeGreaterThan(0.66);
    expect(r.bottom / HEIGHT).toBeLessThan(0.74);
  });

  it('矢印は開口部の縁に収まる', () => {
    const r = openingRectPx(COCKPIT_OPENING, WIDTH, HEIGHT, 40);
    const a = rectEdgeArrow({ x: WIDTH / 2, y: HEIGHT * 0.95 }, r);
    expect(a.y).toBeLessThanOrEqual(r.bottom + 1e-6);
    expect(pointInRect(a, openingRectPx(COCKPIT_OPENING, WIDTH, HEIGHT))).toBe(true);
  });
});

describe('コクピット装飾 ON: 構造の裏には枠を描かない', () => {
  beforeEach(() => {
    resetSettings();
    vi.stubGlobal('document', {
      createElement: (tag: string) => new El(tag),
      createElementNS: (_ns: string, tag: string) => new El(tag),
      body: new El('body'),
    });
    vi.stubGlobal('performance', { now: () => 0 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('開口部の内側なら枠とラベルを描き、矢印は出さない', () => {
    const { container, hud, frame } = setup(INSIDE);
    hud.setCockpitDecorations(true);
    hud.update(frame, 1 / 60);

    const box = find(container, 'mc-tgtbox');
    expect(box.style.display).toBe('');
    expect(find(container, 'mc-tgtbox-label').textContent).toContain('KE04 ミラージュ');
    // 矢印（[0] がターゲット用）は出ない
    expect(findAll(container, 'mc-arrow')[0].style.display).toBe('none');
    // ITTS リードも描かれる
    expect(find(container, 'mc-lead').style.display).toBe('');
  });

  it('開口部の外（機首より下）は枠を描かず、開口部の縁の矢印に寄せる', () => {
    const { container, hud, frame } = setup(BELOW);
    hud.setCockpitDecorations(true);
    hud.update(frame, 1 / 60);

    const box = find(container, 'mc-tgtbox');
    expect(box.style.display).toBe('none');
    // ITTS リードも構造の上に浮かせない
    expect(find(container, 'mc-lead').style.display).toBe('none');

    const arrow = findAll(container, 'mc-arrow')[0];
    expect(arrow.style.display).toBe('');
    const rect = openingRectPx(COCKPIT_OPENING, WIDTH, HEIGHT);
    const y = Number.parseFloat(arrow.style.top);
    const x = Number.parseFloat(arrow.style.left);
    // 画面下端 (1080) ではなく開口部の下端 (約756) より内側に来る
    expect(y).toBeLessThanOrEqual(rect.bottom + 1e-6);
    expect(pointInRect({ x, y }, rect)).toBe(true);
  });

  it('構造の裏にいる機体には印 (mc-marker) を付けない', () => {
    const { container, hud, frame, world, player } = setup(INSIDE);
    // ターゲット以外の敵を開口部の下に置く
    spawnShip(world, {
      def: shipDef('dralthi'),
      faction: 'kilrathi',
      pos: BELOW.clone(),
      speed: 0,
      label: '別の敵',
    });
    player.ship!.targetId = undefined;
    hud.setCockpitDecorations(true);
    hud.update(frame, 1 / 60);

    const rect = openingRectPx(COCKPIT_OPENING, WIDTH, HEIGHT);
    const shown = findAll(container, 'mc-marker').filter(
      (m) => m.style.display === '' && !m.classNames().includes('nav'),
    );
    // 出ている印はすべて開口部の内側
    for (const m of shown) {
      const p = { x: Number.parseFloat(m.style.left), y: Number.parseFloat(m.style.top) };
      expect(pointInRect(p, rect)).toBe(true);
    }
    // 開口部の内側にいる1機だけが出る
    expect(shown).toHaveLength(1);
  });
});

describe('コクピット装飾 OFF / 外部視点: 従来どおり画面全体に描く', () => {
  beforeEach(() => {
    resetSettings();
    vi.stubGlobal('document', {
      createElement: (tag: string) => new El(tag),
      createElementNS: (_ns: string, tag: string) => new El(tag),
      body: new El('body'),
    });
    vi.stubGlobal('performance', { now: () => 0 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('装飾 OFF なら、開口部の外でも枠を描く（OFF の挙動を変えない）', () => {
    const { container, hud, frame } = setup(BELOW);
    hud.setCockpitDecorations(false);
    hud.update(frame, 1 / 60);

    const box = find(container, 'mc-tgtbox');
    expect(box.style.display).toBe('');
    const rect = openingRectPx(COCKPIT_OPENING, WIDTH, HEIGHT);
    // 開口部の外（下）にそのまま描かれている
    expect(Number.parseFloat(box.style.top)).toBeGreaterThan(rect.bottom);
    expect(findAll(container, 'mc-arrow')[0].style.display).toBe('none');
  });

  it('外部視点では風防が無いので、開口部で切らない', () => {
    const { container, hud, frame } = setup(BELOW);
    hud.setCockpitDecorations(true);
    hud.setExternalView(true);
    hud.update(frame, 1 / 60);

    expect(find(container, 'mc-tgtbox').style.display).toBe('');
  });
});
