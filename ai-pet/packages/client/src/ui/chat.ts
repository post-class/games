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

/**
 * しっぽのぶん持ち上げる量（px）。
 *
 * `main.ts` が渡してくる座標は「ペットの頭のあたり」で、CSSの `.bubble` は
 * そこに**箱の下辺**を合わせる。しっぽ（`.bubble::before`）は箱より14px下へ出るので、
 * その分＋わずかな隙間を足して持ち上げ、しっぽの先がペットの頭を指すようにする。
 * main.ts を触らずに位置を詰められるよう、オフセットはこちら側で吸収している。
 */
const TAIL_LIFT = 20;

/** 重なりを避けるときの縦の隙間（px） */
const STACK_GAP = 6;

/** 画面上の吹き出しの矩形（左右は中央、yは**下辺**） */
export interface BubbleBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * 重なった吹き出しを上へ逃がす。
 *
 * 下にいる子（yが大きい＝手前）を動かさず、かぶった子だけを持ち上げる。
 * 返すのは入力と同じ順の新しい配列（`y` だけが変わる）。
 * DOMを触らない純粋関数にしてあるのはテストしやすさのため。
 */
export function stackBubbles(boxes: readonly BubbleBox[], gap = STACK_GAP): BubbleBox[] {
  const out = boxes.map((b) => ({ ...b }));
  // yの大きい順（画面の下にある順）に確定させる
  const order = out.map((_, i) => i).sort((a, b) => (out[b] as BubbleBox).y - (out[a] as BubbleBox).y);
  const placed: BubbleBox[] = [];
  for (const i of order) {
    const it = out[i] as BubbleBox;
    for (const q of placed) {
      // 横がかすりもしないなら縦は気にしない
      if (Math.abs(it.x - q.x) >= (it.w + q.w) / 2) continue;
      // 矩形は (y - h) 〜 y。重なっていたら相手の上へ逃がす
      if (it.y > q.y - q.h && it.y - it.h < q.y) it.y = q.y - q.h - gap;
    }
    // 画面の外まで押し出さない
    if (it.y < it.h + 4) it.y = it.h + 4;
    placed.push(it);
  }
  return out;
}

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

  /**
   * 毎フレーム、画面座標に合わせて位置を更新する。
   *
   * 「表示の切替 → 大きさの計測 → 位置の書き込み」を3段に分けている。
   * 書いてから読むと要素ごとに再レイアウトが走るので、読みをまとめている。
   */
  update(nowMs: number, screenPosOf: (entityId: number) => { x: number; y: number } | null): void {
    // 1. 期限切れを片付け、画面に出すものだけ拾う
    const shown: { b: Bubble; x: number; y: number }[] = [];
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
      // 大きさを測る前に表示に戻す（display:none のままだと0で返る）
      b.el.style.display = '';
      shown.push({ b, x: p.x, y: p.y - TAIL_LIFT });
    }
    if (shown.length === 0) return;

    // 2. まとめて計測 → 重なりを解消
    const boxes = shown.map((s) => ({
      x: s.x,
      y: s.y,
      w: s.b.el.offsetWidth,
      h: s.b.el.offsetHeight,
    }));
    const stacked = stackBubbles(boxes);

    // 3. まとめて書き込む
    for (let i = 0; i < shown.length; i++) {
      const s = shown[i] as { b: Bubble; x: number; y: number };
      const box = stacked[i] as BubbleBox;
      s.b.el.style.left = `${Math.round(box.x)}px`;
      s.b.el.style.top = `${Math.round(box.y)}px`;
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
