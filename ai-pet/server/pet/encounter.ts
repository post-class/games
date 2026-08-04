import { describePersonality } from '../../shared/personality.js';
import { findSpecies, type EncounterView, type SpeciesId } from '../../shared/types.js';
import type { Db } from '../db.js';
import { chat } from '../llm/azure.js';
import { parseEncounter } from '../llm/parse.js';
import { describeError } from './brain.js';
import { ageHoursOf, stageFor } from './growth.js';
import { addEpisode, listFacts, listEpisodes } from './memory.js';
import { petRecordById, type PetRecord } from './store.js';

/**
 * ペット同士のAI交流（本作の核）。
 *
 * 自分がオフラインの間に、他ユーザのペットと出会って会話したことにする。
 * 双方の性格ベクトルと記憶を入力にするので、相性・喧嘩・仲良しが自然に発生する。
 * 生成した会話ログは双方のエピソード記憶に書き戻され、翌日「土産話」として語られる。
 *
 * これにより「非同期マルチユーザ」と「LLMの強み」が同じ機構で成立する。
 */

const ENCOUNTER_SCHEMA = {
  name: 'pet_encounter',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: [
      'lines',
      'souvenir_self',
      'souvenir_other',
      'affinity_delta',
      'episode_self',
      'episode_other',
    ],
    properties: {
      lines: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['speaker', 'text'],
          properties: {
            speaker: { type: 'string', enum: ['self', 'other'] },
            text: { type: 'string' },
          },
        },
      },
      souvenir_self: { type: 'string' },
      souvenir_other: { type: 'string' },
      affinity_delta: { type: 'integer' },
      episode_self: { type: 'string' },
      episode_other: { type: 'string' },
    },
  },
} as const;

function petBrief(db: Db, pet: PetRecord, label: string): string {
  const species = findSpecies(pet.species);
  const facts = listFacts(db, pet.id)
    .slice(0, 6)
    .map((fact) => `${fact.key}=${fact.value}`)
    .join(' / ');
  const episodes = listEpisodes(db, pet.id, false)
    .slice(0, 3)
    .map((episode) => episode.summary)
    .join(' / ');
  return [
    `## ${label}: ${pet.name}（${species?.name ?? pet.species}）`,
    `話し方の土台: ${species?.speech ?? ''}`,
    describePersonality(pet.personality),
    facts ? `覚えていること: ${facts}` : '覚えていること: まだ少ない',
    episodes ? `最近の思い出: ${episodes}` : '最近の思い出: 特にない',
  ].join('\n');
}

export function affinityOf(db: Db, petId: number, otherPetId: number): number {
  const row = db
    .prepare('SELECT affinity FROM pet_affinity WHERE pet_id = ? AND other_pet_id = ?')
    .get(petId, otherPetId) as { affinity: number } | undefined;
  return row?.affinity ?? 0;
}

function bumpAffinity(db: Db, petId: number, otherPetId: number, delta: number): void {
  db.prepare(
    `INSERT INTO pet_affinity (pet_id, other_pet_id, affinity) VALUES (?, ?, ?)
     ON CONFLICT(pet_id, other_pet_id) DO UPDATE SET affinity = MAX(-100, MIN(100, affinity + ?))`,
  ).run(petId, otherPetId, Math.max(-100, Math.min(100, delta)), delta);
}

/**
 * 相手を選ぶ。フレンドのペットを優先し、いなければ全体からランダム。
 * 社交性が低いペットは出会う確率自体が低い（性格が行動に効く）。
 */
export function pickPartner(
  db: Db,
  pet: PetRecord,
  rand: () => number = Math.random,
  now = Date.now(),
): PetRecord | null {
  // 社交性 0 なら 15%、100 なら 95% の確率で出かける。
  const willingness = 0.15 + (pet.personality.social / 100) * 0.8;
  if (rand() > willingness) return null;

  const friendRows = db
    .prepare(
      `SELECT p.id, p.born_at, p.care_score FROM pets p
       JOIN friends f ON f.friend_id = p.user_id
       WHERE f.user_id = ? AND p.id != ?`,
    )
    .all(pet.userId, pet.id) as Array<{ id: number; born_at: number; care_score: number }>;

  const anyRows = db
    .prepare('SELECT id, born_at, care_score FROM pets WHERE id != ? LIMIT 50')
    .all(pet.id) as Array<{ id: number; born_at: number; care_score: number }>;

  // たまごはまだ話せないので相手にならない。
  const hatched = (rows: typeof friendRows) =>
    rows.filter((row) => stageFor(ageHoursOf(row.born_at, now), row.care_score) !== 'egg');

  const pool = hatched(friendRows).length ? hatched(friendRows) : hatched(anyRows);

  if (!pool.length) return null;
  const chosen = pool[Math.floor(rand() * pool.length)];
  return petRecordById(db, chosen.id);
}

export interface EncounterOutcome {
  encounterId: number;
  view: EncounterView;
}

export async function runEncounter(
  db: Db,
  pet: PetRecord,
  partner: PetRecord,
  now = Date.now(),
): Promise<EncounterOutcome> {
  const affinity = affinityOf(db, pet.id, partner.id);
  const relation =
    affinity > 30
      ? 'この2匹はもう仲がいい'
      : affinity < -30
        ? 'この2匹は前に喧嘩していて、気まずい'
        : '2匹はまだお互いをよく知らない';

  const system = [
    'あなたは2匹の生き物の何気ない出会いを描く語り手。',
    '2匹は飼い主のいない時間に外で偶然出会った。以下の設定に厳密に従って会話させる。',
    '性格の数値どおりに話し方と態度を変えること。相性が悪ければ噛み合わない会話になってよい。',
    '人間の助手のような丁寧な言い方は絶対に使わない。生き物同士のとりとめのない会話にする。',
    '',
    petBrief(db, pet, 'self'),
    '',
    petBrief(db, partner, 'other'),
    '',
    `## 2匹の関係\n${relation}（親密度 ${affinity}）`,
    '',
    '## 出力（JSONのみ）',
    '{',
    '  "lines": [{"speaker":"self|other","text":"..."}],   // 4〜6往復、交互に',
    '  "souvenir_self": "selfが飼い主に語る土産話（1〜2文、selfの口調で）",',
    '  "souvenir_other": "otherが飼い主に語る土産話（1〜2文、otherの口調で）",',
    '  "affinity_delta": -10〜10,   // この出会いで関係がどう動いたか',
    '  "episode_self": "selfの記憶に残る1文",',
    '  "episode_other": "otherの記憶に残る1文"',
    '}',
  ].join('\n');

  const raw = await chat({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: '2匹の出会いを生成して JSON で返す。' },
    ],
    jsonSchema: ENCOUNTER_SCHEMA as unknown as { name: string; schema: Record<string, unknown> },
    maxTokens: 1200,
  });

  const parsed = parseEncounter(raw);
  if (!parsed) throw new Error('交流ログの生成に失敗しました');

  const info = db
    .prepare(
      `INSERT INTO encounters (pet_id, other_pet_id, lines, souvenir, affinity_delta, created_at, seen)
       VALUES (?, ?, ?, ?, ?, ?, 0)`,
    )
    .run(
      pet.id,
      partner.id,
      JSON.stringify(parsed.lines),
      parsed.souvenirSelf,
      parsed.affinityDelta,
      now,
    );

  // 相手側にも同じ出会いを（視点を入れ替えて）保存する。
  const mirrored = parsed.lines.map((line) => ({
    speaker: line.speaker === 'self' ? ('other' as const) : ('self' as const),
    text: line.text,
  }));
  db.prepare(
    `INSERT INTO encounters (pet_id, other_pet_id, lines, souvenir, affinity_delta, created_at, seen)
     VALUES (?, ?, ?, ?, ?, ?, 0)`,
  ).run(
    partner.id,
    pet.id,
    JSON.stringify(mirrored),
    parsed.souvenirOther,
    parsed.affinityDelta,
    now,
  );

  bumpAffinity(db, pet.id, partner.id, parsed.affinityDelta);
  bumpAffinity(db, partner.id, pet.id, parsed.affinityDelta);

  // 双方の記憶に書き戻す。これが「翌日の会話に出てくる」ことの正体。
  if (parsed.episodeSelf) {
    addEpisode(db, pet.id, parsed.episodeSelf, parsed.affinityDelta >= 0 ? 3 : 4, null, now);
  }
  if (parsed.episodeOther) {
    addEpisode(db, partner.id, parsed.episodeOther, parsed.affinityDelta >= 0 ? 3 : 4, null, now);
  }

  db.prepare('UPDATE pets SET last_encounter_at = ? WHERE id IN (?, ?)').run(now, pet.id, partner.id);
  pet.lastEncounterAt = now;

  const ownerRow = db.prepare('SELECT name FROM users WHERE id = ?').get(partner.userId) as
    | { name: string }
    | undefined;

  return {
    encounterId: Number(info.lastInsertRowid),
    view: {
      id: Number(info.lastInsertRowid),
      otherPetName: partner.name,
      otherOwnerName: ownerRow?.name ?? '???',
      otherSpecies: partner.species,
      lines: parsed.lines,
      souvenir: parsed.souvenirSelf,
      affinityDelta: parsed.affinityDelta,
      createdAt: now,
      seen: false,
    },
  };
}

interface EncounterRow {
  id: number;
  other_pet_id: number;
  lines: string;
  souvenir: string;
  affinity_delta: number;
  created_at: number;
  seen: number;
}

export function listEncounters(db: Db, petId: number, limit = 10): EncounterView[] {
  const rows = db
    .prepare('SELECT * FROM encounters WHERE pet_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(petId, limit) as EncounterRow[];

  return rows.map((row) => {
    const other = db
      .prepare(
        `SELECT p.name AS pet_name, p.species AS species, u.name AS owner_name
         FROM pets p JOIN users u ON u.id = p.user_id WHERE p.id = ?`,
      )
      .get(row.other_pet_id) as
      | { pet_name: string; species: string; owner_name: string }
      | undefined;
    return {
      id: row.id,
      otherPetName: other?.pet_name ?? '???',
      otherOwnerName: other?.owner_name ?? '???',
      otherSpecies: (other?.species ?? 'mocha') as SpeciesId,
      lines: JSON.parse(row.lines) as EncounterView['lines'],
      souvenir: row.souvenir,
      affinityDelta: row.affinity_delta,
      createdAt: row.created_at,
      seen: row.seen === 1,
    };
  });
}

export function markEncountersSeen(db: Db, petId: number): void {
  db.prepare('UPDATE encounters SET seen = 1 WHERE pet_id = ?').run(petId);
}

/** ログイン時に呼ぶ。間隔・相性判定を通ったら1件だけ生成する。 */
export async function maybeEncounter(
  db: Db,
  pet: PetRecord,
  intervalMs: number,
  now = Date.now(),
  rand: () => number = Math.random,
): Promise<{ created: EncounterView | null; error?: string }> {
  if (now - pet.lastEncounterAt < intervalMs) return { created: null };
  // たまごのうちは外に出られない。
  if (stageFor(ageHoursOf(pet.bornAt, now), pet.careScore) === 'egg') return { created: null };
  const partner = pickPartner(db, pet, rand, now);
  if (!partner) {
    // 出かけなかった場合も時刻は進めて、毎リクエスト試行しないようにする。
    db.prepare('UPDATE pets SET last_encounter_at = ? WHERE id = ?').run(now, pet.id);
    pet.lastEncounterAt = now;
    return { created: null };
  }
  try {
    const outcome = await runEncounter(db, pet, partner, now);
    return { created: outcome.view };
  } catch (error) {
    db.prepare('UPDATE pets SET last_encounter_at = ? WHERE id = ?').run(now, pet.id);
    pet.lastEncounterAt = now;
    return { created: null, error: describeError(error) };
  }
}
