import type { WingmanOrder } from '../world/entity';

/** エース宛の通信（T4-⑯）。挑発とは別扱いにする。 */
export type AceCommsKind = 'name' | 'surrender' | 'duel';

export type CommsAction =
  | { kind: 'order'; order: WingmanOrder }
  | { kind: 'taunt' }
  | { kind: 'report' }
  | { kind: 'ace'; ace: AceCommsKind };

/** メニュー内部の遷移（`onPick` へは流さない）。 */
type CommsNav = { kind: 'ace-page' } | { kind: 'back' };

interface CommsItem {
  label: string;
  action: CommsAction | CommsNav;
}

/** 僚機への指示と報告。ここは常に 1..5 で固定する（指が覚えた位置を動かさない）。 */
const BASE_ITEMS: CommsItem[] = [
  { label: '編隊を組め (Form on my wing)', action: { kind: 'order', order: 'form' } },
  { label: '私の目標を攻撃 (Attack my target)', action: { kind: 'order', order: 'attack-my-target' } },
  { label: '散開して交戦 (Break and attack)', action: { kind: 'order', order: 'break-and-attack' } },
  { label: '支援に来い (Help me)', action: { kind: 'order', order: 'help-me' } },
  { label: '僚機の状況を報告 (Report)', action: { kind: 'report' } },
];

const TAUNT_ITEM: CommsItem = { label: '敵を挑発する (Taunt)', action: { kind: 'taunt' } };

/**
 * 通信メニュー (C キー)。
 * 数字キーで直接選ぶか、▲▼ + Enter で選択する。
 *
 * ■ T4-⑯ の追加分（キーは増やさない）
 * ターゲットがエースのときだけ、6番の「敵を挑発する」が
 * 「★ <名前> へ通信」に**入れ替わり**、選ぶと同じ 1..4 のキーで
 * 名乗る／降伏を勧める／決闘を申し込む／戻る を選べるページに切り替わる。
 * 挑発とエース通信を同時に並べないのは、
 * 「名前の無い敵への圧力」と「名前のある相手との交渉」を混ぜないため。
 */
export class CommsMenu {
  private root: HTMLElement;
  private list: HTMLElement;
  private index = 0;
  private page: 'main' | 'ace' = 'main';
  /** ターゲットがエースのときだけ入る表示名。undefined なら従来どおり挑発を出す。 */
  private aceName?: string;
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

  /**
   * 現在ターゲットにしているエースの表示名を渡す（毎フレーム呼んで良い）。
   * エース以外・ターゲット無しのときは undefined。
   */
  setAceTarget(name: string | undefined): void {
    if (this.aceName === name) return;
    this.aceName = name;
    // エースを外したらエースページには留まらない
    if (!name && this.page === 'ace') {
      this.page = 'main';
      this.index = 0;
    }
    if (this.open) this.render();
  }

  /** いま出ている項目（テストと表示の唯一の出所）。 */
  items(): readonly { label: string; action: CommsAction | CommsNav }[] {
    if (this.page === 'ace') {
      const name = this.aceName ?? 'エース';
      return [
        { label: `名を名乗る (${name} へ)`, action: { kind: 'ace', ace: 'name' } },
        { label: '降伏を勧める', action: { kind: 'ace', ace: 'surrender' } },
        { label: '決闘を申し込む', action: { kind: 'ace', ace: 'duel' } },
        { label: '戻る', action: { kind: 'back' } },
      ];
    }
    const last: CommsItem = this.aceName
      ? { label: `★ ${this.aceName} へ通信 (Ace channel)`, action: { kind: 'ace-page' } }
      : TAUNT_ITEM;
    return [...BASE_ITEMS, last];
  }

  /** エース宛の通信を出せる状態か（テスト用）。 */
  get aceChannelAvailable(): boolean {
    return this.aceName !== undefined;
  }

  get currentPage(): 'main' | 'ace' {
    return this.page;
  }

  setOpen(v: boolean): void {
    this.open = v;
    this.root.style.display = v ? '' : 'none';
    if (v) {
      this.index = 0;
      this.page = 'main';
      this.render();
    }
  }

  toggle(): void {
    this.setOpen(!this.open);
  }

  move(delta: number): void {
    if (!this.open) return;
    const n = this.items().length;
    this.index = (this.index + delta + n) % n;
    this.render();
  }

  confirm(): void {
    if (!this.open) return;
    const item = this.items()[this.index];
    if (!item) return;
    // ページ遷移はメニューを閉じずに処理する（キーを増やさないための入れ替え）
    if (item.action.kind === 'ace-page') {
      this.page = 'ace';
      this.index = 0;
      this.render();
      return;
    }
    if (item.action.kind === 'back') {
      this.page = 'main';
      this.index = 0;
      this.render();
      return;
    }
    this.setOpen(false);
    this.onPick(item.action);
  }

  /**
   * 基本項目（1..5 固定）を、メニューを開かずに実行する。
   * Alt 系ショートカット（W7-6）用。エースページの項目は対象にしない
   * （交渉は「相手を選んで開いてから」の操作なので、ショートカットにしない）。
   */
  invokeBaseItem(index: number): boolean {
    const item = BASE_ITEMS[index];
    if (!item) return false;
    // `open` / `page` は触らない。メニューを開かずに命令だけ流す
    this.onPick(item.action as CommsAction);
    return true;
  }

  /** 数字キーによる直接選択 (1-6) */
  pickIndex(i: number): void {
    if (!this.open || i < 0 || i >= this.items().length) return;
    this.index = i;
    this.confirm();
  }

  private render(): void {
    this.list.innerHTML = this.items()
      .map(
        (it, i) =>
          `<div class="mc-comms-item ${i === this.index ? 'sel' : ''}">${i + 1}. ${it.label}</div>`,
      )
      .join('');
  }

  dispose(): void {
    this.root.remove();
  }
}
