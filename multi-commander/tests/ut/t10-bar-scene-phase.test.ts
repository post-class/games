import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeDom, type FakeDom, type FakeElement } from './fake-dom';
import { BarScene } from '../../src/ui/BarScene';
import { seatPlan } from '../../src/app/barSeats';
import { newRoster } from '../../src/app/roster';
import { buildBarTalk, newBarTalk } from '../../src/app/barTalk';
import { pilotDef } from '../../src/content/pilots';
import type { HubContext } from '../../src/ui/HubPanels';

/**
 * 酒場の場面（`src/ui/BarScene.ts`）の段階と差分更新のテスト。
 *
 * カメラの見た目（CSS transition）は検証できないので、
 * - 段階（`data-phase`）が正しく遷移するか
 * - `update()` が DOM を作り直していないか（要素のインスタンスが保たれるか）
 * - 会話ボックスが不要に組み直されないか
 * を固定する。ここが崩れると演出が成立しない。
 */

const roster = () => {
  const r = newRoster();
  // 出撃回数を散らして、席割りと「付き合いの長さ」が決まるようにする
  r.pilots.forEach((p, i) => {
    p.sorties = i;
  });
  return r;
};

function makeCtx(over: Partial<HubContext> = {}): HubContext {
  const r = roster();
  const plan = seatPlan(r, { seed: 0 });
  return {
    roster: r,
    totalKills: 0,
    sorties: 0,
    cleared: [],
    medals: [],
    chapter: 1,
    totalChapters: 10,
    barSeats: plan.seats,
    barStanding: plan.standing,
    bartender: { name: '七瀬 結衣', line: 'いらっしゃい。' },
    rumors: [{ source: '整備班', text: '補給が遅れているらしい。' }],
    ...over,
  } as HubContext;
}

describe('酒場の場面 — 段階', () => {
  let dom: FakeDom;

  beforeEach(() => {
    dom = installFakeDom();
  });
  afterEach(() => {
    dom.restore();
  });

  const build = (ctx = makeCtx()) => {
    const scene = new BarScene({ background: 'bg.jpg', ctx });
    scene.start();
    return { scene, ctx, root: scene.el as unknown as FakeElement };
  };

  const cameraOf = (root: FakeElement) => dom.findAll(root, 'mc-barroom-camera')[0];

  it('最初は部屋を見回している（room）', () => {
    const { scene, root } = build();
    expect(scene.currentPhase).toBe('room');
    expect(cameraOf(root).dataset.phase).toBe('room');
    expect(scene.selectedPilotId).toBeUndefined();
  });

  it('席にいる全員が立ち絵として並ぶ', () => {
    const { ctx, root } = build();
    const seated = ctx.barSeats!.flatMap((s) => s.occupants).map((p) => p.id);
    const figs = dom.findAll(root, 'mc-barroom-fig');
    // 席の人数ぶん＋酒保
    expect(figs.length).toBe(seated.length + 1);
    for (const id of seated) {
      expect(figs.some((f) => f.dataset.pilot === id)).toBe(true);
    }
  });

  it('←→ で見回す順は画面の左から右（巡回する）', () => {
    const { scene } = build();
    const order = scene.focusOrder();
    expect(order.length).toBeGreaterThan(1);
    scene.select(1);
    expect(scene.selectedPilotId).toBe(order[0]);
    scene.select(1);
    expect(scene.selectedPilotId).toBe(order[1]);
    scene.select(-1);
    expect(scene.selectedPilotId).toBe(order[0]);
    // 端では反対側へ回る
    scene.select(-1);
    expect(scene.selectedPilotId).toBe(order[order.length - 1]);
  });

  it('選んでいる立ち絵にだけ .sel が付く', () => {
    const { scene, root } = build();
    scene.select(1);
    const sel = dom.findAll(root, 'mc-barroom-fig').filter((f) => f.classNames().includes('sel'));
    expect(sel).toHaveLength(1);
    expect(sel[0].dataset.pilot).toBe(scene.selectedPilotId);
  });

  it('近づくと walk を経て talk になり、到着を1回だけ知らせる', () => {
    const { scene, root } = build();
    const done = vi.fn();
    scene.onApproachEnd = done;
    scene.select(1);
    const target = scene.selectedPilotId!;

    scene.approach();
    expect(scene.currentPhase).toBe('walk');
    expect(cameraOf(root).dataset.phase).toBe('walk');
    expect(done).not.toHaveBeenCalled();

    // 歩いている間は相手を変えない・二重に歩き出さない
    scene.select(1);
    expect(scene.selectedPilotId).toBe(target);
    scene.approach();
    expect(scene.currentPhase).toBe('walk');

    dom.flushTimers();
    expect(scene.currentPhase).toBe('talk');
    expect(cameraOf(root).dataset.phase).toBe('talk');
    expect(done).toHaveBeenCalledTimes(1);
    expect(done).toHaveBeenCalledWith(target);
  });

  it('settle() は到着を同期で済ませる', () => {
    const { scene } = build();
    const done = vi.fn();
    scene.onApproachEnd = done;
    scene.select(1);
    scene.approach();
    scene.settle();
    expect(scene.currentPhase).toBe('talk');
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('引くと back を経て room に戻る', () => {
    const { scene } = build();
    scene.select(1);
    scene.approach();
    scene.settle();
    expect(scene.currentPhase).toBe('talk');

    scene.pullBack();
    expect(scene.currentPhase).toBe('back');
    dom.flushTimers();
    expect(scene.currentPhase).toBe('room');
  });

  it('部屋を見ているときに引いても何も起きない', () => {
    const { scene } = build();
    scene.pullBack();
    expect(scene.currentPhase).toBe('room');
  });

  it('カメラの倍率は段階で変わり、等倍を下回らない', () => {
    const { scene, root } = build();
    const cam = cameraOf(root);
    expect(Number(cam.dataset.scale)).toBe(1);
    scene.select(1);
    // 見回しは浅く寄る
    expect(Number(cam.dataset.scale)).toBeGreaterThan(1);
    expect(Number(cam.dataset.scale)).toBeLessThan(1.3);
    scene.approach();
    scene.settle();
    // 会話はしっかり寄る
    expect(Number(cam.dataset.scale)).toBeGreaterThan(1.5);
  });
});

describe('酒場の場面 — 差分更新', () => {
  let dom: FakeDom;

  beforeEach(() => {
    dom = installFakeDom();
  });
  afterEach(() => {
    dom.restore();
  });

  it('update() は同じ人物の立ち絵を作り直さない', () => {
    const ctx = makeCtx();
    const scene = new BarScene({ background: 'bg.jpg', ctx });
    scene.start();
    const root = scene.el as unknown as FakeElement;
    const before = new Map(
      dom.findAll(root, 'mc-barroom-fig').map((f) => [f.dataset.pilot ?? 'tender', f]),
    );

    scene.update(makeCtx());
    const after = new Map(
      dom.findAll(root, 'mc-barroom-fig').map((f) => [f.dataset.pilot ?? 'tender', f]),
    );
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [id, el] of after) {
      // 同一インスタンスであること（＝作り直していない）
      expect(el).toBe(before.get(id));
    }
  });

  it('内容が変わらなければ会話ボックスも作り直さない', () => {
    const ctx = makeCtx();
    const scene = new BarScene({ background: 'bg.jpg', ctx });
    scene.start();
    const root = scene.el as unknown as FakeElement;
    const before = dom.findAll(root, 'mc-barroom-who')[0];
    scene.update(makeCtx());
    expect(dom.findAll(root, 'mc-barroom-who')[0]).toBe(before);
  });

  it('会話が始まると寄り、終わると引く', () => {
    const base = makeCtx();
    const scene = new BarScene({ background: 'bg.jpg', ctx: base });
    scene.start();
    expect(scene.currentPhase).toBe('room');

    // 席にいる誰かとの1対1の会話を開く
    const seated = base.barSeats!.flatMap((s) => s.occupants)[0];
    const pilot = base.roster.pilots.find((p) => p.id === seated.id)!;
    const talk = buildBarTalk({
      pilot,
      personality: pilotDef(pilot.id).personality,
      state: newBarTalk(pilot.id),
    });
    scene.update(makeCtx({ barTalk: talk, barPilotId: pilot.id }));
    expect(scene.currentPhase).toBe('talk');

    // 会話を閉じると引く
    scene.update(makeCtx());
    expect(scene.currentPhase).toBe('back');
    dom.flushTimers();
    expect(scene.currentPhase).toBe('room');
  });

  it('dispose() でタイマーとキー購読を残さない', () => {
    const scene = new BarScene({ background: 'bg.jpg', ctx: makeCtx() });
    scene.start();
    scene.select(1);
    scene.approach();
    expect(dom.pendingTimers()).toBeGreaterThan(0);
    scene.dispose();
    expect(dom.pendingTimers()).toBe(0);
    // 購読が外れているので、キーを叩いても段階が動かない
    const phase = scene.currentPhase;
    dom.key('ArrowRight');
    expect(scene.currentPhase).toBe(phase);
  });
});

describe('酒場の場面 — 入力の切り分け', () => {
  let dom: FakeDom;

  beforeEach(() => {
    dom = installFakeDom();
  });
  afterEach(() => {
    dom.restore();
  });

  const build = () => {
    const scene = new BarScene({ background: 'bg.jpg', ctx: makeCtx() });
    scene.start();
    return scene;
  };

  it('←→ E Q は場面が受け取る', () => {
    const scene = build();
    dom.key('ArrowRight');
    expect(scene.selectedPilotId).toBeDefined();
    dom.key('KeyE');
    expect(scene.currentPhase).toBe('walk');
    scene.settle();
    dom.key('KeyQ');
    expect(scene.currentPhase).toBe('back');
  });

  /**
   * ここが崩れると出撃も帰艦もできなくなる。
   * 上下・決定・キャンセルは必ず `ScreenHost` へ通す。
   */
  it('▲▼ Enter Space Esc は止めずに素通しする', () => {
    const scene = build();
    const seen: string[] = [];
    // 場面より後に登録した購読（＝ScreenHost 相当）へ届くことを見る
    window.addEventListener('keydown', (ev) => seen.push((ev as unknown as { code: string }).code));
    for (const code of ['ArrowUp', 'ArrowDown', 'Enter', 'Space', 'Escape', 'KeyW', 'KeyS']) {
      dom.key(code);
    }
    expect(seen).toEqual(['ArrowUp', 'ArrowDown', 'Enter', 'Space', 'Escape', 'KeyW', 'KeyS']);
    // 素通しした結果、段階も動いていない
    expect(scene.currentPhase).toBe('room');
  });

  it('E の押しっぱなしで二重に歩き出さない', () => {
    const scene = build();
    dom.key('ArrowRight');
    dom.key('KeyE');
    expect(scene.currentPhase).toBe('walk');
    const done = vi.fn();
    scene.onApproachEnd = done;
    dom.key('KeyE', { repeat: true });
    dom.flushTimers();
    expect(done).toHaveBeenCalledTimes(1);
  });
});
