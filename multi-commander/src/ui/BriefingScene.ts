import type { PortraitSpec } from '../content/pilots';
import { hasPortraitArt, portraitSvg, type Expression } from './Portrait';

/**
 * ブリーフィング/デブリーフィングの「顔が喋る」演出。
 *
 * 本家の艦内ブリーフィングと同じで、上官の顔が大写しになり、
 * 台詞が一行ずつ読み上げられていく。声は持てないので
 *   - 口の開閉 (表情画像2枚の入れ替え)
 *   - 文字送り
 * の2つを同じ拍で動かして「喋っている」ことを作る。
 *
 * 台詞が進むにつれて右側の資料 (任務目標・飛行計画) が順に開示される。
 * 画面から外されたら自分で後片付けする (App 側に解放義務を持たせない)。
 */

/** 1行の台詞。表情を明示しなければ本文から推定する */
export interface BriefingLine {
  text: string;
  expression?: Expression;
}

export type BriefingPanelSlot = 'flight-plan' | 'lower-left' | 'lower-right';

/** 資料の内容と、右列内での表示位置。配列順は開示順でもある。 */
export interface BriefingPanel {
  html: string;
  slot: BriefingPanelSlot;
}

/**
 * 説明のあとに入る質疑（`src/content/briefingQuestions.ts`）。
 *
 * 僚機が一つ質問し、プレイヤーが答えると僚機が返す。**数値は動かさない**
 * （ブリーフィングは開き直せるので、稼げる場所にしない）。
 */
export interface BriefingQuestionView {
  /** 質問する僚機の顔画像 id（パイロット id ではなく人物 id） */
  speakerId: string;
  /** 名札に出す呼び名 */
  speakerName: string;
  /** 質問文 */
  text: string;
  answers: Array<{ id: string; label: string }>;
  /** 答えを選んだときに返す僚機の一言を作る */
  replyFor: (answerId: string) => string;
  /** 答えを選んだ後に呼ばれる（発艦前の一言などに使う） */
  onAnswer?: (answerId: string) => void;
}

export interface BriefingSceneOptions {
  /** 顔画像の id (public/art/tex/face-<id>-<expr>.jpg) */
  speakerId: string;
  /** 名札に出す名前 */
  speakerName: string;
  /** 名札の2行目 (配置・役職) */
  speakerRole?: string;
  lines: Array<string | BriefingLine>;
  /** 顔画像が無いときの SVG フォールバック用 */
  fallback: PortraitSpec;
  /** 右列に置く資料。台詞の進行に合わせて配列順に1枚ずつ開く */
  panels?: BriefingPanel[];
  /** 最初の資料を開くまでに読ませる行数 (挨拶の間は伏せておく) */
  panelDelay?: number;
  /** 全部読み終えたときに呼ばれる */
  onFinish?: () => void;
  /** 顔の枠に出す状態表示 (既定: 通信中) */
  statusLabel?: string;
  /** 文面から表情を決められなかったときの既定 (敗戦報告なら grim など) */
  mood?: Expression;
  /** 説明を読み終えたあとに入る質疑。省略すると質疑なしで終わる */
  question?: BriefingQuestionView;
}

/** 1秒あたりの文字数。日本語の読み上げに合う速さにしてある */
const CPS = 26;
/** 1行読み終えてから次に移るまでの間 (ms) */
const LINE_PAUSE = 1100;

export class BriefingScene {
  readonly el: HTMLElement;

  private readonly lines: BriefingLine[];
  private readonly o: BriefingSceneOptions;
  private readonly faceA: HTMLImageElement;
  private readonly faceEl: HTMLElement;
  private readonly logEl: HTMLElement;
  private readonly nextEl: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly panelEls: HTMLElement[] = [];
  /** 表情画像の事前読み込み。差し替え時にちらつかせない */
  private readonly preload: HTMLImageElement[] = [];

  private index = -1;
  private lineEl?: HTMLElement;
  private chars = 0;
  private timer?: number;
  private raf?: number;
  /** 今の行の文字送りを始めた時刻 (performance.now) */
  private startedAt?: number;
  private done = false;
  /** すでに `start()` したか（二重開始の防止） */
  private started = false;
  /** 質疑を出したか。読み飛ばしても二度は出さない */
  private askedQuestion = false;
  /** 質問を出して答えを待っている間。読み進める操作を止める */
  private awaitingAnswer = false;
  private answerEls: HTMLButtonElement[] = [];
  private keyHandler = (ev: KeyboardEvent) => this.onKey(ev);

  constructor(o: BriefingSceneOptions) {
    this.o = o;
    this.lines = o.lines.map((l) => (typeof l === 'string' ? { text: l } : l));

    const root = document.createElement('div');
    root.className = 'mc-brief mc-briefing-desk';

    // ── 左: CRT の通信画面に映る顔
    const view = document.createElement('div');
    view.className = 'mc-brief-view';
    const face = document.createElement('div');
    face.className = 'mc-brief-face';
    const art = hasPortraitArt(o.speakerId);
    const a = document.createElement('img');
    const b = document.createElement('img');
    a.className = 'a';
    b.className = 'b';
    a.alt = '';
    b.alt = '';
    if (art) {
      a.src = this.faceUrl('neutral');
      b.src = this.faceUrl('talk');
      face.append(a, b);
      for (const e of ['strain', 'grin', 'grim'] as Expression[]) {
        const p = new Image();
        p.src = this.faceUrl(e);
        this.preload.push(p);
      }
    } else {
      // 画像が無い人物は SVG の顔で代替する
      face.innerHTML = portraitSvg(o.fallback, { size: 320, speaking: true });
      face.classList.add('svg');
    }
    this.faceA = a;
    this.faceEl = face;

    const glass = document.createElement('div');
    glass.className = 'mc-brief-glass';

    const plate = document.createElement('div');
    plate.className = 'mc-brief-plate';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = o.speakerName;
    plate.appendChild(name);
    if (o.speakerRole) {
      const role = document.createElement('div');
      role.className = 'role';
      role.textContent = o.speakerRole;
      plate.appendChild(role);
    }

    const status = document.createElement('div');
    status.className = 'mc-brief-status';
    status.innerHTML =
      `<i></i><span>${o.statusLabel ?? '通信中'}</span>` +
      `<span class="mc-vu">${'<b></b>'.repeat(7)}</span>`;
    this.statusEl = status;

    view.append(face, glass, plate, status);

    // ── 中央: 台詞
    const talk = document.createElement('div');
    talk.className = 'mc-brief-talk';
    const log = document.createElement('div');
    log.className = 'mc-brief-log';
    const next = document.createElement('div');
    next.className = 'mc-brief-next';
    next.textContent = '▼';
    talk.append(log, next);
    this.logEl = log;
    this.nextEl = next;

    // ── 右: 飛行計画とその他の資料
    if (o.panels?.length) {
      const side = document.createElement('div');
      side.className = 'mc-brief-side';
      const title = document.createElement('h3');
      title.textContent = 'その他';
      const lower = document.createElement('div');
      lower.className = 'mc-brief-side-lower';
      side.append(title);
      for (const panel of o.panels) {
        const p = document.createElement('div');
        p.className = `mc-brief-panel ${panel.slot} preview`;
        p.dataset.slot = panel.slot;
        p.innerHTML = panel.html;
        if (panel.slot === 'flight-plan') side.appendChild(p);
        else lower.appendChild(p);
        this.panelEls.push(p);
      }
      if (lower.childElementCount) side.appendChild(lower);
      root.append(view, talk, side);
    } else {
      root.append(view, talk);
    }

    const wrap = document.createElement('div');
    wrap.className = 'mc-brief-wrap';
    wrap.appendChild(root);

    // 画面のどこを叩いても話が進む（start() 前に叩かれても成立させる）
    wrap.addEventListener('click', () => {
      if (!this.started) this.start();
      else this.advance();
    });
    this.el = wrap;
  }

  /** 資料を全部開いて読み終えた状態か */
  get finished(): boolean {
    return this.done;
  }

  start(): void {
    // 二重に始めない。画面に載せた直後にクリックで先へ進められた場合、
    // 遅れて届く start() が読み終わり判定を巻き戻してしまう。
    if (this.started) return;
    this.started = true;
    window.addEventListener('keydown', this.keyHandler, true);
    this.nextLine();
    this.tick();
  }

  /**
   * 話を進める。
   * 1回目は今の行を一気に出し、出し終わっていれば次の行へ移る。
   */
  advance(): void {
    if (this.done || this.awaitingAnswer) return;
    const line = this.lines[this.index];
    if (line && this.chars < line.text.length) {
      this.chars = line.text.length;
      this.completeLine();
      this.scheduleNext(320);
      return;
    }
    this.clearTimer();
    this.nextLine();
  }

  /** 残り全部を出して終わらせる（質疑があるときは質問まで進める） */
  skip(): void {
    if (this.done || this.awaitingAnswer) return;
    this.clearTimer();
    while (this.index < this.lines.length - 1) {
      this.chars = this.lines[this.index]?.text.length ?? 0;
      this.renderLine();
      this.nextLine(true);
    }
    this.chars = this.lines[this.index]?.text.length ?? 0;
    this.renderLine();
    this.finish();
  }

  dispose(): void {
    this.clearTimer();
    if (this.raf !== undefined) cancelAnimationFrame(this.raf);
    this.raf = undefined;
    window.removeEventListener('keydown', this.keyHandler, true);
  }

  // ───────── 内部 ─────────

  private faceUrl(exp: Expression): string {
    return `${import.meta.env.BASE_URL}art/tex/face-${this.o.speakerId}-${exp}.jpg`;
  }

  private onKey(ev: KeyboardEvent): void {
    if (!this.el.isConnected) {
      this.dispose();
      return;
    }
    if (this.done) return;
    if (this.awaitingAnswer) {
      // 答えは数字キーで選ぶ
      const n = Number(ev.code.replace(/^(Digit|Numpad)/, ''));
      const btn = Number.isInteger(n) ? this.answerEls[n - 1] : undefined;
      if (btn) {
        ev.preventDefault();
        ev.stopPropagation();
        btn.click();
        return;
      }
      if (ev.code === 'Space') {
        // 「読み進める」キーは止める。ここで画面のメニューへ渡すと、
        // 答える前に既定項目（出撃）が選ばれて発艦してしまう。
        ev.preventDefault();
        ev.stopPropagation();
        ev.stopImmediatePropagation();
      }
      // Enter / Esc は通す（答えずに出撃・艦内へ戻るを選べるようにしておく）
      return;
    }
    switch (ev.code) {
      case 'Space':
      case 'Enter':
      case 'NumpadEnter':
        // 読み終わるまでは決定キーを画面のメニューに渡さない。
        // ScreenHost も window で待ち受けているので、同じ節点の購読まで止める
        ev.preventDefault();
        ev.stopPropagation();
        ev.stopImmediatePropagation();
        this.advance();
        break;
      case 'Escape':
        // Esc は「画面を閉じる」ではなく「残りを読み飛ばす」に使う
        ev.preventDefault();
        ev.stopPropagation();
        ev.stopImmediatePropagation();
        this.skip();
        break;
      default:
        break;
    }
  }

  /** 次の行を出し始める。instant なら文字送りの準備だけ行う */
  private nextLine(instant = false): void {
    this.index += 1;
    if (this.index >= this.lines.length) {
      this.finish();
      return;
    }
    const line = this.lines[this.index];
    this.chars = 0;

    const el = document.createElement('div');
    el.className = 'mc-brief-line now';
    this.logEl.querySelectorAll('.mc-brief-line.now').forEach((n) => n.classList.remove('now'));
    this.logEl.appendChild(el);
    this.lineEl = el;
    this.renderLine();

    // 表情を切り替える。喋り始めは口の開閉を有効にする
    this.setExpression(line.expression ?? briefingExpression(line.text, this.o.mood));
    if (!instant) {
      this.faceEl.classList.add('speaking');
      this.statusEl.classList.add('live');
    }
  }

  private setExpression(exp: Expression): void {
    if (this.faceEl.classList.contains('svg')) return;
    // 口を開けた顔 (talk) は開閉用に固定なので、素の表情だけ差し替える
    this.faceA.src = this.faceUrl(exp === 'talk' ? 'neutral' : exp);
  }

  private renderLine(): void {
    if (!this.lineEl) return;
    const line = this.lines[this.index];
    const shown = line.text.slice(0, this.chars);
    const rest = line.text.slice(this.chars);
    // 未表示分は透明で置いておく。1文字ごとに行の高さが変わらないようにする
    this.lineEl.textContent = '';
    this.lineEl.appendChild(document.createTextNode(shown));
    if (rest) {
      const ghost = document.createElement('span');
      ghost.className = 'ghost';
      ghost.textContent = rest;
      this.lineEl.appendChild(ghost);
    }
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  private tick(): void {
    this.raf = requestAnimationFrame(() => this.tick());
    if (!this.el.isConnected) {
      this.dispose();
      return;
    }
    if (this.done) return;
    const line = this.lines[this.index];
    if (!line || this.chars >= line.text.length) return;

    const now = performance.now();
    if (this.startedAt === undefined) this.startedAt = now;
    const want = Math.min(
      line.text.length,
      Math.floor(((now - this.startedAt) / 1000) * CPS),
    );
    if (want === this.chars) return;
    this.chars = want;
    this.renderLine();

    if (this.chars >= line.text.length) {
      this.completeLine();
      this.scheduleNext(LINE_PAUSE);
    }
  }

  /** 今の行を出し切ったときの後処理 */
  private completeLine(): void {
    this.renderLine();
    this.stopSpeaking();
    this.revealPanel(this.index);
  }

  private stopSpeaking(): void {
    this.faceEl.classList.remove('speaking');
    this.statusEl.classList.remove('live');
    this.nextEl.classList.add('on');
  }

  private scheduleNext(delay: number): void {
    this.clearTimer();
    this.timer = window.setTimeout(() => {
      this.timer = undefined;
      this.startedAt = undefined;
      this.nextEl.classList.remove('on');
      this.nextLine();
    }, delay);
  }

  private clearTimer(): void {
    if (this.timer !== undefined) window.clearTimeout(this.timer);
    this.timer = undefined;
    this.startedAt = undefined;
  }

  /** 台詞の進行に合わせて資料を1枚開く */
  private revealPanel(lineIndex: number): void {
    const panel = this.panelEls[lineIndex - (this.o.panelDelay ?? 0)];
    if (!panel) return;
    panel.classList.add('open');
    panel.classList.remove('preview');
  }

  /**
   * 質疑を開く。台詞欄の下に僚機の顔と質問を出し、答えを押させる。
   *
   * 答えを押すと僚機の返しを足して、そのまま読み終わり（`finish`）へ進む。
   * 画面を作り直さないので、ここまでの台詞が消えない。
   */
  private openQuestion(q: BriefingQuestionView): void {
    this.awaitingAnswer = true;
    const wrap = document.createElement('div');
    wrap.className = 'mc-brief-qa';
    // 質問が「読み進める」クリックで飛ばされないようにする
    wrap.addEventListener('click', (ev) => ev.stopPropagation());

    const head = document.createElement('div');
    head.className = 'mc-brief-qa-head';
    const face = document.createElement('img');
    face.src = `${import.meta.env.BASE_URL}art/tex/face-${q.speakerId}-talk.jpg`;
    face.alt = '';
    // 顔画像が無い僚機でも枠を崩さない
    face.addEventListener('error', () => face.remove());
    const who = document.createElement('div');
    const name = document.createElement('b');
    name.textContent = q.speakerName;
    const text = document.createElement('span');
    text.textContent = q.text;
    who.append(name, text);
    head.append(face, who);

    const list = document.createElement('div');
    list.className = 'mc-brief-qa-answers';
    q.answers.forEach((answer, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'mc-brief-qa-answer';
      const key = document.createElement('i');
      key.textContent = String(i + 1);
      const label = document.createElement('span');
      label.textContent = answer.label;
      btn.append(key, label);
      btn.addEventListener('click', () => this.answerQuestion(q, answer.id, answer.label, wrap));
      list.appendChild(btn);
    });

    const cue = document.createElement('div');
    cue.className = 'mc-brief-qa-cue';
    cue.textContent = '1〜3 のキー、またはクリックで答える';
    wrap.append(head, list, cue);
    this.logEl.appendChild(wrap);
    this.logEl.scrollTop = this.logEl.scrollHeight;
    this.nextEl.classList.remove('on');
    this.nextEl.textContent = '';
    this.answerEls = Array.from(list.querySelectorAll('button'));
  }

  /** 答えを1つ選ぶ。選び直しはできない */
  private answerQuestion(
    q: BriefingQuestionView,
    answerId: string,
    label: string,
    wrap: HTMLElement,
  ): void {
    if (!this.awaitingAnswer) return;
    this.awaitingAnswer = false;
    this.answerEls = [];
    wrap.querySelector('.mc-brief-qa-answers')?.remove();
    wrap.querySelector('.mc-brief-qa-cue')?.remove();

    const said = document.createElement('div');
    said.className = 'mc-brief-qa-said';
    const me = document.createElement('p');
    me.className = 'me';
    me.textContent = label;
    const them = document.createElement('p');
    them.className = 'them';
    them.textContent = q.replyFor(answerId);
    said.append(me, them);
    wrap.appendChild(said);
    this.logEl.scrollTop = this.logEl.scrollHeight;

    q.onAnswer?.(answerId);
    this.finish();
  }

  private finish(): void {
    if (this.done) return;
    // 説明を読み終えたら、まず僚機の質問を出す（一度だけ）
    if (this.o.question && !this.askedQuestion) {
      this.askedQuestion = true;
      this.clearTimer();
      this.stopSpeaking();
      this.openQuestion(this.o.question);
      return;
    }
    this.done = true;
    this.clearTimer();
    this.stopSpeaking();
    this.nextEl.classList.remove('on');
    this.nextEl.textContent = '';
    this.faceEl.classList.add('idle');
    this.statusEl.classList.add('closed');
    const label = this.statusEl.querySelector('span');
    if (label) label.textContent = '通信終了';
    this.panelEls.forEach((p) => p.classList.add('open'));
    // 画面が狭くて資料が隠れているときは、話し終わりに合わせて見せる
    if (this.el.scrollHeight > this.el.clientHeight + 8) {
      this.el.scrollTo({ top: this.el.scrollHeight, behavior: 'smooth' });
    }
    this.o.onFinish?.();
  }
}

/** ブリーフィングの文面から表情を選ぶ (無線用より落ち着いた振り分け) */
export function briefingExpression(text: string, fallback: Expression = 'talk'): Expression {
  if (/死ぬな|死ぬ|失った|戦死|墓|喪|失敗|痛|犠牲/.test(text)) return 'grim';
  if (/よくやった|見事|上出来|誇り|感謝|よし/.test(text)) return 'grin';
  if (/急|直ちに|絶対|許さ|逃がす|全力|必ず|なんとしても|撃破せよ/.test(text)) return 'strain';
  return fallback;
}
