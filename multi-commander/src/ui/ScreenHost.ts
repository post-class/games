export interface MenuItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  /** 項目の左に置く絵 (透過 PNG の URL) */
  icon?: string;
}

export interface ScreenSpec {
  /** ブリーフィング用の横長レイアウトを使う */
  variant?: 'briefing';
  title?: string;
  subtitle?: string;
  /** 本文 (自前生成の HTML のみを渡す) */
  bodyHtml?: string;
  /** 本文の後に差し込む DOM (設定画面などの操作要素) */
  content?: HTMLElement;
  items?: MenuItem[];
  /** 背景を透過して戦闘画面を見せる (ポーズ画面) */
  transparent?: boolean;
  /** タイトル画面のように見出しを大きく出す */
  heroTitle?: boolean;
  /** 見出しの上に置く紋章 (透過 PNG の URL) */
  crest?: string;
  /** 紋章の高さ (px) */
  crestHeight?: number;
  /**
   * 画面の背景画 (生成画像の URL)。
   * 文字の可読性のために、CSS 側で暗く落として少しぼかす。
   */
  background?: string;
  /** Esc で戻る動作 */
  onCancel?: () => void;
  hint?: string;
}

/**
 * 全画面 UI の表示器。同時に表示される画面は1つだけ。
 * ▲▼ で選択、Enter で決定、Esc で戻る。クリックにも対応する。
 */
export class ScreenHost {
  private root: HTMLElement;
  private el?: HTMLElement;
  private spec?: ScreenSpec;
  private index = 0;
  private itemEls: HTMLElement[] = [];
  private keyHandler = (ev: KeyboardEvent) => this.onKey(ev);

  constructor(container: HTMLElement) {
    this.root = container;
    window.addEventListener('keydown', this.keyHandler);
  }

  get isOpen(): boolean {
    return !!this.el;
  }

  show(spec: ScreenSpec): void {
    this.hide();
    this.spec = spec;
    this.index = spec.items?.findIndex((i) => !i.disabled) ?? 0;
    if (this.index < 0) this.index = 0;

    const screen = document.createElement('div');
    screen.className =
      `mc-screen${spec.transparent ? ' transparent' : ''}${spec.heroTitle ? ' hero' : ''}${spec.variant ? ` ${spec.variant}` : ''}`;
    if (spec.background) {
      const bg = document.createElement('div');
      bg.className = 'mc-screen-bg';
      bg.style.backgroundImage = `url('${spec.background}')`;
      screen.appendChild(bg);
    }

    const addCrest = (parent: HTMLElement) => {
      if (!spec.crest) return;
      const wrap = document.createElement('div');
      wrap.className = 'mc-crest';
      const img = document.createElement('img');
      img.src = spec.crest;
      img.alt = '';
      if (spec.crestHeight) img.style.height = `${spec.crestHeight}px`;
      // 生成物が欠けていても画面が崩れないようにする
      img.addEventListener('error', () => wrap.remove());
      wrap.appendChild(img);
      parent.appendChild(wrap);
    };
    const addTitle = (parent: HTMLElement) => {
      if (!spec.title) return;
      const h = document.createElement('h1');
      h.textContent = spec.title;
      parent.appendChild(h);
    };
    const addSubtitle = (parent: HTMLElement) => {
      if (!spec.subtitle) return;
      const s = document.createElement('div');
      s.className = 'sub';
      s.textContent = spec.subtitle;
      parent.appendChild(s);
    };
    if (spec.variant === 'briefing') {
      const header = document.createElement('header');
      header.className = 'mc-brief-header';
      addCrest(header);
      addTitle(header);
      addSubtitle(header);
      screen.appendChild(header);
    } else {
      addCrest(screen);
      addTitle(screen);
      addSubtitle(screen);
    }
    if (spec.bodyHtml) {
      const p = document.createElement('div');
      p.className = 'mc-panel';
      p.innerHTML = spec.bodyHtml;
      screen.appendChild(p);
    }
    if (spec.content) screen.appendChild(spec.content);

    this.itemEls = [];
    if (spec.items?.length) {
      const menu = document.createElement('div');
      menu.className = 'mc-menu';
      spec.items.forEach((item, i) => {
        const node = document.createElement('div');
        node.className = `mc-menu-item${item.disabled ? ' disabled' : ''}`;
        if (item.icon) {
          node.classList.add('with-icon');
          const img = document.createElement('img');
          img.src = item.icon;
          img.alt = '';
          img.className = 'mc-menu-icon';
          img.addEventListener('error', () => img.remove());
          node.appendChild(img);
          const label = document.createElement('span');
          label.textContent = item.label;
          node.appendChild(label);
        } else {
          node.textContent = item.label;
        }
        if (!item.disabled) {
          node.addEventListener('click', () => {
            this.index = i;
            this.select();
          });
          node.addEventListener('mouseenter', () => {
            this.index = i;
            this.highlight();
          });
        }
        menu.appendChild(node);
        this.itemEls.push(node);
      });
      screen.appendChild(menu);
    }

    if (spec.hint) {
      const h = document.createElement('div');
      h.className = 'mc-hint';
      h.textContent = spec.hint;
      screen.appendChild(h);
    }

    this.root.appendChild(screen);
    this.root.classList.add('interactive');
    this.el = screen;
    this.highlight();
  }

  hide(): void {
    this.el?.remove();
    this.el = undefined;
    this.spec = undefined;
    this.itemEls = [];
    this.root.classList.remove('interactive');
  }

  private highlight(): void {
    this.itemEls.forEach((n, i) => {
      const sel = i === this.index;
      if (sel) n.classList.add('sel');
      else n.classList.remove('sel');
    });
  }

  private move(delta: number): void {
    const items = this.spec?.items;
    if (!items?.length) return;
    let i = this.index;
    for (let k = 0; k < items.length; k++) {
      i = (i + delta + items.length) % items.length;
      if (!items[i].disabled) break;
    }
    this.index = i;
    this.highlight();
  }

  private select(): void {
    const items = this.spec?.items;
    if (!items?.length) return;
    const item = items[this.index];
    if (!item || item.disabled) return;
    item.onSelect();
  }

  private onKey(ev: KeyboardEvent): void {
    if (!this.el) return;
    switch (ev.code) {
      case 'ArrowUp':
      case 'KeyW':
        ev.preventDefault();
        this.move(-1);
        break;
      case 'ArrowDown':
      case 'KeyS':
        ev.preventDefault();
        this.move(1);
        break;
      case 'Enter':
      case 'NumpadEnter':
      case 'Space':
        ev.preventDefault();
        this.select();
        break;
      case 'Escape':
        ev.preventDefault();
        this.spec?.onCancel?.();
        break;
      default:
        break;
    }
  }

  dispose(): void {
    window.removeEventListener('keydown', this.keyHandler);
    this.hide();
  }
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
