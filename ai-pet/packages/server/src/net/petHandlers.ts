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
import type { PetBrain } from '../pet/brain.ts';
import { memoryFromEvent } from '../pet/memory.ts';

/**
 * 吹き出しの表示時間（文字数から決める）。
 *
 * 以前は短い返事だと3.2秒で消えていて、目を離すと読めずに終わっていた
 * （撮影のためにDOMを監視しないと捕まえられないほど短かった）。
 * **気づけない短さは実質「無い」のと同じ**なので、下限5秒・上限8秒に広げている。
 */
function bubbleMs(text: string): number {
  return Math.min(8000, Math.max(5000, 1800 + text.length * 200));
}

export interface PetSession {
  playerId: string;
  /** ペットのDB上のID */
  petId: number;
  /** ペットのアクターID */
  entityId: EntityId;
}

/**
 * @param hunger `Actor.needs.hunger` の生値（0=満たされ / 100=空腹）。
 *   アクターが引けない場面（理論上は無いが型で保証できない）に備えて既定値を持たせている。
 *   ⚠️ 反転はクライアント側の責務。ここで反転しないこと。
 */
export function petToWire(pet: PetRow, entityId: EntityId, hunger = 0): PetWire {
  return {
    id: entityId,
    species: pet.persona.species,
    name: pet.persona.name,
    affection: pet.affection,
    // ゲージは百分率のバーなので整数で足りる（生の値は 19.376295... のような小数になる）
    hunger: Math.round(hunger),
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
  private brain: PetBrain | null = null;
  /** ペットID → その島日にオーナーが島に来ていたか（日記の材料） */
  private visitedIslandDay = new Map<number, number>();

  constructor(sim: IslandSim, repo: PetRepo, dialogue: DialogueService) {
    this.sim = sim;
    this.repo = repo;
    this.dialogue = dialogue;
    // 島の出来事を、近くにいたペットの記憶に複写する（docs 04章§5）
    sim.events.onFlush((events) => this.rememberEvents(events));
  }

  /** 行動決定層をつなぐ（会話直後の抑止と退島時の掃除に使う） */
  attachBrain(brain: PetBrain): void {
    this.brain = brain;
  }

  /** ペットIDからアクターを引く（日記の懐き度反映で使う） */
  petActorOfPetId(petId: number): Actor | undefined {
    for (const s of this.sessions.values()) {
      if (s.petId === petId) return this.sim.world.actor(s.entityId);
    }
    return undefined;
  }

  /** その島日にオーナーが島に来ていたか */
  ownerVisitedToday(petId: number): boolean {
    return this.visitedIslandDay.get(petId) === this.sim.clock.islandDay;
  }

  /**
   * サーバ再起動後、スナップショットから戻ったペットのアクターをセッションに結び直す。
   *
   * ペットは「オーナー不在でも島に居る」設計なので、
   * これをしないと島にアクターだけ居てDBのペットと繋がらない（記憶も日記も書けない）状態になる。
   */
  rebindRestoredPets(): number {
    let n = 0;
    for (const actor of this.sim.world.actors.values()) {
      if (actor.kind !== 'pet' || !actor.ownerId) continue;
      const row = this.repo.findPetByPlayer(actor.ownerId);
      if (!row) continue;
      this.sessions.set(actor.ownerId, { playerId: actor.ownerId, petId: row.id, entityId: actor.id });
      n++;
    }
    return n;
  }

  // ---------- 入島・退島 ----------

  /** 既存のペットを島に出す。無ければ null（クライアントはタマゴ選択へ） */
  restore(playerId: string, pos: { x: number; y: number }): { pet: PetRow; actor: Actor } | null {
    const row = this.repo.findPetByPlayer(playerId);
    if (!row) return null;

    // オーナーが居ない間もペットは島に残っている（宣伝資料の「ログアウト中も島は動く」）。
    // まだ島に居るなら、その個体をそのまま引き継ぐ（位置も記憶もそのまま）。
    const existing = this.sessions.get(playerId);
    if (existing) {
      const alive = this.sim.world.actor(existing.entityId);
      if (alive) {
        alive.affection = row.affection;
        this.visitedIslandDay.set(row.id, this.sim.clock.islandDay);
        return { pet: row, actor: alive };
      }
    }

    const actor = createPetActor(this.sim.world, {
      species: row.persona.species,
      name: row.persona.name,
      ownerId: playerId,
      pos,
    });
    actor.affection = row.affection;
    this.sessions.set(playerId, { playerId, petId: row.id, entityId: actor.id });
    this.visitedIslandDay.set(row.id, this.sim.clock.islandDay);
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
    this.visitedIslandDay.set(row.id, this.sim.clock.islandDay);
    return { pet: row, actor };
  }

  /**
   * 切断時。**ペットは島に残す**（オーナーが居ない間も暮らし続ける）。
   *
   * 宣伝資料の「3日ぶりに開いたとき、ペットが誰かと友達になっていて」を成立させるには、
   * 不在中も島に居て、出来事を見て、記憶を溜めている必要がある。
   * 消すのはサーバ停止時だけ（そのときはDBから復元される）。
   */
  leave(playerId: string): EntityId | null {
    const s = this.sessions.get(playerId);
    if (!s) return null;
    this.talking.delete(playerId);
    // セッションは残す（brainの不在間隔・記憶の複写・日記の対象に含めるため）
    return null;
  }

  /** 島に残っているペットの数（不在オーナーぶんを含む） */
  petsInIsland(): number {
    let n = 0;
    for (const s of this.sessions.values()) if (this.sim.world.actor(s.entityId)) n++;
    return n;
  }

  sessionOf(playerId: string): PetSession | undefined {
    return this.sessions.get(playerId);
  }

  /** 接続中のペット一覧（PetBrain の activePets に渡す） */
  sessionList(): PetSession[] {
    return [...this.sessions.values()];
  }

  /** DBに居るすべてのペット（不在ぶんも含む。日記は不在ペットにも書く） */
  allPetIds(): number[] {
    return this.repo.allPetIds();
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
        // 会話の直後は行動決定を走らせない（docs §4.1）
        this.brain?.noteTalked(session.petId, this.sim.tick);
        send({ t: 'chatChunk', convId, entityId: petActor.id, delta: '', done: true });
        send({ t: 'bubble', entityId: petActor.id, text: res.text, kind: 'say', ms: bubbleMs(res.text) });
        send({
          t: 'petState',
          affection: res.affection,
          // おなかは生値をそのまま（反転はクライアント側）。整数に丸めるだけ
          hunger: Math.round(petActor.needs.hunger),
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
    opts.send({ t: 'petState', affection, hunger: Math.round(petActor.needs.hunger), mood: 'うれしい' });
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
      knownPets: this.repo.allPetIds().length,
      dialogue: this.dialogue.stats(),
    };
  }
}
