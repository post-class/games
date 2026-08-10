/**
 * T4-⑰ 「撃たない緊張感」を主役にした章（第2章 OPERATION FALSE DAWN）。
 *
 * 固定すること:
 * 1. 撃つべき相手（偽装無人機＝敵対）と撃ってはいけない相手（民間船・漂流者＝非敵対）が
 *    **同じ空域に混ざっている**こと
 * 2. 見分ける手段が**既存 HUD で読める情報**だけで揃っていること
 *    （勢力表示・機種名・速度・通信の遅延。HUD 側の変更は無い）
 * 3. **撃たずに通るだけでは勝てない**こと（偽装無人機の排除が必須）
 * 4. **正しく見分ければ勝てる**こと（＝詰みではない）
 * 5. 誤射したら失敗し、**なぜ誤射になったか**が無線で分かること
 * 6. 難易度を上げすぎていないこと（民間船は誰にも撃たれない＝守り切れずに落ちる経路が無い）
 */
import { Vector3 } from 'three';
import { beforeEach, describe, expect, it } from 'vitest';
import { DIFFICULTIES } from '../../src/app/settings';
import { factionLabel, isHostile } from '../../src/content/factions';
import { shipDef } from '../../src/content/ships';
import { VEIL_CH02 } from '../../src/content/veil/missions/ch02';
import { bus } from '../../src/core/events';
import { reseed } from '../../src/core/rng';
import { displayNameOf, MissionRunner } from '../../src/mission/MissionRunner';
import type { MissionDef, ObjectiveSpec } from '../../src/mission/types';
import { RECOVERY_HOLD_SECONDS } from '../../src/sim/recovery';
import type { Entity } from '../../src/world/entity';
import { World } from '../../src/world/world';

const DT = 1 / 60;
/** 偽装無人機（撃つべき相手） */
const DECOY = 'decoy';
/** 本物の民間船（撃ってはいけない相手） */
const CIVILIAN = 'civilian';
/** 漂流者（収容する相手。撃ってはいけない） */
const RESCUE = 'rescue';

beforeEach(() => {
  reseed(0x4c17);
});

function start(def: MissionDef = VEIL_CH02) {
  const world = new World();
  const runner = new MissionRunner(world, def, { shipId: def.playerShipId }, DIFFICULTIES.easy);
  runner.build();
  runner.update(DT);
  return { world, runner };
}

/** その Nav へワープして到達判定を降らせ、`seconds` 秒だけ滞空する（戦闘は動かさない） */
function holdAtNav(world: World, runner: MissionRunner, index: number, seconds = 0.2): void {
  const pos = VEIL_CH02.navs[index].pos;
  const steps = Math.max(1, Math.round(seconds / DT));
  for (let i = 0; i < steps; i++) {
    world.player!.pos.set(...pos);
    world.player!.vel.set(0, 0, 0);
    runner.update(DT);
    if (runner.state !== 'running') return;
  }
}

/**
 * 異常圏（NAV 2）へ着き、後段の無人機が出るまで待つ。
 * 後段は宣言 45 秒 ＋ 難易度の投入遅延（やさしいは +12 秒）で出る。
 */
function reachAnomaly(world: World, runner: MissionRunner): void {
  const last = Math.max(...VEIL_CH02.spawns.map((g) => g.delay ?? 0));
  holdAtNav(world, runner, 0, 0.3);
  holdAtNav(world, runner, 1, last + DIFFICULTIES.easy.waveDelayBonus + 3);
}

function entitiesOf(world: World, tag: string): Entity[] {
  return world.entities.filter((e) => e.alive && e.tag === tag);
}

function objective(runner: MissionRunner, id: string) {
  const i = VEIL_CH02.objectives.findIndex((o) => o.id === id);
  expect(i, id).toBeGreaterThanOrEqual(0);
  return runner.objectiveViews()[i];
}

/** 対象を正面 `distance` に置いたまま `seconds` 保つ（撃たない＝識別確認の操作） */
function identify(world: World, runner: MissionRunner, target: Entity, seconds: number): void {
  const steps = Math.max(1, Math.round(seconds / DT));
  const fwd = new Vector3(0, 0, -1).applyQuaternion(world.player!.quat);
  for (let i = 0; i < steps; i++) {
    target.pos.copy(world.player!.pos).addScaledVector(fwd, 1200);
    target.vel.set(0, 0, 0);
    runner.update(DT);
    if (runner.state !== 'running') return;
  }
}

/** 並走して収容する（相対速度0で保持） */
function recover(world: World, runner: MissionRunner, target: Entity, seconds: number): void {
  const steps = Math.max(1, Math.round(seconds / DT));
  for (let i = 0; i < steps; i++) {
    world.player!.pos.copy(target.pos);
    world.player!.vel.copy(target.vel);
    runner.update(DT);
    if (runner.state !== 'running') return;
  }
}

// ───────── 1. 撃つべき相手と撃ってはいけない相手が混ざっている ─────────

describe('撃つべき相手と撃ってはいけない相手が混ざっている', () => {
  it('偽装無人機は敵対勢力、民間船と漂流者は非敵対勢力で宣言されている', () => {
    const decoys = VEIL_CH02.spawns.filter((g) => g.tag === DECOY);
    const civilians = VEIL_CH02.spawns.filter((g) => g.tag === CIVILIAN);
    const drifters = VEIL_CH02.spawns.filter((g) => g.tag === RESCUE);
    expect(decoys.length).toBeGreaterThan(0);
    expect(civilians.length).toBeGreaterThan(0);
    expect(drifters.length).toBeGreaterThan(0);
    // 撃つべき相手（撃っても誤射にならない）
    for (const g of decoys) expect(isHostile('confed', g.faction), g.shipId).toBe(true);
    // 撃ってはいけない相手（1発当てた時点で誤射）
    for (const g of [...civilians, ...drifters]) {
      expect(isHostile('confed', g.faction), g.shipId).toBe(false);
    }
  });

  it('同じ空域に出る（現場に着いた時点で両方が戦域にいる）', () => {
    const { world, runner } = start();
    reachAnomaly(world, runner);
    const decoys = entitiesOf(world, DECOY);
    const civilians = entitiesOf(world, CIVILIAN);
    const drifters = entitiesOf(world, RESCUE);
    expect(decoys).toHaveLength(5);
    expect(civilians).toHaveLength(2);
    expect(drifters).toHaveLength(3);
    // 混ざっている＝どの無人機からも民間船が数km以内にいる
    for (const d of decoys) {
      const nearest = Math.min(...civilians.map((c) => c.pos.distanceTo(d.pos)));
      expect(nearest, `無人機と民間船の距離 ${nearest.toFixed(0)}m`).toBeLessThan(8000);
    }
    runner.dispose();
  });

  it('無人機は民間船と僚機の名前を騙る（名前では見分けられない）', () => {
    const civilianNames = VEIL_CH02.spawns
      .filter((g) => g.tag === CIVILIAN)
      .map((g) => g.displayName!);
    const decoys = VEIL_CH02.spawns.filter((g) => g.tag === DECOY);
    // どの偽装群も固有名を名乗る（機体名のままでは偽装にならない）
    for (const g of decoys) expect(g.displayName, g.shipId).toBeTruthy();
    // 少なくとも1群は民間船の船籍名をそのまま返す
    expect(decoys.some((g) => civilianNames.includes(g.displayName!))).toBe(true);
    // 少なくとも1群は僚機の呼称を返す
    expect(decoys.some((g) => g.displayName!.includes('僚機'))).toBe(true);
  });
});

// ───────── 2. 見分ける手段（既存 HUD で読めるものだけ） ─────────

describe('見分ける手段が既存 HUD で読める', () => {
  it('勢力表示が違う（HUD のターゲット情報と同じ出所で、偽装できない）', () => {
    // `factionLabel` は HudView が右VDU に出しているものと同じ関数
    expect(factionLabel('kilrathi')).toBe('キルラシー');
    expect(factionLabel('neutral')).toBe('中立');
    const decoy = VEIL_CH02.spawns.find((g) => g.tag === DECOY)!;
    const civilian = VEIL_CH02.spawns.find((g) => g.tag === CIVILIAN)!;
    expect(factionLabel(decoy.faction)).not.toBe(factionLabel(civilian.faction));
  });

  it('機種名が違う（船籍名を騙る機体の機影は戦闘機）', () => {
    const civilianNames = VEIL_CH02.spawns
      .filter((g) => g.tag === CIVILIAN)
      .map((g) => g.displayName!);
    const liar = VEIL_CH02.spawns.find(
      (g) => g.tag === DECOY && civilianNames.includes(g.displayName!),
    )!;
    const civilian = VEIL_CH02.spawns.find((g) => g.tag === CIVILIAN)!;
    expect(shipDef(liar.shipId).role).toBe('fighter');
    expect(shipDef(civilian.shipId).role).toBe('transport');
    expect(shipDef(liar.shipId).name).not.toBe(shipDef(civilian.shipId).name);
  });

  it('速度が違う（民間船は漂う速さで宣言されている）', () => {
    for (const g of VEIL_CH02.spawns.filter((x) => x.tag === CIVILIAN)) {
      expect(g.speed, g.displayName).toBeGreaterThan(0);
      expect(g.speed!, g.displayName).toBeLessThan(30);
    }
    // 無人機は初速の宣言が無い＝機体本来の巡航速度で寄ってくる
    for (const g of VEIL_CH02.spawns.filter((x) => x.tag === DECOY)) {
      expect(g.speed).toBeUndefined();
      expect(shipDef(g.shipId).maxSpeed).toBeGreaterThan(100);
    }
  });

  it('識別確認の目標文に、読むべきもの（勢力表示）と操作が書いてある', () => {
    const o = VEIL_CH02.objectives.find((x) => x.id === 'identify')!;
    expect(o.required).toBe(true);
    expect(o.spec.kind).toBe('recon');
    expect(o.text).toContain('勢力表示');
    expect(o.text).toContain('中立');
    // 操作（照準に収める・距離・秒数）が読める
    const spec = o.spec as Extract<ObjectiveSpec, { kind: 'recon' }>;
    expect(o.text).toContain('照準');
    expect(o.text).toContain(`${spec.range! / 1000}km`);
    expect(o.text).toContain(`${spec.seconds}秒`);
  });

  it('目標行の note で誤射数と識別の進捗が常時読める', () => {
    const { world, runner } = start();
    reachAnomaly(world, runner);
    expect(objective(runner, 'no-friendly-fire').text).toContain('誤射 0');
    expect(objective(runner, 'identify').text).toContain('%');
    runner.dispose();
  });
});

// ───────── 3. 撃たないだけでは通らない ─────────

describe('撃たないだけでは通らない', () => {
  it('偽装無人機の排除が必須目標になっている', () => {
    const o = VEIL_CH02.objectives.find((x) => x.id === 'decoys')!;
    expect(o.required).toBe(true);
    expect(o.spec.kind).toBe('destroyTag');
    expect((o.spec as { tag: string }).tag).toBe(DECOY);
  });

  it('自機だけが Nav を踏んで帰っても勝てない', () => {
    const { world, runner } = start();
    reachAnomaly(world, runner);
    holdAtNav(world, runner, 2, 0.3);
    expect(objective(runner, 'home').state).toBe('done');
    expect(runner.state).toBe('running');
    expect(objective(runner, 'decoys').state).toBe('active');
    expect(objective(runner, 'identify').state).toBe('active');
    runner.dispose();
  });

  it('撃たずに漂流者を拾って帰るだけでは勝てない（無人機が残る）', () => {
    const { world, runner } = start();
    reachAnomaly(world, runner);
    // 民間船を識別し、漂流者3名を収容し、一発も撃たずに帰投する
    for (const c of entitiesOf(world, CIVILIAN)) identify(world, runner, c, 4);
    for (const pod of entitiesOf(world, RESCUE)) {
      recover(world, runner, pod, RECOVERY_HOLD_SECONDS + 0.3);
    }
    holdAtNav(world, runner, 2, 0.5);
    expect(runner.summary().rescued).toBe(3);
    expect(runner.summary().shotsFired).toBe(0);
    // 帰投も収容も識別も済んでいるのに、無人機が残っているので終わらない
    expect(objective(runner, 'decoys').state).toBe('active');
    expect(runner.state).toBe('running');
    runner.dispose();
  });
});

// ───────── 4. 正しく見分ければ勝てる（詰みではない） ─────────

describe('正しく見分ければ勝てる', () => {
  it('識別して無人機だけを排除し、漂流者を連れて帰れば勝てる', () => {
    const { world, runner } = start();
    reachAnomaly(world, runner);
    // 民間船2隻の識別を確認する（撃たない）
    for (const c of entitiesOf(world, CIVILIAN)) identify(world, runner, c, 4);
    expect(objective(runner, 'identify').state).toBe('done');
    // 勢力表示がキルラシーの機体だけを落とす
    for (const d of entitiesOf(world, DECOY)) world.kill(d);
    runner.update(DT);
    expect(objective(runner, 'decoys').state).toBe('done');
    // 漂流者3名を収容して帰投
    for (const pod of entitiesOf(world, RESCUE)) {
      recover(world, runner, pod, RECOVERY_HOLD_SECONDS + 0.3);
    }
    holdAtNav(world, runner, 2, 0.5);
    expect(runner.summary().rescued).toBe(3);
    expect(runner.summary().friendlyFireHits).toBe(0);
    expect(runner.state).toBe('win');
  });

  it('民間船は誰にも撃たれない（守り切れずに落ちる経路が無い）', () => {
    const { world, runner } = start();
    reachAnomaly(world, runner);
    // 現場で何もせずに滞空しても、民間船は減らない（中立は交戦しない）
    holdAtNav(world, runner, 1, 60);
    expect(entitiesOf(world, CIVILIAN)).toHaveLength(2);
    expect(runner.state).toBe('running');
    expect(runner.objectiveViews().every((o) => o.state !== 'failed')).toBe(true);
    runner.dispose();
  });

  it('必須目標は制限時間を持たない（識別してから撃つ余裕がある）', () => {
    for (const o of VEIL_CH02.objectives) {
      if (!o.required) continue;
      expect(o.spec.kind, o.id).not.toBe('timeLimit');
    }
  });
});

// ───────── 5. 誤射したら失敗し、理由が分かる ─────────

describe('誤射', () => {
  /** 自機の射撃が命中したことにする（`weaponHit` は命中1件につき1回流れる） */
  function hitByPlayer(target: Entity): void {
    bus.emit('weaponHit', { target, fromPlayer: true, weaponKind: 'gun' });
  }

  it('民間船に1発当てたら任務失敗になる', () => {
    const { world, runner } = start();
    reachAnomaly(world, runner);
    hitByPlayer(entitiesOf(world, CIVILIAN)[0]);
    runner.update(DT);
    expect(runner.summary().friendlyFireHits).toBe(1);
    expect(objective(runner, 'no-friendly-fire').state).toBe('failed');
    expect(runner.state).toBe('loss');
  });

  it('漂流者に当てても失敗になる', () => {
    const { world, runner } = start();
    reachAnomaly(world, runner);
    hitByPlayer(entitiesOf(world, RESCUE)[0]);
    runner.update(DT);
    expect(runner.state).toBe('loss');
  });

  it('偽装無人機を撃つのは誤射にならない（撃つべき相手）', () => {
    const { world, runner } = start();
    reachAnomaly(world, runner);
    hitByPlayer(entitiesOf(world, DECOY)[0]);
    runner.update(DT);
    expect(runner.summary().friendlyFireHits).toBe(0);
    expect(objective(runner, 'no-friendly-fire').state).not.toBe('failed');
    expect(runner.state).toBe('running');
    runner.dispose();
  });

  it('誤射した瞬間に「誰に当てたか」と「その勢力表示」を無線で読む', () => {
    const spoken: string[] = [];
    const off = bus.on('radio', (p) => spoken.push(p.text));
    try {
      const { world, runner } = start();
      reachAnomaly(world, runner);
      const victim = entitiesOf(world, CIVILIAN)[0];
      const name = displayNameOf(victim);
      hitByPlayer(victim);
      runner.update(DT);
      const line = spoken.find((t) => t.includes('誤射 1発'));
      expect(line, spoken.join(' / ')).toBeDefined();
      // 名前（displayName 由来）と勢力表示（factionLabel 由来）の両方が入る
      expect(line!).toContain(name);
      expect(line!).toContain(factionLabel(victim.faction));
    } finally {
      off();
    }
  });

  it('指摘する者は章データで宣言されている（他章では流れない）', () => {
    expect(VEIL_CH02.friendlyFireRadio?.speaker).toBeTruthy();
  });
});
