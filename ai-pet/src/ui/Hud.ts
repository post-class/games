import { findItem, type ItemDef } from '../../shared/items.js';
import { TRAIT_LABELS, dominantTraits } from '../../shared/personality.js';
import {
  NEED_KEYS,
  NEED_LABELS,
  STAGE_LABELS,
  findSpecies,
  type PetView,
} from '../../shared/types.js';
import { stageProgressClient } from '../sim/progress.js';
import { wishOf, type Wish } from '../sim/wish.js';
import type { InventoryEntry } from '../net/api.js';
import { button, clear, el } from './dom.js';

/** 画面上部のステータスと、下部の世話ボタン。 */

const NEED_ICON: Record<string, string> = {
  hunger: '🍚',
  fun: '🎾',
  clean: '🫧',
  energy: '⚡',
  mood: '💛',
};

export interface HudCallbacks {
  onUseItem(itemId: string): void;
  onStroke(): void;
  onOpen(panel: 'chat' | 'memory' | 'social' | 'room' | 'shop' | 'game'): void;
}

export class Hud {
  private readonly wishHost: HTMLElement;
  private readonly journalHost: HTMLElement;
  private readonly statusHost: HTMLElement;
  private readonly itemHost: HTMLElement;
  /** 直近のできごと（新しい順）。 */
  private journal: string[] = [];
  /** いま光らせるべき世話の種類（プレイヤーが迷わないように）。 */
  private want: Wish['want'] = 'none';

  constructor(
    private readonly host: HTMLElement,
    private readonly callbacks: HudCallbacks,
  ) {
    this.wishHost = el('div', { class: 'wish' });
    this.journalHost = el('div', { class: 'journal' });
    this.statusHost = el('div', { class: 'hud-status' });
    this.itemHost = el('div', { class: 'hud-items' });

    const tabs = el(
      'nav',
      { class: 'hud-tabs' },
      button('💬 はなす', () => this.callbacks.onOpen('chat'), 'btn btn-tab'),
      button('🎲 あそぶ', () => this.callbacks.onOpen('game'), 'btn btn-tab'),
      button('📖 おもいで', () => this.callbacks.onOpen('memory'), 'btn btn-tab'),
      button('🏠 おへや', () => this.callbacks.onOpen('room'), 'btn btn-tab'),
      button('🌏 ともだち', () => this.callbacks.onOpen('social'), 'btn btn-tab'),
      button('🛒 おみせ', () => this.callbacks.onOpen('shop'), 'btn btn-tab'),
    );

    this.host.append(this.wishHost, this.journalHost, this.statusHost, this.itemHost, tabs);
  }

  /**
   * ペットが勝手にしたことを流す小さなログ。
   *
   * 広いマップだとペットは画面外でも動き続けるので、
   * 見ていなかった間のできごとが1行でも残らないと「何もしていない」ように見える。
   * 3件だけ残して古いものは捨てる（読み切れない量にしない）。
   */
  pushJournal(line: string): void {
    if (this.journal[0] === line) return;
    this.journal = [line, ...this.journal].slice(0, 3);
    clear(this.journalHost);
    this.journal.forEach((text, index) => {
      this.journalHost.append(
        el('p', { class: `journal-line ${index === 0 ? 'journal-fresh' : ''}` }, text),
      );
    });
  }

  renderStatus(pet: PetView, coins: number): void {
    this.renderWish(pet);
    clear(this.statusHost);
    const species = findSpecies(pet.species);
    const traits = dominantTraits(pet.personality)
      .map((key) => TRAIT_LABELS[key])
      .join('・');

    // アイコンだけでは何のバーか分からなかったので、必ずラベルを添える。
    const bars = NEED_KEYS.map((key) =>
      el(
        'div',
        { class: 'need', title: NEED_LABELS[key] },
        el('span', { class: 'need-icon' }, NEED_ICON[key] ?? '•'),
        el(
          'span',
          { class: 'need-body' },
          el('span', { class: 'need-label' }, NEED_LABELS[key]),
          el(
            'span',
            { class: 'need-bar' },
            el('span', {
              class: `need-fill need-${key} ${pet.needs[key] < 30 ? 'need-low' : ''}`,
              style: `width:${pet.needs[key]}%`,
            }),
          ),
        ),
      ),
    );

    const progress = stageProgressClient(pet);
    const nextStage = pet.stage === 'egg' ? 'こども' : 'おとな';

    this.statusHost.append(
      el(
        'div',
        { class: 'hud-head' },
        el(
          'div',
          { class: 'hud-name' },
          el('strong', {}, pet.name),
          el('span', { class: 'chip' }, `${STAGE_LABELS[pet.stage]}`),
          el('span', { class: 'chip chip-quiet' }, species?.name ?? ''),
        ),
        el('div', { class: 'hud-coins' }, `🪙 ${coins}`),
      ),
      el('div', { class: 'need-list' }, ...bars),
      el(
        'div',
        { class: 'hud-foot' },
        el('span', { class: 'hud-traits' }, `せいかく: ${traits}`),
        pet.stage !== 'adult'
          ? el(
              'span',
              { class: 'grow-wrap' },
              el('span', { class: 'grow-caption' }, `${nextStage}まで ${Math.round(progress * 100)}%`),
              el('span', { class: 'grow-bar' }, el('span', { class: 'grow-fill', style: `width:${Math.round(progress * 100)}%` })),
            )
          : el('span', { class: 'hud-traits' }, 'おとなになった'),
      ),
    );
  }

  /** いま何をしてほしいかを1行で見せる。手が止まらないようにするため。 */
  private renderWish(pet: PetView): void {
    const wish = wishOf(pet);
    this.want = wish.want;
    clear(this.wishHost);
    this.wishHost.className = `wish ${wish.urgent ? 'wish-urgent' : ''}`;
    this.wishHost.append(
      el('span', { class: 'wish-icon' }, wish.icon),
      el('span', { class: 'wish-text' }, wish.text),
    );
  }

  renderItems(inventory: InventoryEntry[]): void {
    clear(this.itemHost);
    const usable = inventory
      .map((entry) => ({ entry, item: findItem(entry.itemId) }))
      .filter((row): row is { entry: InventoryEntry; item: ItemDef } => Boolean(row.item))
      .filter((row) => row.item.kind !== 'furniture');

    this.itemHost.append(
      this.careButton('🤍', 'なでる', () => this.callbacks.onStroke(), this.want === 'stroke'),
      ...usable.map((row) =>
        this.careButton(
          iconFor(row.item),
          `${row.item.name} ×${row.entry.count}`,
          () => this.callbacks.onUseItem(row.item.id),
          this.want === row.item.kind,
        ),
      ),
    );

    if (!usable.length) {
      this.itemHost.append(el('p', { class: 'hint' }, 'アイテムがありません。おみせで買えます。'));
    }
  }

  private careButton(
    icon: string,
    label: string,
    onClick: () => void,
    wanted = false,
  ): HTMLElement {
    const node = el(
      'button',
      { class: `item-btn ${wanted ? 'item-wanted' : ''}`, type: 'button' },
      el('span', { class: 'item-icon' }, icon),
      el('span', { class: 'item-label' }, label),
    );
    node.addEventListener('click', onClick);
    return node;
  }
}

export function iconFor(item: ItemDef): string {
  switch (item.id) {
    case 'food_pellet':
      return '🥣';
    case 'food_berry':
      return '🍓';
    case 'food_fish':
      return '🐟';
    case 'food_cake':
      return '🍰';
    case 'toy_ball':
      return '🎾';
    case 'toy_ribbon':
      return '🎀';
    case 'toy_puzzle':
      return '🧩';
    case 'care_brush':
      return '🧹';
    case 'care_towel':
      return '🧺';
    case 'furn_rug':
      return '🟫';
    case 'furn_bed':
      return '🛏️';
    case 'furn_plant':
      return '🪴';
    case 'furn_lamp':
      return '💡';
    case 'furn_shelf':
      return '🗄️';
    case 'furn_window':
      return '🪟';
    default:
      return item.kind === 'food' ? '🍚' : item.kind === 'toy' ? '🎲' : '✨';
  }
}
