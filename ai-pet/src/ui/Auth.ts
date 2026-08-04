import { SPECIES, type SpeciesId } from '../../shared/types.js';
import { api, ApiError } from '../net/api.js';
import { button, clear, el, toast } from './dom.js';

/** ログイン／新規登録と、最初のペット作成。 */

export function renderAuth(host: HTMLElement, onDone: () => void): void {
  clear(host);
  let mode: 'login' | 'register' = 'register';

  const nameInput = el('input', {
    class: 'field',
    type: 'text',
    placeholder: 'なまえ（2〜16文字）',
    maxlength: 16,
    id: 'auth-name',
  });
  const passInput = el('input', {
    class: 'field',
    type: 'password',
    placeholder: 'あいことば（4文字以上）',
    id: 'auth-pass',
  });

  const submit = button('はじめる', async () => {
    const name = nameInput.value.trim();
    const password = passInput.value;
    submit.disabled = true;
    try {
      if (mode === 'register') await api.register(name, password);
      else await api.login(name, password);
      onDone();
    } catch (error) {
      toast(error instanceof ApiError ? error.message : '通信に失敗しました', 'error');
    } finally {
      submit.disabled = false;
    }
  }, 'btn btn-primary btn-wide');

  const toggle = button('もうアカウントがある', () => {
    mode = mode === 'register' ? 'login' : 'register';
    submit.textContent = mode === 'register' ? 'はじめる' : 'ログイン';
    toggle.textContent = mode === 'register' ? 'もうアカウントがある' : 'はじめてなので登録する';
    title.textContent = mode === 'register' ? 'あたらしくはじめる' : 'おかえりなさい';
  }, 'btn btn-ghost');

  const title = el('h2', { class: 'card-title' }, 'あたらしくはじめる');

  host.append(
    el(
      'div',
      { class: 'screen screen-center' },
      el(
        'div',
        { class: 'card card-auth' },
        el('div', { class: 'logo-mark' }, '🥚'),
        el('h1', { class: 'logo-text' }, 'おもいでペット'),
        el(
          'p',
          { class: 'logo-sub' },
          'あなたのことを おぼえている ペットを そだてよう',
        ),
        title,
        nameInput,
        passInput,
        submit,
        toggle,
      ),
    ),
  );
  nameInput.focus();
}

/** 種族選択＋名前。性格はサーバ側で種族バイアス込みに生成される。 */
export function renderCreatePet(host: HTMLElement, onDone: () => void): void {
  clear(host);
  let selected: SpeciesId = SPECIES[0].id;

  const cards = SPECIES.map((species) => {
    const card = el(
      'button',
      { class: 'species-card', type: 'button', 'data-species': species.id },
      el('div', { class: 'species-emoji' }, species.id === 'nimbus' ? '☁️' : species.id === 'pome' ? '🐕' : '🐹'),
      el('div', { class: 'species-name' }, species.name),
      el('div', { class: 'species-tag' }, species.tagline),
    );
    card.addEventListener('click', () => {
      selected = species.id;
      for (const other of cards) other.classList.toggle('selected', other === card);
    });
    return card;
  });
  cards[0].classList.add('selected');

  const nameInput = el('input', {
    class: 'field',
    type: 'text',
    placeholder: 'なまえをつけてね',
    maxlength: 12,
    id: 'pet-name',
  });

  const submit = button('たまごをむかえる', async () => {
    const name = nameInput.value.trim();
    if (!name) {
      toast('なまえを入れてください', 'error');
      return;
    }
    submit.disabled = true;
    try {
      await api.createPet(name, selected);
      onDone();
    } catch (error) {
      toast(error instanceof ApiError ? error.message : '通信に失敗しました', 'error');
      submit.disabled = false;
    }
  }, 'btn btn-primary btn-wide');

  host.append(
    el(
      'div',
      { class: 'screen screen-center' },
      el(
        'div',
        { class: 'card card-auth' },
        el('h1', { class: 'card-title' }, 'どの子をむかえる？'),
        el('div', { class: 'species-grid' }, ...cards),
        el('p', { class: 'hint' }, 'しゅるいで せいかくの かたむきが かわります。おなじしゅるいでも 1匹ずつ ちがう せいかくで 生まれます。'),
        nameInput,
        submit,
      ),
    ),
  );
}
