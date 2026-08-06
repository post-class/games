/**
 * ペット関連のメッセージ処理（createPet / say / interact）。
 *
 * hub.ts が肥大化しないよう、ペット周りの手続きをここに切り出している。
 * LLMを待つあいだ tick を止めないため、会話は**非同期に走らせて結果をあとから送る**。
 */
import {
  LLM,
  type Actor,
  type EntityId,
  type PetSpecies,
  type PetWire,
  type ServerMsg,
} from '@ai-pet/shared';
import { createPetActor } from '../sim/actors.ts';
import type { IslandSim } from '../sim/island.ts';
import type { PetRepo, PetRow } from '../db/petRepo.ts';
import { buildPersona, PET_ARCHETYPES } from '../pet/persona.ts';
import { DialogueService, TALK_RANGE, type DialogueResult } from '../pet/dialogue.ts';
import { memoryFromEvent } from '../pet/memory.ts';

/** 吹き出しの表示時間（文字数から決める） */
function bubbleMs(text: string): number {
  return Math.min(9000, 2200 + text.length * 180);
}

export interface PetSession {
  playerId: string;
  /** ペットのDB上のID */
  petId: number;
  /** ペットのアクターID */
  entityId: EntityId;
}

export function petToWire(pet: PetRow, entityId: EntityId): PetWire {
  return {
    id: entityId,
    species: pet.persona.species,
    name: pet.persona.name,
    affection: pet.affection,
    persona: {
      traitTags: pet.persona.traitTags,
      catchphrase: pet.persona.catchphrase,
      likes: pet.persona.likes,
      dislikes: pet.persona.dislikes,
      archetype: pet.persona.archetype,
    },
  };
}

/** タマゴ選択UIに渡す図鑑データ（クライアントに配るのはここだけ） */
export function petCatalog(): {
  species: PetSpecies;
  displayName: string;
  archetype: string;
  suggestedTraitTags: string[];
  defaultCatchphrase: string;
  defaultLikes: string;
  defaultDislikes: string;
}[] {
  return (Object.keys(PET_ARCHETYPES) as PetSpecies[]).map((species) => {
    const a = PET_ARCHETYPES[species];
    return {
      species,
      displayName: a.displayName,
      archetype: a.archetype,
      suggestedTraitTags: [...a.suggestedTraitTags],
      defaultCatchphrase: a.defaultCatchphrase,
      defaultLikes: a.defaultLikes,
      defaultDislikes: a.defaultDislikes,
    };
  });
}

export class PetManager {
  private sim: IslandSim;
  private repo: PetRepo;
  private dialogue: DialogueService;
  /** playerId → セッション */
  private sessions = new Map<string, PetSession>();
  /** 同時に走る会話は1プレイヤー1本まで（連投でLLMを積み上げない） */
  private talking = new Set<string>();

  constructor(sim: IslandSim, repo: PetRepo, dialogue: DialogueService) {
    this.sim = sim;
    this.repo = repo;
    this.dialogue = dialogue;
    // 島の出来事を、近くにいたペットの記憶に複写する（docs 04章§5）
    sim.events.onFlush((events) => this.rememberEvents(events));
  }

  // ---------- 入島・退島 ----------

  /** 既存のペットを島に出す。無ければ null（クライアントはタマゴ選択へ） */
  restore(playerId: string, pos: { x: number; y: number }): { pet: PetRow; actor: Actor } | null {
    const row = this.repo.findPetByPlayer(playerId);
    if (!row) return null;
    const actor = createPetActor(this.sim.world, {
      species: row.persona.species,
      name: row.persona.name,
      ownerId: playerId,
      pos,
    });
    actor.affection = row.affection;
    this.sessions.set(playerId, { playerId, petId: row.id, entityId: actor.id });
    return { pet: row, actor };
  }

  /** タマゴから作る。すでに居れば既存を返す（二重作成を防ぐ） */
  create(
    playerId: string,
    input: { species: PetSpecies; name: string; persona: { traitTags?: string[]; catchphrase?: string; likes?: string; dislikes?: string } },
    pos: { x: number; y: number },
  ): { pet: PetRow; actor: Actor } {
    const existing = this.sessions.get(playerId);
    if (existing) {
      const row = this.repo.findPetById(existing.petId);
      const actor = this.sim.world.actor(existing.entityId);
      if (row && actor) return { pet: row, actor };
    }

    // プレイヤー入力は必ずサーバ側でサニタイズする（クライアントの検証は当てにしない）
    const persona = buildPersona({
      species: input.species,
      name: input.name,
      ...(input.persona.traitTags ? { traitTags: input.persona.traitTags } : {}),
      ...(input.persona.catchphrase ? { catchphrase: input.persona.catchphrase } : {}),
      ...(input.persona.likes ? { likes: input.persona.likes } : {}),
      ...(input.persona.dislikes ? { dislikes: input.persona.dislikes } : {}),
    });

    const actor = createPetActor(this.sim.world, {
      species: persona.species,
      name: persona.name,
      ownerId: playerId,
      pos,
    });

    const row = this.repo.createPet({ playerId, persona, traits: actor.traits, entityId: actor.id });
    actor.affection = row.affection;
    this.sessions.set(playerId, { playerId, petId: row.id, entityId: actor.id });
    return { pet: row, actor };
  }

  /** 切断時。アクターは島から消すが、DBのペットは残る */
  leave(playerId: string): EntityId | null {
    const s = this.sessions.get(playerId);
    if (!s) return null;
    this.sessions.delete(playerId);
    this.talking.delete(playerId);
    return s.entityId;
  }

  sessionOf(playerId: string): PetSession | undefined {
    return this.sessions.get(playerId);
  }

  petActorOf(playerId: string): Actor | undefined {
    const s = this.sessions.get(playerId);
    return s ? this.sim.world.actor(s.entityId) : undefined;
  }

  // ---------- 会話 ----------

  /**
   * プレイヤーの発話を処理する。
   * LLMの完了を待たずに戻り、結果は send コールバックで届く。
   */
  handleSay(opts: {
    playerId: string;
    ownerName: string;
    text: string;
    send: (msg: ServerMsg) => void;
  }): void {
    const { playerId, ownerName, text, send } = opts;
    const session = this.sessions.get(playerId);
    if (!session) {
      send({ t: 'warn', code: 'no_pet', message: 'まだペットがいません' });
      return;
    }
    const petActor = this.sim.world.actor(session.entityId);
    const petRow = this.repo.findPetById(session.petId);
    if (!petActor || !petRow) {
      send({ t: 'warn', code: 'no_pet', message: 'ペットが島にいません' });
      return;
    }

    const ownerActor = this.ownerActorOf(playerId);
    if (ownerActor) {
      const d = Math.hypot(ownerActor.pos.x - petActor.pos.x, ownerActor.pos.y - petActor.pos.y);
      if (d > TALK_RANGE) {
        send({ t: 'warn', code: 'too_far', message: 'ペットが遠くにいて聞こえていません' });
        return;
      }
    }

    if (this.talking.has(playerId)) {
      send({ t: 'warn', code: 'busy', message: 'ペットがいま考えています' });
      return;
    }
    this.talking.add(playerId);

    const convId = `${playerId}:${this.sim.tick}`;
    const tick = this.sim.tick;

    // プレイヤーの発話も島の出来事として残す（ペットの記憶の材料になる）
    this.sim.events.emit(tick, {
      kind: 'player_say',
      text: `${ownerName}が${petRow.persona.name}に話しかけた`,
      actorId: petActor.id,
      pos: petActor.pos,
      importance: 4,
    });

    void this.dialogue
      .talk(
        { pet: petRow, petActor, ownerName, ownerActor, playerId, playerText: text, tick },
        (delta) => send({ t: 'chatChunk', convId, entityId: petActor.id, delta, done: false }),
      )
      .then((res: DialogueResult) => {
        send({ t: 'chatChunk', convId, entityId: petActor.id, delta: '', done: true });
        send({ t: 'bubble', entityId: petActor.id, text: res.text, kind: 'say', ms: bubbleMs(res.text) });
        send({
          t: 'petState',
          affection: res.affection,
          mood: res.fallback ? 'ねむそう' : 'ふつう',
          ...(petActor.intent ? { intent: { goal: petActor.intent.goal, reason: petActor.intent.reason } } : {}),
        });
        if (res.fallback && res.errorKind) {
          console.warn(`[pet] 会話フォールバック (${res.errorKind}) player=${playerId}`);
          // 理由に応じて世界観を壊さない言い方で伝える（黙って失敗させない）
          const message =
            res.errorKind === 'rate'
              ? 'ペットが少し疲れているようです。すこし待ってあげてください'
              : 'ペットがねむそうで、うまく話せませんでした';
          send({ t: 'warn', code: res.errorKind === 'rate' ? 'say_rate' : 'llm_down', message });
        }
        // 会話で出た行動の希望を intent にする（M5で本格化）
        if (res.goal) {
          petActor.intent = {
            goal: res.goal,
            reason: '話のなかで決めた',
            expiresAtTick: this.sim.tick + LLM.intentTtlTicks,
          };
        }
      })
      .catch((e: unknown) => {
        console.error('[pet] 会話で予期しないエラー', e);
        const line = this.dialogue.busyLine(petRow.persona.species, tick);
        send({ t: 'chatChunk', convId, entityId: petActor.id, delta: line, done: true });
      })
      .finally(() => {
        this.talking.delete(playerId);
      });
  }

  // ---------- インタラクト ----------

  /** 撫でる。懐き度が上がり、ひとこと返す */
  handlePet(opts: { playerId: string; send: (msg: ServerMsg) => void }): void {
    const session = this.sessions.get(opts.playerId);
    if (!session) return;
    const petActor = this.sim.world.actor(session.entityId);
    const row = this.repo.findPetById(session.petId);
    if (!petActor || !row) return;

    const affection = Math.max(0, Math.min(100, row.affection + 1));
    row.affection = affection;
    petActor.affection = affection;
    this.repo.updatePet(row.id, { affection });

    petActor.anim = 'talk';
    const line = row.persona.catchphrase;
    opts.send({ t: 'bubble', entityId: petActor.id, text: line, kind: 'say', ms: bubbleMs(line) });
    opts.send({ t: 'petState', affection, mood: 'うれしい' });
  }

  // ---------- 記憶 ----------

  /**
   * 島の出来事を、近くにいたペットの記憶に複写する。
   * 「その場にいた記憶だけが残る」ので、ペットごとに知っていることが違う（docs 04章§5）。
   */
  private rememberEvents(events: readonly Parameters<typeof memoryFromEvent>[1][]): void {
    if (this.sessions.size === 0) return;
    const rows = [];
    for (const s of this.sessions.values()) {
      const actor = this.sim.world.actor(s.entityId);
      if (!actor) continue;
      const knownNames = this.sim.world.actorsNear(actor.pos, 12, actor.id).map((a) => a.name);
      for (const ev of events) {
        const m = memoryFromEvent(s.petId, ev, this.sim.tick, {
          petPos: actor.pos,
          knownNames,
          selfId: actor.id,
        });
        if (m) rows.push(m);
      }
    }
    if (rows.length === 0) return;
    try {
      this.repo.insertMemories(rows);
    } catch (e) {
      console.error('[pet] 記憶の保存に失敗', e);
    }
  }

  // ---------- 補助 ----------

  /** オーナーのアバターを引く（PetActions に渡す） */
  ownerActorOf(playerId: string): Actor | undefined {
    return this.ownerLookup?.(playerId);
  }

  private ownerLookup: ((playerId: string) => Actor | undefined) | null = null;

  /** hub がプレイヤーのアクターを引ける関数を渡す */
  setOwnerLookup(fn: (playerId: string) => Actor | undefined): void {
    this.ownerLookup = fn;
  }

  stats(): Record<string, unknown> {
    return {
      pets: this.sessions.size,
      talking: this.talking.size,
      dialogue: this.dialogue.stats(),
    };
  }
}
