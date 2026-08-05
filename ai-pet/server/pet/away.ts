import { ACTION_LABELS, type PetAction } from '../../shared/actions.js';
import type { AwayReport, GiftView, VisitView } from '../../shared/types.js';
import { findZone, SPOTS, spotAppeal } from '../../shared/world.js';
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

/**
 * 留守中に立ち寄っていた場所。
 *
 * ペットが広いマップを歩き回るようになったので、留守レポートも
 * 「何をしていたか」だけでなく「どこにいたか」を語る。
 * クライアントの自律行動と同じ式（spotAppeal）で選ぶので、
 * 実際に見ているときの行き先と食い違わない。
 *
 * 乱数を使わず、時間から決めた開始位置で並びを回す。
 * 同じ留守時間なら同じ結果になるのでテストできる。
 */
export function awayPlaces(pet: PetRecord, hoursAway: number): string[] {
  if (hoursAway < 1) return [];
  const ranked = SPOTS.filter((spot) => spot.finds?.length)
    .map((spot) => ({ spot, weight: spotAppeal(spot, pet.needs, pet.personality) }))
    .sort((a, b) => b.weight - a.weight || (a.spot.id < b.spot.id ? -1 : 1));

  // 上位だけを候補にして、留守時間で並びを回す（毎回同じ文にならないように）。
  const pool = ranked.slice(0, 5);
  const count = Math.min(pool.length, hoursAway >= 6 ? 3 : 2);
  const offset = Math.floor(hoursAway) % Math.max(1, pool.length);
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const { spot } = pool[(i + offset) % pool.length];
    const finds = spot.finds ?? [];
    out.push(`${findZone(spot.zone)?.name ?? ''}では、${finds[(i + offset) % finds.length]}`);
  }
  return out;
}

function formatHours(hours: number): string {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}分`;
  if (hours < 24) return `${Math.floor(hours)}時間`;
  return `${Math.floor(hours / 24)}日`;
}

/**
 * 留守中の様子は「していた」と過去形で語る。
 * 現在形のラベルを流用すると「留守のあいだ、すやすや寝ている」と
 * ちぐはぐな日本語になってしまう（プレイテストで気づいた）。
 */
const PAST_LABELS: Partial<Record<PetAction, string>> = {
  nap: 'まるくなって ねむっていた',
  stare_owner: 'ドアのほうを 何度も 見ていた',
  peek_window: '窓のそとを ずっと 眺めていた',
  hide_item: 'なにかを こっそり 隠していた',
  sulk_corner: '部屋のすみで じっと していた',
  daydream: 'ぼんやりと 考えごとを していた',
  tidy_room: '部屋を きちんと 片づけていた',
};

/** 同じ書き出しが並ぶと単調なので、順番に変える。 */
const PREFIXES = ['留守のあいだ、', 'そのあと、', 'ときどき、'];

/** ニーズの状態から、待っていた様子を語る。放置に物語をつける。 */
function needLines(pet: PetRecord, hoursAway: number): string[] {
  const lines: string[] = [];
  if (pet.needs.hunger < 40) lines.push('ごはんの おさらを 何度も のぞきに いったらしい。');
  if (pet.needs.fun < 35) lines.push('あそび相手が いなくて、たいくつ そうにしていた。');
  if (pet.needs.clean < 40) lines.push('毛づくろいが 追いつかなくて、すこし よごれている。');
  if (pet.needs.mood < 25 && hoursAway >= 6) {
    lines.push('ずっと ひとりだったので、いまは 少し 拗ねているみたい。');
  } else if (pet.needs.mood > 70 && hoursAway >= 3) {
    lines.push('あなたの においの するものの 近くで 待っていた。');
  }
  return lines;
}

export function buildAwayReport(db: Db, pet: PetRecord, hoursAway: number): AwayReport {
  const lines: string[] = [];
  const away = formatHours(hoursAway);

  if (hoursAway >= 0.5) {
    lines.push(`${away}ぶりの 再会。`);
    awayActivities(pet, hoursAway).forEach((action, index) => {
      lines.push(`${PREFIXES[index % PREFIXES.length]}${PAST_LABELS[action] ?? ACTION_LABELS[action]}。`);
    });
    lines.push(...awayPlaces(pet, hoursAway));
    lines.push(...needLines(pet, hoursAway));
  } else {
    lines.push('さっきまで 一緒にいた。');
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
