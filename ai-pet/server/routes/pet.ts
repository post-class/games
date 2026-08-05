import { Router } from 'express';
import { findItem, type ItemDef } from '../../shared/items.js';
import {
  behaviorHint,
  BOX_COUNT,
  planRound,
  rewardFor,
  ROUNDS_PER_GAME,
} from '../../shared/minigame.js';
import { findSpecies, type SpeciesId } from '../../shared/types.js';
import { findSpot, placeLabel } from '../../shared/world.js';
import { requireAuth, type AuthedRequest } from '../auth.js';
import type { Db } from '../db.js';
import { env } from '../env.js';
import { greetOwner, petThinks, reactToCare, talkToPet } from '../pet/brain.js';
import { buildAwayReport } from '../pet/away.js';
import { maybeEncounter, markEncountersSeen } from '../pet/encounter.js';
import {
  addEpisode,
  deleteEpisode,
  deleteFact,
  listEpisodes,
  listFacts,
  recentChat,
  setEpisodeFaded,
  updateEpisode,
  upsertFact,
} from '../pet/memory.js';
import { applyNeedsDelta } from '../pet/needs.js';
import {
  acknowledgeStage,
  createPet,
  loadPetWithDecay,
  petRecordOf,
  saveNeeds,
  saveState,
  syncStage,
  toPetView,
} from '../pet/store.js';
import { ageHoursOf, stageFor } from '../pet/growth.js';

/** 世話1回の careScore 加算（成長に効く）。連打対策で1日の上限を設ける。 */
const CARE_SCORE_PER_ACTION = 1;
const CARE_SCORE_DAILY_CAP = 30;

/**
 * 自律行動中の「発見」でもらえるコイン。
 * 画面を開いたまま放置するだけで稼げてしまわないよう、間隔と1日の上限を決める
 * （ごほうびケーキ 80 コインに対して、1日 24 コインまで）。
 */
const DISCOVERY_COINS = 3;
const DISCOVERY_INTERVAL_MS = 300_000;
const DISCOVERY_DAILY_CAP = 24;

type CareKind = 'feed' | 'play' | 'clean' | 'pet';

const KIND_BY_ITEM: Record<string, CareKind> = {
  food: 'feed',
  toy: 'play',
  care: 'clean',
};

export function petRoutes(db: Db): Router {
  const router = Router();
  router.use(requireAuth(db));

  /** 交流を裏で走らせている最中のペット。二重起動を防ぐ。 */
  const runningEncounters = new Set<number>();

  /**
   * 発見の報酬のレート制限（ユーザ ID → その日の付与状況）。
   * プロセスを再起動すると消えるが、上限の目的は「放置で無限に稼げないこと」なので
   * これで足りる（スキーマを増やすほどの情報ではない）。
   */
  const discoveryLog = new Map<number, { day: string; at: number; coins: number }>();

  const GROWTH_MEMORY: Record<string, string> = {
    child: 'たまごから生まれて、はじめて飼い主の顔を見た',
    adult: 'おとなになった。飼い主がここまで育ててくれた',
  };

  /** 成長したら、お祝い情報を作り、その瞬間を記憶にも残す。 */
  function growthOf(pet: Parameters<typeof syncStage>[1]): ReturnType<typeof syncStage> {
    const event = syncStage(db, pet);
    if (event && GROWTH_MEMORY[event.to]) {
      addEpisode(db, pet.id, GROWTH_MEMORY[event.to], 5, 'happy');
    }
    return event;
  }

  function inventoryOf(userId: number): Array<{ itemId: string; count: number }> {
    return (
      db
        .prepare('SELECT item_id, count FROM inventory WHERE user_id = ? AND count > 0')
        .all(userId) as Array<{ item_id: string; count: number }>
    ).map((row) => ({ itemId: row.item_id, count: row.count }));
  }

  function coinsOf(userId: number): number {
    const row = db.prepare('SELECT coins FROM users WHERE id = ?').get(userId) as
      | { coins: number }
      | undefined;
    return row?.coins ?? 0;
  }

  router.post('/create', (req: AuthedRequest, res) => {
    const userId = req.userId!;
    const existing = db.prepare('SELECT id FROM pets WHERE user_id = ?').get(userId);
    if (existing) {
      res.status(409).json({ error: 'すでにペットがいます' });
      return;
    }
    const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 12) : '';
    const speciesId = typeof req.body?.species === 'string' ? req.body.species : '';
    if (name.length < 1) {
      res.status(400).json({ error: 'なまえを入れてください' });
      return;
    }
    if (!findSpecies(speciesId)) {
      res.status(400).json({ error: 'しゅるいを選んでください' });
      return;
    }
    const pet = createPet(db, { userId, name, species: speciesId as SpeciesId });
    res.json({ pet: toPetView(pet) });
  });

  /**
   * 画面を開いたときの一括取得。
   *
   * ペット同士の交流は LLM 呼び出しに20秒近くかかるので、**待たない**。
   * ここで待つと起動が20秒止まってしまい、プレイテストで実際に体験を壊していた。
   * 裏で走らせて、終わったら次回の取得（クライアントが少し後に再取得する）で拾う。
   */
  router.get('/state', async (req: AuthedRequest, res) => {
    const userId = req.userId!;
    const loaded = loadPetWithDecay(db, userId);
    if (!loaded) {
      res.json({ pet: null, coins: coinsOf(userId), inventory: inventoryOf(userId) });
      return;
    }
    const { pet, hoursAway } = loaded;

    let encounterPending = false;
    if (String(req.query.social ?? '1') !== '0' && !runningEncounters.has(pet.id)) {
      const due = Date.now() - pet.lastEncounterAt >= env.encounterIntervalMs;
      if (due) {
        encounterPending = true;
        runningEncounters.add(pet.id);
        void maybeEncounter(db, pet, env.encounterIntervalMs)
          .then((result) => {
            if (result.error) console.warn('[ai-pet] encounter:', result.error);
          })
          .finally(() => runningEncounters.delete(pet.id));
      }
    }

    const growth = growthOf(pet);
    const report = buildAwayReport(db, pet, hoursAway);
    res.json({
      pet: toPetView(pet),
      coins: coinsOf(userId),
      inventory: inventoryOf(userId),
      chat: recentChat(db, pet.id, 20),
      report,
      growth,
      encounterPending,
    });
  });

  /**
   * 久しぶりに開いたときの第一声。
   * 起動を止めないよう /state とは分け、クライアントが表示準備できてから呼ぶ。
   */
  router.post('/greet', async (req: AuthedRequest, res) => {
    const loaded = loadPetWithDecay(db, req.userId!);
    if (!loaded) {
      res.status(404).json({ error: 'ペットがいません' });
      return;
    }
    const { pet } = loaded;
    if (stageFor(ageHoursOf(pet.bornAt, Date.now()), pet.careScore) === 'egg') {
      res.json({ reply: null });
      return;
    }
    const hoursAway = Math.max(0, Number(req.body?.hoursAway) || 0);
    const result = await greetOwner(db, pet, hoursAway);
    res.json({ pet: toPetView(pet), reply: result.reply, llmError: result.llmError });
  });

  /** 成長のお祝いを見せ終わった。これを受けるまでお祝いは出続ける。 */
  router.post('/growth/seen', (req: AuthedRequest, res) => {
    const pet = petRecordOf(db, req.userId!);
    if (!pet) {
      res.status(404).json({ error: 'ペットがいません' });
      return;
    }
    acknowledgeStage(db, pet.id);
    res.json({ ok: true });
  });

  // --- ミニゲーム「どこに かくした？」 ----------------------------------

  interface ActiveGame {
    answer: number;
    round: number;
    hits: number;
  }
  /** 進行中のゲーム。答えをクライアントに渡さないためサーバで持つ。 */
  const games = new Map<number, ActiveGame>();

  router.post('/game/start', (req: AuthedRequest, res) => {
    const loaded = loadPetWithDecay(db, req.userId!);
    if (!loaded) {
      res.status(404).json({ error: 'ペットがいません' });
      return;
    }
    const { pet } = loaded;
    if (stageFor(ageHoursOf(pet.bornAt, Date.now()), pet.careScore) === 'egg') {
      res.status(400).json({ error: 'たまごは まだ あそべません' });
      return;
    }
    if (pet.needs.energy < 15) {
      res.status(400).json({ error: 'ねむすぎて あそべないみたい' });
      return;
    }

    const plan = planRound(pet.personality);
    games.set(pet.id, { answer: plan.answer, round: 1, hits: 0 });
    res.json({
      round: 1,
      rounds: ROUNDS_PER_GAME,
      startBox: plan.startBox,
      swaps: plan.swaps,
      hintBox: plan.hintBox,
      behavior: behaviorHint(pet.personality),
    });
  });

  router.post('/game/guess', (req: AuthedRequest, res) => {
    const loaded = loadPetWithDecay(db, req.userId!);
    if (!loaded) {
      res.status(404).json({ error: 'ペットがいません' });
      return;
    }
    const { pet } = loaded;
    const game = games.get(pet.id);
    if (!game) {
      res.status(400).json({ error: 'ゲームが はじまっていません' });
      return;
    }
    const guess = Number(req.body?.box);
    if (!Number.isInteger(guess) || guess < 0 || guess >= BOX_COUNT) {
      res.status(400).json({ error: 'はこを えらんでください' });
      return;
    }

    const correct = guess === game.answer;
    if (correct) game.hits += 1;
    const answer = game.answer;
    const finished = game.round >= ROUNDS_PER_GAME;

    if (finished) {
      games.delete(pet.id);
      const coins = rewardFor(game.hits);
      db.prepare('UPDATE users SET coins = coins + ? WHERE id = ?').run(coins, pet.userId);
      // 遊べば退屈が解消し、少し仲良くなる。エネルギーは減る。
      const needs = applyNeedsDelta(pet.needs, { fun: 22, mood: 6, energy: -10 });
      pet.needs = needs;
      saveNeeds(db, pet.id, needs);
      db.prepare(
        'UPDATE pets SET game_plays = game_plays + 1, game_hits = game_hits + ?, care_score = care_score + 1 WHERE id = ?',
      ).run(game.hits, pet.id);
      if (game.hits === ROUNDS_PER_GAME) {
        addEpisode(db, pet.id, '「どこにかくした？」で飼い主が全問正解した', 3, 'excited');
      }
      res.json({
        correct,
        answer,
        finished: true,
        hits: game.hits,
        rounds: ROUNDS_PER_GAME,
        coins,
        pet: toPetView(pet),
      });
      return;
    }

    game.round += 1;
    const plan = planRound(pet.personality);
    game.answer = plan.answer;
    res.json({
      correct,
      answer,
      finished: false,
      hits: game.hits,
      round: game.round,
      rounds: ROUNDS_PER_GAME,
      startBox: plan.startBox,
      swaps: plan.swaps,
      hintBox: plan.hintBox,
    });
  });

  router.post('/encounters/seen', (req: AuthedRequest, res) => {
    const loaded = loadPetWithDecay(db, req.userId!);
    if (!loaded) {
      res.status(404).json({ error: 'ペットがいません' });
      return;
    }
    markEncountersSeen(db, loaded.pet.id);
    res.json({ ok: true });
  });

  /** 世話アクション。アイテムを消費し、ニーズを即時反映してから LLM に一言もらう。 */
  router.post('/care', async (req: AuthedRequest, res) => {
    const userId = req.userId!;
    const loaded = loadPetWithDecay(db, userId);
    if (!loaded) {
      res.status(404).json({ error: 'ペットがいません' });
      return;
    }
    const { pet } = loaded;

    const rawKind = req.body?.kind;
    const itemId = typeof req.body?.itemId === 'string' ? req.body.itemId : null;

    let kind: CareKind;
    let item: ItemDef | undefined;

    if (itemId) {
      item = findItem(itemId);
      if (!item || item.kind === 'furniture') {
        res.status(400).json({ error: 'そのアイテムは使えません' });
        return;
      }
      const owned = db
        .prepare('SELECT count FROM inventory WHERE user_id = ? AND item_id = ?')
        .get(userId, itemId) as { count: number } | undefined;
      if (!owned || owned.count <= 0) {
        res.status(400).json({ error: 'もっていません' });
        return;
      }
      kind = KIND_BY_ITEM[item.kind] ?? 'pet';
      db.prepare('UPDATE inventory SET count = count - 1 WHERE user_id = ? AND item_id = ?').run(
        userId,
        itemId,
      );
    } else if (rawKind === 'pet') {
      kind = 'pet';
    } else {
      res.status(400).json({ error: 'なにをするか指定してください' });
      return;
    }

    // 効果をまず反映する（LLM が落ちても世話は成立する）。
    const effect = item ? item.effect : { mood: 4, fun: 3 };
    const needs = applyNeedsDelta(pet.needs, effect);
    pet.needs = needs;
    saveNeeds(db, pet.id, needs);

    const today = new Date().toISOString().slice(0, 10);
    const capRow = db
      .prepare('SELECT COUNT(*) AS n FROM chat_turns WHERE pet_id = ? AND created_at > ?')
      .get(pet.id, new Date(`${today}T00:00:00Z`).getTime()) as { n: number };
    if (capRow.n < CARE_SCORE_DAILY_CAP) {
      pet.careScore += CARE_SCORE_PER_ACTION;
      saveState(db, pet.id, { careScore: pet.careScore });
    }

    const result = await reactToCare(db, pet, { kind, itemName: item?.name });
    const growth = growthOf(pet);
    res.json({
      pet: toPetView(pet),
      reply: result.reply,
      llmError: result.llmError,
      inventory: inventoryOf(userId),
      coins: coinsOf(userId),
      growth,
    });
  });

  /** 会話。 */
  router.post('/chat', async (req: AuthedRequest, res) => {
    const text = typeof req.body?.text === 'string' ? req.body.text.trim().slice(0, 300) : '';
    if (!text) {
      res.status(400).json({ error: 'ことばを入れてください' });
      return;
    }
    const loaded = loadPetWithDecay(db, req.userId!);
    if (!loaded) {
      res.status(404).json({ error: 'ペットがいません' });
      return;
    }
    const { pet } = loaded;
    const result = await talkToPet(db, pet, text);
    res.json({ pet: toPetView(pet), reply: result.reply, llmError: result.llmError });
  });

  /** 自律的な「思いつき」。間隔をあけて呼ばれる。 */
  router.post('/think', async (req: AuthedRequest, res) => {
    const loaded = loadPetWithDecay(db, req.userId!);
    if (!loaded) {
      res.status(404).json({ error: 'ペットがいません' });
      return;
    }
    const { pet } = loaded;
    const now = Date.now();
    if (now - pet.lastThinkAt < env.thinkIntervalMs) {
      res.json({ pet: toPetView(pet), reply: null, skipped: true });
      return;
    }
    // 場所はクライアントの文字列をそのまま使わず、スポット ID から引き直す。
    const spot = findSpot(String(req.body?.spotId ?? ''));
    const result = await petThinks(db, pet, {
      now,
      place: spot ? placeLabel(spot.id) : null,
    });
    res.json({ pet: toPetView(pet), reply: result.reply, llmError: result.llmError });
  });

  /**
   * 自律行動中の「発見」。
   *
   * ペットが勝手に歩き回って何かを見つけたときに呼ばれる。
   * 見つけた話は**記憶に残す**ので、あとの会話で本人が持ち出してくる。
   *
   * 文章はクライアントから受け取らず、shared/world.ts の定義から引く
   * （プロンプトと記憶に任意の文字列を差し込ませない）。
   * コインが無限に湧かないよう、間隔と1日の上限をサーバ側で見張る。
   */
  router.post('/discover', (req: AuthedRequest, res) => {
    const userId = req.userId!;
    const loaded = loadPetWithDecay(db, userId);
    if (!loaded) {
      res.status(404).json({ error: 'ペットがいません' });
      return;
    }
    const spot = findSpot(String(req.body?.spotId ?? ''));
    const index = Number(req.body?.findIndex);
    const text = spot?.finds?.[Number.isInteger(index) ? index : -1];
    if (!spot || !text) {
      res.status(400).json({ error: 'そんな場所はありません' });
      return;
    }

    const now = Date.now();
    const today = new Date(now).toISOString().slice(0, 10);
    const seen = discoveryLog.get(userId);
    const state =
      seen && seen.day === today ? seen : { day: today, at: 0, coins: 0 };
    if (now - state.at < DISCOVERY_INTERVAL_MS || state.coins >= DISCOVERY_DAILY_CAP) {
      res.json({ coins: 0, remembered: false });
      return;
    }

    const coins = state.coins + DISCOVERY_COINS <= DISCOVERY_DAILY_CAP ? DISCOVERY_COINS : 0;
    discoveryLog.set(userId, { day: today, at: now, coins: state.coins + coins });
    if (coins > 0) {
      db.prepare('UPDATE users SET coins = coins + ? WHERE id = ?').run(coins, userId);
    }
    // 重要度 2。雑談で持ち出される程度で、名前や約束のような大事な記憶は押しのけない。
    addEpisode(db, loaded.pet.id, `${placeLabel(spot.id)}で、${text}`, 2, 'curious');
    res.json({ coins, remembered: true });
  });

  // --- おもいで帳 -------------------------------------------------------

  router.get('/memory', (req: AuthedRequest, res) => {
    const loaded = loadPetWithDecay(db, req.userId!);
    if (!loaded) {
      res.status(404).json({ error: 'ペットがいません' });
      return;
    }
    res.json({
      facts: listFacts(db, loaded.pet.id),
      episodes: listEpisodes(db, loaded.pet.id, true),
    });
  });

  router.put('/memory/fact/:key', (req: AuthedRequest, res) => {
    const loaded = loadPetWithDecay(db, req.userId!);
    if (!loaded) {
      res.status(404).json({ error: 'ペットがいません' });
      return;
    }
    const value = typeof req.body?.value === 'string' ? req.body.value : '';
    if (!value.trim()) {
      deleteFact(db, loaded.pet.id, req.params.key);
    } else {
      upsertFact(db, loaded.pet.id, req.params.key, value);
    }
    res.json({ facts: listFacts(db, loaded.pet.id) });
  });

  router.delete('/memory/fact/:key', (req: AuthedRequest, res) => {
    const loaded = loadPetWithDecay(db, req.userId!);
    if (!loaded) {
      res.status(404).json({ error: 'ペットがいません' });
      return;
    }
    deleteFact(db, loaded.pet.id, req.params.key);
    res.json({ facts: listFacts(db, loaded.pet.id) });
  });

  router.patch('/memory/episode/:id', (req: AuthedRequest, res) => {
    const loaded = loadPetWithDecay(db, req.userId!);
    if (!loaded) {
      res.status(404).json({ error: 'ペットがいません' });
      return;
    }
    const id = Number(req.params.id);
    if (typeof req.body?.faded === 'boolean') {
      setEpisodeFaded(db, loaded.pet.id, id, req.body.faded);
    }
    updateEpisode(db, loaded.pet.id, id, {
      summary: typeof req.body?.summary === 'string' ? req.body.summary : undefined,
      importance: typeof req.body?.importance === 'number' ? req.body.importance : undefined,
    });
    res.json({ episodes: listEpisodes(db, loaded.pet.id, true) });
  });

  router.delete('/memory/episode/:id', (req: AuthedRequest, res) => {
    const loaded = loadPetWithDecay(db, req.userId!);
    if (!loaded) {
      res.status(404).json({ error: 'ペットがいません' });
      return;
    }
    deleteEpisode(db, loaded.pet.id, Number(req.params.id));
    res.json({ episodes: listEpisodes(db, loaded.pet.id, true) });
  });

  return router;
}
