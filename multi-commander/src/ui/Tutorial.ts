import { bus } from '../core/events';
import { updateSettings } from '../app/settings';
import type { InputManager } from '../app/input';
import type { World } from '../world/world';

export type TutorialMode = 'simple' | 'detailed';

/**
 * チュートリアルの課程。
 *
 * `'demo'` (お手本モード) は案内の帯ではなく `ui/TutorialDemo.ts` が受け持つ。
 * 「読ませて操作させる課程」と「操作を見せる課程」で担当を分けているので、
 * `Tutorial` 側のステップ判定に 'demo' は入れない。
 */
export type TutorialCourse = TutorialMode | 'demo';

export interface TutorialContext {
  world: World;
  input: InputManager;
  autopilot: boolean;
  commsOpen: boolean;
  navMapOpen: boolean;
}

interface Step {
  text: string;
  /**
   * 完了条件 (T2-⑭)。**表示している操作をやったら進む**ようにする。
   *
   * 「操作イベントを受け取った」だけでは完了にせず、操作後のゲーム状態
   * (速度設定の値・ターゲット・オートパイロット) を見る。
   */
  done: (ctx: TutorialContext, self: Tutorial) => boolean;
  /** この秒数は読ませる (条件を満たしていても早送りしない) */
  minShow?: number;
}

/** チュートリアルの案内を次へ送る専用キー。通常の戦闘操作と衝突しない。 */
const TUTORIAL_NEXT_CODE = 'KeyB';

const SIMPLE_STEPS: Step[] = [
  {
    text: 'まず速度設定を上げる。<b>+</b> キー（10%ずつ）かマウスホイール、または数字の <b>5</b> で 50%。',
    // 「+ で上げる」と書いてあるのだから **1回上げたら完了** にする。
    // 50%→60% のような小さな増加でも進む (以前は 35% 超という別条件で止まっていた)。
    done: (c, self) => self.throttleRaised && c.input.throttle > 0,
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
    text: '速度設定を確認する。<b>+</b>／<b>-</b> は10%ずつ、数字 <b>1〜9</b> は割合指定、<b>0</b> は停止。ホイールでも調整できる。',
    done: (c, self) => self.throttleRaised && c.input.throttle > 0,
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
 *
 * 案内した操作を実際にやれば次へ進む (T2-⑭)。読み飛ばしたいときは B キーで送れる。
 * 最後のステップを終えたら**繰り返さずに帯を消す**。
 */
export class Tutorial {
  active = false;
  private index = 0;
  private el: HTMLElement;
  stepElapsed = 0;
  turnAmount = 0;
  shotsFired = 0;
  missilesFired = 0;
  /** 速度設定を一度でも上げたか (押した瞬間ではなく、値が増えたことで判定する) */
  throttleRaised = false;
  /** 最後のステップまで通したか */
  completed = false;
  /** 前フレームの速度設定。出撃直後の値を「上げた」と誤判定しないため未取得を分ける */
  private lastThrottle?: number;
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
    this.throttleRaised = false;
    this.completed = false;
    this.lastThrottle = undefined;
    this.usedActions.clear();
    this.render();
  }

  /** 現在のステップ番号 (0 始まり。テスト・確認用) */
  get stepIndex(): number {
    return this.index;
  }

  /** 全ステップ数 (テスト・確認用) */
  get stepCount(): number {
    return this.steps().length;
  }

  /** 帯が出ているか (テスト・確認用) */
  get visible(): boolean {
    return this.el.style.display !== 'none';
  }

  private steps(): Step[] {
    return this.mode === 'detailed' ? DETAILED_STEPS : SIMPLE_STEPS;
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

    // 速度設定は「上がったこと」を値の変化で見る。キー入力を数えると、
    // キーリピートや上限で止まっている操作まで数えてしまう。
    if (this.lastThrottle !== undefined && ctx.input.throttle > this.lastThrottle + 1e-6) {
      this.throttleRaised = true;
    }
    this.lastThrottle = ctx.input.throttle;

    if (ctx.input.afterburner) this.usedActions.add('afterburner');
    const step = this.steps()[this.index];
    if (!step) {
      this.completeAll();
      return;
    }
    // 案内した操作をやったら次へ。読む時間 (minShow) は必ず確保する。
    if (this.stepElapsed >= (step.minShow ?? 0) && step.done(ctx, this)) this.advance();
  }

  /** 現在の案内を確認したら次のステップへ進める。最後まで来たら終える。 */
  private advance(): void {
    if (!this.active) return;
    const steps = this.steps();
    if (this.index + 1 >= steps.length) {
      this.completeAll();
      return;
    }
    this.index += 1;
    this.stepElapsed = 0;
    this.render();
  }

  /**
   * 全ステップを通し終えた。
   *
   * 繰り返さずに帯を消す (訓練の帯が任務中ずっと出続けないようにする)。
   * `tutorialDone` は出撃の結果として App が決めるので、ここでは書かない。
   */
  private completeAll(): void {
    this.completed = true;
    this.finish(false);
  }

  private render(): void {
    const steps = this.steps();
    const step = steps[this.index];
    if (!step || !this.active) return;
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
