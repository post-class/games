import { Router } from 'express';
import { findItem, type ItemDef } from '../../shared/items.js';
import { findSpecies, type SpeciesId } from '../../shared/types.js';
import { requireAuth, type AuthedRequest } from '../auth.js';
import type { Db } from '../db.js';
import { env } from '../env.js';
import { petThinks, reactToCare, talkToPet } from '../pet/brain.js';
import { buildAwayReport } from '../pet/away.js';
import { maybeEncounter, markEncountersSeen } from '../pet/encounter.js';
import {
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
import { createPet, loadPetWithDecay, saveNeeds, saveState, toPetView } from '../pet/store.js';

/** 世話1回の careScore 加算（成長に効く）。連打対策で1日の上限を設ける。 */
const CARE_SCORE_PER_ACTION = 1;
const CARE_SCORE_DAILY_CAP = 30;

type CareKind = 'feed' | 'play' | 'clean' | 'pet';

const KIND_BY_ITEM: Record<string, CareKind> = {
  food: 'feed',
  toy: 'play',
  care: 'clean',
};

export function petRoutes(db: Db): Router {
  const router = Router();
  router.use(requireAuth(db));

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

  /** 画面を開いたときの一括取得。ここで留守レポートと（条件を満たせば）交流も走る。 */
  router.get('/state', async (req: AuthedRequest, res) => {
    const userId = req.userId!;
    const loaded = loadPetWithDecay(db, userId);
    if (!loaded) {
      res.json({ pet: null, coins: coinsOf(userId), inventory: inventoryOf(userId) });
      return;
    }
    const { pet, hoursAway } = loaded;

    let encounterError: string | undefined;
    if (String(req.query.social ?? '1') !== '0') {
      const result = await maybeEncounter(db, pet, env.encounterIntervalMs);
      encounterError = result.error;
    }

    const report = buildAwayReport(db, pet, hoursAway);
    res.json({
      pet: toPetView(pet),
      coins: coinsOf(userId),
      inventory: inventoryOf(userId),
      chat: recentChat(db, pet.id, 20),
      report,
      encounterError,
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
    res.json({
      pet: toPetView(pet),
      reply: result.reply,
      llmError: result.llmError,
      inventory: inventoryOf(userId),
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
    const result = await petThinks(db, pet, { now });
    res.json({ pet: toPetView(pet), reply: result.reply, llmError: result.llmError });
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
