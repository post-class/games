import {
  PAGER_KEYS,
  pagerClampPage,
  pagerEntryMatches,
  pagerPageCount,
  pagerStatus,
  type PagerFilterOption,
} from './HubPanels';

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
 * 艦内パネルのページ送り1つぶんの状態。
 *
 * HTML には全件が入っている（`HubPanels.pagerHtml`）。ここでは
 * 「今どのページ・どの絞り込みか」だけを持ち、`display` を付け外しする。
 * 情報を削らないので、ページを送れば必ず全件に到達できる。
 */
interface PagerBinding {
  items: HTMLElement[];
  tags: Array<Record<string, string[]>>;
  status: HTMLElement | null;
  empty: HTMLElement | null;
  pageSize: number;
  page: number;
  filters: Array<{
    key: string;
    code: string;
    index: number;
    options: PagerFilterOption[];
    valueEl: HTMLElement | null;
    chip: HTMLElement;
  }>;
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
  private gamepadRaf = 0;
  private gamepadButtons = new Set<number>();
  private pagers: PagerBinding[] = [];

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
    this.pagers = [];
    if (spec.bodyHtml) {
      const p = document.createElement('div');
      p.className = 'mc-panel';
      p.innerHTML = spec.bodyHtml;
      screen.appendChild(p);
      this.bindPagers(p);
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
    this.startGamepadLoop();
  }

  hide(): void {
    if (this.gamepadRaf) cancelAnimationFrame(this.gamepadRaf);
    this.gamepadRaf = 0;
    this.el?.remove();
    this.el = undefined;
    this.spec = undefined;
    this.itemEls = [];
    this.pagers = [];
    this.root.classList.remove('interactive');
  }

  // ───────── ページ送り ─────────

  /**
   * `HubPanels.pagerHtml` が出した一覧を拾い、ページ送りと絞り込みを効かせる。
   *
   * 画面を開き直すと必ず1ページ目・絞り込み「すべて」に戻る
   * （`AI_CODING.md`「表示状態の初期化規則を明確にする」）。
   */
  private bindPagers(panel: HTMLElement): void {
    // DOM を持たない環境（単体テストの最小 DOM）では何もしない
    if (typeof panel.querySelectorAll !== 'function') return;
    const roots = Array.from(panel.querySelectorAll<HTMLElement>('.mc-pager'));
    for (const root of roots) {
      const items = Array.from(root.querySelectorAll<HTMLElement>('.mc-pager-item'));
      const pageSize = Math.max(1, Number(root.dataset.pageSize ?? '8') || 8);
      const binding: PagerBinding = {
        items,
        tags: items.map((el) => readItemTags(el)),
        status: root.querySelector<HTMLElement>('[data-mc-pager-status]'),
        empty: root.querySelector<HTMLElement>('[data-mc-pager-empty]'),
        pageSize,
        page: 0,
        filters: Array.from(root.querySelectorAll<HTMLElement>('[data-mc-pager-filter]')).map((chip) => ({
          key: chip.dataset.mcPagerFilter ?? '',
          code: chip.dataset.mcPagerCode ?? '',
          index: 0,
          options: parseFilterOptions(chip.dataset.mcPagerOptions),
          valueEl: chip.querySelector<HTMLElement>('[data-mc-pager-filter-value]'),
          chip,
        })),
      };
      root.querySelector<HTMLElement>('[data-mc-pager-act="prev"]')?.addEventListener('click', () => {
        this.movePage(binding, -1);
      });
      root.querySelector<HTMLElement>('[data-mc-pager-act="next"]')?.addEventListener('click', () => {
        this.movePage(binding, 1);
      });
      for (const f of binding.filters) {
        f.chip.addEventListener('click', () => {
          f.index = (f.index + 1) % Math.max(1, f.options.length);
          binding.page = 0;
          this.applyPager(binding);
        });
      }
      this.pagers.push(binding);
      this.applyPager(binding);
    }
  }

  private filterOf(binding: PagerBinding): Record<string, string> {
    const out: Record<string, string> = {};
    for (const f of binding.filters) out[f.key] = f.options[f.index]?.value ?? '';
    return out;
  }

  private applyPager(binding: PagerBinding): void {
    const filter = this.filterOf(binding);
    const visible: number[] = [];
    binding.tags.forEach((tags, i) => {
      if (pagerEntryMatches(tags, filter)) visible.push(i);
    });
    const pages = pagerPageCount(visible.length, binding.pageSize);
    binding.page = pagerClampPage(binding.page, pages);
    const from = binding.page * binding.pageSize;
    const shown = new Set(visible.slice(from, from + binding.pageSize));
    binding.items.forEach((el, i) => {
      el.style.display = shown.has(i) ? '' : 'none';
    });
    if (binding.status) {
      binding.status.textContent = pagerStatus(binding.page, pages, visible.length, binding.items.length);
    }
    if (binding.empty) binding.empty.hidden = visible.length > 0;
    for (const f of binding.filters) {
      if (f.valueEl) f.valueEl.textContent = f.options[f.index]?.label ?? 'すべて';
      f.chip.classList.toggle('active', !!f.options[f.index]?.value);
    }
  }

  private movePage(binding: PagerBinding, delta: number): void {
    const filter = this.filterOf(binding);
    const visible = binding.tags.filter((tags) => pagerEntryMatches(tags, filter)).length;
    const pages = pagerPageCount(visible, binding.pageSize);
    binding.page = (binding.page + delta + pages) % pages;
    this.applyPager(binding);
  }

  /** ページ送り・絞り込みのキー。ページャがある画面でだけ拾う。 */
  private onPagerKey(code: string): boolean {
    if (!this.pagers.length) return false;
    if (code === PAGER_KEYS.prev || code === PAGER_KEYS.next) {
      const delta = code === PAGER_KEYS.next ? 1 : -1;
      this.pagers.forEach((b) => this.movePage(b, delta));
      return true;
    }
    let hit = false;
    for (const b of this.pagers) {
      for (const f of b.filters) {
        if (f.code !== code) continue;
        f.index = (f.index + 1) % Math.max(1, f.options.length);
        b.page = 0;
        hit = true;
      }
      if (hit) this.applyPager(b);
    }
    return hit;
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
    if (this.onPagerKey(ev.code)) {
      ev.preventDefault();
      return;
    }
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

  /** メニュー中もゲームパッドで移動・決定・キャンセルできるようにする。 */
  private startGamepadLoop(): void {
    const tick = () => {
      if (!this.el) return;
      this.pollGamepad();
      this.gamepadRaf = requestAnimationFrame(tick);
    };
    this.gamepadRaf = requestAnimationFrame(tick);
  }

  private pollGamepad(): void {
    const pads = navigator.getGamepads?.() ?? [];
    const pad = Array.from(pads).find((p): p is Gamepad => !!p && p.connected);
    if (!pad) {
      this.gamepadButtons.clear();
      return;
    }
    const pressed = new Set<number>();
    pad.buttons.forEach((button, index) => {
      if (button.pressed || button.value > 0.5) pressed.add(index);
    });
    for (const index of pressed) {
      if (this.gamepadButtons.has(index)) continue;
      switch (index) {
        case 12:
          this.move(-1);
          break;
        case 13:
          this.move(1);
          break;
        case 0:
          this.select();
          break;
        case 1:
          this.spec?.onCancel?.();
          break;
      }
    }
    this.gamepadButtons = pressed;
  }

  dispose(): void {
    window.removeEventListener('keydown', this.keyHandler);
    this.hide();
  }
}

/** 項目の `data-f-<key>="a b"` を絞り込み用のタグへ戻す。 */
function readItemTags(el: HTMLElement): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const attrs = el.attributes;
  for (let i = 0; i < attrs.length; i++) {
    const name = attrs[i].name;
    if (!name.startsWith('data-f-')) continue;
    out[name.slice('data-f-'.length)] = attrs[i].value.split(/\s+/).filter(Boolean);
  }
  return out;
}

function parseFilterOptions(raw: string | undefined): PagerFilterOption[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (o): o is PagerFilterOption =>
        !!o && typeof o === 'object' && typeof (o as PagerFilterOption).value === 'string',
    );
  } catch {
    return [];
  }
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
