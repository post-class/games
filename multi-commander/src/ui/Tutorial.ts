import { bus } from '../core/events';
import { updateSettings } from '../app/settings';
import type { InputManager } from '../app/input';
import type { World } from '../world/world';

export type TutorialMode = 'simple' | 'detailed';

export interface TutorialContext {
  world: World;
  input: InputManager;
  autopilot: boolean;
  commsOpen: boolean;
  navMapOpen: boolean;
}

interface Step {
  text: string;
  /** 旧チュートリアル互換用。進行判定には使用しない。 */
  done: (ctx: TutorialContext, self: Tutorial) => boolean;
  /** 旧チュートリアル互換用。進行判定には使用しない。 */
  minShow?: number;
}

/** チュートリアルの案内を次へ送る専用キー。通常の戦闘操作と衝突しない。 */
const TUTORIAL_NEXT_CODE = 'KeyB';

const SIMPLE_STEPS: Step[] = [
  {
    text: 'まずスロットルを上げる。<b>]</b> キー（10%ずつ）かマウスホイール、または数字の <b>5</b> で 50%。',
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

const DETAILED_STEPS: Step[] = [
  {
    text: 'スロットルを確認する。<b>]</b>／<b>[</b> は10%ずつ、数字 <b>1〜9</b> は割合指定、<b>0</b> は停止。ホイールでも調整できる。',
    done: (c) => c.input.throttle > 0.35,
  },
  {
    text: 'キーボード操縦を試す。<b>↑↓←→</b> でピッチ／ヨー、<b>Q/E</b> でロール。',
    done: (c, self) => c.input.flightInputUsed || self.used('flightInput') || self.turnAmount > 2.5,
    minShow: 2,
  },
  {
    text: 'マウス操縦を試す。<b>M</b> で ON/OFF を切り替え、照準を画面中央へ戻してからマウスを動かす。',
    done: (_c, self) => self.used('mouseToggle'),
    minShow: 2,
  },
  {
    text: '<b>Tab</b> を押してアフターバーナー。速度は上がるが燃料を消費する。',
    done: (c, self) => c.input.afterburnerUsed || self.used('afterburner'),
    minShow: 2,
  },
  {
    text: '<b>T</b> で順番に、<b>R</b> で最も近い敵を、<b>Y</b> で正面の敵をターゲットする。',
    done: (c) => c.world.player?.ship?.targetId !== undefined,
  },
  {
    text: '<b>Space</b> または左クリックで主砲。格納庫ではパルスキャノン（3発散開）やイオンランス（高速精密弾）も選べる。',
    done: (_c, self) => self.shotsFired > 3,
    minShow: 2,
  },
  {
    text: '<b>X</b> で副兵装を切り替える。HUD の選択中ミサイル名と残弾を確認する。シールドブレイカーはシールド、アーマーブリーチャーは装甲向けだ。',
    done: (_c, self) => self.used('nextSecondary'),
    minShow: 2,
  },
  {
    text: '敵を正面に捉えてロックし、<b>Enter</b> または右クリックでミサイルを発射する。',
    done: (_c, self) => self.missilesFired > 0,
    minShow: 2,
  },
  {
    text: '<b>G</b> でフレアを放出する。敵ミサイルの警告時に使い、残数をHUDで確認する。',
    done: (_c, self) => self.used('flare'),
    minShow: 2,
  },
  {
    text: '<b>D</b> で被害状況、<b>F</b> で視点、<b>N</b> でNavマップを切り替える。',
    done: (_c, self) => self.used('damageDisplay') && self.used('viewToggle') && self.used('navMap'),
    minShow: 2,
  },
  {
    text: '<b>C</b> で通信メニューを開き、数字キーで僚機への指示を選ぶ。',
    done: (c, self) => c.commsOpen || self.used('comms'),
    minShow: 2,
  },
  {
    text: '<b>Z</b> で飛行モードを切り替える。設定の上級者向け操作も確認しておこう。',
    done: (_c, self) => self.used('flightModeToggle'),
    minShow: 2,
  },
  {
    text: 'Navポイント間は <b>A</b> のオートパイロットで移動する。敵が近い場合は作動しないことがある。',
    done: (c, self) => c.autopilot || self.used('autopilot'),
    minShow: 2,
  },
];

/**
 * 初回プレイ向けの短い操作案内。
 * B キーでステップを進め、最後まで進むと最初へ戻って繰り返す。
 */
export class Tutorial {
  active = false;
  private index = 0;
  private el: HTMLElement;
  stepElapsed = 0;
  turnAmount = 0;
  shotsFired = 0;
  missilesFired = 0;
  private mode: TutorialMode = 'simple';
  private usedActions = new Set<string>();
  private unsubs: Array<() => void> = [];

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
    const onKeyDown = (ev: KeyboardEvent) => {
      if (!this.active || ev.repeat) return;
      if (ev.code === TUTORIAL_NEXT_CODE) {
        // B はチュートリアル専用。ゲーム側へ渡して意図しない操作を起こさない。
        ev.preventDefault();
        ev.stopImmediatePropagation();
        this.advance();
        return;
      }
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyQ', 'KeyE'].includes(ev.code)) {
        this.usedActions.add('flightInput');
      }
      if (ev.code === 'Tab') this.usedActions.add('afterburner');
    };
    window.addEventListener('keydown', onKeyDown);
    this.unsubs.push(() => window.removeEventListener('keydown', onKeyDown));
  }

  start(mode: TutorialMode = 'simple'): void {
    this.active = true;
    this.mode = mode;
    this.index = 0;
    this.stepElapsed = 0;
    this.turnAmount = 0;
    this.shotsFired = 0;
    this.missilesFired = 0;
    this.usedActions.clear();
    this.render();
  }

  /** 詳細チュートリアルが入力経路を確認するための記録。 */
  noteAction(action: string): void {
    if (this.active) this.usedActions.add(action);
  }

  used(action: string): boolean {
    return this.usedActions.has(action);
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

    if (ctx.input.afterburner) this.usedActions.add('afterburner');
    const steps = this.mode === 'detailed' ? DETAILED_STEPS : SIMPLE_STEPS;
    const step = steps[this.index];
    if (!step) {
      this.index = 0;
      this.stepElapsed = 0;
      this.render();
      return;
    }
  }

  /** 現在の案内を確認したら次のステップへ進める。 */
  private advance(): void {
    if (!this.active) return;
    const steps = this.mode === 'detailed' ? DETAILED_STEPS : SIMPLE_STEPS;
    this.index = (this.index + 1) % steps.length;
    this.stepElapsed = 0;
    this.render();
  }

  private render(): void {
    const steps = this.mode === 'detailed' ? DETAILED_STEPS : SIMPLE_STEPS;
    const step = steps[this.index];
    if (!step) return;
    this.el.style.display = '';
    this.el.innerHTML =
      `<span class="step">${this.mode === 'detailed' ? '詳細訓練' : '簡易訓練'} ${this.index + 1} / ${steps.length}</span>` +
      `<span class="message">${step.text} <span class="next">[B] 次へ</span></span>`;
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.el.remove();
  }
}
