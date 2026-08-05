import type { WingmanOrder } from '../world/entity';

export type CommsAction =
  | { kind: 'order'; order: WingmanOrder }
  | { kind: 'taunt' }
  | { kind: 'report' };

interface CommsItem {
  label: string;
  action: CommsAction;
}

const ITEMS: CommsItem[] = [
  { label: '編隊を組め (Form on my wing)', action: { kind: 'order', order: 'form' } },
  { label: '私の目標を攻撃 (Attack my target)', action: { kind: 'order', order: 'attack-my-target' } },
  { label: '散開して交戦 (Break and attack)', action: { kind: 'order', order: 'break-and-attack' } },
  { label: '支援に来い (Help me)', action: { kind: 'order', order: 'help-me' } },
  { label: '僚機の状況を報告 (Report)', action: { kind: 'report' } },
  { label: '敵を挑発する (Taunt)', action: { kind: 'taunt' } },
];

/**
 * 通信メニュー (C キー)。
 * 数字キーで直接選ぶか、▲▼ + Enter で選択する。
 */
export class CommsMenu {
  private root: HTMLElement;
  private list: HTMLElement;
  private index = 0;
  open = false;

  constructor(container: HTMLElement, private onPick: (a: CommsAction) => void) {
    this.root = document.createElement('div');
    this.root.className = 'mc-comms';
    const title = document.createElement('div');
    title.className = 'mc-comms-title';
    title.textContent = '通信 [C で閉じる]';
    this.list = document.createElement('div');
    this.root.append(title, this.list);
    container.appendChild(this.root);
    this.render();
    this.setOpen(false);
  }

  setOpen(v: boolean): void {
    this.open = v;
    this.root.style.display = v ? '' : 'none';
    if (v) {
      this.index = 0;
      this.render();
    }
  }

  toggle(): void {
    this.setOpen(!this.open);
  }

  move(delta: number): void {
    if (!this.open) return;
    this.index = (this.index + delta + ITEMS.length) % ITEMS.length;
    this.render();
  }

  confirm(): void {
    if (!this.open) return;
    const item = ITEMS[this.index];
    this.setOpen(false);
    this.onPick(item.action);
  }

  /** 数字キーによる直接選択 (1-6) */
  pickIndex(i: number): void {
    if (!this.open || i < 0 || i >= ITEMS.length) return;
    this.index = i;
    this.confirm();
  }

  private render(): void {
    this.list.innerHTML = ITEMS.map(
      (it, i) =>
        `<div class="mc-comms-item ${i === this.index ? 'sel' : ''}">${i + 1}. ${it.label}</div>`,
    ).join('');
  }

  dispose(): void {
    this.root.remove();
  }
}
