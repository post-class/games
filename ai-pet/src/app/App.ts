import { ACTION_LABELS, type PetAction } from '../../shared/actions.js';
import { localReaction, type CareKind } from '../../shared/reactions.js';
import { findItem, type ItemDef } from '../../shared/items.js';
import type { AwayReport, ChatTurn, NeedKey, PetView } from '../../shared/types.js';
import { findSpot, placeLabel, type ZoneId } from '../../shared/world.js';
import type { AgendaEvent } from '../sim/agenda.js';
import { dominantTraits, TRAIT_LABELS } from '../../shared/personality.js';
import { api, ApiError, type GrowthEvent, type InventoryEntry } from '../net/api.js';
import { Stage } from '../render/Stage.js';
import { renderAuth, renderCreatePet } from '../ui/Auth.js';
import { openChatPanel } from '../ui/ChatPanel.js';
import { button, clear, el, modal, toast } from '../ui/dom.js';
import { Hud } from '../ui/Hud.js';
import { openMemoryBook } from '../ui/MemoryBook.js';
import { openMiniGame } from '../ui/MiniGame.js';
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

/** できごとログの行頭につける印。文字だけだと流し読みできないため。 */
const ACTION_ICON: Partial<Record<PetAction, string>> = {
  nap: '💤',
  eat: '🍚',
  play: '🎾',
  wash: '🫧',
  dig: '⛏️',
  bury_treasure: '💎',
  sniff_flower: '🌷',
  splash_puddle: '💧',
  chase_butterfly: '🦋',
  climb_tree: '🌳',
  stargaze: '⭐',
  sunbathe: '☀️',
  chat_bird: '🐦',
  check_mail: '📮',
  dance: '🎵',
  sing: '🎶',
  peek_window: '🪟',
  hide_item: '🙈',
  stare_owner: '👀',
  daydream: '💭',
  jump_joy: '✨',
  roll_around: '🌀',
  stretch: '🐈',
  tidy_room: '🧹',
  nuzzle: '💛',
  sulk_corner: '💧',
  walk: '🐾',
  idle: '·',
};

export class App {
  private host: HTMLElement;
  private stage: Stage | null = null;
  private hud: Hud | null = null;
  private pet: PetView | null = null;
  private coins = 0;
  private inventory: InventoryEntry[] = [];
  private chatHistory: ChatTurn[] = [];
  private thinkTimer = 0;
  private encounterWatch = 0;
  private llmAvailable = true;
  /** 直前にログへ書いたゾーン。部屋を移ったときだけ書くための記録。 */
  private lastZoneId: ZoneId | null = null;

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
        /* 見た目の行動変化はサーバに送らない（毎数秒なので通信しない） */
      },
      onAgendaEvent: (event) => this.onAgendaEvent(event),
    });
    this.hud = new Hud(hudHost, {
      onUseItem: (itemId) => void this.care({ itemId }),
      onStroke: () => void this.care({ kind: 'pet' }),
      onOpen: (panel) => this.openPanel(panel),
    });

    // HUD は「できごとログ」が増えると背が伸びる。伸びた分ステージを詰めないと
    // ページが縦スクロールしてしまう（E2E D10）。HUD の高さを見張って詰め直す。
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(() => this.stage?.refit()).observe(hudHost);
    }

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
      // HUD の高さが決まってからステージを詰め直す（画面がスクロールしないように）。
      this.stage?.refit();

      const room = await api.room();
      // 部屋は Stage が持つのでここでは保持しない。
      this.stage?.setLayout(room.layout);

      if (state.growth) {
        this.celebrateGrowth(state.growth, state.pet);
      } else if (withReport && state.report) {
        // 成長のお祝いと留守レポートが重なると読み飛ばされるので、お祝いを優先する。
        this.showAwayReport(state.report);
      }

      // 交流はサーバ側で裏で走っているので、少し待ってから土産話を取りに行く。
      if (state.encounterPending && !this.encounterWatch) {
        this.watchForEncounter();
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

    // 即時フィードバック（ステージ側）。
    const local = localReaction(
      this.pet.species,
      kind,
      this.pet.needs.mood,
      undefined,
      this.pet.stage,
    );
    this.stage?.playAction(local.action);
    this.stage?.say(local.say, 4500);

    // 即時フィードバック（HUD 側）。
    // 以前はステージの吹き出しだけ先に出し、アイテムの数とニーズのバーは
    // サーバの返事（LLM を含むので 2〜4 秒かかる）を待っていた。
    // 押したのに数字が動かないのは「効いていない」と読めてしまうので、
    // 効果が確定しているぶん（アイテム定義の効果と消費）は先に画面へ出す。
    // サーバの返事が来たら、そちらの値で必ず上書きする（正はサーバ）。
    this.applyOptimisticCare(item ?? null);

    try {
      const result = await api.care(payload);
      this.pet = result.pet;
      this.inventory = result.inventory;
      this.coins = result.coins;
      this.hud?.renderStatus(result.pet, this.coins);
      this.hud?.renderItems(result.inventory);
      this.stage?.setPet(result.pet);
      if (result.growth) this.celebrateGrowth(result.growth, result.pet);
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

  /**
   * ペットが新しい場所で何かを始めた。
   *
   * 見ていなくても世界が動いていると感じられるように、
   * ここでログを1行流し、発見があればサーバに知らせる（記憶とコインになる）。
   */
  private onAgendaEvent(event: AgendaEvent): void {
    const spot = event.spotId ? findSpot(event.spotId) : null;
    const zoneId = spot?.zone ?? null;

    if (event.find && spot) {
      this.hud?.pushJournal(`${ACTION_ICON[event.action] ?? '✨'} ${event.find}`);
      const index = spot.finds?.indexOf(event.find) ?? -1;
      if (index >= 0) void this.reportDiscovery(spot.id, index);
    } else if (zoneId && zoneId !== this.lastZoneId) {
      // 部屋を移ったときだけ書く。行動ごとに書くと数秒でログが流れてしまう。
      this.hud?.pushJournal(
        `${ACTION_ICON[event.action] ?? '·'} ${placeLabel(spot!.id)}で ${ACTION_LABELS[event.action]}`,
      );
    }
    if (zoneId) this.lastZoneId = zoneId;
  }

  private async reportDiscovery(spotId: string, findIndex: number): Promise<void> {
    try {
      const result = await api.discover(spotId, findIndex);
      if (result.coins > 0) {
        this.coins += result.coins;
        if (this.pet) this.hud?.renderStatus(this.pet, this.coins);
        toast(`ひろってきた 🪙 ${result.coins}`);
      }
    } catch {
      // 発見はおまけなので、失敗しても黙って流す。
    }
  }

  /**
   * 世話の効果を先に画面へ反映する（楽観的更新）。
   * アイテムの効果は `shared/items.ts` が正なのでクライアントでも同じ値を出せる。
   * サーバの返事が来た時点で上書きされるので、ここでずれても残らない。
   */
  private applyOptimisticCare(item: ItemDef | null): void {
    if (!this.pet) return;
    if (item) {
      this.inventory = this.inventory
        .map((entry) =>
          entry.itemId === item.id ? { ...entry, count: entry.count - 1 } : entry,
        )
        .filter((entry) => entry.count > 0);
      const needs = { ...this.pet.needs };
      for (const [key, delta] of Object.entries(item.effect)) {
        const need = key as NeedKey;
        needs[need] = Math.max(0, Math.min(100, needs[need] + (delta ?? 0)));
      }
      this.pet = { ...this.pet, needs };
    } else {
      // なでるは「なかよし」が少し上がる（サーバ側の値もおおよそこの範囲）。
      const needs = { ...this.pet.needs, mood: Math.min(100, this.pet.needs.mood + 3) };
      this.pet = { ...this.pet, needs };
    }
    this.hud?.renderStatus(this.pet, this.coins);
    this.hud?.renderItems(this.inventory);
  }

  private async think(): Promise<void> {
    if (!this.pet || document.hidden) return;
    // モーダルを開いている間は割り込まない。
    if (document.querySelector('.modal-backdrop')) return;
    try {
      // いまどこにいるかを渡すと、独り言がその場所の話になる。
      const result = await api.think(this.stage?.currentSpotId() ?? null);
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

  private openPanel(panel: 'chat' | 'memory' | 'social' | 'room' | 'shop' | 'game'): void {
    if (!this.pet) return;
    switch (panel) {
      case 'game':
        // 自分のゲーム中に寝ていると気が抜けるので、遊ぶ姿にしておく。
        this.stage?.playAction('play');
        openMiniGame({
          pet: this.pet,
          onFinished: (pet) => {
            this.pet = pet;
            this.stage?.setPet(pet);
            this.stage?.playAction('jump_joy');
            void this.refresh();
          },
        });
        break;
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

  /**
   * 裏で走っているペット同士の交流が終わるのを待つ。
   * 起動を止めないために交流を非同期にしたので、終わったらここで拾って知らせる。
   */
  private watchForEncounter(): void {
    let tries = 0;
    this.encounterWatch = window.setInterval(() => {
      tries += 1;
      if (tries > 12) {
        this.clearEncounterWatch();
        return;
      }
      void (async () => {
        try {
          const result = await api.encounters();
          const fresh = result.encounters.find((encounter) => !encounter.seen);
          if (!fresh) return;
          this.clearEncounterWatch();
          this.stage?.say(fresh.souvenir, 8000);
          toast(`${fresh.otherPetName} と会った話をしてくれた`);
          await api.markEncountersSeen();
        } catch {
          this.clearEncounterWatch();
        }
      })();
    }, 5000);
  }

  private clearEncounterWatch(): void {
    if (this.encounterWatch) window.clearInterval(this.encounterWatch);
    this.encounterWatch = 0;
  }

  /**
   * 成長のお祝い。
   * プレイテストで、孵化がチップの文字が変わるだけで通り過ぎてしまっていた。
   * ここは育成ゲームでいちばん嬉しい瞬間なので、必ず足を止めて見せる。
   */
  private celebrateGrowth(growth: GrowthEvent, pet: PetView): void {
    const isHatch = growth.to === 'child';
    const handle = modal(isHatch ? 'たまごが うまれた！' : 'おとなに なった！');
    const traits = dominantTraits(pet.personality)
      .map((key) => TRAIT_LABELS[key])
      .join('と');

    handle.body.append(
      el('div', { class: 'celebrate-mark' }, isHatch ? '🎉' : '🌟'),
      el(
        'p',
        { class: 'celebrate-line' },
        isHatch
          ? `${pet.name} が たまごから 出てきた！`
          : `${pet.name} が りっぱな おとなに なった！`,
      ),
      el(
        'p',
        { class: 'hint' },
        isHatch
          ? `${traits}が つよい 子のようです。はなしかけると、あなたのことを おぼえていきます。`
          : `${traits}な 子に 育ちました。ここまで そだてた 思い出は「おもいで」で 読めます。`,
      ),
    );
    if (growth.coins > 0) {
      handle.body.append(
        el('p', { class: 'celebrate-reward' }, `おいわいに 🪙 ${growth.coins} もらった`),
      );
    }
    handle.body.append(
      button(
        'やったー',
        () => {
          handle.close();
          // 見せ終わったことをサーバに伝える（通信が切れてお祝いが消えないように）。
          void api.growthSeen();
        },
        'btn btn-primary btn-wide',
      ),
    );

    this.stage?.celebrate();
  }

  /** ねこあつめ流の「開いたら必ず何か起きている」画面。 */
  private showAwayReport(report: AwayReport): void {
    const hasNews =
      report.encounters.length > 0 || report.gifts.length > 0 || report.hoursAway >= 0.5;
    if (!hasNews) return;

    const handle = modal('おかえりなさい');

    // この子自身の第一声。LLM を待つので、先に枠だけ出しておいて後から埋める。
    const greeting = el('div', { class: 'report-greeting report-greeting-waiting' }, '…');
    if (report.hoursAway >= 0.5) {
      handle.body.append(greeting);
      void (async () => {
        try {
          const result = await api.greet(report.hoursAway);
          if (!result.reply?.say) {
            greeting.remove();
            return;
          }
          greeting.classList.remove('report-greeting-waiting');
          greeting.textContent = `「${result.reply.say}」`;
          this.stage?.say(result.reply.say, 8000);
          this.stage?.playAction(result.reply.action);
        } catch {
          greeting.remove();
        }
      })();
    }

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
