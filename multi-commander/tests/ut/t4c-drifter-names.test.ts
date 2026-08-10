/**
 * T4-⑰ 第2章の漂流者3名に名前を与える。
 *
 * 固定すること:
 * - 3名に名前があり、その出所が `people.ts`（`speakerName()` 経由）の**1系統**であること
 * - 章のミッション定義に名前の文字列が直書きされていないこと
 * - 名簿へ足したのは**失踪者名簿**で、現役名簿（全76名・名鑑の人数）を動かしていないこと
 * - 収容した名前が `summary().rescuedNames` に載り、そのまま第10章の読み上げに並ぶこと
 */
import { describe, expect, it } from 'vitest';
import { DIFFICULTIES } from '../../src/app/settings';
import { VEIL_CH02 } from '../../src/content/veil/missions/ch02';
import { VEIL_CH10 } from '../../src/content/veil/missions/ch10';
import { speakerName } from '../../src/content/veil/missions/shared';
import { VEIL_LOST_PEOPLE, VEIL_PEOPLE, peopleOfFaction, veilPerson } from '../../src/content/veil/people';
import { reseed } from '../../src/core/rng';
import { MissionRunner, returneeRollCall, rollCallLines } from '../../src/mission/MissionRunner';
import { RECOVERY_HOLD_SECONDS } from '../../src/sim/recovery';
import { World } from '../../src/world/world';

const DT = 1 / 60;
const LOST_IDS = ['confed-lost-01', 'confed-lost-02', 'confed-lost-03'];

/**
 * 名前が「宣言（`displayNames`）以外の場所」に現れていないかを見るための、
 * `displayNames` を落とした章データ。ここに名前が出てきたら出所が2系統になっている。
 */
const CH02_WITHOUT_DECLARED_NAMES = JSON.stringify({
  ...VEIL_CH02,
  spawns: VEIL_CH02.spawns.map((g) => ({ ...g, displayNames: undefined })),
});

/** 第2章の漂流者3名（宣言の出所）*/
const DRIFTER_GROUP = VEIL_CH02.spawns.find((g) => g.tag === 'rescue')!;

describe('失踪者名簿', () => {
  it('八十三年前の船の乗員3名が名簿に入っている', () => {
    expect(VEIL_LOST_PEOPLE).toHaveLength(3);
    expect(VEIL_LOST_PEOPLE.map((p) => p.id)).toEqual(LOST_IDS);
    for (const p of VEIL_LOST_PEOPLE) {
      // 「八十三年前に失踪した」ことが名簿の記述から読める
      expect(p.role, p.id).toContain('失踪');
      expect(p.achievement.length, p.id).toBeGreaterThan(0);
      expect(veilPerson(p.id)).toBe(p);
    }
  });

  it('現役名簿（名鑑の人数・連番）を動かしていない', () => {
    expect(VEIL_PEOPLE).toHaveLength(76);
    expect(peopleOfFaction('confed')).toHaveLength(36);
    // 失踪者は現役名簿には出ない（名鑑の一覧・顔画像の対象にならない）
    expect(VEIL_PEOPLE.some((p) => LOST_IDS.includes(p.id))).toBe(false);
    // 連番も従来どおり（ここがずれると全章の話者参照が壊れる）
    expect(veilPerson('confed-13').name).toContain('相沢 紗良');
    expect(veilPerson('confed-36')).toBeDefined();
  });
});

describe('第2章の漂流者3名', () => {
  it('3基すべてに名前が宣言されている', () => {
    expect(DRIFTER_GROUP.count).toBe(3);
    expect(DRIFTER_GROUP.displayNames).toHaveLength(3);
    for (const n of DRIFTER_GROUP.displayNames!) expect(n.length).toBeGreaterThan(0);
  });

  it('名前の出所は people.ts（speakerName）の1系統だけ', () => {
    expect(DRIFTER_GROUP.displayNames).toEqual(LOST_IDS.map((id) => speakerName(id)));
    // 表示用に整えた名前（読み括弧を落としたもの）が入っている
    expect(DRIFTER_GROUP.displayNames).toEqual(['イネス・バレラ', '真田 十和', 'トビアス・ライ']);
  });

  it('名前は宣言（displayNames）にしか現れない（ブリーフィング・無線・目標文に直書きしていない）', () => {
    for (const name of DRIFTER_GROUP.displayNames!) {
      expect(CH02_WITHOUT_DECLARED_NAMES.includes(name), name).toBe(false);
    }
    // 名簿表記そのもの（読み括弧つき）も章データには現れない
    for (const id of LOST_IDS) {
      expect(JSON.stringify(VEIL_CH02)).not.toContain(veilPerson(id).name);
    }
  });
});

describe('収容した名前が第10章の読み上げに載る', () => {
  it('第2章で3名を収容すると rescuedNames に名簿由来の名前が並ぶ', () => {
    reseed(0x4c18);
    const world = new World();
    const runner = new MissionRunner(
      world,
      VEIL_CH02,
      { shipId: VEIL_CH02.playerShipId },
      DIFFICULTIES.easy,
    );
    runner.build();
    runner.update(DT);
    // 現場（NAV 2）へ着いて漂流者を出す
    for (const index of [0, 1]) {
      for (let i = 0; i < 240; i++) {
        world.player!.pos.set(...VEIL_CH02.navs[index].pos);
        world.player!.vel.set(0, 0, 0);
        runner.update(DT);
      }
    }
    const pods = world.entities.filter((e) => e.alive && e.tag === 'rescue');
    expect(pods).toHaveLength(3);
    for (const pod of pods) {
      const steps = Math.round((RECOVERY_HOLD_SECONDS + 0.3) / DT);
      for (let i = 0; i < steps; i++) {
        world.player!.pos.copy(pod.pos);
        world.player!.vel.copy(pod.vel);
        runner.update(DT);
      }
    }
    const s = runner.summary();
    expect(s.rescued).toBe(3);
    expect(s.rescuedNames).toEqual(LOST_IDS.map((id) => speakerName(id)));
    runner.dispose();

    // 第10章の最終無線に、そのまま一人ずつ並ぶ（読み上げ用の名簿を作らない）
    const lines = rollCallLines(VEIL_CH10.rollCall!, returneeRollCall(s.rescuedNames, []));
    for (const name of s.rescuedNames) {
      expect(lines.some((l) => l.text === `${name}。`), name).toBe(true);
    }
    expect(lines.every((l) => l.speaker === VEIL_CH10.rollCall!.speaker)).toBe(true);
  });
});
