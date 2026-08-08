/**
 * タマゴ選択UI（docs/02_ゲーム実装プラン/06_クライアント設計.md §5）
 *
 * ペット未作成のときに1回だけ出る。5種から1匹を選び、名前と性格を決める。
 * DOMで作る（日本語入力があるのでCanvasには描かない）。
 */
import type { PetCatalogEntry } from '@ai-pet/shared';
import { DEFAULT_PLAYER_SPECIES, PLAYER_SPECIES } from '../state/species.ts';

export interface EggSelection {
  species: string;
  name: string;
  /**
   * 自分のアバターの色（D-5）。省略すると**サーバが playerId のハッシュで決定論的に割り振る**ので、
   * 「選ばなかった人が全員同じ色になる」ことはない。
   */
  avatar?: string;
  persona: { traitTags: string[]; catchphrase: string; likes: string; dislikes: string };
}

/**
 * アバターの色の表示名。`state/species.ts` の `PLAYER_SPECIES`（a..d）と**同じ順**にすること。
 * 服の色はアセット側で決まっている（a=紫 / b=緑 / c=桃 / d=黄）。
 */
const AVATAR_LABEL: Record<string, string> = { a: 'むらさき', b: 'みどり', c: 'もも', d: 'きいろ' };

const MAX_TAGS = 3;

export function showEggSelect(catalog: readonly PetCatalogEntry[], onDecide: (sel: EggSelection) => void): void {
  const root = document.createElement('div');
  root.className = 'egg';
  root.dataset['testid'] = 'egg-select';

  let selected = catalog[0]?.species ?? 'mofi';
  let avatar = DEFAULT_PLAYER_SPECIES;
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
              <img class="egg-img" src="/assets/game/egg_${c.species}.png" alt="${c.displayName}のタマゴ"
                   onerror="this.src='/assets/game/pet_${c.species}_s.png'">
              <b>${c.displayName}</b>
              <span>${c.archetype}</span>
            </button>`,
            )
            .join('')}
        </div>

        <div class="egg-avatars">
          <span class="egg-label">じぶんのふく</span>
          <div data-testid="egg-avatars">
            ${PLAYER_SPECIES.map(
              (a) => `
              <button class="egg-avatar av-${a}${a === avatar ? ' on' : ''}" data-avatar="${a}"
                      data-testid="egg-avatar-${a}" title="${AVATAR_LABEL[a] ?? a}">
                <img src="/assets/game/player_${a}_s.png" alt="${AVATAR_LABEL[a] ?? a}のふく">
              </button>`,
            ).join('')}
          </div>
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

    const av = target.closest('.egg-avatar') as HTMLElement | null;
    if (av?.dataset['avatar']) {
      avatar = av.dataset['avatar'];
      // 入力中の値を保ったまま描き直す（タグと同じ扱い）
      const keep = readForm(root);
      render();
      writeForm(root, keep);
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
      // 宣伝資料は「5種のタマゴから1匹を連れて行けます」なので、
      // 選んだタマゴが割れて中身が出る一呼吸を入れる（E-4）。
      // ⚠️ 演出中に二度押しできないようボタンを無効化する。
      // `prefers-reduced-motion` では待たずに即決定する（案内が進まないと感じさせない）。
      hatch(root, selected);
      const reduced =
        typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const decide = (): void => {
        onDecide(pack(selected, form, e));
        root.remove();
      };
      if (reduced) {
        decide();
        return;
      }
      window.setTimeout(decide, HATCH_MS);
      return;
    }

  });

  /** フォームの値を `EggSelection` にまとめる（決定と即決定の2経路で使う） */
  function pack(species: string, form: FormValues, e: PetCatalogEntry | undefined): EggSelection {
    return {
      species,
      name: form.name || e?.displayName || 'なまえなし',
      avatar,
      persona: {
        traitTags: [...tags],
        catchphrase: form.catchphrase,
        likes: form.likes,
        dislikes: form.dislikes,
      },
    };
  }
}

/** 孵化の演出にかける時間（ms）。長いと待たされるので1秒弱 */
export const HATCH_MS = 900;

/**
 * 選んだタマゴが割れて中身が出る演出（E-4）。
 *
 * 宣伝資料は「5種のタマゴから1匹を連れて行けます」なので、
 * タマゴを選んだのに何の変化もなくゲームが始まると「選んだ実感」が無い。
 *
 * 実装は CSS のアニメーションに任せ、ここでは
 * 「選んだカードに `hatching` を付ける」「画像をペットに差し替える」だけをやる。
 * 他のカードとボタンは操作できないようにする（演出中の二度押しを防ぐ）。
 */
export function hatch(root: HTMLElement, species: string): void {
  root.classList.add('egg-hatching');
  const go = root.querySelector<HTMLButtonElement>('.egg-go');
  if (go) go.disabled = true;
  const card = root.querySelector<HTMLElement>(`.egg-card[data-species="${species}"]`);
  if (!card) return;
  card.classList.add('hatching');
  const img = card.querySelector<HTMLImageElement>('img');
  if (!img) return;
  // 割れる動きの途中で中身（ペット）に差し替える
  window.setTimeout(() => {
    img.src = `/assets/game/pet_${species}_s.png`;
    card.classList.add('hatched');
  }, Math.round(HATCH_MS * 0.45));
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
