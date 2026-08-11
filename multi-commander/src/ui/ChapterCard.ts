import type { VeilChapter } from '../content/veil/chapters';
import { hasPortraitArt, portraitFace } from './Portrait';
import { escapeHtml } from './ScreenHost';

/**
 * 章の導入カード（章の始まりの一幕）。
 *
 * 章に入った最初の一度だけ、ブリーフィングの前に挟む。本家の
 * 「作戦の合間に入る一枚絵と語り」に相当する部分で、
 * `VeilChapter` の `image`（章の一枚絵）と `body`（本文6段落）を使う。
 *
 * 本文は長いので、1画面に2段落ずつ送る。文字送りは行わない
 * （読み物として読ませたいので、送り速度を待たせない）。
 * 進行は `next()` で、最後まで送ると `onFinish` を呼ぶ。
 */

/** 1画面に出す段落数。1280×720 で2段落が読める上限 */
const PARAGRAPHS_PER_PAGE = 2;

export interface ChapterCardOptions {
  chapter: VeilChapter;
  /** 章の一枚絵の URL（`artUrl('tex/story-chNN','jpg')`） */
  image: string;
  /** 全何章か。「第1章 / 全10章」の表示に使う */
  totalChapters: number;
  /** 最後まで読み終えたときに呼ばれる */
  onFinish?: () => void;
}

export class ChapterCard {
  readonly el: HTMLElement;

  private readonly o: ChapterCardOptions;
  private readonly pages: string[][];
  private readonly bodyEl: HTMLElement;
  private readonly pagerEl: HTMLElement;
  private page = 0;

  constructor(o: ChapterCardOptions) {
    this.o = o;
    const ch = o.chapter;
    this.pages = [];
    for (let i = 0; i < ch.body.length; i += PARAGRAPHS_PER_PAGE) {
      this.pages.push(ch.body.slice(i, i + PARAGRAPHS_PER_PAGE));
    }
    if (!this.pages.length) this.pages.push([]);

    const root = document.createElement('div');
    root.className = 'mc-chapter';

    // ── 一枚絵。読み物の背景ではなく、絵として立てる
    const art = document.createElement('div');
    art.className = 'mc-chapter-art';
    art.style.backgroundImage = `url('${o.image}')`;
    art.innerHTML =
      `<div class="mc-chapter-head">` +
      `<span class="no">第${ch.chapter}章 / 全${o.totalChapters}章　${escapeHtml(ch.operation)}</span>` +
      `<h2>${escapeHtml(ch.title)}</h2>` +
      `<p class="tag">${escapeHtml(ch.tagline)}</p>` +
      `</div>` +
      `<div class="mc-chapter-meta">` +
      `<span><b>戦域</b>${escapeHtml(ch.theaterName)}</span>` +
      `<span><b>主目標</b>${escapeHtml(ch.objective)}</span>` +
      `<span><b>${escapeHtml(ch.hook.label)}</b>${escapeHtml(ch.hook.value)}</span>` +
      `</div>`;

    // ── 本文と、この章に出る人物
    const text = document.createElement('div');
    text.className = 'mc-chapter-text';
    const body = document.createElement('div');
    body.className = 'mc-chapter-body';
    const pager = document.createElement('div');
    pager.className = 'mc-chapter-pager';
    text.append(this.castHtmlEl(ch), body, pager);
    this.bodyEl = body;
    this.pagerEl = pager;

    root.append(art, text);
    // 画面のどこを叩いても先へ進む
    root.addEventListener('click', () => this.next());
    this.el = root;
    this.render();
  }

  /** 次のページへ。最後のページで呼ぶと読み終わりになる */
  next(): void {
    if (this.page >= this.pages.length - 1) {
      this.o.onFinish?.();
      return;
    }
    this.page += 1;
    this.render();
  }

  /** 残りを飛ばして最後のページを出す */
  skip(): void {
    this.page = this.pages.length - 1;
    this.render();
  }

  /** 最後のページまで読んだか */
  get finished(): boolean {
    return this.page >= this.pages.length - 1;
  }

  private render(): void {
    this.bodyEl.innerHTML = this.pages[this.page]
      .map((para) => `<p>${escapeHtml(para)}</p>`)
      .join('');
    this.bodyEl.scrollTop = 0;
    const last = this.page >= this.pages.length - 1;
    this.pagerEl.innerHTML =
      `<span class="dim">${this.page + 1} / ${this.pages.length}</span>` +
      `<span class="cue">${last ? 'Enter でブリーフィングへ' : 'Space / クリックで読み進める'}</span>`;
  }

  /** この章に出る人物。顔画像がある人だけ顔を添える */
  private castHtmlEl(ch: VeilChapter): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'mc-chapter-cast';
    wrap.innerHTML = ch.cast
      .map((person) => {
        const face =
          person.id && hasPortraitArt(person.id)
            ? portraitFace(person.id, { skin: '#e7c9a4', hair: '#2b2119', hairStyle: 'short', eyes: 'normal' }, {
                size: 40,
                scanlines: false,
              })
            : '';
        return `<span class="mc-chapter-person">${face}<b>${escapeHtml(person.name)}</b></span>`;
      })
      .join('');
    return wrap;
  }
}
