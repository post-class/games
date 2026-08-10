/**
 * T4-⑮ 救助を、自分の手で行う操作にする。
 *
 * 固定したいのは次の5点。
 *  1. 速すぎる／遠すぎると収容が**始まらない**（第1章で「近づく手段が示されないまま失敗した」問題の根）
 *  2. 条件を満たすと進捗が進み、外れると戻る
 *  3. 収容すると `rescued` が増え、`rescuedNames` に**名前**が入る
 *  4. 名前は `SpawnGroupDef.displayName` / `displayNames`（＝`speakerName()` 由来）だけから来る
 *  5. 発艦演出中・撃墜演出中には収容が始まらない
 * あわせて第1章のポッド3基が全部拾えること（詰みでない）と、
 * 拾わなくても必須目標だけで勝てることを実際に走らせて確認する。
 */
import { Vector3 } from 'three';
import { beforeEach, describe, expect, it } from 'vitest';
import { DIFFICULTIES } from '../../src/app/settings';
import { VEIL_CH01 } from '../../src/content/veil/missions/ch01';
import { VEIL_CH10 } from '../../src/content/veil/missions/ch10';
import { speakerName } from '../../src/content/veil/missions/shared';
import { bus } from '../../src/core/events';
import { reseed } from '../../src/core/rng';
import {
  MissionRunner,
  displayNameOf,
  returneeRollCall,
  rollCallLines,
} from '../../src/mission/MissionRunner';
import type { MissionDef } from '../../src/mission/types';
import { setCombatOptions } from '../../src/sim/combat';
import {
  RECOVERY_DECAY_RATE,
  RECOVERY_HOLD_SECONDS,
  RECOVERY_REL_SPEED,
  RecoveryHold,
  recoveryBlockOf,
  recoveryConditions,
  recoveryNoticeRange,
  type RecoverySample,
} from '../../src/sim/recovery';
import { recoveryHudView } from '../../src/hud/recoveryHud';
import { simulateStep } from '../../src/sim/step';
import type { Entity } from '../../src/world/entity';
import { World } from '../../src/world/world';

const DT = 1 / 60;
const COND = recoveryConditions({ range: 300 });

beforeEach(() => {
  reseed(0x4b15);
  setCombatOptions({ playerDamageTaken: 1, playerDamageDealt: 1 });
});

const sample = (over: Partial<RecoverySample> = {}): RecoverySample => ({
  id: 1,
  name: 'テスト対象',
  distance: 100,
  relSpeed: 10,
  ...over,
});

// ───────── 1. 条件の判定 ─────────

describe('収容の条件 (距離・相対速度・保持秒数)', () => {
  it('近くて遅ければ収容できる', () => {
    expect(recoveryBlockOf(sample(), COND)).toBe('ready');
  });

  it('遠すぎると始まらない', () => {
    expect(recoveryBlockOf(sample({ distance: 301 }), COND)).toBe('far');
    // 境界: ちょうど条件値は成立側
    expect(recoveryBlockOf(sample({ distance: 300 }), COND)).toBe('ready');
  });

  it('速すぎると始まらない', () => {
    expect(recoveryBlockOf(sample({ relSpeed: RECOVERY_REL_SPEED + 1 }), COND)).toBe('fast');
    expect(recoveryBlockOf(sample({ relSpeed: RECOVERY_REL_SPEED }), COND)).toBe('ready');
  });

  it('遠いときは速度を理由にしない (直すべき一つだけを出す)', () => {
    expect(recoveryBlockOf(sample({ distance: 900, relSpeed: 400 }), COND)).toBe('far');
  });

  it('演出中 (suspended) はすべての条件より先に止まる', () => {
    expect(recoveryBlockOf(sample(), COND, true)).toBe('suspended');
  });

  it('案内は条件距離の4倍から出す', () => {
    expect(recoveryNoticeRange(COND)).toBe(1200);
  });
});

// ───────── 2. 保持と減衰 ─────────

describe('収容の保持', () => {
  const hold = () => new RecoveryHold();

  it('条件を満たしている間だけ進み、必要秒で収容が成立する', () => {
    const h = hold();
    let collected = 0;
    for (let i = 0; i < Math.round(RECOVERY_HOLD_SECONDS / DT) - 1; i++) {
      collected += h.update(DT, [sample()], COND).collected.length;
    }
    expect(collected).toBe(0);
    expect(h.progressOf(1)).toBeGreaterThan(RECOVERY_HOLD_SECONDS - 0.1);
    const last = h.update(DT, [sample()], COND);
    expect(last.collected.map((s) => s.id)).toEqual([1]);
    // 収容した対象の保持は捨てる
    expect(h.progressOf(1)).toBe(0);
  });

  it('速すぎる間は1秒経っても進捗が0のまま', () => {
    const h = hold();
    for (let i = 0; i < 60; i++) h.update(DT, [sample({ relSpeed: 400 })], COND);
    expect(h.progressOf(1)).toBe(0);
  });

  it('遠すぎる間は進捗が0のまま', () => {
    const h = hold();
    for (let i = 0; i < 60; i++) h.update(DT, [sample({ distance: 5000 })], COND);
    expect(h.progressOf(1)).toBe(0);
  });

  it('途中で条件を外れると進捗が戻る', () => {
    const h = hold();
    h.update(1, [sample()], COND);
    expect(h.progressOf(1)).toBeCloseTo(1, 5);
    // 加速して離脱 → 1.5 倍速で戻る
    h.update(0.4, [sample({ relSpeed: 400 })], COND);
    expect(h.progressOf(1)).toBeCloseTo(1 - 0.4 * RECOVERY_DECAY_RATE, 5);
    // 戻り切ったら 0 で止まる (負にならない)
    h.update(5, [sample({ relSpeed: 400 })], COND);
    expect(h.progressOf(1)).toBe(0);
  });

  it('戻ったあとでも条件を満たし直せば収容できる', () => {
    const h = hold();
    h.update(2, [sample()], COND);
    h.update(0.5, [sample({ distance: 4000 })], COND);
    expect(h.progressOf(1)).toBeGreaterThan(0);
    const r = h.update(RECOVERY_HOLD_SECONDS, [sample()], COND);
    expect(r.collected).toHaveLength(1);
  });

  it('候補から消えた対象の保持は残らない', () => {
    const h = hold();
    h.update(1, [sample()], COND);
    h.update(DT, [], COND);
    expect(h.progressOf(1)).toBe(0);
  });

  it('保持秒数と相対速度は目標側から上書きできる', () => {
    const loose = recoveryConditions({ range: 300, holdSeconds: 1, relSpeed: 200 });
    const h = hold();
    const r = h.update(1, [sample({ relSpeed: 150 })], loose);
    expect(r.collected).toHaveLength(1);
  });

  it('HUD には保持中のものを優先して1件だけ返す', () => {
    const h = hold();
    h.update(1, [sample({ id: 7, distance: 250 })], COND);
    const r = h.update(DT, [
      sample({ id: 7, distance: 250 }),
      sample({ id: 8, distance: 10 }),
    ], COND);
    expect(r.status?.targetId).toBe(7);
  });
});

// ───────── 3. HUD の文言 ─────────

describe('収容の HUD 表示', () => {
  const statusOf = (over: Partial<RecoverySample>, progress = 0, suspended = false) => {
    const s = sample(over);
    const h = new RecoveryHold();
    if (progress > 0) h.update(progress, [sample(over)], COND);
    return h.update(0, [s], COND, suspended).status!;
  };

  it('保持中は進捗と条件を秒で出す', () => {
    const v = recoveryHudView(statusOf({}, 2.4));
    expect(v.title).toContain('収容中 2.4s / 3.0s');
    expect(v.holding).toBe(true);
    expect(v.ratio).toBeCloseTo(2.4 / 3, 5);
    // 無防備になることと、掩護を頼めることを案内する
    expect(v.advice).toContain('掩護');
  });

  it('速すぎるときは減速を指示する', () => {
    const v = recoveryHudView(statusOf({ relSpeed: 180 }));
    expect(v.title).toContain('収容できない');
    expect(v.advice).toContain('速すぎる');
    expect(v.advice).toContain('減速');
    expect(v.advice).toContain('180 / 60 m/s');
    expect(v.holding).toBe(false);
  });

  it('遠いときは残り距離と条件距離を出す', () => {
    const v = recoveryHudView(statusOf({ distance: 940 }));
    expect(v.advice).toContain('接近せよ');
    expect(v.advice).toContain('640m');
    expect(v.advice).toContain('300m');
  });

  it('演出中は理由を出す', () => {
    const v = recoveryHudView(statusOf({}, 0, true));
    expect(v.title).toContain('収容できない');
    expect(v.advice).toContain('安定していない');
  });

  it('表示名がそのまま出る (HUD で名前を作らない)', () => {
    const v = recoveryHudView(statusOf({ name: '相沢 紗良' }, 1));
    expect(v.title).toContain('相沢 紗良');
  });
});

// ───────── 4. ミッションでの収容 ─────────

const BASE: MissionDef = {
  id: 'test-recovery',
  title: '収容テスト',
  system: 'Test',
  briefing: [''],
  briefingSpeaker: '管制',
  playerShipId: 'hornet',
  navs: [
    { name: 'NAV 1', pos: [0, 0, -4000] },
    { name: '帰投', pos: [0, 0, 0] },
  ],
  // 収容を1基ずつ確かめたいので、条件距離より十分に離して別々の群で置く
  spawns: [
    {
      shipId: 'escape-pod',
      count: 1,
      faction: 'neutral',
      tag: 'pods',
      offset: [0, 0, -3000],
      spread: 0,
      speed: 0,
      displayName: '朝倉 澪',
    },
    {
      shipId: 'escape-pod',
      count: 1,
      faction: 'neutral',
      tag: 'pods',
      offset: [6000, 0, -3000],
      spread: 0,
      speed: 0,
      displayName: '相沢 紗良',
    },
  ],
  objectives: [
    { id: 'sar', text: '収容', required: true, spec: { kind: 'rescue', tag: 'pods', radius: 300 } },
  ],
  debriefWin: [''],
  debriefLoss: [''],
};

function start(def: MissionDef) {
  const world = new World();
  const runner = new MissionRunner(world, def, { shipId: def.playerShipId }, DIFFICULTIES.normal);
  runner.build();
  runner.update(DT);
  return { world, runner };
}

/** その座標へワープして到達判定を降らせる */
function warpTo(world: World, runner: MissionRunner, pos: readonly [number, number, number]): void {
  for (let i = 0; i < 8; i++) {
    world.player!.pos.set(pos[0], pos[1], pos[2]);
    world.player!.vel.set(0, 0, 0);
    runner.update(DT);
  }
}

/** 対象の横に並走して収容する（相対速度0で保持） */
function recover(world: World, runner: MissionRunner, target: Entity, seconds: number): void {
  const steps = Math.max(1, Math.round(seconds / DT));
  for (let i = 0; i < steps; i++) {
    world.player!.pos.copy(target.pos);
    world.player!.vel.copy(target.vel);
    runner.update(DT);
  }
}

describe('ミッションでの収容', () => {
  it('接近しただけでは収容されない (半径に入れば自動ではない)', () => {
    const { world, runner } = start(BASE);
    const pod = world.entities.find((e) => e.tag === 'pods' && e.alive)!;
    world.player!.pos.copy(pod.pos);
    world.player!.vel.set(0, 0, 0);
    runner.update(DT);
    expect(runner.summary().rescued).toBe(0);
    expect(pod.alive).toBe(true);
  });

  it('速すぎると収容が始まらない', () => {
    const { world, runner } = start(BASE);
    const pod = world.entities.find((e) => e.tag === 'pods' && e.alive)!;
    for (let i = 0; i < 300; i++) {
      world.player!.pos.copy(pod.pos);
      world.player!.vel.set(0, 0, -400);
      runner.update(DT);
    }
    expect(runner.summary().rescued).toBe(0);
  });

  it('遠すぎると収容が始まらない', () => {
    const { world, runner } = start(BASE);
    const pod = world.entities.find((e) => e.tag === 'pods' && e.alive)!;
    for (let i = 0; i < 300; i++) {
      world.player!.pos.copy(pod.pos).add(new Vector3(0, 0, 2000));
      world.player!.vel.set(0, 0, 0);
      runner.update(DT);
    }
    expect(runner.summary().rescued).toBe(0);
  });

  it('条件を満たして保つと収容でき、rescued と rescuedNames が揃って増える', () => {
    const { world, runner } = start(BASE);
    const pods = world.entities.filter((e) => e.tag === 'pods' && e.alive);
    expect(pods).toHaveLength(2);
    recover(world, runner, pods[0], RECOVERY_HOLD_SECONDS + 0.2);
    const s1 = runner.summary();
    expect(s1.rescued).toBe(1);
    expect(s1.rescuedNames).toEqual(['朝倉 澪']);
    expect(world.byId(pods[0].id)).toBeUndefined();

    recover(world, runner, pods[1], RECOVERY_HOLD_SECONDS + 0.2);
    const s2 = runner.summary();
    expect(s2.rescued).toBe(2);
    expect(s2.rescuedNames).toEqual(['朝倉 澪', '相沢 紗良']);
    // 件数と名前の数が食い違わない
    expect(s2.rescuedNames).toHaveLength(s2.rescued);
  });

  it('名前は displayNames から来る (機体名の推測ではない)', () => {
    const { world } = start(BASE);
    const pods = world.entities.filter((e) => e.tag === 'pods' && e.alive);
    expect(pods.map((p) => displayNameOf(p))).toEqual(['朝倉 澪', '相沢 紗良']);
    // 宣言が無ければ機体名にフォールバックする（既存の見え方を変えない）
    const plain: MissionDef = {
      ...BASE,
      spawns: [{ ...BASE.spawns[0], displayName: undefined, displayNames: undefined }],
    };
    const other = start(plain);
    const pod = other.world.entities.find((e) => e.tag === 'pods')!;
    expect(displayNameOf(pod)).toBe('脱出ポッド');
  });

  it('発艦・着艦演出中 (recoverySuspended) は収容が始まらない', () => {
    const { world, runner } = start(BASE);
    const pod = world.entities.find((e) => e.tag === 'pods' && e.alive)!;
    runner.recoverySuspended = true;
    recover(world, runner, pod, 6);
    expect(runner.summary().rescued).toBe(0);
    // 演出が終われば収容できる
    runner.recoverySuspended = false;
    recover(world, runner, pod, RECOVERY_HOLD_SECONDS + 0.2);
    expect(runner.summary().rescued).toBe(1);
  });

  it('撃墜演出中 (自機が脱出・ハル0) は収容が始まらない', () => {
    const { world, runner } = start(BASE);
    const pod = world.entities.find((e) => e.tag === 'pods' && e.alive)!;
    world.player!.ship!.ejected = true;
    recover(world, runner, pod, 6);
    expect(runner.summary().rescued).toBe(0);

    world.player!.ship!.ejected = false;
    world.player!.ship!.hull = 0;
    recover(world, runner, pod, 6);
    expect(runner.summary().rescued).toBe(0);
  });
});

// ───────── 5. 第1章 ─────────

describe('第1章の脱出ポッド3基', () => {
  /** その Nav へワープして、出現待ちの群が出るまで回す */
  function reachNav(world: World, runner: MissionRunner, index: number, seconds = 1): void {
    const def = VEIL_CH01.navs[index];
    const steps = Math.max(1, Math.round(seconds / DT));
    for (let i = 0; i < steps; i++) {
      world.player!.pos.set(...def.pos);
      world.player!.vel.set(0, 0, 0);
      simulateStep(world, DT, { flightMode: 'wc', ai: { maxAttackersOnPlayer: 1 } });
      runner.update(DT);
    }
  }

  it('搭乗者3名の名前が名簿 (speakerName) 由来で宣言されている', () => {
    const group = VEIL_CH01.spawns.find((g) => g.shipId === 'escape-pod')!;
    expect(group.displayNames).toEqual([
      speakerName('confed-13'),
      speakerName('confed-14'),
      speakerName('confed-15'),
    ]);
    // 名簿の表記そのままではなく、表示用に整えた名前が入っている
    expect(group.displayNames![0]).toBe('相沢 紗良');
  });

  it('3基すべて収容できる (詰みではない)', () => {
    const world = new World();
    const runner = new MissionRunner(world, VEIL_CH01, { shipId: 'hornet' }, DIFFICULTIES.normal);
    runner.build();
    runner.update(DT);
    reachNav(world, runner, 0);
    reachNav(world, runner, 1, 4);
    const pods = world.entities.filter((e) => e.tag === 'rescue' && e.alive);
    expect(pods).toHaveLength(3);
    for (const pod of pods) recover(world, runner, pod, RECOVERY_HOLD_SECONDS + 0.3);
    const s = runner.summary();
    expect(s.rescued).toBe(3);
    expect(s.rescuedNames).toEqual([
      speakerName('confed-13'),
      speakerName('confed-14'),
      speakerName('confed-15'),
    ]);
    expect(s.objectives.find((o) => o.text.includes('脱出ポッド3基'))?.state).toBe('done');
    runner.dispose();
  });

  it('収容が必須ではないので、拾わなくても目標一覧では加点扱いのまま', () => {
    const pods = VEIL_CH01.objectives.find((o) => o.id === 'pods')!;
    expect(pods.required).toBe(false);
    expect(pods.reward).toBe('＋帰還者3');
    // 必須の達成目標は輸送船の帰投と自機の帰投だけ（収容は増やしていない）
    const required = VEIL_CH01.objectives.filter((o) => o.required).map((o) => o.spec.kind);
    expect(required).not.toContain('rescue');
  });

  it('収容が要る章でも、目標文に操作の中身が書いてある', () => {
    for (const o of VEIL_CH01.objectives) {
      if (o.spec.kind !== 'rescue') continue;
      expect(o.text).toContain('300m');
      expect(o.text).toContain('3秒');
    }
  });
});

// ───────── 6. 読み上げ ─────────

describe('帰還者の読み上げ', () => {
  it('累積 → 今回の順で並び、重複は一度だけ', () => {
    expect(returneeRollCall(['相沢 紗良', '柊 奏'], ['水城 玲奈', '相沢 紗良'])).toEqual([
      '相沢 紗良',
      '柊 奏',
      '水城 玲奈',
    ]);
  });

  it('累積が無ければ今回の分だけ', () => {
    expect(returneeRollCall(undefined, ['朝倉 澪'])).toEqual(['朝倉 澪']);
  });

  it('一人も連れ帰っていなければ空 (読む名前が無い)', () => {
    expect(returneeRollCall([], [])).toEqual([]);
    expect(returneeRollCall(['', '  '], [])).toEqual([]);
  });

  it('無線は前口上 + 一人ずつ (まとめて1行にしない)', () => {
    const spec = { navIndex: 2, speaker: '艦長', intro: '最終無線を開く。', interval: 1.8 };
    const lines = rollCallLines(spec, ['相沢 紗良', '柊 奏']);
    expect(lines).toHaveLength(3);
    expect(lines[0].text).toBe('最終無線を開く。');
    expect(lines[1].text).toBe('相沢 紗良。');
    expect(lines[2].text).toBe('柊 奏。');
    expect(lines[1].after).toBe(1.8);
    expect(lines[2].after).toBe(1.8);
    expect(lines.every((l) => l.speaker === '艦長')).toBe(true);
  });

  it('名前が無ければ「無い」と言う1行だけ', () => {
    const lines = rollCallLines({ navIndex: 2, speaker: '艦長', empty: '読む名前が無い。' }, []);
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toBe('読む名前が無い。');
  });

  it('第10章が読み上げを宣言していて、帰投 Nav を指している', () => {
    expect(VEIL_CH10.rollCall).toBeDefined();
    const home = VEIL_CH10.objectives.find((o) => o.spec.kind === 'reachNav')!;
    expect(VEIL_CH10.rollCall!.navIndex).toBe(
      (home.spec as { kind: 'reachNav'; navIndex: number }).navIndex,
    );
    // 累積の名前はロードアウトから渡す（章データに名簿を書かない）
    expect(JSON.stringify(VEIL_CH10)).not.toContain('相沢');
  });

  it('あとは帰るだけになった時点で読み上げが始まる (着いてからでは無線が流れない)', () => {
    const def: MissionDef = {
      ...BASE,
      objectives: [
        { id: 'sar', text: '収容', required: false, spec: { kind: 'rescue', tag: 'pods', radius: 300 } },
        { id: 'home', text: '帰投', required: true, spec: { kind: 'reachNav', navIndex: 1 } },
      ],
      rollCall: { navIndex: 1, speaker: '艦長', intro: '最終無線を開く。', interval: 0.1 },
    };
    const spoken: string[] = [];
    const off = bus.on('radio', (p) => spoken.push(p.text));
    try {
      const { world, runner } = start(def);
      const pod = world.entities.find((e) => e.tag === 'pods' && e.alive)!;
      recover(world, runner, pod, RECOVERY_HOLD_SECONDS + 0.2);
      // 手前の航路点を踏むまでは読み上げを開かない（誰も拾う前に読み始めない）
      for (let i = 0; i < 60; i++) runner.update(DT);
      expect(spoken).not.toContain('最終無線を開く。');
      warpTo(world, runner, BASE.navs[0].pos);
      // 帰投 Nav へは着いていないが、必須は帰投だけなので最終無線が開く
      for (let i = 0; i < 400; i++) runner.update(DT);
      expect(spoken).toContain('最終無線を開く。');
      expect(spoken).toContain('朝倉 澪。');
      runner.dispose();
    } finally {
      off();
    }
  });

  it('累積で渡した名前も読み上げに並ぶ', () => {
    const def: MissionDef = {
      ...BASE,
      objectives: [{ id: 'home', text: '帰投', required: true, spec: { kind: 'reachNav', navIndex: 1 } }],
      rollCall: { navIndex: 1, speaker: '艦長', interval: 0.1 },
    };
    const spoken: string[] = [];
    const off = bus.on('radio', (p) => spoken.push(p.text));
    try {
      const world = new World();
      const runner = new MissionRunner(
        world,
        def,
        { shipId: 'hornet', rescuedNames: ['柊 奏'] },
        DIFFICULTIES.normal,
      );
      runner.build();
      runner.update(DT);
      warpTo(world, runner, BASE.navs[0].pos);
      for (let i = 0; i < 400; i++) runner.update(DT);
      expect(spoken).toContain('柊 奏。');
      runner.dispose();
    } finally {
      off();
    }
  });
});
