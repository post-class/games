import type { PortraitSpec } from '../content/pilots';
import { hasPortraitArt, portraitSvg, type Expression } from './Portrait';

/**
 * ブリーフィング/デブリーフィングの「顔が喋る」演出。
 *
 * 本家の艦内ブリーフィングと同じで、上官の顔が大写しになり、
 * 台詞が一行ずつ読み上げられていく。声は持てないので
 *   - 口の開閉 (表情画像2枚の入れ替え)
 *   - 無線合成音 (AudioManager.radioVoice)
 *   - 文字送り
 * の3つを同じ拍で動かして「喋っている」ことを作る。
 *
 * 台詞が進むにつれて右側の資料 (任務目標・飛行計画) が順に開示される。
 * 画面から外されたら自分で後片付けする (App 側に解放義務を持たせない)。
 */

/** 1行の台詞。表情を明示しなければ本文から推定する */
export interface BriefingLine {
  text: string;
  expression?: Expression;
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
  /**
   * 台詞の断片ごとに呼ばれる。無線音を鳴らして長さ (秒) を返す。
   * 音を出さない設定なら 0 を返してよい。
   */
  speak?: (chunk: string) => number;
  /** 右側に並べる資料。台詞の進行に合わせて1枚ずつ開く */
  panels?: string[];
  /** 最初の資料を開くまでに読ませる行数 (挨拶の間は伏せておく) */
  panelDelay?: number;
  /** 全部読み終えたときに呼ばれる */
  onFinish?: () => void;
  /** 顔の枠に出す状態表示 (既定: 通信中) */
  statusLabel?: string;
  /** 文面から表情を決められなかったときの既定 (敗戦報告なら grim など) */
  mood?: Expression;
}

/** 1秒あたりの文字数。日本語の読み上げに合う速さにしてある */
const CPS = 26;
/** 1行読み終えてから次に移るまでの間 (ms) */
const LINE_PAUSE = 1100;
/** 無線音を1回鳴らす長さの目安 (文字数) */
const CHUNK = 12;

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
  private spokenChunks = 0;
  private voiceUntil = 0;
  private timer?: number;
  private raf?: number;
  /** 今の行の文字送りを始めた時刻 (performance.now) */
  private startedAt?: number;
  private done = false;
  private keyHandler = (ev: KeyboardEvent) => this.onKey(ev);

  constructor(o: BriefingSceneOptions) {
    this.o = o;
    this.lines = o.lines.map((l) => (typeof l === 'string' ? { text: l } : l));

    const root = document.createElement('div');
    root.className = 'mc-brief';

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

    // ── 右: 台詞と資料
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

    // 資料は台詞と同じ列に積む。顔が最後まで画面から出ないようにする
    if (o.panels?.length) {
      const side = document.createElement('div');
      side.className = 'mc-brief-side';
      for (const html of o.panels) {
        const p = document.createElement('div');
        p.className = 'mc-brief-panel';
        p.innerHTML = html;
        side.appendChild(p);
        this.panelEls.push(p);
      }
      talk.appendChild(side);
    }

    root.append(view, talk);

    const wrap = document.createElement('div');
    wrap.className = 'mc-brief-wrap';
    wrap.appendChild(root);

    // 画面のどこを叩いても話が進む
    wrap.addEventListener('click', () => this.advance());
    this.el = wrap;
  }

  /** 資料を全部開いて読み終えた状態か */
  get finished(): boolean {
    return this.done;
  }

  start(): void {
    window.addEventListener('keydown', this.keyHandler, true);
    this.nextLine();
    this.tick();
  }

  /**
   * 話を進める。
   * 1回目は今の行を一気に出し、出し終わっていれば次の行へ移る。
   */
  advance(): void {
    if (this.done) return;
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

  /** 残り全部を出して終わらせる */
  skip(): void {
    if (this.done) return;
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
    this.spokenChunks = 0;

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
    if (want === this.chars) {
      this.maybeSpeak(now);
      return;
    }
    this.chars = want;
    this.renderLine();
    this.maybeSpeak(now);

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

  /** 文字送りに合わせて無線音を継ぎ足す */
  private maybeSpeak(now: number): void {
    if (!this.o.speak || now < this.voiceUntil) return;
    const line = this.lines[this.index];
    if (!line) return;
    const from = this.spokenChunks * CHUNK;
    if (from >= line.text.length || from > this.chars) return;
    const chunk = line.text.slice(from, from + CHUNK);
    this.spokenChunks += 1;
    const dur = this.o.speak(chunk);
    this.voiceUntil = now + Math.max(180, dur * 1000);
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
    this.panelEls[lineIndex - (this.o.panelDelay ?? 0)]?.classList.add('open');
  }

  private finish(): void {
    if (this.done) return;
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
