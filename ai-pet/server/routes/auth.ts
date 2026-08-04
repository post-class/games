import { Router } from 'express';
import { STARTER_COINS, STARTER_INVENTORY } from '../../shared/items.js';
import {
  clearSessionCookie,
  createSession,
  destroySession,
  hashPassword,
  readCookie,
  requireAuth,
  SESSION_COOKIE,
  setSessionCookie,
  userIdForToken,
  validatePassword,
  validateUserName,
  verifyPassword,
  type AuthedRequest,
} from '../auth.js';
import type { Db } from '../db.js';

export function authRoutes(db: Db): Router {
  const router = Router();

  router.post('/register', (req, res) => {
    const name = validateUserName(req.body?.name);
    const password = validatePassword(req.body?.password);
    if (!name) {
      res.status(400).json({ error: 'なまえは2〜16文字の英数字・かな漢字で入れてください' });
      return;
    }
    if (!password) {
      res.status(400).json({ error: 'あいことばは4文字以上にしてください' });
      return;
    }
    const existing = db.prepare('SELECT id FROM users WHERE name = ?').get(name);
    if (existing) {
      res.status(409).json({ error: 'そのなまえは使われています' });
      return;
    }

    const now = Date.now();
    const info = db
      .prepare(
        'INSERT INTO users (name, password_hash, coins, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(name, hashPassword(password), STARTER_COINS, now, now);
    const userId = Number(info.lastInsertRowid);

    const addItem = db.prepare(
      `INSERT INTO inventory (user_id, item_id, count) VALUES (?, ?, ?)
       ON CONFLICT(user_id, item_id) DO UPDATE SET count = count + excluded.count`,
    );
    for (const [itemId, count] of STARTER_INVENTORY) addItem.run(userId, itemId, count);

    db.prepare('INSERT INTO room_layout (user_id, layout, updated_at) VALUES (?, ?, ?)').run(
      userId,
      JSON.stringify({ wall: 'cream', floor: 'wood', furniture: [] }),
      now,
    );

    setSessionCookie(res, createSession(db, userId));
    res.json({ user: { id: userId, name }, coins: STARTER_COINS });
  });

  router.post('/login', (req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const row = db.prepare('SELECT id, password_hash FROM users WHERE name = ?').get(name) as
      | { id: number; password_hash: string }
      | undefined;
    if (!row || !verifyPassword(password, row.password_hash)) {
      res.status(401).json({ error: 'なまえかあいことばが違います' });
      return;
    }
    db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(Date.now(), row.id);
    setSessionCookie(res, createSession(db, row.id));
    res.json({ user: { id: row.id, name } });
  });

  router.post('/logout', (req, res) => {
    const token = readCookie(req, SESSION_COOKIE);
    if (token) destroySession(db, token);
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  router.get('/me', (req, res) => {
    const userId = userIdForToken(db, readCookie(req, SESSION_COOKIE));
    if (userId === null) {
      res.json({ user: null });
      return;
    }
    const row = db.prepare('SELECT id, name, coins FROM users WHERE id = ?').get(userId) as
      | { id: number; name: string; coins: number }
      | undefined;
    if (!row) {
      res.json({ user: null });
      return;
    }
    const pet = db.prepare('SELECT id FROM pets WHERE user_id = ?').get(userId) as
      | { id: number }
      | undefined;
    res.json({ user: { id: row.id, name: row.name }, coins: row.coins, hasPet: Boolean(pet) });
  });

  // 自分のアカウントを消す（テストと作り直し用）。
  router.delete('/me', requireAuth(db), (req: AuthedRequest, res) => {
    db.prepare('DELETE FROM users WHERE id = ?').run(req.userId);
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  return router;
}
