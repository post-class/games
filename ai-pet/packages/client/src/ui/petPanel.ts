/**
 * ペット情報パネル（docs/02_ゲーム実装プラン/06_クライアント設計.md §5）
 *
 * 懐き度・いまの目標（LLMが決めた理由）・最近の記憶を出す。
 * 「ペットが自分で考えている」ことがプレイヤーに見えるのはここだけなので、
 * `reason` をそのまま見せる（内部値ではなく、ペットの言葉として読める文が来る前提）。
 */

export interface PetPanelState {
  name: string;
  species: string;
  affection: number;
  mood?: string;
  goal?: string;
  reason?: string;
  memories?: string[];
}

/** 目標の内部名 → 日本語 */
const GOAL_LABEL: Record<string, string> = {
  follow_owner: 'いっしょにいる',
  explore: '島を見にいく',
  visit_friend: '友だちに会いにいく',
  gather: '食べものをさがす',
  help_critter: 'だれかを助ける',
  rest: 'やすんでいる',
  watch_stars: '星をながめる',
  talk_to: 'はなしにいく',
};

export class PetPanel {
  private root: HTMLElement;
  private state: PetPanelState | null = null;
  private open = false;

  constructor() {
    this.root = document.createElement('div');
    this.root.className = 'petpanel hidden';
    this.root.dataset['testid'] = 'pet-panel';
    document.body.appendChild(this.root);

    this.root.addEventListener('click', (ev) => {
      if ((ev.target as HTMLElement).closest('.petpanel-close')) this.hide();
    });
  }

  /** 状態を更新する（表示中なら描き直す） */
  update(patch: Partial<PetPanelState>): void {
    this.state = { ...(this.state ?? { name: 'ペット', species: '', affection: 0 }), ...patch };
    if (this.open) this.render();
  }

  toggle(): void {
    if (this.open) this.hide();
    else this.show();
  }

  show(): void {
    if (!this.state) return;
    this.open = true;
    this.root.classList.remove('hidden');
    this.render();
  }

  hide(): void {
    this.open = false;
    this.root.classList.add('hidden');
  }

  get isOpen(): boolean {
    return this.open;
  }

  private render(): void {
    const s = this.state;
    if (!s) return;
    const filled = Math.max(0, Math.min(10, Math.round(s.affection / 10)));
    const meter = '●'.repeat(filled) + '○'.repeat(10 - filled);
    const goal = s.goal ? (GOAL_LABEL[s.goal] ?? s.goal) : null;

    this.root.innerHTML = `
      <div class="petpanel-head">
        <img src="/assets/game/pet_${s.species}_s.png" alt=""
             onerror="this.src='/assets/placeholder/pet_${s.species}_s.png'">
        <div>
          <b>${escapeHtml(s.name)}</b>
          <span>${escapeHtml(s.mood ?? '')}</span>
        </div>
        <button class="petpanel-close" aria-label="閉じる">×</button>
      </div>

      <p class="petpanel-row">なつき度 <span class="petpanel-meter">${meter}</span> ${Math.round(s.affection)}</p>

      ${
        goal
          ? `<p class="petpanel-row">いまの目標 <b>${escapeHtml(goal)}</b></p>
             ${s.reason ? `<p class="petpanel-reason">「${escapeHtml(s.reason)}」</p>` : ''}`
          : '<p class="petpanel-row petpanel-dim">いまはとくに考えていないみたい</p>'
      }

      ${
        s.memories && s.memories.length > 0
          ? `<p class="petpanel-row">おぼえていること</p>
             <ul class="petpanel-mem">${s.memories
               .slice(0, 3)
               .map((m) => `<li>${escapeHtml(m)}</li>`)
               .join('')}</ul>`
          : ''
      }`;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return map[c] ?? c;
  });
}
