import type { ChatTurn } from '../../shared/types.js';
import { api, ApiError } from '../net/api.js';
import { clear, el, modal, toast, type ModalHandle } from './dom.js';

/** 会話パネル。送信中も入力を止めない（体感を軽くする）。 */

/** 1回に話せる長さ。サーバ側（300文字で切る）より短くしてある。 */
const CHAT_MAX_LENGTH = 200;

export interface ChatPanelOptions {
  petName: string;
  history: ChatTurn[];
  onReply(reply: { say: string; action: string; emotion: string }): void;
  onStateChanged(): void;
}

export function openChatPanel(options: ChatPanelOptions): ModalHandle {
  const handle = modal(`${options.petName} とはなす`);
  const log = el('div', { class: 'chat-log' });
  const input = el('input', {
    class: 'field',
    type: 'text',
    placeholder: 'はなしかけてみよう',
    maxlength: CHAT_MAX_LENGTH,
    id: 'chat-input',
  });
  const send = el('button', { class: 'btn btn-primary', type: 'button', id: 'chat-send' }, 'いう');

  const history = [...options.history];

  function renderLog(): void {
    clear(log);
    if (!history.length) {
      log.append(el('p', { class: 'hint' }, 'まだ なにも はなしていません。'));
    }
    for (const turn of history) {
      log.append(
        el(
          'div',
          { class: `chat-row chat-${turn.role}` },
          el('span', { class: 'chat-who' }, turn.role === 'owner' ? 'あなた' : options.petName),
          el('span', { class: 'chat-text' }, turn.text),
        ),
      );
    }
    log.scrollTop = log.scrollHeight;
  }

  async function submit(): Promise<void> {
    // 入力欄の maxlength と同じ長さで切る。
    // 貼り付けや自動入力は maxlength をすり抜けることがあり、
    // そのままだと「画面には全文、サーバには切り詰めた分」が渡ってずれる（E2E E8）。
    const text = input.value.trim().slice(0, CHAT_MAX_LENGTH);
    if (!text) return;
    input.value = '';
    history.push({ id: Date.now(), role: 'owner', text, emotion: null, createdAt: Date.now() });
    const thinking = el(
      'div',
      { class: 'chat-row chat-pet chat-pending' },
      el('span', { class: 'chat-who' }, options.petName),
      el('span', { class: 'chat-text' }, '…'),
    );
    renderLog();
    log.append(thinking);
    log.scrollTop = log.scrollHeight;
    send.setAttribute('disabled', 'true');

    try {
      const result = await api.chat(text);
      history.push({
        id: Date.now() + 1,
        role: 'pet',
        text: result.reply.say,
        emotion: result.reply.emotion,
        createdAt: Date.now(),
      });
      options.onReply(result.reply);
      if (result.llmError) toast(`AIに繋がりません: ${result.llmError}`, 'error');
      options.onStateChanged();
    } catch (error) {
      toast(error instanceof ApiError ? error.message : '通信に失敗しました', 'error');
    } finally {
      thinking.remove();
      send.removeAttribute('disabled');
      renderLog();
      input.focus();
    }
  }

  send.addEventListener('click', () => void submit());
  input.addEventListener('keydown', (event) => {
    if ((event as KeyboardEvent).key === 'Enter') void submit();
  });

  handle.body.append(log, el('div', { class: 'chat-input-row' }, input, send));
  renderLog();
  setTimeout(() => input.focus(), 50);
  return handle;
}
