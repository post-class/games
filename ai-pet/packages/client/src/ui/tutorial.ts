/**
 * 最初の3分の導線（docs/02_ゲーム実装プラン/09_マイルストーン計画.md M8）
 *
 * 「説明なしで5分遊んでもらえる」ための最小限の案内。
 * このゲームは**やらなくてもいい**設計（docs 01章 §1-3）なので、
 * 強制も達成報酬も付けず、「次にこれができる」を1つずつ出して消えるだけにする。
 *
 * 進行はプレイヤーの実際の操作で進む（時間切れでも次へ進む）。
 * 一度終わったら二度と出さない（localStorage）。
 */

const DONE_KEY = 'pokomofu.tutorial.done';

export type TutorialStep = 'move' | 'talk' | 'pet' | 'harvest' | 'place' | 'done';

interface StepDef {
  id: TutorialStep;
  text: string;
  /** タッチ端末での文言。キーの名前を出しても意味がないので言い換える */
  touchText?: string;
  /** この操作をしたら次へ */
  next: TutorialStep;
  /** 操作がなくてもこの秒数で次へ（放置してもゲームが止まらない） */
  timeoutSec: number;
}

const STEPS: readonly StepDef[] = [
  {
    id: 'move',
    text: 'WASD か 画面クリックで島を歩けます',
    touchText: '左下のスティックか、行きたい場所をタップで歩けます',
    next: 'talk',
    timeoutSec: 40,
  },
  {
    id: 'talk',
    text: 'Enter で話しかけると、ペットが自分の言葉で返します',
    touchText: '「はなす」で話しかけると、ペットが自分の言葉で返します',
    next: 'pet',
    timeoutSec: 60,
  },
  {
    id: 'pet',
    text: 'ペットをクリックすると撫でられます（Space で今の気持ちを見る）',
    touchText: 'ペットをタップすると撫でられます（「ペット」で今の気持ち）',
    next: 'harvest',
    timeoutSec: 50,
  },
  {
    id: 'harvest',
    text: '木の実や畑をクリックすると採れます。水やりもできます',
    touchText: '木の実や畑をタップすると採れます。水やりもできます',
    next: 'place',
    timeoutSec: 50,
  },
  {
    id: 'place',
    text: 'B でベンチを置くと、動物が集まってきます',
    touchText: '「ベンチ」を押して置くと、動物が集まってきます',
    next: 'done',
    timeoutSec: 50,
  },
];

export class Tutorial {
  private el: HTMLElement;
  private index = 0;
  private startedAt = 0;
  private active: boolean;

  constructor() {
    this.active = localStorage.getItem(DONE_KEY) !== '1';

    this.el = document.createElement('div');
    this.el.className = 'tut hidden';
    this.el.dataset['testid'] = 'tutorial';
    document.body.appendChild(this.el);

    this.el.addEventListener('click', () => this.skipAll());

    // 画面の向きや幅が変わったら置き場所を見直す
    window.addEventListener('resize', () => this.place());
  }

  /**
   * 置き場所を決める。
   *
   * 広い画面は画面上部の中央に浮かせる。
   * 狭い画面は**チャット欄の中（いちばん上）に流し込む**。
   * 絶対配置で「チャット欄の少し上」に置くやり方だと、
   * 通知が溜まってチャットログが伸びたときに必ず重なる。
   */
  private place(): void {
    const narrow = window.matchMedia('(max-width: 640px)').matches;
    const chat = document.querySelector('.chat');
    if (narrow && chat) {
      if (this.el.parentElement !== chat) chat.insertBefore(this.el, chat.firstChild);
      this.el.classList.add('in-chat');
    } else {
      if (this.el.parentElement !== document.body) document.body.appendChild(this.el);
      this.el.classList.remove('in-chat');
    }
  }

  /** 島に入ったら開始する（ペット作成後に呼ぶ） */
  start(): void {
    if (!this.active) return;
    this.index = 0;
    this.place();
    this.show();
  }

  /** プレイヤーが操作したことを知らせる。該当ステップなら次へ進む */
  did(step: TutorialStep): void {
    if (!this.active) return;
    const current = STEPS[this.index];
    if (!current || current.id !== step) return;
    this.advance();
  }

  /** 毎フレーム呼ぶ（放置しても進むように） */
  update(nowMs: number): void {
    if (!this.active) return;
    const current = STEPS[this.index];
    if (!current) return;
    if (this.startedAt === 0) this.startedAt = nowMs;
    if (nowMs - this.startedAt > current.timeoutSec * 1000) this.advance();
  }

  private advance(): void {
    this.index++;
    this.startedAt = 0;
    if (this.index >= STEPS.length) {
      this.finish();
      return;
    }
    this.show();
  }

  private show(): void {
    const current = STEPS[this.index];
    if (!current) return;
    // タッチ端末にキーの名前を出しても伝わらないので言い換える
    const touch = window.matchMedia('(pointer: coarse)').matches || document.body.classList.contains('has-pad');
    this.el.textContent = (touch && current.touchText) || current.text;
    this.el.classList.remove('hidden');
    // 出た瞬間に少し弾ませる（気づいてもらうため）
    this.el.classList.remove('pop');
    void this.el.offsetWidth; // リフローを起こしてアニメを再生させる
    this.el.classList.add('pop');
  }

  /** クリックで全部飛ばす（案内が邪魔な人のため） */
  private skipAll(): void {
    this.finish();
  }

  private finish(): void {
    this.active = false;
    this.el.classList.add('hidden');
    localStorage.setItem(DONE_KEY, '1');
  }

  get isActive(): boolean {
    return this.active;
  }

  /** 開発用（`?tut=1` でやり直す） */
  static reset(): void {
    localStorage.removeItem(DONE_KEY);
  }
}
