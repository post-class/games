import type { MemoryEpisode, MemoryFact } from '../../shared/types.js';
import { api, ApiError } from '../net/api.js';
import { button, clear, el, modal, toast } from './dom.js';

/**
 * おもいで帳。
 *
 * 既存の AI ペットアプリは「何を覚えているか」がブラックボックスで、
 * 間違って覚えられても直せない。ここではユーザが全部見て、直して、消せる。
 * 本作の差別化のうち、ユーザが最も直接触れる部分。
 */

/** 事実キーの表示名（サーバの FACT_KEYS と対応）。 */
const FACT_LABELS: Record<string, string> = {
  owner_name: 'あなたの呼び名',
  owner_likes: 'あなたの好きなもの',
  owner_dislikes: 'あなたの苦手なもの',
  owner_job: 'あなたの仕事・学校',
  owner_routine: 'あなたの生活リズム',
  favorite_food: 'この子の好きな食べ物',
  favorite_toy: 'この子の好きな遊び',
  fear: 'この子が怖いもの',
  dream: 'この子の夢',
  nickname_for_owner: 'あなたの呼び方',
  shared_joke: 'ふたりの合言葉',
  promise: 'やくそく',
};

const ALL_FACT_KEYS = Object.keys(FACT_LABELS);

export function openMemoryBook(petName: string): void {
  const handle = modal(`${petName} の おもいで帳`);
  const factHost = el('div', { class: 'memory-facts' });
  const episodeHost = el('div', { class: 'memory-episodes' });

  handle.body.append(
    el(
      'p',
      { class: 'hint' },
      'この子が おぼえていること の ぜんぶ です。まちがって おぼえていたら 直したり 消したり できます。',
    ),
    el('h3', { class: 'section-title' }, 'おぼえていること'),
    factHost,
    el('h3', { class: 'section-title' }, 'おもいで'),
    episodeHost,
  );

  function renderFacts(facts: MemoryFact[]): void {
    clear(factHost);
    const byKey = new Map(facts.map((fact) => [fact.key, fact.value]));
    for (const key of ALL_FACT_KEYS) {
      const value = byKey.get(key) ?? '';
      const input = el('input', {
        class: 'field field-inline',
        type: 'text',
        value,
        placeholder: 'まだ おぼえていない',
        maxlength: 60,
        'data-fact': key,
      });
      const save = button('なおす', async () => {
        try {
          const result = await api.saveFact(key, input.value);
          toast('なおしました');
          renderFacts(result.facts);
        } catch (error) {
          toast(error instanceof ApiError ? error.message : '保存に失敗しました', 'error');
        }
      }, 'btn btn-small');

      factHost.append(
        el(
          'div',
          { class: `fact-row ${value ? '' : 'fact-empty'}` },
          el('span', { class: 'fact-label' }, FACT_LABELS[key]),
          input,
          save,
        ),
      );
    }
  }

  function renderEpisodes(episodes: MemoryEpisode[]): void {
    clear(episodeHost);
    if (!episodes.length) {
      episodeHost.append(el('p', { class: 'hint' }, 'まだ おもいでが ありません。'));
      return;
    }
    for (const episode of episodes) {
      const summary = el('input', {
        class: 'field field-inline',
        type: 'text',
        value: episode.summary,
        maxlength: 120,
      });
      const stars = el('span', { class: 'stars', title: `重要度 ${episode.importance}` }, '★'.repeat(episode.importance));
      const when = new Date(episode.createdAt).toLocaleString('ja-JP', {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });

      const save = button('なおす', async () => {
        try {
          const result = await api.updateEpisode(episode.id, { summary: summary.value });
          toast('なおしました');
          renderEpisodes(result.episodes);
        } catch (error) {
          toast(error instanceof ApiError ? error.message : '保存に失敗しました', 'error');
        }
      }, 'btn btn-small');

      const remove = button('わすれさせる', async () => {
        try {
          const result = await api.deleteEpisode(episode.id);
          renderEpisodes(result.episodes);
        } catch (error) {
          toast(error instanceof ApiError ? error.message : '削除に失敗しました', 'error');
        }
      }, 'btn btn-small btn-danger');

      episodeHost.append(
        el(
          'div',
          { class: `episode-row ${episode.faded ? 'episode-faded' : ''}` },
          el(
            'div',
            { class: 'episode-meta' },
            stars,
            el('span', { class: 'episode-when' }, when),
            episode.faded ? el('span', { class: 'chip chip-quiet' }, 'うすれた記憶') : null,
          ),
          summary,
          el('div', { class: 'episode-actions' }, save, remove),
        ),
      );
    }
  }

  void (async () => {
    try {
      const result = await api.memory();
      renderFacts(result.facts);
      renderEpisodes(result.episodes);
    } catch (error) {
      toast(error instanceof ApiError ? error.message : '読み込みに失敗しました', 'error');
    }
  })();
}
