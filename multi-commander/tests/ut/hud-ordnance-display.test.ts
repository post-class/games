import { PerspectiveCamera, Vector3 } from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HudView } from '../../src/hud/HudView';
import { resetSettings } from '../../src/app/settings';
import { shipDef } from '../../src/content/ships';
import { spawnShip, World } from '../../src/world/world';
import { FakeElement } from './fake-dom';

/**
 * 計器盤中央の被害表示 (DAMAGE)。
 *
 * - 図は機体の形で、機首・尾部・左右の翼がそれぞれ装甲の面に対応する
 * - 翼下のパイロンと数字で副兵装の残弾が読める
 * - 残弾の数え方は `ship.missiles` ひとつだけ (右 VDU の兵装ページと同じ配列)
 */

/** `classList.toggle` を足した最小要素 (HUD が使う API だけ補う) */
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

/** 被害表示の SVG の中で、翼下パイロン (rect) だけを集める */
function pips(container: FakeElement): FakeElement[] {
  const box = find(container, 'mc-shielddisp');
  const out: FakeElement[] = [];
  walk(box, (el) => {
    if (el.tagName === 'RECT' && el.getAttribute('rx') === '1.7') out.push(el);
  });
  return out;
}

/** 右 VDU の内容 (innerHTML で書かれるので textContent では読めない) */
function vduHtml(container: FakeElement): string {
  let html = '';
  walk(container, (el) => {
    if (el.classNames().includes('mc-vdu')) html += el.innerHTML;
  });
  return html;
}

function litPips(container: FakeElement): number {
  return pips(container).filter((p) => (p.getAttribute('fill') ?? '').startsWith('#')).length;
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
    missileOverride: [
      { missileId: 'dumbfire', count: 4 },
      { missileId: 'heat-seeker', count: 3 },
    ],
  });
  world.playerId = player.id;
  const camera = new PerspectiveCamera(70, 16 / 9, 0.5, 60000);
  const frame = {
    world,
    camera,
    width: 1280,
    height: 720,
    throttle: 0.5,
    mouseFlight: false,
    visible: true,
  };
  return { container, hud, world, player, frame };
}

describe('被害表示 (機体図) と副兵装の残弾', () => {
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

  it('ORD-01: 残弾は「選択中 / 合計」で出し、パイロンが残数だけ点く', () => {
    const { container, hud, frame } = setup();
    hud.update(frame, 1 / 60);

    // 合計 7 発。パイロンは6本しか無いので、点くのは6本まで (数字が正確な値を出す)
    expect(find(container, 'mc-mslnum').textContent).toBe('MSL 4/7');
    expect(pips(container).length).toBe(6);
    expect(litPips(container)).toBe(6);
  });

  it('ORD-02: 撃つと点灯するパイロンが減り、数字も同時に減る', () => {
    const { container, hud, frame, player } = setup();
    player.ship!.missiles[0].count = 2;
    player.ship!.missiles[1].count = 1;
    hud.update(frame, 1 / 60);

    expect(find(container, 'mc-mslnum').textContent).toBe('MSL 2/3');
    expect(litPips(container)).toBe(3);
  });

  it('ORD-03: 弾切れではパイロンが消灯し、数字も 0 になる', () => {
    const { container, hud, frame, player } = setup();
    for (const slot of player.ship!.missiles) slot.count = 0;
    hud.update(frame, 1 / 60);

    expect(find(container, 'mc-mslnum').textContent).toBe('MSL 0');
    expect(litPips(container)).toBe(0);
  });

  it('ORD-04: 残弾の出所は右 VDU の兵装ページと同じ配列である', () => {
    const { container, hud, frame, player } = setup();
    player.ship!.missiles[1].count = 5;

    // 右 VDU を兵装ページへ送る (V キーと同じ経路)
    hud.update(frame, 1 / 60);
    hud.toggleRightVduPage();
    hud.update(frame, 1 / 60);

    const total = player.ship!.missiles.reduce((sum, m) => sum + m.count, 0);
    expect(total).toBe(9);
    expect(find(container, 'mc-mslnum').textContent).toBe(`MSL 4/${total}`);
    // 兵装ページにも同じ数が出る (数え方の出所が1つ)
    const weaponsHtml = vduHtml(container);
    expect(weaponsHtml).toContain('ORDNANCE');
    expect(weaponsHtml).toContain('ヒートシーカー');
    expect(weaponsHtml).toContain('>5<');
  });

  it('ORD-05: 機体図は機首・尾部・左右の翼で装甲の面を表す', () => {
    const { container, hud, frame, player } = setup();
    // 左翼だけ装甲を削る。図でも左翼の面だけ色が変わる。
    player.ship!.armor.left = 0;
    hud.update(frame, 1 / 60);

    const box = find(container, 'mc-shielddisp');
    const polys: FakeElement[] = [];
    walk(box, (el) => {
      if (el.tagName === 'POLYGON') polys.push(el);
    });
    // 機首 / 左翼 / 右翼 / 尾部 の4面
    expect(polys.length).toBe(4);
    const fills = polys.map((p) => p.getAttribute('fill'));
    // 健全な面と削れた面で色が違う (barColor の段階)
    expect(new Set(fills).size).toBeGreaterThan(1);
  });
});
