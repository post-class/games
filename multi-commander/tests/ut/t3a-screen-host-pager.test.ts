import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeDom, type FakeDom } from './fake-dom';
import { ScreenHost } from '../../src/ui/ScreenHost';
import { PAGER_FILTER_CODES, PAGER_KEYS } from '../../src/ui/HubPanels';

/**
 * T3-⑩ ページ送りの DOM 側。
 *
 * `ScreenHost` は `HubPanels.pagerHtml` が出した一覧を拾い、
 * 表示ページだけを `display` で出す。ここでは「全件が DOM に残ったまま、
 * ページを送ると全件に到達できる」ことと、初期状態（1ページ目・絞り込みなし）を固定する。
 *
 * `fake-dom.ts` の最小 DOM は `innerHTML` を文字列として持つだけなので、
 * ページャの構造はこのファイルの `StubEl` で組む（`fake-dom.ts` は編集しない）。
 */

class StubEl {
  className = '';
  hidden = false;
  textContent = '';
  readonly style: Record<string, string> = {};
  readonly dataset: Record<string, string> = {};
  readonly attrs: Record<string, string> = {};
  readonly children: StubEl[] = [];
  private readonly listeners = new Map<string, Array<() => void>>();

  constructor(className = '') {
    this.className = className;
  }

  get classList() {
    return {
      add: (n: string) => {
        if (!this.className.split(/\s+/).includes(n)) this.className = `${this.className} ${n}`.trim();
      },
      remove: (n: string) => {
        this.className = this.className.split(/\s+/).filter((x) => x && x !== n).join(' ');
      },
      contains: (n: string) => this.className.split(/\s+/).includes(n),
      toggle: (n: string, on?: boolean) => {
        if (on) this.classList.add(n);
        else this.classList.remove(n);
      },
    };
  }

  get attributes(): Array<{ name: string; value: string }> {
    return Object.entries(this.attrs).map(([name, value]) => ({ name, value }));
  }

  append(...kids: StubEl[]): StubEl {
    this.children.push(...kids);
    return this;
  }

  remove(): void {
    /* ルートから外す動作は検証に不要 */
  }

  addEventListener(type: string, fn: () => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  click(): void {
    (this.listeners.get('click') ?? []).forEach((fn) => fn());
  }

  private descendants(): StubEl[] {
    return this.children.flatMap((c) => [c, ...c.descendants()]);
  }

  private matches(sel: string): boolean {
    if (sel.startsWith('.')) return this.classList.contains(sel.slice(1));
    const m = /^\[([a-zA-Z-]+)(?:="([^"]*)")?\]$/.exec(sel);
    if (!m) throw new Error(`未対応のセレクタ: ${sel}`);
    const name = m[1];
    const key = name.replace(/^data-/, '').replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    const value = name.startsWith('data-') ? this.dataset[key] : this.attrs[name];
    if (value === undefined) return false;
    return m[2] === undefined ? true : value === m[2];
  }

  querySelectorAll(sel: string): StubEl[] {
    return this.descendants().filter((el) => el.matches(sel));
  }

  querySelector(sel: string): StubEl | null {
    return this.querySelectorAll(sel)[0] ?? null;
  }
}

interface Built {
  panel: StubEl;
  items: StubEl[];
  status: StubEl;
  chip: StubEl;
  prev: StubEl;
  next: StubEl;
}

/** `pagerHtml` と同じ構造を組む（勢力タグ付きの項目 n 件、1ページ 3 件） */
function buildPager(total: number, pageSize = 3): Built {
  const items = Array.from({ length: total }, (_, i) => {
    const el = new StubEl('mc-pager-item');
    el.attrs['data-f-faction'] = i % 2 === 0 ? 'confed' : 'ordo';
    el.attrs['data-f-chapter'] = i < 2 ? '1 2' : '3';
    el.textContent = `item-${i}`;
    return el;
  });
  const status = new StubEl('mc-pager-status');
  status.dataset.mcPagerStatus = '';
  const empty = new StubEl('mc-pager-empty');
  empty.dataset.mcPagerEmpty = '';
  const prev = new StubEl('mc-pager-btn');
  prev.dataset.mcPagerAct = 'prev';
  const next = new StubEl('mc-pager-btn');
  next.dataset.mcPagerAct = 'next';
  const chipValue = new StubEl('');
  chipValue.dataset.mcPagerFilterValue = '';
  const chip = new StubEl('mc-pager-filter');
  chip.dataset.mcPagerFilter = 'faction';
  chip.dataset.mcPagerCode = PAGER_FILTER_CODES.faction;
  chip.dataset.mcPagerOptions = JSON.stringify([
    { value: '', label: 'すべて' },
    { value: 'confed', label: '連邦' },
    { value: 'ordo', label: 'オルド' },
  ]);
  chip.append(chipValue);

  const pager = new StubEl('block mc-pager');
  pager.dataset.pageSize = String(pageSize);
  pager.append(prev, status, next, chip, empty, ...items);
  const panel = new StubEl('mc-panel');
  panel.append(pager);
  return { panel, items, status, chip, prev, next };
}

interface HostInternals {
  el?: unknown;
  pagers: unknown[];
  bindPagers(panel: unknown): void;
}

function visibleTexts(items: StubEl[]): string[] {
  return items.filter((el) => el.style.display !== 'none').map((el) => el.textContent);
}

describe('ScreenHost のページ送り', () => {
  let dom: FakeDom;
  let host: ScreenHost;
  let internals: HostInternals;

  beforeEach(() => {
    dom = installFakeDom();
    vi.stubGlobal('requestAnimationFrame', () => 0);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    host = new ScreenHost(document.createElement('div'));
    internals = host as unknown as HostInternals;
  });

  afterEach(() => {
    host.dispose();
    dom.restore();
  });

  function bind(total: number, pageSize = 3): Built {
    const built = buildPager(total, pageSize);
    internals.el = built.panel; // キー処理を有効にする（show() 相当）
    internals.pagers = [];
    internals.bindPagers(built.panel);
    return built;
  }

  it('初期状態は1ページ目・絞り込みなしで、総件数を表示する', () => {
    const b = bind(7);
    expect(visibleTexts(b.items)).toEqual(['item-0', 'item-1', 'item-2']);
    expect(b.status.textContent).toBe('1 / 3 ページ　7 件');
  });

  it('全件が DOM に残っている（切り捨てていない）', () => {
    const b = bind(7);
    expect(b.items).toHaveLength(7);
    expect(b.panel.querySelectorAll('.mc-pager-item')).toHaveLength(7);
  });

  it('. キーで次ページ、, キーで前ページへ送り、全件に到達できる', () => {
    const b = bind(7);
    const seen = new Set<string>(visibleTexts(b.items));
    for (let i = 0; i < 2; i++) {
      dom.key(PAGER_KEYS.next);
      visibleTexts(b.items).forEach((t) => seen.add(t));
    }
    expect([...seen].sort()).toEqual(b.items.map((el) => el.textContent).sort());
    expect(b.status.textContent).toBe('3 / 3 ページ　7 件');
    // 最終ページは端数の1件だけ
    expect(visibleTexts(b.items)).toEqual(['item-6']);
    dom.key(PAGER_KEYS.prev);
    expect(b.status.textContent).toBe('2 / 3 ページ　7 件');
  });

  it('最終ページから次へ送ると1ページ目に戻る（巡回する）', () => {
    const b = bind(7);
    for (let i = 0; i < 3; i++) dom.key(PAGER_KEYS.next);
    expect(b.status.textContent).toBe('1 / 3 ページ　7 件');
  });

  it('◀ ▶ のクリックでもページが動く', () => {
    const b = bind(7);
    b.next.click();
    expect(visibleTexts(b.items)).toEqual(['item-3', 'item-4', 'item-5']);
    b.prev.click();
    expect(visibleTexts(b.items)).toEqual(['item-0', 'item-1', 'item-2']);
  });

  it('絞り込みキーで条件が変わり、件数表示と1ページ目に戻る', () => {
    const b = bind(7);
    dom.key(PAGER_KEYS.next);
    dom.key(PAGER_FILTER_CODES.faction); // すべて → 連邦
    expect(b.status.textContent).toBe('1 / 2 ページ　4 / 7 件');
    expect(visibleTexts(b.items)).toEqual(['item-0', 'item-2', 'item-4']);
    expect(b.chip.classList.contains('active')).toBe(true);
    dom.key(PAGER_FILTER_CODES.faction); // 連邦 → オルド
    expect(b.status.textContent).toBe('1 / 1 ページ　3 / 7 件');
    expect(visibleTexts(b.items)).toEqual(['item-1', 'item-3', 'item-5']);
    dom.key(PAGER_FILTER_CODES.faction); // オルド → すべて（一周して全件に戻る）
    expect(b.status.textContent).toBe('1 / 3 ページ　7 件');
    expect(b.chip.classList.contains('active')).toBe(false);
  });

  it('絞り込み後もページ送りで該当全件に到達できる', () => {
    const b = bind(7);
    dom.key(PAGER_FILTER_CODES.faction); // 連邦のみ 4件
    const seen = new Set(visibleTexts(b.items));
    dom.key(PAGER_KEYS.next);
    visibleTexts(b.items).forEach((t) => seen.add(t));
    expect([...seen].sort()).toEqual(['item-0', 'item-2', 'item-4', 'item-6']);
  });

  it('画面を閉じるとページャの登録も消える（次の画面へ持ち越さない）', () => {
    bind(7);
    expect(internals.pagers).toHaveLength(1);
    host.hide();
    expect(internals.pagers).toHaveLength(0);
  });

  it('ページャが無い画面では , . を奪わない', () => {
    internals.el = new StubEl('mc-panel');
    internals.pagers = [];
    // 例外なく無視される（項目移動のキー処理へ素通りする）
    expect(() => dom.key(PAGER_KEYS.next)).not.toThrow();
  });
});
