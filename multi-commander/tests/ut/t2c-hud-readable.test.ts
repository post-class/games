import { PerspectiveCamera, Vector3 } from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../src/core/events';
import { HudView, MOUSE_HINT_SECONDS } from '../../src/hud/HudView';
import type { ObjectiveView } from '../../src/hud/objectiveLines';
import { resetSettings, settings } from '../../src/app/settings';
import { shipDef } from '../../src/content/ships';
import { spawnNav, spawnShip, World } from '../../src/world/world';
import { estimateLabelHalfWidth } from '../../src/hud/project';
import { FakeElement } from './fake-dom';

/**
 * T2-⑧ / T2-⑨ の HUD 側。
 *
 * - 目標の常時表示が3行に収まり、行ごとに暗い帯が敷かれている
 * - 全目標は右 VDU の3ページ目（`V`）で読める
 * - 警告が2行になる
 * - 操縦ヒントが画面下部で数秒で消え、航法マップの上には出ない
 * - Nav ラベルが画面内に収まる
 * - 被弾方向が画面端の光と装甲図で分かり、`reducedFlashes` でも文字が残る
 *
 * `fake-dom.ts` の `FakeElement` に `classList.toggle` と `createElementNS` を足して使う
 * （`t1b-hud-drama.test.ts` と同じ流儀。`fake-dom.ts` 自体は変更しない）。
 */

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

const view = (text: string, over: Partial<ObjectiveView> = {}): ObjectiveView => ({
  text,
  state: 'active',
  ...over,
});

function objectives(): ObjectiveView[] {
  return [
    view('輸送船を帰投航路に乗せる'),
    view('〈アストラ・メイ〉を守る'),
    view('隔壁を保つ — 残り 240s', { timeLeftSec: 240 }),
    view('自機で帰投する'),
    view('＋帰還者3 … 救助艇を回収する — 残り 90s', { required: false, timeLeftSec: 90 }),
    view('＋整備点2 … 敵補給艇を止める — 残り 30s', { required: false, timeLeftSec: 30 }),
    view('＋情報1 … 通信塔を偵察する', { required: false }),
  ];
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
  camera.updateMatrixWorld();
  const frame = {
    world,
    camera,
    width: 1280,
    height: 720,
    throttle: 0.6,
    mouseFlight: false,
    objectives: objectives(),
    visible: true,
  };
  return { container, hud, world, player, camera, frame };
}

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

describe('T2-⑧ 目標の常時表示', () => {
  it('7項目でも常時表示は3行に収まる', () => {
    const { container, hud, frame } = setup();
    hud.update(frame, 1 / 60);
    const box = find(container, 'mc-objectives');
    expect(box.children.length).toBeLessThanOrEqual(3);
    expect(hud.objectiveLineCount).toBe(2); // 追うべき目標 + 制限時間（達成はまだ無い）
    expect(box.children[0].textContent).toContain('輸送船を帰投航路に乗せる');
    expect(box.children[1].textContent).toContain('残り 30s');
  });

  it('どの行にも半透明の暗い帯が敷かれている（明るい背景でも読める）', () => {
    const { container, hud, frame } = setup();
    hud.update(frame, 1 / 60);
    const box = find(container, 'mc-objectives');
    expect(box.children.length).toBeGreaterThan(0);
    for (const line of box.children) {
      expect(line.style.background).toContain('rgba(4,12,14,0.72)');
    }
  });

  it('必須は ▸、加点は ＋、達成は ✓、失敗は取り消し線で出し分ける', () => {
    const { container, hud, frame } = setup();
    // 必須をすべて片付け、加点だけ残す
    const objs = [
      view('輸送船を帰投航路に乗せる', { state: 'done' }),
      view('＋帰還者3 … 救助艇を回収する', { required: false }),
      view('自機で帰投する', { state: 'failed' }),
    ];
    hud.update({ ...frame, objectives: objs }, 1 / 60);
    const box = find(container, 'mc-objectives');
    const texts = box.children.map((c) => c.textContent);
    expect(texts.some((t) => t.startsWith('＋'))).toBe(true);
    const failed = box.children.find((c) => c.classNames().includes('failed'))!;
    expect(failed.style.textDecoration).toBe('line-through');
    expect(failed.textContent.startsWith('✖')).toBe(true);
  });

  it('達成した直近1件が3行目に出て、時間が経つと消える', () => {
    const { container, hud, frame } = setup();
    hud.update(frame, 1 / 60);
    const done = objectives().map((o, i) => (i === 0 ? { ...o, state: 'done' as const } : o));
    hud.update({ ...frame, objectives: done }, 1 / 60);
    const box = find(container, 'mc-objectives');
    expect(box.children.some((c) => c.classNames().includes('recent'))).toBe(true);
    // 表示時間を過ぎたら3行目は消える（常時表示を膨らませない）
    hud.update({ ...frame, objectives: done }, 20);
    expect(find(container, 'mc-objectives').children.some((c) => c.classNames().includes('recent'))).toBe(
      false,
    );
  });

  it('全目標は右 VDU の3ページ目（V）で読める。既存の2ページは残す', () => {
    const { container, hud, frame } = setup();
    hud.update(frame, 1 / 60);
    expect(hud.vduPage).toBe('tactical');
    hud.toggleRightVduPage();
    expect(hud.vduPage).toBe('weapons');
    hud.toggleRightVduPage();
    expect(hud.vduPage).toBe('objectives');
    hud.update(frame, 1 / 60);
    // `right` は画面端の光などにも付くので、VDU であることも条件にする
    let vdu: FakeElement | undefined;
    walk(container, (el) => {
      const cls = el.classNames();
      if (!vdu && cls.includes('mc-vdu') && cls.includes('right')) vdu = el;
    });
    if (!vdu) throw new Error('右 VDU が見つからない');
    expect(vdu.innerHTML).toContain('OBJECTIVES  [V]');
    // 常時表示に出していない目標もここには並ぶ
    expect(vdu.innerHTML).toContain('通信塔を偵察する');
    expect(vdu.innerHTML).toContain('自機で帰投する');
    hud.toggleRightVduPage();
    expect(hud.vduPage).toBe('tactical');
  });

  it('任務をまたぐと常時表示と一覧が空になる', () => {
    const { container, hud, frame } = setup();
    hud.update(frame, 1 / 60);
    hud.resetTransientState();
    expect(find(container, 'mc-objectives').children.length).toBe(0);
    expect(hud.vduPage).toBe('tactical');
  });
});

describe('T2-⑧ 警告は2行', () => {
  it('安全窓が閉じたとき、指示が2行目に出る', () => {
    const { container, hud, frame } = setup();
    bus.emit('announce', { text: '安全窓が閉じた', kind: 'bad', durationMs: 2600 });
    hud.update(frame, 1 / 60);
    const announce = find(container, 'mc-announce');
    expect(announce.children.length).toBe(2);
    expect(announce.children[0].textContent).toBe('安全窓が閉じた');
    expect(announce.children[1].textContent).toBe('発砲すると共鳴パルスが止まる');
  });

  it('指示の無い告知は1行のまま', () => {
    const { container, hud, frame } = setup();
    bus.emit('announce', { text: 'ナビポイント到達', kind: 'good' });
    hud.update(frame, 1 / 60);
    expect(find(container, 'mc-announce').children.length).toBe(1);
  });
});

describe('T2-⑧ 操縦ヒント', () => {
  it('促されてから数秒で消える（出したままにしない）', () => {
    const { hud, frame } = setup();
    hud.update({ ...frame, mouseArmPending: true }, 1 / 60);
    expect(hud.mouseHintVisible).toBe(true);
    hud.update({ ...frame, mouseArmPending: true }, MOUSE_HINT_SECONDS);
    expect(hud.mouseHintVisible).toBe(false);
  });

  it('航法マップを開いている間は出さない（マップに重ねない）', () => {
    const { hud, frame } = setup();
    hud.update({ ...frame, mouseArmPending: true }, 1 / 60);
    expect(hud.mouseHintVisible).toBe(true);
    hud.navMap.setOpen(true);
    hud.update({ ...frame, mouseArmPending: true }, 1 / 60);
    expect(hud.mouseHintVisible).toBe(false);
  });

  it('促しが消えたらヒントも消える', () => {
    const { hud, frame } = setup();
    hud.update({ ...frame, mouseArmPending: true }, 1 / 60);
    hud.update({ ...frame, mouseArmPending: false }, 1 / 60);
    expect(hud.mouseHintVisible).toBe(false);
  });
});

describe('T2-⑧ Nav ラベルが画面内に収まる', () => {
  it('左端の Nav でもラベルの左半分が画面外に出ない', () => {
    const { container, hud, world, camera, frame } = setup();
    // 画面左端すれすれに Nav を置く（実機で `発艦点 2.6k` が x=0 で切れた状況）
    // 投影すると x ≈ 5px（ラベルの左半分が欠ける位置）に来る
    const nav = spawnNav(world, { name: '発艦点', pos: new Vector3(-2470, 0, -2000), index: 0 });
    camera.position.set(0, 0, 0);
    camera.lookAt(new Vector3(0, 0, -2000));
    camera.updateMatrixWorld();
    hud.update({ ...frame, nav }, 1 / 60);
    const marker = find(container, 'nav');
    expect(marker.style.display).toBe('');
    const x = Number(marker.style.left.replace('px', ''));
    // ラベル幅の半分ぶんは必ず内側にある（中央合わせでも左端が欠けない）
    const half = estimateLabelHalfWidth(marker.textContent);
    expect(x).toBeGreaterThanOrEqual(half);
    expect(x).toBeLessThanOrEqual(1280 - half);
  });
});

describe('T2-⑨ 被弾の方向を伝える', () => {
  const hitFromLeft = (player: ReturnType<typeof setup>['player']) =>
    bus.emit('shieldHit', {
      target: player,
      point: new Vector3(-30, 0, 0),
      amount: 12,
      isPlayer: true,
    });

  it('左から撃たれたら左端が光り、右端は光らない', () => {
    const { hud, frame, player } = setup();
    hitFromLeft(player);
    hud.update(frame, 1 / 60);
    expect(hud.hitEdgeOpacity('left')).toBeGreaterThan(0);
    expect(hud.hitEdgeOpacity('right')).toBe(0);
  });

  it('上下も光る（機体ローカル座標で判定する）', () => {
    const { hud, frame, player } = setup();
    bus.emit('armorHit', {
      target: player,
      point: new Vector3(0, 40, 0),
      amount: 20,
      layer: 'armor',
      isPlayer: true,
    });
    hud.update(frame, 1 / 60);
    expect(hud.hitEdgeOpacity('top')).toBeGreaterThan(0);
    expect(hud.hitEdgeOpacity('bottom')).toBe(0);
  });

  it('時間が経つと光は消える', () => {
    const { hud, frame, player } = setup();
    hitFromLeft(player);
    hud.update(frame, 1 / 60);
    hud.update(frame, 3);
    expect(hud.hitEdgeOpacity('left')).toBe(0);
    expect(hud.hitDirectionText).toBe('');
  });

  it('装甲図の直前に食らった面をハイライトする', () => {
    const { container, hud, frame, player } = setup();
    bus.emit('armorHit', {
      target: player,
      point: new Vector3(-30, 0, 0),
      amount: 20,
      layer: 'armor',
      isPlayer: true,
      hitFace: 'left',
    });
    hud.update(frame, 1 / 60);
    expect(hud.highlightedFace).toBe('left');
    // 装甲4象限のうち、赤い縁が付いているのは1つだけ
    const svg = find(container, 'mc-shielddisp');
    const highlighted = svg.children
      .flatMap((c) => c.children)
      .filter((n) => n.getAttribute('stroke') === '#ff6b6b');
    expect(highlighted.length).toBe(1);
  });

  it('閃光を抑える設定では明滅させず、方向の文字は残す', () => {
    const { hud, frame, player } = setup();
    settings.reducedFlashes = true;
    hitFromLeft(player);
    hud.update(frame, 1 / 60);
    const first = hud.hitEdgeOpacity('left');
    hud.update(frame, 1 / 60);
    expect(hud.hitEdgeOpacity('left')).toBe(first);
    expect(hud.hitDirectionText).toContain('左');
  });

  it('敵に当てた命中では自機の被弾表示を出さない', () => {
    const { hud, frame, world } = setup();
    const enemy = spawnShip(world, {
      def: shipDef('dralthi'),
      faction: 'kilrathi',
      pos: new Vector3(0, 0, -900),
      speed: 0,
      label: 'ドゥル',
      pilot: 'ドゥル',
    });
    bus.emit('shieldHit', {
      target: enemy,
      point: new Vector3(-30, 0, -900),
      amount: 12,
      isPlayer: false,
    });
    hud.update(frame, 1 / 60);
    expect(hud.hitDirectionText).toBe('');
    expect(hud.hitEdgeOpacity('left')).toBe(0);
  });

  it('任務をまたぐと被弾方向の表示が消える', () => {
    const { hud, frame, player } = setup();
    hitFromLeft(player);
    hud.update(frame, 1 / 60);
    hud.resetTransientState();
    expect(hud.hitEdgeOpacity('left')).toBe(0);
    expect(hud.hitDirectionText).toBe('');
    expect(hud.highlightedFace).toBeUndefined();
  });
});
