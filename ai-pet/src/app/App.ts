import { localReaction, type CareKind } from '../../shared/reactions.js';
import { findItem } from '../../shared/items.js';
import type { AwayReport, ChatTurn, PetView } from '../../shared/types.js';
import { api, ApiError, type InventoryEntry } from '../net/api.js';
import { Stage } from '../render/Stage.js';
import { renderAuth, renderCreatePet } from '../ui/Auth.js';
import { openChatPanel } from '../ui/ChatPanel.js';
import { button, clear, el, modal, toast } from '../ui/dom.js';
import { Hud } from '../ui/Hud.js';
import { openMemoryBook } from '../ui/MemoryBook.js';
import { openRoomEditor, openShop } from '../ui/RoomEditor.js';
import { openSocialPanel } from '../ui/SocialPanel.js';

/**
 * 画面全体の司令塔。
 *
 * 手触りの方針（My Talking Tom から学んだ点）:
 * 世話ボタンは「押した瞬間に」定型リアクションとアニメを出し、
 * LLM の一言は返ってきたら差し替える。ユーザは待たされない。
 */

const THINK_POLL_MS = 30_000;

export class App {
  private host: HTMLElement;
  private stage: Stage | null = null;
  private hud: Hud | null = null;
  private pet: PetView | null = null;
  private coins = 0;
  private inventory: InventoryEntry[] = [];
  private chatHistory: ChatTurn[] = [];
  private thinkTimer = 0;
  private llmAvailable = true;

  constructor(host: HTMLElement) {
    this.host = host;
  }

  async start(): Promise<void> {
    try {
      const health = await api.health();
      this.llmAvailable = health.llm;
    } catch {
      this.llmAvailable = false;
    }
    await this.route();
  }

  private async route(): Promise<void> {
    let me: Awaited<ReturnType<typeof api.me>>;
    try {
      me = await api.me();
    } catch {
      toast('サーバに繋がりません', 'error');
      return;
    }

    if (!me.user) {
      renderAuth(this.host, () => void this.route());
      return;
    }
    if (!me.hasPet) {
      renderCreatePet(this.host, () => void this.route());
      return;
    }
    await this.renderGame(me.user.name);
  }

  private async renderGame(userName: string): Promise<void> {
    clear(this.host);
    if (this.thinkTimer) window.clearInterval(this.thinkTimer);

    const stageHost = el('div', { class: 'stage-host' });
    const hudHost = el('div', { class: 'hud' });
    const header = el(
      'header',
      { class: 'app-head' },
      el('span', { class: 'app-title' }, 'おもいでペット'),
      el(
        'span',
        { class: 'app-user' },
        userName,
        button('ログアウト', async () => {
          await api.logout();
          window.location.reload();
        }, 'btn btn-ghost btn-small'),
      ),
    );

    this.host.append(el('div', { class: 'screen screen-game' }, header, stageHost, hudHost));

    this.stage = new Stage(stageHost, {
      onPetTouched: () => void this.care({ kind: 'pet' }),
      onActionChanged: () => {
        /* FSM の行動変化はサーバに送らない（見た目だけ） */
      },
    });
    this.hud = new Hud(hudHost, {
      onUseItem: (itemId) => void this.care({ itemId }),
      onStroke: () => void this.care({ kind: 'pet' }),
      onOpen: (panel) => this.openPanel(panel),
    });

    await this.refresh(true);
    this.stage.start();

    // 自律的な「思いつき」。サーバ側でも間隔を守るので、多少ずれても問題ない。
    this.thinkTimer = window.setInterval(() => void this.think(), THINK_POLL_MS);
  }

  private async refresh(withReport = false): Promise<void> {
    try {
      const state = await api.state(withReport);
      if (!state.pet) {
        await this.route();
        return;
      }
      this.pet = state.pet;
      this.coins = state.coins;
      this.inventory = state.inventory;
      if (state.chat) this.chatHistory = state.chat;
      this.stage?.setPet(state.pet);
      this.hud?.renderStatus(state.pet, state.coins);
      this.hud?.renderItems(state.inventory);

      const room = await api.room();
      // 部屋は Stage が持つのでここでは保持しない。
      this.stage?.setLayout(room.layout);

      if (withReport && state.report) {
        this.showAwayReport(state.report);
      }
      if (withReport && state.encounterError) {
        console.warn('[ai-pet] encounter:', state.encounterError);
      }
    } catch (error) {
      toast(error instanceof ApiError ? error.message : '読み込みに失敗しました', 'error');
    }
  }

  /** 世話。押した瞬間にローカル反応 → 裏で LLM の一言を取りに行く。 */
  private async care(payload: { itemId?: string; kind?: 'pet' }): Promise<void> {
    if (!this.pet) return;
    const item = payload.itemId ? findItem(payload.itemId) : null;
    const kind: CareKind = item
      ? item.kind === 'food'
        ? 'feed'
        : item.kind === 'toy'
          ? 'play'
          : 'clean'
      : 'pet';

    // 即時フィードバック。
    const local = localReaction(
      this.pet.species,
      kind,
      this.pet.needs.mood,
      undefined,
      this.pet.stage,
    );
    this.stage?.playAction(local.action);
    this.stage?.say(local.say, 4500);

    try {
      const result = await api.care(payload);
      this.pet = result.pet;
      this.inventory = result.inventory;
      this.hud?.renderStatus(result.pet, this.coins);
      this.hud?.renderItems(result.inventory);
      this.stage?.setPet(result.pet);
      if (result.reply.say && result.reply.say !== local.say) {
        this.stage?.say(result.reply.say);
        this.stage?.playAction(result.reply.action);
      }
      if (result.llmError && this.llmAvailable) {
        this.llmAvailable = false;
        toast(`AIに繋がりません（定型のはんのうで つづけます）`, 'error');
      }
    } catch (error) {
      toast(error instanceof ApiError ? error.message : '通信に失敗しました', 'error');
    }
  }

  private async think(): Promise<void> {
    if (!this.pet || document.hidden) return;
    // モーダルを開いている間は割り込まない。
    if (document.querySelector('.modal-backdrop')) return;
    try {
      const result = await api.think();
      this.pet = result.pet;
      this.hud?.renderStatus(result.pet, this.coins);
      this.stage?.setPet(result.pet);
      if (result.reply?.say) {
        this.stage?.say(result.reply.say);
        this.stage?.playAction(result.reply.action);
      }
    } catch {
      // 思いつきは失敗しても静かに諦める（見た目は FSM が動かし続ける）。
    }
  }

  private openPanel(panel: 'chat' | 'memory' | 'social' | 'room' | 'shop'): void {
    if (!this.pet) return;
    switch (panel) {
      case 'chat':
        openChatPanel({
          petName: this.pet.name,
          history: this.chatHistory,
          onReply: (reply) => {
            this.stage?.say(reply.say);
            this.stage?.playAction(reply.action as never);
          },
          onStateChanged: () => void this.refresh(),
        });
        break;
      case 'memory':
        openMemoryBook(this.pet.name);
        break;
      case 'social':
        openSocialPanel({
          petName: this.pet.name,
          inventory: this.inventory,
          onChanged: () => void this.refresh(),
        });
        break;
      case 'room':
        openRoomEditor(this.inventory, (layout) => this.stage?.setLayout(layout));
        break;
      case 'shop':
        openShop(this.coins, () => void this.refresh());
        break;
    }
  }

  /** ねこあつめ流の「開いたら必ず何か起きている」画面。 */
  private showAwayReport(report: AwayReport): void {
    const hasNews =
      report.encounters.length > 0 || report.gifts.length > 0 || report.hoursAway >= 0.5;
    if (!hasNews) return;

    const handle = modal('おかえりなさい');
    const list = el('div', { class: 'report-list' });
    for (const line of report.lines) {
      list.append(el('p', { class: 'report-line' }, line));
    }
    for (const encounter of report.encounters) {
      list.append(
        el(
          'div',
          { class: 'report-souvenir' },
          el('strong', {}, `${encounter.otherPetName} と会った話`),
          el('p', {}, `「${encounter.souvenir}」`),
        ),
      );
    }
    handle.body.append(
      list,
      button('ただいま', () => handle.close(), 'btn btn-primary btn-wide'),
    );
    if (report.encounters.length) void api.markEncountersSeen();
  }
}
