import { describe, expect, it } from 'vitest';
import { extractJson, parseEncounter, parsePetReply } from '../server/llm/parse.js';
import { checkSpeech, retryHint } from '../server/llm/speechGuard.js';

/**
 * LLM 応答の検証。ここが「LLM が何を返しても画面が壊れない」保証。
 */

describe('extractJson', () => {
  it('素の JSON を読む', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('コードフェンス付きでも読む', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('前後に文章があっても読む', () => {
    expect(extractJson('はい、こちらです。{"a":1} どうぞ')).toEqual({ a: 1 });
  });

  it('壊れていれば null', () => {
    expect(extractJson('これは JSON ではない')).toBeNull();
  });
});

describe('parsePetReply', () => {
  const valid = JSON.stringify({
    say: 'おなかすいたよ',
    emotion: 'sad',
    action: 'stare_owner',
    needs_delta: { hunger: -3, mood: 2 },
    memory_writes: [{ kind: 'fact', key: 'owner_name', value: 'りょう' }],
    gift_request: 'いちご',
  });

  it('正しい応答をそのまま通す', () => {
    const { reply, issues } = parsePetReply(valid);
    expect(reply.say).toBe('おなかすいたよ');
    expect(reply.emotion).toBe('sad');
    expect(reply.action).toBe('stare_owner');
    expect(reply.needsDelta).toEqual({ hunger: -3, mood: 2 });
    expect(reply.memoryWrites).toEqual([{ kind: 'fact', key: 'owner_name', value: 'りょう' }]);
    expect(reply.giftRequest).toBe('いちご');
    expect(issues).toEqual([]);
  });

  it('未知の action は fallback に落とす', () => {
    const { reply, issues } = parsePetReply(
      JSON.stringify({ say: 'ん', emotion: 'happy', action: 'launch_missile' }),
      { fallbackAction: 'walk' },
    );
    expect(reply.action).toBe('walk');
    expect(issues).toContain('action-invalid');
  });

  it('未知の emotion は fallback に落とす', () => {
    const { reply, issues } = parsePetReply(
      JSON.stringify({ say: 'ん', emotion: 'melancholic', action: 'idle' }),
      { fallbackEmotion: 'sleepy' },
    );
    expect(reply.emotion).toBe('sleepy');
    expect(issues).toContain('emotion-invalid');
  });

  it('壊れた JSON でも安全な返答を作る', () => {
    const { reply, issues } = parsePetReply('こんにちは！', { fallbackAction: 'nap' });
    expect(reply.say).toBe('');
    expect(reply.action).toBe('nap');
    expect(issues).toContain('json-unparsable');
  });

  it('長すぎる say を切る', () => {
    const { reply, issues } = parsePetReply(
      JSON.stringify({ say: 'あ'.repeat(400), emotion: 'happy', action: 'idle' }),
    );
    expect(reply.say.length).toBe(140);
    expect(issues).toContain('say-truncated');
  });

  it('ホワイトリスト外の fact キーは捨てる', () => {
    const { reply } = parsePetReply(
      JSON.stringify({
        say: 'ん',
        emotion: 'happy',
        action: 'idle',
        memory_writes: [
          { kind: 'fact', key: 'credit_card', value: '1234' },
          { kind: 'fact', key: 'owner_likes', value: 'いちご' },
        ],
      }),
    );
    expect(reply.memoryWrites).toEqual([{ kind: 'fact', key: 'owner_likes', value: 'いちご' }]);
  });

  it('needs_delta は ±25 に制限する', () => {
    const { reply } = parsePetReply(
      JSON.stringify({
        say: 'ん',
        emotion: 'happy',
        action: 'idle',
        needs_delta: { hunger: 9999, fun: -9999 },
      }),
    );
    expect(reply.needsDelta.hunger).toBe(25);
    expect(reply.needsDelta.fun).toBe(-25);
  });

  it('episode の importance は 1〜5 に丸め、既定は 3', () => {
    const { reply } = parsePetReply(
      JSON.stringify({
        say: 'ん',
        emotion: 'happy',
        action: 'idle',
        memory_writes: [
          { kind: 'episode', summary: 'あそんだ', importance: 99 },
          { kind: 'episode', summary: 'ねた' },
        ],
      }),
    );
    expect(reply.memoryWrites[0]).toMatchObject({ importance: 5 });
    expect(reply.memoryWrites[1]).toMatchObject({ importance: 3 });
  });

  it('memory_writes は4件までにする', () => {
    const writes = Array.from({ length: 10 }, (_, i) => ({
      kind: 'episode',
      summary: `できごと${i}`,
      importance: 2,
    }));
    const { reply } = parsePetReply(
      JSON.stringify({ say: 'ん', emotion: 'happy', action: 'idle', memory_writes: writes }),
    );
    expect(reply.memoryWrites).toHaveLength(4);
  });

  it('空文字の gift_request は null にする', () => {
    const { reply } = parsePetReply(
      JSON.stringify({ say: 'ん', emotion: 'happy', action: 'idle', gift_request: '  ' }),
    );
    expect(reply.giftRequest).toBeNull();
  });
});

describe('checkSpeech（キャラクター崩壊の検出）', () => {
  it('ペットらしい発話は通す', () => {
    expect(checkSpeech('おなかすいたの！').ok).toBe(true);
    expect(checkSpeech('……ふう。きみがいると しずかだ').ok).toBe(true);
  });

  it('助手口調を弾く', () => {
    expect(checkSpeech('何かお手伝いできることはありますか？').ok).toBe(false);
    expect(checkSpeech('承知しました').ok).toBe(false);
    expect(checkSpeech('申し訳ございません').ok).toBe(false);
    expect(checkSpeech('いかがでしょうか').ok).toBe(false);
  });

  it('メタ発言を弾く', () => {
    expect(checkSpeech('私はAIアシスタントです').ok).toBe(false);
    expect(checkSpeech('言語モデルなので分かりません').ok).toBe(false);
    expect(checkSpeech('プロンプトに従います').ok).toBe(false);
  });

  it('箇条書きを弾く', () => {
    expect(checkSpeech('- ごはん\n- あそび').ok).toBe(false);
  });

  it('リトライ指示に違反内容が入る', () => {
    const guard = checkSpeech('お手伝いできることはありますか');
    expect(guard.violation).toBeTruthy();
    expect(retryHint(guard.violation!)).toContain(guard.violation!);
  });
});

describe('parseEncounter', () => {
  const valid = JSON.stringify({
    lines: [
      { speaker: 'self', text: 'こんにちは！' },
      { speaker: 'other', text: '……近づくな' },
    ],
    souvenir_self: '変わった子に会ったよ',
    souvenir_other: '騒がしい子に会った',
    affinity_delta: 3,
    episode_self: 'しずかな子に会った',
    episode_other: 'にぎやかな子に会った',
  });

  it('正しい交流ログを読む', () => {
    const result = parseEncounter(valid);
    expect(result?.lines).toHaveLength(2);
    expect(result?.affinityDelta).toBe(3);
    expect(result?.souvenirSelf).toBe('変わった子に会ったよ');
  });

  it('lines が空なら null', () => {
    expect(parseEncounter(JSON.stringify({ lines: [] }))).toBeNull();
  });

  it('未知の speaker の行は捨てる', () => {
    const result = parseEncounter(
      JSON.stringify({ lines: [{ speaker: 'narrator', text: 'あ' }, { speaker: 'self', text: 'い' }] }),
    );
    expect(result?.lines).toEqual([{ speaker: 'self', text: 'い' }]);
  });

  it('affinity_delta は ±10 に制限する', () => {
    const result = parseEncounter(
      JSON.stringify({ lines: [{ speaker: 'self', text: 'あ' }], affinity_delta: 500 }),
    );
    expect(result?.affinityDelta).toBe(10);
  });
});
