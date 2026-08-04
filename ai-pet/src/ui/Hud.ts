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
  onOpen(panel: 'chat' | 'memory' | 'social' | 'room' | 'shop'): void;
}

export class Hud {
  private readonly statusHost: HTMLElement;
  private readonly itemHost: HTMLElement;

  constructor(
    private readonly host: HTMLElement,
    private readonly callbacks: HudCallbacks,
  ) {
    this.statusHost = el('div', { class: 'hud-status' });
    this.itemHost = el('div', { class: 'hud-items' });

    const tabs = el(
      'nav',
      { class: 'hud-tabs' },
      button('💬 はなす', () => this.callbacks.onOpen('chat'), 'btn btn-tab'),
      button('📖 おもいで', () => this.callbacks.onOpen('memory'), 'btn btn-tab'),
      button('🏠 おへや', () => this.callbacks.onOpen('room'), 'btn btn-tab'),
      button('🌏 ともだち', () => this.callbacks.onOpen('social'), 'btn btn-tab'),
      button('🛒 おみせ', () => this.callbacks.onOpen('shop'), 'btn btn-tab'),
    );

    this.host.append(this.statusHost, this.itemHost, tabs);
  }

  renderStatus(pet: PetView, coins: number): void {
    clear(this.statusHost);
    const species = findSpecies(pet.species);
    const traits = dominantTraits(pet.personality)
      .map((key) => TRAIT_LABELS[key])
      .join('・');

    const bars = NEED_KEYS.map((key) =>
      el(
        'div',
        { class: 'need', title: NEED_LABELS[key] },
        el('span', { class: 'need-icon' }, NEED_ICON[key] ?? '•'),
        el(
          'span',
          { class: 'need-bar' },
          el('span', {
            class: `need-fill need-${key} ${pet.needs[key] < 30 ? 'need-low' : ''}`,
            style: `width:${pet.needs[key]}%`,
          }),
        ),
      ),
    );

    const progress = stageProgressClient(pet);

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
              { class: 'grow-wrap', title: 'つぎのせいちょうまで' },
              el('span', { class: 'grow-bar' }, el('span', { class: 'grow-fill', style: `width:${Math.round(progress * 100)}%` })),
            )
          : el('span', { class: 'hud-traits' }, 'おとなになった'),
      ),
    );
  }

  renderItems(inventory: InventoryEntry[]): void {
    clear(this.itemHost);
    const usable = inventory
      .map((entry) => ({ entry, item: findItem(entry.itemId) }))
      .filter((row): row is { entry: InventoryEntry; item: ItemDef } => Boolean(row.item))
      .filter((row) => row.item.kind !== 'furniture');

    this.itemHost.append(
      this.careButton('🤍', 'なでる', () => this.callbacks.onStroke()),
      ...usable.map((row) =>
        this.careButton(
          iconFor(row.item),
          `${row.item.name} ×${row.entry.count}`,
          () => this.callbacks.onUseItem(row.item.id),
        ),
      ),
    );

    if (!usable.length) {
      this.itemHost.append(el('p', { class: 'hint' }, 'アイテムがありません。おみせで買えます。'));
    }
  }

  private careButton(icon: string, label: string, onClick: () => void): HTMLElement {
    const node = el(
      'button',
      { class: 'item-btn', type: 'button' },
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
