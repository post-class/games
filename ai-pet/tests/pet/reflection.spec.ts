/**
 * 日記（記憶の圧縮）と留守中サマリ（docs/02_ゲーム実装プラン/07_ペットAI設計.md §3.4 / 06章 §5）
 *
 * 実APIは叩かない。`mode:'mock'` / `'fail'`、または `mode:'real'` ＋ `fetchImpl` で偽応答を返す。
 */
import { afterEach, describe, expect, test } from 'vitest';
import { LLM, Rng, TICKS_PER_ISLAND_HOUR, type IslandEvent, type PetSpecies, type Traits } from '@ai-pet/shared';
import { Repo } from '../../packages/server/src/db/repo.ts';
import { PetRepo } from '../../packages/server/src/db/petRepo.ts';
import { LlmClient } from '../../packages/server/src/llm/client.ts';
import { WorldClock } from '../../packages/server/src/sim/clock.ts';
import { buildPersona } from '../../packages/server/src/pet/persona.ts';
import { AWAY_LINE_CHARS, AWAY_MAX_LINES, AWAY_MIN_LINES, ReflectionService } from '../../packages/server/src/pet/reflection.ts';
import type { MemoryRecord } from '../../packages/server/src/pet/memory.ts';

const PLAYER = 'player-1';
const PET_ID = 4001;
const TRAITS: Traits = { energy: 0.5, sociability: 0.5, caution: 0.5, gluttony: 0.5, curiosity: 0.5 };

interface Harness {
  repo: Repo;
  petRepo: PetRepo;
  llm: LlmClient;
  clock: WorldClock;
  svc: ReflectionService;
  calls: () => number;
}

const repos: Repo[] = [];

afterEach(() => {
  for (const r of repos.splice(0)) r.close();
});

/** Azure OpenAI の応答を模した偽fetch。`body` をそのまま content にする（JSON崩れの検証にも使う） */
function fakeFetch(content: string, opts: { status?: number } = {}): { impl: typeof fetch; count: () => number } {
  let n = 0;
  const impl = (async () => {
    n++;
    return new Response(
      JSON.stringify({
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 200, completion_tokens: 60 },
      }),
      { status: opts.status ?? 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof fetch;
  return { impl, count: () => n };
}

function newHarness(
  opts: { mode?: 'mock' | 'fail' | 'real'; fetchImpl?: typeof fetch; species?: PetSpecies } = {},
): Harness {
  const repo = new Repo(':memory:');
  repos.push(repo);
  const petRepo = new PetRepo(repo.db);

  const llm = new LlmClient({
    mode: opts.mode ?? 'mock',
    endpoint: 'https://example.invalid/',
    apiKey: 'dummy-key',
    apiVersion: '2025-04-01-preview',
    model: 'gpt-5.6-luna',
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });

  // pet.player_id は player を参照するので、先にプレイヤー行を作る（本番の hello と同じ順序）
  const playerRow = repo.createPlayer({
    secret: 'secret-for-test',
    displayName: 'りょう',
    islandId: 'main',
    pos: { x: 64, y: 64 },
  });
  repo.db.prepare('UPDATE player SET id = ? WHERE id = ?').run(PLAYER, playerRow.id);

  petRepo.createPet({
    playerId: PLAYER,
    persona: buildPersona({ species: opts.species ?? 'mizune', name: 'みずね', traitTags: ['クール', '観察好き'] }),
    traits: TRAITS,
    entityId: PET_ID,
  });

  const clock = new WorldClock(new Rng('reflection'));
  const svc = new ReflectionService(llm, petRepo, repo, clock);
  return {
    repo,
    petRepo,
    llm,
    clock,
    svc,
    calls: () => Number((llm.stats() as { calls: number }).calls),
  };
}

/** その島日の記憶を仕込む */
function seedMemories(h: Harness, islandDay: number, list: { text: string; importance: number; kind?: string }[]): void {
  const rows: MemoryRecord[] = list.map((m, i) => ({
    petId: PET_ID,
    tick: islandDay * 100 + i,
    islandDay,
    kind: (m.kind ?? 'observe') as MemoryRecord['kind'],
    text: m.text,
    keywords: ['テスト'],
    importance: m.importance,
    lastAccessTick: islandDay * 100 + i,
  }));
  h.petRepo.insertMemories(rows);
}

function seedEvents(h: Harness, list: { islandDay: number; text: string; importance: number }[]): void {
  const events: IslandEvent[] = list.map((e, i) => ({
    kind: 'quarrel',
    tick: e.islandDay * 100 + i,
    islandDay: e.islandDay,
    text: e.text,
    importance: e.importance,
  }));
  h.repo.insertIslandEvents('main', events);
}

function diaryCount(h: Harness): number {
  return h.petRepo.recentMemories(PET_ID, { kinds: ['diary'], limit: 100 }).length;
}

// ---------- 日記 ----------

describe('日記', () => {
  test('記憶がある島日は diary と summary が返り、pet_memory に kind=diary が1件増える', async () => {
    const { impl } = fakeFetch(
      JSON.stringify({
        diary: 'きょうは川むこうまで行った。あんころがケンカしてた。',
        summaryUpdate: 'りょうと会った日が多い。川むこうが気になっている。',
        moodDelta: 1,
      }),
    );
    const h = newHarness({ mode: 'real', fetchImpl: impl });
    seedMemories(h, 3, [
      { text: 'あんころとくろまめがケンカした', importance: 6 },
      { text: '木の実をひとつ食べた', importance: 3 },
    ]);

    const before = diaryCount(h);
    const r = await h.svc.writeDiary({ petId: PET_ID, islandDay: 3, tick: 3 * 14400, ownerVisited: true });

    expect(r.fallback).toBe(false);
    expect(r.islandDay).toBe(3);
    expect(r.diary).toContain('川むこう');
    expect(r.summary).toContain('川むこう');
    expect(r.moodDelta).toBe(1);
    expect(diaryCount(h)).toBe(before + 1);
    // 長期記憶がDBに入っている
    expect(h.petRepo.findPetById(PET_ID)?.summary).toBe(r.summary);
  });

  test('summary は400字に切られる', async () => {
    const long = 'あ'.repeat(900);
    const { impl } = fakeFetch(JSON.stringify({ diary: 'ながい日だった。', summaryUpdate: long, moodDelta: 0 }));
    const h = newHarness({ mode: 'real', fetchImpl: impl });
    seedMemories(h, 2, [{ text: 'いろいろあった', importance: 5 }]);

    const r = await h.svc.writeDiary({ petId: PET_ID, islandDay: 2, tick: 2000, ownerVisited: false });
    expect(r.summary.length).toBe(LLM.maxSummaryChars);
    expect(h.petRepo.findPetById(PET_ID)?.summary.length).toBe(LLM.maxSummaryChars);
  });

  test('moodDelta が -3..3 にクランプされる', async () => {
    const { impl } = fakeFetch(JSON.stringify({ diary: 'さいこうの日。', summaryUpdate: 'たのしい', moodDelta: 99 }));
    const h = newHarness({ mode: 'real', fetchImpl: impl });
    seedMemories(h, 5, [{ text: 'たのしいことがあった', importance: 5 }]);

    const r = await h.svc.writeDiary({ petId: PET_ID, islandDay: 5, tick: 5000, ownerVisited: true });
    expect(r.moodDelta).toBe(3);
  });

  test('importance 上位12件だけがプロンプトに載る', async () => {
    let body = '';
    const impl = (async (_url: string, init?: RequestInit) => {
      body = String(init?.body ?? '');
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ diary: 'いろいろ。', summaryUpdate: '', moodDelta: 0 }) } }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;
    const h = newHarness({ mode: 'real', fetchImpl: impl });
    // 重要度1の記憶を20件 + 重要度9を1件
    const list: { text: string; importance: number }[] = [];
    for (let i = 0; i < 20; i++) list.push({ text: `どうでもいい出来事${i}`, importance: 1 });
    list.push({ text: 'たいせつなやくそくをした', importance: 9 });
    seedMemories(h, 4, list);

    await h.svc.writeDiary({ petId: PET_ID, islandDay: 4, tick: 4000, ownerVisited: true });
    expect(body).toContain('たいせつなやくそく');
    // 12件しか載らないので、末尾の記憶は落ちている
    expect(body).not.toContain('どうでもいい出来事19');
  });

  test('記憶が0件の島日はLLMを呼ばずに汎用の日記になる', async () => {
    const h = newHarness({ mode: 'mock' });
    const r = await h.svc.writeDiary({ petId: PET_ID, islandDay: 9, tick: 9000, ownerVisited: false });

    expect(h.calls()).toBe(0);
    expect(r.fallback).toBe(true);
    expect(r.errorKind).toBe('no_memories');
    expect(r.diary.length).toBeGreaterThan(0);
    expect(diaryCount(h)).toBe(1);
  });

  test('記憶が0件でも既存の長期記憶は書き換えない', async () => {
    const h = newHarness({ mode: 'mock' });
    h.petRepo.updatePet(PET_ID, { summary: 'りょうとよく話す。木の実がすき。' });

    const r = await h.svc.writeDiary({ petId: PET_ID, islandDay: 9, tick: 9000, ownerVisited: false });
    expect(r.summary).toBe('りょうとよく話す。木の実がすき。');
  });

  test('LLM失敗時は機械的な要約になり、既存の summary が壊れない', async () => {
    const h = newHarness({ mode: 'fail' });
    const prev = 'りょうと3回話した。ケンカを見た。畑がすきになった。';
    h.petRepo.updatePet(PET_ID, { summary: prev });
    seedMemories(h, 6, [
      { text: 'あんころとくろまめがケンカした', importance: 6 },
      { text: 'りょうに木の実をもらった', importance: 5 },
      { text: 'なにかの音がした', importance: 2 },
    ]);

    const r = await h.svc.writeDiary({ petId: PET_ID, islandDay: 6, tick: 6000, ownerVisited: true });

    expect(r.fallback).toBe(true);
    // 重要度上位3件が機械的に連結されている
    expect(r.diary).toContain('ケンカ');
    expect(r.diary).toContain('木の実');
    // 既存の長期記憶が先頭に残っている（ここが壊れると「覚えていたこと」が消える）
    expect(r.summary.startsWith(prev)).toBe(true);
    expect(r.summary).toContain('ケンカ');
    expect(h.petRepo.findPetById(PET_ID)?.summary.startsWith(prev)).toBe(true);
    // フォールバックでも日記は残る（翌日の会話とサマリの材料になる）
    expect(diaryCount(h)).toBe(1);
  });

  test('既存の summary が400字ちょうどでも消えない（足せないなら足さない）', async () => {
    const h = newHarness({ mode: 'fail' });
    const prev = 'い'.repeat(LLM.maxSummaryChars);
    h.petRepo.updatePet(PET_ID, { summary: prev });
    seedMemories(h, 7, [{ text: 'なにかあった', importance: 5 }]);

    const r = await h.svc.writeDiary({ petId: PET_ID, islandDay: 7, tick: 7000, ownerVisited: false });
    expect(r.summary).toBe(prev);
  });

  test('JSON崩れでもフォールバックする', async () => {
    const { impl } = fakeFetch('{"diary": "とちゅうで切れ');
    const h = newHarness({ mode: 'real', fetchImpl: impl });
    seedMemories(h, 8, [{ text: 'なにかあった', importance: 5 }]);

    const r = await h.svc.writeDiary({ petId: PET_ID, islandDay: 8, tick: 8000, ownerVisited: false });
    expect(r.fallback).toBe(true);
    expect(r.errorKind).toBe('parse');
    expect(r.diary.length).toBeGreaterThan(0);
  });

  test('空応答でもフォールバックする', async () => {
    const { impl } = fakeFetch('');
    const h = newHarness({ mode: 'real', fetchImpl: impl });
    seedMemories(h, 10, [{ text: 'なにかあった', importance: 5 }]);

    const r = await h.svc.writeDiary({ petId: PET_ID, islandDay: 10, tick: 10000, ownerVisited: false });
    expect(r.fallback).toBe(true);
    expect(r.diary.length).toBeGreaterThan(0);
    expect(diaryCount(h)).toBe(1);
  });

  test('ペットがいなければ例外を投げずにフォールバックを返す', async () => {
    const h = newHarness({ mode: 'mock' });
    const r = await h.svc.writeDiary({ petId: 999999, islandDay: 1, tick: 1, ownerVisited: false });
    expect(r.fallback).toBe(true);
    expect(r.errorKind).toBe('no_pet');
    expect(h.calls()).toBe(0);
  });

  test('同じペットで二重に走らない（同時呼び出し）', async () => {
    const { impl, count } = fakeFetch(
      JSON.stringify({ diary: 'きょうのこと。', summaryUpdate: 'まとめ', moodDelta: 0 }),
    );
    const h = newHarness({ mode: 'real', fetchImpl: impl });
    seedMemories(h, 11, [{ text: 'なにかあった', importance: 5 }]);

    const [a, b] = await Promise.all([
      h.svc.writeDiary({ petId: PET_ID, islandDay: 11, tick: 11000, ownerVisited: false }),
      h.svc.writeDiary({ petId: PET_ID, islandDay: 11, tick: 11000, ownerVisited: false }),
    ]);

    expect(count()).toBe(1);
    expect(a).toEqual(b);
    expect(diaryCount(h)).toBe(1);
  });

  test('同じ島日を続けて呼んでもLLMを呼び直さない（書いた日記を返す）', async () => {
    const { impl, count } = fakeFetch(
      JSON.stringify({ diary: 'いちどだけ書いた日記。', summaryUpdate: 'まとめ', moodDelta: 0 }),
    );
    const h = newHarness({ mode: 'real', fetchImpl: impl });
    seedMemories(h, 12, [{ text: 'なにかあった', importance: 5 }]);

    const first = await h.svc.writeDiary({ petId: PET_ID, islandDay: 12, tick: 12000, ownerVisited: false });
    const second = await h.svc.writeDiary({ petId: PET_ID, islandDay: 12, tick: 12100, ownerVisited: false });

    expect(count()).toBe(1);
    expect(second.diary).toContain('いちどだけ');
    expect(second.errorKind).toBe('written');
    expect(diaryCount(h)).toBe(1);
    expect(first.diary.length).toBeGreaterThan(0);
  });

  test('日記だけが材料の島日はLLMを呼ばない（自分の日記を読み返さない）', async () => {
    const h = newHarness({ mode: 'mock' });
    seedMemories(h, 13, [{ text: 'きのうの日記', importance: 7, kind: 'diary' }]);
    // 既に日記があるので「書き直さない」経路に入る
    const r = await h.svc.writeDiary({ petId: PET_ID, islandDay: 13, tick: 13000, ownerVisited: false });
    expect(h.calls()).toBe(0);
    expect(r.diary).toBe('きのうの日記');
  });

  test('stats に件数とフォールバックの内訳が出る', async () => {
    const h = newHarness({ mode: 'fail' });
    seedMemories(h, 14, [{ text: 'なにかあった', importance: 5 }]);
    await h.svc.writeDiary({ petId: PET_ID, islandDay: 14, tick: 14000, ownerVisited: false });
    const s = h.svc.stats();
    expect(s.diaries).toBe(1);
    expect(s.fallback).toBe(1);
    expect(s.fallbackRatio).toBe(1);
  });
});

// ---------- 留守中サマリ ----------

describe('留守中サマリ', () => {
  test('日記が3件あれば3行以上になり、LLMを呼ばない', () => {
    const h = newHarness({ mode: 'mock' });
    seedMemories(h, 20, [{ text: '20日目。木の実をひろった。', importance: 7, kind: 'diary' }]);
    seedMemories(h, 21, [{ text: '21日目。あんころとあそんだ。', importance: 7, kind: 'diary' }]);
    seedMemories(h, 22, [{ text: '22日目。雨がふっていた。', importance: 7, kind: 'diary' }]);

    const s = h.svc.buildAwaySummary({
      petId: PET_ID,
      islandId: 'main',
      sinceIslandDay: 20,
      currentIslandDay: 23,
      petName: 'みずね',
    });

    expect(h.calls()).toBe(0);
    expect(s.generic).toBe(false);
    expect(s.lines.length).toBeGreaterThanOrEqual(AWAY_MIN_LINES);
    expect(s.lines.length).toBeLessThanOrEqual(AWAY_MAX_LINES);
    expect(s.islandDaysPassed).toBe(3);
    // 日記が古い順に並ぶ
    const joined = s.lines.join('\n');
    expect(joined).toContain('木の実');
    expect(joined).toContain('あんころ');
    expect(joined.indexOf('木の実')).toBeLessThan(joined.indexOf('あんころ'));
  });

  test('重要な出来事が混ざる', () => {
    const h = newHarness({ mode: 'mock' });
    seedMemories(h, 30, [{ text: '30日目。しずかだった。', importance: 7, kind: 'diary' }]);
    seedEvents(h, [
      { islandDay: 30, text: 'あんころのこどもが生まれた', importance: 8 },
      { islandDay: 31, text: 'くろまめとしろみがケンカした', importance: 6 },
      { islandDay: 31, text: '木の実をすこし収穫した', importance: 3 },
    ]);

    const s = h.svc.buildAwaySummary({
      petId: PET_ID,
      islandId: 'main',
      sinceIslandDay: 30,
      currentIslandDay: 32,
      petName: 'みずね',
    });

    const joined = s.lines.join('\n');
    expect(joined).toContain('生まれた');
    expect(joined).toContain('ケンカ');
    // importance 6 未満は載せない
    expect(joined).not.toContain('収穫');
    expect(h.calls()).toBe(0);
  });

  test('材料が無ければ generic:true で3行返る', () => {
    const h = newHarness({ mode: 'mock' });
    const s = h.svc.buildAwaySummary({
      petId: PET_ID,
      islandId: 'main',
      sinceIslandDay: 1,
      currentIslandDay: 4,
      petName: 'みずね',
    });
    expect(s.generic).toBe(true);
    expect(s.lines).toHaveLength(AWAY_MIN_LINES);
    expect(s.islandDaysPassed).toBe(3);
    expect(h.calls()).toBe(0);
  });

  test('留守より前の日記は材料にしない', () => {
    const h = newHarness({ mode: 'mock' });
    seedMemories(h, 5, [{ text: '5日目。むかしのはなし。', importance: 7, kind: 'diary' }]);

    const s = h.svc.buildAwaySummary({
      petId: PET_ID,
      islandId: 'main',
      sinceIslandDay: 40,
      currentIslandDay: 42,
      petName: 'みずね',
    });
    expect(s.generic).toBe(true);
    expect(s.lines.join('\n')).not.toContain('むかしのはなし');
  });

  test('各行が長さ上限を守り、ペット名が主語になっている', () => {
    const h = newHarness({ mode: 'mock' });
    seedMemories(h, 50, [{ text: 'あ'.repeat(80), importance: 7, kind: 'diary' }]);
    seedEvents(h, [{ islandDay: 50, text: 'い'.repeat(80), importance: 8 }]);

    const s = h.svc.buildAwaySummary({
      petId: PET_ID,
      islandId: 'main',
      sinceIslandDay: 50,
      currentIslandDay: 51,
      petName: 'ながいなまえのペット',
    });

    for (const line of s.lines) {
      expect(line.length).toBeLessThanOrEqual(AWAY_LINE_CHARS);
      expect(line.startsWith('ながいなまえのペット「')).toBe(true);
    }
  });

  test('経過島日数が0以下でも壊れない', () => {
    const h = newHarness({ mode: 'mock' });
    const s = h.svc.buildAwaySummary({
      petId: PET_ID,
      islandId: 'main',
      sinceIslandDay: 10,
      currentIslandDay: 10,
      petName: 'みずね',
    });
    expect(s.islandDaysPassed).toBe(0);
    expect(s.lines.length).toBeGreaterThanOrEqual(AWAY_MIN_LINES);
  });

  test('日記に書かれている出来事は行を二重に使わない', () => {
    const h = newHarness({ mode: 'mock' });
    seedMemories(h, 65, [{ text: '65日目。しろみのこどもが生まれた。うれしい。', importance: 7, kind: 'diary' }]);
    seedEvents(h, [
      { islandDay: 65, text: 'しろみのこどもが生まれた', importance: 8 },
      { islandDay: 65, text: 'くろまめとあんころがケンカした', importance: 6 },
    ]);
    const s = h.svc.buildAwaySummary({
      petId: PET_ID,
      islandId: 'main',
      sinceIslandDay: 65,
      currentIslandDay: 66,
      petName: 'みずね',
    });
    const hits = s.lines.filter((l) => l.includes('こどもが生まれた'));
    expect(hits).toHaveLength(1);
    expect(s.lines.join('\n')).toContain('ケンカ');
  });

  test('同じ文面の出来事は1回だけ載る', () => {
    const h = newHarness({ mode: 'mock' });
    seedEvents(h, [
      { islandDay: 60, text: 'くろまめとしろみがケンカした', importance: 6 },
      { islandDay: 60, text: 'くろまめとしろみがケンカした', importance: 6 },
      { islandDay: 61, text: 'くろまめとしろみがケンカした', importance: 6 },
    ]);
    const s = h.svc.buildAwaySummary({
      petId: PET_ID,
      islandId: 'main',
      sinceIslandDay: 60,
      currentIslandDay: 62,
      petName: 'みずね',
    });
    const hits = s.lines.filter((l) => l.includes('ケンカ'));
    expect(hits).toHaveLength(1);
  });
});

// ---------- 剪定 ----------

describe('記憶の剪定', () => {
  test('古い低重要度の記憶だけを消し、日記は残す', () => {
    const h = newHarness({ mode: 'mock' });
    seedMemories(h, 1, [
      { text: '古くてどうでもいい観察', importance: 2 },
      { text: '古いけれど大事な約束', importance: 8 },
      { text: '古い日記', importance: 7, kind: 'diary' },
    ]);
    seedMemories(h, 19, [{ text: '新しいどうでもいい観察', importance: 2 }]);

    const before = h.petRepo.countMemories(PET_ID);
    const removed = h.svc.pruneOldMemories(PET_ID, 20);

    expect(removed).toBe(1);
    expect(h.petRepo.countMemories(PET_ID)).toBe(before - 1);
    const rest = h.petRepo.recentMemories(PET_ID, { limit: 100 }).map((m) => m.text);
    expect(rest).toContain('古いけれど大事な約束');
    expect(rest).toContain('古い日記');
    expect(rest).toContain('新しいどうでもいい観察');
    expect(rest).not.toContain('古くてどうでもいい観察');
  });

  test('島がまだ若いうちは何も消さない', () => {
    const h = newHarness({ mode: 'mock' });
    seedMemories(h, 1, [{ text: 'どうでもいい観察', importance: 2 }]);
    expect(h.svc.pruneOldMemories(PET_ID, 3)).toBe(0);
    expect(h.petRepo.countMemories(PET_ID)).toBe(1);
  });

  test('剪定の件数が stats に積まれる', () => {
    const h = newHarness({ mode: 'mock' });
    seedMemories(h, 1, [{ text: 'ふるい観察', importance: 1 }]);
    h.svc.pruneOldMemories(PET_ID, 30);
    expect(h.svc.stats().pruned).toBe(1);
  });
});

// ---------- 日記が翌日の会話に出る（結合の入口） ----------

describe('日記の使い道', () => {
  test('書いた日記は kind=diary として検索対象に残る', async () => {
    const { impl } = fakeFetch(
      JSON.stringify({ diary: 'きょうは高台にのぼった。', summaryUpdate: '高台がすき', moodDelta: 2 }),
    );
    const h = newHarness({ mode: 'real', fetchImpl: impl });
    seedMemories(h, 70, [{ text: '高台にのぼった', importance: 6 }]);

    await h.svc.writeDiary({ petId: PET_ID, islandDay: 70, tick: 70 * TICKS_PER_ISLAND_HOUR, ownerVisited: true });

    const diaries = h.petRepo.recentMemories(PET_ID, { kinds: ['diary'], limit: 10 });
    expect(diaries).toHaveLength(1);
    expect(diaries[0]?.importance).toBe(7);
    expect(diaries[0]?.text).toContain('高台');
  });
});
