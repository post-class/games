/**
 * タマゴ選択UI（docs/02_ゲーム実装プラン/06_クライアント設計.md §5）
 *
 * ペット未作成のときに1回だけ出る。5種から1匹を選び、名前と性格を決める。
 * DOMで作る（日本語入力があるのでCanvasには描かない）。
 */
import type { PetCatalogEntry } from '@ai-pet/shared';

export interface EggSelection {
  species: string;
  name: string;
  persona: { traitTags: string[]; catchphrase: string; likes: string; dislikes: string };
}

const MAX_TAGS = 3;

export function showEggSelect(catalog: readonly PetCatalogEntry[], onDecide: (sel: EggSelection) => void): void {
  const root = document.createElement('div');
  root.className = 'egg';
  root.dataset['testid'] = 'egg-select';

  let selected = catalog[0]?.species ?? 'mofi';
  const tags = new Set<string>();

  function entry(species: string): PetCatalogEntry | undefined {
    return catalog.find((c) => c.species === species);
  }

  function render(): void {
    const e = entry(selected);
    root.innerHTML = `
      <div class="egg-panel">
        <p class="egg-title">相棒をえらぶ</p>
        <p class="egg-lead">見た目で選んでもいいし、性格で選んでもいい。1匹だけ連れていけます。</p>
        <div class="egg-cards" data-testid="egg-cards">
          ${catalog
            .map(
              (c) => `
            <button class="egg-card${c.species === selected ? ' on' : ''}" data-species="${c.species}"
                    data-testid="egg-card-${c.species}">
              <img src="/assets/placeholder/pet_${c.species}_s.png" alt="${c.displayName}">
              <b>${c.displayName}</b>
              <span>${c.archetype}</span>
            </button>`,
            )
            .join('')}
        </div>

        <div class="egg-form">
          <label>なまえ
            <input id="egg-name" type="text" maxlength="12" value="${e?.displayName ?? ''}"
                   data-testid="egg-name">
          </label>

          <div class="egg-tags">
            <span class="egg-label">せいかく（3つまで）</span>
            <div data-testid="egg-tags">
              ${(e?.suggestedTraitTags ?? [])
                .map(
                  (t) =>
                    `<button class="egg-tag${tags.has(t) ? ' on' : ''}" data-tag="${t}">${t}</button>`,
                )
                .join('')}
            </div>
          </div>

          <label>くちぐせ
            <input id="egg-catchphrase" type="text" maxlength="16" value="${e?.defaultCatchphrase ?? ''}">
          </label>
          <div class="egg-row">
            <label>すきなもの
              <input id="egg-likes" type="text" maxlength="20" value="${e?.defaultLikes ?? ''}">
            </label>
            <label>にがてなもの
              <input id="egg-dislikes" type="text" maxlength="20" value="${e?.defaultDislikes ?? ''}">
            </label>
          </div>
        </div>

        <button class="egg-go" data-testid="egg-decide">この子とくらす</button>
      </div>`;
  }

  render();
  document.body.appendChild(root);

  root.addEventListener('click', (ev) => {
    const target = ev.target as HTMLElement;

    const card = target.closest('.egg-card') as HTMLElement | null;
    if (card?.dataset['species']) {
      selected = card.dataset['species'];
      tags.clear();
      render();
      return;
    }

    const tag = target.closest('.egg-tag') as HTMLElement | null;
    if (tag?.dataset['tag']) {
      const t = tag.dataset['tag'];
      if (tags.has(t)) tags.delete(t);
      else if (tags.size < MAX_TAGS) tags.add(t);
      // 入力中の値を保ったまま描き直す
      const keep = readForm(root);
      render();
      writeForm(root, keep);
      return;
    }

    if (target.closest('.egg-go')) {
      const form = readForm(root);
      const e = entry(selected);
      onDecide({
        species: selected,
        name: form.name || e?.displayName || 'なまえなし',
        persona: {
          traitTags: [...tags],
          catchphrase: form.catchphrase,
          likes: form.likes,
          dislikes: form.dislikes,
        },
      });
      root.remove();
    }
  });
}

interface FormValues {
  name: string;
  catchphrase: string;
  likes: string;
  dislikes: string;
}

function val(root: HTMLElement, id: string): string {
  return (root.querySelector<HTMLInputElement>(`#${id}`)?.value ?? '').trim();
}

function readForm(root: HTMLElement): FormValues {
  return {
    name: val(root, 'egg-name'),
    catchphrase: val(root, 'egg-catchphrase'),
    likes: val(root, 'egg-likes'),
    dislikes: val(root, 'egg-dislikes'),
  };
}

function writeForm(root: HTMLElement, v: FormValues): void {
  const set = (id: string, value: string): void => {
    const el = root.querySelector<HTMLInputElement>(`#${id}`);
    if (el) el.value = value;
  };
  set('egg-name', v.name);
  set('egg-catchphrase', v.catchphrase);
  set('egg-likes', v.likes);
  set('egg-dislikes', v.dislikes);
}
