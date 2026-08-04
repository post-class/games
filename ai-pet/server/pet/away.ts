import { ACTION_LABELS, type PetAction } from '../../shared/actions.js';
import type { AwayReport, GiftView, VisitView } from '../../shared/types.js';
import type { Db } from '../db.js';
import { listEncounters } from './encounter.js';
import type { PetRecord } from './store.js';

/**
 * 留守中レポート。
 *
 * ねこあつめの「開いたら必ず何か起きている」を再現する。
 * 何もなかった日でも必ず1行は出す（空の画面を見せない）。
 */

/** 留守中にしていたであろうことを、ニーズと性格から決定論的に選ぶ。 */
export function awayActivities(pet: PetRecord, hoursAway: number): PetAction[] {
  const out: PetAction[] = [];
  if (hoursAway < 0.5) return out;

  if (pet.needs.energy < 40 || hoursAway > 6) out.push('nap');
  if (pet.needs.hunger < 35) out.push('stare_owner');
  if (pet.needs.fun < 35) out.push(pet.personality.mischief > 60 ? 'hide_item' : 'peek_window');
  if (pet.needs.mood < 25) out.push('sulk_corner');
  if (pet.personality.clever > 70) out.push('daydream');
  if (pet.personality.mischief < 30 && pet.needs.clean > 60) out.push('tidy_room');

  return out.slice(0, 3);
}

function formatHours(hours: number): string {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}分`;
  if (hours < 24) return `${Math.floor(hours)}時間`;
  return `${Math.floor(hours / 24)}日`;
}

export function buildAwayReport(db: Db, pet: PetRecord, hoursAway: number): AwayReport {
  const lines: string[] = [];
  const away = formatHours(hoursAway);

  if (hoursAway >= 0.5) {
    lines.push(`${away}ぶりの再会。`);
    for (const action of awayActivities(pet, hoursAway)) {
      lines.push(`留守のあいだ、${ACTION_LABELS[action]}。`);
    }
  } else {
    lines.push('さっきまで一緒にいた。');
  }

  const giftRows = db
    .prepare(
      `SELECT g.id, g.item_id, g.message, g.created_at, g.claimed, u.name AS from_name
       FROM gifts g JOIN users u ON u.id = g.from_user_id
       WHERE g.to_user_id = ? AND g.claimed = 0 ORDER BY g.created_at DESC LIMIT 10`,
    )
    .all(pet.userId) as Array<{
    id: number;
    item_id: string;
    message: string;
    created_at: number;
    claimed: number;
    from_name: string;
  }>;
  const gifts: GiftView[] = giftRows.map((row) => ({
    id: row.id,
    fromUserName: row.from_name,
    itemId: row.item_id,
    message: row.message,
    createdAt: row.created_at,
    claimed: row.claimed === 1,
  }));
  if (gifts.length) {
    lines.push(`${gifts.length}件のおくりものが届いている。`);
  }

  const visitRows = db
    .prepare(
      `SELECT v.id, v.comment, v.created_at, u.name AS visitor_name, p.name AS visitor_pet
       FROM visits v
       JOIN users u ON u.id = v.visitor_user_id
       LEFT JOIN pets p ON p.user_id = v.visitor_user_id
       WHERE v.host_user_id = ? ORDER BY v.created_at DESC LIMIT 10`,
    )
    .all(pet.userId) as Array<{
    id: number;
    comment: string;
    created_at: number;
    visitor_name: string;
    visitor_pet: string | null;
  }>;
  const visits: VisitView[] = visitRows.map((row) => ({
    id: row.id,
    visitorName: row.visitor_name,
    visitorPetName: row.visitor_pet ?? '???',
    comment: row.comment,
    createdAt: row.created_at,
  }));

  const encounters = listEncounters(db, pet.id, 5).filter((encounter) => !encounter.seen);
  for (const encounter of encounters) {
    lines.push(`外で ${encounter.otherPetName} に会ったらしい。`);
  }

  return { hoursAway, lines, encounters, gifts, visits };
}
