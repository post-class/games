/**
 * DOM を持たない vitest 環境（このリポジトリは既定の node 環境のまま）で
 * UI 部品を検証するための最小 DOM。
 *
 * `tests/ut/hud-panel-input.test.ts` と同じ流儀で、`vi.stubGlobal` に
 * `document` / `window` を差し替えて使う（vitest の environment 設定は変えない）。
 * 実装している API は、UI 部品が実際に使うものだけに限る。
 */
import { vi } from 'vitest';

type Listener = (ev: Record<string, unknown>) => void;

export class FakeElement {
  readonly tagName: string;
  className = '';
  readonly children: FakeElement[] = [];
  parent: FakeElement | null = null;
  innerHTML = '';
  isConnected = true;
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  readonly attributes: Record<string, string> = {};
  private text = '';
  private readonly listeners = new Map<string, Listener[]>();

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }

  get classList() {
    const set = () => new Set(this.classNames());
    return {
      add: (...names: string[]) => {
        const s = set();
        names.forEach((n) => s.add(n));
        this.className = [...s].join(' ');
      },
      remove: (...names: string[]) => {
        const s = set();
        names.forEach((n) => s.delete(n));
        this.className = [...s].join(' ');
      },
      contains: (name: string) => this.classNames().includes(name),
      toggle: (name: string, force?: boolean) => this.toggle(name, force),
    };
  }

  classNames(): string[] {
    return this.className.split(/\s+/).filter(Boolean);
  }

  get textContent(): string {
    if (this.children.length) return this.children.map((c) => c.textContent).join('');
    return this.text;
  }

  set textContent(value: string) {
    this.children.splice(0, this.children.length).forEach((c) => {
      c.parent = null;
    });
    this.text = value;
  }

  appendChild<T extends FakeElement>(child: T): T {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  append(...nodes: FakeElement[]): void {
    nodes.forEach((n) => this.appendChild(n));
  }

  /** 子をまとめて差し替える (実DOMの replaceChildren 相当) */
  replaceChildren(...nodes: FakeElement[]): void {
    this.children.splice(0, this.children.length).forEach((c) => {
      c.parent = null;
    });
    nodes.forEach((n) => this.appendChild(n));
  }

  remove(): void {
    if (this.parent) {
      const i = this.parent.children.indexOf(this);
      if (i >= 0) this.parent.children.splice(i, 1);
    }
    this.parent = null;
    this.isConnected = false;
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  scrollIntoView(): void {
    /* レイアウトを持たないので何もしない */
  }

  /** class の付け外し。`force` を渡すとその値に合わせる（実DOMと同じ） */
  toggle(name: string, force?: boolean): void {
    if (force === undefined) {
      if (this.classNames().includes(name)) this.classList.remove(name);
      else this.classList.add(name);
      return;
    }
    if (force) this.classList.add(name);
    else this.classList.remove(name);
  }

  addEventListener(type: string, fn: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, fn: Listener): void {
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      list.filter((f) => f !== fn),
    );
  }

  /** テストから発火する（実DOMの dispatchEvent 相当） */
  fire(type: string, ev: Record<string, unknown> = {}): void {
    const base = {
      preventDefault: () => {},
      stopPropagation: () => {},
      stopImmediatePropagation: () => {},
      target: this,
    };
    [...(this.listeners.get(type) ?? [])].forEach((fn) => fn({ ...base, ...ev }));
  }
}

export interface FakeDom {
  /** ルート要素以下から class 名で要素を集める */
  findAll(root: FakeElement, className: string): FakeElement[];
  /** ルート要素以下の文字（innerHTML に入れた SVG 文字列も含む）を連結する */
  text(root: FakeElement): string;
  /** window の keydown を発火する。capture 登録の順に呼ぶ */
  key(code: string, ev?: Record<string, unknown>): void;
  /**
   * `setTimeout` に積まれた処理を実行する。
   * 実際には待たないので、演出の「着いた」判定をテストから進めるために使う。
   */
  flushTimers(): void;
  /** 未消化のタイマーの本数（解放漏れの検査に使う） */
  pendingTimers(): number;
  /** 後片付け */
  restore(): void;
}

/** `document` / `window` を差し替える。テストの beforeEach から呼ぶ。 */
export function installFakeDom(): FakeDom {
  const keyListeners: Listener[] = [];
  /**
   * `setTimeout` の代わり。実際には待たず、`flushTimers()` で消化する。
   * 演出の「一定時間後に着く」を、テストから同期的に進めるために持つ。
   */
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  const setTimer = (fn: () => void): number => {
    const id = nextTimer++;
    timers.set(id, fn);
    return id;
  };
  const clearTimer = (id?: number): void => {
    if (id !== undefined) timers.delete(id);
  };

  const document = {
    createElement: (tag: string) => new FakeElement(tag),
    body: new FakeElement('body'),
  };
  const window = {
    addEventListener: (type: string, fn: Listener) => {
      if (type === 'keydown') keyListeners.push(fn);
    },
    removeEventListener: (type: string, fn: Listener) => {
      if (type !== 'keydown') return;
      const i = keyListeners.indexOf(fn);
      if (i >= 0) keyListeners.splice(i, 1);
    },
    setTimeout: (fn: () => void) => setTimer(fn),
    clearTimeout: clearTimer,
  };
  vi.stubGlobal('document', document);
  vi.stubGlobal('window', window);
  vi.stubGlobal('clearTimeout', clearTimer);
  vi.stubGlobal('setTimeout', (fn: () => void) => setTimer(fn));
  // rAF は回さない。演出の進行は各シーンの同期 API（`settle()` など）で進める
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.stubGlobal('performance', { now: () => 0 });

  const walk = (root: FakeElement, visit: (el: FakeElement) => void): void => {
    visit(root);
    root.children.forEach((c) => walk(c, visit));
  };

  return {
    findAll(root, className) {
      const out: FakeElement[] = [];
      walk(root, (el) => {
        if (el.classNames().includes(className)) out.push(el);
      });
      return out;
    },
    text(root) {
      let s = '';
      walk(root, (el) => {
        if (!el.children.length) s += el.textContent;
        s += el.innerHTML;
      });
      return s;
    },
    key(code, ev = {}) {
      let stopped = false;
      const event = {
        code,
        repeat: false,
        preventDefault: () => {},
        stopPropagation: () => {},
        stopImmediatePropagation: () => {
          stopped = true;
        },
        ...ev,
      };
      for (const fn of [...keyListeners]) {
        if (stopped) break;
        fn(event);
      }
    },
    flushTimers() {
      // 実行中に積まれたタイマーは次の flush に回す（無限ループを避ける）
      const due = [...timers.entries()];
      timers.clear();
      for (const [, fn] of due) fn();
    },
    pendingTimers() {
      return timers.size;
    },
    restore() {
      timers.clear();
      vi.unstubAllGlobals();
    },
  };
}
