/**
 * チャット欄と吹き出し（docs/02_ゲーム実装プラン/06_クライアント設計.md §5, §6）
 *
 * - 入力と履歴はDOM（日本語入力・折返し・読み上げのため）
 * - 吹き出しもDOMで、カメラ座標に合わせて毎フレーム位置だけ更新する
 *   （Pixiのテキストより日本語の折返しが素直で、ストリーミング表示も簡単）
 */

export interface ChatUiOptions {
  onSend: (text: string) => void;
}

export class ChatUi {
  private root: HTMLElement;
  private log: HTMLElement;
  private input: HTMLInputElement;
  /** ストリーミング中の行（convIdごと） */
  private streaming = new Map<string, HTMLElement>();

  constructor(opts: ChatUiOptions) {
    this.root = document.createElement('div');
    this.root.className = 'chat';
    this.root.dataset['testid'] = 'chat';
    this.root.innerHTML = `
      <div class="chat-log" data-testid="chat-log"></div>
      <form class="chat-form">
        <input class="chat-input" type="text" maxlength="200" placeholder="ペットに話しかける（Enter）"
               data-testid="chat-input" autocomplete="off">
        <button class="chat-send" type="submit">はなす</button>
      </form>`;
    document.body.appendChild(this.root);

    this.log = this.root.querySelector('.chat-log') as HTMLElement;
    this.input = this.root.querySelector('.chat-input') as HTMLInputElement;

    this.root.querySelector('.chat-form')?.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const text = this.input.value.trim();
      if (text.length === 0) return;
      this.input.value = '';
      // 送信したらフォーカスを外す。
      // 入力欄に残るとWASDが文字入力に食われて島を歩けなくなる（実機で発見）。
      this.input.blur();
      opts.onSend(text);
    });

    // Enterでチャット欄にフォーカス（ゲーム操作と衝突しないように）
    window.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && document.activeElement !== this.input) {
        this.input.focus();
        ev.preventDefault();
      }
      if (ev.key === 'Escape' && document.activeElement === this.input) this.input.blur();
    });
  }

  /** 入力欄にフォーカスがあるか（移動キーを食わせないために使う） */
  get isTyping(): boolean {
    return document.activeElement === this.input;
  }

  addLine(speaker: string, text: string, cls = ''): HTMLElement {
    const line = document.createElement('p');
    line.className = `chat-line ${cls}`;
    line.innerHTML = `<b>${escapeHtml(speaker)}</b>${escapeHtml(text)}`;
    this.log.appendChild(line);
    while (this.log.children.length > 60) this.log.firstElementChild?.remove();
    this.log.scrollTop = this.log.scrollHeight;
    return line;
  }

  /** ストリーミングの差分を追記する */
  appendChunk(convId: string, speaker: string, delta: string, done: boolean): void {
    let line = this.streaming.get(convId);
    if (!line) {
      line = this.addLine(speaker, '', 'pet');
      this.streaming.set(convId, line);
    }
    if (delta) {
      const body = line.lastChild;
      if (body && body.nodeType === Node.TEXT_NODE) body.textContent = (body.textContent ?? '') + delta;
      else line.appendChild(document.createTextNode(delta));
      this.log.scrollTop = this.log.scrollHeight;
    }
    if (done) {
      // 空のまま終わった行は消す（フォールバックの吹き出しだけが残る）
      if ((line.textContent ?? '').replace(speaker, '').trim().length === 0) line.remove();
      this.streaming.delete(convId);
    }
  }

  /** 完成した応答で行を置き換える（フォールバック時など） */
  replaceLast(convId: string, speaker: string, text: string): void {
    const line = this.streaming.get(convId);
    if (line) {
      line.innerHTML = `<b>${escapeHtml(speaker)}</b>${escapeHtml(text)}`;
      this.streaming.delete(convId);
      return;
    }
    this.addLine(speaker, text, 'pet');
  }

  notice(text: string): void {
    this.addLine('', text, 'notice');
  }
}

// ---------- 吹き出し ----------

interface Bubble {
  el: HTMLElement;
  entityId: number;
  until: number;
}

/** 画面内に出す吹き出しの上限（多すぎるとうるさい） */
const MAX_BUBBLES = 5;

export class BubbleLayer {
  private root: HTMLElement;
  private bubbles: Bubble[] = [];

  constructor() {
    this.root = document.createElement('div');
    this.root.className = 'bubbles';
    this.root.dataset['testid'] = 'bubbles';
    document.body.appendChild(this.root);
  }

  show(entityId: number, text: string, ms: number, nowMs: number): void {
    // 同じ相手の古い吹き出しは差し替える
    this.remove(entityId);
    const el = document.createElement('div');
    el.className = 'bubble';
    el.dataset['entity'] = String(entityId);
    el.textContent = text;
    this.root.appendChild(el);
    this.bubbles.push({ el, entityId, until: nowMs + ms });

    while (this.bubbles.length > MAX_BUBBLES) {
      const old = this.bubbles.shift();
      old?.el.remove();
    }
  }

  remove(entityId: number): void {
    const idx = this.bubbles.findIndex((b) => b.entityId === entityId);
    if (idx >= 0) {
      this.bubbles[idx]?.el.remove();
      this.bubbles.splice(idx, 1);
    }
  }

  /** 毎フレーム、画面座標に合わせて位置を更新する */
  update(nowMs: number, screenPosOf: (entityId: number) => { x: number; y: number } | null): void {
    for (let i = this.bubbles.length - 1; i >= 0; i--) {
      const b = this.bubbles[i] as Bubble;
      if (nowMs >= b.until) {
        b.el.remove();
        this.bubbles.splice(i, 1);
        continue;
      }
      const p = screenPosOf(b.entityId);
      if (!p) {
        b.el.style.display = 'none';
        continue;
      }
      b.el.style.display = '';
      b.el.style.left = `${Math.round(p.x)}px`;
      b.el.style.top = `${Math.round(p.y)}px`;
    }
  }

  count(): number {
    return this.bubbles.length;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return map[c] ?? c;
  });
}
