import { bus } from '../core/events';
import { updateSettings } from '../app/settings';
import type { InputManager } from '../app/input';
import type { World } from '../world/world';

export interface TutorialContext {
  world: World;
  input: InputManager;
  autopilot: boolean;
}

interface Step {
  text: string;
  /** 条件を満たしたか */
  done: (ctx: TutorialContext, self: Tutorial) => boolean;
  /** 表示してから最低これだけ出す (秒) */
  minShow?: number;
}

const STEPS: Step[] = [
  {
    text: 'まずスロットルを上げる。<b>]</b> キー か マウスホイール、または数字の <b>5</b> で 50%。',
    done: (c) => c.input.throttle > 0.35,
  },
  {
    text: 'マウスを照準から動かすと機首が向く。キーボードなら <b>↑↓←→</b>。<b>Q/E</b> でロール。',
    done: (_c, self) => self.turnAmount > 2.5,
    minShow: 2,
  },
  {
    text: '<b>T</b> でターゲットを取る。<b>R</b> は最至近、<b>Y</b> は正面の敵。',
    done: (c) => c.world.player?.ship?.targetId !== undefined,
  },
  {
    text: '<b>Space</b>（左クリック）で主砲。黄色い点線の丸が命中点だ、そこに敵を重ねろ。',
    done: (_c, self) => self.shotsFired > 8,
    minShow: 2,
  },
  {
    text: '誘導ミサイルは敵を正面に捉え続けてロックしてから <b>Enter</b>（右クリック）。<b>X</b> で選択。',
    done: (_c, self) => self.missilesFired > 0 || self.stepElapsed > 12,
    minShow: 3,
  },
  {
    text: 'Nav 間の移動は <b>A</b> のオートパイロット。敵が近くにいると使えない。<b>C</b> で僚機へ指示。',
    done: (c) => c.autopilot,
    minShow: 2,
  },
];

/**
 * 初回プレイ向けの短い操作案内。
 * 条件を満たすと次へ進み、最後まで進むと以後は表示しない。
 */
export class Tutorial {
  active = false;
  private index = 0;
  private el: HTMLElement;
  stepElapsed = 0;
  turnAmount = 0;
  shotsFired = 0;
  missilesFired = 0;
  private unsubs: Array<() => void> = [];
  private doneAt?: number;

  constructor(container: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'mc-tutorial';
    this.el.style.display = 'none';
    container.appendChild(this.el);

    this.unsubs.push(
      bus.on('weaponFired', (p) => {
        if (!p.isPlayer || !this.active) return;
        if (p.weaponKind === 'gun') this.shotsFired++;
        else this.missilesFired++;
      }),
    );
  }

  start(): void {
    this.active = true;
    this.index = 0;
    this.stepElapsed = 0;
    this.turnAmount = 0;
    this.shotsFired = 0;
    this.missilesFired = 0;
    this.doneAt = undefined;
    this.render();
  }

  /** 訓練を打ち切る (以後表示しない) */
  finish(markDone = true): void {
    this.active = false;
    this.el.style.display = 'none';
    if (markDone) updateSettings({ tutorialDone: true });
  }

  update(ctx: TutorialContext, dt: number): void {
    if (!this.active) return;
    this.stepElapsed += dt;
    this.turnAmount += (Math.abs(ctx.input.pitch) + Math.abs(ctx.input.yaw) + Math.abs(ctx.input.roll)) * dt;

    const step = STEPS[this.index];
    if (!step) {
      this.finish();
      return;
    }
    if (this.doneAt === undefined) {
      if (this.stepElapsed >= (step.minShow ?? 0) && step.done(ctx, this)) {
        this.doneAt = this.stepElapsed;
        this.el.classList.add('done');
      }
      return;
    }
    // 達成表示を少し見せてから次へ
    if (this.stepElapsed - this.doneAt > 1.1) {
      this.index++;
      this.stepElapsed = 0;
      this.doneAt = undefined;
      this.el.classList.remove('done');
      if (this.index >= STEPS.length) {
        bus.emit('announce', { text: '訓練完了', kind: 'good' });
        this.finish();
        return;
      }
      this.render();
    }
  }

  private render(): void {
    const step = STEPS[this.index];
    if (!step) return;
    this.el.style.display = '';
    this.el.innerHTML =
      `<span class="step">訓練 ${this.index + 1} / ${STEPS.length}</span>` +
      `<span class="message">${step.text}</span>`;
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.el.remove();
  }
}
