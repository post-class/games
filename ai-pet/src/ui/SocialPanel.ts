import { findItem } from '../../shared/items.js';
import { STAGE_LABELS, type EncounterView } from '../../shared/types.js';
import { api, ApiError } from '../net/api.js';
import type { InventoryEntry } from '../net/api.js';
import { button, clear, el, modal, toast } from './dom.js';

/** ともだち・訪問・おくりもの・ペット同士の交流・今日のやくそく。 */

export interface SocialPanelOptions {
  petName: string;
  inventory: InventoryEntry[];
  onChanged(): void;
}

export function openSocialPanel(options: SocialPanelOptions): void {
  const handle = modal('ともだちと ペットのせかい');
  const tabHost = el('div', { class: 'tab-row' });
  const paneHost = el('div', { class: 'tab-pane' });
  handle.body.append(tabHost, paneHost);

  const tabs: Array<{ label: string; render: () => void }> = [
    { label: '🐾 でかけた話', render: renderEncounters },
    { label: '👥 ともだち', render: renderFriends },
    { label: '🔍 さがす', render: renderSearch },
    { label: '🎁 とどいた', render: renderGifts },
    { label: '✅ やくそく', render: renderPromises },
  ];

  const tabButtons = tabs.map((tab) =>
    button(tab.label, () => {
      for (const [index, node] of tabButtons.entries()) {
        node.classList.toggle('active', tabs[index] === tab);
      }
      tab.render();
    }, 'btn btn-tab-small'),
  );
  tabHost.append(...tabButtons);
  tabButtons[0].classList.add('active');
  renderEncounters();

  // --- ペット同士の交流ログ ---------------------------------------------

  function encounterCard(encounter: EncounterView): HTMLElement {
    const lines = encounter.lines.map((line) =>
      el(
        'div',
        { class: `enc-line enc-${line.speaker}` },
        el('span', { class: 'enc-who' }, line.speaker === 'self' ? options.petName : encounter.otherPetName),
        el('span', { class: 'enc-text' }, line.text),
      ),
    );
    const mood =
      encounter.affinityDelta > 2
        ? el('span', { class: 'chip chip-good' }, `なかよくなった +${encounter.affinityDelta}`)
        : encounter.affinityDelta < -2
          ? el('span', { class: 'chip chip-bad' }, `気まずくなった ${encounter.affinityDelta}`)
          : el('span', { class: 'chip chip-quiet' }, 'とくに変化なし');

    return el(
      'div',
      { class: 'enc-card' },
      el(
        'div',
        { class: 'enc-head' },
        el('strong', {}, `${encounter.otherPetName}`),
        el('span', { class: 'enc-owner' }, `（${encounter.otherOwnerName}さんの子）`),
        mood,
      ),
      el('div', { class: 'enc-souvenir' }, `「${encounter.souvenir}」`),
      el('details', { class: 'enc-details' }, el('summary', {}, 'そのときの ようす'), ...lines),
    );
  }

  function renderEncounters(): void {
    clear(paneHost);
    paneHost.append(
      el(
        'p',
        { class: 'hint' },
        'あなたが いないあいだに、この子は 他のひとの ペットと 出会って 話しています。もどってきたら 土産話を してくれます。',
      ),
    );
    const goOut = button('いま でかけさせる', async () => {
      goOut.disabled = true;
      goOut.textContent = 'でかけ中…';
      try {
        const result = await api.runEncounter(true);
        if (result.error) toast(`交流に失敗: ${result.error}`, 'error');
        else if (!result.encounter) toast('出かける相手が いませんでした');
        else toast('でかけて きました！');
        options.onChanged();
        renderEncounters();
      } catch (error) {
        toast(error instanceof ApiError ? error.message : '通信に失敗しました', 'error');
      } finally {
        goOut.disabled = false;
        goOut.textContent = 'いま でかけさせる';
      }
    }, 'btn btn-primary');
    paneHost.append(goOut);

    const list = el('div', { class: 'enc-list' }, el('p', { class: 'hint' }, '読み込み中…'));
    paneHost.append(list);
    void (async () => {
      try {
        const result = await api.encounters();
        clear(list);
        if (!result.encounters.length) {
          list.append(el('p', { class: 'hint' }, 'まだ 出会いが ありません。'));
          return;
        }
        for (const encounter of result.encounters) list.append(encounterCard(encounter));
        await api.markEncountersSeen();
      } catch (error) {
        clear(list);
        list.append(el('p', { class: 'hint' }, error instanceof ApiError ? error.message : '読み込みに失敗'));
      }
    })();
  }

  // --- ともだち ---------------------------------------------------------

  function renderFriends(): void {
    clear(paneHost);
    const list = el('div', { class: 'friend-list' }, el('p', { class: 'hint' }, '読み込み中…'));
    paneHost.append(list);
    void (async () => {
      try {
        const result = await api.friends();
        clear(list);
        if (!result.friends.length) {
          list.append(el('p', { class: 'hint' }, 'まだ ともだちが いません。「さがす」から ふやせます。'));
          return;
        }
        for (const friend of result.friends) {
          const giftSelect = el('select', { class: 'field field-inline' });
          for (const entry of options.inventory) {
            const item = findItem(entry.itemId);
            if (!item) continue;
            giftSelect.append(el('option', { value: item.id }, `${item.name} ×${entry.count}`));
          }
          const giftMessage = el('input', {
            class: 'field field-inline',
            type: 'text',
            placeholder: 'ひとこと',
            maxlength: 60,
          });

          list.append(
            el(
              'div',
              { class: 'friend-row' },
              el(
                'div',
                { class: 'friend-info' },
                el('strong', {}, friend.userName),
                el('span', { class: 'chip chip-quiet' }, `${friend.petName}（${STAGE_LABELS[friend.petStage]}）`),
                el(
                  'span',
                  { class: `chip ${friend.affinity >= 0 ? 'chip-good' : 'chip-bad'}` },
                  `ペットの仲: ${friend.affinity}`,
                ),
              ),
              el(
                'div',
                { class: 'friend-actions' },
                button('おへやを見る', () => visitRoom(friend.userId, friend.userName), 'btn btn-small'),
                giftSelect,
                giftMessage,
                button('おくる', async () => {
                  if (!giftSelect.value) {
                    toast('おくるものが ありません', 'error');
                    return;
                  }
                  try {
                    await api.sendGift(friend.userId, giftSelect.value, giftMessage.value);
                    toast('おくりました');
                    options.onChanged();
                  } catch (error) {
                    toast(error instanceof ApiError ? error.message : '送れませんでした', 'error');
                  }
                }, 'btn btn-small btn-primary'),
                button('やめる', async () => {
                  await api.removeFriend(friend.userId);
                  renderFriends();
                }, 'btn btn-small btn-danger'),
              ),
            ),
          );
        }
      } catch (error) {
        clear(list);
        list.append(el('p', { class: 'hint' }, error instanceof ApiError ? error.message : '読み込みに失敗'));
      }
    })();
  }

  function visitRoom(userId: number, userName: string): void {
    const visitHandle = modal(`${userName}さんの おへや`);
    void (async () => {
      try {
        const result = await api.visitRoom(userId);
        const furniture = result.layout.furniture
          .map((entry) => findItem(entry.itemId)?.name ?? entry.itemId)
          .join('、');
        visitHandle.body.append(
          el(
            'div',
            { class: 'visit-card' },
            el('p', {}, `かべ: ${result.layout.wall} / ゆか: ${result.layout.floor}`),
            el('p', {}, furniture ? `かぐ: ${furniture}` : 'かぐは まだ ありません'),
            result.pet
              ? el(
                  'p',
                  {},
                  `${result.pet.name}（${STAGE_LABELS[result.pet.stage as keyof typeof STAGE_LABELS] ?? result.pet.stage}）が います。`,
                )
              : el('p', {}, 'ペットは まだ いません。'),
            el('p', { class: 'hint' }, 'あなたが 来たことは 相手に つたわります。'),
          ),
        );
      } catch (error) {
        visitHandle.body.append(
          el('p', { class: 'hint' }, error instanceof ApiError ? error.message : '読み込みに失敗'),
        );
      }
    })();
  }

  // --- さがす -----------------------------------------------------------

  function renderSearch(): void {
    clear(paneHost);
    const list = el('div', { class: 'friend-list' }, el('p', { class: 'hint' }, '読み込み中…'));
    paneHost.append(el('p', { class: 'hint' }, 'ほかの ひとを さがして ともだちに なれます。'), list);
    void (async () => {
      try {
        const result = await api.users();
        clear(list);
        if (!result.users.length) {
          list.append(el('p', { class: 'hint' }, 'まだ ほかの ひとが いません。'));
          return;
        }
        for (const user of result.users) {
          list.append(
            el(
              'div',
              { class: 'friend-row' },
              el(
                'div',
                { class: 'friend-info' },
                el('strong', {}, user.userName),
                el('span', { class: 'chip chip-quiet' }, user.petName ?? 'ペットなし'),
              ),
              el(
                'div',
                { class: 'friend-actions' },
                user.isFriend
                  ? el('span', { class: 'chip chip-good' }, 'ともだち')
                  : button('ともだちに なる', async () => {
                      try {
                        await api.addFriend(user.userId);
                        toast('ともだちに なりました');
                        renderSearch();
                      } catch (error) {
                        toast(error instanceof ApiError ? error.message : '失敗しました', 'error');
                      }
                    }, 'btn btn-small btn-primary'),
              ),
            ),
          );
        }
      } catch (error) {
        clear(list);
        list.append(el('p', { class: 'hint' }, error instanceof ApiError ? error.message : '読み込みに失敗'));
      }
    })();
  }

  // --- とどいたもの -----------------------------------------------------

  function renderGifts(): void {
    clear(paneHost);
    const list = el('div', { class: 'gift-list' }, el('p', { class: 'hint' }, '読み込み中…'));
    paneHost.append(list);
    void (async () => {
      try {
        const state = await api.state(false);
        const visits = await api.visits();
        clear(list);
        const gifts = state.report?.gifts ?? [];
        if (!gifts.length) {
          list.append(el('p', { class: 'hint' }, 'とどいた おくりものは ありません。'));
        }
        for (const gift of gifts) {
          const item = findItem(gift.itemId);
          list.append(
            el(
              'div',
              { class: 'gift-row' },
              el('span', {}, `${gift.fromUserName}さんから ${item?.name ?? gift.itemId}`),
              gift.message ? el('span', { class: 'gift-msg' }, `「${gift.message}」`) : null,
              button('うけとる', async () => {
                try {
                  await api.claimGift(gift.id);
                  toast('うけとりました');
                  options.onChanged();
                  renderGifts();
                } catch (error) {
                  toast(error instanceof ApiError ? error.message : '失敗しました', 'error');
                }
              }, 'btn btn-small btn-primary'),
            ),
          );
        }

        list.append(el('h3', { class: 'section-title' }, 'きてくれた ひと'));
        if (!visits.visits.length) {
          list.append(el('p', { class: 'hint' }, 'まだ だれも きていません。'));
        }
        for (const visit of visits.visits) {
          list.append(
            el(
              'div',
              { class: 'visit-row' },
              el('span', {}, `${visit.visitorName}さん（${visit.visitorPetName}）が きました`),
              el('span', { class: 'gift-msg' }, new Date(visit.createdAt).toLocaleString('ja-JP')),
            ),
          );
        }
      } catch (error) {
        clear(list);
        list.append(el('p', { class: 'hint' }, error instanceof ApiError ? error.message : '読み込みに失敗'));
      }
    })();
  }

  // --- やくそく ---------------------------------------------------------

  function renderPromises(): void {
    clear(paneHost);
    paneHost.append(
      el(
        'p',
        { class: 'hint' },
        'きょう 自分と する やくそくを 1つ 書いてみましょう。まもれたら この子が おぼえてくれます。',
      ),
    );
    const input = el('input', {
      class: 'field',
      type: 'text',
      placeholder: 'れい: 30分 さんぽする',
      maxlength: 60,
    });
    const add = button('やくそくする', async () => {
      if (!input.value.trim()) return;
      try {
        await api.addPromise(input.value.trim());
        input.value = '';
        renderPromises();
      } catch (error) {
        toast(error instanceof ApiError ? error.message : '失敗しました', 'error');
      }
    }, 'btn btn-primary');
    const list = el('div', { class: 'promise-list' });
    paneHost.append(el('div', { class: 'chat-input-row' }, input, add), list);

    void (async () => {
      try {
        const result = await api.promises();
        clear(list);
        if (!result.promises.length) {
          list.append(el('p', { class: 'hint' }, 'きょうの やくそくは まだ ありません。'));
          return;
        }
        for (const promise of result.promises) {
          list.append(
            el(
              'div',
              { class: `promise-row ${promise.done ? 'promise-done' : ''}` },
              el('span', {}, promise.text),
              promise.done
                ? el('span', { class: 'chip chip-good' }, 'まもれた')
                : button('まもれた！', async () => {
                    try {
                      await api.completePromise(promise.id);
                      toast('えらい！ この子も おぼえました（🪙+15）');
                      options.onChanged();
                      renderPromises();
                    } catch (error) {
                      toast(error instanceof ApiError ? error.message : '失敗しました', 'error');
                    }
                  }, 'btn btn-small btn-primary'),
            ),
          );
        }
      } catch (error) {
        clear(list);
        list.append(el('p', { class: 'hint' }, error instanceof ApiError ? error.message : '読み込みに失敗'));
      }
    })();
  }
}
