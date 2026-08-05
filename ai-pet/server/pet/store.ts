import { isEmotion, isPetAction, type Emotion, type PetAction } from '../../shared/actions.js';
import { clampPersonality, randomPersonality, type Personality } from '../../shared/personality.js';
import {
  findSpecies,
  type GrowthStage,
  type Needs,
  type PetView,
  type SpeciesId,
} from '../../shared/types.js';
import type { Db } from '../db.js';
import { ageHoursOf, stageFor } from './growth.js';
import { clampNeeds, decayNeeds, initialNeeds } from './needs.js';

export interface PetRow {
  id: number;
  user_id: number;
  name: string;
  species: string;
  personality: string;
  needs: string;
  stage: string;
  care_score: number;
  action: string;
  emotion: string;
  born_at: number;
  needs_at: number;
  last_think_at: number;
  last_encounter_at: number;
}

export interface PetRecord {
  id: number;
  userId: number;
  name: string;
  species: SpeciesId;
  personality: Personality;
  needs: Needs;
  careScore: number;
  action: PetAction;
  emotion: Emotion;
  bornAt: number;
  needsAt: number;
  lastThinkAt: number;
  lastEncounterAt: number;
}

function parseRow(row: PetRow): PetRecord {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    species: (findSpecies(row.species)?.id ?? 'mocha') as SpeciesId,
    personality: clampPersonality(JSON.parse(row.personality) as Personality),
    needs: clampNeeds(JSON.parse(row.needs) as Needs),
    careScore: row.care_score,
    action: isPetAction(row.action) ? row.action : 'idle',
    emotion: isEmotion(row.emotion) ? row.emotion : 'curious',
    bornAt: row.born_at,
    needsAt: row.needs_at,
    lastThinkAt: row.last_think_at,
    lastEncounterAt: row.last_encounter_at,
  };
}

/**
 * 成長段階の変化を検出して確定させる。
 *
 * `pets.stage` 列は「プレイヤーに通知済みの段階」として使う。
 * 計算した段階と食い違ったら、そのときだけ1回お祝いを返す。
 * プレイテストで、孵化がチップの文字が変わるだけで通り過ぎてしまい、
 * いちばん嬉しい瞬間が失われていたため。
 */
export interface GrowthEvent {
  from: GrowthStage;
  to: GrowthStage;
  coins: number;
}

const GROWTH_REWARD: Record<GrowthStage, number> = { egg: 0, child: 40, adult: 150 };

export function syncStage(db: Db, pet: PetRecord, now = Date.now()): GrowthEvent | null {
  const computed = stageFor(ageHoursOf(pet.bornAt, now), pet.careScore);
  const row = db.prepare('SELECT stage, ack_stage FROM pets WHERE id = ?').get(pet.id) as
    | { stage: string; ack_stage: string }
    | undefined;
  const stored = (row?.stage ?? 'egg') as GrowthStage;
  const acknowledged = (row?.ack_stage ?? 'egg') as GrowthStage;

  // ごほうびは段階が進んだ最初の1回だけ渡す。
  if (computed !== stored) {
    db.prepare('UPDATE pets SET stage = ? WHERE id = ?').run(computed, pet.id);
    const coins = GROWTH_REWARD[computed] ?? 0;
    if (coins > 0) {
      db.prepare('UPDATE users SET coins = coins + ? WHERE id = ?').run(coins, pet.userId);
    }
  }

  // お祝いは、プレイヤーが「見た」と返事をするまで出し続ける。
  // 通信が途中で切れてお祝いが消えてしまう事故を防ぐため。
  if (computed === acknowledged) return null;
  return { from: acknowledged, to: computed, coins: GROWTH_REWARD[computed] ?? 0 };
}

/** お祝いを見せ終わったことを記録する。 */
export function acknowledgeStage(db: Db, petId: number): void {
  db.prepare('UPDATE pets SET ack_stage = stage WHERE id = ?').run(petId);
}

export function petRecordOf(db: Db, userId: number): PetRecord | null {
  const row = db.prepare('SELECT * FROM pets WHERE user_id = ?').get(userId) as PetRow | undefined;
  return row ? parseRow(row) : null;
}

export function petRecordById(db: Db, petId: number): PetRecord | null {
  const row = db.prepare('SELECT * FROM pets WHERE id = ?').get(petId) as PetRow | undefined;
  return row ? parseRow(row) : null;
}

/**
 * 読み出しと同時にニーズを現在時刻まで進めて保存する（lazy tick）。
 * 経過時間も返すので、呼び出し側は「何時間ぶりの再訪か」を留守レポートに使える。
 */
export function loadPetWithDecay(
  db: Db,
  userId: number,
  now = Date.now(),
): { pet: PetRecord; hoursAway: number } | null {
  const pet = petRecordOf(db, userId);
  if (!pet) return null;
  const { needs, hoursElapsed } = decayNeeds(pet.needs, pet.personality, pet.needsAt, now);
  if (hoursElapsed > 0) {
    db.prepare('UPDATE pets SET needs = ?, needs_at = ? WHERE id = ?').run(
      JSON.stringify(needs),
      now,
      pet.id,
    );
    pet.needs = needs;
    pet.needsAt = now;
  }
  return { pet, hoursAway: hoursElapsed };
}

export function saveNeeds(db: Db, petId: number, needs: Needs, now = Date.now()): void {
  db.prepare('UPDATE pets SET needs = ?, needs_at = ? WHERE id = ?').run(
    JSON.stringify(clampNeeds(needs)),
    now,
    petId,
  );
}

export function saveState(
  db: Db,
  petId: number,
  patch: { action?: PetAction; emotion?: Emotion; careScore?: number },
): void {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (patch.action) {
    sets.push('action = ?');
    values.push(patch.action);
  }
  if (patch.emotion) {
    sets.push('emotion = ?');
    values.push(patch.emotion);
  }
  if (typeof patch.careScore === 'number') {
    sets.push('care_score = ?');
    values.push(patch.careScore);
  }
  if (!sets.length) return;
  values.push(petId);
  db.prepare(`UPDATE pets SET ${sets.join(', ')} WHERE id = ?`).run(...values);
}

export function toPetView(pet: PetRecord, now = Date.now()): PetView {
  const ageHours = ageHoursOf(pet.bornAt, now);
  return {
    id: pet.id,
    name: pet.name,
    species: pet.species,
    personality: pet.personality,
    needs: pet.needs,
    stage: stageFor(ageHours, pet.careScore),
    ageHours,
    careScore: pet.careScore,
    action: pet.action,
    emotion: pet.emotion,
    bornAt: pet.bornAt,
  };
}

export interface CreatePetInput {
  userId: number;
  name: string;
  species: SpeciesId;
  rand?: () => number;
  now?: number;
}

/** 種族バイアスを加えた性格ベクトルで新しいペットを作る。 */
export function createPet(db: Db, input: CreatePetInput): PetRecord {
  const now = input.now ?? Date.now();
  const rand = input.rand ?? Math.random;
  const species = findSpecies(input.species);
  if (!species) throw new Error(`unknown species: ${input.species}`);

  const base = randomPersonality(rand);
  const personality = clampPersonality(
    Object.fromEntries(
      Object.entries(base).map(([key, value]) => [
        key,
        value + (species.bias[key as keyof Personality] ?? 0),
      ]),
    ) as Personality,
  );

  const needs = initialNeeds();
  const info = db
    .prepare(
      `INSERT INTO pets (user_id, name, species, personality, needs, stage, care_score, action, emotion, born_at, needs_at)
       VALUES (?, ?, ?, ?, ?, 'egg', 0, 'idle', 'curious', ?, ?)`,
    )
    .run(
      input.userId,
      input.name,
      species.id,
      JSON.stringify(personality),
      JSON.stringify(needs),
      now,
      now,
    );

  return {
    id: Number(info.lastInsertRowid),
    userId: input.userId,
    name: input.name,
    species: species.id,
    personality,
    needs,
    careScore: 0,
    action: 'idle',
    emotion: 'curious',
    bornAt: now,
    needsAt: now,
    lastThinkAt: 0,
    lastEncounterAt: 0,
  };
}
