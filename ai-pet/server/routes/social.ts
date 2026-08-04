import { Router } from 'express';
import { findItem } from '../../shared/items.js';
import type { FriendView, PromiseView, RoomLayout, SpeciesId } from '../../shared/types.js';
import { requireAuth, type AuthedRequest } from '../auth.js';
import type { Db } from '../db.js';
import { env } from '../env.js';
import { addEpisode } from '../pet/memory.js';
import { affinityOf, listEncounters, maybeEncounter } from '../pet/encounter.js';
import { ageHoursOf, stageFor } from '../pet/growth.js';
import { loadPetWithDecay, petRecordOf } from '../pet/store.js';

export function socialRoutes(db: Db): Router {
  const router = Router();
  router.use(requireAuth(db));

  /** 他のユーザを探す（自分とフレンド以外）。 */
  router.get('/users', (req: AuthedRequest, res) => {
    const userId = req.userId!;
    const rows = db
      .prepare(
        `SELECT u.id, u.name, p.name AS pet_name, p.species, p.born_at, p.care_score
         FROM users u LEFT JOIN pets p ON p.user_id = u.id
         WHERE u.id != ? ORDER BY u.last_seen_at DESC LIMIT 30`,
      )
      .all(userId) as Array<{
      id: number;
      name: string;
      pet_name: string | null;
      species: string | null;
      born_at: number | null;
      care_score: number | null;
    }>;
    const friendIds = new Set(
      (
        db.prepare('SELECT friend_id FROM friends WHERE user_id = ?').all(userId) as Array<{
          friend_id: number;
        }>
      ).map((row) => row.friend_id),
    );
    res.json({
      users: rows.map((row) => ({
        userId: row.id,
        userName: row.name,
        petName: row.pet_name,
        petSpecies: row.species as SpeciesId | null,
        isFriend: friendIds.has(row.id),
      })),
    });
  });

  router.get('/friends', (req: AuthedRequest, res) => {
    const userId = req.userId!;
    const myPet = petRecordOf(db, userId);
    const now = Date.now();
    const rows = db
      .prepare(
        `SELECT u.id, u.name, p.id AS pet_id, p.name AS pet_name, p.species, p.born_at, p.care_score
         FROM friends f JOIN users u ON u.id = f.friend_id
         LEFT JOIN pets p ON p.user_id = u.id
         WHERE f.user_id = ? ORDER BY u.name`,
      )
      .all(userId) as Array<{
      id: number;
      name: string;
      pet_id: number | null;
      pet_name: string | null;
      species: string | null;
      born_at: number | null;
      care_score: number | null;
    }>;

    const friends: FriendView[] = rows.map((row) => ({
      userId: row.id,
      userName: row.name,
      petName: row.pet_name ?? '（まだいない）',
      petSpecies: (row.species ?? 'mocha') as SpeciesId,
      petStage: stageFor(
        row.born_at ? ageHoursOf(row.born_at, now) : 0,
        row.care_score ?? 0,
      ),
      affinity: myPet && row.pet_id ? affinityOf(db, myPet.id, row.pet_id) : 0,
    }));
    res.json({ friends });
  });

  router.post('/friends', (req: AuthedRequest, res) => {
    const userId = req.userId!;
    const targetId = Number(req.body?.userId);
    if (!Number.isInteger(targetId) || targetId === userId) {
      res.status(400).json({ error: '相手を指定してください' });
      return;
    }
    const exists = db.prepare('SELECT id FROM users WHERE id = ?').get(targetId);
    if (!exists) {
      res.status(404).json({ error: 'その人はいません' });
      return;
    }
    const now = Date.now();
    // 相互フレンドにする（申請・承認は作らない。非同期ソーシャルの摩擦を減らす）。
    const insert = db.prepare(
      'INSERT OR IGNORE INTO friends (user_id, friend_id, created_at) VALUES (?, ?, ?)',
    );
    insert.run(userId, targetId, now);
    insert.run(targetId, userId, now);
    res.json({ ok: true });
  });

  router.delete('/friends/:userId', (req: AuthedRequest, res) => {
    const userId = req.userId!;
    const targetId = Number(req.params.userId);
    db.prepare('DELETE FROM friends WHERE user_id = ? AND friend_id = ?').run(userId, targetId);
    db.prepare('DELETE FROM friends WHERE user_id = ? AND friend_id = ?').run(targetId, userId);
    res.json({ ok: true });
  });

  /** フレンドの部屋を見る（非同期訪問）。訪問した痕跡を残す。 */
  router.get('/room/:userId', (req: AuthedRequest, res) => {
    const userId = req.userId!;
    const hostId = Number(req.params.userId);
    const host = db.prepare('SELECT id, name FROM users WHERE id = ?').get(hostId) as
      | { id: number; name: string }
      | undefined;
    if (!host) {
      res.status(404).json({ error: 'その人はいません' });
      return;
    }
    const layoutRow = db.prepare('SELECT layout FROM room_layout WHERE user_id = ?').get(hostId) as
      | { layout: string }
      | undefined;
    const petRow = db
      .prepare('SELECT name, species, born_at, care_score, action, emotion FROM pets WHERE user_id = ?')
      .get(hostId) as
      | {
          name: string;
          species: string;
          born_at: number;
          care_score: number;
          action: string;
          emotion: string;
        }
      | undefined;

    if (hostId !== userId) {
      db.prepare(
        'INSERT INTO visits (host_user_id, visitor_user_id, comment, created_at) VALUES (?, ?, ?, ?)',
      ).run(hostId, userId, typeof req.query.comment === 'string' ? req.query.comment.slice(0, 60) : '', Date.now());
    }

    const now = Date.now();
    res.json({
      host: { id: host.id, name: host.name },
      layout: layoutRow
        ? (JSON.parse(layoutRow.layout) as RoomLayout)
        : { wall: 'cream', floor: 'wood', furniture: [] },
      pet: petRow
        ? {
            name: petRow.name,
            species: petRow.species as SpeciesId,
            stage: stageFor(ageHoursOf(petRow.born_at, now), petRow.care_score),
            action: petRow.action,
            emotion: petRow.emotion,
          }
        : null,
    });
  });

  router.get('/visits', (req: AuthedRequest, res) => {
    const rows = db
      .prepare(
        `SELECT v.id, v.comment, v.created_at, u.name AS visitor_name, p.name AS visitor_pet
         FROM visits v JOIN users u ON u.id = v.visitor_user_id
         LEFT JOIN pets p ON p.user_id = v.visitor_user_id
         WHERE v.host_user_id = ? ORDER BY v.created_at DESC LIMIT 20`,
      )
      .all(req.userId!) as Array<{
      id: number;
      comment: string;
      created_at: number;
      visitor_name: string;
      visitor_pet: string | null;
    }>;
    res.json({
      visits: rows.map((row) => ({
        id: row.id,
        visitorName: row.visitor_name,
        visitorPetName: row.visitor_pet ?? '???',
        comment: row.comment,
        createdAt: row.created_at,
      })),
    });
  });

  /** おくりものを送る。 */
  router.post('/gift', (req: AuthedRequest, res) => {
    const userId = req.userId!;
    const toUserId = Number(req.body?.userId);
    const itemId = typeof req.body?.itemId === 'string' ? req.body.itemId : '';
    const message = typeof req.body?.message === 'string' ? req.body.message.slice(0, 60) : '';
    if (!findItem(itemId)) {
      res.status(400).json({ error: 'そのアイテムはありません' });
      return;
    }
    const owned = db
      .prepare('SELECT count FROM inventory WHERE user_id = ? AND item_id = ?')
      .get(userId, itemId) as { count: number } | undefined;
    if (!owned || owned.count <= 0) {
      res.status(400).json({ error: 'もっていません' });
      return;
    }
    if (!db.prepare('SELECT id FROM users WHERE id = ?').get(toUserId)) {
      res.status(404).json({ error: 'その人はいません' });
      return;
    }
    db.prepare('UPDATE inventory SET count = count - 1 WHERE user_id = ? AND item_id = ?').run(
      userId,
      itemId,
    );
    db.prepare(
      'INSERT INTO gifts (from_user_id, to_user_id, item_id, message, created_at, claimed) VALUES (?, ?, ?, ?, ?, 0)',
    ).run(userId, toUserId, itemId, message, Date.now());
    res.json({ ok: true });
  });

  /** 届いたおくりものを受け取る。ペットの記憶にも残る。 */
  router.post('/gift/:id/claim', (req: AuthedRequest, res) => {
    const userId = req.userId!;
    const giftId = Number(req.params.id);
    const row = db
      .prepare(
        `SELECT g.id, g.item_id, g.message, u.name AS from_name
         FROM gifts g JOIN users u ON u.id = g.from_user_id
         WHERE g.id = ? AND g.to_user_id = ? AND g.claimed = 0`,
      )
      .get(giftId, userId) as
      | { id: number; item_id: string; message: string; from_name: string }
      | undefined;
    if (!row) {
      res.status(404).json({ error: 'そのおくりものはありません' });
      return;
    }
    db.prepare('UPDATE gifts SET claimed = 1 WHERE id = ?').run(giftId);
    db.prepare(
      `INSERT INTO inventory (user_id, item_id, count) VALUES (?, ?, 1)
       ON CONFLICT(user_id, item_id) DO UPDATE SET count = count + 1`,
    ).run(userId, row.item_id);

    const pet = petRecordOf(db, userId);
    if (pet) {
      const item = findItem(row.item_id);
      addEpisode(
        db,
        pet.id,
        `${row.from_name}さんから${item?.name ?? 'おくりもの'}が届いた${row.message ? `（「${row.message}」）` : ''}`,
        3,
      );
    }
    res.json({ ok: true });
  });

  /** ペット同士の交流を手動で走らせる（検証用・「外に行っておいで」ボタン）。 */
  router.post('/encounter', async (req: AuthedRequest, res) => {
    const loaded = loadPetWithDecay(db, req.userId!);
    if (!loaded) {
      res.status(404).json({ error: 'ペットがいません' });
      return;
    }
    const force = req.body?.force === true;
    const result = await maybeEncounter(
      db,
      loaded.pet,
      force ? 0 : env.encounterIntervalMs,
      Date.now(),
      // force のときは必ず出かける。
      force ? () => 0 : Math.random,
    );
    res.json({ encounter: result.created, error: result.error });
  });

  router.get('/encounters', (req: AuthedRequest, res) => {
    const pet = petRecordOf(db, req.userId!);
    if (!pet) {
      res.status(404).json({ error: 'ペットがいません' });
      return;
    }
    res.json({ encounters: listEncounters(db, pet.id, 20) });
  });

  // --- 今日の約束（Finch 型の軽量版） -----------------------------------

  router.get('/promises', (req: AuthedRequest, res) => {
    const today = new Date().toISOString().slice(0, 10);
    const rows = db
      .prepare('SELECT * FROM promises WHERE user_id = ? AND for_date = ? ORDER BY id')
      .all(req.userId!, today) as Array<{
      id: number;
      text: string;
      for_date: string;
      done: number;
      created_at: number;
    }>;
    const promises: PromiseView[] = rows.map((row) => ({
      id: row.id,
      text: row.text,
      forDate: row.for_date,
      done: row.done === 1,
      createdAt: row.created_at,
    }));
    res.json({ promises });
  });

  router.post('/promises', (req: AuthedRequest, res) => {
    const text = typeof req.body?.text === 'string' ? req.body.text.trim().slice(0, 60) : '';
    if (!text) {
      res.status(400).json({ error: 'やくそくを書いてください' });
      return;
    }
    const today = new Date().toISOString().slice(0, 10);
    db.prepare(
      'INSERT INTO promises (user_id, text, for_date, done, created_at) VALUES (?, ?, ?, 0, ?)',
    ).run(req.userId!, text, today, Date.now());
    res.json({ ok: true });
  });

  router.post('/promises/:id/done', (req: AuthedRequest, res) => {
    const userId = req.userId!;
    const id = Number(req.params.id);
    const row = db
      .prepare('SELECT text FROM promises WHERE id = ? AND user_id = ? AND done = 0')
      .get(id, userId) as { text: string } | undefined;
    if (!row) {
      res.status(404).json({ error: 'そのやくそくはありません' });
      return;
    }
    db.prepare('UPDATE promises SET done = 1 WHERE id = ?').run(id);
    // 約束を守ったことは重要な記憶として残す（Finch の「自分のケアがペットの成長になる」）。
    const pet = petRecordOf(db, userId);
    if (pet) {
      addEpisode(db, pet.id, `飼い主が「${row.text}」の約束を守った`, 5, 'happy');
      db.prepare('UPDATE pets SET care_score = care_score + 2 WHERE id = ?').run(pet.id);
    }
    db.prepare('UPDATE users SET coins = coins + 15 WHERE id = ?').run(userId);
    res.json({ ok: true });
  });

  return router;
}
