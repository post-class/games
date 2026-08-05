import { findItem, ITEMS } from '../../shared/items.js';
import type { RoomLayout } from '../../shared/types.js';
import { api, ApiError } from '../net/api.js';
import type { InventoryEntry } from '../net/api.js';
import { button, clear, el, modal, toast } from './dom.js';
import { iconFor } from './Hud.js';

/** おへや（壁・床・家具の配置）とおみせ。 */

const WALL_LABELS: Record<string, string> = {
  cream: 'クリーム',
  mint: 'ミント',
  sky: 'そら',
  rose: 'ローズ',
};
const FLOOR_LABELS: Record<string, string> = {
  wood: 'いた',
  tatami: 'たたみ',
  tile: 'タイル',
  grass: 'くさ',
};

export function openRoomEditor(
  inventory: InventoryEntry[],
  onSaved: (layout: RoomLayout) => void,
): void {
  // 置いた家具が見えるよう、ステージを隠さない高さで開く。
  const handle = modal('おへやを かざる', { compact: true });
  const body = handle.body;
  body.append(el('p', { class: 'hint' }, '読み込み中…'));

  void (async () => {
    try {
      const result = await api.room();
      const layout: RoomLayout = {
        wall: result.layout.wall,
        floor: result.layout.floor,
        furniture: [...result.layout.furniture],
      };
      clear(body);

      const wallRow = el('div', { class: 'chip-row' });
      for (const wall of result.walls) {
        const chip = button(WALL_LABELS[wall] ?? wall, () => {
          layout.wall = wall;
          markActive(wallRow, wall);
          void save();
        }, `btn btn-small ${layout.wall === wall ? 'active' : ''}`);
        chip.dataset.value = wall;
        wallRow.append(chip);
      }

      const floorRow = el('div', { class: 'chip-row' });
      for (const floor of result.floors) {
        const chip = button(FLOOR_LABELS[floor] ?? floor, () => {
          layout.floor = floor;
          markActive(floorRow, floor);
          void save();
        }, `btn btn-small ${layout.floor === floor ? 'active' : ''}`);
        chip.dataset.value = floor;
        floorRow.append(chip);
      }

      const placedHost = el('div', { class: 'placed-list' });
      const ownedHost = el('div', { class: 'owned-list' });

      function renderPlaced(): void {
        clear(placedHost);
        if (!layout.furniture.length) {
          placedHost.append(el('p', { class: 'hint' }, 'まだ なにも おいていません。'));
        }
        layout.furniture.forEach((entry, index) => {
          const item = findItem(entry.itemId);
          const xSlider = el('input', {
            class: 'slider',
            type: 'range',
            min: 0,
            max: 14,
            value: entry.x,
          });
          const ySlider = el('input', {
            class: 'slider',
            type: 'range',
            min: 0,
            max: 6,
            value: entry.y,
          });
          xSlider.addEventListener('input', () => {
            layout.furniture[index].x = Number(xSlider.value);
            onSaved(layout);
          });
          xSlider.addEventListener('change', () => void save());
          ySlider.addEventListener('input', () => {
            layout.furniture[index].y = Number(ySlider.value);
            onSaved(layout);
          });
          ySlider.addEventListener('change', () => void save());

          placedHost.append(
            el(
              'div',
              { class: 'placed-row' },
              el('span', { class: 'item-icon' }, item ? iconFor(item) : '📦'),
              el('span', {}, item?.name ?? entry.itemId),
              el('span', { class: 'slider-wrap' }, '横', xSlider),
              el('span', { class: 'slider-wrap' }, '奥', ySlider),
              button('どける', () => {
                layout.furniture.splice(index, 1);
                renderPlaced();
                onSaved(layout);
                void save();
              }, 'btn btn-small btn-danger'),
            ),
          );
        });
      }

      function renderOwned(): void {
        clear(ownedHost);
        const owned = inventory
          .map((entry) => ({ entry, item: findItem(entry.itemId) }))
          .filter((row) => row.item?.kind === 'furniture');
        if (!owned.length) {
          ownedHost.append(el('p', { class: 'hint' }, 'かぐを もっていません。おみせで 買えます。'));
          return;
        }
        for (const row of owned) {
          const placedCount = layout.furniture.filter((f) => f.itemId === row.item!.id).length;
          const remaining = row.entry.count - placedCount;
          const node = button(
            `${iconFor(row.item!)} ${row.item!.name}（のこり${remaining}）`,
            () => {
              if (remaining <= 0) {
                toast('もう ぜんぶ おいています', 'error');
                return;
              }
              layout.furniture.push({ itemId: row.item!.id, x: 6, y: 1 });
              renderPlaced();
              renderOwned();
              onSaved(layout);
              void save();
            },
            'btn btn-small',
          );
          ownedHost.append(node);
        }
      }

      async function save(): Promise<void> {
        try {
          const saved = await api.saveRoom(layout);
          onSaved(saved.layout);
        } catch (error) {
          toast(error instanceof ApiError ? error.message : '保存に失敗しました', 'error');
        }
      }

      body.append(
        el('h3', { class: 'section-title' }, 'かべ'),
        wallRow,
        el('h3', { class: 'section-title' }, 'ゆか'),
        floorRow,
        el('h3', { class: 'section-title' }, 'おいてある かぐ'),
        placedHost,
        el('h3', { class: 'section-title' }, 'もっている かぐ'),
        ownedHost,
      );
      renderPlaced();
      renderOwned();
    } catch (error) {
      clear(body);
      body.append(el('p', { class: 'hint' }, error instanceof ApiError ? error.message : '読み込みに失敗'));
    }
  })();
}

function markActive(row: HTMLElement, value: string): void {
  for (const child of Array.from(row.children)) {
    child.classList.toggle('active', (child as HTMLElement).dataset.value === value);
  }
}

export function openShop(coins: number, onBought: () => void): void {
  const handle = modal('おみせ');
  const coinLabel = el('p', { class: 'shop-coins' }, `🪙 ${coins}`);
  const list = el('div', { class: 'shop-list' });
  handle.body.append(coinLabel, list);

  let current = coins;
  function render(): void {
    clear(list);
    coinLabel.textContent = `🪙 ${current}`;
    for (const item of ITEMS) {
      list.append(
        el(
          'div',
          { class: 'shop-row' },
          el('span', { class: 'item-icon' }, iconFor(item)),
          el('span', { class: 'shop-name' }, item.name),
          el('span', { class: 'shop-price' }, `🪙 ${item.price}`),
          button('かう', async () => {
            try {
              const result = await api.buy(item.id);
              current = result.coins;
              toast(`${item.name} を かいました`);
              onBought();
              render();
            } catch (error) {
              toast(error instanceof ApiError ? error.message : '買えませんでした', 'error');
            }
          }, 'btn btn-small btn-primary'),
        ),
      );
    }
  }
  render();
}
