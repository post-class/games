import { Router } from 'express';
import { findItem, ITEMS } from '../../shared/items.js';
import type { RoomLayout } from '../../shared/types.js';
import { requireAuth, type AuthedRequest } from '../auth.js';
import type { Db } from '../db.js';

const WALLS = ['cream', 'mint', 'sky', 'rose'];
const FLOORS = ['wood', 'tatami', 'tile', 'grass'];

export function roomRoutes(db: Db): Router {
  const router = Router();
  router.use(requireAuth(db));

  router.get('/', (req: AuthedRequest, res) => {
    const row = db.prepare('SELECT layout FROM room_layout WHERE user_id = ?').get(req.userId!) as
      | { layout: string }
      | undefined;
    res.json({
      layout: row
        ? (JSON.parse(row.layout) as RoomLayout)
        : { wall: 'cream', floor: 'wood', furniture: [] },
      walls: WALLS,
      floors: FLOORS,
    });
  });

  router.put('/', (req: AuthedRequest, res) => {
    const body = req.body as Partial<RoomLayout> | undefined;
    const wall = WALLS.includes(String(body?.wall)) ? String(body?.wall) : 'cream';
    const floor = FLOORS.includes(String(body?.floor)) ? String(body?.floor) : 'wood';
    const furniture = Array.isArray(body?.furniture)
      ? body!.furniture
          .filter((entry) => {
            const item = findItem(String(entry?.itemId));
            return item?.kind === 'furniture';
          })
          .slice(0, 20)
          .map((entry) => ({
            itemId: String(entry.itemId),
            x: Math.max(0, Math.min(15, Math.round(Number(entry.x) || 0))),
            y: Math.max(0, Math.min(9, Math.round(Number(entry.y) || 0))),
          }))
      : [];

    const layout: RoomLayout = { wall, floor, furniture };
    db.prepare(
      `INSERT INTO room_layout (user_id, layout, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET layout = excluded.layout, updated_at = excluded.updated_at`,
    ).run(req.userId!, JSON.stringify(layout), Date.now());
    res.json({ layout });
  });

  /** おみせ。コインでアイテムを買う。 */
  router.get('/shop', (_req, res) => {
    res.json({ items: ITEMS });
  });

  router.post('/shop/buy', (req: AuthedRequest, res) => {
    const userId = req.userId!;
    const itemId = typeof req.body?.itemId === 'string' ? req.body.itemId : '';
    const item = findItem(itemId);
    if (!item) {
      res.status(400).json({ error: 'そのアイテムはありません' });
      return;
    }
    const row = db.prepare('SELECT coins FROM users WHERE id = ?').get(userId) as
      | { coins: number }
      | undefined;
    if (!row || row.coins < item.price) {
      res.status(400).json({ error: 'コインが足りません' });
      return;
    }
    db.prepare('UPDATE users SET coins = coins - ? WHERE id = ?').run(item.price, userId);
    db.prepare(
      `INSERT INTO inventory (user_id, item_id, count) VALUES (?, ?, 1)
       ON CONFLICT(user_id, item_id) DO UPDATE SET count = count + 1`,
    ).run(userId, itemId);
    res.json({ ok: true, coins: row.coins - item.price });
  });

  return router;
}
