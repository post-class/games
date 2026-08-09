import type { VeilChoice } from '../content/veil/chapters';

/**
 * 章末の選択画面（T7-4）。
 *
 * `VeilChapter.choice` を受け取り、`kind` / `question` / `note` と
 * 各選択肢の `label` ＋ `consequence`（次章に何が変わるか）を提示する。
 *
 * - 「正解／不正解」を示す表現は使わない。
 * - 4状態（帰還者／航路信頼／軍令信用／敵エースの誓約）の増減は**ここでは出さない**。
 *   数値の開示はデブリーフ側（T7-5）が担当する。
 * - `applyChoice` を二度呼ばせないため、`onSelect` は1回だけ発火する。
 *
 *   const scene = new ChoiceScene({
 *     choice: chapter.choice,
 *     chapterLabel: `第${chapter.chapter}章`,
 *     onSelect: (choiceId) => { applyChoice(state, chapter.id, choiceId, effectsOf(choiceId)); },
 *   });
 *   host.show({ title: chapter.choice.kind, content: scene.el, hint: scene.hint });
 *   scene.start();
 */

export interface ChoiceSceneOptions {
  choice: VeilChoice;
  /** 選んだ選択肢 id を受け取る。連打・キーリピートでも1回しか呼ばれない。 */
  onSelect: (choiceId: string) => void;
  /** 見出しに添える章の表記（例 '第9章'）。 */
  chapterLabel?: string;
  /** 最初に選択状態にする選択肢 id。 */
  initialId?: string;
}

export const CHOICE_HINT = '←→↑↓ で選択 / Enter で決定 / クリックでも選べます';

export class ChoiceScene {
  readonly el: HTMLElement;
  readonly hint = CHOICE_HINT;

  private readonly o: ChoiceSceneOptions;
  private readonly optionEls: HTMLElement[] = [];
  private index = 0;
  private decided = false;
  private keyHandler = (ev: KeyboardEvent) => this.onKey(ev);

  constructor(o: ChoiceSceneOptions) {
    this.o = o;
    const options = o.choice.options;
    const initial = options.findIndex((opt) => opt.id === o.initialId);
    this.index = initial >= 0 ? initial : 0;

    const root = document.createElement('div');
    root.className = 'mc-choice';

    const head = document.createElement('div');
    head.className = 'mc-choice-head';
    const kind = document.createElement('div');
    kind.className = 'mc-choice-kind';
    kind.textContent = o.chapterLabel ? `${o.chapterLabel} ／ ${o.choice.kind}` : o.choice.kind;
    const question = document.createElement('div');
    question.className = 'mc-choice-question';
    question.textContent = o.choice.question;
    head.append(kind, question);
    if (o.choice.note) {
      const note = document.createElement('div');
      note.className = 'mc-choice-note dim';
      note.textContent = o.choice.note;
      head.appendChild(note);
    }
    root.appendChild(head);

    const list = document.createElement('div');
    list.className = 'mc-choice-options';
    // 2〜4択でレイアウトが崩れないよう、選択肢数を CSS 側の手がかりとして持たせる
    list.dataset.count = String(options.length);
    options.forEach((opt, i) => {
      const el = document.createElement('div');
      el.className = 'mc-choice-option';
      el.dataset.choiceId = opt.id;
      el.setAttribute('role', 'button');

      const label = document.createElement('div');
      label.className = 'mc-choice-label';
      label.textContent = opt.label;

      const consequence = document.createElement('div');
      consequence.className = 'mc-choice-consequence';
      consequence.textContent = opt.consequence;

      const caption = document.createElement('div');
      caption.className = 'mc-choice-caption dim';
      caption.textContent = '次章に変わること';

      el.append(label, caption, consequence);
      el.addEventListener('click', () => {
        if (this.decided) return;
        this.index = i;
        this.highlight();
        this.decide();
      });
      list.appendChild(el);
      this.optionEls.push(el);
    });
    root.appendChild(list);

    this.el = root;
    this.highlight();
  }

  /** いま選択されている選択肢 id */
  get selectedId(): string {
    return this.o.choice.options[this.index]?.id ?? '';
  }

  /** 決定済みか。決定後は入力を受け付けない。 */
  get isDecided(): boolean {
    return this.decided;
  }

  start(): void {
    // ScreenHost も window で Enter を待っているので、capture で先に受ける
    window.addEventListener('keydown', this.keyHandler, true);
  }

  dispose(): void {
    window.removeEventListener('keydown', this.keyHandler, true);
  }

  // ───────── 内部 ─────────

  private highlight(): void {
    this.optionEls.forEach((el, i) => {
      if (i === this.index) el.classList.add('sel');
      else el.classList.remove('sel');
    });
    this.optionEls[this.index]?.scrollIntoView?.({ block: 'nearest' });
  }

  private move(delta: number): void {
    if (this.decided) return;
    const n = this.o.choice.options.length;
    if (n === 0) return;
    this.index = (this.index + delta + n) % n;
    this.highlight();
  }

  /** 選択を確定する。`applyChoice` を二度呼ばせないため、最初の1回だけ通す。 */
  private decide(): void {
    if (this.decided) return;
    const opt = this.o.choice.options[this.index];
    if (!opt) return;
    this.decided = true;
    // 決定後は選択肢自体を操作不能にし、状態遷移中の入力で上書きされないようにする
    this.el.classList.add('decided');
    this.optionEls.forEach((el, i) => {
      if (i !== this.index) el.classList.add('dim');
    });
    this.dispose();
    this.o.onSelect(opt.id);
  }

  private onKey(ev: KeyboardEvent): void {
    if (!this.el.isConnected) {
      this.dispose();
      return;
    }
    if (this.decided) return;
    // 押しっぱなしのキーリピートで決定が複数回走らないようにする
    if (ev.repeat) {
      if (ev.code === 'Enter' || ev.code === 'NumpadEnter' || ev.code === 'Space') {
        this.consume(ev);
      }
      return;
    }
    switch (ev.code) {
      case 'ArrowLeft':
      case 'ArrowUp':
        this.consume(ev);
        this.move(-1);
        break;
      case 'ArrowRight':
      case 'ArrowDown':
        this.consume(ev);
        this.move(1);
        break;
      case 'Enter':
      case 'NumpadEnter':
      case 'Space':
        this.consume(ev);
        this.decide();
        break;
      default:
        break;
    }
  }

  /** ScreenHost のメニューへ同じキーを渡さない */
  private consume(ev: KeyboardEvent): void {
    ev.preventDefault();
    ev.stopPropagation();
    ev.stopImmediatePropagation();
  }
}
