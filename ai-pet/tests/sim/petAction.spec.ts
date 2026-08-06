/**
 * ペットのReflex層のテスト。
 * ここが動いていれば「LLMが落ちてもペットは生きて見える」が成立する（docs 09章 M4 の完了条件）。
 */
import { describe, expect, test } from 'vitest';
import {
  NEEDS,
  RESOURCE,
  Rng,
  TICKS_PER_ISLAND_DAY,
  TICK_SEC,
  type Actor,
  type PetIntent,
} from '@ai-pet/shared';
import { IslandWorld } from '../../packages/server/src/sim/world.ts';
import { WorldClock } from '../../packages/server/src/sim/clock.ts';
import { NavService } from '../../packages/server/src/sim/nav.ts';
import { updateMovement } from '../../packages/server/src/sim/movement.ts';
import { createCritterActor, createPetActor, createPlayerActor } from '../../packages/server/src/sim/actors.ts';
import { PetActions, PET_ACTION_TUNING, forgetPet } from '../../packages/server/src/sim/petAction.ts';

const OWNER_ID = 'owner-1';

interface Ctx {
  world: IslandWorld;
  clock: WorldClock;
  nav: NavService;
  pets: PetActions;
  owner: Actor | null;
  pet: Actor;
}

/** 広い草原の世界。オーナーとペットを広場中央に置く */
function newCtx(opts: { withOwner?: boolean; seed?: string } = {}): Ctx {
  const world = new IslandWorld(new Rng(opts.seed ?? 'petaction'));
  for (let y = 40; y < 90; y++) {
    for (let x = 40; x < 90; x++) world.setTerrain(x, y, 'grass');
  }
  world.spawn = { x: 64.5, y: 64.5 };

  const clock = new WorldClock(world.rng);
  const nav = new NavService(world);
  const owner = opts.withOwner === false ? null : createPlayerActor(world, { name: 'りょう', pos: { x: 64.5, y: 64.5 } });
  const pet = createPetActor(world, { species: 'mofi', name: 'モフィ', ownerId: OWNER_ID, pos: { x: 65, y: 65 } });

  const pets = new PetActions(world, nav, clock, {
    ownerActorOf: (id) => (id === OWNER_ID && owner ? owner : undefined),
  });
  return { world, clock, nav, pets, owner, pet };
}

/** サーバのtickを模す（ペット行動 → 経路 → 移動） */
function run(ctx: Ctx, ticks: number, fromTick = 0): number {
  let tick = fromTick;
  for (let i = 0; i < ticks; i++) {
    tick++;
    ctx.pets.update(tick);
    ctx.nav.update();
    updateMovement(ctx.world, TICK_SEC);
  }
  return tick;
}

function addFood(world: IslandWorld, pos: { x: number; y: number }): ReturnType<IslandWorld['addResource']> {
  return world.addResource({
    id: world.allocId(),
    type: 'berry_tree',
    pos,
    amount: RESOURCE.berryTreeMax,
    max: RESOURCE.berryTreeMax,
    regenPerIslandHour: RESOURCE.berryRegenPerIslandHour,
  });
}

function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

describe('オーナーへの追従', () => {
  test('離れたオーナーを追いかける', () => {
    const ctx = newCtx();
    ctx.owner!.pos = { x: 80, y: 70 };
    const before = dist(ctx.pet.pos, ctx.owner!.pos);

    run(ctx, 200);

    const after = dist(ctx.pet.pos, ctx.owner!.pos);
    expect(after, `${before.toFixed(1)} → ${after.toFixed(1)}`).toBeLessThan(before);
    expect(after).toBeLessThan(PET_ACTION_TUNING.FOLLOW_CATCHUP + 1);
  });

  test('近くにいるときは追いかけず、そばで待つ', () => {
    const ctx = newCtx();
    ctx.owner!.pos = { x: 64.5, y: 64.5 };
    ctx.pet.pos = { x: 65.2, y: 64.5 };
    run(ctx, 40);
    expect(ctx.pet.action?.kind).toBe('idle');
  });

  test('オーナーが動き続けても追従の目標地点が更新される', () => {
    const ctx = newCtx();
    let tick = 0;
    for (let i = 0; i < 10; i++) {
      ctx.owner!.pos = { x: 64.5 + i * 1.5, y: 64.5 };
      tick = run(ctx, 20, tick);
    }
    expect(dist(ctx.pet.pos, ctx.owner!.pos)).toBeLessThan(6);
  });

  test('オーナーが未接続なら島で過ごす（昼は歩き、夜は寝る）', () => {
    const ctx = newCtx({ withOwner: false });
    run(ctx, 30);
    expect(['wander', 'idle', 'eat', 'sleep']).toContain(ctx.pet.action?.kind);

    // 夜にする
    const nightTick = Math.floor(TICKS_PER_ISLAND_DAY * 0.8);
    ctx.pet.needs.sleep = 90;
    run(ctx, 30, nightTick);
    expect(ctx.pet.action?.kind).toBe('sleep');
    expect(ctx.pet.anim).toBe('sleep');
  });

  test('オーナーが島の反対側にいたら諦めて自分の用事をする', () => {
    const ctx = newCtx();
    ctx.owner!.pos = { x: 5, y: 5 }; // 到達不能なほど遠い（FOLLOW_GIVEUP超え）
    ctx.pet.pos = { x: 80, y: 80 };
    run(ctx, 20);
    expect(ctx.pet.action?.kind).not.toBe('follow');
  });
});

describe('自分の世話（LLM不要）', () => {
  test('空腹なら食べに行き、満たされる', () => {
    const ctx = newCtx();
    addFood(ctx.world, { x: 70.5, y: 65.5 });
    ctx.pet.needs.hunger = 95;

    run(ctx, 400);

    expect(ctx.pet.needs.hunger).toBeLessThan(95);
    expect(ctx.world.totalResourceAmount()).toBeLessThan(RESOURCE.berryTreeMax);
  });

  test('空腹はオーナーへの追従より優先される', () => {
    const ctx = newCtx();
    addFood(ctx.world, { x: 70.5, y: 65.5 });
    ctx.owner!.pos = { x: 55, y: 65 }; // 反対方向
    ctx.pet.needs.hunger = 95;

    // 20tickも回すと食べ終わって追従に戻るので、最初の判断を見る
    run(ctx, 2);
    expect(ctx.pet.action?.kind).toBe('eat');
  });

  test('食料が無ければ食事を選ばない（探し続けて固まらない）', () => {
    const ctx = newCtx();
    ctx.pet.needs.hunger = 100;
    run(ctx, 40);
    expect(ctx.pet.action?.kind).not.toBe('eat');
  });

  test('ほぼ空の資源は食事の対象にしない', () => {
    const ctx = newCtx();
    const node = addFood(ctx.world, { x: 70.5, y: 65.5 });
    node.amount = 0.2; // 1回ぶんに足りない
    ctx.pet.needs.hunger = 95;
    run(ctx, 20);
    expect(ctx.pet.action?.kind).not.toBe('eat');
  });

  test('夜に眠気が強ければ寝る。朝になったら起きる', () => {
    const ctx = newCtx();
    ctx.pet.needs.sleep = 95;
    const nightTick = Math.floor(TICKS_PER_ISLAND_DAY * 0.8);
    run(ctx, 20, nightTick);
    expect(ctx.pet.anim).toBe('sleep');

    ctx.pet.needs.sleep = 10;
    run(ctx, 20, 10); // 朝（tick=10付近）
    expect(ctx.pet.anim).not.toBe('sleep');
  });
});

describe('LLMが決めた目標（intent）の実行', () => {
  function setIntent(pet: Actor, intent: Partial<PetIntent> & { goal: PetIntent['goal'] }, tick = 0): void {
    pet.intent = {
      goal: intent.goal,
      reason: intent.reason ?? 'テスト',
      expiresAtTick: intent.expiresAtTick ?? tick + 1000,
      ...(intent.targetEntity !== undefined ? { targetEntity: intent.targetEntity } : {}),
      ...(intent.targetTile ? { targetTile: intent.targetTile } : {}),
    };
  }

  test('gather は食料へ向かい、達成すると目標が消える', () => {
    const ctx = newCtx();
    addFood(ctx.world, { x: 68.5, y: 65.5 });
    setIntent(ctx.pet, { goal: 'gather' });

    run(ctx, 300);
    expect(ctx.pet.intent).toBeNull();
    expect(ctx.pets.stats()['intentsExecuted']).toBeGreaterThan(0);
  });

  test('talk_to は相手のところへ行く', () => {
    const ctx = newCtx();
    const other = createCritterActor(ctx.world, { species: 'rabbit', pos: { x: 72, y: 66 }, ageDays: 10 });
    setIntent(ctx.pet, { goal: 'talk_to', targetEntity: other.id });

    // 到着後は用が済んでオーナーの元へ戻るので、最接近距離を見る
    let closest = dist(ctx.pet.pos, other.pos);
    let tick = 0;
    for (let i = 0; i < 60; i++) {
      tick = run(ctx, 5, tick);
      closest = Math.min(closest, dist(ctx.pet.pos, other.pos));
    }
    expect(closest).toBeLessThan(3);
  });

  test('help_critter は相手の空腹を満たす', () => {
    const ctx = newCtx();
    const other = createCritterActor(ctx.world, { species: 'rabbit', pos: { x: 67, y: 65 }, ageDays: 10 });
    other.needs.hunger = 90;
    setIntent(ctx.pet, { goal: 'help_critter', targetEntity: other.id });

    run(ctx, 300);
    expect(other.needs.hunger).toBeLessThan(90);
  });

  test('相手が居ない目標は捨てて既定行動に戻る', () => {
    const ctx = newCtx();
    setIntent(ctx.pet, { goal: 'talk_to', targetEntity: 99_999 });
    ctx.owner!.pos = { x: 75, y: 70 };

    // 追従はすぐ追いついて idle になるので、切り替わった直後を見る
    run(ctx, 2);
    expect(ctx.pet.intent).toBeNull();
    expect(ctx.pets.stats()['intentsFailed']).toBeGreaterThan(0);
    expect(ctx.pet.action?.kind).toBe('follow');
  });

  test('期限が切れた目標は捨てられる', () => {
    const ctx = newCtx();
    setIntent(ctx.pet, { goal: 'rest', expiresAtTick: 5 });
    run(ctx, 20);
    expect(ctx.pet.intent).toBeNull();
  });

  test('空腹が切迫していれば目標より生存を優先する', () => {
    const ctx = newCtx();
    addFood(ctx.world, { x: 68.5, y: 65.5 });
    setIntent(ctx.pet, { goal: 'rest' });
    ctx.pet.needs.hunger = 98;

    run(ctx, 2);
    expect(ctx.pet.action?.kind).toBe('eat');
    // 目標そのものは残っている（あとで再開できる）
    expect(ctx.pet.intent).not.toBeNull();
  });

  test('到達できない場所の explore は捨てられる', () => {
    const ctx = newCtx();
    // 未設定タイルは grass（歩ける）なので、マップ外を指定して到達不能にする
    setIntent(ctx.pet, { goal: 'explore', targetTile: { x: 200, y: 200 } });
    run(ctx, 20);
    expect(ctx.pet.intent).toBeNull();
  });
});

describe('安定性', () => {
  test('1島日ぶん回しても例外が出ず、座標も壊れない', () => {
    const ctx = newCtx();
    addFood(ctx.world, { x: 70.5, y: 65.5 });
    addFood(ctx.world, { x: 60.5, y: 60.5 });

    expect(() => {
      let tick = 0;
      for (let i = 0; i < 40; i++) {
        ctx.owner!.pos = { x: 60 + (i % 20), y: 60 + ((i * 3) % 20) };
        tick = run(ctx, 360, tick);
      }
    }).not.toThrow();

    expect(Number.isFinite(ctx.pet.pos.x)).toBe(true);
    expect(ctx.world.canStandAt(ctx.pet.pos)).toBe(true);
    expect(ctx.pet.needs.hunger).toBeLessThanOrEqual(100);
  });

  test('同じ状況なら同じ行動になる（決定論）', () => {
    function trace(): string {
      const ctx = newCtx({ seed: 'determinism' });
      addFood(ctx.world, { x: 70.5, y: 65.5 });
      ctx.pet.needs.hunger = 80;
      const out: string[] = [];
      let tick = 0;
      for (let i = 0; i < 30; i++) {
        tick = run(ctx, 10, tick);
        out.push(`${ctx.pet.action?.kind}@${ctx.pet.pos.x.toFixed(2)},${ctx.pet.pos.y.toFixed(2)}`);
      }
      return out.join('|');
    }
    expect(trace()).toBe(trace());
  });

  test('forgetPet でキャッシュを捨てても動き続ける', () => {
    const ctx = newCtx();
    run(ctx, 20);
    forgetPet(ctx.pet);
    expect(() => run(ctx, 20)).not.toThrow();
  });

  test('欲求を満たす効果が定数どおり効く', () => {
    const ctx = newCtx();
    const node = addFood(ctx.world, { x: 65.2, y: 65.2 });
    ctx.pet.needs.hunger = 100;
    run(ctx, 60);
    // 1回ぶん食べれば eatRelief ぶん近く減る
    expect(ctx.pet.needs.hunger).toBeLessThanOrEqual(100 - NEEDS.eatRelief * 0.9);
    expect(node.amount).toBeLessThan(RESOURCE.berryTreeMax);
  });
});
