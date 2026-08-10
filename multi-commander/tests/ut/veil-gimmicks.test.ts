import { Vector3 } from 'three';
import { beforeEach, describe, expect, it } from 'vitest';
import { DIFFICULTIES } from '../../src/app/settings';
import { bus } from '../../src/core/events';
import { reseed } from '../../src/core/rng';
import { missionDef } from '../../src/content/missions';
import { shipDef } from '../../src/content/ships';
import { VEIL_CH02 } from '../../src/content/veil/missions/ch02';
import { VEIL_CH03 } from '../../src/content/veil/missions/ch03';
import { VEIL_CH07 } from '../../src/content/veil/missions/ch07';
import { MissionRunner } from '../../src/mission/MissionRunner';
import type { MissionDef, RadioLineDef } from '../../src/mission/types';
import {
  configureMineSensors,
  mineSensorState,
  resetMineSensors,
  updateObstacles,
} from '../../src/sim/obstacles';
import { spawnMine, spawnShip, World } from '../../src/world/world';

const DT = 1 / 60;

beforeEach(() => {
  reseed(0x5eed);
  resetMineSensors();
});

function start(def: MissionDef) {
  const world = new World();
  const runner = new MissionRunner(world, def, { shipId: def.playerShipId }, DIFFICULTIES.normal);
  runner.build();
  return { world, runner };
}

/** ミッション定義に書かれた無線をすべて集める (出所つき) */
function allRadioLines(def: MissionDef): Array<{ where: string; line: RadioLineDef }> {
  const out: Array<{ where: string; line: RadioLineDef }> = [];
  for (const line of def.openingRadio ?? []) out.push({ where: 'openingRadio', line });
  def.navs.forEach((n, i) => {
    for (const line of n.onArrive ?? []) out.push({ where: `nav${i}`, line });
  });
  def.spawns.forEach((g, i) => {
    for (const line of g.radio ?? []) out.push({ where: `spawn${i}(${g.shipId})`, line });
  });
  return out;
}

// ───────── 第2章: 識別と誤射 (T6-2) ─────────

describe('第2章 識別と誤射', () => {
  it('誤射ゼロ (noFriendlyFire) が必須目標に入っている', () => {
    const o = VEIL_CH02.objectives.find((x) => x.spec.kind === 'noFriendlyFire');
    expect(o).toBeDefined();
    expect(o!.required).toBe(true);
  });

  it('「撃たずに拾って帰る」解が残っている (撃墜系の目標はすべて任意)', () => {
    for (const o of VEIL_CH02.objectives) {
      if (o.spec.kind === 'destroyTag' || o.spec.kind === 'destroyAll') {
        expect(o.required).toBe(false);
      }
    }
    // 必須は「回収」「誤射ゼロ」「帰投」だけ
    expect(VEIL_CH02.objectives.filter((o) => o.required).map((o) => o.spec.kind).sort()).toEqual(
      ['noFriendlyFire', 'reachNav', 'rescue'],
    );
  });

  it('偽装機の無線には遅延が無く、本物の味方の無線には必ず遅延がある', () => {
    const lines = allRadioLines(VEIL_CH02);
    const spoofed = lines.filter((l) => l.line.speaker.includes('僚機'));
    const genuine = lines.filter((l) => !l.line.speaker.includes('僚機'));

    // 偽装ドローンの声は遅れない (after を書かない)
    expect(spoofed.length).toBeGreaterThan(0);
    for (const s of spoofed) expect(s.line.after).toBeUndefined();

    // 本物の声は必ず遅れて届く
    expect(genuine.length).toBeGreaterThan(0);
    for (const g of genuine) {
      expect(g.line.after, `${g.where}: ${g.line.speaker}`).toBeGreaterThan(0);
    }
  });

  it('偽装機を出す群では、偽装の声が本物の声より先に流れる', () => {
    const decoyGroups = VEIL_CH02.spawns.filter((g) => g.tag === 'decoy');
    expect(decoyGroups.length).toBeGreaterThan(0);
    for (const g of decoyGroups) {
      const lines = g.radio ?? [];
      expect(lines.length).toBeGreaterThanOrEqual(2);
      // 先頭が偽装 (遅延なし)、続く本物には遅延がある
      expect(lines[0].speaker).toContain('僚機');
      expect(lines[0].after).toBeUndefined();
      expect(lines[1].after).toBeGreaterThan(0);
    }
  });
});

// ───────── 第3章: 熱紋機雷と共鳴パルス (T6-3) ─────────

describe('第3章 避難船と護送目標', () => {
  it('避難船が18隻いる', () => {
    const liners = VEIL_CH03.spawns
      .filter((g) => g.shipId === 'refugee-liner')
      .reduce((n, g) => n + g.count, 0);
    expect(liners).toBe(18);
  });

  it('護送は protectCount で、min は18隻以下 (牽引の6隻を見捨てられない値)', () => {
    const o = VEIL_CH03.objectives.find((x) => x.spec.kind === 'protectCount');
    expect(o).toBeDefined();
    expect(o!.required).toBe(true);
    const spec = o!.spec as { kind: 'protectCount'; tag: string; min: number };
    expect(spec.min).toBeLessThanOrEqual(18);
    // 自力航行できる12隻だけでは足りない = 牽引の6隻を守る動機が生まれる
    expect(spec.min).toBeGreaterThan(12);

    // protectCount が数えるタグには避難船18隻だけが付いている
    const tagged = VEIL_CH03.spawns
      .filter((g) => g.tag === spec.tag)
      .reduce((n, g) => n + g.count, 0);
    expect(tagged).toBe(18);
    for (const g of VEIL_CH03.spawns.filter((x) => x.tag === spec.tag)) {
      expect(g.shipId).toBe('refugee-liner');
    }
  });

  it('武器管制停止 (weaponsSafe) は任意目標として残る', () => {
    const o = VEIL_CH03.objectives.find((x) => x.spec.kind === 'weaponsSafe');
    expect(o).toBeDefined();
    expect(o!.required).toBe(false);
  });

  it('機雷帯は熱紋機雷として宣言され、共鳴パルスは80秒周期・60秒有効', () => {
    const mines = (VEIL_CH03.hazards ?? []).filter((h) => h.kind === 'minefield');
    expect(mines.length).toBeGreaterThan(0);
    for (const m of mines) expect(m.thermalOnly).toBe(true);
    const withPulse = mines.filter((m) => m.resonance);
    expect(withPulse).toHaveLength(1);
    expect(withPulse[0].resonance).toMatchObject({ cycle: 80, window: 60 });
  });
});

describe('熱紋機雷', () => {
  /** 機雷の傍らに1機だけ置いて起爆シーケンスに入るか見る */
  function armsFor(shipId: string): boolean {
    const world = new World();
    const s = spawnShip(world, {
      def: shipDef(shipId),
      faction: 'confed',
      pos: new Vector3(0, 0, -50),
      speed: 0,
    });
    world.playerId = s.id;
    const mine = spawnMine(world, { pos: new Vector3(0, 0, 0), ownerFaction: 'neurowm' });
    for (let i = 0; i < 10; i++) updateObstacles(world, DT);
    return mine.mine!.armed;
  }

  it('避難船 (非武装の輸送船) では起爆しない', () => {
    configureMineSensors({ thermalOnly: true });
    expect(armsFor('refugee-liner')).toBe(false);
  });

  it('軍用推進器 (戦闘機) には反応する', () => {
    configureMineSensors({ thermalOnly: true });
    expect(armsFor('hornet')).toBe(true);
  });

  it('熱紋設定が無ければ、避難船でも従来どおり起爆する (既存挙動)', () => {
    expect(armsFor('refugee-liner')).toBe(true);
  });
});

describe('共鳴パルスの安全窓', () => {
  it('80秒周期で60秒間だけ開き、その間は機雷が起爆しない', () => {
    const { runner } = start(VEIL_CH03);
    // 開始直後は窓が開いている (周期の先頭60秒)
    runner.update(DT);
    expect(runner.resonanceWindowOpen).toBe(true);
    expect(mineSensorState().suppressed).toBe(true);

    // 30秒後もまだ開いている
    for (let t = 0; t < 30; t += 0.25) runner.update(0.25);
    expect(runner.resonanceWindowOpen).toBe(true);

    // 60秒を越えると閉じる
    for (let t = 0; t < 35; t += 0.25) runner.update(0.25);
    expect(runner.elapsed).toBeGreaterThan(60);
    expect(runner.resonanceWindowOpen).toBe(false);
    expect(mineSensorState().suppressed).toBe(false);

    // 80秒でまた開く
    for (let t = 0; t < 20; t += 0.25) runner.update(0.25);
    expect(runner.elapsed).toBeGreaterThan(80);
    expect(runner.resonanceWindowOpen).toBe(true);
    expect(mineSensorState().suppressed).toBe(true);
  });

  it('窓が開いている間は熱紋機雷が戦闘機にも反応しない', () => {
    const { world, runner } = start(VEIL_CH03);
    runner.update(DT);
    expect(runner.resonanceWindowOpen).toBe(true);

    const player = world.player!;
    const mine = spawnMine(world, {
      pos: player.pos.clone().add(new Vector3(0, 0, -40)),
      ownerFaction: 'neurowm',
    });
    for (let i = 0; i < 10; i++) updateObstacles(world, DT);
    expect(mine.mine!.armed).toBe(false);
  });

  it('自機が発砲すると窓が閉じ、以後は開かない', () => {
    const { world, runner } = start(VEIL_CH03);
    runner.update(DT);
    expect(runner.resonanceWindowOpen).toBe(true);

    bus.emit('weaponFired', {
      shooter: world.player!,
      muzzle: world.player!.pos.clone(),
      direction: new Vector3(0, 0, -1),
      weaponKind: 'gun',
      weaponId: 'laser',
      isPlayer: true,
    });
    expect(runner.resonanceStopped).toBe(true);
    expect(runner.resonanceWindowOpen).toBe(false);
    expect(mineSensorState().suppressed).toBe(false);

    // 次の周期が来ても二度と開かない
    for (let t = 0; t < 100; t += 0.25) runner.update(0.25);
    expect(runner.resonanceWindowOpen).toBe(false);
    expect(mineSensorState().suppressed).toBe(false);

    // 発砲した事実は weaponsSafe 目標の失敗として残る (窓の状態も note に出る)
    const view = runner.objectiveViews()[
      VEIL_CH03.objectives.findIndex((o) => o.spec.kind === 'weaponsSafe')
    ];
    expect(view.state).toBe('failed');

    runner.dispose();
  });

  it('発砲前は weaponsSafe の note に安全窓の残り時間が出る (HUD を触らずに窓を見せる)', () => {
    const { runner } = start(VEIL_CH03);
    runner.update(DT);
    const idx = VEIL_CH03.objectives.findIndex((o) => o.spec.kind === 'weaponsSafe');
    expect(runner.objectiveViews()[idx].text).toContain('安全窓');
    runner.dispose();
  });
});

describe('既存ミッションの機雷 (回帰)', () => {
  it('m3-strike は熱紋設定も安全窓も持たない', () => {
    const def = missionDef('m3-strike');
    expect((def.hazards ?? []).some((h) => h.kind === 'minefield')).toBe(true);
    for (const h of def.hazards ?? []) {
      expect(h.thermalOnly).toBeUndefined();
      expect(h.resonance).toBeUndefined();
    }
    start(def);
    expect(mineSensorState().thermalOnly).toBe(false);
    expect(mineSensorState().suppressed).toBe(false);
  });

  it('第3章のあとに既存ミッションを開いても、機雷の規則が持ち越されない', () => {
    const veil = start(VEIL_CH03);
    veil.runner.update(DT);
    expect(mineSensorState().suppressed).toBe(true);
    veil.runner.dispose();

    // 続けて既存ミッションを開始すると規則が既定へ戻る
    start(missionDef('m3-strike'));
    expect(mineSensorState().thermalOnly).toBe(false);
    expect(mineSensorState().suppressed).toBe(false);

    // 輸送船でも従来どおり起爆する
    const world = new World();
    const s = spawnShip(world, {
      def: shipDef('drayman'),
      faction: 'confed',
      pos: new Vector3(0, 0, -50),
      speed: 0,
    });
    world.playerId = s.id;
    const mine = spawnMine(world, { pos: new Vector3(0, 0, 0), ownerFaction: 'kilrathi' });
    for (let i = 0; i < 10; i++) updateObstacles(world, DT);
    expect(mine.mine!.armed).toBe(true);
  });
});

// ───────── 第7章: 発砲禁止の搬送 (T6-7) ─────────

describe('第7章 発砲禁止の搬送', () => {
  it('weaponsSafe は任意目標 (発砲は即失敗ではなく代償)', () => {
    const o = VEIL_CH07.objectives.find((x) => x.spec.kind === 'weaponsSafe');
    expect(o).toBeDefined();
    expect(o!.required).toBe(false);
    expect(o!.text).toContain('保全規約');
    expect(o!.text).toContain('正当性');
  });

  it('哨戒機の保護は weaponsSafe と別の任意目標として残す', () => {
    const protectObjectives = VEIL_CH07.objectives.filter((x) => x.spec.kind === 'protect');
    expect(protectObjectives).toHaveLength(1);
    expect(protectObjectives[0].required).toBe(false);
    expect(protectObjectives[0].id).not.toBe(
      VEIL_CH07.objectives.find((x) => x.spec.kind === 'weaponsSafe')!.id,
    );
  });

  it('発砲しても任務は失敗しない (必須は搬送・提出・期限だけで、発砲禁止は必須にしない)', () => {
    // T3-C で「中継所へ書式を提出する」(recon) を必須に追加した。
    // 発砲を数える目標 (weaponsSafe) と誤射・護衛系は必須に入れない、が要点。
    expect(VEIL_CH07.objectives.filter((o) => o.required).map((o) => o.spec.kind).sort()).toEqual(
      ['reachNav', 'recon', 'timeLimit'],
    );
    expect(VEIL_CH07.objectives.find((o) => o.spec.kind === 'weaponsSafe')!.required).toBe(false);
  });
});
